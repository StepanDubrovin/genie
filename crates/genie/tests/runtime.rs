//! The whole agent loop over real HTTP and processes: inbox → orchestrator →
//! team → review → done, with a scripted agent standing in for the model.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use genie::config::Config;
use genie::state::App;
use genie_core::{Actor, CreateInput, Role, Status};

struct Live {
    _dir: tempfile::TempDir,
    app: Arc<App>,
    _stop: tokio::sync::oneshot::Sender<()>,
}

async fn live(env: &[(&str, &str)]) -> Live {
    let dir = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut cfg = Config::load(dir.path()).unwrap();
    cfg.port = port;
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-agent.sh");
    cfg.runtime.command = vec![vec!["bash".into(), script.to_string_lossy().into_owned()], vec!["{message}".into()]];
    cfg.runtime.turn_timeout_secs = 60;
    cfg.runtime.env.insert("GENIE_BIN".into(), env!("CARGO_BIN_EXE_genie").into());
    cfg.runtime.env.insert("GENIE_MARK".into(), dir.path().join("failed-once").to_string_lossy().into_owned());
    for (k, v) in env {
        cfg.runtime.env.insert(k.to_string(), v.to_string());
    }
    let app = App::open(dir.path(), cfg, PathBuf::from("/nonexistent")).unwrap();
    app.create_project("shop", "Shop", None, None, None).unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let a = app.clone();
    tokio::spawn(async move {
        genie::serve_on(a, listener, async {
            let _ = rx.await;
        })
        .await
        .unwrap();
    });
    genie::runtime::start(&app);
    Live { _dir: dir, app, _stop: tx }
}

async fn wait_for(app: &Arc<App>, what: &str, timeout: Duration, mut done: impl FnMut(&App) -> bool) {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if done(app) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let turns = app.with_server(|db| db.turns("shop", None, 50)).unwrap();
    let log: Vec<String> =
        turns.iter().map(|t| format!("{} {} {:?}\n{}", t.agent, t.status, t.error, t.log.clone().unwrap_or_default())).collect();
    panic!("timed out waiting for {what}\n{}", log.join("\n---\n"));
}

fn status(app: &App) -> Status {
    app.with_tracker("shop", |t| Ok(t.get("G-1")?.status)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inbox_to_done_through_the_orchestrator_and_a_team() {
    let l = live(&[]).await;
    l.app
        .with_tracker("shop", |t| {
            t.create(
                &Actor::new("anna", Role::Human),
                CreateInput { title: "CSV export".into(), status: Some(Status::Inbox), ..Default::default() },
            )
        })
        .unwrap();
    l.app.wake_runtime.notify_one();
    wait_for(&l.app, "task done", Duration::from_secs(90), |app| status(app) == Status::Done).await;
    let (task, team) = l.app.with_tracker("shop", |t| Ok((t.get("G-1")?, t.bus().get("G-1")?))).unwrap();
    assert!(task.acceptance.iter().all(|a| a.done));
    assert!(task.artifacts.iter().any(|a| a.name == "review.md"));
    assert_eq!(task.merge_strategy, "merge by orchestrator");
    // The closed task's team is stopped by the server, not by an agent.
    wait_for(&l.app, "team stopped", Duration::from_secs(10), |app| {
        app.with_tracker("shop", |t| Ok(t.bus().get("G-1")?.state == "stopped")).unwrap()
    })
    .await;
    assert_eq!(team.template.as_deref(), Some("pair"));
    let turns = l.app.with_server(|db| db.turns("shop", None, 100)).unwrap();
    assert!(turns.iter().all(|t| t.status == "succeeded" || t.status == "skipped"), "{turns:#?}");
    let unread: i64 = l
        .app
        .with_tracker("shop", |t| {
            Ok(t.conn()
                .query_row("SELECT COUNT(*) FROM mail WHERE delivered_at IS NULL AND recipient <> 'orchestrator'", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(unread, 0, "every message was delivered exactly through a successful turn");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_crashed_turn_gives_its_mail_back_and_is_retried() {
    let l = live(&[("FAIL_ONCE", "1")]).await;
    l.app
        .with_tracker("shop", |t| {
            t.create(
                &Actor::new("anna", Role::Human),
                CreateInput { title: "CSV export".into(), status: Some(Status::Inbox), ..Default::default() },
            )
        })
        .unwrap();
    l.app.wake_runtime.notify_one();
    wait_for(&l.app, "task done after a retry", Duration::from_secs(120), |app| status(app) == Status::Done).await;
    let turns = l.app.with_server(|db| db.turns("shop", None, 100)).unwrap();
    let failed: Vec<_> = turns.iter().filter(|t| t.status == "failed").collect();
    assert_eq!(failed.len(), 1, "exactly the simulated crash failed");
    assert!(failed[0].log.as_deref().unwrap_or_default().contains("simulated crash"));
    let retried = turns.iter().filter(|t| t.agent == failed[0].agent && t.status == "succeeded").count();
    assert!(retried >= 1, "the same agent ran again and succeeded");
}

#[test]
fn recovery_stops_only_verified_stray_agent_processes() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config::load(dir.path()).unwrap();
    cfg.runtime.enabled = false;
    let app = App::open(dir.path(), cfg, PathBuf::from("/nonexistent")).unwrap();
    app.create_project("shop", "", None, None, None).unwrap();
    let spawn = |env: &[(&str, &str)]| std::process::Command::new("sleep").arg("30").envs(env.iter().copied()).spawn().unwrap();
    let mut stray = spawn(&[("GENIE_PROJECT", "shop"), ("GENIE_AGENT_NAME", "bender")]);
    let mut other = spawn(&[]);
    app.with_server(|db| {
        let a = db.start_turn("shop", "G-1/bender", Some("G-1"), Some("bender"), None)?;
        db.set_turn_pid(a, stray.id())?;
        let b = db.start_turn("shop", "G-1/yoda", Some("G-1"), Some("yoda"), None)?;
        db.set_turn_pid(b, other.id())
    })
    .unwrap();
    genie::runtime::recover(&app).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    assert!(stray.try_wait().unwrap().is_some(), "the stray agent was stopped");
    assert!(other.try_wait().unwrap().is_none(), "a process that is not that agent is left alone");
    other.kill().unwrap();
}
