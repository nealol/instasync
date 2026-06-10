//! Integration tests over the axum app with the mock OIDC issuer, a temp sqlite
//! db, and a hermetic fake y-sweet (so the doc-token relay path is exercised
//! without the real binary).

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use realtime_server::config::{Config, OidcMode};
use realtime_server::{app, build_state, gen_auth_key};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tower::ServiceExt;

// ---------- fake y-sweet ----------

async fn fake_ysweet() -> String {
    use axum::extract::Path;
    use axum::http::HeaderMap;
    use axum::routing::post;
    use axum::Json;

    async fn new_doc(Json(body): Json<Value>) -> Json<Value> {
        Json(json!({ "docId": body.get("docId").cloned().unwrap_or(Value::Null) }))
    }
    async fn auth_doc(headers: HeaderMap, Path(doc_id): Path<String>) -> Json<Value> {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1")
            .to_string();
        Json(json!({
            "url": format!("ws://{host}/d/{doc_id}"),
            "baseUrl": format!("http://{host}/d/{doc_id}"),
            "docId": doc_id,
            "token": "fake-token",
            "authorization": "full",
        }))
    }

    let router = Router::new()
        .route("/doc/new", post(new_doc))
        .route("/doc/{doc_id}/auth", post(auth_doc));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

// ---------- fake y-sweet that also serves /as-update (for the git audit test) ----------

fn text_update(name: &str, value: &str) -> Vec<u8> {
    use yrs::{Text, Transact};
    let doc = yrs::Doc::new();
    let text = doc.get_or_insert_text(name);
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, value);
    }
    use yrs::ReadTxn;
    let u = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    u
}

fn files_update(entries: &[(&str, &str)]) -> Vec<u8> {
    use yrs::{Map, Transact};
    let doc = yrs::Doc::new();
    let map = doc.get_or_insert_map("files");
    {
        let mut txn = doc.transact_mut();
        for (path, guid) in entries {
            map.insert(&mut txn, path.to_string(), guid.to_string());
        }
    }
    use yrs::ReadTxn;
    let u = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    u
}

/// A fake y-sweet whose `/doc/{id}/as-update` returns deterministic state: the
/// index doc (id without `__`) yields a one-entry `files` map, and each file doc
/// (`{vault}__{guid}`) yields `contents` text derived from its guid.
async fn fake_ysweet_as_update() -> String {
    use axum::extract::Path;
    use axum::http::HeaderMap;
    use axum::routing::{get, post};
    use axum::Json;

    async fn auth_doc(headers: HeaderMap, Path(doc_id): Path<String>) -> Json<Value> {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1")
            .to_string();
        Json(json!({
            "url": format!("ws://{host}/d/{doc_id}"),
            "baseUrl": format!("http://{host}/d/{doc_id}"),
            "docId": doc_id,
            "token": "fake-token",
            "authorization": "read-only",
        }))
    }

    async fn as_update(Path(doc_id): Path<String>) -> Vec<u8> {
        match doc_id.split_once("__") {
            Some((_, guid)) => text_update("contents", &format!("# Note {guid}\n")),
            None => files_update(&[("note.md", "g1")]),
        }
    }

    let router = Router::new()
        .route("/doc/{doc_id}/auth", post(auth_doc))
        .route("/d/{doc_id}/as-update", get(as_update));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

/// Shared doc store for [`fake_ysweet_store_with_docs`].
type FakeDocs = Arc<Mutex<HashMap<String, Vec<u8>>>>;

async fn fake_ysweet_store() -> String {
    fake_ysweet_store_with_docs().await.0
}

/// Like [`fake_ysweet_store`] but also returns the backing doc map so tests can
/// seed and inspect raw doc state directly (used by the plugin-db tests).
async fn fake_ysweet_store_with_docs() -> (String, FakeDocs) {
    use axum::body::Bytes;
    use axum::extract::{Path, State};
    use axum::http::HeaderMap;
    use axum::routing::{get, post};
    use axum::Json;
    use yrs::updates::decoder::Decode;
    use yrs::{ReadTxn, Transact};

    type Docs = FakeDocs;

    fn empty_update() -> Vec<u8> {
        let doc = yrs::Doc::new();
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        update
    }

    async fn new_doc(State(docs): State<Docs>, Json(body): Json<Value>) -> Json<Value> {
        let doc_id = body
            .get("docId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        docs.lock()
            .await
            .entry(doc_id.clone())
            .or_insert_with(empty_update);
        Json(json!({ "docId": doc_id }))
    }

    async fn auth_doc(headers: HeaderMap, Path(doc_id): Path<String>) -> Json<Value> {
        let host = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("127.0.0.1")
            .to_string();
        Json(json!({
            "url": format!("ws://{host}/d/{doc_id}"),
            "baseUrl": format!("http://{host}/d/{doc_id}"),
            "docId": doc_id,
            "token": "fake-token",
            "authorization": "full",
        }))
    }

    async fn as_update(State(docs): State<Docs>, Path(doc_id): Path<String>) -> Vec<u8> {
        docs.lock()
            .await
            .get(&doc_id)
            .cloned()
            .unwrap_or_else(empty_update)
    }

    async fn update(
        State(docs): State<Docs>,
        Path(doc_id): Path<String>,
        body: Bytes,
    ) -> Json<Value> {
        let base = docs
            .lock()
            .await
            .get(&doc_id)
            .cloned()
            .unwrap_or_else(empty_update);
        let doc = yrs::Doc::new();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(yrs::Update::decode_v1(&base).unwrap());
            txn.apply_update(yrs::Update::decode_v1(&body).unwrap());
        }
        let merged = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        docs.lock().await.insert(doc_id, merged);
        Json(json!({ "ok": true }))
    }

    let docs: Docs = Arc::new(Mutex::new(HashMap::new()));
    let router = Router::new()
        .route("/doc/new", post(new_doc))
        .route("/doc/{doc_id}/auth", post(auth_doc))
        .route("/d/{doc_id}/as-update", get(as_update))
        .route("/d/{doc_id}/update", post(update))
        .with_state(docs.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (format!("http://{addr}"), docs)
}

async fn fake_attachment_source() -> String {
    use axum::routing::get;

    async fn image() -> ([(&'static str, &'static str); 1], Vec<u8>) {
        ([("content-type", "image/png")], b"remote image".to_vec())
    }

    let router = Router::new().route("/image.png", get(image));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    format!("http://{addr}")
}

/// Build a git-enabled `AppState` plus its repo dir and a synthetic vault id.
async fn git_state(
    ysweet_url: &str,
) -> (realtime_server::state::AppState, std::path::PathBuf, String) {
    git_state_ext(ysweet_url, None).await
}

/// Like [`git_state`], optionally wiring the cr-sqlite loadable extension.
async fn git_state_ext(
    ysweet_url: &str,
    crsqlite_ext_path: Option<String>,
) -> (realtime_server::state::AppState, std::path::PathBuf, String) {
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("realtime-test-{}.db", uuid::Uuid::new_v4()));
    let mut git_dir = std::env::temp_dir();
    git_dir.push(format!("realtime-git-{}", uuid::Uuid::new_v4()));

    let config = Config {
        database_url: format!("sqlite://{}?mode=rwc", db_path.display()),
        bind_addr: "127.0.0.1:0".into(),
        public_base_url: "http://auth.test".into(),
        blob_dir: std::env::temp_dir().display().to_string(),
        ysweet_store_dir: None,
        ysweet_url: ysweet_url.to_string(),
        ysweet_public_url: ysweet_url.to_string(),
        ysweet_auth_key: gen_auth_key(),
        oidc_mode: OidcMode::Mock,
        oidc_issuer: None,
        oidc_client_id: None,
        oidc_client_secret: None,
        oidc_redirect_url: None,
        allowed_login_redirects: vec![],
        cors_allowed_origins: vec![],
        git_data_dir: git_dir.display().to_string(),
        git_enabled: true,
        git_debounce_ms: 50,
        git_bot_name: "Realtime".into(),
        git_bot_email: "realtime@localhost".into(),
        cursor_email_domain: "localhost".into(),
        git_remote_url: None,
        git_push_enabled: false,
        daily_note_path_template: "Daily Notes/{{YYYY-MM-DD}}.md".into(),
        weekly_note_path_template: None,
        monthly_note_path_template: None,
        quarterly_note_path_template: None,
        yearly_note_path_template: None,
        attachment_fetch_host_allowlist: vec![],
        attachment_allowed_extensions: vec![
            "png".into(),
            "jpg".into(),
            "jpeg".into(),
            "gif".into(),
            "webp".into(),
            "svg".into(),
            "pdf".into(),
            "txt".into(),
        ],
        attachment_max_bytes: realtime_server::blobs::MAX_BLOB_BYTES,
        attachments_path_mode: "relative".into(),
        attachments_subfolder: None,
        upload_token: "test-upload-token".into(),
        crsqlite_ext_path,
    };
    let state = build_state(config).await.unwrap();
    let vault_id = uuid::Uuid::new_v4().to_string();
    (state, git_dir, vault_id)
}

fn git_out(repo: &std::path::Path, args: &[&str]) -> (bool, String) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .expect("run git");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).trim().to_string(),
    )
}

/// Poll the repo until a commit appears (or time out), returning the last log line.
async fn wait_for_commit(repo: &std::path::Path) -> String {
    for _ in 0..100 {
        let (ok, line) = git_out(repo, &["log", "-1", "--format=%an|%ae|%s"]);
        if ok && !line.is_empty() {
            return line;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("no commit appeared in repo {}", repo.display());
}

fn principal(id: &str, name: &str, email: &str) -> realtime_server::state::Principal {
    realtime_server::state::Principal {
        user_id: id.into(),
        display_name: name.into(),
        email: email.into(),
        actor: realtime_server::state::PrincipalActor::User,
        expires_at_ms: i64::MAX,
    }
}

// ---------- harness ----------

async fn test_app(ysweet_url: &str, ysweet_public_url: &str) -> Router {
    test_app_with_attachment_max(
        ysweet_url,
        ysweet_public_url,
        realtime_server::blobs::MAX_BLOB_BYTES,
    )
    .await
}

async fn test_app_with_attachment_max(
    ysweet_url: &str,
    ysweet_public_url: &str,
    attachment_max_bytes: u64,
) -> Router {
    let mut path = std::env::temp_dir();
    path.push(format!("realtime-test-{}.db", uuid::Uuid::new_v4()));
    let database_url = format!("sqlite://{}?mode=rwc", path.display());

    let mut blob_dir = std::env::temp_dir();
    blob_dir.push(format!("realtime-blobs-{}", uuid::Uuid::new_v4()));

    let mut git_dir = std::env::temp_dir();
    git_dir.push(format!("realtime-git-{}", uuid::Uuid::new_v4()));

    let config = Config {
        database_url,
        bind_addr: "127.0.0.1:0".into(),
        public_base_url: "http://auth.test".into(),
        blob_dir: blob_dir.display().to_string(),
        ysweet_store_dir: None,
        ysweet_url: ysweet_url.to_string(),
        ysweet_public_url: ysweet_public_url.to_string(),
        ysweet_auth_key: gen_auth_key(),
        oidc_mode: OidcMode::Mock,
        oidc_issuer: None,
        oidc_client_id: None,
        oidc_client_secret: None,
        oidc_redirect_url: None,
        allowed_login_redirects: vec!["http://app".into()],
        cors_allowed_origins: vec!["http://app".into()],
        git_data_dir: git_dir.display().to_string(),
        // Off by default; the git-specific test builds its own app with it enabled.
        git_enabled: false,
        git_debounce_ms: 50,
        git_bot_name: "Realtime".into(),
        git_bot_email: "realtime@localhost".into(),
        cursor_email_domain: "localhost".into(),
        git_remote_url: None,
        git_push_enabled: false,
        daily_note_path_template: "Daily Notes/{{YYYY-MM-DD}}.md".into(),
        weekly_note_path_template: None,
        monthly_note_path_template: None,
        quarterly_note_path_template: None,
        yearly_note_path_template: None,
        attachment_fetch_host_allowlist: vec!["127.0.0.1".into()],
        attachment_allowed_extensions: vec![
            "png".into(),
            "jpg".into(),
            "jpeg".into(),
            "gif".into(),
            "webp".into(),
            "svg".into(),
            "pdf".into(),
            "txt".into(),
        ],
        attachment_max_bytes,
        attachments_path_mode: "relative".into(),
        attachments_subfolder: None,
        upload_token: "test-upload-token".into(),
        crsqlite_ext_path: None,
    };
    let state = build_state(config).await.unwrap();
    app(state)
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    let req = if let Some(b) = body {
        req.header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&b).unwrap()))
            .unwrap()
    } else {
        req.body(Body::empty()).unwrap()
    };

    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

async fn multipart_upload(
    app: &Router,
    token: &str,
    path: &str,
    filename: &str,
    content_type: &str,
    bytes: &[u8],
) -> (StatusCode, Value) {
    let boundary = format!("----realtime-{}", uuid::Uuid::new_v4());
    let mut body = Vec::new();
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n{path}\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/upload?token={token}"))
                .header(
                    header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    (status, value)
}

/// Drive the mock login flow and return a session token for the given subject.
async fn login(app: &Router, sub: &str) -> String {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/auth/login?redirect=http://app/cb&mock_sub={sub}&mock_name={sub}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER, "login should redirect");
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let state = url::Url::parse(&format!("http://x{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/auth/callback?state={state}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        res.status(),
        StatusCode::SEE_OTHER,
        "callback should redirect"
    );
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    url::Url::parse(loc)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "token")
        .unwrap()
        .1
        .into_owned()
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

async fn oauth_token(app: &Router, owner_sub: &str, verifier: &str) -> (String, String, String) {
    let session = login(app, owner_sub).await;
    let (status, vault) = send(
        app,
        "POST",
        "/api/vaults",
        Some(&session),
        Some(json!({"name": "OAuth Vault"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap().to_string();

    let (status, cursor) = send(
        app,
        "POST",
        &format!("/api/vaults/{vault_id}/cursors"),
        Some(&session),
        Some(json!({"name": "MCP Client"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resource = cursor["mcpUrl"].as_str().unwrap();

    let (status, client) = send(
        app,
        "POST",
        "/oauth/register",
        None,
        Some(json!({"redirect_uris": ["http://client/cb"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let client_id = client["client_id"].as_str().unwrap();

    let authorize_uri = format!(
        "/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Fclient%2Fcb&code_challenge={}&code_challenge_method=S256&resource={}&state=s1&mock_sub={owner_sub}&mock_name={owner_sub}",
        pkce_challenge(verifier),
        url::form_urlencoded::byte_serialize(resource.as_bytes()).collect::<String>()
    );
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(authorize_uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let oidc_state = url::Url::parse(&format!("http://x{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/auth/callback?state={oidc_state}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SEE_OTHER);
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let code = url::Url::parse(loc)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();

    let body = format!(
        "grant_type=authorization_code&code={code}&redirect_uri=http%3A%2F%2Fclient%2Fcb&client_id={client_id}&code_verifier={verifier}"
    );
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let tokens: Value = serde_json::from_slice(&bytes).unwrap();
    (
        tokens["access_token"].as_str().unwrap().to_string(),
        tokens["refresh_token"].as_str().unwrap().to_string(),
        vault_id,
    )
}

// ---------- tests ----------

#[tokio::test]
async fn login_creates_session_and_me_works() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;

    let token = login(&app, "alice").await;
    let (status, me) = send(&app, "GET", "/api/me", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["displayName"], "alice");

    // No bearer -> 401.
    let (status, _) = send(&app, "GET", "/api/me", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn server_info_returns_stable_id_without_auth() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;

    // Public: no bearer required.
    let (status, info) = send(&app, "GET", "/api/server-info", None, None).await;
    assert_eq!(status, StatusCode::OK);
    let id = info["serverId"].as_str().expect("serverId string");
    assert!(!id.is_empty());

    // Stable across calls on the same server.
    let (_, again) = send(&app, "GET", "/api/server-info", None, None).await;
    assert_eq!(again["serverId"].as_str(), Some(id));
}

#[tokio::test]
async fn logout_revokes_session() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;

    let token = login(&app, "alice").await;
    let (status, _) = send(&app, "POST", "/api/logout", Some(&token), Some(json!({}))).await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(&app, "GET", "/api/me", Some(&token), None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn login_rejects_unallowed_redirect() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/auth/login?redirect=https://evil.example/cb")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn openapi_json_and_swagger_docs_are_served() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;

    let (status, spec) = send(&app, "GET", "/openapi.json", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(spec["openapi"], "3.1.0");
    let paths = spec["paths"].as_object().unwrap();
    assert!(paths.contains_key("/api/vaults/{id}/notes/{path}"));
    assert!(paths.contains_key("/api/vaults/{id}/attachments/upload-link"));
    assert!(paths.contains_key("/oauth/token"));
    assert!(paths.contains_key("/upload"));
    assert!(paths.contains_key("/n/{guid}"));
    assert!(!paths.contains_key("/mcp/i/{app_id}"));
    assert!(!paths.contains_key("/d/{rest}"));
    assert!(!paths.contains_key("/api/doc-token"));
    assert!(!paths.contains_key("/api/vaults/{id}/blobs/{hash}"));
    assert!(spec["components"]["securitySchemes"]["bearerAuth"].is_object());

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/docs/")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8_lossy(&body);
    assert!(html.contains("Swagger UI"));
}

#[tokio::test]
async fn oauth_authorize_token_refresh_and_rest_access() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let verifier = "correct-horse-battery-staple";
    let (access, refresh, vault_id) = oauth_token(&app, "alice", verifier).await;

    let (status, note) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/notes"),
        Some(&access),
        Some(json!({"path": "oauth.md", "content": "hello"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(note["path"], "oauth.md");

    let body = format!("grant_type=refresh_token&refresh_token={refresh}");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn oauth_rejects_bad_pkce_and_is_single_use() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let session = login(&app, "alice").await;
    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&session),
        Some(json!({"name":"v"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap();
    let (status, cursor) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/cursors"),
        Some(&session),
        Some(json!({"name":"c"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resource = cursor["mcpUrl"].as_str().unwrap();
    let (status, client) = send(
        &app,
        "POST",
        "/oauth/register",
        None,
        Some(json!({"redirect_uris":["http://client/cb"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let client_id = client["client_id"].as_str().unwrap();
    let uri = format!("/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Fclient%2Fcb&code_challenge={}&code_challenge_method=S256&resource={}&mock_sub=alice", pkce_challenge("good"), url::form_urlencoded::byte_serialize(resource.as_bytes()).collect::<String>());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let oidc_state = url::Url::parse(&format!("http://x{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/auth/callback?state={oidc_state}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let code = url::Url::parse(loc)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "code")
        .unwrap()
        .1
        .into_owned();
    let body = format!("grant_type=authorization_code&code={code}&redirect_uri=http%3A%2F%2Fclient%2Fcb&client_id={client_id}&code_verifier=bad");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let body = format!("grant_type=authorization_code&code={code}&redirect_uri=http%3A%2F%2Fclient%2Fcb&client_id={client_id}&code_verifier=good");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/oauth/token")
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn oauth_wrong_owner_authorize_forbidden() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let session = login(&app, "alice").await;
    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&session),
        Some(json!({"name":"v"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap();
    let (status, cursor) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/cursors"),
        Some(&session),
        Some(json!({"name":"c"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let resource = cursor["mcpUrl"].as_str().unwrap();
    let (status, client) = send(
        &app,
        "POST",
        "/oauth/register",
        None,
        Some(json!({"redirect_uris":["http://client/cb"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let client_id = client["client_id"].as_str().unwrap();
    let uri = format!("/oauth/authorize?response_type=code&client_id={client_id}&redirect_uri=http%3A%2F%2Fclient%2Fcb&code_challenge={}&code_challenge_method=S256&resource={}&mock_sub=bob", pkce_challenge("good"), url::form_urlencoded::byte_serialize(resource.as_bytes()).collect::<String>());
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    let oidc_state = url::Url::parse(&format!("http://x{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/auth/callback?state={oidc_state}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn mcp_unauthenticated_returns_resource_metadata_challenge() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let session = login(&app, "alice").await;
    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&session),
        Some(json!({"name":"v"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap();
    let (status, cursor) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/cursors"),
        Some(&session),
        Some(json!({"name":"c"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let app_id = cursor["appId"].as_str().unwrap();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/mcp/i/{app_id}"))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    let challenge = res
        .headers()
        .get(header::WWW_AUTHENTICATE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(challenge.contains(&format!(
        "/.well-known/oauth-protected-resource/mcp/i/{app_id}"
    )));
}

async fn mcp_call(
    app: &Router,
    app_id: &str,
    token: &str,
    id: i64,
    method: &str,
    params: Value,
) -> (StatusCode, Value) {
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/mcp/i/{app_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .header(header::HOST, "127.0.0.1")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json, text/event-stream")
                .body(Body::from(
                    serde_json::to_vec(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "method": method,
                        "params": params,
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    (status, value)
}

#[tokio::test]
async fn mcp_lists_tools_and_round_trips_note_edits() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let session = login(&app, "alice").await;
    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&session),
        Some(json!({"name":"v"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap();
    let (status, cursor) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/cursors"),
        Some(&session),
        Some(json!({"name":"c"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let app_id = cursor["appId"].as_str().unwrap();
    let secret = cursor["secretToken"].as_str().unwrap();

    let (status, list) = mcp_call(&app, app_id, secret, 1, "tools/list", json!({})).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    let tools = list["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "create_note"));
    assert!(tools.iter().any(|tool| tool["name"] == "read_attachment"));

    let (status, created) = mcp_call(
        &app,
        app_id,
        secret,
        2,
        "tools/call",
        json!({
            "name": "create_note",
            "arguments": {"path": "mcp.md", "content": "hello"}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["result"]["isError"], false);

    let (status, patched) = mcp_call(
        &app,
        app_id,
        secret,
        3,
        "tools/call",
        json!({
            "name": "patch_note",
            "arguments": {"path": "mcp.md", "old": "hello", "new": "hello mcp"}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{patched}");
    assert_eq!(patched["result"]["isError"], false);

    let (status, read) = mcp_call(
        &app,
        app_id,
        secret,
        4,
        "tools/call",
        json!({
            "name": "read_note",
            "arguments": {"path": "mcp.md"}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{read}");
    assert_eq!(
        read["result"]["structuredContent"]["data"]["content"],
        "hello mcp"
    );
}

#[tokio::test]
async fn create_list_vault() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;

    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(vault["role"], "admin");
    assert_eq!(vault["owner"], true);
    assert!(vault["createdBy"].as_str().is_some());

    let (status, list) = send(&app, "GET", "/api/vaults", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn note_crud_rest_roundtrip() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();

    let notes_url = format!("/api/vaults/{vault_id}/notes");
    let (status, created) = send(
        &app,
        "POST",
        &notes_url,
        Some(&token),
        Some(json!({"path": "dir/a.md", "content": "# A\n"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["path"], "dir/a.md");
    assert_eq!(created["content"], "# A\n");
    assert!(created["permalink"].as_str().unwrap().contains("/n/"));
    let guid = created["guid"].as_str().unwrap();

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/n/{guid}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(loc.starts_with("obsidian://realtime-open?"));
    assert!(loc.contains(&format!("vaultId={vault_id}")));
    assert!(loc.contains(&format!("guid={guid}")));

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/p?vault={vault_id}&path=dir%2Fa.md"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::TEMPORARY_REDIRECT);
    let loc = res
        .headers()
        .get(header::LOCATION)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(loc.contains("path=dir%2Fa.md"));

    let (status, list) = send(&app, "GET", &notes_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["path"], "dir/a.md");

    let note_url = format!("/api/vaults/{vault_id}/notes/dir/a.md");
    let (status, read) = send(&app, "GET", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["content"], "# A\n");

    let (status, replaced) = send(
        &app,
        "PUT",
        &note_url,
        Some(&token),
        Some(json!({"content": "# B\nbody"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(replaced["content"], "# B\nbody");

    let (status, read) = send(&app, "GET", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(read["content"], "# B\nbody");

    let (status, patched) = send(
        &app,
        "PATCH",
        &note_url,
        Some(&token),
        Some(json!({"old": "body", "new": "patched"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(patched["content"], "# B\npatched");

    let (status, with_fm) = send(
        &app,
        "PUT",
        &note_url,
        Some(&token),
        Some(json!({"content": "---\ntitle: Old\ntags:\n  - a\n---\n# B\npatched"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(with_fm["content"].as_str().unwrap().starts_with("---\n"));

    let fm_url = format!("/api/vaults/{vault_id}/note-frontmatter/dir/a.md");
    let (status, fm) = send(&app, "GET", &fm_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(fm["frontmatter"]["title"], "Old");

    let (status, fm_patched) = send(
        &app,
        "PATCH",
        &fm_url,
        Some(&token),
        Some(json!({"set": {"title": "New", "draft": true}, "unset": ["tags"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let content = fm_patched["content"].as_str().unwrap();
    assert!(content.contains("title: New"), "{content}");
    assert!(content.contains("draft: true"), "{content}");
    assert!(!content.contains("tags:"), "{content}");

    let move_url = format!("/api/vaults/{vault_id}/note-moves/dir/a.md");
    let (status, moved) = send(
        &app,
        "POST",
        &move_url,
        Some(&token),
        Some(json!({"toPath": "dir/b.md"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved["path"], "dir/b.md");
    assert!(moved["content"].as_str().unwrap().contains("# B\npatched"));

    let (status, _) = send(&app, "GET", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let note_url = format!("/api/vaults/{vault_id}/notes/dir/b.md");
    let (status, read) = send(&app, "GET", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(read["content"].as_str().unwrap().contains("# B\npatched"));

    let (status, deleted) = send(&app, "DELETE", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["ok"], true);

    let (status, _) = send(&app, "GET", &note_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn periodic_daily_note_get_create_and_append() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();

    let periodic_url = format!("/api/vaults/{vault_id}/periodic/daily");
    let (status, note) = send(
        &app,
        "POST",
        &periodic_url,
        Some(&token),
        Some(json!({"date": "2026-06-06", "content": "# Today"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(note["path"], "Daily Notes/2026-06-06.md");
    assert_eq!(note["content"], "# Today");

    let (status, same) = send(
        &app,
        "POST",
        &periodic_url,
        Some(&token),
        Some(json!({"date": "2026-06-06", "content": "ignored"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(same["guid"], note["guid"]);
    assert_eq!(same["content"], "# Today");

    let append_url = format!("/api/vaults/{vault_id}/periodic/daily/append");
    let (status, appended) = send(
        &app,
        "POST",
        &append_url,
        Some(&token),
        Some(json!({"date": "2026-06-06", "text": "- item"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(appended["content"], "# Today\n- item");
}

#[tokio::test]
async fn attachment_upload_list_read_delete_roundtrip() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();
    let url = format!("/api/vaults/{vault_id}/attachments/images/pic.png");

    let payload = b"image bytes".to_vec();
    let (status, uploaded_bytes) = send_raw(&app, "PUT", &url, Some(&token), payload.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let uploaded: Value = serde_json::from_slice(&uploaded_bytes).unwrap();
    assert_eq!(uploaded["path"], "images/pic.png");
    assert_eq!(uploaded["size"], payload.len() as i64);
    let hash = uploaded["hash"].as_str().unwrap();
    assert_eq!(hash.len(), 64);

    let list_url = format!("/api/vaults/{vault_id}/attachments");
    let (status, list) = send(&app, "GET", &list_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["hash"], hash);

    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(
        res.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(bytes.as_ref(), payload.as_slice());

    let move_url = format!("/api/vaults/{vault_id}/attachment-moves/images/pic.png");
    let (status, moved) = send(
        &app,
        "POST",
        &move_url,
        Some(&token),
        Some(json!({"toPath": "images/moved.png"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(moved["path"], "images/moved.png");
    assert_eq!(moved["hash"], hash);

    let (status, _) = send(&app, "GET", &url, Some(&token), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let url = format!("/api/vaults/{vault_id}/attachments/images/moved.png");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(bytes.as_ref(), payload.as_slice());

    let (status, deleted) = send(&app, "DELETE", &url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deleted["ok"], true);

    let (status, list) = send(&app, "GET", &list_url, Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn signed_upload_link_uploads_once_and_rejects_bad_inputs() {
    let ys = fake_ysweet_store().await;
    let app = test_app_with_attachment_max(&ys, &ys, 16).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();

    let link_url = format!("/api/vaults/{vault_id}/attachments/upload-link");
    let (status, link) = send(
        &app,
        "POST",
        &link_url,
        Some(&token),
        Some(json!({"landingDir": "uploads", "expiresInSeconds": 60})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let upload_token = link["token"].as_str().unwrap();

    let png = b"\x89PNG\r\n\x1a\n123";
    let (status, uploaded) =
        multipart_upload(&app, upload_token, "pic.png", "pic.png", "image/png", png).await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    assert_eq!(uploaded["path"], "uploads/pic.png");

    let (status, reused) = multipart_upload(
        &app,
        upload_token,
        "again.png",
        "again.png",
        "image/png",
        png,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{reused}");

    let (_, link) = send(
        &app,
        "POST",
        &link_url,
        Some(&token),
        Some(json!({"landingDir": "uploads"})),
    )
    .await;
    let upload_token = link["token"].as_str().unwrap();
    let (status, rejected) = multipart_upload(
        &app,
        upload_token,
        "bad.exe",
        "bad.exe",
        "application/octet-stream",
        b"abc",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");

    let (_, link) = send(
        &app,
        "POST",
        &link_url,
        Some(&token),
        Some(json!({"landingDir": "uploads"})),
    )
    .await;
    let upload_token = link["token"].as_str().unwrap();
    let (status, rejected) = multipart_upload(
        &app,
        upload_token,
        "page.txt",
        "page.txt",
        "text/html",
        b"<html>no</html>",
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");

    let (_, link) = send(
        &app,
        "POST",
        &link_url,
        Some(&token),
        Some(json!({"landingDir": "uploads"})),
    )
    .await;
    let upload_token = link["token"].as_str().unwrap();
    let (status, rejected) = multipart_upload(
        &app,
        upload_token,
        "big.txt",
        "big.txt",
        "text/plain",
        b"0123456789abcdefg",
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{rejected}");
}

#[tokio::test]
async fn attachment_upload_from_url_roundtrip() {
    let ys = fake_ysweet_store().await;
    let source = fake_attachment_source().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();

    let from_url = format!("/api/vaults/{vault_id}/attachments/from-url");
    let (status, uploaded) = send(
        &app,
        "POST",
        &from_url,
        Some(&token),
        Some(json!({"sourceUrl": format!("{source}/image.png"), "path": "web/image.png"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(uploaded["path"], "web/image.png");
    assert_eq!(uploaded["size"], "remote image".len() as i64);

    let url = format!("/api/vaults/{vault_id}/attachments/web/image.png");
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(&url)
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(bytes.as_ref(), b"remote image");
}

#[tokio::test]
async fn invite_is_single_use_and_grants_membership() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let admin = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    let carol = login(&app, "carol").await;

    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&admin),
        Some(json!({"name": "Shared"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();

    // Non-admin cannot invite.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/invites"),
        Some(&bob),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, invite) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/invites"),
        Some(&admin),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let code = invite["code"].as_str().unwrap().to_string();
    assert_eq!(code.split('-').count(), 4);

    // Bob redeems successfully.
    let (status, redeem) = send(
        &app,
        "POST",
        "/api/invites/redeem",
        Some(&bob),
        Some(json!({"code": code})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(redeem["vaultId"], vault_id);

    // Carol cannot reuse the same single-use code.
    let (status, _) = send(
        &app,
        "POST",
        "/api/invites/redeem",
        Some(&carol),
        Some(json!({"code": code})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn promote_member_to_admin() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let admin = login(&app, "alice").await;
    let bob = login(&app, "bob").await;
    let bob_id = send(&app, "GET", "/api/me", Some(&bob), None).await.1["userId"]
        .as_str()
        .unwrap()
        .to_string();

    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&admin),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();
    let (_, invite) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/invites"),
        Some(&admin),
        Some(json!({})),
    )
    .await;
    let code = invite["code"].as_str().unwrap().to_string();
    send(
        &app,
        "POST",
        "/api/invites/redeem",
        Some(&bob),
        Some(json!({"code": code})),
    )
    .await;

    // Bob (member) can list members; promotion still succeeds.
    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/members"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/members/{bob_id}/promote"),
        Some(&admin),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/members"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn remove_member_permissions() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let owner = login(&app, "owner").await;
    let admin = login(&app, "admin").await;
    let member = login(&app, "member").await;
    let outsider = login(&app, "outsider").await;

    let admin_id = send(&app, "GET", "/api/me", Some(&admin), None).await.1["userId"]
        .as_str()
        .unwrap()
        .to_string();
    let member_id = send(&app, "GET", "/api/me", Some(&member), None).await.1["userId"]
        .as_str()
        .unwrap()
        .to_string();
    let owner_id = send(&app, "GET", "/api/me", Some(&owner), None).await.1["userId"]
        .as_str()
        .unwrap()
        .to_string();

    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&owner),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();

    for token in [&admin, &member] {
        let (_, invite) = send(
            &app,
            "POST",
            &format!("/api/vaults/{vault_id}/invites"),
            Some(&owner),
            Some(json!({})),
        )
        .await;
        let code = invite["code"].as_str().unwrap().to_string();
        send(
            &app,
            "POST",
            "/api/invites/redeem",
            Some(token),
            Some(json!({"code": code})),
        )
        .await;
    }

    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/members/{admin_id}/promote"),
        Some(&owner),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/vaults/{vault_id}/members/{admin_id}"),
        Some(&admin),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "admin cannot remove another admin"
    );

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/vaults/{vault_id}/members/{member_id}"),
        Some(&admin),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "admin can remove a member");

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/vaults/{vault_id}/members/{admin_id}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "owner can remove an admin");

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/vaults/{vault_id}/members/{owner_id}"),
        Some(&owner),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "owner cannot remove themselves"
    );

    let (status, _) = send(
        &app,
        "DELETE",
        &format!("/api/vaults/{vault_id}/members/{owner_id}"),
        Some(&outsider),
        None,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "outsider cannot remove anyone"
    );
}

// ---------- blob store ----------

/// Send a request with a raw (non-JSON) body and return status + collected bytes.
async fn send_raw(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(b) = bearer {
        req = req.header(header::AUTHORIZATION, format!("Bearer {b}"));
    }
    let req = req.body(Body::from(body)).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn blob_put_head_get_roundtrip() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&alice),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();

    let content = b"\x00\x01\x02 binary payload \xff\xfe".to_vec();
    let hash = sha256_hex(&content);
    let uri = format!("/api/vaults/{vault_id}/blobs/{hash}");

    // Missing before upload.
    let (status, _) = send_raw(&app, "HEAD", &uri, Some(&alice), vec![]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Upload.
    let (status, _) = send_raw(&app, "PUT", &uri, Some(&alice), content.clone()).await;
    assert_eq!(status, StatusCode::OK);

    // Present after upload.
    let (status, _) = send_raw(&app, "HEAD", &uri, Some(&alice), vec![]).await;
    assert_eq!(status, StatusCode::OK);

    // Download returns identical bytes.
    let (status, got) = send_raw(&app, "GET", &uri, Some(&alice), vec![]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got, content);

    // Idempotent re-upload.
    let (status, _) = send_raw(&app, "PUT", &uri, Some(&alice), content.clone()).await;
    assert_eq!(status, StatusCode::OK);

    // A non-member of the vault is refused.
    let (status, _) = send_raw(&app, "GET", &uri, Some(&bob), vec![]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn blob_rejects_bad_hash_and_mismatch() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let alice = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&alice),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();

    // Non-hex / wrong-length hash is rejected before touching the filesystem.
    let bad = format!("/api/vaults/{vault_id}/blobs/not-a-valid-hash");
    let (status, _) = send_raw(&app, "PUT", &bad, Some(&alice), b"x".to_vec()).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Well-formed hash that doesn't match the body is rejected.
    let wrong = format!("/api/vaults/{vault_id}/blobs/{}", "a".repeat(64));
    let (status, _) = send_raw(&app, "PUT", &wrong, Some(&alice), b"payload".to_vec()).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn blob_requires_auth() {
    let ys = fake_ysweet().await;
    let app = test_app(&ys, &ys).await;
    let alice = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&alice),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();
    let uri = format!("/api/vaults/{vault_id}/blobs/{}", "b".repeat(64));

    let (status, _) = send_raw(&app, "HEAD", &uri, None, vec![]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ---------- git audit log ----------

#[tokio::test]
async fn git_audit_commits_attributed_to_principal() {
    let ys = fake_ysweet_as_update().await;
    let (state, git_dir, vault_id) = git_state(&ys).await;
    let repo = git_dir.join(&vault_id);

    // A write by Alice triggers a debounced commit materializing the vault tree.
    state
        .git
        .mark_write(
            &vault_id,
            &principal("u-alice", "Alice", "alice@example.com"),
        )
        .await;

    let log = wait_for_commit(&repo).await;
    assert_eq!(
        log, "Alice|alice@example.com|Sync 1 file(s)",
        "author/subject"
    );

    // Committer is pinned to the Realtime bot (not the server's git identity),
    // even though the author is the attributed user.
    let (_, committer) = git_out(&repo, &["log", "-1", "--format=%cn|%ce"]);
    assert_eq!(
        committer, "Realtime|realtime@localhost",
        "committer identity"
    );

    // The note's content was reconstructed from y-sweet, at its real vault path.
    let content = std::fs::read_to_string(repo.join("note.md")).unwrap();
    assert!(content.contains("# Note g1"), "got {content:?}");

    // Structured audit trailers are present and parseable.
    let (_, body) = git_out(&repo, &["log", "-1", "--format=%b"]);
    assert!(
        body.contains(&format!("Vault-Id: {vault_id}")),
        "trailers: {body}"
    );
    assert!(body.contains("Principal-Id: u-alice"), "trailers: {body}");

    // Idempotent: another write with no content change adds no commit.
    state
        .git
        .mark_write(
            &vault_id,
            &principal("u-alice", "Alice", "alice@example.com"),
        )
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let (_, count) = git_out(&repo, &["rev-list", "--count", "HEAD"]);
    assert_eq!(count, "1", "no-op write must not create a second commit");
}

#[tokio::test]
async fn doc_token_scopes_and_mints() {
    let ys = fake_ysweet().await;
    let public = "http://public.example:9999";
    let app = test_app(&ys, public).await;
    let alice = login(&app, "alice").await;
    let bob = login(&app, "bob").await;

    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&alice),
        Some(json!({"name": "V"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap().to_string();

    // Non-member is refused.
    let (status, _) = send(
        &app,
        "POST",
        "/api/doc-token",
        Some(&bob),
        Some(json!({"vaultId": vault_id, "docId": vault_id})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A docId outside the vault namespace is refused.
    let (status, _) = send(
        &app,
        "POST",
        "/api/doc-token",
        Some(&alice),
        Some(json!({"vaultId": vault_id, "docId": "someoneelse__abc"})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Member gets a token (default allow-all), with the host rewritten to public.
    let (status, token) = send(
        &app,
        "POST",
        "/api/doc-token",
        Some(&alice),
        Some(json!({"vaultId": vault_id, "docId": format!("{vault_id}__deadbeef")})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        token["url"]
            .as_str()
            .unwrap()
            .contains("public.example:9999"),
        "host should be rewritten to public url, got {}",
        token["url"]
    );
}

#[tokio::test]
async fn search_tags_backlinks_reindex_and_rename_rewrite() {
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let token = login(&app, "alice").await;
    let (_, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&token),
        Some(json!({"name": "Notes"})),
    )
    .await;
    let vault_id = vault["id"].as_str().unwrap();
    let notes_url = format!("/api/vaults/{vault_id}/notes");

    // alpha links to beta and carries frontmatter + inline tags.
    let (status, _) = send(
        &app,
        "POST",
        &notes_url,
        Some(&token),
        Some(json!({
            "path": "alpha.md",
            "content": "---\ntitle: Alpha Note\ntags:\n  - project\n  - rust\n---\nSee [[beta]] for details. #journal"
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _) = send(
        &app,
        "POST",
        &notes_url,
        Some(&token),
        Some(json!({"path": "beta.md", "content": "# Beta\nunique xyzzy content"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // FTS path (>= 3 chars): body-only term finds beta.
    let (status, hits) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/search?q=xyzzy"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let hits = hits.as_array().unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0]["path"], "beta.md");

    // LIKE fallback path (< 3 chars): matches alpha's path substring.
    let (status, hits) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/search?q=al"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let paths: Vec<&str> = hits
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"alpha.md"), "fallback hits: {paths:?}");

    // Tags aggregation.
    let (status, tags) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/tags"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let tag_names: Vec<&str> = tags
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["tag"].as_str().unwrap())
        .collect();
    assert!(tag_names.contains(&"project"));
    assert!(tag_names.contains(&"rust"));
    assert!(tag_names.contains(&"journal"));

    // Backlinks: alpha links to beta.
    let (status, backlinks) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/backlinks/beta.md"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let backlinks = backlinks.as_array().unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0]["path"], "alpha.md");

    // Reindex rebuilds from the authoritative CRDT (2 notes).
    let (status, reindexed) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/reindex"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reindexed["count"], 2);

    // Rename beta -> gamma and assert alpha's backlink was rewritten.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/note-moves/beta.md"),
        Some(&token),
        Some(json!({"toPath": "gamma.md"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, alpha) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/notes/alpha.md"),
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        alpha["content"].as_str().unwrap().contains("[[gamma]]"),
        "expected rewritten link, got {}",
        alpha["content"]
    );
}

// ---------- plugin databases (cr-sqlite) ----------
//
// The replica/dump/compaction tests need the cr-sqlite loadable extension and
// are gated on CRSQLITE_EXT_PATH (they skip cleanly when it is not set), e.g.:
//   CRSQLITE_EXT_PATH=/path/to/crsqlite.dylib cargo test plugin_db

fn crsqlite_ext() -> Option<String> {
    std::env::var("CRSQLITE_EXT_PATH")
        .ok()
        .filter(|p| std::path::Path::new(p).exists())
}

fn open_crsqlite(path: &std::path::Path, ext: &str) -> rusqlite::Connection {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = rusqlite::Connection::open(path).unwrap();
    // SAFETY: loading the operator-supplied test extension.
    unsafe {
        conn.load_extension_enable().unwrap();
        conn.load_extension(ext, Some("sqlite3_crsqlite_init")).unwrap();
        conn.load_extension_disable().unwrap();
    }
    conn
}

fn b64(bytes: &[u8]) -> String {
    // Tiny local base64 (std has none; avoids another dev-dependency).
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Read every `crsql_changes` row from a scratch source DB as wire-format JSON.
/// Returns `(site_hex, max_db_version, change_rows)`.
fn read_source_changes(conn: &rusqlite::Connection) -> (String, i64, Vec<Value>) {
    let mut stmt = conn
        .prepare(
            "SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq \
             FROM crsql_changes ORDER BY db_version, seq",
        )
        .unwrap();
    let mut site_hex = String::new();
    let mut max_v = 0i64;
    let rows = stmt
        .query_map([], |row| {
            let pk: Vec<u8> = row.get(1)?;
            let val: rusqlite::types::Value = row.get(3)?;
            let site: Vec<u8> = row.get(6)?;
            Ok((
                pk,
                row.get::<_, String>(0)?,
                row.get::<_, String>(2)?,
                val,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                site,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let changes = rows
        .into_iter()
        .map(|(pk, table, cid, val, col_version, db_version, site, cl, seq)| {
            site_hex = hex(&site);
            max_v = max_v.max(db_version);
            let val_json = match val {
                rusqlite::types::Value::Null => Value::Null,
                rusqlite::types::Value::Integer(i) => json!(i),
                rusqlite::types::Value::Real(f) => json!(f),
                rusqlite::types::Value::Text(t) => json!(t),
                rusqlite::types::Value::Blob(b) => json!({ "$blob": b64(&b) }),
            };
            json!({
                "table": table,
                "pk": b64(&pk),
                "cid": cid,
                "val": val_json,
                "col_version": col_version,
                "db_version": db_version,
                "site_id": b64(&site),
                "cl": cl,
                "seq": seq,
            })
        })
        .collect();
    (site_hex, max_v, changes)
}

fn json_to_any(v: &Value) -> yrs::Any {
    use yrs::Any;
    match v {
        Value::Null => Any::Null,
        Value::Bool(b) => Any::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Any::BigInt(i),
            None => Any::Number(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Any::String(s.clone().into()),
        Value::Array(a) => Any::Array(a.iter().map(json_to_any).collect::<Vec<_>>().into()),
        Value::Object(o) => Any::Map(
            o.iter()
                .map(|(k, v)| (k.clone(), json_to_any(v)))
                .collect::<HashMap<_, _>>()
                .into(),
        ),
    }
}

/// Encode a full plugin-db Y.Doc state: `batches`, `meta.schema`, optional tombstone.
fn plugin_db_doc_update(schema: &[String], batches: &Value, deleted_at: Option<i64>) -> Vec<u8> {
    use yrs::{Array, Map, ReadTxn, Transact};
    let doc = yrs::Doc::new();
    let batches_arr = doc.get_or_insert_array("batches");
    let meta = doc.get_or_insert_map("meta");
    {
        let mut txn = doc.transact_mut();
        for b in batches.as_array().unwrap() {
            batches_arr.push_back(&mut txn, json_to_any(b));
        }
        meta.insert(&mut txn, "schema", json_to_any(&json!(schema)));
        meta.insert(&mut txn, "schemaVersion", yrs::Any::BigInt(1));
        if let Some(ms) = deleted_at {
            meta.insert(&mut txn, "deletedAt", yrs::Any::BigInt(ms));
        }
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    update
}

/// Merge `meta.deletedAt` into an existing raw doc state.
async fn set_doc_deleted_at(docs: &FakeDocs, doc_id: &str, ms: i64) {
    use yrs::updates::decoder::Decode;
    use yrs::{Map, ReadTxn, Transact};
    let mut guard = docs.lock().await;
    let base = guard.get(doc_id).cloned().unwrap_or_default();
    let doc = yrs::Doc::new();
    {
        let mut txn = doc.transact_mut();
        if !base.is_empty() {
            txn.apply_update(yrs::Update::decode_v1(&base).unwrap());
        }
    }
    let meta = doc.get_or_insert_map("meta");
    {
        let mut txn = doc.transact_mut();
        meta.insert(&mut txn, "deletedAt", yrs::Any::BigInt(ms));
    }
    let merged = doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default());
    guard.insert(doc_id.to_string(), merged);
}

/// Scratch source DB with a CRR `tasks` table and two rows; returns the wire
/// batch JSON + schema DDL the client would publish.
fn make_source_batch(ext: &str) -> (Vec<String>, Value, String, i64) {
    let src = std::env::temp_dir().join(format!("crsql-src-{}.sqlite", uuid::Uuid::new_v4()));
    let conn = open_crsqlite(&src, ext);
    conn.execute_batch("CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title)")
        .unwrap();
    conn.execute_batch("SELECT crsql_as_crr('tasks')").unwrap();
    conn.execute("INSERT INTO tasks (id, title) VALUES ('a', 'alpha')", [])
        .unwrap();
    conn.execute("INSERT INTO tasks (id, title) VALUES ('b', 'beta')", [])
        .unwrap();
    let (site_hex, max_v, changes) = read_source_changes(&conn);
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    let batch = json!({
        "id": "batch-1",
        "siteId": site_hex,
        "fromDbVersion": 0,
        "toDbVersion": max_v,
        "schemaVersion": 1,
        "createdAt": 0,
        "format": "crsqlite-1",
        "changes": changes,
    });
    let schema = vec![
        "CREATE TABLE tasks (id PRIMARY KEY NOT NULL, title)".to_string(),
        "SELECT crsql_as_crr('tasks')".to_string(),
    ];
    (schema, json!([batch]), site_hex, max_v)
}

fn replica_file(git_dir: &std::path::Path, vault: &str, plugin: &str, name: &str) -> std::path::PathBuf {
    // replica_root derives from git_data_dir's parent (see plugindb.rs).
    git_dir
        .parent()
        .unwrap()
        .join("plugin-db-replicas")
        .join(vault)
        .join(plugin)
        .join(format!("{name}.sqlite"))
}

fn replica_titles(path: &std::path::Path, ext: &str) -> Vec<String> {
    let conn = open_crsqlite(path, ext);
    let mut stmt = conn
        .prepare("SELECT title FROM tasks ORDER BY id")
        .unwrap();
    let titles = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(stmt);
    let _ = conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()));
    titles
}

#[tokio::test]
async fn plugin_db_replication_dump_compaction_and_bootstrap() {
    let Some(ext) = crsqlite_ext() else {
        eprintln!("skipping plugin_db_replication test: CRSQLITE_EXT_PATH not set");
        return;
    };
    let (ys, docs) = fake_ysweet_store_with_docs().await;
    let (state, git_dir, vault_id) = git_state_ext(&ys, Some(ext.clone())).await;
    let repo = git_dir.join(&vault_id);

    // Seed the per-DB doc with one published batch (two task rows).
    let (schema, batches, site_hex, max_v) = make_source_batch(&ext);
    let doc_id = format!("{vault_id}__plugindb__my-plugin__tasks");
    docs.lock()
        .await
        .insert(doc_id.clone(), plugin_db_doc_update(&schema, &batches, None));

    // Replay batches -> replica matches the source.
    state.plugindb.mark_write(&vault_id, "my-plugin", "tasks").await;
    let replica = replica_file(&git_dir, &vault_id, "my-plugin", "tasks");
    for _ in 0..100 {
        if replica.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(replica.exists(), "replica file should be created");
    assert_eq!(replica_titles(&replica, &ext), vec!["alpha", "beta"]);

    // Compaction: the server replica covers the lone batch and no device
    // cursors hold it back, so the doc log gets trimmed.
    let mut compacted = false;
    for _ in 0..100 {
        let raw = docs.lock().await.get(&doc_id).cloned().unwrap();
        let view = realtime_server::plugindb::decode_doc(&raw).unwrap();
        if view.batches.is_empty() {
            assert_eq!(
                view.compacted_through.get(&site_hex),
                Some(&max_v),
                "compactedThrough must record the trimmed high-water mark"
            );
            compacted = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(compacted, "server should compact the fully-replicated log");

    // Bootstrap survives compaction: a fresh client (empty cursor) still gets
    // the full changeset, served from the replica.
    let rows = state
        .plugindb
        .bootstrap_changes(&vault_id, "my-plugin", "tasks", &HashMap::new())
        .await
        .unwrap();
    assert!(!rows.is_empty(), "bootstrap must serve compacted history");
    let tables: std::collections::HashSet<_> = rows.iter().map(|r| r.table.as_str()).collect();
    assert_eq!(tables, std::collections::HashSet::from(["tasks"]));
    // A caught-up cursor gets nothing.
    let mut caught_up = HashMap::new();
    caught_up.insert(site_hex.clone(), max_v);
    let none = state
        .plugindb
        .bootstrap_changes(&vault_id, "my-plugin", "tasks", &caught_up)
        .await
        .unwrap();
    assert!(none.is_empty(), "caught-up cursor should get no rows");

    // Git dump: deterministic, committed under .realtime/plugin-dbs/, restorable.
    let d1 = state.plugindb.dumps_for_vault(&vault_id).await;
    let d2 = state.plugindb.dumps_for_vault(&vault_id).await;
    assert_eq!(d1, d2, "dumps must be deterministic");
    assert_eq!(d1.len(), 1);
    let (rel, sql) = &d1[0];
    assert_eq!(
        rel.to_string_lossy(),
        ".realtime/plugin-dbs/my-plugin/tasks.sql"
    );
    assert!(sql.contains("-- crr: tasks"), "dump records CRR tables: {sql}");

    state
        .git
        .mark_write(&vault_id, &principal("u-alice", "Alice", "alice@example.com"))
        .await;
    wait_for_commit(&repo).await;
    let committed = repo.join(".realtime/plugin-dbs/my-plugin/tasks.sql");
    assert!(committed.exists(), "git tree must contain the dump");

    // Restore-from-dump round trip: fresh DB + dump + re-run crsql_as_crr.
    let restored = std::env::temp_dir().join(format!("crsql-restore-{}.sqlite", uuid::Uuid::new_v4()));
    let conn = open_crsqlite(&restored, &ext);
    let crr_tables: Vec<String> = sql
        .lines()
        .find_map(|l| l.strip_prefix("-- crr: "))
        .unwrap()
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();
    conn.execute_batch(sql).unwrap();
    for t in &crr_tables {
        conn.execute_batch(&format!("SELECT crsql_as_crr('{t}')")).unwrap();
    }
    let mut stmt = conn.prepare("SELECT title FROM tasks ORDER BY id").unwrap();
    let titles: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(titles, vec!["alpha", "beta"], "dump restore round-trips");
}

#[tokio::test]
async fn plugin_db_soft_delete_keeps_replica_and_purge_removes_everything() {
    let Some(ext) = crsqlite_ext() else {
        eprintln!("skipping plugin_db_purge test: CRSQLITE_EXT_PATH not set");
        return;
    };
    let (ys, docs) = fake_ysweet_store_with_docs().await;
    let (state, git_dir, vault_id) = git_state_ext(&ys, Some(ext.clone())).await;
    let repo = git_dir.join(&vault_id);

    let (schema, batches, _site_hex, _max_v) = make_source_batch(&ext);
    let doc_id = format!("{vault_id}__plugindb__my-plugin__tasks");
    docs.lock()
        .await
        .insert(doc_id.clone(), plugin_db_doc_update(&schema, &batches, None));

    // Replicate, then commit the dump.
    state.plugindb.mark_write(&vault_id, "my-plugin", "tasks").await;
    let replica = replica_file(&git_dir, &vault_id, "my-plugin", "tasks");
    for _ in 0..100 {
        if replica.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(replica.exists());
    state
        .git
        .mark_write(&vault_id, &principal("u-alice", "Alice", "alice@example.com"))
        .await;
    wait_for_commit(&repo).await;
    let committed_dump = repo.join(".realtime/plugin-dbs/my-plugin/tasks.sql");
    assert!(committed_dump.exists());

    // Soft delete: tombstone the doc. Replication stops but the replica stays.
    set_doc_deleted_at(&docs, &doc_id, 12345).await;
    state.plugindb.mark_write(&vault_id, "my-plugin", "tasks").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        replica.exists(),
        "soft-deleted database must keep its replica (it is restorable)"
    );

    // Purge: replica gone, doc trimmed + tombstoned, dump dropped from git.
    state
        .plugindb
        .purge(&vault_id, "my-plugin", "tasks")
        .await
        .unwrap();
    assert!(!replica.exists(), "purge must delete the replica file");
    let raw = docs.lock().await.get(&doc_id).cloned().unwrap();
    let view = realtime_server::plugindb::decode_doc(&raw).unwrap();
    assert!(view.batches.is_empty(), "purge must trim the batch log");
    assert!(view.deleted_at.is_some(), "purge must set the tombstone");
    assert!(
        state.plugindb.dumps_for_vault(&vault_id).await.is_empty(),
        "purged databases must not be dumped"
    );

    state
        .git
        .mark_write(&vault_id, &principal("u-alice", "Alice", "alice@example.com"))
        .await;
    for _ in 0..100 {
        let (_, count) = git_out(&repo, &["rev-list", "--count", "HEAD"]);
        if count == "2" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (_, count) = git_out(&repo, &["rev-list", "--count", "HEAD"]);
    assert_eq!(count, "2", "purge should produce a delete commit");
    assert!(
        !committed_dump.exists(),
        "the delete commit must remove the dump from the git tree"
    );
}

#[tokio::test]
async fn plugin_db_routes_validate_ids_and_membership() {
    // The store-backed fake serves /as-update, which the bootstrap route reads.
    let ys = fake_ysweet_store().await;
    let app = test_app(&ys, &ys).await;
    let alice = login(&app, "alice").await;

    let (status, vault) = send(
        &app,
        "POST",
        "/api/vaults",
        Some(&alice),
        Some(json!({"name": "Notes"})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let vault_id = vault["id"].as_str().unwrap().to_string();

    // Invalid plugin id -> 400 (matches the client-side [A-Za-z0-9_-]{1,80} rule).
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/plugin-dbs/bad!id/tasks/touch"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // `__` is the doc-id separator and is rejected to keep doc ids unambiguous.
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/plugin-dbs/bad__id/tasks/touch"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Non-members are rejected.
    let bob = login(&app, "bob").await;
    let (status, _) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/plugin-dbs/my-plugin/tasks/touch"),
        Some(&bob),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // A member can touch (arms replication + git debounces).
    let (status, body) = send(
        &app,
        "POST",
        &format!("/api/vaults/{vault_id}/plugin-dbs/my-plugin/tasks/touch"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], true);

    // Bootstrap on an empty/unknown db returns an empty changeset.
    let (status, body) = send(
        &app,
        "GET",
        &format!("/api/vaults/{vault_id}/plugin-dbs/my-plugin/tasks/changes"),
        Some(&alice),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["changes"], json!([]));
}

// ---------- cross-stack wire-format regression ----------
//
// `tests/fixtures/client-published-doc.bin` is a Y.Doc update produced by the
// REAL TypeScript client engine (SyncedPluginDatabase publishing through
// cr-sqlite WASM). Regenerate it after wire-format changes with:
//
//   npx tsx tests/support/genPluginDbDocFixture.mts
//
// This guards against drift between the client's JS/Yjs encoding (e.g. lib0
// float-vs-int number encoding) and the server's serde decode, which fabricated
// Rust-side batches can never catch.

#[tokio::test]
async fn plugin_db_decodes_and_replicates_a_real_client_published_doc() {
    let raw = include_bytes!("fixtures/client-published-doc.bin");
    let view = realtime_server::plugindb::decode_doc(raw).expect("decode client doc");

    // The client published one batch with four change rows (two task rows,
    // title + done columns each).
    assert_eq!(view.batches.len(), 1, "client batch must deserialize");
    let batch = &view.batches[0];
    assert_eq!(batch.changes.len(), 4, "all change rows must deserialize");
    assert!(
        view.schema.iter().any(|s| s.contains("crsql_as_crr")),
        "client-published schema must include the CRR call: {:?}",
        view.schema
    );

    // With the extension available, the batch must replay into a replica and
    // the dump must contain the client's rows.
    let Some(ext) = crsqlite_ext() else {
        eprintln!("skipping replica half: CRSQLITE_EXT_PATH not set");
        return;
    };
    let (ys, docs) = fake_ysweet_store_with_docs().await;
    let (state, git_dir, vault_id) = git_state_ext(&ys, Some(ext.clone())).await;
    let doc_id = format!("{vault_id}__plugindb__client-plugin__tasks");
    docs.lock().await.insert(doc_id.clone(), raw.to_vec());

    state
        .plugindb
        .mark_write(&vault_id, "client-plugin", "tasks")
        .await;
    let replica = replica_file(&git_dir, &vault_id, "client-plugin", "tasks");
    for _ in 0..100 {
        if replica.exists() && !replica_titles(&replica, &ext).is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        replica_titles(&replica, &ext),
        vec!["from-A", "from-B"],
        "replica must contain the client's rows"
    );

    let dumps = state.plugindb.dumps_for_vault(&vault_id).await;
    assert_eq!(dumps.len(), 1, "dump must exist for the replicated client db");
    assert!(dumps[0].1.contains("from-A") && dumps[0].1.contains("from-B"));
}
