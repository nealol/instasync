//! Reverse proxy for the bundled y-sweet server.
//!
//! When the auth server runs y-sweet internally (see the Docker entrypoint), the
//! minted client tokens point clients back at *this* server under `/d/...`. These
//! handlers forward that traffic — both the sync WebSocket and the document HTTP
//! endpoints (`as-update`, `update`) — to the internal y-sweet over plain TCP.
//!
//! The proxy is a dumb pass-through: y-sweet still validates the doc token (it
//! holds the same auth key), so the security model is unchanged from exposing
//! y-sweet directly. Authorization was already enforced when the token was minted.

use axum::{
    body::Bytes,
    extract::{
        ws::{Message as AxumMsg, WebSocket, WebSocketUpgrade},
        FromRequestParts, Request, State,
    },
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMsg};
use url::Url;

use crate::git::GitService;
use crate::state::{AppState, Principal};

/// Everything the proxy needs to attribute a write on this connection to a user.
struct Attribution {
    vault_id: String,
    principal: Principal,
    git: GitService,
}

/// Hop-by-hop headers must not be forwarded across the proxy.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
    "host",
];

/// `host[:port]` of the internal y-sweet, derived from the configured URL.
fn upstream_authority(state: &AppState) -> anyhow::Result<String> {
    let url = Url::parse(&state.config.ysweet_url)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("missing y-sweet host"))?;
    Ok(if let Some(port) = url.port() {
        format!("{host}:{port}")
    } else {
        host.to_string()
    })
}

/// Largest document HTTP body we relay (y-sweet `update` payloads).
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// True if the request is a WebSocket upgrade.
fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false)
}

/// Forward a request under `/d/*` to the internal y-sweet. WebSocket upgrades are
/// relayed bidirectionally; everything else is proxied as a plain HTTP request.
pub async fn proxy(State(state): State<AppState>, req: Request) -> Response {
    let authority = match upstream_authority(&state) {
        Ok(authority) => authority,
        Err(e) => {
            tracing::warn!("invalid y-sweet upstream: {e}");
            return (StatusCode::BAD_GATEWAY, "invalid y-sweet upstream").into_response();
        }
    };
    let (mut parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| parts.uri.path())
        .to_string();

    if is_websocket_upgrade(&parts.headers) {
        // Resolve who is on this connection before consuming the request parts, so
        // content writes can be attributed to an authenticated principal.
        let attribution = resolve_attribution(&state, &parts.uri).await;
        let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(ws) => ws,
            Err(rej) => return rej.into_response(),
        };
        let target = format!("ws://{authority}{path_and_query}");
        return ws.on_upgrade(move |client| async move {
            if let Err(e) = relay_ws(client, target, attribution).await {
                tracing::debug!("y-sweet ws proxy closed: {e}");
            }
        });
    }

    let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "request body too large").into_response(),
    };

    match proxy_http(
        &state,
        &parts.method,
        &authority,
        &path_and_query,
        &parts.headers,
        bytes,
    )
    .await
    {
        Ok(res) => res,
        Err(e) => {
            tracing::warn!("y-sweet http proxy error: {e}");
            (StatusCode::BAD_GATEWAY, "y-sweet upstream error").into_response()
        }
    }
}

/// Proxy a single non-WebSocket request via reqwest.
async fn proxy_http(
    state: &AppState,
    method: &Method,
    authority: &str,
    path_and_query: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> anyhow::Result<Response> {
    let url = format!("http://{authority}{path_and_query}");
    let mut req = state.http.request(method.clone(), &url);

    for (name, value) in headers {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            req = req.header(name, value);
        }
    }
    req = req.body(body);

    let upstream = timeout(Duration::from_secs(30), req.send()).await??;
    if upstream
        .content_length()
        .is_some_and(|len| len > MAX_BODY_BYTES as u64)
    {
        return Ok((StatusCode::BAD_GATEWAY, "y-sweet response too large").into_response());
    }

    let mut builder = Response::builder().status(upstream.status());
    for (name, value) in upstream.headers() {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    let bytes = timeout(Duration::from_secs(30), upstream.bytes()).await??;
    Ok(builder
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()))
}

/// Resolve the `(vault, principal)` for a sync WebSocket from its docId path and
/// `?token=` query, returning `None` if the token is unknown/expired (e.g. a
/// read-only viewer whose writes we simply won't attribute).
async fn resolve_attribution(state: &AppState, uri: &axum::http::Uri) -> Option<Attribution> {
    // Path is `/d/{docId}/{docId}`; the first segment after `/d/` is the docId.
    let doc_id = uri.path().strip_prefix("/d/")?.split('/').next()?;
    if doc_id.is_empty() {
        return None;
    }
    let token = url::form_urlencoded::parse(uri.query()?.as_bytes())
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())?;
    let principal = state.principal_for_token(&token).await?;
    // Index docId is the bare vaultId; file docIds are `{vaultId}__{guid}`.
    let vault_id = doc_id.split("__").next().unwrap_or(doc_id).to_string();
    Some(Attribution {
        vault_id,
        principal,
        git: state.git.clone(),
    })
}

/// Read one unsigned LEB128 varint (lib0 encoding), returning it and the rest.
fn read_varint(buf: &[u8]) -> Option<(u64, &[u8])> {
    let mut result: u64 = 0;
    let mut shift = 0;
    for (i, &byte) in buf.iter().enumerate() {
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((result, &buf[i + 1..]));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

/// True if a client→server binary frame carries document content: a Yjs sync
/// message (type 0) of sub-type SyncStep2 (1) or Update (2). Awareness (cursor)
/// traffic and SyncStep1 (read requests) are deliberately ignored.
fn is_content_write(data: &[u8]) -> bool {
    let Some((msg_type, rest)) = read_varint(data) else {
        return false;
    };
    if msg_type != 0 {
        return false;
    }
    matches!(read_varint(rest), Some((sub, _)) if sub == 1 || sub == 2)
}

/// Open an upstream WebSocket to y-sweet and pump frames in both directions.
async fn relay_ws(
    client: WebSocket,
    target: String,
    attribution: Option<Attribution>,
) -> anyhow::Result<()> {
    // Connect over plain TCP (y-sweet is internal, no TLS) using the target's authority.
    let request = target.as_str().into_client_request()?;
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

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    // client -> upstream (taps content writes for git attribution en route)
    let c2u = async {
        while let Some(msg) = cl_rx.next().await {
            let msg = msg?;
            if let (Some(attr), AxumMsg::Binary(bytes)) = (&attribution, &msg) {
                if is_content_write(bytes) {
                    attr.git.mark_write(&attr.vault_id, &attr.principal).await;
                }
            }
            if let Some(out) = axum_to_tungstenite(msg) {
                up_tx.send(out).await?;
            }
        }
        anyhow::Ok(())
    };

    // upstream -> client
    let u2c = async {
        while let Some(msg) = up_rx.next().await {
            let msg = msg?;
            if let Some(out) = tungstenite_to_axum(msg) {
                cl_tx.send(out).await?;
            }
        }
        anyhow::Ok(())
    };

    // Whichever side closes first ends the relay.
    tokio::select! {
        r = c2u => r?,
        r = u2c => r?,
    }
    Ok(())
}

fn axum_to_tungstenite(msg: AxumMsg) -> Option<WsMsg> {
    Some(match msg {
        AxumMsg::Text(t) => WsMsg::Text(t.as_str().to_string()),
        AxumMsg::Binary(b) => WsMsg::Binary(b.to_vec()),
        AxumMsg::Ping(b) => WsMsg::Ping(b.to_vec()),
        AxumMsg::Pong(b) => WsMsg::Pong(b.to_vec()),
        AxumMsg::Close(_) => WsMsg::Close(None),
    })
}

fn tungstenite_to_axum(msg: WsMsg) -> Option<AxumMsg> {
    Some(match msg {
        WsMsg::Text(t) => AxumMsg::Text(t.as_str().into()),
        WsMsg::Binary(b) => AxumMsg::Binary(b.into()),
        WsMsg::Ping(b) => AxumMsg::Ping(b.into()),
        WsMsg::Pong(b) => AxumMsg::Pong(b.into()),
        WsMsg::Close(_) => AxumMsg::Close(None),
        // Raw frames are an internal tungstenite detail; never surfaced here.
        WsMsg::Frame(_) => return None,
    })
}
