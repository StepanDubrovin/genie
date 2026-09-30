//! Repositories of projects and how agents work with them.
//!
//! - [`hosts`]: the git hosts of `git.json` and their secrets;
//! - [`policy`]: what an agent may do in a repository (the effective policy);
//! - [`store`]: the server's mirrors and the agents' clones;
//! - [`provider`]: pull/merge requests and CI of a host (GitHub, GitLab);
//! - [`delivery`]: the state of a task's delivery and the watcher of open requests.
//!
//! Design: docs/platform/git-repositories.md. Agents hold no credentials for hosts:
//! their clones point at the proxy of the server (`crate::http::git`), which
//! checks every push against the effective policy and forwards it with the host's
//! token; requests are opened and merged by the server (`genie agent pr`).

pub mod check;
pub mod delivery;
pub mod hosts;
pub mod policy;
pub mod provider;
pub mod service;
pub mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Shared state of the repository layer: a lock per mirror and when it was last fetched.
#[derive(Default)]
pub struct Git {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    fetched: Mutex<HashMap<String, Instant>>,
}

impl Git {
    /// The lock of one mirror or workspace directory (held around every write to it).
    pub fn lock(&self, key: &str) -> Arc<Mutex<()>> {
        let mut m = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(key.to_string()).or_default().clone()
    }

    pub(crate) fn fetched_at(&self, key: &str) -> Option<Instant> {
        self.fetched.lock().unwrap_or_else(|e| e.into_inner()).get(key).copied()
    }

    pub(crate) fn mark_fetched(&self, key: &str) {
        self.fetched.lock().unwrap_or_else(|e| e.into_inner()).insert(key.to_string(), Instant::now());
    }
}
