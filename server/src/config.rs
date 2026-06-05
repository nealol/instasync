use std::env;

/// Runtime configuration, read from the environment. See README for the full list.
#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    /// Public base URL of *this* server (used to build the OIDC redirect default).
    pub public_base_url: String,
    /// Internal URL the auth server uses to reach y-sweet.
    pub ysweet_url: String,
    /// Filesystem directory for the content-addressed binary blob store.
    pub blob_dir: String,
    /// URL clients should connect to (host rewritten into minted tokens).
    pub ysweet_public_url: String,
    /// Shared private key, identical to what `y-sweet serve --auth` is given.
    pub ysweet_auth_key: String,
    /// "oidc" for a real IdP, "mock" for the in-process test issuer.
    pub oidc_mode: OidcMode,
    pub oidc_issuer: Option<String>,
    pub oidc_client_id: Option<String>,
    pub oidc_client_secret: Option<String>,
    pub oidc_redirect_url: Option<String>,
    pub allowed_login_redirects: Vec<String>,
    pub cors_allowed_origins: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OidcMode {
    Oidc,
    Mock,
}

fn opt(name: &str) -> Option<String> {
    env::var(name).ok().filter(|s| !s.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let oidc_mode = match opt("OIDC_MODE").as_deref() {
            Some("mock") => OidcMode::Mock,
            _ => OidcMode::Oidc,
        };
        if oidc_mode == OidcMode::Mock && opt("ALLOW_MOCK_OIDC").as_deref() != Some("1") {
            panic!("OIDC_MODE=mock requires ALLOW_MOCK_OIDC=1 and must not be used in production");
        }
        Config {
            database_url: opt("DATABASE_URL")
                .unwrap_or_else(|| "sqlite://instasync.db?mode=rwc".to_string()),
            bind_addr: opt("BIND_ADDR").unwrap_or_else(|| "127.0.0.1:8081".to_string()),
            public_base_url: opt("PUBLIC_BASE_URL")
                .unwrap_or_else(|| "http://127.0.0.1:8081".to_string()),
            ysweet_url: opt("YSWEET_URL").unwrap_or_else(|| "http://127.0.0.1:8080".to_string()),
            blob_dir: opt("BLOB_DIR").unwrap_or_else(|| "./blobs".to_string()),
            ysweet_public_url: opt("YSWEET_PUBLIC_URL")
                .or_else(|| opt("YSWEET_URL"))
                .unwrap_or_else(|| "http://127.0.0.1:8080".to_string()),
            ysweet_auth_key: opt("YSWEET_AUTH_KEY").unwrap_or_default(),
            oidc_mode,
            oidc_issuer: opt("OIDC_ISSUER"),
            oidc_client_id: opt("OIDC_CLIENT_ID"),
            oidc_client_secret: opt("OIDC_CLIENT_SECRET"),
            oidc_redirect_url: opt("OIDC_REDIRECT_URL"),
            allowed_login_redirects: list("ALLOWED_LOGIN_REDIRECTS"),
            cors_allowed_origins: list("CORS_ALLOWED_ORIGINS"),
        }
    }

    /// Where the IdP should redirect back to after login.
    pub fn redirect_url(&self) -> String {
        self.oidc_redirect_url
            .clone()
            .unwrap_or_else(|| format!("{}/auth/callback", self.public_base_url.trim_end_matches('/')))
    }
}

fn list(name: &str) -> Vec<String> {
    opt(name)
        .map(|s| s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}
