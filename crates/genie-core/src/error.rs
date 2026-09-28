use thiserror::Error;

/// Errors of the domain core. Messages are user-facing and mirror the TypeScript
/// tracker word for word, so the CLI, the web UI and agents see the same text.
#[derive(Debug, Error)]
pub enum GenieError {
    /// The actor's role may not perform the action.
    #[error("{0}")]
    Denied(String),
    /// A task, criterion or artifact does not exist.
    #[error("{0}")]
    NotFound(String),
    /// The request breaks a workflow rule or carries invalid input.
    #[error("{0}")]
    Invalid(String),
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

impl GenieError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        GenieError::Invalid(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        GenieError::NotFound(msg.into())
    }
}

pub type Result<T, E = GenieError> = std::result::Result<T, E>;
