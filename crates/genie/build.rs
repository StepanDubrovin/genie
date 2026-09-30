//! Builds the web UI into the binary: the files of `web/dist` (`npm run
//! build:web`) become `$OUT_DIR/web_assets.rs`, source maps left out.
//!
//! - `GENIE_WEB_DIST=<dir>` (relative to the repository root) names the build
//!   and requires it: a release build fails rather than ship without the UI,
//!   and setting the variable re-runs this script.
//! - Otherwise `web/dist` is taken when it is there. A build made before it was
//!   is not redone when it appears (Cargo would re-run the script on every build
//!   while a watched path is missing); such a binary serves `web/dist` of its
//!   working directory, or the directory given with `--web`.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=GENIE_WEB_DIST");
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest.join("../..");
    let explicit = std::env::var_os("GENIE_WEB_DIST").filter(|d| !d.is_empty()).map(|d| root.join(d));
    let dist = explicit.clone().unwrap_or_else(|| root.join("web/dist"));
    let mut files = Vec::new();
    if dist.join("index.html").is_file() {
        println!("cargo:rerun-if-changed={}", dist.display());
        let dist = dist.canonicalize().expect("web/dist");
        collect(&dist, &dist, &mut files);
        files.sort();
    } else if let Some(d) = explicit {
        panic!("GENIE_WEB_DIST={}: no index.html there; build the web UI first (npm run build:web)", d.display());
    }
    let mut out = String::from(
        "/// The files of the built web UI: path under `web/dist` and contents.\npub static WEB_ASSETS: &[(&str, &[u8])] = &[\n",
    );
    for (rel, file) in &files {
        writeln!(out, "    ({rel:?}, include_bytes!({:?})),", file.display().to_string()).unwrap();
    }
    out.push_str("];\n");
    let target = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("web_assets.rs");
    if std::fs::read_to_string(&target).ok().as_deref() != Some(out.as_str()) {
        std::fs::write(&target, out).expect("web_assets.rs");
    }
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).expect("web/dist").filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let path = e.path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if path.extension().is_none_or(|x| x != "map") {
            let rel =
                path.strip_prefix(root).expect("under web/dist").components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>();
            out.push((rel.join("/"), path));
        }
    }
}
