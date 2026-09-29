mod common;

use axum::http::StatusCode;
use common::{Harness, call};
use genie_core::Role;
use genie_core::vault::{Policy, Publish, Section};
use serde_json::json;

#[tokio::test]
async fn people_write_agents_propose_owners_approve() {
    let h = Harness::new();
    h.project("shop");
    let r = &h.router;
    let page = "---\ntitle: Экспорт\ntype: guide\nstatus: current\n---\n# Экспорт\n\nЗаказы выгружаются в CSV.\n";
    let (s, saved, _) =
        call(r, "POST", "/api/docs/page").json(json!({ "path": "shop/export.md", "content": page, "mode": "create" })).send().await;
    assert_eq!(s, StatusCode::CREATED, "{saved}");
    let hash = saved["page"]["contentHash"].as_str().unwrap().to_string();
    let (s, _, _) =
        call(r, "POST", "/api/docs/page").json(json!({ "path": "shop/export.md", "content": page, "mode": "create" })).send().await;
    assert_eq!(s, StatusCode::CONFLICT);

    let (_, tree, _) = call(r, "GET", "/api/docs/tree").send().await;
    assert!(tree["pages"].as_array().unwrap().iter().any(|p| p["path"] == "shop/changelog.md"), "every project space has a changelog");
    let (_, found, _) = call(r, "GET", "/api/docs/search?q=выгружаются").send().await;
    assert_eq!(found["results"][0]["path"], "shop/export.md");

    let agent =
        h.app.with_server(|db| db.create_agent_token("shop", Role::Documenter, "tolkien", None, None, chrono::Duration::hours(1))).unwrap();
    let edited = page.replace("CSV.", "CSV и XLSX.");
    let (s, prop, _) = call(&h.remote, "POST", "/api/docs/page")
        .bearer(&agent)
        .no_csrf()
        .json(json!({ "path": "shop/export.md", "content": edited, "note": "XLSX", "task": "G-1" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::ACCEPTED, "agents propose by default: {prop}");
    let id = prop["proposal"].as_i64().unwrap();
    let (_, listed, _) = call(r, "GET", "/api/docs/proposals").send().await;
    assert_eq!(listed[0]["id"], id);
    let (_, one, _) = call(r, "GET", &format!("/api/docs/proposals/{id}")).send().await;
    assert!(one["current"].as_str().unwrap().contains("CSV."));
    let (s, _, _) = call(&h.remote, "POST", &format!("/api/docs/proposals/{id}/approve")).bearer(&agent).no_csrf().send().await;
    assert_eq!(s, StatusCode::FORBIDDEN, "agents do not approve");
    let (s, done, _) = call(r, "POST", &format!("/api/docs/proposals/{id}/approve")).send().await;
    assert_eq!(s, StatusCode::OK, "{done}");
    let (_, read, _) = call(r, "GET", "/api/docs/page?path=shop/export.md").send().await;
    assert!(read["content"].as_str().unwrap().contains("XLSX"));

    // A stale edit is a conflict, not a silent overwrite.
    let (s, e, _) =
        call(r, "POST", "/api/docs/page").json(json!({ "path": "shop/export.md", "content": page, "baseHash": hash })).send().await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");

    let events = h.app.with_tracker("shop", |t| t.events_after(0, 100)).unwrap();
    let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
    assert!(kinds.contains(&"doc.changed") && kinds.contains(&"doc.proposal"), "{kinds:?}");
}

#[tokio::test]
async fn locked_sections_and_changelog_release() {
    let h = Harness::new();
    h.project("shop");
    h.app
        .with_vault(|v| {
            v.config.spaces.get_mut("shop").unwrap().sections.insert(
                "processes".into(),
                Section { policy: Some(Policy { humans: Publish::Direct, agents: Publish::Locked }), owners: vec![] },
            );
            v.save_config()
        })
        .unwrap();
    let agent =
        h.app.with_server(|db| db.create_agent_token("shop", Role::Documenter, "tolkien", None, None, chrono::Duration::hours(1))).unwrap();
    let (s, _, _) = call(&h.remote, "POST", "/api/docs/page")
        .bearer(&agent)
        .no_csrf()
        .json(json!({ "path": "shop/processes/release.md", "content": "# R\n\nx" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    genie::knowledge::changelog_add(&h.app, "shop", "added", "Экспорт в CSV", Some("G-1")).unwrap();
    let (_, cl, _) = call(&h.router, "GET", "/api/docs/changelog").send().await;
    assert!(cl["content"].as_str().unwrap().contains("### Добавлено\n\n- Экспорт в CSV (G-1)"), "{cl}");
    let (s, rel, _) = call(&h.router, "POST", "/api/docs/changelog/release").json(json!({ "version": "1.0.0" })).send().await;
    assert_eq!(s, StatusCode::OK, "{rel}");
    assert!(rel["notes"].as_str().unwrap().contains("Экспорт в CSV"));
    let events = h.app.with_tracker("shop", |t| t.events_after(0, 100)).unwrap();
    assert!(events.iter().any(|e| e.kind == "release.published"));
}

#[tokio::test]
async fn a_task_in_review_names_the_pages_its_changes_may_have_made_stale() {
    let h = common::Harness::new();
    let repo = h.dir.path().join("shop-repo");
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/pricing.abap"), "CLASS zcl_pricing DEFINITION.\nENDCLASS.\n").unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let out = std::process::Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    h.app.create_project("shop", "Магазин", Some(&repo.to_string_lossy()), None, None).unwrap();
    let r = &h.router;
    call(r, "POST", "/api/tasks").json(json!({ "title": "Скидки в возвратах", "description": "d", "acceptance": ["a"] })).send().await;
    call(r, "POST", "/api/tasks/G-1/status").json(json!({ "status": "ready" })).send().await;
    let (s, team, _) = call(r, "POST", "/api/teams").json(json!({ "task": "G-1", "template": "pair" })).send().await;
    assert_eq!(s, StatusCode::CREATED, "{team}");
    let worktree = std::path::PathBuf::from(team["worktree"]["path"].as_str().unwrap());
    std::fs::write(worktree.join("src/pricing.abap"), "CLASS zcl_pricing DEFINITION.\n* returns\nENDCLASS.\n").unwrap();
    for (path, content) in [
        ("shop/ceny.md", "---\ntitle: Цены\npaths: [src/**]\n---\n# Цены\n\nКак считаются цены.\n"),
        ("shop/vozvraty.md", "---\ntitle: Возвраты\nrelated: [G-1]\n---\n# Возвраты\n\nПравила возвратов.\n"),
        ("shop/sklad.md", "---\ntitle: Склад\npaths: [docs/**]\n---\n# Склад\n\nВолны.\n"),
    ] {
        let (s, e, _) = call(r, "POST", "/api/docs/page").json(json!({ "path": path, "content": content })).send().await;
        assert!(s.is_success(), "{s}: {e}");
    }
    let (s, impact, _) = call(r, "GET", "/api/tasks/G-1/docs-impact").send().await;
    assert_eq!(s, StatusCode::OK, "{impact}");
    assert_eq!(impact["changedPathsAvailable"], true, "{impact}");
    assert_eq!(impact["changedPaths"], json!(["src/pricing.abap"]));
    let pages: Vec<&str> = impact["candidates"].as_array().unwrap().iter().map(|c| c["path"].as_str().unwrap()).collect();
    assert_eq!(pages, ["shop/ceny.md", "shop/vozvraty.md"], "changed paths first, then pages naming the task: {impact}");
    assert_eq!(impact["candidates"][0]["reasons"][0], json!({ "kind": "changed-path", "path": "src/pricing.abap", "pattern": "src/**" }));
    assert_eq!(impact["candidates"][1]["reasons"][0], json!({ "kind": "related", "id": "G-1" }));
    assert_eq!(impact["applicable"], false, "the hint is meant for review and done");
}
