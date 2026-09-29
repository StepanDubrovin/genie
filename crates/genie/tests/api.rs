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
    assert_eq!(s, StatusCode::FORBIDDEN, "executors cannot create loose tasks: {t}");
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

#[tokio::test]
async fn team_members_act_only_on_their_task_its_subtasks_and_epic_notes() {
    use genie_core::team::{NewMember, NewTeam};
    use genie_core::{Actor, CreateInput, TaskType};
    let h = Harness::new();
    h.project("shop");
    h.app
        .with_tracker("shop", |t| {
            let o = Actor::new("orchestrator", Role::Orchestrator);
            t.create(&o, CreateInput { title: "Epic".into(), task_type: Some(TaskType::Epic), ..Default::default() })?; // G-1
            t.create(&o, CreateInput { title: "Mine".into(), parent: Some("G-1".into()), ..Default::default() })?; // G-2
            t.create(&o, CreateInput { title: "Other".into(), ..Default::default() })?; // G-3
            t.create(&o, CreateInput { title: "Sub".into(), parent: Some("G-2".into()), ..Default::default() })?; // G-4
            t.bus().create(
                "orchestrator",
                "orchestrator",
                NewTeam {
                    id: "G-2".into(),
                    task: "G-2".into(),
                    cwd: "/tmp".into(),
                    members: vec![NewMember { name: "sherlock".into(), role: "analyst".into(), ..Default::default() }],
                    ..Default::default()
                },
            )?;
            Ok(())
        })
        .unwrap();
    let token = h
        .app
        .with_server(|db| db.create_agent_token("shop", Role::Analyst, "sherlock", Some("G-2"), None, chrono::Duration::hours(1)))
        .unwrap();
    let r = &h.remote;
    let token = &token;
    let send = |m: &'static str, uri: String, body: serde_json::Value| async move {
        call(r, m, &uri).bearer(token).no_csrf().json(body).send().await.0
    };
    assert_eq!(send("PATCH", "/api/tasks/G-2".into(), json!({ "plan": "p" })).await, StatusCode::OK);
    assert_eq!(send("PATCH", "/api/tasks/G-4".into(), json!({ "plan": "p" })).await, StatusCode::OK, "subtasks are in scope");
    assert_eq!(
        send("POST", "/api/tasks/G-1/comments".into(), json!({ "text": "shared finding" })).await,
        StatusCode::CREATED,
        "notes on the epic"
    );
    assert_eq!(send("PATCH", "/api/tasks/G-1".into(), json!({ "plan": "p" })).await, StatusCode::FORBIDDEN, "but not edits of the epic");
    assert_eq!(send("POST", "/api/tasks/G-3/comments".into(), json!({ "text": "x" })).await, StatusCode::FORBIDDEN);
    assert_eq!(send("POST", "/api/tasks/G-3/status".into(), json!({ "status": "refining" })).await, StatusCode::FORBIDDEN);
    assert_eq!(send("POST", "/api/tasks".into(), json!({ "title": "loose" })).await, StatusCode::FORBIDDEN);
    assert_eq!(send("POST", "/api/tasks".into(), json!({ "title": "piece", "parent": "G-2" })).await, StatusCode::CREATED);
}

#[tokio::test]
async fn in_an_assisted_project_people_close_tasks_and_teams_get_the_default_integration() {
    let h = Harness::new();
    h.project("shop");
    let r = &h.router;
    for title in ["first", "second", "third"] {
        let (s, _, _) = call(r, "POST", "/api/tasks").json(json!({ "title": title })).send().await;
        assert_eq!(s, StatusCode::CREATED);
    }
    let (s, p, _) = call(r, "PATCH", "/api/projects/shop")
        .json(json!({ "name": "Магазин", "autonomy": "assisted", "integration": "the owner reviews the branch and merges it" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::OK, "{p}");
    assert_eq!((p["name"].as_str(), p["autonomy"].as_str()), (Some("Магазин"), Some("assisted")));
    let orch = h
        .app
        .with_server(|db| db.create_agent_token("shop", Role::Orchestrator, "orchestrator", None, None, chrono::Duration::hours(1)))
        .unwrap();
    let close = |id: &str| format!("/api/tasks/{id}/status");
    let (s, e, _) = call(&h.remote, "POST", &close("G-1")).bearer(&orch).no_csrf().json(json!({ "status": "cancelled" })).send().await;
    assert_eq!(s, StatusCode::CONFLICT, "{e}");
    assert!(e["error"].as_str().unwrap().contains("needs_owner"), "the refusal says what to do instead: {e}");
    let (s, _, _) = call(r, "POST", &close("G-1")).json(json!({ "status": "cancelled" })).send().await;
    assert_eq!(s, StatusCode::OK, "a person closes it");
    call(r, "PATCH", "/api/projects/shop").json(json!({ "autonomy": "autonomous" })).send().await;
    let (s, _, _) = call(&h.remote, "POST", &close("G-2")).bearer(&orch).no_csrf().json(json!({ "status": "cancelled" })).send().await;
    assert_eq!(s, StatusCode::OK, "an autonomous orchestrator closes tasks itself");

    // A team gets the project's way of integrating results.
    call(r, "PATCH", "/api/tasks/G-3").json(json!({ "description": "Do it", "acceptance": ["it works"] })).send().await;
    let (s, t, _) = call(r, "POST", &close("G-3")).json(json!({ "status": "ready" })).send().await;
    assert_eq!(s, StatusCode::OK, "{t}");
    let (s, team, _) = call(r, "POST", "/api/teams").json(json!({ "task": "G-3", "template": "pair" })).send().await;
    assert_eq!(s, StatusCode::CREATED, "{team}");
    let (_, t, _) = call(r, "GET", "/api/tasks/G-3").send().await;
    assert_eq!(t["mergeStrategy"], "the owner reviews the branch and merges it");
}

#[tokio::test]
async fn a_person_is_responsible_for_a_task_and_mentions_reach_people() {
    let h = Harness::new();
    h.project("shop");
    let (anna, boris, carol) = h
        .app
        .with_server(|db| {
            let anna = db.create_user("anna", "Анна", None, Some("password-1"), false)?;
            let boris = db.create_user("boris", "Борис", None, Some("password-2"), false)?;
            let carol = db.create_user("carol", "", None, Some("password-3"), false)?;
            db.set_membership("shop", anna.id, ProjectRole::Member)?;
            db.set_membership("shop", boris.id, ProjectRole::Member)?;
            Ok((anna.id, boris.id, carol.id))
        })
        .unwrap();
    let r = &h.remote;
    let (_, _, cookies) = call(r, "POST", "/api/auth/login").json(json!({ "login": "anna", "password": "password-1" })).send().await;
    let session = cookies[0].clone();
    let (s, t, _) = call(r, "POST", "/api/tasks").cookie(&session).json(json!({ "title": "Экспорт" })).send().await;
    assert_eq!(s, StatusCode::CREATED);
    let id = t["id"].as_str().unwrap().to_string();
    let task = format!("/api/tasks/{id}");
    let notes = |user: i64| h.app.with_server(|db| db.notifications(user, false, 20)).unwrap();

    let (s, e, _) = call(r, "PATCH", &task).cookie(&session).json(json!({ "assignee": "@carol" })).send().await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{e}");
    assert!(e["error"].as_str().unwrap().contains("not a member"), "{e}");
    let (s, t, _) = call(r, "PATCH", &task).cookie(&session).json(json!({ "assignee": "@Boris" })).send().await;
    assert_eq!(s, StatusCode::OK, "{t}");
    assert_eq!(t["assignee"], "boris");
    assert!(notes(boris).iter().any(|n| n.kind == "assigned" && n.title.contains(&id)), "{:#?}", notes(boris));
    let (_, list, _) = call(r, "GET", "/api/tasks").cookie(&session).send().await;
    assert_eq!(list[0]["assignee"], "boris", "lists show the person responsible");
    call(r, "PATCH", &task).cookie(&session).json(json!({ "assignee": "boris" })).send().await;
    assert_eq!(notes(boris).iter().filter(|n| n.kind == "assigned").count(), 1, "the same person is not told twice");

    // Mentions reach the project's people: not the one who writes, not outsiders.
    let (s, _, _) = call(r, "POST", &format!("{task}/comments"))
        .cookie(&session)
        .json(json!({ "text": "@boris глянь, пожалуйста (и @anna, и @carol)." }))
        .send()
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(notes(boris).iter().any(|n| n.kind == "mention" && n.body.contains("глянь")), "{:#?}", notes(boris));
    assert!(notes(anna).is_empty(), "no note to oneself");
    assert!(notes(carol).is_empty(), "outsiders are not reached");
    // Agents reach people the same way.
    let orch = h
        .app
        .with_server(|db| db.create_agent_token("shop", Role::Orchestrator, "orchestrator", None, None, chrono::Duration::hours(1)))
        .unwrap();
    let (s, _, _) = call(&h.remote, "POST", &format!("{task}/comments"))
        .bearer(&orch)
        .no_csrf()
        .json(json!({ "text": "@anna нужен формат" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(notes(anna).iter().any(|n| n.kind == "mention" && n.body.starts_with("orchestrator: @anna")), "{:#?}", notes(anna));

    // A question to people goes to the person responsible and the author.
    let (s, e, _) = call(&h.remote, "POST", &format!("{task}/status"))
        .bearer(&orch)
        .no_csrf()
        .json(json!({ "status": "needs_owner", "note": "CSV или XLSX?" }))
        .send()
        .await;
    assert_eq!(s, StatusCode::OK, "{e}");
    genie::engine::tick(&h.app).unwrap();
    for who in [boris, anna] {
        assert!(notes(who).iter().any(|n| n.kind == "needs_owner"), "{:#?}", notes(who));
    }

    let (_, t, _) = call(r, "PATCH", &task).cookie(&session).json(json!({ "assignee": null })).send().await;
    assert!(t.get("assignee").is_none(), "cleared: {t}");
}

#[tokio::test]
async fn a_project_is_checked_before_anything_is_created() {
    let h = Harness::new();
    let r = &h.router;
    let (s, e, _) = call(r, "POST", "/api/projects").json(json!({ "slug": "../evil" })).send().await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");
    let (s, e, _) = call(r, "POST", "/api/projects").json(json!({ "slug": "shop", "repo": "/nonexistent/repo" })).send().await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");
    assert!(e["error"].as_str().unwrap().contains("/nonexistent/repo"), "{e}");
    assert!(!h.app.data.join("projects/shop").exists(), "a refused project leaves nothing behind");
    assert!(!h.app.data.join("evil").exists() && !h.app.data.join("projects/../evil").exists());
    let (s, p, _) = call(r, "POST", "/api/projects").json(json!({ "slug": "Shop", "name": "Магазин" })).send().await;
    assert_eq!(s, StatusCode::CREATED, "{p}");
    assert_eq!(p["slug"], "shop");
    assert!(h.app.data.join("projects/shop").is_dir(), "the tracker lives under the lowercase slug");
    let (s, e, _) = call(r, "POST", "/api/projects").json(json!({ "slug": "shop" })).send().await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{e}");
}

/// `!image[docs/shot.png]` in the team chat: a raster file of the project's
/// repository — or of the team's worktree — served inline, and nothing else.
#[tokio::test]
async fn images_come_from_the_repository_or_the_teams_worktree_and_nowhere_else() {
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f,
        0x15, 0xc4, 0x89,
    ];
    let h = Harness::new();
    let repo = h.dir.path().join("shop-repo");
    let write = |rel: &str, bytes: &[u8]| {
        let file = repo.join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    };
    write("docs/shot.png", PNG);
    write("docs/mislabeled.txt", PNG);
    write("docs/vector.svg", b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
    write("docs/big.png", &[PNG, &vec![0u8; 11 * 1024 * 1024]].concat());
    std::fs::create_dir_all(repo.join("docs/dir.png")).unwrap();
    let outside = h.dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.png"), PNG).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.png"), repo.join("docs/linked.png")).unwrap();
    std::os::unix::fs::symlink(repo.join("docs/shot.png"), repo.join("docs/alias.png")).unwrap();
    std::os::unix::fs::symlink(&outside, repo.join("out")).unwrap();
    let git = |args: &[&str]| {
        let out = std::process::Command::new("git").arg("-C").arg(&repo).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    };
    git(&["init", "-q", "-b", "main"]);
    git(&["add", "docs/shot.png"]);
    git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    h.app.create_project("shop", "Магазин", Some(&repo.to_string_lossy()), None, None).unwrap();
    let r = &h.router;
    let get = |uri: String| async move { call(r, "GET", &uri).send_raw().await };

    let (s, headers, bytes) = get("/api/images?path=docs%2Fshot.png".into()).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["content-disposition"], "inline");
    assert_eq!(bytes, PNG);
    let (s, headers, _) = get("/api/images?path=docs%2Fmislabeled.txt".into()).await;
    assert_eq!((s, headers["content-type"].to_str().unwrap()), (StatusCode::OK, "image/png"), "the type comes from the bytes");

    for (path, status) in [
        ("..%2Fescape.png", StatusCode::BAD_REQUEST),
        ("%2Fetc%2Fpasswd", StatusCode::BAD_REQUEST),
        ("a%5Cb.png", StatusCode::BAD_REQUEST),
        ("a%00b.png", StatusCode::BAD_REQUEST),
        ("", StatusCode::BAD_REQUEST),
        ("https%3A%2F%2Fexample.com%2Fx.png", StatusCode::BAD_REQUEST),
        ("docs%2Flinked.png", StatusCode::BAD_REQUEST),
        ("docs%2Falias.png", StatusCode::BAD_REQUEST),
        ("out%2Fsecret.png", StatusCode::BAD_REQUEST),
        ("docs%2Fmissing.png", StatusCode::NOT_FOUND),
        ("docs%2Fdir.png", StatusCode::NOT_FOUND),
        ("docs%2Fvector.svg", StatusCode::UNSUPPORTED_MEDIA_TYPE),
        ("docs%2Fbig.png", StatusCode::PAYLOAD_TOO_LARGE),
    ] {
        assert_eq!(get(format!("/api/images?path={path}")).await.0, status, "{path}");
    }
    assert_eq!(get("/api/images".into()).await.0, StatusCode::BAD_REQUEST);

    // A file the team made in its worktree shows in its chat, not in the project's.
    call(r, "POST", "/api/tasks").json(json!({ "title": "Screenshots" })).send().await;
    call(r, "POST", "/api/tasks/G-1/status").json(json!({ "status": "ready" })).send().await;
    let (s, team, _) = call(r, "POST", "/api/teams").json(json!({ "task": "G-1", "template": "pair" })).send().await;
    assert_eq!(s, StatusCode::CREATED, "{team}");
    let (id, worktree) = (team["id"].as_str().unwrap(), team["worktree"]["path"].as_str().unwrap());
    std::fs::create_dir_all(std::path::Path::new(worktree).join("shots")).unwrap();
    std::fs::write(std::path::Path::new(worktree).join("shots/new.png"), PNG).unwrap();
    assert_eq!(get(format!("/api/images?path=shots%2Fnew.png&team={id}")).await.0, StatusCode::OK);
    assert_eq!(get("/api/images?path=shots%2Fnew.png".into()).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        get(format!("/api/images?path=docs%2Fshot.png&team={id}")).await.0,
        StatusCode::OK,
        "committed files are in the worktree too"
    );

    // A project without a repository has no files to show.
    h.project("notes");
    let (s, _, _) = call(r, "GET", "/api/images?path=docs%2Fshot.png").header("x-genie-project", "notes").send_raw().await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // Agents of another project do not read this one's files.
    let agent =
        h.app.with_server(|db| db.create_agent_token("notes", Role::Documenter, "ada", None, None, chrono::Duration::hours(1))).unwrap();
    let (s, _, _) = call(&h.remote, "GET", "/api/images?path=docs%2Fshot.png&project=shop").bearer(&agent).no_csrf().send_raw().await;
    assert_ne!(s, StatusCode::OK);
}
