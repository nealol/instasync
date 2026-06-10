use sea_orm::sea_query::{Index, IndexCreateStatement};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, DatabaseConnection, DbErr, EntityTrait, Schema, Set,
};

use crate::entities::{
    invites, memberships, note_search, oauth_clients, oauth_codes, oauth_tokens, permissions,
    plugin_db_replicas, remote_cursors, server_meta, sessions, upload_jtis, users, vault_files,
    vaults,
};

/// Create all tables (and the composite-unique indexes) if they do not exist.
/// Using the schema builder keeps this prototype free of a separate migration
/// crate while still being deterministic.
pub async fn init_schema(db: &DatabaseConnection) -> Result<(), DbErr> {
    let backend = db.get_database_backend();
    let schema = Schema::new(backend);

    macro_rules! create {
        ($entity:expr) => {{
            let mut stmt = schema.create_table_from_entity($entity);
            stmt.if_not_exists();
            db.execute(backend.build(&stmt)).await?;
        }};
    }

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
    create!(oauth_clients::Entity);
    create!(oauth_codes::Entity);
    create!(oauth_tokens::Entity);
    create!(upload_jtis::Entity);
    create!(plugin_db_replicas::Entity);

    let indexes: [IndexCreateStatement; 10] = [
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
            .name("idx_plugin_db_replicas_vault_plugin_name")
            .table(plugin_db_replicas::Entity)
            .col(plugin_db_replicas::Column::VaultId)
            .col(plugin_db_replicas::Column::PluginId)
            .col(plugin_db_replicas::Column::Name)
            .unique()
            .to_owned(),
    ];
    for idx in indexes {
        db.execute(backend.build(&idx)).await?;
    }

    db.execute_unprepared(
        "CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(\
         vault_id UNINDEXED, guid UNINDEXED, path, title, tags, body, \
         tokenize = 'trigram')",
    )
    .await?;

    Ok(())
}

const SERVER_ID_KEY: &str = "server_id";

/// Return this server's stable id, generating and persisting one on first call.
/// The id is advertised via `GET /api/server-info` so clients can key cached
/// session tokens per server (Obsidian's SecretStorage is shared across vaults).
pub async fn ensure_server_id(db: &DatabaseConnection) -> Result<String, DbErr> {
    if let Some(row) = server_meta::Entity::find_by_id(SERVER_ID_KEY.to_string())
        .one(db)
        .await?
    {
        return Ok(row.value);
    }
    let id = uuid::Uuid::new_v4().to_string();
    server_meta::ActiveModel {
        key: Set(SERVER_ID_KEY.to_string()),
        value: Set(id.clone()),
    }
    .insert(db)
    .await?;
    Ok(id)
}
