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
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as WsMsg};

use crate::state::AppState;

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
fn upstream_authority(state: &AppState) -> &str {
    let url = &state.config.ysweet_url;
    let without_scheme = url.split("://").nth(1).unwrap_or(url);
    without_scheme.trim_end_matches('/')
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
    let authority = upstream_authority(&state).to_string();
    let (mut parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| parts.uri.path())
        .to_string();

    if is_websocket_upgrade(&parts.headers) {
        let ws = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(ws) => ws,
            Err(rej) => return rej.into_response(),
        };
        let target = format!("ws://{authority}{path_and_query}");
        return ws.on_upgrade(move |client| async move {
            if let Err(e) = relay_ws(client, &target).await {
                tracing::debug!("y-sweet ws proxy closed: {e}");
            }
        });
    }

    let bytes = match axum::body::to_bytes(body, MAX_BODY_BYTES).await {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, "request body too large").into_response(),
    };

    match proxy_http(&state, &parts.method, &authority, &path_and_query, &parts.headers, bytes)
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

    let upstream = req.send().await?;

    let mut builder = Response::builder().status(upstream.status());
    for (name, value) in upstream.headers() {
        if !HOP_BY_HOP.contains(&name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    let bytes = upstream.bytes().await?;
    Ok(builder
        .body(axum::body::Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()))
}

/// Open an upstream WebSocket to y-sweet and pump frames in both directions.
async fn relay_ws(client: WebSocket, target: &str) -> anyhow::Result<()> {
    // Connect over plain TCP (y-sweet is internal, no TLS) using the target's authority.
    let request = target.into_client_request()?;
    let host = request
        .uri()
        .authority()
        .map(|a| a.as_str().to_string())
        .ok_or_else(|| anyhow::anyhow!("missing authority in {target}"))?;
    let tcp = TcpStream::connect(&host).await?;
    let (upstream, _resp) = tokio_tungstenite::client_async(request, tcp).await?;

    let (mut up_tx, mut up_rx) = upstream.split();
    let (mut cl_tx, mut cl_rx) = client.split();

    // client -> upstream
    let c2u = async {
        while let Some(msg) = cl_rx.next().await {
            let msg = msg?;
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
