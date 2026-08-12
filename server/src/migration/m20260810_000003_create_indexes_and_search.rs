use sea_orm::ConnectionTrait;
use sea_orm_migration::prelude::*;

use crate::entities::{
    cursor_audit_log, memberships, note_search, oauth_codes, oauth_tokens, plugin_db_replicas,
    public_attachment_shares, public_shares, remote_cursors, upload_jtis, users, vault_files,
};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[sea_orm_migration::async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let indexes = [
            Index::create()
                .if_not_exists()
                .name("idx_public_attachment_shares_vault_path")
                .table(public_attachment_shares::Entity)
                .col(public_attachment_shares::Column::VaultId)
                .col(public_attachment_shares::Column::Path)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_public_shares_vault_guid")
                .table(public_shares::Entity)
                .col(public_shares::Column::VaultId)
                .col(public_shares::Column::Guid)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_users_issuer_subject")
                .table(users::Entity)
                .col(users::Column::OidcIssuer)
                .col(users::Column::OidcSubject)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_memberships_user_vault")
                .table(memberships::Entity)
                .col(memberships::Column::UserId)
                .col(memberships::Column::VaultId)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_vault_files_vault_guid")
                .table(vault_files::Entity)
                .col(vault_files::Column::VaultId)
                .col(vault_files::Column::Guid)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_note_search_vault_guid")
                .table(note_search::Entity)
                .col(note_search::Column::VaultId)
                .col(note_search::Column::Guid)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_note_search_vault")
                .table(note_search::Entity)
                .col(note_search::Column::VaultId)
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_remote_cursors_app_id")
                .table(remote_cursors::Entity)
                .col(remote_cursors::Column::AppId)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_oauth_codes_expires_at")
                .table(oauth_codes::Entity)
                .col(oauth_codes::Column::ExpiresAt)
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_oauth_tokens_refresh_hash")
                .table(oauth_tokens::Entity)
                .col(oauth_tokens::Column::RefreshHash)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_upload_jtis_expires_at")
                .table(upload_jtis::Entity)
                .col(upload_jtis::Column::ExpiresAt)
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_remote_cursors_vault_plugin")
                .table(remote_cursors::Entity)
                .col(remote_cursors::Column::VaultId)
                .col(remote_cursors::Column::PluginId)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_cursor_audit_cursor_created")
                .table(cursor_audit_log::Entity)
                .col(cursor_audit_log::Column::CursorId)
                .col(cursor_audit_log::Column::CreatedAt)
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_cursor_audit_created")
                .table(cursor_audit_log::Entity)
                .col(cursor_audit_log::Column::CreatedAt)
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_plugin_db_replicas_vault_plugin_name")
                .table(plugin_db_replicas::Entity)
                .col(plugin_db_replicas::Column::VaultId)
                .col(plugin_db_replicas::Column::PluginId)
                .col(plugin_db_replicas::Column::Name)
                .unique()
                .to_owned(),
            Index::create()
                .if_not_exists()
                .name("idx_background_job_intents_pending")
                .table(Alias::new("background_job_intents"))
                .col(Alias::new("active_generation"))
                .col(Alias::new("completed_revision"))
                .col(Alias::new("revision"))
                .to_owned(),
        ];

        for index in indexes {
            manager.create_index(index).await?;
        }

        manager
            .get_connection()
            .execute_unprepared(
                "CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(\
                 vault_id UNINDEXED, guid UNINDEXED, path, title, tags, body, \
                 tokenize = 'trigram')",
            )
            .await?;

        Ok(())
    }
}
