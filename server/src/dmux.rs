//! Single-socket multiplexing endpoint for y-sweet sync (prototype "Option A").
//!
//! `/d/*` opens one upstream y-sweet socket per *client* socket, so a client
//! syncing a whole vault opens one socket per document. `/dmux` lets a client
//! carry every document over a **single** socket: the client tags each frame
//! with a channel id, and this handler demultiplexes — dialing one upstream
//! y-sweet socket per channel and pumping frames between them.
//!
//! Auth/attribution are unchanged from [`crate::proxy`]: each `OPEN` frame
//! carries the per-doc path+query (`/d/{docId}/ws/{docId}?token=…`) the client
//! would otherwise have connected to, and we forward it verbatim to the internal
//! y-sweet (which still validates the doc token) and attribute writes via
//! [`crate::proxy::resolve_attribution`].
//!
//! Wire frames mirror `src/sync/mux.ts` (ints are lib0 var-uints):
//!   OPEN     = [1][channel][varString pathAndQuery]   client -> server
//!   OPEN_OK  = [2][channel]                            server -> client
//!   OPEN_ERR = [3][channel]                            server -> client
//!   DATA     = [4][channel][raw yjs bytes …]           both directions
//!   CLOSE    = [5][channel]                            both directions

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message as AxumMsg, WebSocket, WebSocketUpgrade},
        State,
    },
    http::Uri,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMsg};

use crate::proxy::{
    is_content_write, read_varint, resolve_attribution, upstream_authority, Attribution,
};
use crate::state::AppState;

const FRAME_OPEN: u64 = 1;
const FRAME_OPEN_OK: u64 = 2;
const FRAME_OPEN_ERR: u64 = 3;
const FRAME_DATA: u64 = 4;
const FRAME_CLOSE: u64 = 5;

/// Outbound queue depth per direction; bounds memory if one side stalls.
const CHANNEL_CAPACITY: usize = 256;

/// Accept the multiplexed sync socket.
pub async fn dmux(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state))
}

/// One open channel: a sender into its upstream pump plus the resolved
/// attribution (used to mark content writes for git/search/plugin-db).
struct ChannelHandle {
    up_tx: mpsc::Sender<Vec<u8>>,
    attribution: Option<Arc<Attribution>>,
}

async fn handle(client: WebSocket, state: AppState) {
    let (mut cl_sink, mut cl_stream) = client.split();

    // All writes to the single client socket are serialized through this queue,
    // since every upstream pump (one per channel) plus control replies share it.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_CAPACITY);
    let writer = tokio::spawn(async move {
        while let Some(buf) = out_rx.recv().await {
            if cl_sink.send(AxumMsg::Binary(buf.into())).await.is_err() {
                break;
            }
        }
    });

    let mut channels: HashMap<u64, ChannelHandle> = HashMap::new();

    while let Some(msg) = cl_stream.next().await {
        let Ok(msg) = msg else { break };
        let AxumMsg::Binary(buf) = msg else {
            // Text/ping/pong/close: ping/pong are handled by axum; ignore the rest.
            continue;
        };
        match parse_frame(&buf) {
            Some(Frame::Open {
                channel,
                path_and_query,
            }) => {
                start_channel(&state, channel, path_and_query, &out_tx, &mut channels).await;
            }
            Some(Frame::Data { channel, payload }) => {
                if let Some(handle) = channels.get(&channel) {
                    if let Some(attr) = &handle.attribution {
                        if is_content_write(payload) {
                            attr.mark_content_write().await;
                        }
                    }
                    // Drop on a full/closed channel rather than blocking the
                    // whole socket; the provider re-syncs on reconnect.
                    let _ = handle.up_tx.try_send(payload.to_vec());
                }
            }
            Some(Frame::Close { channel }) => {
                // Dropping the handle ends that channel's upstream pump.
                channels.remove(&channel);
            }
            None => {}
        }
    }

    // Client gone: drop every channel (ends each upstream pump) and the writer.
    channels.clear();
    drop(out_tx);
    let _ = writer.await;
}

/// Dial the upstream y-sweet for one channel and spawn its bidirectional pump.
async fn start_channel(
    state: &AppState,
    channel: u64,
    path_and_query: String,
    out_tx: &mpsc::Sender<Vec<u8>>,
    channels: &mut HashMap<u64, ChannelHandle>,
) {
    let authority = match upstream_authority(state) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("dmux: invalid y-sweet upstream: {e}");
            let _ = out_tx.send(encode_simple(FRAME_OPEN_ERR, channel)).await;
            return;
        }
    };

    // Attribute writes exactly as the /d proxy does, from the path+query token.
    let attribution = match path_and_query.parse::<Uri>() {
        Ok(uri) => resolve_attribution(state, &uri).await.map(Arc::new),
        Err(_) => None,
    };

    let target = format!("ws://{authority}{path_and_query}");
    let upstream = match dial_upstream(&target).await {
        Ok(ws) => ws,
        Err(e) => {
            tracing::debug!("dmux: upstream dial failed: {e}");
            let _ = out_tx.send(encode_simple(FRAME_OPEN_ERR, channel)).await;
            return;
        }
    };

    let _ = out_tx.send(encode_simple(FRAME_OPEN_OK, channel)).await;

    let (up_tx, up_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_CAPACITY);
    let out_for_pump = out_tx.clone();
    tokio::spawn(async move {
        pump_channel(channel, upstream, up_rx, out_for_pump).await;
    });

    channels.insert(channel, ChannelHandle { up_tx, attribution });
}

type Upstream = tokio_tungstenite::WebSocketStream<TcpStream>;

/// Open a plain-TCP WebSocket to the internal y-sweet (no TLS; it is internal).
async fn dial_upstream(target: &str) -> anyhow::Result<Upstream> {
    let request = target.into_client_request()?;
    let host = request
        .uri()
        .authority()
        .map(|a| a.as_str().to_string())
        .ok_or_else(|| anyhow::anyhow!("missing authority in {target}"))?;
    let tcp = timeout(Duration::from_secs(10), TcpStream::connect(&host)).await??;
    let (upstream, _resp) = timeout(
        Duration::from_secs(10),
        tokio_tungstenite::client_async(request, tcp),
    )
    .await??;
    Ok(upstream)
}

/// Pump one channel's frames in both directions until either side closes.
/// Ends when `up_rx` is dropped (the channel was closed / client left) or the
/// upstream socket closes (then a CLOSE frame is sent to the client).
async fn pump_channel(
    channel: u64,
    upstream: Upstream,
    mut up_rx: mpsc::Receiver<Vec<u8>>,
    out_tx: mpsc::Sender<Vec<u8>>,
) {
    let (mut up_sink, mut up_stream) = upstream.split();
    loop {
        tokio::select! {
            from_client = up_rx.recv() => {
                match from_client {
                    Some(bytes) => {
                        if up_sink.send(WsMsg::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    None => break, // channel closed or client gone
                }
            }
            from_upstream = up_stream.next() => {
                match from_upstream {
                    Some(Ok(WsMsg::Binary(bytes))) => {
                        if out_tx.send(encode_data(channel, &bytes)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(WsMsg::Ping(payload))) => {
                        let _ = up_sink.send(WsMsg::Pong(payload)).await;
                    }
                    Some(Ok(WsMsg::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    let _ = out_tx.send(encode_simple(FRAME_CLOSE, channel)).await;
}

// --- framing ---------------------------------------------------------------

enum Frame<'a> {
    Open {
        channel: u64,
        path_and_query: String,
    },
    Data {
        channel: u64,
        payload: &'a [u8],
    },
    Close {
        channel: u64,
    },
}

fn parse_frame(buf: &[u8]) -> Option<Frame<'_>> {
    let (frame_type, rest) = read_varint(buf)?;
    let (channel, rest) = read_varint(rest)?;
    match frame_type {
        t if t == FRAME_OPEN => {
            let (len, rest) = read_varint(rest)?;
            let len = len as usize;
            if rest.len() < len {
                return None;
            }
            let path_and_query = String::from_utf8(rest[..len].to_vec()).ok()?;
            Some(Frame::Open {
                channel,
                path_and_query,
            })
        }
        t if t == FRAME_DATA => Some(Frame::Data {
            channel,
            payload: rest,
        }),
        t if t == FRAME_CLOSE => Some(Frame::Close { channel }),
        _ => None,
    }
}

/// Append an unsigned LEB128 var-uint (lib0 encoding).
fn write_varint(buf: &mut Vec<u8>, mut n: u64) {
    loop {
        let mut byte = (n & 0x7f) as u8;
        n >>= 7;
        if n != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if n == 0 {
            break;
        }
    }
}

/// A frame with just a type and channel id (OPEN_OK / OPEN_ERR / CLOSE).
fn encode_simple(frame_type: u64, channel: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4);
    write_varint(&mut buf, frame_type);
    write_varint(&mut buf, channel);
    buf
}

fn encode_data(channel: u64, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(payload.len() + 4);
    write_varint(&mut buf, FRAME_DATA);
    write_varint(&mut buf, channel);
    buf.extend_from_slice(payload);
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_roundtrips() {
        for n in [0u64, 1, 127, 128, 300, 16384, u32::MAX as u64] {
            let mut buf = Vec::new();
            write_varint(&mut buf, n);
            let (got, rest) = read_varint(&buf).unwrap();
            assert_eq!(got, n);
            assert!(rest.is_empty());
        }
    }

    #[test]
    fn parses_open_frame() {
        // [type=1][channel=7][len=3]["abc"]
        let mut buf = Vec::new();
        write_varint(&mut buf, FRAME_OPEN);
        write_varint(&mut buf, 7);
        write_varint(&mut buf, 3);
        buf.extend_from_slice(b"abc");
        match parse_frame(&buf) {
            Some(Frame::Open {
                channel,
                path_and_query,
            }) => {
                assert_eq!(channel, 7);
                assert_eq!(path_and_query, "abc");
            }
            _ => panic!("expected open frame"),
        }
    }

    #[test]
    fn parses_data_and_close() {
        let data = encode_data(9, b"hello");
        match parse_frame(&data) {
            Some(Frame::Data { channel, payload }) => {
                assert_eq!(channel, 9);
                assert_eq!(payload, b"hello");
            }
            _ => panic!("expected data frame"),
        }

        let close = encode_simple(FRAME_CLOSE, 4);
        assert!(matches!(
            parse_frame(&close),
            Some(Frame::Close { channel: 4 })
        ));
    }

    #[test]
    fn rejects_truncated_open() {
        let mut buf = Vec::new();
        write_varint(&mut buf, FRAME_OPEN);
        write_varint(&mut buf, 1);
        write_varint(&mut buf, 10); // claims 10 bytes
        buf.extend_from_slice(b"short");
        assert!(parse_frame(&buf).is_none());
    }
}
