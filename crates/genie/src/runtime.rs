//! Agent runtime (filled in by the team runtime step).

use std::sync::Arc;

use crate::state::App;

/// Stop teams of closed tasks in a project.
pub async fn reap_closed(_app: &Arc<App>, _project: &str) {}

/// Start background workers.
pub fn start(_app: &Arc<App>) {}
