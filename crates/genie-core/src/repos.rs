//! Repositories of a project and the state of a task's delivery in them
//! (`project_repos`, `task_repos` of the server database).
//!
//! This module holds the data and its validation. What a policy means and how a
//! repository is reached lives in the server crate (`genie::git`).

use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use crate::db::now;
use crate::error::{GenieError, Result};
use crate::server_db::ServerDb;

/// A repository attached to a project.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRepo {
    pub project: String,
    /// The alias inside the project (`api`, `web`): it names branches, paths and prompts.
    pub name: String,
    /// A host of `git.json`.
    pub host: String,
    /// The path on the host: `group/subgroup/repo`.
    pub remote: String,
    /// Where the repository sits in the project's workspace (`.` is the root).
    pub mount: String,
    pub default_branch: String,
    /// The most the project allows agents to do: `read` or `write`.
    pub access: String,
    /// The repository's policy (`genie::git::policy`); `{}` means the defaults.
    pub policy: Value,
    pub created: String,
}

impl ProjectRepo {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<ProjectRepo> {
        let policy: String = r.get("policy")?;
        Ok(ProjectRepo {
            project: r.get("project")?,
            name: r.get("name")?,
            host: r.get("host")?,
            remote: r.get("remote")?,
            mount: r.get("mount")?,
            default_branch: r.get("default_branch")?,
            access: r.get("access")?,
            policy: serde_json::from_str(&policy).unwrap_or(Value::Null),
            created: r.get("created")?,
        })
    }
}

/// A task's use of a repository and how its delivery stands.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRepo {
    pub project: String,
    pub task: String,
    pub repo: String,
    /// `read` or `write`.
    pub access: String,
    /// The task's branch in this repository (set when it is first needed).
    pub branch: String,
    /// `pending` → `published` (a branch was pushed) → `merged`; `abandoned` for a request closed unmerged.
    pub state: String,
    pub cr_number: Option<i64>,
    pub cr_url: Option<String>,
    /// `open`, `merged` or `closed`.
    pub cr_state: Option<String>,
    /// `pending`, `passed`, `failed` or `none`.
    pub ci_state: Option<String>,
    pub head_sha: Option<String>,
    /// The host's timestamp of the newest comment already passed on to the task.
    pub seen_at: String,
    pub updated: String,
}

impl TaskRepo {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<TaskRepo> {
        Ok(TaskRepo {
            project: r.get("project")?,
            task: r.get("task")?,
            repo: r.get("repo")?,
            access: r.get("access")?,
            branch: r.get("branch")?,
            state: r.get("state")?,
            cr_number: r.get("cr_number")?,
            cr_url: r.get("cr_url")?,
            cr_state: r.get("cr_state")?,
            ci_state: r.get("ci_state")?,
            head_sha: r.get("head_sha")?,
            seen_at: r.get("seen_at")?,
            updated: r.get("updated")?,
        })
    }
}

/// A new repository of a project.
#[derive(Debug, Clone, Default)]
pub struct NewRepo {
    pub name: String,
    pub host: String,
    pub remote: String,
    pub mount: Option<String>,
    pub default_branch: Option<String>,
    pub access: Option<String>,
    pub policy: Option<Value>,
}

/// Fields of a repository to change (`None` keeps a field).
#[derive(Debug, Clone, Default)]
pub struct RepoPatch {
    pub mount: Option<String>,
    pub default_branch: Option<String>,
    pub access: Option<String>,
    pub policy: Option<Value>,
}

/// Delivery fields to change (`None` keeps a field).
#[derive(Debug, Clone, Default)]
pub struct Delivery {
    pub branch: Option<String>,
    pub state: Option<String>,
    pub cr_number: Option<i64>,
    pub cr_url: Option<String>,
    pub cr_state: Option<String>,
    pub ci_state: Option<String>,
    pub head_sha: Option<String>,
    pub seen_at: Option<String>,
}

/// A repository alias: lowercase letters, digits, dashes and underscores.
pub fn valid_repo_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 40
        && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && !s.starts_with(['-', '_'])
}

/// A mount path: relative, without `..`, without `.git` parts; `.` for the root.
pub fn clean_mount(mount: &str) -> Result<String> {
    let m = mount.trim().trim_matches('/');
    if m.is_empty() || m == "." {
        return Ok(".".into());
    }
    let mut parts = Vec::new();
    for p in m.split('/') {
        let bad = p.is_empty()
            || p == "."
            || p == ".."
            || p.eq_ignore_ascii_case(".git")
            || !p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
        if bad {
            return Err(GenieError::invalid(format!(
                "mount {mount:?}: a relative path of letters, digits, dashes, underscores and dots (no `..`, no `.git`)"
            )));
        }
        parts.push(p);
    }
    Ok(parts.join("/"))
}

/// A path on a host: `group/subgroup/repo` (no `.git` suffix, no `..`).
pub fn clean_remote(remote: &str) -> Result<String> {
    let r = remote.trim().trim_matches('/');
    let r = r.strip_suffix(".git").unwrap_or(r);
    let ok = !r.is_empty()
        && r.split('/').all(|p| {
            !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        });
    if ok { Ok(r.to_string()) } else { Err(GenieError::invalid(format!("remote {remote:?}: a path like group/subgroup/repo"))) }
}

/// Two mounts collide when they are the same or one is inside the other. The root
/// (`.`) may hold the others: a repository at the root has the rest in subdirectories.
pub fn mounts_collide(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    if a == "." || b == "." {
        return false;
    }
    a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn check_access(access: &str) -> Result<()> {
    if matches!(access, "read" | "write") { Ok(()) } else { Err(GenieError::invalid("access must be read or write")) }
}

impl ServerDb {
    pub fn add_repo(&self, project: &str, new: NewRepo) -> Result<ProjectRepo> {
        self.project(project)?;
        let name = new.name.trim().to_lowercase();
        if !valid_repo_name(&name) {
            return Err(GenieError::invalid("repository name: lowercase letters, digits, dashes and underscores"));
        }
        let host = new.host.trim().to_string();
        if host.is_empty() {
            return Err(GenieError::invalid("a repository needs a host"));
        }
        let remote = clean_remote(&new.remote)?;
        let mount = clean_mount(new.mount.as_deref().unwrap_or("."))?;
        let access = new.access.unwrap_or_else(|| "write".into());
        check_access(&access)?;
        if self.repo_opt(project, &name)?.is_some() {
            return Err(GenieError::invalid(format!("project {project} already has a repository {name}")));
        }
        if let Some(other) = self.repos(project)?.iter().find(|r| mounts_collide(&r.mount, &mount)) {
            return Err(GenieError::invalid(format!("mount {mount} collides with the repository {} at {}", other.name, other.mount)));
        }
        let policy = new.policy.unwrap_or_else(|| Value::Object(Default::default()));
        self.conn().execute(
            "INSERT INTO project_repos(project, name, host, remote, mount, default_branch, access, policy, created)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![project, name, host, remote, mount, new.default_branch.unwrap_or_default().trim(), access, policy.to_string(), now()],
        )?;
        self.repo(project, &name)
    }

    pub fn repo_opt(&self, project: &str, name: &str) -> Result<Option<ProjectRepo>> {
        Ok(self
            .conn()
            .query_row("SELECT * FROM project_repos WHERE project = ?1 AND name = ?2", params![project, name], ProjectRepo::from_row)
            .optional()?)
    }

    pub fn repo(&self, project: &str, name: &str) -> Result<ProjectRepo> {
        self.repo_opt(project, name)?.ok_or_else(|| GenieError::not_found(format!("project {project} has no repository {name}")))
    }

    pub fn repos(&self, project: &str) -> Result<Vec<ProjectRepo>> {
        let mut stmt = self.conn().prepare("SELECT * FROM project_repos WHERE project = ?1 ORDER BY mount, name")?;
        Ok(stmt.query_map([project], ProjectRepo::from_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Every repository of every project (mirrors, checks).
    pub fn all_repos(&self) -> Result<Vec<ProjectRepo>> {
        let mut stmt = self.conn().prepare("SELECT * FROM project_repos ORDER BY project, mount, name")?;
        Ok(stmt.query_map([], ProjectRepo::from_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn update_repo(&self, project: &str, name: &str, patch: RepoPatch) -> Result<ProjectRepo> {
        let current = self.repo(project, name)?;
        if let Some(m) = &patch.mount {
            let m = clean_mount(m)?;
            if let Some(other) = self.repos(project)?.iter().find(|r| r.name != name && mounts_collide(&r.mount, &m)) {
                return Err(GenieError::invalid(format!("mount {m} collides with the repository {} at {}", other.name, other.mount)));
            }
            self.conn().execute("UPDATE project_repos SET mount = ?1 WHERE project = ?2 AND name = ?3", params![m, project, name])?;
        }
        if let Some(b) = &patch.default_branch {
            self.conn().execute(
                "UPDATE project_repos SET default_branch = ?1 WHERE project = ?2 AND name = ?3",
                params![b.trim(), project, name],
            )?;
        }
        if let Some(a) = &patch.access {
            check_access(a)?;
            self.conn().execute("UPDATE project_repos SET access = ?1 WHERE project = ?2 AND name = ?3", params![a, project, name])?;
        }
        if let Some(p) = &patch.policy {
            self.conn()
                .execute("UPDATE project_repos SET policy = ?1 WHERE project = ?2 AND name = ?3", params![p.to_string(), project, name])?;
        }
        let _ = current;
        self.repo(project, name)
    }

    pub fn remove_repo(&self, project: &str, name: &str) -> Result<()> {
        self.repo(project, name)?;
        let open: i64 = self.conn().query_row(
            "SELECT COUNT(*) FROM task_repos WHERE project = ?1 AND repo = ?2 AND state = 'published'",
            params![project, name],
            |r| r.get(0),
        )?;
        if open > 0 {
            return Err(GenieError::invalid(format!("{name} has {open} unmerged deliveries; finish or abandon them first")));
        }
        self.conn().execute("DELETE FROM task_repos WHERE project = ?1 AND repo = ?2", params![project, name])?;
        self.conn().execute("DELETE FROM project_repos WHERE project = ?1 AND name = ?2", params![project, name])?;
        Ok(())
    }

    // --- tasks ----------------------------------------------------------------------

    pub fn task_repos(&self, project: &str, task: &str) -> Result<Vec<TaskRepo>> {
        let mut stmt = self.conn().prepare("SELECT * FROM task_repos WHERE project = ?1 AND task = ?2 ORDER BY repo")?;
        Ok(stmt.query_map(params![project, task], TaskRepo::from_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn task_repo(&self, project: &str, task: &str, repo: &str) -> Result<Option<TaskRepo>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT * FROM task_repos WHERE project = ?1 AND task = ?2 AND repo = ?3",
                params![project, task, repo],
                TaskRepo::from_row,
            )
            .optional()?)
    }

    /// Name the repositories of a task with their access. A repository already
    /// delivered (a branch pushed) cannot be dropped, only its access changed.
    pub fn set_task_repos(&self, project: &str, task: &str, wanted: &[(String, String)]) -> Result<Vec<TaskRepo>> {
        let known = self.repos(project)?;
        for (name, access) in wanted {
            check_access(access)?;
            let Some(r) = known.iter().find(|r| &r.name == name) else {
                return Err(GenieError::not_found(format!("project {project} has no repository {name}")));
            };
            if access == "write" && r.access != "write" {
                return Err(GenieError::invalid(format!("the project allows only read access to {name}")));
            }
        }
        for have in self.task_repos(project, task)? {
            if !wanted.iter().any(|(n, _)| *n == have.repo) {
                if have.state != "pending" {
                    return Err(GenieError::invalid(format!(
                        "{} already has a delivery in {} ({}); it cannot be dropped",
                        task, have.repo, have.state
                    )));
                }
                self.conn()
                    .execute("DELETE FROM task_repos WHERE project = ?1 AND task = ?2 AND repo = ?3", params![project, task, have.repo])?;
            }
        }
        for (name, access) in wanted {
            self.conn().execute(
                "INSERT INTO task_repos(project, task, repo, access, updated) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(project, task, repo) DO UPDATE SET access = excluded.access, updated = excluded.updated",
                params![project, task, name, access, now()],
            )?;
        }
        self.task_repos(project, task)
    }

    pub fn update_delivery(&self, project: &str, task: &str, repo: &str, d: Delivery) -> Result<TaskRepo> {
        if self.task_repo(project, task, repo)?.is_none() {
            return Err(GenieError::not_found(format!("{task} has no repository {repo}")));
        }
        self.conn().execute(
            "UPDATE task_repos SET
               branch = COALESCE(?4, branch), state = COALESCE(?5, state),
               cr_number = COALESCE(?6, cr_number), cr_url = COALESCE(?7, cr_url), cr_state = COALESCE(?8, cr_state),
               ci_state = COALESCE(?9, ci_state), head_sha = COALESCE(?10, head_sha), seen_at = COALESCE(?11, seen_at), updated = ?12
             WHERE project = ?1 AND task = ?2 AND repo = ?3",
            params![project, task, repo, d.branch, d.state, d.cr_number, d.cr_url, d.cr_state, d.ci_state, d.head_sha, d.seen_at, now()],
        )?;
        Ok(self.task_repo(project, task, repo)?.expect("row exists"))
    }

    /// Deliveries with an open request: the ones the poller watches.
    pub fn open_deliveries(&self) -> Result<Vec<TaskRepo>> {
        let mut stmt = self.conn().prepare("SELECT * FROM task_repos WHERE cr_state = 'open' ORDER BY updated")?;
        Ok(stmt.query_map([], TaskRepo::from_row)?.collect::<rusqlite::Result<_>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, ServerDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = ServerDb::open(&dir.path().join("server.db")).unwrap();
        db.create_project("shop", "Shop", "/tmp/shop-tracker", None, None).unwrap();
        (dir, db)
    }

    fn new(name: &str, remote: &str, mount: &str) -> NewRepo {
        NewRepo { name: name.into(), host: "gitlab".into(), remote: remote.into(), mount: Some(mount.into()), ..Default::default() }
    }

    #[test]
    fn mounts_are_relative_clean_paths() {
        assert_eq!(clean_mount("").unwrap(), ".");
        assert_eq!(clean_mount("/services/api/").unwrap(), "services/api");
        assert!(clean_mount("../x").is_err());
        assert!(clean_mount("a/../b").is_err());
        assert!(clean_mount("a/.git").is_err());
        assert!(clean_mount("a b").is_err());
        assert!(mounts_collide("a", "a/b"));
        assert!(!mounts_collide(".", "a"));
        assert!(!mounts_collide("a", "b"));
    }

    #[test]
    fn remotes_lose_their_git_suffix_and_reject_traversal() {
        assert_eq!(clean_remote("/group/sub/repo.git").unwrap(), "group/sub/repo");
        assert!(clean_remote("a/../b").is_err());
        assert!(clean_remote("").is_err());
        assert!(clean_remote("a b/c").is_err());
    }

    #[test]
    fn a_project_holds_several_repositories_at_their_own_paths() {
        let (_d, db) = db();
        db.add_repo("shop", new("api", "acme/shop/api", "services/api")).unwrap();
        db.add_repo("shop", new("web", "acme/shop/web", "services/web")).unwrap();
        assert!(db.add_repo("shop", new("api", "acme/x", "x")).is_err(), "names are unique");
        assert!(db.add_repo("shop", new("bad", "acme/x", "services/api/inner")).is_err(), "mounts do not nest");
        assert!(db.add_repo("shop", NewRepo { access: Some("admin".into()), ..new("z", "a/b", "z") }).is_err());
        let list = db.repos("shop").unwrap();
        assert_eq!(list.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["api", "web"]);
        let r = db.update_repo("shop", "web", RepoPatch { mount: Some("frontend".into()), ..Default::default() }).unwrap();
        assert_eq!(r.mount, "frontend");
        assert!(db.update_repo("shop", "web", RepoPatch { mount: Some("services/api".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn a_task_names_its_repositories_and_the_project_caps_the_access() {
        let (_d, db) = db();
        db.add_repo("shop", NewRepo { access: Some("read".into()), ..new("docs", "acme/docs", "docs") }).unwrap();
        db.add_repo("shop", new("api", "acme/api", "api")).unwrap();
        assert!(db.set_task_repos("shop", "S-1", &[("docs".into(), "write".into())]).is_err(), "the project allows read only");
        let rows = db.set_task_repos("shop", "S-1", &[("docs".into(), "read".into()), ("api".into(), "write".into())]).unwrap();
        assert_eq!(rows.len(), 2);
        db.update_delivery(
            "shop",
            "S-1",
            "api",
            Delivery { state: Some("published".into()), cr_state: Some("open".into()), cr_number: Some(7), ..Default::default() },
        )
        .unwrap();
        assert!(db.set_task_repos("shop", "S-1", &[("docs".into(), "read".into())]).is_err(), "a delivered repository stays");
        let kept = db.set_task_repos("shop", "S-1", &[("docs".into(), "read".into()), ("api".into(), "read".into())]).unwrap();
        assert_eq!(kept.iter().find(|r| r.repo == "api").unwrap().cr_number, Some(7), "delivery survives an access change");
        assert_eq!(db.open_deliveries().unwrap().len(), 1);
        assert!(db.remove_repo("shop", "api").is_err(), "an unmerged delivery blocks removal");
    }
}
