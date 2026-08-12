use sea_orm::Schema;
use sea_orm_migration::prelude::*;

use crate::entities::{
    cursor_audit_log, git_backups, invites, memberships, note_search, oauth_clients, oauth_codes,
    oauth_tokens, permissions, plugin_db_replicas, public_attachment_shares, public_shares,
    remote_cursor_tokens, remote_cursors, server_meta, sessions, upload_jtis, users, vault_files,
    vaults,
};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[sea_orm_migration::async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let schema = Schema::new(manager.get_database_backend());

        macro_rules! create {
            ($entity:expr) => {{
                let mut statement = schema.create_table_from_entity($entity);
                statement.if_not_exists();
                manager.create_table(statement).await?;
            }};
        }

        // `IF NOT EXISTS` is intentional: installations created before the
        // migration ledger already have some or all of these tables. This
        // migration adopts them; the next migration repairs known old shapes.
        create!(server_meta::Entity);
        create!(users::Entity);
        create!(sessions::Entity);
        create!(vaults::Entity);
        create!(memberships::Entity);
        create!(invites::Entity);
        create!(vault_files::Entity);
        create!(note_search::Entity);
        create!(permissions::Entity);
        create!(remote_cursors::Entity);
        create!(remote_cursor_tokens::Entity);
        create!(cursor_audit_log::Entity);
        create!(oauth_clients::Entity);
        create!(oauth_codes::Entity);
        create!(oauth_tokens::Entity);
        create!(upload_jtis::Entity);
        create!(plugin_db_replicas::Entity);
        create!(git_backups::Entity);
        create!(public_shares::Entity);
        create!(public_attachment_shares::Entity);

        Ok(())
    }
}
