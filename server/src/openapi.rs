#![allow(dead_code)]

use axum::Json;
use serde_json::Value;
use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{Modify, OpenApi};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "InstaSync API",
        version = env!("CARGO_PKG_VERSION"),
        description = "REST, OAuth, auth, permalink, and public upload surfaces for InstaSync. MCP JSON-RPC, y-sweet proxy, raw blob store, and doc-token endpoints are intentionally excluded."
    ),
    modifiers(&SecurityAddon),
    paths(
        auth_login,
        auth_callback,
        oauth_protected_resource,
        oauth_protected_resource_app,
        oauth_authorization_server,
        oauth_register,
        oauth_authorize,
        oauth_token,
        me,
        logout,
        list_vaults,
        create_vault,
        create_invite,
        redeem_invite,
        list_members,
        promote_member,
        remove_member,
        list_cursors,
        create_cursor,
        rename_cursor,
        delete_cursor,
        regenerate_cursor_token,
        upsert_file,
        list_notes,
        create_note,
        search_notes,
        list_tags,
        list_backlinks,
        reindex,
        read_note,
        replace_note,
        patch_note,
        delete_note,
        move_note,
        note_permalink,
        parse_frontmatter,
        patch_frontmatter,
        periodic_note_get_or_create,
        periodic_note_append,
        list_attachments,
        upload_attachment_url,
        create_upload_link,
        read_attachment,
        head_attachment,
        upload_attachment,
        delete_attachment,
        move_attachment,
        public_upload,
        note_by_guid,
        note_by_path
    ),
    tags(
        (name = "auth", description = "Browser login and session management"),
        (name = "oauth", description = "OAuth 2.1 authorization server"),
        (name = "vaults", description = "Vault, invite, member, cursor, and file registry APIs"),
        (name = "notes", description = "Vault-scoped note APIs"),
        (name = "search", description = "Vault-scoped note search APIs"),
        (name = "attachments", description = "Vault-scoped attachment APIs and signed uploads"),
        (name = "permalinks", description = "Public note redirect endpoints")
    )
)]
pub struct ApiDoc;

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearerAuth",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).build()),
        );
    }
}

pub async fn openapi_json() -> Json<Value> {
    Json(serde_json::to_value(ApiDoc::openapi()).expect("serialize openapi"))
}

#[allow(dead_code)]
#[utoipa::path(
    get,
    path = "/auth/login",
    tag = "auth",
    params(
        ("redirect" = Option<String>, Query, description = "Allowed post-login redirect"),
        ("mock_sub" = Option<String>, Query, description = "Mock-mode subject")
    ),
    responses((status = 303, description = "Redirects to OIDC provider or callback"), (status = 400, description = "Invalid redirect"))
)]
async fn auth_login() {}

#[utoipa::path(get, path = "/auth/callback", tag = "auth", responses((status = 200, description = "Login token page"), (status = 303, description = "Redirect with token or OAuth code"), (status = 400, description = "Invalid state"), (status = 403, description = "OAuth owner check failed")))]
async fn auth_callback() {}

#[utoipa::path(get, path = "/.well-known/oauth-protected-resource", tag = "oauth", responses((status = 200, description = "RFC 9728 protected resource metadata")))]
async fn oauth_protected_resource() {}

#[utoipa::path(get, path = "/.well-known/oauth-protected-resource/mcp/i/{app_id}", tag = "oauth", params(("app_id" = String, Path, description = "Remote cursor app id")), responses((status = 200, description = "RFC 9728 protected resource metadata for an MCP resource")))]
async fn oauth_protected_resource_app() {}

#[utoipa::path(get, path = "/.well-known/oauth-authorization-server", tag = "oauth", responses((status = 200, description = "RFC 8414 authorization server metadata")))]
async fn oauth_authorization_server() {}

#[utoipa::path(post, path = "/oauth/register", tag = "oauth", request_body = Object, responses((status = 200, description = "Dynamic client registration response"), (status = 400, description = "Invalid registration")))]
async fn oauth_register() {}

#[utoipa::path(get, path = "/oauth/authorize", tag = "oauth", responses((status = 303, description = "Starts login and authorization-code flow"), (status = 400, description = "Invalid OAuth request")))]
async fn oauth_authorize() {}

#[utoipa::path(post, path = "/oauth/token", tag = "oauth", request_body(content = String, content_type = "application/x-www-form-urlencoded"), responses((status = 200, description = "Access and refresh token response"), (status = 400, description = "Invalid token request"), (status = 401, description = "Invalid grant or client")))]
async fn oauth_token() {}

#[utoipa::path(get, path = "/api/me", tag = "auth", security(("bearerAuth" = [])), responses((status = 200, description = "Current user"), (status = 401, description = "Unauthorized")))]
async fn me() {}

#[utoipa::path(post, path = "/api/logout", tag = "auth", security(("bearerAuth" = [])), responses((status = 200, description = "Session revoked"), (status = 401, description = "Unauthorized")))]
async fn logout() {}

#[utoipa::path(get, path = "/api/vaults", tag = "vaults", security(("bearerAuth" = [])), responses((status = 200, description = "Vault list")))]
async fn list_vaults() {}

#[utoipa::path(post, path = "/api/vaults", tag = "vaults", security(("bearerAuth" = [])), request_body = Object, responses((status = 200, description = "Created vault")))]
async fn create_vault() {}

#[utoipa::path(post, path = "/api/vaults/{id}/invites", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path, description = "Vault id")), request_body = Object, responses((status = 200, description = "Created invite"), (status = 403, description = "Admin required")))]
async fn create_invite() {}

#[utoipa::path(post, path = "/api/invites/redeem", tag = "vaults", security(("bearerAuth" = [])), request_body = Object, responses((status = 200, description = "Invite redeemed"), (status = 404, description = "Invite not found"), (status = 409, description = "Invite already used")))]
async fn redeem_invite() {}

#[utoipa::path(get, path = "/api/vaults/{id}/members", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path, description = "Vault id")), responses((status = 200, description = "Member list")))]
async fn list_members() {}

#[utoipa::path(post, path = "/api/vaults/{id}/members/{user_id}/promote", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path), ("user_id" = String, Path)), responses((status = 200, description = "Member promoted")))]
async fn promote_member() {}

#[utoipa::path(delete, path = "/api/vaults/{id}/members/{user_id}", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path), ("user_id" = String, Path)), responses((status = 200, description = "Member removed")))]
async fn remove_member() {}

#[utoipa::path(get, path = "/api/vaults/{id}/cursors", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path)), responses((status = 200, description = "Remote cursor list")))]
async fn list_cursors() {}

#[utoipa::path(post, path = "/api/vaults/{id}/cursors", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path)), request_body = Object, responses((status = 200, description = "Created remote cursor and secret token")))]
async fn create_cursor() {}

#[utoipa::path(post, path = "/api/vaults/{id}/cursors/{cursor_id}", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path), ("cursor_id" = String, Path)), request_body = Object, responses((status = 200, description = "Renamed remote cursor")))]
async fn rename_cursor() {}

#[utoipa::path(delete, path = "/api/vaults/{id}/cursors/{cursor_id}", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path), ("cursor_id" = String, Path)), responses((status = 200, description = "Deleted remote cursor")))]
async fn delete_cursor() {}

#[utoipa::path(post, path = "/api/vaults/{id}/cursors/{cursor_id}/token", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path), ("cursor_id" = String, Path)), responses((status = 200, description = "Regenerated cursor secret token")))]
async fn regenerate_cursor_token() {}

#[utoipa::path(post, path = "/api/vaults/{id}/files", tag = "vaults", security(("bearerAuth" = [])), params(("id" = String, Path)), request_body = Object, responses((status = 200, description = "File registry entry upserted")))]
async fn upsert_file() {}

#[utoipa::path(get, path = "/api/vaults/{id}/notes", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path)), responses((status = 200, description = "Note summaries")))]
async fn list_notes() {}

#[utoipa::path(post, path = "/api/vaults/{id}/notes", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path)), request_body = Object, responses((status = 200, description = "Created note"), (status = 409, description = "Note already exists")))]
async fn create_note() {}

#[utoipa::path(get, path = "/api/vaults/{id}/search", tag = "search", security(("bearerAuth" = [])), params(("id" = String, Path), ("q" = String, Query), ("limit" = Option<u32>, Query)), responses((status = 200, description = "Search hits")))]
async fn search_notes() {}

#[utoipa::path(get, path = "/api/vaults/{id}/tags", tag = "search", security(("bearerAuth" = [])), params(("id" = String, Path)), responses((status = 200, description = "Tag counts")))]
async fn list_tags() {}

#[utoipa::path(get, path = "/api/vaults/{id}/backlinks/{path}", tag = "search", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Backlinking notes")))]
async fn list_backlinks() {}

#[utoipa::path(post, path = "/api/vaults/{id}/reindex", tag = "search", security(("bearerAuth" = [])), params(("id" = String, Path)), responses((status = 200, description = "Reindexed vault")))]
async fn reindex() {}

#[utoipa::path(get, path = "/api/vaults/{id}/notes/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path, description = "Wildcard note path")), responses((status = 200, description = "Note content"), (status = 404, description = "Not found")))]
async fn read_note() {}

#[utoipa::path(put, path = "/api/vaults/{id}/notes/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body = Object, responses((status = 200, description = "Replaced note")))]
async fn replace_note() {}

#[utoipa::path(patch, path = "/api/vaults/{id}/notes/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body = Object, responses((status = 200, description = "Patched note"), (status = 409, description = "Ambiguous or no-op patch")))]
async fn patch_note() {}

#[utoipa::path(delete, path = "/api/vaults/{id}/notes/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Deleted note")))]
async fn delete_note() {}

#[utoipa::path(post, path = "/api/vaults/{id}/note-moves/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body = Object, responses((status = 200, description = "Moved note")))]
async fn move_note() {}

#[utoipa::path(post, path = "/api/vaults/{id}/note-permalinks/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Generated permalink")))]
async fn note_permalink() {}

#[utoipa::path(get, path = "/api/vaults/{id}/note-frontmatter/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Parsed frontmatter")))]
async fn parse_frontmatter() {}

#[utoipa::path(patch, path = "/api/vaults/{id}/note-frontmatter/{path}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body = Object, responses((status = 200, description = "Patched frontmatter")))]
async fn patch_frontmatter() {}

#[utoipa::path(post, path = "/api/vaults/{id}/periodic/{period}", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("period" = String, Path)), request_body = Object, responses((status = 200, description = "Got or created periodic note")))]
async fn periodic_note_get_or_create() {}

#[utoipa::path(post, path = "/api/vaults/{id}/periodic/{period}/append", tag = "notes", security(("bearerAuth" = [])), params(("id" = String, Path), ("period" = String, Path)), request_body = Object, responses((status = 200, description = "Appended to periodic note")))]
async fn periodic_note_append() {}

#[utoipa::path(get, path = "/api/vaults/{id}/attachments", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path)), responses((status = 200, description = "Attachment summaries")))]
async fn list_attachments() {}

#[utoipa::path(post, path = "/api/vaults/{id}/attachments/from-url", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path)), request_body = Object, responses((status = 200, description = "Uploaded attachment from URL"), (status = 403, description = "Host forbidden")))]
async fn upload_attachment_url() {}

#[utoipa::path(post, path = "/api/vaults/{id}/attachments/upload-link", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path)), request_body = Object, responses((status = 200, description = "Signed single-use upload link")))]
async fn create_upload_link() {}

#[utoipa::path(get, path = "/api/vaults/{id}/attachments/{path}", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Attachment bytes"), (status = 404, description = "Not found")))]
async fn read_attachment() {}

#[utoipa::path(head, path = "/api/vaults/{id}/attachments/{path}", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Attachment exists"), (status = 404, description = "Not found")))]
async fn head_attachment() {}

#[utoipa::path(put, path = "/api/vaults/{id}/attachments/{path}", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body(content = Vec<u8>, content_type = "application/octet-stream"), responses((status = 200, description = "Uploaded attachment"), (status = 413, description = "Too large")))]
async fn upload_attachment() {}

#[utoipa::path(delete, path = "/api/vaults/{id}/attachments/{path}", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), responses((status = 200, description = "Deleted attachment")))]
async fn delete_attachment() {}

#[utoipa::path(post, path = "/api/vaults/{id}/attachment-moves/{path}", tag = "attachments", security(("bearerAuth" = [])), params(("id" = String, Path), ("path" = String, Path)), request_body = Object, responses((status = 200, description = "Moved attachment")))]
async fn move_attachment() {}

#[utoipa::path(post, path = "/upload", tag = "attachments", request_body(content = String, content_type = "multipart/form-data"), responses((status = 200, description = "Uploaded via signed link"), (status = 401, description = "Invalid or expired upload token"), (status = 409, description = "Upload token already used"), (status = 413, description = "Too large")))]
async fn public_upload() {}

#[utoipa::path(get, path = "/n/{guid}", tag = "permalinks", params(("guid" = String, Path)), responses((status = 303, description = "Redirects to note deep link or path redirect"), (status = 404, description = "Not found")))]
async fn note_by_guid() {}

#[utoipa::path(get, path = "/p", tag = "permalinks", params(("vault" = Option<String>, Query), ("path" = Option<String>, Query)), responses((status = 303, description = "Redirects to note deep link"), (status = 400, description = "Missing query")))]
async fn note_by_path() {}
