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
