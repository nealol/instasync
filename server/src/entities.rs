//! SeaORM entities. Ids are stored as TEXT (uuid v4 strings) and timestamps as
//! epoch-millis i64, which keeps the sqlite mapping trivial.

pub mod server_meta {
    use sea_orm::entity::prelude::*;

    /// Singleton-ish key/value table for server-wide metadata. Currently holds
    /// the stable `server_id` advertised by `GET /api/server-info`.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "server_meta")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub key: String,
        pub value: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod users {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub oidc_issuer: String,
        pub oidc_subject: String,
        pub email: String,
        pub git_email: Option<String>,
        pub display_name: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod sessions {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub token: String,
        pub user_id: String,
        pub created_at: i64,
        pub expires_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod vaults {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "vaults")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub name: String,
        pub created_by: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod memberships {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "memberships")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub user_id: String,
        pub vault_id: String,
        /// "admin" | "member"
        pub role: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod invites {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "invites")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        #[sea_orm(unique)]
        pub code: String,
        /// Role granted on redemption ("admin" | "member").
        pub role_granted: String,
        pub created_by: String,
        pub used_by: Option<String>,
        pub used_at: Option<i64>,
        pub created_at: i64,
        pub expires_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod vault_files {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "vault_files")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        pub guid: String,
        pub path: String,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod public_shares {
    use sea_orm::entity::prelude::*;

    /// Public read-only share links. The id is the nanoid in `/view/{id}`;
    /// shares reference the stable note guid so they survive renames. Revoking
    /// a share deletes the row.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "public_shares")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        pub guid: String,
        pub created_by: String,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod note_search {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "note_search")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        pub guid: String,
        pub path: String,
        pub title: String,
        pub tags: String,
        pub links: String,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod permissions {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "permissions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        /// NULL means "everyone".
        pub principal_user_id: Option<String>,
        pub path_prefix: String,
        /// "full" | "read-only" | "deny"
        pub level: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod remote_cursors {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "remote_cursors")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        #[sea_orm(unique)]
        pub app_id: String,
        pub name: String,
        pub token_hash: String,
        pub created_by: String,
        /// Set when the cursor is managed by an Obsidian plugin (manifest id).
        /// One plugin cursor per (vault_id, plugin_id); NULL for admin-created
        /// cursors.
        pub plugin_id: Option<String>,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod remote_cursor_tokens {
    use sea_orm::entity::prelude::*;

    /// Additional bearer tokens for a remote cursor, used by plugin-managed
    /// cursors where several devices may acquire tokens independently. The
    /// legacy single `remote_cursors.token_hash` keeps working alongside these.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "remote_cursor_tokens")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub cursor_id: String,
        #[sea_orm(unique)]
        pub token_hash: String,
        /// Free-form hint about who minted it (e.g. acquiring user).
        pub label: String,
        pub created_at: i64,
        pub expires_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod cursor_audit_log {
    use sea_orm::entity::prelude::*;

    /// Short-lived (~3 days) audit trail of remote-cursor mutations across the
    /// MCP, REST and streaming surfaces. `before_content`/`after_content` hold
    /// the full note text (or pretty JSON for structured docs) so entries can
    /// be diffed and undone; this is separate from the permanent Git log.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "cursor_audit_log")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        pub cursor_id: String,
        pub created_at: i64,
        /// e.g. "note_create" | "note_replace" | "note_patch" | "note_move" |
        /// "note_delete" | "stream" | "structured_*" | "attachment_*"
        pub operation: String,
        pub path: String,
        /// Destination path for move operations.
        pub to_path: Option<String>,
        pub before_content: Option<String>,
        pub after_content: Option<String>,
        /// JSON object with operation-specific extras (hash/size, truncated…).
        pub details: Option<String>,
        pub undone_at: Option<i64>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod git_backups {
    use sea_orm::entity::prelude::*;

    /// Per-vault git backup remote. One row per vault; the server pushes the
    /// vault's audit repo here after every commit. Secrets are stored in
    /// plaintext by design (server-side trust model, no at-rest encryption).
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "git_backups")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub vault_id: String,
        pub remote_url: String,
        /// "ssh" | "https"
        pub auth_method: String,
        pub branch: String,
        /// OpenSSH-format private key (auth_method == "ssh").
        pub ssh_private_key: Option<String>,
        pub ssh_public_key: Option<String>,
        /// HTTPS access token (auth_method == "https").
        pub https_token: Option<String>,
        pub enabled: bool,
        pub last_push_at: Option<i64>,
        pub last_push_error: Option<String>,
        pub created_by: String,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod oauth_clients {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "oauth_clients")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub client_secret_hash: Option<String>,
        pub redirect_uris: String,
        pub app_id: Option<String>,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod oauth_codes {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "oauth_codes")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub code_hash: String,
        pub client_id: String,
        pub user_id: String,
        pub app_id: String,
        pub vault_id: String,
        pub code_challenge: String,
        pub redirect_uri: String,
        pub scope: String,
        pub expires_at: i64,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod oauth_tokens {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "oauth_tokens")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub access_hash: String,
        #[sea_orm(unique)]
        pub refresh_hash: Option<String>,
        pub client_id: String,
        pub user_id: String,
        pub app_id: String,
        pub vault_id: String,
        pub scope: String,
        pub access_expires_at: i64,
        pub refresh_expires_at: i64,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod upload_jtis {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "upload_jtis")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub jti: String,
        pub expires_at: i64,
        pub created_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod plugin_db_replicas {
    use sea_orm::entity::prelude::*;

    /// Per synced plugin database: the server's applied cursor (JSON
    /// `{siteHex: dbVersion}`) into the on-disk replica, so restarts don't
    /// re-scan the whole Y log.
    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "plugin_db_replicas")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub vault_id: String,
        pub plugin_id: String,
        pub name: String,
        /// JSON object: applied cursor `{siteHex: dbVersion}`.
        pub cursor_json: String,
        /// Whether the database has been purged (tombstoned).
        pub deleted: bool,
        pub updated_at: i64,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}
