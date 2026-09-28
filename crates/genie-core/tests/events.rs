//! Event journal: every change has exactly one event, written in the same
//! transaction; subscribers resume from a cursor that never moves back.

use genie_core::*;

fn orch() -> Actor {
    Actor::new("orchestrator", Role::Orchestrator)
}

fn fresh() -> (tempfile::TempDir, Tracker) {
    let dir = tempfile::tempdir().unwrap();
    let t = Tracker::init(dir.path().join(".genie"), None, None).unwrap();
    (dir, t)
}

fn kinds(t: &Tracker, after: i64) -> Vec<String> {
    t.events_after(after, 1000).unwrap().into_iter().map(|e| e.kind).collect()
}

#[test]
fn every_change_appends_one_event() {
    let (_d, t) = fresh();
    let a = orch();
    t.create(&a, CreateInput { title: "x".into(), description: Some("d".into()), acceptance: vec!["c".into()], ..Default::default() })
        .unwrap();
    t.update(&a, "G-1", UpdateInput { plan: Some("p".into()), ..Default::default() }).unwrap();
    t.set_status(&a, "G-1", Status::Ready, StatusOptions::default()).unwrap();
    t.comment(&a, "G-1", "hi", CommentKind::Note).unwrap();
    t.check(&a, "G-1", 1, true).unwrap();
    t.add_artifact(&a, "G-1", ArtifactInput { kind: None, source: ArtifactSource::Content(b"x".to_vec()), name: None, note: None })
        .unwrap();
    t.block(&a, "G-1", "waiting").unwrap();
    t.unblock(&a, "G-1").unwrap();
    t.assign_team(&a, "G-1", Some("G-1"), None, None).unwrap();
    assert_eq!(
        kinds(&t, 0),
        vec![
            events::TASK_CREATED,
            events::TASK_UPDATED,
            events::TASK_STATUS_CHANGED,
            events::TASK_COMMENTED,
            events::TASK_CRITERION_CHECKED,
            events::TASK_ARTIFACT_ADDED,
            events::TASK_BLOCKED,
            events::TASK_UNBLOCKED,
            events::TASK_TEAM_ASSIGNED,
        ]
    );
    let all = t.events_after(0, 1000).unwrap();
    assert!(all.iter().all(|e| e.subject.as_deref() == Some("G-1") && e.actor == "orchestrator" && e.actor_role == "orchestrator"));
    assert_eq!(all[2].payload["from"], "draft");
    assert_eq!(all[2].payload["to"], "ready");
    assert_eq!(all[1].payload["fields"], serde_json::json!(["plan"]));
}

#[test]
fn owner_actions_also_record_the_mail_they_send() {
    let (_d, t) = fresh();
    let me = Actor::new("me", Role::Human);
    t.create(&me, CreateInput { title: "From the web".into(), status: Some(Status::Inbox), ..Default::default() }).unwrap();
    assert_eq!(kinds(&t, 0), vec![events::TASK_CREATED, events::MAIL_SENT]);
    let mail = &t.events_after(0, 10).unwrap()[1];
    assert_eq!(mail.payload["recipient"], "orchestrator");
    assert_eq!(mail.actor_role, "human");
}

#[test]
fn a_rejected_change_leaves_no_event() {
    let (_d, t) = fresh();
    let a = orch();
    t.create(&a, CreateInput { title: "x".into(), ..Default::default() }).unwrap();
    let before = t.last_event_id().unwrap();
    // Fails after earlier fields were already written inside the transaction.
    let bad = UpdateInput { plan: Some("p".into()), add_deps: vec!["G-99".into()], ..Default::default() };
    assert!(t.update(&a, "G-1", bad).is_err());
    assert_eq!(t.last_event_id().unwrap(), before);
    assert_eq!(t.get("G-1").unwrap().plan, "", "the partial update was rolled back too");
    assert!(t.set_status(&a, "G-1", Status::Ready, StatusOptions::default()).is_err());
    assert_eq!(t.last_event_id().unwrap(), before);
}

#[test]
fn cursors_resume_after_reopen_and_never_move_back() {
    let (_d, t) = fresh();
    let a = orch();
    for i in 0..5 {
        t.create(&a, CreateInput { title: format!("t{i}"), ..Default::default() }).unwrap();
    }
    assert_eq!(t.event_cursor("sse").unwrap(), 0);
    let first = t.events_after(t.event_cursor("sse").unwrap(), 3).unwrap();
    assert_eq!(first.len(), 3);
    t.ack_events("sse", first.last().unwrap().id).unwrap();
    t.ack_events("sse", first[0].id).unwrap(); // late duplicate ack
    let dir = t.dir().to_path_buf();
    drop(t);

    let t = Tracker::open(&dir).unwrap();
    let rest = t.events_after(t.event_cursor("sse").unwrap(), 100).unwrap();
    assert_eq!(rest.iter().map(|e| e.subject.clone().unwrap()).collect::<Vec<_>>(), vec!["G-4", "G-5"]);
    assert_eq!(t.event_cursor("other").unwrap(), 0, "cursors are per subscriber");
}
