//! Hosts in practice: the checks an administrator runs, and the SSH transport (with a
//! stand-in for `ssh` that runs the remote command locally, so nothing but genie's own
//! wiring is under test).

mod common;

use common::fakehost;
use common::githost::{sh, try_sh, upstream};
use common::*;
use genie::git::check;
use genie_core::repos::NewRepo;
use serde_json::json;

fn joined(lines: &[check::Line]) -> String {
    lines.iter().map(|l| format!("{} {}", l.level, l.text)).collect::<Vec<_>>().join("\n")
}

async fn with_repo(kind: &'static str) -> (Harness, fakehost::FakeHost, std::path::PathBuf) {
    let h = Harness::new();
    let hosts = h.dir.path().join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    let up = upstream(&hosts, "acme/api", &[("README.md", "api\n")]);
    let fake = fakehost::spawn(kind, "secret").await;
    let cfg = json!({ "hosts": { "h": {
        "kind": kind, "url": fake.url, "token": "secret",
        "clone_urls": { "https": format!("file://{}/{{remote}}.git", hosts.display()) }
    } } });
    std::fs::write(h.dir.path().join("git.json"), cfg.to_string()).unwrap();
    h.project("shop");
    let app = h.app.clone();
    tokio::task::spawn_blocking(move || {
        genie::git::service::add_repo(
            &app,
            "shop",
            NewRepo { name: "api".into(), host: "h".into(), remote: "acme/api".into(), mount: Some(".".into()), ..Default::default() },
        )
        .unwrap()
    })
    .await
    .unwrap();
    (h, fake, up)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_check_says_what_the_token_can_do_and_what_is_left_unprotected() {
    for kind in ["github", "gitlab"] {
        let (h, fake, up) = with_repo(kind).await;
        let lines = check::host(&h.app, "h").await;
        assert!(!check::failed(&lines), "{kind}: {}", joined(&lines));
        assert!(joined(&lines).contains("genie-bot"), "{}", joined(&lines));

        let lines = check::repo(&h.app, "shop", "api", false).await;
        let text = joined(&lines);
        assert!(!check::failed(&lines), "{kind}: {text}");
        assert!(
            text.contains("the token can push") && text.contains("main is protected on the host") && text.contains("fetched"),
            "{text}"
        );

        // An unprotected default branch is worth a warning; a probe proves the push and cleans up.
        fake.lock().protected.clear();
        let lines = check::repo(&h.app, "shop", "api", true).await;
        let text = joined(&lines);
        assert!(text.contains("warn main is not protected"), "{text}");
        assert!(text.contains("can push a branch") && text.contains("deleted again"), "{text}");
        let (_, branches) = try_sh(&up, &[], &["for-each-ref", "--format=%(refname)", "refs/heads"]);
        assert_eq!(branches.trim(), "refs/heads/main", "the probe branch is gone");

        // A wrong token and a repository the host does not know.
        let cfg = std::fs::read_to_string(h.dir.path().join("git.json")).unwrap().replace("\"secret\"", "\"wrong\"");
        std::fs::write(h.dir.path().join("git.json"), cfg).unwrap();
        let lines = check::host(&h.app, "h").await;
        assert!(check::failed(&lines) && joined(&lines).contains("refused the token"), "{}", joined(&lines));
        let lines = check::repo(&h.app, "shop", "api", false).await;
        assert!(check::failed(&lines), "{}", joined(&lines));
    }
    let h = Harness::new();
    assert!(check::failed(&check::host(&h.app, "nope").await));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ssh_transport_uses_the_key_and_the_known_hosts_file() {
    let h = Harness::new();
    let dir = h.dir.path();
    let hosts = dir.join("hosts");
    std::fs::create_dir_all(&hosts).unwrap();
    let up = upstream(&hosts, "acme/api", &[("README.md", "api\n")]);
    let (key, known, log, ssh) = (dir.join("id_test"), dir.join("known_hosts"), dir.join("ssh.log"), dir.join("fake-ssh"));
    std::fs::write(&key, "not a real key").unwrap();
    std::fs::write(&known, "").unwrap();
    // The stand-in: log the call, run the remote command here (git-upload-pack → git upload-pack).
    std::fs::write(
        &ssh,
        format!(
            "#!/usr/bin/env bash\necho \"$@\" >> {}\ncmd=\"${{@: -1}}\"\ncase \"$cmd\" in git-*) cmd=\"git ${{cmd#git-}}\";; esac\nexec sh -c \"$cmd\"\n",
            log.display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let cfg = json!({ "hosts": { "s": {
        "kind": "plain", "url": "https://git.example.test", "transport": "ssh",
        "ssh_key": key, "known_hosts": known, "ssh_command": ssh,
        "clone_urls": { "ssh": format!("ssh://git@git.example.test{}/{{remote}}.git", hosts.display()) }
    } } });
    std::fs::write(dir.join("git.json"), cfg.to_string()).unwrap();
    h.project("shop");
    let app = h.app.clone();
    let (repo, warning) = tokio::task::spawn_blocking(move || {
        genie::git::service::add_repo(
            &app,
            "shop",
            NewRepo { name: "api".into(), host: "s".into(), remote: "acme/api".into(), ..Default::default() },
        )
        .unwrap()
    })
    .await
    .unwrap();
    assert!(warning.is_none(), "{warning:?}");
    assert_eq!(repo.default_branch, "main", "fetched over the ssh stand-in");

    // A probe pushes over ssh as well.
    let lines = check::repo(&h.app, "shop", "api", true).await;
    assert!(!check::failed(&lines), "{}", joined(&lines));
    assert!(joined(&lines).contains("can push a branch"), "{}", joined(&lines));
    let calls = std::fs::read_to_string(&log).unwrap();
    assert!(calls.contains("-i") && calls.contains(&key.to_string_lossy().to_string()), "{calls}");
    assert!(
        calls.contains("UserKnownHostsFile=") && calls.contains("StrictHostKeyChecking=yes") && calls.contains("IdentitiesOnly=yes"),
        "{calls}"
    );
    assert!(calls.contains("BatchMode=yes") && calls.contains("git@git.example.test"), "{calls}");
    assert_eq!(sh(&up, &["rev-parse", "--abbrev-ref", "HEAD"]), "main");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn doctor_reports_hosts_and_repositories_that_cannot_work() {
    let h = Harness::new();
    h.project("shop");
    std::fs::write(
        h.dir.path().join("git.json"),
        r#"{"hosts": {
            "good": {"kind": "plain", "url": "https://git.example.test"},
            "nosecret": {"kind": "gitlab", "url": "https://git.example.test", "token": "${GENIE_TEST_DOCTOR_UNSET}"},
            "typo": {"kind": "gitlab", "url": "https://x.io", "tokn": "x"}
        }}"#,
    )
    .unwrap();
    h.app
        .with_server(|db| {
            db.add_repo(
                "shop",
                NewRepo {
                    name: "lost".into(),
                    host: "gone".into(),
                    remote: "a/b".into(),
                    mount: Some("lost".into()),
                    ..Default::default()
                },
            )?;
            db.add_repo(
                "shop",
                NewRepo {
                    name: "bad".into(),
                    host: "good".into(),
                    remote: "a/c".into(),
                    mount: Some("bad".into()),
                    policy: Some(json!({ "push": "sometimes" })),
                    ..Default::default()
                },
            )?;
            Ok(())
        })
        .unwrap();
    let cfg = genie::config::Config::load(h.dir.path()).unwrap();
    let agents = genie::agent_config::AgentConfig::load(h.dir.path(), &cfg, None);
    let checks = genie::doctor::run(h.dir.path(), &cfg, &agents, None);
    let git: Vec<String> = checks.iter().filter(|c| c.area == "git").map(|c| format!("{:?} {}", c.level, c.text)).collect();
    let all = git.join("\n");
    assert!(all.contains("Fail git.json: host typo"), "{all}");
    assert!(all.contains("Fail host nosecret: secret missing: GENIE_TEST_DOCTOR_UNSET"), "{all}");
    assert!(all.contains("Fail shop: repository lost lives on host gone"), "{all}");
    assert!(all.contains("Fail shop: repository bad: repository bad") || all.contains("Fail shop: repository bad:"), "{all}");
    assert!(all.contains("Ok host good (plain)"), "{all}");
}
