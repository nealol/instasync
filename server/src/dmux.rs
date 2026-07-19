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

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
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
use tokio::sync::mpsc::error::TrySendError;
use tokio::time::{interval, timeout, Duration, Instant, MissedTickBehavior};
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
const FRAME_PING: u64 = 6;
const FRAME_PONG: u64 = 7;

/// Channel id reserved for connection-level control frames (PING/PONG).
const CONTROL_CHANNEL: u64 = 0;

/// Outbound queue depth per direction; bounds memory if one side stalls.
const CHANNEL_CAPACITY: usize = 256;
/// Hard fan-out bound for one client connection.
const MAX_CHANNELS: usize = 1_024;
/// Bound OPEN parsing/allocation and the request forwarded to tungstenite.
const MAX_OPEN_PATH_BYTES: usize = 4_096;
/// Bound dial-task creation even when a client immediately closes each channel.
const MAX_OPENS_PER_WINDOW: usize = 128;
const OPEN_RATE_WINDOW: Duration = Duration::from_secs(10);
/// The browser client sends mux PING frames every five seconds.
const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// Process-wide count of live upstream y-sweet sockets across every `/dmux`
/// connection — the fan-out metric the eval called for. Logged on each change.
static UPSTREAM_SOCKETS: AtomicU64 = AtomicU64::new(0);

/// RAII gauge: one live upstream y-sweet socket for as long as it is held.
struct UpstreamGuard;

impl UpstreamGuard {
    fn new() -> Self {
        let n = UPSTREAM_SOCKETS.fetch_add(1, Ordering::Relaxed) + 1;
        tracing::debug!(upstream_sockets = n, "dmux: upstream socket opened");
        Self
    }
}

impl Drop for UpstreamGuard {
    fn drop(&mut self) {
        let n = UPSTREAM_SOCKETS.fetch_sub(1, Ordering::Relaxed) - 1;
        tracing::debug!(upstream_sockets = n, "dmux: upstream socket closed");
    }
}

struct OpenLimiter {
    seen_channels: HashSet<u64>,
    window_started: Instant,
    opens_in_window: usize,
}

impl OpenLimiter {
    fn new(now: Instant) -> Self {
        Self {
            seen_channels: HashSet::new(),
            window_started: now,
            opens_in_window: 0,
        }
    }

    fn admit(&mut self, channel: u64, active_channels: usize, now: Instant) -> bool {
        if now.duration_since(self.window_started) >= OPEN_RATE_WINDOW {
            self.window_started = now;
            self.opens_in_window = 0;
        }
        self.opens_in_window += 1;
        if channel == CONTROL_CHANNEL
            || self.seen_channels.contains(&channel)
            || active_channels >= MAX_CHANNELS
            || self.opens_in_window > MAX_OPENS_PER_WINDOW
        {
            return false;
        }
        self.seen_channels.insert(channel);
        true
    }
}

/// Accept the multiplexed sync socket.
pub async fn dmux(State(state): State<AppState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle(socket, state))
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

    // channel id -> sender into that channel's upstream pump.
    let mut channels: HashMap<u64, mpsc::Sender<Vec<u8>>> = HashMap::new();
    let mut open_limiter = OpenLimiter::new(Instant::now());
    let mut last_client_activity = Instant::now();
    let mut idle_tick = interval(Duration::from_secs(5));
    idle_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Upstream tasks notify this loop when their channel has ended, so terminal
    // paths such as OPEN_ERR or upstream close do not leave stale senders behind.
    let (done_tx, mut done_rx) = mpsc::unbounded_channel::<u64>();

    loop {
        tokio::select! {
            msg = cl_stream.next() => {
                let Some(msg) = msg else { break };
                let Ok(msg) = msg else { break };
                let AxumMsg::Binary(buf) = msg else {
                    // Text/ping/pong/close: ping/pong are handled by axum; ignore the rest.
                    continue;
                };
                last_client_activity = Instant::now();
                match parse_frame(&buf) {
                    Some(Frame::Open {
                        channel,
                        path_and_query,
                    }) => {
                        if !open_limiter.admit(channel, channels.len(), Instant::now()) {
                            let _ = out_tx.try_send(encode_simple(FRAME_OPEN_ERR, channel));
                            tracing::warn!(
                                channel,
                                active_channels = channels.len(),
                                "dmux: rejected channel open"
                            );
                            continue;
                        }
                        // Register the channel synchronously, then dial upstream in a
                        // spawned task. Dialing here would block the whole multiplexed
                        // socket (head-of-line) — a slow/hung upstream would freeze every
                        // other channel — so the read loop must never await the dial.
                        let (up_tx, up_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_CAPACITY);
                        channels.insert(channel, up_tx);
                        let state = state.clone();
                        let out = out_tx.clone();
                        let done = done_tx.clone();
                        tokio::spawn(async move {
                            open_and_pump(state, channel, path_and_query, up_rx, out).await;
                            let _ = done.send(channel);
                        });
                    }
                    Some(Frame::Data { channel, payload }) => {
                        if let Some(up_tx) = channels.get(&channel) {
                            match up_tx.try_send(payload.to_vec()) {
                                Ok(()) => {}
                                // Upstream is backed up. Silently dropping a Yjs update
                                // would diverge the doc (the provider thinks it sent it
                                // and won't resend until reconnect), so instead reset the
                                // channel: the provider reconnects and does a full resync.
                                Err(TrySendError::Full(_)) => {
                                    channels.remove(&channel);
                                    let _ = out_tx.try_send(encode_simple(FRAME_CLOSE, channel));
                                    tracing::warn!(channel, "dmux: upstream backpressure; reset channel");
                                }
                                Err(TrySendError::Closed(_)) => {
                                    channels.remove(&channel);
                                }
                            }
                        }
                    }
                    Some(Frame::Close { channel }) => {
                        // Dropping the sender ends that channel's upstream pump.
                        channels.remove(&channel);
                    }
                    Some(Frame::Ping) => {
                        let _ = out_tx.try_send(encode_simple(FRAME_PONG, CONTROL_CHANNEL));
                    }
                    None => {}
                }
            }
            done = done_rx.recv() => {
                if let Some(channel) = done {
                    channels.remove(&channel);
                }
            }
            _ = idle_tick.tick() => {
                if last_client_activity.elapsed() > CLIENT_IDLE_TIMEOUT {
                    tracing::debug!("dmux: idle client connection closed");
                    break;
                }
            }
        }
    }

    // Client gone: drop every channel (ends each upstream pump) and the writer.
    channels.clear();
    drop(out_tx);
    writer.abort();
    let _ = writer.await;
}

/// Resolve attribution, dial the upstream y-sweet, then pump frames for one
/// channel. Runs in its own task so the client read loop never blocks on a dial.
async fn open_and_pump(
    state: AppState,
    channel: u64,
    path_and_query: String,
    up_rx: mpsc::Receiver<Vec<u8>>,
    out_tx: mpsc::Sender<Vec<u8>>,
) {
    let authority = match upstream_authority(&state) {
        Ok(a) => a,
        Err(e) => {
            tracing::warn!("dmux: invalid y-sweet upstream: {e}");
            let _ = out_tx.send(encode_simple(FRAME_OPEN_ERR, channel)).await;
            return;
        }
    };

    // Attribute writes exactly as the /d proxy does, from the path+query token.
    let attribution = match path_and_query.parse::<Uri>() {
        Ok(uri) => resolve_attribution(&state, &uri).await.map(Arc::new),
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
    let _guard = UpstreamGuard::new();

    if out_tx
        .send(encode_simple(FRAME_OPEN_OK, channel))
        .await
        .is_err()
    {
        return;
    }

    pump_channel(channel, upstream, up_rx, out_tx, attribution).await;
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
    attribution: Option<Arc<Attribution>>,
) {
    let (mut up_sink, mut up_stream) = upstream.split();
    loop {
        tokio::select! {
            from_client = up_rx.recv() => {
                match from_client {
                    Some(bytes) => {
                        // Tap content writes for git/search/plugin-db, exactly as
                        // the /d proxy does — here rather than in the read loop so
                        // attribution never blocks other channels.
                        if let Some(attr) = &attribution {
                            if is_content_write(&bytes) {
                                attr.mark_content_write().await;
                            }
                        }
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
    Ping,
}

fn parse_frame(buf: &[u8]) -> Option<Frame<'_>> {
    let (frame_type, rest) = read_varint(buf)?;
    let (channel, rest) = read_varint(rest)?;
    match frame_type {
        t if t == FRAME_OPEN => {
            let (len, rest) = read_varint(rest)?;
            let len = len as usize;
            if len > MAX_OPEN_PATH_BYTES || rest.len() < len {
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
        t if t == FRAME_PING && channel == CONTROL_CHANNEL => Some(Frame::Ping),
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
    fn parses_ping() {
        let ping = encode_simple(FRAME_PING, CONTROL_CHANNEL);
        assert!(matches!(parse_frame(&ping), Some(Frame::Ping)));
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

    #[test]
    fn rejects_oversized_open_path() {
        let mut buf = Vec::new();
        write_varint(&mut buf, FRAME_OPEN);
        write_varint(&mut buf, 1);
        write_varint(&mut buf, (MAX_OPEN_PATH_BYTES + 1) as u64);
        buf.resize(buf.len() + MAX_OPEN_PATH_BYTES + 1, b'x');
        assert!(parse_frame(&buf).is_none());
    }

    #[test]
    fn open_limiter_rejects_control_duplicates_rate_and_fanout() {
        let start = Instant::now();
        let mut limiter = OpenLimiter::new(start);
        assert!(!limiter.admit(CONTROL_CHANNEL, 0, start));
        assert!(limiter.admit(1, 0, start));
        assert!(!limiter.admit(1, 0, start));

        let mut rate_limiter = OpenLimiter::new(start);
        for channel in 1..=MAX_OPENS_PER_WINDOW as u64 {
            assert!(rate_limiter.admit(channel, 0, start));
        }
        assert!(!rate_limiter.admit((MAX_OPENS_PER_WINDOW + 1) as u64, 0, start));

        let mut fanout_limiter = OpenLimiter::new(start);
        let mut now = start;
        for active in 0..MAX_CHANNELS {
            if active > 0 && active % MAX_OPENS_PER_WINDOW == 0 {
                now += OPEN_RATE_WINDOW;
            }
            assert!(fanout_limiter.admit((active + 1) as u64, active, now));
        }
        now += OPEN_RATE_WINDOW;
        assert!(!fanout_limiter.admit((MAX_CHANNELS + 1) as u64, MAX_CHANNELS, now));
    }
}
