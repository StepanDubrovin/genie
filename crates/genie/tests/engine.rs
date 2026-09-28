//! The automation engine's event intake: a rule applies to events from its creation on.

use std::path::PathBuf;

use genie::config::Config;
use genie::state::App;
use genie_core::{Actor, CreateInput, Role};
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
