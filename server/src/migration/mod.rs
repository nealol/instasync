mod m20260810_000001_create_application_tables;
mod m20260810_000002_upgrade_legacy_schema;
mod m20260810_000003_create_indexes_and_search;

use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, TransactionTrait};
use sea_orm_migration::prelude::{MigrationTrait, MigratorTrait};

pub struct Migrator;

#[sea_orm_migration::async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260810_000001_create_application_tables::Migration),
            Box::new(m20260810_000002_upgrade_legacy_schema::Migration),
            Box::new(m20260810_000003_create_indexes_and_search::Migration),
        ]
    }
}

/// Apply every pending application migration as one SQLite transaction.
///
/// The history must be an exact prefix of the migrations compiled into this
/// binary. A database created by a newer binary, or one with missing/reordered
/// history, is rejected before any schema statement runs.
pub async fn migrate(db: &DatabaseConnection) -> Result<(), DbErr> {
    let transaction = db.begin().await?;
    let result = async {
        verify_history(&transaction).await?;
        Migrator::up(&transaction, None).await
    }
    .await;

    match result {
        Ok(()) => transaction.commit().await,
        Err(error) => match transaction.rollback().await {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(DbErr::Migration(format!(
                "database migration failed: {error}; rollback failed: {rollback_error}"
            ))),
        },
    }
}

async fn verify_history<C>(db: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    let expected = migration_names();
    let applied = Migrator::get_migration_models(db).await?;

    for (position, migration) in applied.iter().enumerate() {
        if expected.get(position) != Some(&migration.version) {
            let expected_version = expected
                .get(position)
                .map(String::as_str)
                .unwrap_or("<no migration>");
            return Err(DbErr::Migration(format!(
                "database migration history is unknown or out of order at position {}: \
                 found {:?}, expected {:?}; refusing startup",
                position + 1,
                migration.version,
                expected_version
            )));
        }
    }

    Ok(())
}

fn migration_names() -> Vec<String> {
    Migrator::migrations()
        .iter()
        .map(|migration| migration.name().to_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{remote_cursors, users};
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Statement};
    use sea_orm_migration::SchemaManager;

    #[tokio::test]
    async fn fresh_database_is_versioned_and_idempotent() {
        let db = Database::connect("sqlite::memory:").await.unwrap();

        migrate(&db).await.unwrap();
        migrate(&db).await.unwrap();

        let applied: Vec<String> = Migrator::get_migration_models(&db)
            .await
            .unwrap()
            .into_iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(applied, migration_names());

        let manager = SchemaManager::new(&db);
        assert!(manager.has_table("users").await.unwrap());
        assert!(manager.has_table("background_job_intents").await.unwrap());
        assert!(manager.has_table("note_fts").await.unwrap());
        assert!(manager.has_column("users", "git_email").await.unwrap());
        assert!(manager
            .has_column("remote_cursors", "plugin_id")
            .await
            .unwrap());
        assert!(manager
            .has_column("background_job_intents", "terminal_revision")
            .await
            .unwrap());
        assert!(manager
            .has_index("remote_cursors", "idx_remote_cursors_vault_plugin")
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn unversioned_legacy_database_is_upgraded_without_losing_rows() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared(
            "CREATE TABLE users (\
                 id TEXT PRIMARY KEY NOT NULL,\
                 oidc_issuer TEXT NOT NULL,\
                 oidc_subject TEXT NOT NULL,\
                 email TEXT NOT NULL,\
                 display_name TEXT NOT NULL,\
                 created_at INTEGER NOT NULL\
             );\
             CREATE TABLE remote_cursors (\
                 id TEXT PRIMARY KEY NOT NULL,\
                 vault_id TEXT NOT NULL,\
                 app_id TEXT NOT NULL,\
                 name TEXT NOT NULL,\
                 token_hash TEXT NOT NULL,\
                 created_by TEXT NOT NULL,\
                 created_at INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL\
             );\
             CREATE TABLE background_job_intents (\
                 intent_key TEXT PRIMARY KEY NOT NULL,\
                 payload_json TEXT NOT NULL,\
                 revision INTEGER NOT NULL,\
                 completed_revision INTEGER NOT NULL,\
                 generation INTEGER NOT NULL,\
                 active_generation INTEGER NOT NULL,\
                 run_after_ms INTEGER NOT NULL,\
                 updated_at INTEGER NOT NULL,\
                 last_error TEXT\
             );\
             INSERT INTO users \
                 (id, oidc_issuer, oidc_subject, email, display_name, created_at) \
                 VALUES ('user-1', 'issuer', 'subject', 'user@example.com', 'User', 1);\
             INSERT INTO remote_cursors \
                 (id, vault_id, app_id, name, token_hash, created_by, created_at, updated_at) \
                 VALUES ('cursor-1', 'vault-1', 'app-1', 'Cursor', 'hash', 'user-1', 1, 1);\
             INSERT INTO background_job_intents \
                 (intent_key, payload_json, revision, completed_revision, generation, \
                  active_generation, run_after_ms, updated_at, last_error) \
                 VALUES ('job-1', '{}', 4, 2, 1, 1, 0, 1, NULL)",
        )
        .await
        .unwrap();

        migrate(&db).await.unwrap();

        let user = users::Entity::find_by_id("user-1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(user.email, "user@example.com");
        assert_eq!(user.git_email, None);
        assert_eq!(user.picture_url, None);
        assert_eq!(user.avatar_url_override, None);

        let cursor = remote_cursors::Entity::find_by_id("cursor-1")
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cursor.name, "Cursor");
        assert_eq!(cursor.plugin_id, None);

        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT revision, completed_revision, terminal_revision \
                 FROM background_job_intents WHERE intent_key = 'job-1'",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<i64>("", "revision").unwrap(), 4);
        assert_eq!(row.try_get::<i64>("", "completed_revision").unwrap(), 2);
        assert_eq!(row.try_get::<i64>("", "terminal_revision").unwrap(), 0);
    }

    #[tokio::test]
    async fn unknown_or_newer_migration_history_is_rejected() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        migrate(&db).await.unwrap();
        db.execute_unprepared(
            "INSERT INTO seaql_migrations(version, applied_at) \
             VALUES ('m99999999_999999_unknown', 0)",
        )
        .await
        .unwrap();

        let error = migrate(&db).await.unwrap_err();
        assert!(error.to_string().contains("unknown or out of order"));
        assert!(error.to_string().contains("refusing startup"));
    }

    #[tokio::test]
    async fn failed_migration_rolls_back_schema_and_history_together() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        db.execute_unprepared(
            "CREATE TABLE users (\
                 id TEXT PRIMARY KEY NOT NULL,\
                 oidc_issuer TEXT NOT NULL,\
                 oidc_subject TEXT NOT NULL,\
                 email TEXT NOT NULL,\
                 display_name TEXT NOT NULL,\
                 created_at INTEGER NOT NULL\
             );\
             INSERT INTO users VALUES ('user-1', 'issuer', 'duplicate', 'a@example.com', 'A', 1);\
             INSERT INTO users VALUES ('user-2', 'issuer', 'duplicate', 'b@example.com', 'B', 1)",
        )
        .await
        .unwrap();

        assert!(migrate(&db).await.is_err());

        let manager = SchemaManager::new(&db);
        assert!(!manager.has_table("seaql_migrations").await.unwrap());
        assert!(!manager.has_column("users", "git_email").await.unwrap());
        assert!(!manager.has_table("vaults").await.unwrap());

        let row = db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS count FROM users",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.try_get::<i64>("", "count").unwrap(), 2);
    }
}
