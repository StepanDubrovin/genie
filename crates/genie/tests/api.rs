mod common;

use axum::http::StatusCode;
use common::{Harness, call};
use genie_core::Role;
use genie_core::server_db::ProjectRole;
use serde_json::json;

#[tokio::test]
async fn local_owner_without_users_runs_the_full_task_cycle() {
    let h = Harness::new();
    h.project("shop");
    let r = &h.router;
    let (s, me, _) = call(r, "GET", "/api/auth/me").send().await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(me["mode"], "local");
    assert_eq!(me["project"], "shop");

    let (s, task, _) =
        call(r, "POST", "/api/tasks").json(json!({ "title": "Экспорт", "description": "CSV", "acceptance": ["скачивается"] })).send().await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(task["status"], "inbox", "people submit to the inbox");
    let id = task["id"].as_str().unwrap().to_string();

    let (s, _, _) =
        call(r, "PATCH", &format!("/api/tasks/{id}")).json(json!({ "plan": "1. do", "addDeps": [] , "labels": ["web"] })).send().await;
    assert_eq!(s, StatusCode::OK);
    let (s, t, _) = call(r, "POST", &format!("/api/tasks/{id}/status")).json(json!({ "status": "ready" })).send().await;
    assert_eq!(s, StatusCode::OK, "{t}");
    let (_, t, _) = call(r, "POST", &format!("/api/tasks/{id}/comments")).json(json!({ "text": "срочно" })).send().await;
    assert_eq!(t["comments"][0]["kind"], "owner");
    let (_, t, _) = call(r, "POST", &format!("/api/tasks/{id}/acceptance/1")).json(json!({ "done": true })).send().await;
    assert_eq!(t["acceptance"][0]["done"], true);
    let (s, _, _) = call(r, "POST", &format!("/api/tasks/{id}/artifacts"))
        .json(json!({ "kind": "analysis", "name": "a.md", "text": "# A" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let (_, a, _) = call(r, "GET", &format!("/api/tasks/{id}/artifacts/1")).send().await;
    assert_eq!((a["text"].as_str(), a["kind"].as_str()), (Some("# A"), Some("analysis")));
    let png = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    call(r, "POST", &format!("/api/tasks/{id}/artifacts"))
        .json(json!({ "kind": "other", "name": "shot.png", "contentBase64": png }))
        .send()
        .await;
    let (_, a, _) = call(r, "GET", &format!("/api/tasks/{id}/artifacts/2")).send().await;
    assert_eq!(a["mime"], "image/png");
    let (s, _, _) = call(r, "GET", &format!("/api/tasks/{id}/artifacts/1?raw=1")).send().await;
    assert_eq!(s, StatusCode::UNSUPPORTED_MEDIA_TYPE);

    let (s, parts, _) = call(r, "POST", &format!("/api/tasks/{id}/split"))
        .json(json!({ "children": ["backend", { "title": "ui", "acceptance": ["x"] }] }))
        .send()
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(parts.as_array().unwrap().len(), 2);
    let (_, list, _) = call(r, "GET", "/api/tasks?type=epic").send().await;
    assert_eq!(list[0]["id"], id.as_str());
    let (_, j, _) = call(r, "GET", "/api/journal?after=0&limit=500").send().await;
    assert!(j["events"].as_array().unwrap().len() >= 8);
    let (s, e, _) = call(r, "POST", &format!("/api/tasks/{id}/status")).json(json!({ "status": "nope" })).send().await;
    assert_eq!((s, e["error"].as_str()), (StatusCode::BAD_REQUEST, Some("unknown status nope")));
    let (s, e, _) = call(r, "GET", "/api/tasks/G-99").send().await;
    assert_eq!((s, e["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("task G-99 not found")));
}

#[tokio::test]
async fn writes_need_the_csrf_header_and_hosts_are_checked() {
    let h = Harness::new();
    h.project("shop");
    let (s, e, _) = call(&h.router, "POST", "/api/tasks").no_csrf().json(json!({ "title": "x" })).send().await;
    assert_eq!((s, e["error"].as_str()), (StatusCode::FORBIDDEN, Some("missing X-Genie header")));
    let (s, _, _) = call(&h.router, "GET", "/api/meta").header("host", "evil.example").send().await;
    assert_eq!(s, StatusCode::MISDIRECTED_REQUEST);
    let (s, _, _) = call(&h.router, "GET", "/api/meta").header("host", "localhost:7420").send().await;
    assert_eq!(s, StatusCode::OK);
}

#[tokio::test]
async fn remote_callers_need_a_login_even_without_users() {
    let h = Harness::new();
    h.project("shop");
    let (s, _, _) = call(&h.remote, "GET", "/api/tasks").send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn users_log_in_and_roles_limit_writes() {
    let h = Harness::new();
    h.project("shop");
    h.project("payments");
    let (anna, viewer) = h
        .app
        .with_server(|db| {
            let anna = db.create_user("anna", "Анна", None, Some("password-1"), false)?;
            let v = db.create_user("vic", "", None, Some("password-2"), false)?;
            db.set_membership("shop", anna.id, ProjectRole::Member)?;
            db.set_membership("shop", v.id, ProjectRole::Viewer)?;
            Ok((anna, v))
        })
        .unwrap();
    let r = &h.remote;
    let (s, _, _) = call(r, "GET", "/api/tasks").send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "no more local mode once users exist");
    let (s, _, _) = call(&h.router, "GET", "/api/tasks").send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED, "not even from loopback");

    let (s, _, _) = call(r, "POST", "/api/auth/login").json(json!({ "login": "anna", "password": "nope" })).send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _, cookies) = call(r, "POST", "/api/auth/login").json(json!({ "login": "anna", "password": "password-1" })).send().await;
    assert_eq!(s, StatusCode::OK);
    let session = cookies[0].clone();
    let (_, me, _) = call(r, "GET", "/api/auth/me").cookie(&session).send().await;
    assert_eq!(me["user"]["login"], "anna");
    assert_eq!(me["projects"].as_array().unwrap().len(), 1, "only projects with a membership");
    let (s, t, _) = call(r, "POST", "/api/tasks").cookie(&session).json(json!({ "title": "from anna" })).send().await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(t["history"][0]["actor"], "anna");
    let (s, _, _) = call(r, "GET", "/api/tasks").cookie(&session).header("x-genie-project", "payments").send().await;
    assert_eq!(s, StatusCode::OK, "a hint without access falls back to an accessible project");
    let (s, _, _) = call(r, "POST", "/api/session/project").cookie(&session).json(json!({ "project": "payments" })).send().await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (_, _, vc) = call(r, "POST", "/api/auth/login").json(json!({ "login": "vic", "password": "password-2" })).send().await;
    let (s, _, _) = call(r, "GET", "/api/tasks").cookie(&vc[0]).send().await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = call(r, "POST", "/api/tasks").cookie(&vc[0]).json(json!({ "title": "no" })).send().await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    let (_, _, lc) = call(r, "POST", "/api/auth/logout").cookie(&session).send().await;
    assert!(lc[0].ends_with('='));
    let (s, _, _) = call(r, "GET", "/api/auth/me").cookie(&session).send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let _ = (anna, viewer);
}

#[tokio::test]
async fn agent_tokens_are_bound_to_their_project_and_role() {
    let h = Harness::new();
    h.project("shop");
    h.project("payments");
    let token = h
        .app
        .with_server(|db| db.create_agent_token("shop", Role::Executor, "bender", Some("G-1"), None, chrono::Duration::hours(1)))
        .unwrap();
    let r = &h.remote;
    let (s, t, _) = call(r, "POST", "/api/tasks").bearer(&token).no_csrf().json(json!({ "title": "x" })).send().await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "executors cannot create tasks: {t}");
    let (s, _, _) = call(r, "GET", "/api/tasks").bearer(&token).header("x-genie-project", "payments").send().await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _, _) = call(r, "GET", "/api/tasks").bearer("gna_forged").send().await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let orch = h
        .app
        .with_server(|db| db.create_agent_token("shop", Role::Orchestrator, "orchestrator", None, None, chrono::Duration::hours(1)))
        .unwrap();
    let (s, t, _) = call(r, "POST", "/api/tasks").bearer(&orch).no_csrf().json(json!({ "title": "planned" })).send().await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(t["status"], "draft", "agents create drafts");
    let (s, e, _) = call(r, "POST", "/api/tasks/G-1/status").bearer(&orch).no_csrf().json(json!({ "status": "ready" })).send().await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "the orchestrator is held to the Definition of Ready");
    assert!(e["error"].as_str().unwrap().contains("not ready"));
}

#[tokio::test]
async fn invitations_create_members() {
    let h = Harness::new();
    h.project("shop");
    let r = &h.router;
    let (s, inv, _) = call(r, "POST", "/api/projects/shop/invites").json(json!({ "role": "member" })).send().await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(inv["url"].as_str().unwrap().contains("/invite?token="));
    let (s, _, cookies) = call(&h.remote, "POST", "/api/auth/invite")
        .json(json!({ "token": inv["token"], "login": "pm", "name": "Product", "password": "password-9" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let (_, me, _) = call(&h.remote, "GET", "/api/auth/me").cookie(&cookies[0]).send().await;
    assert_eq!(me["projects"][0]["role"], "member");
}
