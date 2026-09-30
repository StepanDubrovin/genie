//! Images from the project's files in the team chat: `!image[docs/shot.png]` in
//! a message shows the file inline (`GET /api/images?path=docs/shot.png&team=…`).
//!
//! The path is relative to the team's worktree when the team has one (what its
//! agents see), otherwise to the project's repository. Served: PNG, JPEG, GIF
//! and WebP — by the file's bytes, not its name — up to 10 MiB; nothing outside
//! the root and nothing reached through a symlink.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::Deserialize;

use super::ctx::Ctx;
use super::{ApiError, ApiResult};
use crate::state::{App, AppError};

/// The largest image served.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// The longest path accepted (the chat leaves longer references as text).
const MAX_PATH_CHARS: usize = 400;

pub fn routes() -> Router<Arc<App>> {
    Router::new().route("/images", get(image))
}

/// PNG, JPEG, GIF or WebP by magic bytes (the only formats shown inline).
pub fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// A plain relative path (`docs/shot.png`), or None: no `.`, `..` or empty
/// segments, no leading `/`, backslash, NUL or `:` (so no URL scheme or drive).
pub fn relative_image_path(input: &str) -> Option<&str> {
    let value = input.trim();
    let plain = !value.is_empty()
        && value.chars().count() <= MAX_PATH_CHARS
        && !value.contains(['\\', '\0', ':'])
        && value.split('/').all(|p| !p.is_empty() && p != "." && p != "..");
    plain.then_some(value)
}

/// An image under `root`, with its type; the error's status says what is wrong
/// (400 a bad path or a symlink, 404 no such file, 413 too large, 415 not an image).
pub fn read_image(root: &Path, input: &str) -> Result<(Vec<u8>, &'static str), ApiError> {
    let rel = relative_image_path(input).ok_or_else(|| ApiError::bad(format!("invalid image path: {input}")))?;
    let not_found = || ApiError::new(StatusCode::NOT_FOUND, "image not found");
    let mut file = root.canonicalize().map_err(|_| not_found())?;
    // Component by component, so a link anywhere on the way — even one that
    // stays inside the root — is refused rather than followed.
    for part in rel.split('/') {
        file.push(part);
        let meta = std::fs::symlink_metadata(&file).map_err(|_| not_found())?;
        if meta.file_type().is_symlink() {
            return Err(ApiError::bad("refusing to serve an image through a symlink"));
        }
    }
    let too_large = || ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, format!("the image is larger than {} MiB", MAX_IMAGE_BYTES >> 20));
    let meta = std::fs::metadata(&file).map_err(|_| not_found())?;
    if !meta.is_file() {
        return Err(not_found());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&file).and_then(|f| f.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)).map_err(|_| not_found())?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(too_large());
    }
    let mime = image_mime(&bytes)
        .ok_or_else(|| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "only PNG, JPEG, GIF and WebP images are shown"))?;
    Ok((bytes, mime))
}

#[derive(Deserialize)]
struct ImageQuery {
    path: Option<String>,
    /// The team whose chat shows the image: its worktree is the root.
    team: Option<String>,
}

async fn image(State(app): State<Arc<App>>, ctx: Ctx, Query(q): Query<ImageQuery>) -> ApiResult<Response> {
    let access = ctx.access(&app, None).await?;
    let path = q.path.unwrap_or_default();
    if relative_image_path(&path).is_none() {
        return Err(ApiError::bad(format!("invalid image path: {path}")));
    }
    let (slug, team) = (access.project.clone(), q.team.filter(|t| !t.trim().is_empty()));
    let root = app
        .blocking(move |app| {
            if let Some(id) = team
                && let Some(w) = app.with_tracker(&slug, |t| t.bus().get(&id))?.worktree
            {
                return Ok(Some(PathBuf::from(w.path)));
            }
            Ok(app.with_server(|db| db.project(&slug))?.repo.map(PathBuf::from))
        })
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "the project has no repository to show images from"))?;
    let (bytes, mime) = tokio::task::spawn_blocking(move || read_image(&root, &path))
        .await
        .map_err(|e| ApiError::from(AppError::Internal(e.to_string())))??;
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline"));
    // The file changes while the team works on it.
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok((h, Bytes::from(bytes)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_relative_paths_are_images() {
        for ok in ["docs/shot.png", "shot.png", " a/b/c.webp ", "имя/файл.png"] {
            assert!(relative_image_path(ok).is_some(), "{ok}");
        }
        for bad in [
            "",
            " ",
            "../x.png",
            "a/../x.png",
            "./x.png",
            "/etc/passwd",
            "a\\b.png",
            "a\0b.png",
            "https://x/y.png",
            "C:x.png",
            "a//b.png",
            "a/",
        ] {
            assert!(relative_image_path(bad).is_none(), "{bad:?}");
        }
        assert!(relative_image_path(&"a".repeat(MAX_PATH_CHARS + 1)).is_none());
    }

    #[test]
    fn the_type_comes_from_the_bytes() {
        assert_eq!(image_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0]), Some("image/png"));
        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a....."), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF\x1a\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
    }
}
