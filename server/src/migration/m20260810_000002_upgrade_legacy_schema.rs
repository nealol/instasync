use sea_orm_migration::prelude::*;

const JOB_INTENTS: &str = "background_job_intents";
const JOB_CONTRIBUTORS: &str = "background_job_contributors";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[sea_orm_migration::async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Alias::new(JOB_INTENTS))
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Alias::new("intent_key"))
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(Alias::new("payload_json")).text().not_null())
                    .col(
                        ColumnDef::new(Alias::new("revision"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("completed_revision"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("terminal_revision"))
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Alias::new("generation"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("active_generation"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("run_after_ms"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("updated_at"))
                            .big_integer()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Alias::new("last_error")).text())
                    .to_owned(),
            )
            .await?;

        add_big_integer_column(manager, JOB_INTENTS, "terminal_revision", true, Some(0)).await?;

        manager
            .create_table(
                Table::create()
                    .table(Alias::new(JOB_CONTRIBUTORS))
                    .if_not_exists()
                    .col(ColumnDef::new(Alias::new("intent_key")).text().not_null())
                    .col(ColumnDef::new(Alias::new("actor_key")).text().not_null())
                    .col(
                        ColumnDef::new(Alias::new("principal_json"))
                            .text()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("revision"))
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .primary_key(
                        Index::create()
                            .name("pk_background_job_contributors")
                            .col(Alias::new("intent_key"))
                            .col(Alias::new("actor_key"))
                            .primary(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_background_job_contributors_intent")
                            .from(Alias::new(JOB_CONTRIBUTORS), Alias::new("intent_key"))
                            .to(Alias::new(JOB_INTENTS), Alias::new("intent_key"))
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        add_text_column(manager, "remote_cursors", "plugin_id").await?;
        add_big_integer_column(manager, JOB_CONTRIBUTORS, "revision", true, Some(0)).await?;
        add_text_column(manager, "users", "git_email").await?;
        add_text_column(manager, "users", "picture_url").await?;
        add_text_column(manager, "users", "avatar_url_override").await?;

        Ok(())
    }
}

async fn add_text_column(
    manager: &SchemaManager<'_>,
    table: &str,
    column: &str,
) -> Result<(), DbErr> {
    if manager.has_column(table, column).await? {
        return Ok(());
    }
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new(table))
                .add_column(ColumnDef::new(Alias::new(column)).text())
                .to_owned(),
        )
        .await
}

async fn add_big_integer_column(
    manager: &SchemaManager<'_>,
    table: &str,
    column: &str,
    not_null: bool,
    default: Option<i64>,
) -> Result<(), DbErr> {
    if manager.has_column(table, column).await? {
        return Ok(());
    }

    let mut definition = ColumnDef::new(Alias::new(column));
    definition.big_integer();
    if not_null {
        definition.not_null();
    }
    if let Some(default) = default {
        definition.default(default);
    }

    manager
        .alter_table(
            Table::alter()
                .table(Alias::new(table))
                .add_column(&mut definition)
                .to_owned(),
        )
        .await
}
