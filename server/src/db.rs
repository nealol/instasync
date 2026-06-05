use sea_orm::sea_query::{Index, IndexCreateStatement};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbErr, Schema};

use crate::entities::{invites, memberships, permissions, sessions, users, vault_files, vaults};

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

    create!(users::Entity);
    create!(sessions::Entity);
    create!(vaults::Entity);
    create!(memberships::Entity);
    create!(invites::Entity);
    create!(vault_files::Entity);
    create!(permissions::Entity);

    let indexes: [IndexCreateStatement; 3] = [
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
    ];
    for idx in indexes {
        db.execute(backend.build(&idx)).await?;
    }

    Ok(())
}
