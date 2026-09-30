//! The Rust core opens a tracker written by the TypeScript CLI in place: same
//! schema, same JSON columns, same ids.
//!
//! `fixtures/ts-tracker.db` is the `.genie/genie.db` the TypeScript CLI wrote
//! (schema 3) in a directory named `shop`, with `GENIE_ROLE=human GENIE_MEMBER=anna`:
//!
//! ```text
//! genie init --prefix TS
//! genie new Export -d "CSV export" -a downloads --label web --draft
//! genie comment TS-1 "please hurry"
//! genie status TS-1 needs_owner -m "Keep ZPR1?"
//! ```
//!
//! It is kept as it was written, so trackers of the TypeScript era keep opening
//! after the TypeScript CLI is gone.

use std::path::Path;

use genie_core::*;

#[test]
fn opens_a_tracker_written_by_the_typescript_cli() {
    let project = tempfile::tempdir().unwrap();
    let dir = project.path().join(".genie");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts-tracker.db"), dir.join("genie.db")).unwrap();

    let t = Tracker::open(&dir).unwrap();
    assert_eq!(t.meta().unwrap().prefix, "TS");
    let task = t.get("1").unwrap();
    assert_eq!(task.id, "TS-1");
    assert_eq!(task.title, "Export");
    assert_eq!(task.description, "CSV export");
    assert_eq!(task.labels, vec!["web"]);
    assert_eq!(task.acceptance[0].text, "downloads");
    assert_eq!(task.comments[0].kind, CommentKind::Owner);
    assert_eq!((task.comments[0].author.as_str(), task.comments[0].text.as_str()), ("anna", "please hurry"));
    assert_eq!(task.status, Status::NeedsOwner);
    let asked = task.needs_owner.as_ref().unwrap();
    assert_eq!((asked.question.as_str(), asked.previous), ("Keep ZPR1?", Status::Draft));

    // Rust writes on top of the TypeScript data: the sequence continues and events start now.
    let next =
        t.create(&Actor::new("orchestrator", Role::Orchestrator), CreateInput { title: "Next".into(), ..Default::default() }).unwrap();
    assert_eq!(next.id, "TS-2");
    assert_eq!(t.events_after(0, 10).unwrap().len(), 1);
}
