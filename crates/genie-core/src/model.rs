//! Task model and workflow rules shared by the server, the CLI and agent tools.
//! Port of `src/tracker/model.ts`; the transition table and the DoR/DoD checks
//! must stay identical to it until the TypeScript core is removed.

use std::collections::HashSet;
use std::fmt;
use std::str::FromStr;

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};

use crate::error::GenieError;

/// String-backed enum stored as TEXT and serialised as the same string.
macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident ($label:literal) { $($variant:ident => $s:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $s)] $variant),+ }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $s),+ }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
        impl FromStr for $name {
            type Err = GenieError;
            fn from_str(s: &str) -> Result<Self, GenieError> {
                match s {
                    $($s => Ok($name::$variant),)+
                    _ => Err(GenieError::invalid(format!(concat!("unknown ", $label, " {}"), s))),
                }
            }
        }
        impl ToSql for $name {
            fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> { Ok(ToSqlOutput::from(self.as_str())) }
        }
        impl FromSql for $name {
            fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
                value.as_str()?.parse().map_err(|e| FromSqlError::Other(Box::new(e)))
            }
        }
    };
}

str_enum!(
    /// Task lifecycle status.
    Status("status") {
        Inbox => "inbox",                         // submitted by the owner; the orchestrator has not taken it yet
        Draft => "draft",                         // taken by the orchestrator, not analysed yet
        Refining => "refining",                   // scope and acceptance criteria are being clarified
        Ready => "ready",                         // Definition of Ready met; can be handed to a team
        InProgress => "in_progress",              // a team is working on it
        Review => "review",                       // executor submitted the result for review
        ChangesRequested => "changes_requested",  // reviewer/tester sent it back
        Approved => "approved",                   // reviewer approved; waits for orchestrator acceptance
        NeedsOwner => "needs_owner",              // stuck on a decision only the owner can make
        Done => "done",                           // accepted and closed by the orchestrator
        Cancelled => "cancelled",
    }
);

str_enum!(
    /// Who acts: the human owner, the orchestrator or a team member role.
    Role("role") {
        Human => "human",
        Orchestrator => "orchestrator",
        Analyst => "analyst",
        Executor => "executor",
        Reviewer => "reviewer",
        Tester => "tester",
        Documenter => "documenter",
    }
);

str_enum!(
    TaskType("type") {
        Epic => "epic",
        Task => "task",
        Bug => "bug",
        Spike => "spike",
    }
);

str_enum!(
    CommentKind("comment kind") {
        Note => "note",
        Progress => "progress",
        Question => "question",
        Decision => "decision",
        Review => "review",
        Handoff => "handoff",
        Owner => "owner",
    }
);

str_enum!(
    ArtifactKind("artifact kind") {
        Analysis => "analysis",
        Plan => "plan",
        Code => "code",
        Review => "review",
        TestReport => "test-report",
        Diff => "diff",
        Doc => "doc",
        Log => "log",
        Other => "other",
    }
);

pub const CLOSED: &[Status] = &[Status::Done, Status::Cancelled];

/// Statuses that mean a team is actually working on a task (they start its epic).
pub const WORKING: &[Status] = &[Status::InProgress, Status::Review, Status::ChangesRequested, Status::Approved];

pub const MEMBER_ROLES: &[Role] = &[Role::Analyst, Role::Executor, Role::Reviewer, Role::Tester, Role::Documenter];

/// Transitions that only the orchestrator (or the human) may make.
pub const ORCHESTRATOR_ONLY: &[Status] = &[Status::Draft, Status::Ready, Status::NeedsOwner, Status::Done, Status::Cancelled];

/// Team verdicts the orchestrator must not fake: it needs `force` to set them itself.
pub const TEAM_ONLY: &[Status] = &[Status::Review, Status::Approved];

struct TransitionRule {
    from: Status,
    to: Status,
    roles: &'static [Role],
}

// "human" may do anything; "orchestrator" anything except the team's verdicts (see can_transition).
const TRANSITIONS: &[TransitionRule] = &[
    TransitionRule { from: Status::Draft, to: Status::Refining, roles: &[Role::Analyst] },
    TransitionRule { from: Status::Ready, to: Status::InProgress, roles: &[Role::Executor, Role::Analyst] },
    TransitionRule { from: Status::ChangesRequested, to: Status::InProgress, roles: &[Role::Executor] },
    TransitionRule { from: Status::InProgress, to: Status::Review, roles: &[Role::Executor] },
    TransitionRule { from: Status::Review, to: Status::ChangesRequested, roles: &[Role::Reviewer, Role::Tester] },
    TransitionRule { from: Status::Review, to: Status::Approved, roles: &[Role::Reviewer] },
];

pub fn is_privileged(role: Role) -> bool {
    matches!(role, Role::Human | Role::Orchestrator)
}

pub fn is_member_role(role: Role) -> bool {
    MEMBER_ROLES.contains(&role)
}

pub fn can_transition(role: Role, from: Status, to: Status) -> bool {
    if from == to {
        return false;
    }
    if role == Role::Human {
        return true;
    }
    if to == Status::Inbox {
        return false;
    }
    if role == Role::Orchestrator {
        return !TEAM_ONLY.contains(&to);
    }
    if ORCHESTRATOR_ONLY.contains(&to) {
        return false;
    }
    TRANSITIONS.iter().any(|t| t.from == from && t.to == to && t.roles.contains(&role))
}

pub fn allowed_transitions(role: Role, from: Status) -> Vec<Status> {
    Status::ALL.iter().copied().filter(|&to| can_transition(role, from, to)).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor {
    pub name: String,
    pub role: Role,
}

impl Actor {
    pub fn new(name: impl Into<String>, role: Role) -> Self {
        Actor { name: name.into(), role }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceCriterion {
    pub id: i64,
    pub text: String,
    pub done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Comment {
    pub id: i64,
    pub at: String,
    pub author: String,
    pub role: Role,
    pub kind: CommentKind,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    /// Per-task number (#1, #2…).
    pub id: i64,
    pub at: String,
    pub author: String,
    pub role: Role,
    pub kind: ArtifactKind,
    pub name: String,
    pub size: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: String,
    pub actor: String,
    pub role: Role,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NeedsOwner {
    pub question: String,
    pub by: String,
    pub at: String,
    /// Status to return to once the owner has answered.
    pub previous: Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Blocked {
    pub reason: String,
    pub by: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub status: Status,
    /// 0 = urgent … 4 = low
    pub priority: i64,
    pub description: String,
    pub acceptance: Vec<AcceptanceCriterion>,
    /// Implementation plan (markdown), usually written by the analyst.
    pub plan: String,
    /// Running implementation notes / final summary (markdown).
    pub notes: String,
    /// How the result gets integrated, agreed before dispatch.
    pub merge_strategy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub children: Vec<String>,
    /// Tasks that must be done before this one can start.
    pub deps: Vec<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Worktree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<Blocked>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_owner: Option<NeedsOwner>,
    pub comments: Vec<Comment>,
    pub artifacts: Vec<Artifact>,
    pub history: Vec<HistoryEntry>,
    pub created: String,
    pub updated: String,
}

/// Lightweight row for lists and boards.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub task_type: TaskType,
    pub status: Status,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked: Option<Blocked>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub needs_owner: Option<NeedsOwner>,
    pub acceptance_done: i64,
    pub acceptance_total: i64,
    pub deps: Vec<String>,
    pub open_deps: Vec<String>,
    pub children: i64,
    /// Children that are done or cancelled (epic progress).
    pub children_closed: i64,
    pub comments: i64,
    pub artifacts: i64,
    pub created: String,
    pub updated: String,
}

/// Definition of Ready: problems that prevent moving a task to `ready`.
pub fn readiness_problems(task: &Task, existing_deps: &HashSet<String>) -> Vec<String> {
    let mut problems = Vec::new();
    if task.description.trim().is_empty() {
        problems.push("description is empty".to_string());
    }
    if task.acceptance.is_empty() {
        problems.push("no acceptance criteria".to_string());
    }
    if task.task_type == TaskType::Epic {
        problems.push("epics are not handed to teams; split it into tasks".to_string());
    }
    for dep in &task.deps {
        if !existing_deps.contains(dep) {
            problems.push(format!("dependency {dep} does not exist"));
        }
    }
    problems
}

/// Optional artifact gates (`gates` in the config).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gates {
    /// Require a test-report artifact before in_progress → review.
    #[serde(default)]
    pub require_test_report: bool,
    /// Require a review artifact before review → approved.
    #[serde(default)]
    pub require_review_artifact: bool,
}

/// Definition of Done: problems that prevent moving a task to `done`.
pub fn done_problems(task: &Task, child_statuses: &[Status]) -> Vec<String> {
    let mut problems = Vec::new();
    let open: Vec<String> = task.acceptance.iter().filter(|a| !a.done).map(|a| format!("#{}", a.id)).collect();
    if !open.is_empty() {
        problems.push(format!("unchecked acceptance criteria: {}", open.join(", ")));
    }
    if task.task_type == TaskType::Epic {
        let unfinished = child_statuses.iter().filter(|s| !CLOSED.contains(s)).count();
        if unfinished > 0 {
            problems.push(format!("{unfinished} unfinished child task(s)"));
        }
    } else if task.status != Status::Approved {
        problems.push(format!("status is {}; a reviewer must approve it first", task.status));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transition_table_sanity() {
        assert!(can_transition(Role::Analyst, Status::Draft, Status::Refining));
        assert!(!can_transition(Role::Analyst, Status::Refining, Status::Ready));
        assert!(can_transition(Role::Orchestrator, Status::Approved, Status::Done));
        assert!(!can_transition(Role::Orchestrator, Status::InProgress, Status::Review));
        assert!(!can_transition(Role::Orchestrator, Status::Review, Status::Approved));
        assert!(can_transition(Role::Human, Status::Review, Status::Approved));
        assert!(!can_transition(Role::Executor, Status::Review, Status::Approved));
        assert!(!can_transition(Role::Orchestrator, Status::Draft, Status::Inbox));
        assert!(can_transition(Role::Human, Status::Draft, Status::Inbox));
    }

    #[test]
    fn enums_round_trip_as_strings() {
        for s in Status::ALL {
            assert_eq!(s.as_str().parse::<Status>().unwrap(), *s);
            assert_eq!(serde_json::to_string(s).unwrap(), format!("\"{}\"", s.as_str()));
        }
        assert_eq!("test-report".parse::<ArtifactKind>().unwrap(), ArtifactKind::TestReport);
        assert_eq!("nope".parse::<Status>().unwrap_err().to_string(), "unknown status nope");
        assert_eq!("nope".parse::<ArtifactKind>().unwrap_err().to_string(), "unknown artifact kind nope");
    }
}
