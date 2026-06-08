use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{header, request::Parts, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::{middleware, Router};
use base64::Engine;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content, Implementation, ServerCapabilities, ServerInfo};
use rmcp::service::RequestContext;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use rmcp::{tool, tool_handler, tool_router, ErrorData, RoleServer, ServerHandler};
use schemars::JsonSchema;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::json;

use crate::attachments::{self, CreateUploadLinkBody, MoveAttachmentBody, UploadFromUrlBody};
use crate::entities::{oauth_tokens, remote_cursors, users};
use crate::error::AppError;
use crate::notes::{
    self, CreateNoteBody, MoveNoteBody, PatchFrontmatterBody, PatchNoteBody, PeriodicAppendBody,
    PeriodicBody, ReplaceNoteBody,
};
use crate::search;
use crate::session::{bearer_token, hash_token, now_millis, ApiActor, ApiPrincipal};
use crate::state::AppState;
use crate::{SERVER_NAME, SERVER_SLUG};

#[derive(Clone)]
pub(crate) struct ToolCtx {
    pub state: AppState,
    pub vault_id: String,
    pub principal: ApiPrincipal,
}

#[derive(Clone)]
pub struct InstaMcp;

pub fn router(state: AppState) -> Router<AppState> {
    let svc = StreamableHttpService::new(
        || Ok(InstaMcp),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .disable_allowed_hosts()
            .with_stateful_mode(false)
            .with_json_response(true),
    );
    Router::new()
        .route_service("/mcp/i/{app_id}", svc)
        .route_layer(middleware::from_fn_with_state(state, front_auth))
}

async fn front_auth(
    State(state): State<AppState>,
    Path(app_id): Path<String>,
    mut req: Request<Body>,
    next: Next,
) -> Result<Response, Response> {
    match authenticate_mcp(
        &state,
        &app_id,
        req.headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
    )
    .await
    {
        Ok((vault_id, principal)) => {
            req.extensions_mut().insert(ToolCtx {
                state,
                vault_id,
                principal,
            });
            Ok(next.run(req).await)
        }
        Err(_) => Err(unauthorized(&state, &app_id)),
    }
}

fn unauthorized(state: &AppState, app_id: &str) -> Response {
    let metadata = format!(
        "{}/.well-known/oauth-protected-resource/mcp/i/{app_id}",
        state.config.public_base_url.trim_end_matches('/')
    );
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header(
            header::WWW_AUTHENTICATE,
            format!("Bearer resource_metadata=\"{metadata}\""),
        )
        .body(Body::empty())
        .unwrap()
}

async fn authenticate_mcp(
    state: &AppState,
    app_id: &str,
    auth: Option<&str>,
) -> Result<(String, ApiPrincipal), AppError> {
    let token = auth.and_then(bearer_token).ok_or(AppError::Unauthorized)?;
    let token_hash = hash_token(token);
    let cursor = remote_cursors::Entity::find()
        .filter(remote_cursors::Column::AppId.eq(app_id))
        .one(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if cursor.token_hash == token_hash {
        let user = users::Entity::find_by_id(cursor.created_by.clone())
            .one(&state.db)
            .await?
            .ok_or(AppError::Unauthorized)?;
        return Ok((
            cursor.vault_id.clone(),
            ApiPrincipal {
                user,
                actor: ApiActor::Cursor(cursor),
            },
        ));
    }
    let oauth = oauth_tokens::Entity::find_by_id(token_hash)
        .one(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
    if oauth.access_expires_at < now_millis()
        || oauth.app_id != app_id
        || oauth.vault_id != cursor.vault_id
    {
        return Err(AppError::Unauthorized);
    }
    let user = users::Entity::find_by_id(cursor.created_by.clone())
        .one(&state.db)
        .await?
        .ok_or(AppError::Unauthorized)?;
    Ok((
        cursor.vault_id.clone(),
        ApiPrincipal {
            user,
            actor: ApiActor::Cursor(cursor),
        },
    ))
}

fn ctx(context: &RequestContext<RoleServer>) -> Result<ToolCtx, ErrorData> {
    context
        .extensions
        .get::<Parts>()
        .and_then(|parts| parts.extensions.get::<ToolCtx>())
        .cloned()
        .ok_or_else(|| ErrorData::internal_error("missing tool context", None))
}

fn ok<T: serde::Serialize>(value: T) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::structured(
        json!({ "ok": true, "data": value }),
    ))
}

fn tool_result(
    result: crate::error::AppResult<impl serde::Serialize>,
) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(value) => ok(value),
        Err(err) => Ok(CallToolResult::structured_error(
            json!({ "ok": false, "reason": err.to_string() }),
        )),
    }
}

fn tool_unit(result: crate::error::AppResult<()>) -> Result<CallToolResult, ErrorData> {
    match result {
        Ok(()) => ok(json!({ "deleted": true })),
        Err(err) => Ok(CallToolResult::structured_error(
            json!({ "ok": false, "reason": err.to_string() }),
        )),
    }
}

#[derive(Deserialize, JsonSchema)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize, JsonSchema)]
struct CreateArgs {
    path: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize, JsonSchema)]
struct ContentArgs {
    path: String,
    content: String,
}

#[derive(Deserialize, JsonSchema)]
struct BodyArgs {
    path: String,
    body: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    path: String,
    to_path: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PatchArgs {
    path: String,
    old: String,
    new: String,
    #[serde(default)]
    replace_all: bool,
}

#[derive(Deserialize, JsonSchema)]
struct FrontmatterArgs {
    path: String,
    #[serde(default)]
    set: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    unset: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
struct PeriodicArgs {
    period: String,
    date: Option<String>,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize, JsonSchema)]
struct PeriodicAppendArgs {
    period: String,
    date: Option<String>,
    text: String,
}

#[derive(Deserialize, JsonSchema)]
struct AttachmentUploadArgs {
    path: String,
    base64: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentMoveArgs {
    path: String,
    to_path: String,
    #[serde(default)]
    update_embeds: bool,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentFromUrlArgs {
    source_url: String,
    path: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct CreateUploadLinkArgs {
    landing_dir: Option<String>,
    expires_in_seconds: Option<i64>,
}

#[derive(Deserialize, JsonSchema)]
struct SearchArgs {
    query: String,
    limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
struct BacklinksArgs {
    path: String,
}

#[tool_router]
impl InstaMcp {
    #[tool(description = "List notes in the cursor vault")]
    async fn list_notes(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(notes::list_notes_inner(&c.state, &c.principal, &c.vault_id).await)
    }

    #[tool(description = "Read a note by path")]
    async fn read_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(notes::read_note_inner(&c.state, &c.principal, &c.vault_id, &args.path).await)
    }

    #[tool(description = "Create a note")]
    async fn create_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<CreateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::create_note_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                CreateNoteBody {
                    path: args.path,
                    content: args.content,
                },
            )
            .await,
        )
    }

    #[tool(description = "Replace a full note including frontmatter")]
    async fn replace_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<ContentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::replace_note_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                ReplaceNoteBody {
                    content: args.content,
                },
            )
            .await,
        )
    }

    #[tool(description = "Replace only the body of a note, preserving existing frontmatter")]
    async fn replace_body(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<BodyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::replace_body_inner(&c.state, &c.principal, &c.vault_id, &args.path, args.body)
                .await,
        )
    }

    #[tool(description = "Patch note text")]
    async fn patch_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PatchArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::patch_note_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                PatchNoteBody {
                    old: args.old,
                    new: args.new,
                    replace_all: args.replace_all,
                },
            )
            .await,
        )
    }

    #[tool(description = "Move or rename a note")]
    async fn move_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<MoveArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::move_note_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                MoveNoteBody {
                    to_path: args.to_path,
                },
            )
            .await,
        )
    }

    #[tool(description = "Delete a note")]
    async fn delete_note(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_unit(notes::delete_note_inner(&c.state, &c.principal, &c.vault_id, &args.path).await)
    }

    #[tool(description = "Parse note frontmatter")]
    async fn parse_frontmatter(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::parse_frontmatter_inner(&c.state, &c.principal, &c.vault_id, &args.path).await,
        )
    }

    #[tool(description = "Patch note frontmatter keys")]
    async fn patch_frontmatter(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<FrontmatterArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::patch_frontmatter_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                PatchFrontmatterBody {
                    set: args.set,
                    unset: args.unset,
                },
            )
            .await,
        )
    }

    #[tool(
        description = "Generate a stable permalink for a note. Returns a URL of the form <public-base>/n/<guid>. Opening it in a browser issues an HTTP redirect to an obsidian://realtime-open deeplink, which opens the note in the user's Obsidian vault via the Realtime plugin. The permalink tracks the note by stable guid, so it keeps working after the note is renamed or moved. Share this URL as-is; do not rewrite it into an obsidian:// link yourself."
    )]
    async fn generate_permalink(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::note_permalink_inner(&c.state, &c.principal, &c.vault_id, &args.path).await,
        )
    }

    #[tool(description = "Get or create a periodic note")]
    async fn periodic_note_get_or_create(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PeriodicArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::periodic_note_get_or_create_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.period,
                PeriodicBody {
                    date: args.date,
                    content: args.content,
                },
            )
            .await,
        )
    }

    #[tool(description = "Append text to a periodic note")]
    async fn periodic_note_append(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PeriodicAppendArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            notes::periodic_note_append_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.period,
                PeriodicAppendBody {
                    date: args.date,
                    text: args.text,
                },
            )
            .await,
        )
    }

    #[tool(description = "List attachments in the cursor vault")]
    async fn list_attachments(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(attachments::list_attachments_inner(&c.state, &c.principal, &c.vault_id).await)
    }

    #[tool(description = "Check whether an attachment exists")]
    async fn head_attachment(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            attachments::head_attachment_inner(&c.state, &c.principal, &c.vault_id, &args.path)
                .await,
        )
    }

    #[tool(
        description = "Read an attachment; images are returned as image content, other files as base64"
    )]
    async fn read_attachment(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        match attachments::read_attachment_inner(&c.state, &c.principal, &c.vault_id, &args.path)
            .await
        {
            Ok(data) if data.content_type.starts_with("image/") => {
                Ok(CallToolResult::success(vec![Content::image(
                    base64::engine::general_purpose::STANDARD.encode(&data.bytes),
                    data.content_type,
                )]))
            }
            Ok(data) => ok(json!({
                "path": data.meta.path,
                "hash": data.meta.hash,
                "size": data.meta.size,
                "contentType": data.content_type,
                "base64": base64::engine::general_purpose::STANDARD.encode(&data.bytes),
            })),
            Err(err) => Ok(CallToolResult::structured_error(
                json!({ "ok": false, "reason": err.to_string() }),
            )),
        }
    }

    #[tool(description = "Upload an attachment from base64 content")]
    async fn upload_attachment(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<AttachmentUploadArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        let bytes = match base64::engine::general_purpose::STANDARD.decode(args.base64.as_bytes()) {
            Ok(bytes) => bytes,
            Err(_) => {
                return Ok(CallToolResult::structured_error(
                    json!({ "ok": false, "reason": "invalid_base64" }),
                ))
            }
        };
        tool_result(
            attachments::upload_attachment_bytes_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                &bytes,
            )
            .await,
        )
    }

    #[tool(description = "Delete an attachment")]
    async fn delete_attachment(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<PathArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_unit(
            attachments::delete_attachment_inner(&c.state, &c.principal, &c.vault_id, &args.path)
                .await,
        )
    }

    #[tool(description = "Move or rename an attachment")]
    async fn move_attachment(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<AttachmentMoveArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            attachments::move_attachment_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.path,
                MoveAttachmentBody {
                    to_path: args.to_path,
                    update_embeds: args.update_embeds,
                },
            )
            .await,
        )
    }

    #[tool(description = "Fetch an attachment from an allowlisted URL")]
    async fn upload_attachment_url(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<AttachmentFromUrlArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            attachments::upload_attachment_url_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                UploadFromUrlBody {
                    source_url: args.source_url,
                    path: args.path,
                },
            )
            .await,
        )
    }

    #[tool(description = "Create a signed single-use browser upload link")]
    async fn create_upload_link(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<CreateUploadLinkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            attachments::create_upload_link_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                CreateUploadLinkBody {
                    landing_dir: args.landing_dir,
                    expires_in_seconds: args.expires_in_seconds,
                },
            )
            .await,
        )
    }

    #[tool(description = "Search notes")]
    async fn search_notes(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            search::search_notes_inner(
                &c.state,
                &c.principal,
                &c.vault_id,
                &args.query,
                args.limit,
            )
            .await,
        )
    }

    #[tool(description = "List tags")]
    async fn list_tags(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(search::list_tags_inner(&c.state, &c.principal, &c.vault_id).await)
    }

    #[tool(description = "List backlinks")]
    async fn list_backlinks(
        &self,
        context: RequestContext<RoleServer>,
        Parameters(args): Parameters<BacklinksArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(
            search::list_backlinks_inner(&c.state, &c.principal, &c.vault_id, &args.path).await,
        )
    }

    #[tool(description = "Backfill note ids")]
    async fn backfill_ids(
        &self,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let c = ctx(&context)?;
        tool_result(search::reindex_inner(&c.state, &c.principal, &c.vault_id).await)
    }
}

#[tool_handler]
impl ServerHandler for InstaMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(SERVER_SLUG, env!("CARGO_PKG_VERSION")))
            .with_instructions(format!("{SERVER_NAME} vault tools"))
    }
}
