//! The Rust core opens a tracker written by the TypeScript CLI in place: same
//! schema, same JSON columns, same ids. Skipped when Node or the TypeScript
//! sources are not available.

use std::path::{Path, PathBuf};
use std::process::Command;

use genie_core::*;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap()
}

fn node_genie(cwd: &Path, args: &[&str]) -> bool {
    let cli = repo_root().join("src/cli/genie.ts");
    Command::new("node")
        .arg(&cli)
        .args(args)
        .current_dir(cwd)
        .env_remove("GENIE_DIR")
        .env("GENIE_ROLE", "human")
        .output()
        .map(|o| {
            if !o.status.success() {
                eprintln!("genie {args:?}: {}", String::from_utf8_lossy(&o.stderr));
            }
            o.status.success()
        })
        .unwrap_or(false)
}

#[test]
fn opens_a_tracker_written_by_the_typescript_cli() {
    let project = tempfile::tempdir().unwrap();
    if !repo_root().join("src/cli/genie.ts").exists() || !node_genie(project.path(), &["init", "--prefix", "TS"]) {
        eprintln!("skipped: node or the TypeScript CLI is not available");
        return;
    }
    assert!(node_genie(project.path(), &["new", "Export", "-d", "CSV export", "-a", "downloads", "--label", "web", "--draft"]));
    assert!(node_genie(project.path(), &["comment", "TS-1", "please hurry"]));
    assert!(node_genie(project.path(), &["status", "TS-1", "needs_owner", "-m", "Keep ZPR1?"]));

    let t = Tracker::open(project.path().join(".genie")).unwrap();
    assert_eq!(t.meta().unwrap().prefix, "TS");
    let task = t.get("1").unwrap();
    assert_eq!(task.id, "TS-1");
    assert_eq!(task.labels, vec!["web"]);
    assert_eq!(task.acceptance[0].text, "downloads");
    assert_eq!(task.comments[0].kind, CommentKind::Owner);
    assert_eq!(task.needs_owner.as_ref().unwrap().previous, Status::Draft);

    // Rust writes on top of the TypeScript data: the sequence continues and events start now.
    let next =
        t.create(&Actor::new("orchestrator", Role::Orchestrator), CreateInput { title: "Next".into(), ..Default::default() }).unwrap();
    assert_eq!(next.id, "TS-2");
    assert_eq!(t.events_after(0, 10).unwrap().len(), 1);
}
