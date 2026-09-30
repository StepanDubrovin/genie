//! The automation engine's event intake: a rule applies to events from its creation on.

use std::path::PathBuf;

use genie::config::Config;
use genie::state::App;
use genie_core::{Actor, CreateInput, Role, Status, StatusOptions};
use serde_json::json;

fn create_task(app: &App, title: &str) -> String {
    app.with_tracker("shop", |t| t.create(&Actor::new("anna", Role::Human), CreateInput { title: title.into(), ..Default::default() }))
        .unwrap()
        .id
}

#[test]
fn a_rule_sees_events_after_its_creation_only() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::open(dir.path(), Config::load(dir.path()).unwrap(), PathBuf::from("/nonexistent")).unwrap();
    app.create_project("shop", "Shop", None, None, None).unwrap();
    // An event the engine has not read yet when the rule appears: history, not a trigger.
    create_task(&app, "before the rule");
    std::thread::sleep(std::time::Duration::from_millis(5));
    let spec = json!({ "name": "Comment new tasks", "on": { "event": "task.created" }, "steps": [{ "id": "c", "task.comment": { "text": "seen" } }] });
    let rule = app.with_server(|db| db.create_automation("shop", &spec, "anna")).unwrap();
    // Created right after the rule, before any engine pass: a trigger (this used to race when the
    // engine loaded its rules before reading the journal).
    let second = create_task(&app, "after the rule");
    genie::engine::tick(&app).unwrap();
    let runs = app.with_server(|db| db.runs("shop", Some(rule.id), 10)).unwrap();
    assert_eq!(runs.len(), 1, "{runs:?}");
    let event = app
        .with_tracker("shop", |t| t.events_after(0, 50))
        .unwrap()
        .into_iter()
        .find(|e| e.kind == "task.created" && e.subject.as_deref() == Some(second.as_str()))
        .unwrap();
    assert_eq!(runs[0].trigger_key, format!("event:shop:{}", event.id), "the run is for the task created after the rule");
}

#[test]
fn the_auto_ready_playbook_moves_a_task_once_nothing_holds_it() {
    let dir = tempfile::tempdir().unwrap();
    let app = App::open(dir.path(), Config::load(dir.path()).unwrap(), PathBuf::from("/nonexistent")).unwrap();
    app.create_project("shop", "Shop", None, None, None).unwrap();
    let (_, _, spec) = genie::engine::playbooks().into_iter().find(|(id, ..)| *id == "auto-ready").unwrap();
    assert!(genie_core::automation::validate(&spec).is_empty());
    app.with_server(|db| db.create_automation("shop", &spec, "anna")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));

    let anna = Actor::new("anna", Role::Human);
    let status = |id: &str| app.with_tracker("shop", |t| t.get(id)).unwrap().status;
    let dep = create_task(&app, "API of the warehouse");
    let ready = |title: &str, deps: Vec<String>| {
        app.with_tracker("shop", |t| {
            t.create(
                &anna,
                CreateInput {
                    title: title.into(),
                    description: Some("Export the orders".into()),
                    acceptance: vec!["A CSV file downloads".into()],
                    deps,
                    ..Default::default()
                },
            )
        })
        .unwrap()
        .id
    };
    let waiting = ready("Export orders", vec![dep.clone()]);
    let blocked = ready("Export returns", vec![]);
    app.with_tracker("shop", |t| t.block(&anna, &blocked, "no access to the warehouse API")).unwrap();
    genie::engine::tick(&app).unwrap();
    // The dependency has no description or criteria; the others wait for it or are blocked.
    assert_eq!(status(&dep), Status::Draft);
    assert_eq!(status(&waiting), Status::Draft, "an open dependency holds it");
    assert_eq!(status(&blocked), Status::Draft, "a block holds it");

    app.with_tracker("shop", |t| t.unblock(&anna, &blocked)).unwrap();
    app.with_tracker("shop", |t| t.set_status(&anna, &dep, Status::Done, StatusOptions { note: None, force: true })).unwrap();
    genie::engine::tick(&app).unwrap();
    assert_eq!(status(&blocked), Status::Ready, "unblocked, nothing else holds it");
    assert_eq!(status(&waiting), Status::Ready, "its dependency is done");
}
