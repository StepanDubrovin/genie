//! The web UI: built into the binary (`build.rs` takes `web/dist`), or served
//! from a directory — the one given with `genie serve --web <dir>` (a fresh
//! `npm run build:web` without rebuilding genie), or `web/dist` of the working
//! directory when the binary was built without the UI. A `--web` directory
//! without a built UI (a unit file from before the UI was built in) gives way
//! to the built-in one.

use std::path::{Path, PathBuf};

use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

/// Where the web UI comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebUi {
    /// A built UI in a directory.
    Dir(PathBuf),
    /// The UI built into the binary.
    BuiltIn,
    /// None: why, and what to do.
    Missing(String),
}

/// The web UI to serve: a built one in `--web <dir>`, else the one built in,
/// else `web/dist` here.
pub fn resolve(web: Option<&Path>) -> WebUi {
    resolve_with(web, WEB_ASSETS)
}

fn resolve_with(web: Option<&Path>, built_in: &[(&str, &[u8])]) -> WebUi {
    match web {
        Some(dir) if dir.join("index.html").is_file() => WebUi::Dir(dir.to_path_buf()),
        _ if !built_in.is_empty() => WebUi::BuiltIn,
        Some(dir) => WebUi::Missing(format!(
            "no web UI in {}: run `npm install && npm run build:web` in the genie repository and serve its web/dist",
            dir.display()
        )),
        None if Path::new("web/dist/index.html").is_file() => WebUi::Dir(PathBuf::from("web/dist")),
        None => WebUi::Missing(
            "this genie was built without the web UI: run `npm install && npm run build:web` before `cargo build`, or serve a built one with --web <dir>"
                .into(),
        ),
    }
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, ext)| ext) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// A file of a built-in UI for a request path. Client-side routes (`/board`,
/// `/team/G-7`) get `index.html`; a missing file under `assets/` is a 404, so a
/// page of an older build does not load HTML as a script.
pub fn respond(assets: &'static [(&'static str, &'static [u8])], method: &Method, path: &str) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = path.trim_start_matches('/');
    let file = match assets.iter().find(|(p, _)| *p == path) {
        Some(f) => f,
        None if path.starts_with("assets/") => return StatusCode::NOT_FOUND.into_response(),
        None => match assets.iter().find(|(p, _)| *p == "index.html") {
            Some(f) => f,
            None => return StatusCode::NOT_FOUND.into_response(),
        },
    };
    // Vite names assets by their contents: they never change under one name.
    let cache = if file.0.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
    let headers = [
        (header::CONTENT_TYPE, HeaderValue::from_static(content_type(file.0))),
        (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
        (header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
    ];
    (headers, file.1).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    static ASSETS: &[(&str, &[u8])] =
        &[("assets/app-1a2b.js", b"console.log(1)"), ("assets/app-1a2b.css", b"body{}"), ("index.html", b"<div id=\"root\"></div>")];

    fn get(path: &str) -> Response {
        respond(ASSETS, &Method::GET, path)
    }

    #[test]
    fn files_by_path_routes_get_the_page_and_missing_assets_are_missing() {
        let js = get("/assets/app-1a2b.js");
        assert_eq!(js.status(), StatusCode::OK);
        assert_eq!(js.headers()[header::CONTENT_TYPE], "text/javascript; charset=utf-8");
        assert_eq!(js.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable");
        assert_eq!(get("/assets/app-1a2b.css").headers()[header::CONTENT_TYPE], "text/css; charset=utf-8");
        for route in ["/", "/board", "/team/G-7", "/index.html"] {
            let page = get(route);
            assert_eq!(page.status(), StatusCode::OK, "{route}");
            assert_eq!(page.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
            assert_eq!(page.headers()[header::CACHE_CONTROL], "no-cache", "the page is revalidated: it names the current assets");
        }
        assert_eq!(get("/assets/app-0000.js").status(), StatusCode::NOT_FOUND);
        assert_eq!(respond(ASSETS, &Method::POST, "/board").status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(respond(&[], &Method::GET, "/").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_built_directory_given_wins_and_an_empty_one_gives_way_to_the_built_in_ui() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(resolve_with(Some(dir.path()), ASSETS), WebUi::BuiltIn);
        assert!(matches!(resolve_with(Some(dir.path()), &[]), WebUi::Missing(m) if m.contains("no web UI in")));
        std::fs::write(dir.path().join("index.html"), "<div id=\"root\"></div>").unwrap();
        assert_eq!(resolve_with(Some(dir.path()), ASSETS), WebUi::Dir(dir.path().to_path_buf()));
        assert_eq!(resolve_with(None, ASSETS), WebUi::BuiltIn);
    }
}
