use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use std::collections::HashSet;

use crate::audit::{self, AuditEntry};
use crate::error::{AppError, AppResult};
use crate::routes::{authorize_path, require_member};
use crate::session::{now_millis, ApiPrincipal};
use crate::state::AppState;
use crate::ydoc::{self, StructuredIndexEntry};
use crate::ysweet::{ensure_doc, Level};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredSummary {
    pub path: String,
    pub guid: String,
    pub kind: String,
    pub permalink: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredResponse {
    pub path: String,
    pub guid: String,
    pub kind: String,
    pub value: JsonValue,
    pub permalink: String,
}

#[derive(Deserialize)]
pub struct CreateStructuredBody {
    pub path: String,
    #[serde(default)]
    pub value: JsonValue,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveStructuredBody {
    pub to_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNodeBody {
    pub id: Option<String>,
    #[serde(flatten)]
    pub fields: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasNodePatchBody {
    pub id: String,
    #[serde(flatten)]
    pub patch: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
pub struct IdBody {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdgeBody {
    pub id: Option<String>,
    pub from_node: String,
    pub to_node: String,
    #[serde(flatten)]
    pub fields: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdgePatchBody {
    pub id: String,
    #[serde(flatten)]
    pub patch: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
pub struct BaseViewBody {
    pub name: String,
    #[serde(rename = "type")]
    pub view_type: String,
    #[serde(flatten)]
    pub fields: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
pub struct BaseViewPatchBody {
    pub name: String,
    #[serde(flatten)]
    pub patch: JsonMap<String, JsonValue>,
}

#[derive(Deserialize)]
pub struct NameBody {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SetValueBody {
    pub name: Option<String>,
    pub value: JsonValue,
}

pub fn canvas_to_file_json(value: JsonValue) -> JsonValue {
    let Some(root) = value.as_object() else {
        return json!({ "nodes": [], "edges": [] });
    };
    let nodes = root.get("nodes").and_then(JsonValue::as_object);
    let edges = root.get("edges").and_then(JsonValue::as_object);
    let node_order = root.get("nodeOrder").and_then(JsonValue::as_array);
    let edge_order = root.get("edgeOrder").and_then(JsonValue::as_array);
    json!({
        "nodes": ordered_canvas_items(nodes, node_order),
        "edges": ordered_canvas_items(edges, edge_order),
    })
}

pub fn ordered_canvas_items(
    items: Option<&JsonMap<String, JsonValue>>,
    order: Option<&Vec<JsonValue>>,
) -> Vec<JsonValue> {
    let Some(items) = items else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    if let Some(order) = order {
        for id in order.iter().filter_map(JsonValue::as_str) {
            if let Some(item) = items.get(id) {
                out.push(item.clone());
                seen.insert(id.to_string());
            }
        }
    }
    for (id, item) in items {
        if !seen.contains(id) {
            out.push(item.clone());
        }
    }
    out
}

pub async fn list_canvases(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
) -> AppResult<Json<Vec<StructuredSummary>>> {
    Ok(Json(
        list_structured_inner(&state, &principal, &vault_id, Some("canvas")).await?,
    ))
}

pub async fn list_bases(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
) -> AppResult<Json<Vec<StructuredSummary>>> {
    Ok(Json(
        list_structured_inner(&state, &principal, &vault_id, Some("base")).await?,
    ))
}

pub(crate) async fn list_structured_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    kind_filter: Option<&str>,
) -> AppResult<Vec<StructuredSummary>> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    let update = ydoc::read_update(state, vault_id).await?;
    let mut entries =
        ydoc::decode_structured_index(&update).map_err(|e| AppError::Internal(e.to_string()))?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries
        .into_iter()
        .filter(|e| kind_filter.is_none_or(|k| e.kind == k))
        .map(|e| StructuredSummary {
            permalink: permalink_for_guid(state, &e.guid),
            path: e.path,
            guid: e.guid,
            kind: e.kind,
        })
        .collect())
}

pub async fn read_canvas(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        read_canvas_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub(crate) async fn read_canvas_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<StructuredResponse> {
    let mut response = read_structured_json(state, principal, vault_id, path, "canvas").await?;
    response.value = canvas_to_file_json(response.value);
    Ok(response)
}

pub async fn create_canvas(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
    Json(body): Json<CreateStructuredBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        create_canvas_inner(&state, &principal, &vault_id, body).await?,
    ))
}

pub(crate) async fn create_canvas_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    body: CreateStructuredBody,
) -> AppResult<StructuredResponse> {
    create_structured(
        state,
        principal,
        vault_id,
        &body.path,
        "canvas",
        canvas_file_to_map(body.value),
    )
    .await
}

pub async fn replace_canvas(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<JsonValue>,
) -> AppResult<Json<StructuredResponse>> {
    let value = canvas_file_to_map(body);
    Ok(Json(
        write_structured_json(&state, &principal, &vault_id, &path, "canvas", value).await?,
    ))
}

pub async fn delete_canvas(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<JsonValue>> {
    delete_structured_inner(&state, &principal, &vault_id, &path, "canvas").await?;
    Ok(Json(json!({ "deleted": true })))
}

pub(crate) async fn delete_canvas_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<()> {
    delete_structured_inner(state, principal, vault_id, path, "canvas").await
}

pub async fn move_canvas(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<MoveStructuredBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        move_structured_inner(&state, &principal, &vault_id, &path, body, "canvas").await?,
    ))
}

pub async fn add_canvas_node(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<CanvasNodeBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            add_node(root, body)
        })
        .await?,
    ))
}

pub(crate) async fn add_canvas_node_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: CanvasNodeBody,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        add_node(root, body)
    })
    .await
}

pub(crate) async fn update_canvas_node_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: CanvasNodePatchBody,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        patch_item(root, "nodes", &body.id, body.patch)
    })
    .await
}

pub(crate) async fn delete_canvas_node_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    id: &str,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        delete_node(root, id)
    })
    .await
}

pub async fn update_canvas_node(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<CanvasNodePatchBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            patch_item(root, "nodes", &body.id, body.patch)
        })
        .await?,
    ))
}

pub async fn delete_canvas_node(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<IdBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            delete_node(root, &body.id)
        })
        .await?,
    ))
}

pub async fn add_canvas_edge(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<CanvasEdgeBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            add_edge(root, body)
        })
        .await?,
    ))
}

pub(crate) async fn add_canvas_edge_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: CanvasEdgeBody,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        add_edge(root, body)
    })
    .await
}

pub(crate) async fn update_canvas_edge_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: CanvasEdgePatchBody,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        patch_item(root, "edges", &body.id, body.patch)
    })
    .await
}

pub(crate) async fn delete_canvas_edge_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    id: &str,
) -> AppResult<StructuredResponse> {
    update_canvas_doc(state, principal, vault_id, path, |root| {
        delete_item(root, "edges", "edgeOrder", id)
    })
    .await
}

pub async fn update_canvas_edge(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<CanvasEdgePatchBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            patch_item(root, "edges", &body.id, body.patch)
        })
        .await?,
    ))
}

pub async fn delete_canvas_edge(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<IdBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_canvas_doc(&state, &principal, &vault_id, &path, |root| {
            delete_item(root, "edges", "edgeOrder", &body.id)
        })
        .await?,
    ))
}

pub async fn read_base(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        read_base_inner(&state, &principal, &vault_id, &path).await?,
    ))
}

pub(crate) async fn read_base_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<StructuredResponse> {
    read_structured_json(state, principal, vault_id, path, "base").await
}

pub async fn create_base(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path(vault_id): Path<String>,
    Json(body): Json<CreateStructuredBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        create_base_inner(&state, &principal, &vault_id, body).await?,
    ))
}

pub(crate) async fn create_base_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    body: CreateStructuredBody,
) -> AppResult<StructuredResponse> {
    create_structured(state, principal, vault_id, &body.path, "base", body.value).await
}

pub async fn replace_base(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<JsonValue>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        write_structured_json(&state, &principal, &vault_id, &path, "base", body).await?,
    ))
}

pub async fn delete_base(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<JsonValue>> {
    delete_structured_inner(&state, &principal, &vault_id, &path, "base").await?;
    Ok(Json(json!({ "deleted": true })))
}

pub(crate) async fn delete_base_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<()> {
    delete_structured_inner(state, principal, vault_id, path, "base").await
}

pub async fn move_base(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<MoveStructuredBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        move_structured_inner(&state, &principal, &vault_id, &path, body, "base").await?,
    ))
}

pub async fn list_base_views(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
) -> AppResult<Json<JsonValue>> {
    let value = read_structured_json(&state, &principal, &vault_id, &path, "base")
        .await?
        .value;
    Ok(Json(base_views_value(value)))
}

pub(crate) async fn list_base_views_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
) -> AppResult<JsonValue> {
    Ok(base_views_value(
        read_structured_json(state, principal, vault_id, path, "base")
            .await?
            .value,
    ))
}

pub async fn add_base_view(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<BaseViewBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        add_base_view_inner(&state, &principal, &vault_id, &path, body).await?,
    ))
}

pub(crate) async fn add_base_view_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: BaseViewBody,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        upsert_view(root, body)
    })
    .await
}

pub(crate) async fn update_base_view_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: BaseViewPatchBody,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        patch_view(root, body)
    })
    .await
}

pub(crate) async fn delete_base_view_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        delete_view(root, name)
    })
    .await
}

pub(crate) async fn set_base_filters_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        root.insert("filters".into(), value);
        Ok(())
    })
    .await
}

pub(crate) async fn set_base_view_filters_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        set_view_field(root, name, "filters", value)
    })
    .await
}

pub(crate) async fn set_base_formula_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        set_named(root, "formulas", name, value)
    })
    .await
}

pub(crate) async fn delete_base_formula_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        delete_named(root, "formulas", name)
    })
    .await
}

pub(crate) async fn set_base_property_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        set_named(root, "properties", name, value)
    })
    .await
}

pub(crate) async fn delete_base_property_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    name: &str,
) -> AppResult<StructuredResponse> {
    update_base_doc(state, principal, vault_id, path, |root| {
        delete_named(root, "properties", name)
    })
    .await
}

pub async fn update_base_view(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<BaseViewPatchBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            patch_view(root, body)
        })
        .await?,
    ))
}

pub async fn delete_base_view(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            delete_view(root, &body.name)
        })
        .await?,
    ))
}

pub async fn set_base_filters(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<SetValueBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            root.insert("filters".into(), body.value);
            Ok(())
        })
        .await?,
    ))
}

pub async fn set_base_view_filters(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<SetValueBody>,
) -> AppResult<Json<StructuredResponse>> {
    let name = body
        .name
        .ok_or_else(|| AppError::BadRequest("name is required".into()))?;
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            set_view_field(root, &name, "filters", body.value)
        })
        .await?,
    ))
}

pub async fn set_base_formula(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<SetValueBody>,
) -> AppResult<Json<StructuredResponse>> {
    let name = body
        .name
        .ok_or_else(|| AppError::BadRequest("name is required".into()))?;
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            set_named(root, "formulas", &name, body.value)
        })
        .await?,
    ))
}

pub async fn delete_base_formula(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            delete_named(root, "formulas", &body.name)
        })
        .await?,
    ))
}

pub async fn set_base_property(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<SetValueBody>,
) -> AppResult<Json<StructuredResponse>> {
    let name = body
        .name
        .ok_or_else(|| AppError::BadRequest("name is required".into()))?;
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            set_named(root, "properties", &name, body.value)
        })
        .await?,
    ))
}

pub async fn delete_base_property(
    State(state): State<AppState>,
    principal: ApiPrincipal,
    Path((vault_id, path)): Path<(String, String)>,
    Json(body): Json<NameBody>,
) -> AppResult<Json<StructuredResponse>> {
    Ok(Json(
        update_base_doc(&state, &principal, &vault_id, &path, |root| {
            delete_named(root, "properties", &body.name)
        })
        .await?,
    ))
}

async fn update_canvas_doc<F>(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    edit: F,
) -> AppResult<StructuredResponse>
where
    F: FnOnce(&mut JsonMap<String, JsonValue>) -> AppResult<()>,
{
    let mut response = read_structured_json(state, principal, vault_id, path, "canvas").await?;
    let root = response
        .value
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("structured root is not object".into()))?;
    edit(root)?;
    response = write_structured_json(
        state,
        principal,
        vault_id,
        path,
        "canvas",
        JsonValue::Object(root.clone()),
    )
    .await?;
    response.value = canvas_to_file_json(response.value);
    Ok(response)
}

async fn update_base_doc<F>(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    edit: F,
) -> AppResult<StructuredResponse>
where
    F: FnOnce(&mut JsonMap<String, JsonValue>) -> AppResult<()>,
{
    let mut response = read_structured_json(state, principal, vault_id, path, "base").await?;
    let root = response
        .value
        .as_object_mut()
        .ok_or_else(|| AppError::Internal("structured root is not object".into()))?;
    edit(root)?;
    write_structured_json(
        state,
        principal,
        vault_id,
        path,
        "base",
        JsonValue::Object(root.clone()),
    )
    .await
}

pub(crate) async fn read_structured_json(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    kind: &str,
) -> AppResult<StructuredResponse> {
    let entry = require_structured_access(state, principal, vault_id, path, kind, false).await?;
    let update = ydoc::read_update(state, &doc_id(vault_id, &entry.guid)).await?;
    let value = ydoc::decode_structured(&update).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(StructuredResponse {
        permalink: permalink_for_guid(state, &entry.guid),
        path: entry.path,
        guid: entry.guid,
        kind: entry.kind,
        value,
    })
}

pub(crate) async fn write_structured_json(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    kind: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    let entry = require_structured_access(state, principal, vault_id, path, kind, true).await?;
    // The before-image is only needed for the cursor audit trail; spare human
    // callers the extra y-sweet read.
    let before = if audit::is_cursor(principal) {
        let update = ydoc::read_update(state, &doc_id(vault_id, &entry.guid)).await?;
        Some(ydoc::decode_structured(&update).map_err(|e| AppError::Internal(e.to_string()))?)
    } else {
        None
    };
    ydoc::set_structured(state, &doc_id(vault_id, &entry.guid), &value).await?;
    mark_structured_write(state, vault_id, principal).await;
    if let Some(before) = before {
        audit::record(
            state,
            principal,
            vault_id,
            AuditEntry::new("structured_set", path)
                .before(pretty_json(&before))
                .after(pretty_json(&value))
                .details(json!({ "kind": kind })),
        )
        .await;
    }
    Ok(StructuredResponse {
        permalink: permalink_for_guid(state, &entry.guid),
        path: entry.path,
        guid: entry.guid,
        kind: entry.kind,
        value,
    })
}

pub(crate) async fn create_structured(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    kind: &str,
    value: JsonValue,
) -> AppResult<StructuredResponse> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    validate_structured_path(path, kind)?;
    if structured_entry_by_path(state, vault_id, path)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict("structured file already exists".into()));
    }
    let level = authorize_path(state, &principal.user, vault_id, path).await?;
    if level == Level::ReadOnly {
        return Err(AppError::Forbidden);
    }
    let guid = uuid::Uuid::new_v4().to_string();
    ensure_doc(state, &doc_id(vault_id, &guid)).await?;
    ydoc::set_structured(state, &doc_id(vault_id, &guid), &value).await?;
    ydoc::index_set_structured(state, vault_id, path, &guid, kind).await?;
    mark_structured_write(state, vault_id, principal).await;
    audit::record(
        state,
        principal,
        vault_id,
        AuditEntry::new("structured_create", path)
            .after(pretty_json(&value))
            .details(json!({ "kind": kind })),
    )
    .await;
    Ok(StructuredResponse {
        permalink: permalink_for_guid(state, &guid),
        path: path.into(),
        guid,
        kind: kind.into(),
        value,
    })
}

pub(crate) async fn move_structured_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    body: MoveStructuredBody,
    kind: &str,
) -> AppResult<StructuredResponse> {
    validate_structured_path(&body.to_path, kind)?;
    let entry = require_structured_access(state, principal, vault_id, path, kind, true).await?;
    if structured_entry_by_path(state, vault_id, &body.to_path)
        .await?
        .is_some()
    {
        return Err(AppError::Conflict("exists".into()));
    }
    let level = authorize_path(state, &principal.user, vault_id, &body.to_path).await?;
    if level == Level::ReadOnly {
        return Err(AppError::Forbidden);
    }
    ydoc::index_rename_structured(state, vault_id, &entry.path, &body.to_path).await?;
    mark_structured_write(state, vault_id, principal).await;
    audit::record(
        state,
        principal,
        vault_id,
        AuditEntry::new("structured_move", &entry.path)
            .to_path(&body.to_path)
            .details(json!({ "kind": kind })),
    )
    .await;
    let mut out = read_structured_json(state, principal, vault_id, &body.to_path, kind).await?;
    if kind == "canvas" {
        out.value = canvas_to_file_json(out.value);
    }
    Ok(out)
}

pub(crate) async fn delete_structured_inner(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    kind: &str,
) -> AppResult<()> {
    let entry = require_structured_access(state, principal, vault_id, path, kind, true).await?;
    // Capture the document for the cursor audit trail so the delete can be
    // undone; human deletes skip the extra read.
    let before = if audit::is_cursor(principal) {
        let update = ydoc::read_update(state, &doc_id(vault_id, &entry.guid)).await?;
        Some(ydoc::decode_structured(&update).map_err(|e| AppError::Internal(e.to_string()))?)
    } else {
        None
    };
    ydoc::index_remove_structured(state, vault_id, &entry.path).await?;
    mark_structured_write(state, vault_id, principal).await;
    if let Some(before) = before {
        audit::record(
            state,
            principal,
            vault_id,
            AuditEntry::new("structured_delete", &entry.path)
                .before(pretty_json(&before))
                .details(json!({ "kind": kind })),
        )
        .await;
    }
    Ok(())
}

fn pretty_json(value: &JsonValue) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

async fn require_structured_access(
    state: &AppState,
    principal: &ApiPrincipal,
    vault_id: &str,
    path: &str,
    expect_kind: &str,
    write: bool,
) -> AppResult<StructuredIndexEntry> {
    principal.require_vault(vault_id)?;
    require_member(state, &principal.user.id, vault_id).await?;
    validate_structured_path(path, expect_kind)?;
    let entry = structured_entry_by_path(state, vault_id, path)
        .await?
        .ok_or(AppError::NotFound)?;
    if entry.kind != expect_kind {
        return Err(AppError::BadRequest("wrong structured kind".into()));
    }
    let level = authorize_path(state, &principal.user, vault_id, path).await?;
    if write && level == Level::ReadOnly {
        return Err(AppError::Forbidden);
    }
    Ok(entry)
}

async fn structured_entry_by_path(
    state: &AppState,
    vault_id: &str,
    path: &str,
) -> AppResult<Option<StructuredIndexEntry>> {
    let update = ydoc::read_update(state, vault_id).await?;
    Ok(ydoc::decode_structured_index(&update)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .find(|e| e.path == path))
}

fn canvas_file_to_map(value: JsonValue) -> JsonValue {
    let mut root = JsonMap::new();
    let nodes = value
        .get("nodes")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let edges = value
        .get("edges")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let mut node_map = JsonMap::new();
    let mut edge_map = JsonMap::new();
    let mut node_order = Vec::new();
    let mut edge_order = Vec::new();
    for item in nodes {
        if let Some(id) = item.get("id").and_then(JsonValue::as_str) {
            node_order.push(json!(id));
            node_map.insert(id.into(), item);
        }
    }
    for item in edges {
        if let Some(id) = item.get("id").and_then(JsonValue::as_str) {
            edge_order.push(json!(id));
            edge_map.insert(id.into(), item);
        }
    }
    root.insert("nodes".into(), JsonValue::Object(node_map));
    root.insert("edges".into(), JsonValue::Object(edge_map));
    root.insert("nodeOrder".into(), JsonValue::Array(node_order));
    root.insert("edgeOrder".into(), JsonValue::Array(edge_order));
    JsonValue::Object(root)
}

fn add_node(root: &mut JsonMap<String, JsonValue>, body: CanvasNodeBody) -> AppResult<()> {
    let id = body.id.unwrap_or_else(gen_canvas_id);
    let nodes = ensure_object(root, "nodes");
    if nodes.contains_key(&id) {
        return Err(AppError::Conflict("node exists".into()));
    }
    let mut node = body.fields;
    node.insert("id".into(), json!(id.clone()));
    nodes.insert(id.clone(), JsonValue::Object(node));
    ensure_order(root, "nodeOrder", &id);
    Ok(())
}

fn add_edge(root: &mut JsonMap<String, JsonValue>, body: CanvasEdgeBody) -> AppResult<()> {
    let id = body.id.unwrap_or_else(gen_canvas_id);
    let edges = ensure_object(root, "edges");
    if edges.contains_key(&id) {
        return Err(AppError::Conflict("edge exists".into()));
    }
    let mut edge = body.fields;
    edge.insert("id".into(), json!(id.clone()));
    edge.insert("fromNode".into(), json!(body.from_node));
    edge.insert("toNode".into(), json!(body.to_node));
    edges.insert(id.clone(), JsonValue::Object(edge));
    ensure_order(root, "edgeOrder", &id);
    Ok(())
}

fn patch_item(
    root: &mut JsonMap<String, JsonValue>,
    map_key: &str,
    id: &str,
    patch: JsonMap<String, JsonValue>,
) -> AppResult<()> {
    let items = ensure_object(root, map_key);
    let item = items
        .get_mut(id)
        .and_then(JsonValue::as_object_mut)
        .ok_or(AppError::NotFound)?;
    for (key, value) in patch {
        item.insert(key, value);
    }
    item.insert("id".into(), json!(id));
    Ok(())
}

fn delete_node(root: &mut JsonMap<String, JsonValue>, id: &str) -> AppResult<()> {
    delete_item(root, "nodes", "nodeOrder", id)?;
    let mut delete_edges = Vec::new();
    for (edge_id, edge) in ensure_object(root, "edges").iter() {
        if edge.get("fromNode").and_then(JsonValue::as_str) == Some(id)
            || edge.get("toNode").and_then(JsonValue::as_str) == Some(id)
        {
            delete_edges.push(edge_id.clone());
        }
    }
    for edge_id in delete_edges {
        delete_item(root, "edges", "edgeOrder", &edge_id)?;
    }
    Ok(())
}

fn delete_item(
    root: &mut JsonMap<String, JsonValue>,
    map_key: &str,
    order_key: &str,
    id: &str,
) -> AppResult<()> {
    ensure_object(root, map_key)
        .remove(id)
        .ok_or(AppError::NotFound)?;
    if let Some(order) = root.get_mut(order_key).and_then(JsonValue::as_array_mut) {
        order.retain(|v| v.as_str() != Some(id));
    }
    Ok(())
}

fn upsert_view(root: &mut JsonMap<String, JsonValue>, body: BaseViewBody) -> AppResult<()> {
    let mut view = body.fields;
    view.insert("name".into(), json!(body.name));
    view.insert("type".into(), json!(body.view_type));
    upsert_by_name(root, "views", JsonValue::Object(view))
}

fn base_views_value(value: JsonValue) -> JsonValue {
    value.get("views").cloned().unwrap_or_else(|| json!([]))
}

fn patch_view(root: &mut JsonMap<String, JsonValue>, body: BaseViewPatchBody) -> AppResult<()> {
    let views = ensure_array(root, "views");
    let view = views
        .iter_mut()
        .find(|v| v.get("name").and_then(JsonValue::as_str) == Some(&body.name))
        .and_then(JsonValue::as_object_mut)
        .ok_or(AppError::NotFound)?;
    for (key, value) in body.patch {
        view.insert(key, value);
    }
    view.insert("name".into(), json!(body.name));
    Ok(())
}

fn delete_view(root: &mut JsonMap<String, JsonValue>, name: &str) -> AppResult<()> {
    let views = ensure_array(root, "views");
    let old_len = views.len();
    views.retain(|v| v.get("name").and_then(JsonValue::as_str) != Some(name));
    if old_len == views.len() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

fn set_view_field(
    root: &mut JsonMap<String, JsonValue>,
    name: &str,
    field: &str,
    value: JsonValue,
) -> AppResult<()> {
    let views = ensure_array(root, "views");
    let view = views
        .iter_mut()
        .find(|v| v.get("name").and_then(JsonValue::as_str) == Some(name))
        .and_then(JsonValue::as_object_mut)
        .ok_or(AppError::NotFound)?;
    view.insert(field.into(), value);
    Ok(())
}

fn set_named(
    root: &mut JsonMap<String, JsonValue>,
    key: &str,
    name: &str,
    value: JsonValue,
) -> AppResult<()> {
    ensure_object(root, key).insert(name.into(), value);
    Ok(())
}

fn delete_named(root: &mut JsonMap<String, JsonValue>, key: &str, name: &str) -> AppResult<()> {
    ensure_object(root, key)
        .remove(name)
        .ok_or(AppError::NotFound)?;
    Ok(())
}

fn upsert_by_name(
    root: &mut JsonMap<String, JsonValue>,
    key: &str,
    value: JsonValue,
) -> AppResult<()> {
    let name = value
        .get("name")
        .and_then(JsonValue::as_str)
        .ok_or_else(|| AppError::BadRequest("name is required".into()))?
        .to_string();
    let values = ensure_array(root, key);
    if let Some(slot) = values
        .iter_mut()
        .find(|v| v.get("name").and_then(JsonValue::as_str) == Some(&name))
    {
        *slot = value;
    } else {
        values.push(value);
    }
    Ok(())
}

fn ensure_object<'a>(
    root: &'a mut JsonMap<String, JsonValue>,
    key: &str,
) -> &'a mut JsonMap<String, JsonValue> {
    if !root.get(key).is_some_and(JsonValue::is_object) {
        root.insert(key.into(), json!({}));
    }
    root.get_mut(key).unwrap().as_object_mut().unwrap()
}

fn ensure_array<'a>(root: &'a mut JsonMap<String, JsonValue>, key: &str) -> &'a mut Vec<JsonValue> {
    if !root.get(key).is_some_and(JsonValue::is_array) {
        root.insert(key.into(), json!([]));
    }
    root.get_mut(key).unwrap().as_array_mut().unwrap()
}

fn ensure_order(root: &mut JsonMap<String, JsonValue>, key: &str, id: &str) {
    let order = ensure_array(root, key);
    if !order.iter().any(|v| v.as_str() == Some(id)) {
        order.push(json!(id));
    }
}

fn validate_structured_path(path: &str, kind: &str) -> AppResult<()> {
    if path.is_empty() || path.contains('\\') {
        return Err(AppError::BadRequest("invalid structured path".into()));
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(AppError::BadRequest("invalid structured path".into()));
        }
    }
    let ext = match kind {
        "canvas" => ".canvas",
        "base" => ".base",
        _ => return Err(AppError::BadRequest("invalid structured kind".into())),
    };
    if !path.ends_with(ext) {
        return Err(AppError::BadRequest("invalid structured path".into()));
    }
    Ok(())
}

fn gen_canvas_id() -> String {
    nanoid::nanoid!(16, &nanoid::alphabet::SAFE)
}

fn doc_id(vault_id: &str, guid: &str) -> String {
    format!("{vault_id}__{guid}")
}

fn permalink_for_guid(state: &AppState, guid: &str) -> String {
    format!(
        "{}/n/{guid}",
        state.config.public_base_url.trim_end_matches('/')
    )
}

async fn mark_structured_write(state: &AppState, vault_id: &str, principal: &ApiPrincipal) {
    state
        .git
        .mark_write(
            vault_id,
            &principal.to_git_principal(now_millis() + 24 * 60 * 60 * 1000),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_add_sets_id_and_order() {
        let mut root = JsonMap::new();
        add_node(
            &mut root,
            CanvasNodeBody {
                id: Some("abc".into()),
                fields: JsonMap::from_iter([("type".into(), json!("text"))]),
            },
        )
        .unwrap();
        assert_eq!(root["nodeOrder"], json!(["abc"]));
        assert_eq!(root["nodes"]["abc"]["id"], json!("abc"));
    }

    #[test]
    fn node_delete_cascades_edges() {
        let mut root = canvas_file_to_map(json!({ "nodes": [{"id":"a"},{"id":"b"}], "edges": [{"id":"e", "fromNode":"a", "toNode":"b"}] })).as_object().unwrap().clone();
        delete_node(&mut root, "a").unwrap();
        assert_eq!(root["edges"], json!({}));
        assert_eq!(root["edgeOrder"], json!([]));
    }

    #[test]
    fn view_upserts_by_name() {
        let mut root = JsonMap::new();
        upsert_view(
            &mut root,
            BaseViewBody {
                name: "Main".into(),
                view_type: "table".into(),
                fields: JsonMap::new(),
            },
        )
        .unwrap();
        upsert_view(
            &mut root,
            BaseViewBody {
                name: "Main".into(),
                view_type: "cards".into(),
                fields: JsonMap::new(),
            },
        )
        .unwrap();
        assert_eq!(root["views"].as_array().unwrap().len(), 1);
        assert_eq!(root["views"][0]["type"], json!("cards"));
    }

    #[test]
    fn formula_property_set_unset() {
        let mut root = JsonMap::new();
        set_named(&mut root, "formulas", "f", json!("1+1")).unwrap();
        set_named(&mut root, "properties", "p", json!({"type":"text"})).unwrap();
        delete_named(&mut root, "formulas", "f").unwrap();
        assert!(root["formulas"].as_object().unwrap().is_empty());
        assert_eq!(root["properties"]["p"]["type"], json!("text"));
    }
}
