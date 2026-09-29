use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum NicelError {
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Serialization error: {0}")]
    Json(#[from] serde_json::Error),
    /// #355: a write/delete through a generic, non-dedicated path was
    /// refused because it targeted a reserved key range (currently only
    /// `script_trust.*` — see `db::operations::SCRIPT_TRUST_KEY_PREFIX`).
    #[error("{0}")]
    Rejected(String),
}

// Tauri commands must return serializable errors
impl Serialize for NicelError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, NicelError>;
