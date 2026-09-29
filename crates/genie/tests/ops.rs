//! Operations: a backup of a live server holds everything needed to restore it
//! (databases, the vault, the configuration) and old backups are pruned; the
//! preflight is there for the server's admins only.

mod common;

use axum::http::StatusCode;
use common::{Harness, call};
use genie_core::server_db::ServerDb;
use serde_json::json;

#[tokio::test]
async fn a_backup_holds_the_databases_the_vault_and_the_configuration() {
    let h = Harness::new();
    h.project("shop");
    let data = h.app.data.clone();
    std::fs::write(data.join("config.json"), json!({ "telegram": { "token": "tg-s3cret" } }).to_string()).unwrap();
    std::fs::create_dir_all(data.join("agents")).unwrap();
    std::fs::write(data.join("agents/security-reviewer.md"), "---\nextends: reviewer\n---\n").unwrap();
    let (s, _, _) = call(&h.router, "POST", "/api/tasks").json(json!({ "title": "Экспорт" })).send().await;
    assert_eq!(s, StatusCode::CREATED);

    let backups = tempfile::tempdir().unwrap();
    let report = genie::cli::backup(&data, &h.app.cfg, backups.path()).unwrap();
    let out = std::fs::read_dir(backups.path()).unwrap().flatten().map(|e| e.path()).next().unwrap();
    assert!(report.contains("config/: config.json, agents"), "{report}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&out).unwrap().permissions().mode() & 0o777, 0o700, "the backup holds secrets");
    }
    let server = ServerDb::open(&out.join("server.db")).unwrap();
    assert_eq!(server.projects().unwrap()[0].slug, "shop");
    let tasks: i64 = rusqlite::Connection::open(out.join("projects/shop.db"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(tasks, 1);
    assert!(std::fs::read_to_string(out.join("config/config.json")).unwrap().contains("tg-s3cret"));
    assert!(out.join("config/agents/security-reviewer.md").exists());
    if data.join("vault/.git").exists() {
        let restored = tempfile::tempdir().unwrap();
        let st = std::process::Command::new("git")
            .args(["clone", "-q"])
            .arg(out.join("vault.bundle"))
            .arg(restored.path().join("vault"))
            .status()
            .unwrap();
        assert!(st.success(), "the vault restores from its bundle");
    }

    // Retention: the most recent ones stay, anything else in the directory is left alone.
    for stamp in ["20260101-000000", "20260102-000000", "20260103-000000"] {
        std::fs::create_dir_all(backups.path().join(format!("genie-{stamp}"))).unwrap();
    }
    std::fs::create_dir_all(backups.path().join("genie-notes")).unwrap();
    let removed = genie::cli::prune_backups(backups.path(), 2).unwrap();
    let names =
        |paths: Vec<std::path::PathBuf>| paths.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect::<Vec<_>>();
    assert_eq!(names(removed), ["genie-20260101-000000", "genie-20260102-000000"]);
    let mut left = names(std::fs::read_dir(backups.path()).unwrap().flatten().map(|e| e.path()).collect());
    left.sort();
    assert_eq!(left, ["genie-20260103-000000".to_string(), out.file_name().unwrap().to_string_lossy().into_owned(), "genie-notes".into()]);
}

#[tokio::test]
async fn the_preflight_is_for_server_admins() {
    let h = Harness::new();
    h.project("shop");
    let (s, d, _) = call(&h.router, "GET", "/api/doctor").send().await;
    assert_eq!(s, StatusCode::OK, "the local owner is an admin: {d}");
    let checks = d["checks"].as_array().unwrap();
    assert!(checks.iter().any(|c| c["area"] == "projects" && c["level"] == "ok"), "{d}");
    assert!(checks.iter().any(|c| c["area"] == "web" && c["level"] == "fail"), "the harness serves no web UI: {d}");

    let vic = h.app.with_server(|db| db.create_user("vic", "", None, Some("password-2"), false)).unwrap();
    h.app.with_server(|db| db.set_membership("shop", vic.id, genie_core::server_db::ProjectRole::Admin)).unwrap();
    let (_, _, cookies) = call(&h.remote, "POST", "/api/auth/login").json(json!({ "login": "vic", "password": "password-2" })).send().await;
    let (s, _, _) = call(&h.remote, "GET", "/api/doctor").cookie(&cookies[0]).send().await;
    assert_eq!(s, StatusCode::FORBIDDEN, "a project admin is not a server admin");
}
