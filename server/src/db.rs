use sea_orm::{ActiveModelTrait, DatabaseConnection, DbErr, EntityTrait, Set};

use crate::entities::server_meta;

/// Apply every pending application-database migration.
///
/// Migrations and their ledger entries commit atomically. Existing unversioned
/// databases are adopted by the baseline migration, while unknown or
/// out-of-order migration history is rejected.
pub async fn migrate_schema(db: &DatabaseConnection) -> Result<(), DbErr> {
    crate::migration::migrate(db).await
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
