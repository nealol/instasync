use anyhow::{anyhow, Result};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use std::collections::HashMap;
use std::sync::Arc;
use y_sweet_core::auth::Authenticator;
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{Any, Doc, GetString, Map, ReadTxn, Text, Transact, Update};

use crate::config::Config;
use crate::entities::vault_files;
use crate::error::{AppError, AppResult};
use crate::session::now_millis;
use crate::state::AppState;
use crate::ysweet::{self, Level};

pub async fn read_update(state: &AppState, doc_id: &str) -> AppResult<Vec<u8>> {
    read_update_with(&state.config, &state.http, &state.authenticator, doc_id).await
}

pub async fn read_update_with(
    config: &Arc<Config>,
    http: &reqwest::Client,
    authenticator: &Arc<Authenticator>,
    doc_id: &str,
) -> AppResult<Vec<u8>> {
    let (base_url, token) =
        ysweet::mint_internal_token_with(config, http, authenticator, doc_id, Level::ReadOnly)
            .await?;
    let url = format!("{}/as-update", base_url.trim_end_matches('/'));
    let res = http
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("GET {url}: {e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Internal(format!(
            "as-update {doc_id} returned {}",
            res.status()
        )));
    }
    res.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| AppError::Internal(format!("as-update body: {e}")))
}

pub async fn write_update(state: &AppState, doc_id: &str, update: Vec<u8>) -> AppResult<()> {
    let (base_url, token) = ysweet::mint_internal_token(state, doc_id, Level::Full).await?;
    let url = format!("{}/update", base_url.trim_end_matches('/'));
    let res = state
        .http
        .post(&url)
        .bearer_auth(token)
        .body(update)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("POST {url}: {e}")))?;
    if !res.status().is_success() {
        return Err(AppError::Internal(format!(
            "update {doc_id} returned {}",
            res.status()
        )));
    }
    Ok(())
}

pub async fn set_text(state: &AppState, doc_id: &str, new_content: &str) -> AppResult<()> {
    let current = read_update(state, doc_id).await?;
    let update = build_set_text_update(&current, "contents", new_content)?;
    if update.is_empty() {
        return Ok(());
    }
    write_update(state, doc_id, update).await
}

pub async fn index_set_file(
    state: &AppState,
    vault_id: &str,
    path: &str,
    guid: &str,
) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let update = build_map_set_update(&current, "files", path, guid.to_string())?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    upsert_vault_file(state, vault_id, path, guid).await
}

pub async fn index_remove_file(state: &AppState, vault_id: &str, path: &str) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let guid = decode_files_map(&current)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .find(|(p, _)| p == path)
        .map(|(_, guid)| guid);
    let update = build_map_remove_update(&current, "files", path)?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    if let Some(guid) = guid {
        vault_files::Entity::delete_many()
            .filter(vault_files::Column::VaultId.eq(vault_id))
            .filter(vault_files::Column::Guid.eq(guid))
            .exec(&state.db)
            .await?;
    }
    Ok(())
}

pub async fn index_rename(state: &AppState, vault_id: &str, from: &str, to: &str) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let guid = decode_files_map(&current)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .find(|(path, _)| path == from)
        .map(|(_, guid)| guid)
        .ok_or(AppError::NotFound)?;
    let update = build_map_rename_update(&current, "files", from, to, guid.clone())?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    upsert_vault_file(state, vault_id, to, &guid).await
}

pub async fn index_set_binary(
    state: &AppState,
    vault_id: &str,
    path: &str,
    hash: &str,
    size: i64,
) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let metadata = HashMap::from([
        ("hash".to_string(), Any::String(hash.into())),
        ("size".to_string(), Any::BigInt(size)),
    ]);
    let update = build_map_set_update(&current, "binaries", path, metadata)?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    Ok(())
}

pub async fn index_remove_binary(state: &AppState, vault_id: &str, path: &str) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let update = build_map_remove_update(&current, "binaries", path)?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    Ok(())
}

pub async fn index_rename_binary(
    state: &AppState,
    vault_id: &str,
    from: &str,
    to: &str,
) -> AppResult<()> {
    let current = read_update(state, vault_id).await?;
    let meta = decode_binaries_map(&current)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .into_iter()
        .find(|(path, _)| path == from)
        .map(|(_, meta)| meta)
        .ok_or(AppError::NotFound)?;
    let update = build_map_rename_update(&current, "binaries", from, to, meta)?;
    if !update.is_empty() {
        write_update(state, vault_id, update).await?;
    }
    Ok(())
}

fn build_set_text_update(
    current_update: &[u8],
    name: &str,
    new_content: &str,
) -> AppResult<Vec<u8>> {
    let doc = doc_from_update(current_update)?;
    let before = doc.transact().state_vector();
    let text = doc.get_or_insert_text(name);
    let old_content = {
        let txn = doc.transact();
        text.get_string(&txn)
    };
    if old_content == new_content {
        return Ok(Vec::new());
    }

    let ascii_splice = old_content.is_ascii() && new_content.is_ascii();
    let (prefix, old_suffix, new_suffix) = if ascii_splice {
        common_affixes(&old_content, new_content)
    } else {
        (0, old_content.len(), new_content.len())
    };
    let prefix_units = old_content[..prefix].chars().count() as u32;
    let delete_len = if ascii_splice {
        old_content[prefix..old_suffix].chars().count() as u32
    } else {
        old_content[prefix..old_suffix].len() as u32
    };
    let insert_text = &new_content[prefix..new_suffix];
    {
        let mut txn = doc.transact_mut();
        if delete_len > 0 {
            text.remove_range(&mut txn, prefix_units, delete_len);
        }
        if !insert_text.is_empty() {
            text.insert(&mut txn, prefix_units, insert_text);
        }
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

fn build_map_set_update<V>(
    current_update: &[u8],
    map_name: &str,
    key: &str,
    value: V,
) -> AppResult<Vec<u8>>
where
    V: Into<Any>,
{
    let doc = doc_from_update(current_update)?;
    let before = doc.transact().state_vector();
    let map = doc.get_or_insert_map(map_name);
    {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, key.to_string(), value);
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

fn build_map_remove_update(current_update: &[u8], map_name: &str, key: &str) -> AppResult<Vec<u8>> {
    let doc = doc_from_update(current_update)?;
    let before = doc.transact().state_vector();
    let map = doc.get_or_insert_map(map_name);
    {
        let mut txn = doc.transact_mut();
        map.remove(&mut txn, key);
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

fn build_map_rename_update<V>(
    current_update: &[u8],
    map_name: &str,
    from: &str,
    to: &str,
    value: V,
) -> AppResult<Vec<u8>>
where
    V: Into<Any>,
{
    let doc = doc_from_update(current_update)?;
    let before = doc.transact().state_vector();
    let map = doc.get_or_insert_map(map_name);
    {
        let mut txn = doc.transact_mut();
        map.remove(&mut txn, from);
        map.insert(&mut txn, to.to_string(), value);
    }
    let update = doc.transact().encode_state_as_update_v1(&before);
    Ok(update)
}

fn doc_from_update(update: &[u8]) -> AppResult<Doc> {
    let doc = Doc::new();
    let update = Update::decode_v1(update)
        .map_err(|e| AppError::Internal(format!("decode update: {e:?}")))?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
    }
    Ok(doc)
}

fn common_affixes(old: &str, new: &str) -> (usize, usize, usize) {
    let mut prefix = 0;
    for ((old_idx, old_ch), (new_idx, new_ch)) in old.char_indices().zip(new.char_indices()) {
        if old_ch != new_ch {
            break;
        }
        prefix = old_idx + old_ch.len_utf8();
        debug_assert_eq!(prefix, new_idx + new_ch.len_utf8());
    }

    let mut old_suffix = old.len();
    let mut new_suffix = new.len();
    while old_suffix > prefix && new_suffix > prefix {
        let old_ch = old[..old_suffix].chars().next_back().unwrap();
        let new_ch = new[..new_suffix].chars().next_back().unwrap();
        if old_ch != new_ch {
            break;
        }
        old_suffix -= old_ch.len_utf8();
        new_suffix -= new_ch.len_utf8();
    }
    (prefix, old_suffix, new_suffix)
}

async fn upsert_vault_file(
    state: &AppState,
    vault_id: &str,
    path: &str,
    guid: &str,
) -> AppResult<()> {
    let existing = vault_files::Entity::find()
        .filter(vault_files::Column::VaultId.eq(vault_id))
        .filter(vault_files::Column::Guid.eq(guid))
        .one(&state.db)
        .await?;

    if let Some(model) = existing {
        let mut active: vault_files::ActiveModel = model.into();
        active.path = Set(path.to_string());
        active.updated_at = Set(now_millis());
        active.update(&state.db).await?;
    } else {
        vault_files::ActiveModel {
            id: Set(uuid::Uuid::new_v4().to_string()),
            vault_id: Set(vault_id.to_string()),
            guid: Set(guid.to_string()),
            path: Set(path.to_string()),
            updated_at: Set(now_millis()),
        }
        .insert(&state.db)
        .await?;
    }
    Ok(())
}

/// Decode a named root `Y.Text` from a full-state update into a String.
pub fn decode_text(update: &[u8], name: &str) -> Result<String> {
    let doc = Doc::new();
    let update = Update::decode_v1(update).map_err(|e| anyhow!("decode update: {e:?}"))?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
    }
    let text = doc.get_or_insert_text(name);
    let txn = doc.transact();
    Ok(text.get_string(&txn))
}

/// Decode the vault index doc's `files` map (path -> guid) from a full-state update.
pub fn decode_files_map(update: &[u8]) -> Result<Vec<(String, String)>> {
    decode_string_map(update, "files")
}

/// Decode the vault index doc's `binaries` map (path -> JSON metadata) from a full-state update.
pub fn decode_binaries_map(update: &[u8]) -> Result<Vec<(String, Any)>> {
    let doc = Doc::new();
    let update = Update::decode_v1(update).map_err(|e| anyhow!("decode index: {e:?}"))?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
    }
    let map = doc.get_or_insert_map("binaries");
    let txn = doc.transact();
    let mut out = Vec::new();
    if let Any::Map(entries) = map.to_json(&txn) {
        for (path, value) in entries.iter() {
            out.push((path.clone(), value.clone()));
        }
    }
    Ok(out)
}

fn decode_string_map(update: &[u8], name: &str) -> Result<Vec<(String, String)>> {
    let doc = Doc::new();
    let update = Update::decode_v1(update).map_err(|e| anyhow!("decode index: {e:?}"))?;
    {
        let mut txn = doc.transact_mut();
        txn.apply_update(update);
    }
    let map = doc.get_or_insert_map(name);
    let txn = doc.transact();
    let mut out = Vec::new();
    if let Any::Map(entries) = map.to_json(&txn) {
        for (path, value) in entries.iter() {
            if let Any::String(guid) = value {
                out.push((path.clone(), guid.to_string()));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Map, Text};

    fn text_update(name: &str, value: &str) -> Vec<u8> {
        let doc = Doc::new();
        let text = doc.get_or_insert_text(name);
        {
            let mut txn = doc.transact_mut();
            text.insert(&mut txn, 0, value);
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        update
    }

    fn files_update(entries: &[(&str, &str)]) -> Vec<u8> {
        let doc = Doc::new();
        let map = doc.get_or_insert_map("files");
        {
            let mut txn = doc.transact_mut();
            for (path, guid) in entries {
                map.insert(&mut txn, path.to_string(), guid.to_string());
            }
        }
        let update = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        update
    }

    fn apply_update(base: &[u8], update: &[u8]) -> Vec<u8> {
        let doc = doc_from_update(base).unwrap();
        let update = Update::decode_v1(update).unwrap();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update);
        }
        let out = doc
            .transact()
            .encode_state_as_update_v1(&yrs::StateVector::default());
        out
    }

    #[test]
    fn decode_text_roundtrips() {
        let update = text_update("contents", "# Hello\nworld");
        assert_eq!(decode_text(&update, "contents").unwrap(), "# Hello\nworld");
    }

    #[test]
    fn decode_files_map_roundtrips() {
        let update = files_update(&[("a.md", "guid-a"), ("dir/b.md", "guid-b")]);
        let mut got = decode_files_map(&update).unwrap();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("a.md".to_string(), "guid-a".to_string()),
                ("dir/b.md".to_string(), "guid-b".to_string()),
            ]
        );
    }

    #[test]
    fn build_set_text_update_replaces_middle_only() {
        let base = text_update("contents", "hello brave world");
        let diff = build_set_text_update(&base, "contents", "hello bold world").unwrap();
        let merged = apply_update(&base, &diff);
        assert_eq!(
            decode_text(&merged, "contents").unwrap(),
            "hello bold world"
        );
    }

    #[test]
    fn build_set_text_update_handles_unicode_boundaries() {
        let base = text_update("contents", "hi 🦀 world");
        let diff = build_set_text_update(&base, "contents", "hi 🦀 vault").unwrap();
        let merged = apply_update(&base, &diff);
        assert_eq!(decode_text(&merged, "contents").unwrap(), "hi 🦀 vault");
    }

    #[test]
    fn build_map_rename_update_moves_file_entry() {
        let base = files_update(&[("a.md", "guid-a")]);
        let diff =
            build_map_rename_update(&base, "files", "a.md", "b.md", "guid-a".to_string()).unwrap();
        let merged = apply_update(&base, &diff);
        assert_eq!(
            decode_files_map(&merged).unwrap(),
            vec![("b.md".into(), "guid-a".into())]
        );
    }
}
