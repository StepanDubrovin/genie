//! A person's own secrets for their agents (`user_secrets` of the server
//! database): the LiteLLM key agents started on their behalf use.
//!
//! Unlike sessions and tokens these must be read back, so they are sealed with
//! ChaCha20-Poly1305 under a key kept next to the database (`secrets.key`, 0600)
//! and not copied by `genie backup`: a leaked database or backup does not leak
//! them. Lose the key and the secrets read as unset — people enter them again.

use std::path::{Path, PathBuf};

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::db::now;
use crate::error::{GenieError, Result};
use crate::server_db::ServerDb;

/// The LiteLLM key of a person (`LITELLM_API_KEY` of their agents).
pub const LITELLM: &str = "litellm";

pub const SECRETS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS user_secrets (
  user INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  updated TEXT NOT NULL,
  PRIMARY KEY (user, name)
);
"#;

/// What may be shown about a secret: never the value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    /// The last characters of the value (`…a1b2`).
    pub hint: String,
    pub updated: String,
    /// The value cannot be read back (the server's key changed): enter it again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}

/// The key file of a database at `db_path`.
pub fn key_path(db_path: &Path) -> PathBuf {
    db_path.with_file_name("secrets.key")
}

fn load_key(path: &Path, create: bool) -> Result<Option<[u8; 32]>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            let raw = hex::decode(text.trim()).map_err(|_| GenieError::invalid(format!("{}: not a hex key", path.display())))?;
            let key: [u8; 32] = raw.try_into().map_err(|_| GenieError::invalid(format!("{}: the key must be 32 bytes", path.display())))?;
            Ok(Some(key))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && create => {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).expect("OS random source");
            write_private(path, &hex::encode(key))?;
            Ok(Some(key))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(text.as_bytes())?;
    Ok(())
}

fn seal(key: &[u8; 32], name: &str, value: &str) -> Result<String> {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).expect("OS random source");
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    // The name is bound in: a sealed value cannot be moved to another secret.
    let payload = chacha20poly1305::aead::Payload { msg: value.as_bytes(), aad: name.as_bytes() };
    let sealed = cipher.encrypt(Nonce::from_slice(&nonce), payload).map_err(|_| GenieError::invalid("cannot seal the secret"))?;
    Ok(format!("{}{}", hex::encode(nonce), hex::encode(sealed)))
}

fn unseal(key: &[u8; 32], name: &str, sealed: &str) -> Option<String> {
    let raw = hex::decode(sealed).ok()?;
    if raw.len() < 12 {
        return None;
    }
    let (nonce, body) = raw.split_at(12);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let plain = cipher.decrypt(Nonce::from_slice(nonce), chacha20poly1305::aead::Payload { msg: body, aad: name.as_bytes() }).ok()?;
    String::from_utf8(plain).ok()
}

fn hint(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 12 {
        return String::new();
    }
    format!("…{}", chars[chars.len() - 4..].iter().collect::<String>())
}

impl ServerDb {
    /// Set a person's secret (a blank value removes it).
    pub fn set_user_secret(&self, user: i64, name: &str, value: &str) -> Result<()> {
        let value = value.trim();
        if value.is_empty() {
            return self.delete_user_secret(user, name);
        }
        if value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(GenieError::invalid("the secret must be one line of at most 4096 characters"));
        }
        let key = load_key(&self.secrets_key, true)?.expect("created");
        self.conn().execute(
            "INSERT INTO user_secrets(user, name, sealed, hint, updated) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(user, name) DO UPDATE SET sealed = excluded.sealed, hint = excluded.hint, updated = excluded.updated",
            params![user, name, seal(&key, name, value)?, hint(value), now()],
        )?;
        Ok(())
    }

    pub fn delete_user_secret(&self, user: i64, name: &str) -> Result<()> {
        self.conn().execute("DELETE FROM user_secrets WHERE user = ?1 AND name = ?2", params![user, name])?;
        Ok(())
    }

    /// A person's secret in the clear, for the agents started on their behalf;
    /// `None` when it is unset or cannot be read back.
    pub fn user_secret(&self, user: i64, name: &str) -> Result<Option<String>> {
        let sealed: Option<String> = self
            .conn()
            .query_row("SELECT sealed FROM user_secrets WHERE user = ?1 AND name = ?2", params![user, name], |r| r.get(0))
            .optional()?;
        let Some(sealed) = sealed else { return Ok(None) };
        let Some(key) = load_key(&self.secrets_key, false)? else { return Ok(None) };
        Ok(unseal(&key, name, &sealed))
    }

    /// What can be shown about a person's secret.
    pub fn user_secret_info(&self, user: i64, name: &str) -> Result<Option<SecretInfo>> {
        let row: Option<(String, String, String)> = self
            .conn()
            .query_row("SELECT sealed, hint, updated FROM user_secrets WHERE user = ?1 AND name = ?2", params![user, name], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .optional()?;
        let Some((sealed, hint, updated)) = row else { return Ok(None) };
        let readable = load_key(&self.secrets_key, false)?.is_some_and(|k| unseal(&k, name, &sealed).is_some());
        Ok(Some(SecretInfo { name: name.to_string(), hint, updated, unreadable: !readable }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_sealed_and_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(&dir.path().join("server.db")).unwrap();
        let u = db.create_user("ann", "Ann", None, None, false).unwrap();
        assert_eq!(db.user_secret(u.id, LITELLM).unwrap(), None);
        db.set_user_secret(u.id, LITELLM, "  sk-litellm-0123456789  ").unwrap();
        assert_eq!(db.user_secret(u.id, LITELLM).unwrap().as_deref(), Some("sk-litellm-0123456789"));
        let info = db.user_secret_info(u.id, LITELLM).unwrap().unwrap();
        assert_eq!(info.hint, "…6789");
        assert!(!info.unreadable);
        // Stored sealed, never in the clear.
        let sealed: String = db.conn().query_row("SELECT sealed FROM user_secrets", [], |r| r.get(0)).unwrap();
        assert!(!sealed.contains("sk-litellm"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("secrets.key")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // A blank value removes it.
        db.set_user_secret(u.id, LITELLM, " ").unwrap();
        assert_eq!(db.user_secret_info(u.id, LITELLM).unwrap(), None);
    }

    #[test]
    fn a_lost_key_makes_secrets_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(&dir.path().join("server.db")).unwrap();
        let u = db.create_user("ann", "Ann", None, None, false).unwrap();
        db.set_user_secret(u.id, LITELLM, "sk-litellm-0123456789").unwrap();
        std::fs::remove_file(dir.path().join("secrets.key")).unwrap();
        assert_eq!(db.user_secret(u.id, LITELLM).unwrap(), None);
        assert!(db.user_secret_info(u.id, LITELLM).unwrap().unwrap().unreadable);
        // Entering it again makes a new key.
        db.set_user_secret(u.id, LITELLM, "sk-litellm-abcdefghij").unwrap();
        assert_eq!(db.user_secret(u.id, LITELLM).unwrap().as_deref(), Some("sk-litellm-abcdefghij"));
    }
}
