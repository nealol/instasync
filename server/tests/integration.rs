//! Integration tests over the axum app with the mock OIDC issuer, a temp sqlite
//! db, and a hermetic fake y-sweet (so the doc-token relay path is exercised
//! without the real binary).

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use instasync_server::config::{Config, OidcMode};
use instasync_server::{app, build_state, gen_auth_key};
use serde_json::{json, Value};
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
    use axum::routing::get;

    async fn as_update(Path(doc_id): Path<String>) -> Vec<u8> {
        match doc_id.split_once("__") {
            Some((_, guid)) => text_update("contents", &format!("# Note {guid}\n")),
            None => files_update(&[("note.md", "g1")]),
        }
    }

    let router = Router::new().route("/doc/{doc_id}/as-update", get(as_update));
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
) -> (
    instasync_server::state::AppState,
    std::path::PathBuf,
    String,
) {
    let mut db_path = std::env::temp_dir();
    db_path.push(format!("instasync-test-{}.db", uuid::Uuid::new_v4()));
    let mut git_dir = std::env::temp_dir();
    git_dir.push(format!("instasync-git-{}", uuid::Uuid::new_v4()));

    let config = Config {
        database_url: format!("sqlite://{}?mode=rwc", db_path.display()),
        bind_addr: "127.0.0.1:0".into(),
        public_base_url: "http://auth.test".into(),
        blob_dir: std::env::temp_dir().display().to_string(),
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
        git_bot_name: "InstaSync".into(),
        git_bot_email: "instasync@localhost".into(),
        git_remote_url: None,
        git_push_enabled: false,
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

fn principal(id: &str, name: &str, email: &str) -> instasync_server::state::Principal {
    instasync_server::state::Principal {
        user_id: id.into(),
        display_name: name.into(),
        email: email.into(),
        expires_at_ms: i64::MAX,
    }
}

// ---------- harness ----------

async fn test_app(ysweet_url: &str, ysweet_public_url: &str) -> Router {
    let mut path = std::env::temp_dir();
    path.push(format!("instasync-test-{}.db", uuid::Uuid::new_v4()));
    let database_url = format!("sqlite://{}?mode=rwc", path.display());

    let mut blob_dir = std::env::temp_dir();
    blob_dir.push(format!("instasync-blobs-{}", uuid::Uuid::new_v4()));

    let mut git_dir = std::env::temp_dir();
    git_dir.push(format!("instasync-git-{}", uuid::Uuid::new_v4()));

    let config = Config {
        database_url,
        bind_addr: "127.0.0.1:0".into(),
        public_base_url: "http://auth.test".into(),
        blob_dir: blob_dir.display().to_string(),
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
        git_bot_name: "InstaSync".into(),
        git_bot_email: "instasync@localhost".into(),
        git_remote_url: None,
        git_push_enabled: false,
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
    assert_eq!(vault["createdBy"].as_str().is_some(), true);

    let (status, list) = send(&app, "GET", "/api/vaults", Some(&token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list.as_array().unwrap().len(), 1);
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

    // Committer is pinned to the InstaSync bot (not the server's git identity),
    // even though the author is the attributed user.
    let (_, committer) = git_out(&repo, &["log", "-1", "--format=%cn|%ce"]);
    assert_eq!(
        committer, "InstaSync|instasync@localhost",
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
