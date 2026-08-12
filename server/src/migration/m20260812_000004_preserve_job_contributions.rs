use sea_orm_migration::prelude::*;

const JOB_CONTRIBUTORS: &str = "background_job_contributors";

#[derive(DeriveMigrationName)]
pub struct Migration;

#[sea_orm_migration::async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Alias::new("background_job_contributors_v2"))
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
                            .not_null(),
                    )
                    .primary_key(
                        Index::create()
                            .name("pk_background_job_contributors_v2")
                            .col(Alias::new("intent_key"))
                            .col(Alias::new("revision"))
                            .col(Alias::new("actor_key"))
                            .primary(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_background_job_contributors_v2_intent")
                            .from(
                                Alias::new("background_job_contributors_v2"),
                                Alias::new("intent_key"),
                            )
                            .to(
                                Alias::new("background_job_intents"),
                                Alias::new("intent_key"),
                            )
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .get_connection()
            .execute_unprepared(
                "INSERT INTO background_job_contributors_v2 \
                 (intent_key,actor_key,principal_json,revision) \
                 SELECT intent_key,actor_key,principal_json,revision \
                 FROM background_job_contributors",
            )
            .await?;
        manager
            .drop_table(Table::drop().table(Alias::new(JOB_CONTRIBUTORS)).to_owned())
            .await?;
        manager
            .rename_table(
                Table::rename()
                    .table(
                        Alias::new("background_job_contributors_v2"),
                        Alias::new(JOB_CONTRIBUTORS),
                    )
                    .to_owned(),
            )
            .await
    }
}
