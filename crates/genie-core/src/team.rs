//! Teams, members and peer-to-peer mail, stored in the project's tracker
//! database. Port of `src/team/bus.ts` and `src/team/digest.ts`, adapted to the
//! turn-based runtime:
//!
//! - an agent works in *turns*: the runtime leases the agent's unread mail to a
//!   turn (`lease`), runs the agent, and marks the mail delivered only when the
//!   turn succeeds (`complete_lease`); a failed or interrupted turn releases the
//!   lease and the mail is offered again — at-least-once delivery, no loss;
//! - the orchestrator's mailbox is its global box plus every team except teams
//!   stopped on purpose (their late mail is dropped, as before).

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::now;
use crate::error::{GenieError, Result};
use crate::events;
use crate::tracker::Tracker;

pub const ORCHESTRATOR: &str = "orchestrator";
pub const BROADCAST: &str = "all";

/// Stops made on purpose: such teams are not revived and their late mail is dropped.
pub const DELIBERATE_STOPS: &[&str] = &["orchestrator", "owner", "task_closed"];
const DELIBERATE_SQL: &str = "('orchestrator', 'owner', 'task_closed')";

pub const MAIL_LEVELS: &[&str] = &["low", "normal", "high"];
pub const MAIL_INTENTS: &[&str] = &["question", "blocker", "verdict", "done", "fyi"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TeamWorktree {
    pub path: String,
    pub branch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub name: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
    pub status: String,
    pub status_at: String,
    /// `active` | `stopped` | `error`
    pub state: String,
    /// `idle` | `working` | `error`
    pub activity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<TeamWorktree>,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub created: String,
    pub updated: String,
    pub members: Vec<Member>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mail {
    pub id: i64,
    pub at: String,
    pub team: Option<String>,
    pub from: String,
    pub from_role: String,
    pub to: String,
    pub text: String,
    pub urgent: bool,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// `message` | `kickoff` | `system` | `owner`
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<String>,
}

impl Mail {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Mail> {
        let urgent: i64 = r.get("urgent")?;
        let level: String = r.get("level")?;
        let level = if urgent != 0 {
            "high".to_string()
        } else if MAIL_LEVELS.contains(&level.as_str()) {
            level
        } else {
            "normal".into()
        };
        Ok(Mail {
            id: r.get("id")?,
            at: r.get("at")?,
            team: r.get("team")?,
            from: r.get("sender")?,
            from_role: r.get("sender_role")?,
            to: r.get("recipient")?,
            text: r.get("text")?,
            urgent: level == "high",
            level,
            intent: r.get("intent")?,
            kind: r.get("kind")?,
            task: r.get("task")?,
            delivered_at: r.get("delivered_at")?,
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct NewMember {
    pub name: String,
    pub role: String,
    pub model: Option<String>,
    pub thinking: Option<String>,
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct NewTeam {
    pub id: String,
    pub task: String,
    pub template: Option<String>,
    pub cwd: String,
    pub worktree: Option<TeamWorktree>,
    pub members: Vec<NewMember>,
}

#[derive(Debug, Clone)]
pub struct SendMail<'a> {
    pub team: &'a str,
    pub from: &'a str,
    pub from_role: &'a str,
    pub to: &'a str,
    pub text: &'a str,
    pub level: Option<&'a str>,
    pub intent: Option<&'a str>,
    pub kind: &'a str,
}

/// A mailbox with unread, unleased mail: `(team, recipient)`; team `None` is the orchestrator.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Mailbox {
    pub team: Option<String>,
    pub recipient: String,
}

fn member_from_row(r: &Row<'_>) -> rusqlite::Result<Member> {
    let runtime: Option<String> = r.get("runtime")?;
    Ok(Member {
        name: r.get("name")?,
        role: r.get("role")?,
        model: r.get("model")?,
        thinking: r.get("thinking")?,
        instructions: r.get("instructions")?,
        status: r.get("status")?,
        status_at: r.get("status_at")?,
        state: r.get("state")?,
        activity: r.get("activity")?,
        activity_at: r.get("activity_at")?,
        heartbeat_at: r.get("heartbeat_at")?,
        runtime: runtime.and_then(|s| serde_json::from_str(&s).ok()),
        session_file: r.get("session_file")?,
    })
}

fn valid_member_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Team registry and mailboxes on top of a project tracker.
pub struct Bus<'a> {
    t: &'a Tracker,
}

impl Tracker {
    pub fn bus(&self) -> Bus<'_> {
        Bus { t: self }
    }
}

impl Bus<'_> {
    fn conn(&self) -> &rusqlite::Connection {
        self.t.conn()
    }

    pub fn exists(&self, team: &str) -> Result<bool> {
        Ok(self.conn().query_row("SELECT 1 FROM teams WHERE id = ?1", [team], |_| Ok(())).optional()?.is_some())
    }

    pub fn get(&self, team: &str) -> Result<Team> {
        type Row = (String, String, Option<String>, String, Option<String>, String, Option<String>, String, String);
        let row: Row = self
            .conn()
            .query_row(
                "SELECT id, task, template, cwd, worktree, state, stop_reason, created, updated FROM teams WHERE id = ?1",
                [team],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?)),
            )
            .optional()?
            .ok_or_else(|| GenieError::not_found(format!("team {team} not found")))?;
        let mut stmt = self.conn().prepare_cached("SELECT * FROM members WHERE team = ?1 ORDER BY ord")?;
        let members = stmt.query_map([team], member_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(Team {
            id: row.0,
            task: row.1,
            template: row.2,
            cwd: row.3,
            worktree: row.4.and_then(|w| serde_json::from_str(&w).ok()),
            state: row.5,
            stop_reason: row.6,
            created: row.7,
            updated: row.8,
            members,
        })
    }

    pub fn list(&self, include_stopped: bool) -> Result<Vec<Team>> {
        let sql = if include_stopped {
            "SELECT id FROM teams ORDER BY created"
        } else {
            "SELECT id FROM teams WHERE state = 'active' ORDER BY created"
        };
        let mut stmt = self.conn().prepare(sql)?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        ids.iter().map(|id| self.get(id)).collect()
    }

    pub fn active_count(&self) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM teams WHERE state = 'active'", [], |r| r.get(0))?)
    }

    /// A free team id derived from the task id: G-7, G-7b, G-7c…
    pub fn free_id(&self, task: &str) -> Result<String> {
        if !self.exists(task)? {
            return Ok(task.to_string());
        }
        for c in b'b'..=b'z' {
            let id = format!("{task}{}", c as char);
            if !self.exists(&id)? {
                return Ok(id);
            }
        }
        Ok(format!("{task}-{}", chrono::Utc::now().timestamp()))
    }

    /// Names used by members of active teams, so new members get distinct names.
    pub fn taken_names(&self) -> Result<std::collections::HashSet<String>> {
        let mut stmt = self.conn().prepare("SELECT m.name FROM members m JOIN teams t ON t.id = m.team WHERE t.state = 'active'")?;
        Ok(stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn log(&self, team: &str, event: &str, data: Value) -> Result<()> {
        self.conn()
            .execute("INSERT INTO log(team, at, event, data) VALUES (?1, ?2, ?3, ?4)", params![team, now(), event, data.to_string()])?;
        Ok(())
    }

    pub fn read_log(&self, team: &str, limit: i64) -> Result<Vec<Value>> {
        let mut stmt =
            self.conn().prepare("SELECT at, event, data FROM (SELECT * FROM log WHERE team = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id")?;
        let rows =
            stmt.query_map(params![team, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        rows.map(|r| {
            let (at, event, data) = r?;
            let mut v: Value = serde_json::from_str(&data).unwrap_or_else(|_| json!({}));
            if let Some(o) = v.as_object_mut() {
                o.insert("at".into(), json!(at));
                o.insert("event".into(), json!(event));
            }
            Ok(v)
        })
        .collect()
    }

    fn insert_member(&self, team: &str, m: &NewMember, ord: i64) -> Result<()> {
        if !valid_member_name(&m.name) {
            return Err(GenieError::invalid(format!("member name \"{}\" must match [a-z][a-z0-9_-]*", m.name)));
        }
        if m.name == ORCHESTRATOR || m.name == BROADCAST {
            return Err(GenieError::invalid(format!("member name \"{}\" is reserved", m.name)));
        }
        let at = now();
        self.conn().execute(
            "INSERT INTO members(team, name, role, model, thinking, instructions, status, status_at, state, activity, runtime, session_file, ord)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'starting', ?7, 'active', 'idle', ?8, ?9, ?10)",
            params![
                team,
                m.name,
                m.role,
                m.model,
                m.thinking,
                m.instructions,
                at,
                json!({ "kind": "turn" }).to_string(),
                format!("{team}-{}", m.name).to_lowercase(),
                ord
            ],
        )?;
        Ok(())
    }

    pub fn create(&self, actor: &str, actor_role: &str, team: NewTeam) -> Result<Team> {
        self.t.tx(|| {
            if self.exists(&team.id)? {
                return Err(GenieError::invalid(format!("team {} already exists", team.id)));
            }
            let at = now();
            self.conn().execute(
                "INSERT INTO teams(id, task, template, cwd, worktree, state, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6)",
                params![team.id, team.task, team.template, team.cwd, team.worktree.as_ref().map(|w| json!(w).to_string()), at],
            )?;
            for (i, m) in team.members.iter().enumerate() {
                self.insert_member(&team.id, m, i as i64)?;
            }
            let roster: Vec<String> = team.members.iter().map(|m| format!("{}:{}:{}", m.name, m.role, m.model.as_deref().unwrap_or("default"))).collect();
            self.log(&team.id, "team_created", json!({ "members": roster }))?;
            events::append(
                self.conn(),
                "team.spawned",
                Some(&team.task),
                actor,
                actor_role,
                json!({ "team": team.id, "template": team.template, "members": roster }),
            )?;
            Ok(())
        })?;
        self.get(&team.id)
    }

    pub fn add_member(&self, team: &str, m: NewMember) -> Result<Team> {
        self.t.tx(|| {
            if self
                .conn()
                .query_row("SELECT 1 FROM members WHERE team = ?1 AND name = ?2", params![team, m.name], |_| Ok(()))
                .optional()?
                .is_some()
            {
                return Err(GenieError::invalid(format!("team {team} already has a member {}", m.name)));
            }
            let ord: i64 = self.conn().query_row("SELECT COUNT(*) FROM members WHERE team = ?1", [team], |r| r.get(0))?;
            self.insert_member(team, &m, ord)?;
            self.log(team, "member_added", json!({ "member": format!("{}:{}", m.name, m.role) }))
        })?;
        self.get(team)
    }

    /// Remove a member; its unread mail is closed (the history stays).
    pub fn remove_member(&self, team: &str, member: &str) -> Result<()> {
        self.t.tx(|| {
            let n = self.conn().execute("DELETE FROM members WHERE team = ?1 AND name = ?2", params![team, member])?;
            if n == 0 {
                return Err(GenieError::not_found(format!("team {team} has no member {member}")));
            }
            self.conn().execute(
                "UPDATE mail SET delivered_at = ?1, lease = NULL WHERE team = ?2 AND recipient = ?3 AND delivered_at IS NULL",
                params![now(), team, member],
            )?;
            self.conn().execute("UPDATE teams SET updated = ?1 WHERE id = ?2", params![now(), team])?;
            self.log(team, "member_removed", json!({ "member": member }))
        })
    }

    /// Stop (`stopped`, with a reason) or reactivate (`active`) a team.
    pub fn set_state(&self, team: &str, state: &str, reason: Option<&str>, actor: &str) -> Result<()> {
        self.t.tx(|| {
            let task: String = self
                .conn()
                .query_row("SELECT task FROM teams WHERE id = ?1", [team], |r| r.get(0))
                .optional()?
                .ok_or_else(|| GenieError::not_found(format!("team {team} not found")))?;
            let reason = (state == "stopped").then(|| reason.unwrap_or("orchestrator"));
            self.conn().execute(
                "UPDATE teams SET state = ?1, stop_reason = ?2, updated = ?3 WHERE id = ?4",
                params![state, reason, now(), team],
            )?;
            if let Some(r) = reason
                && DELIBERATE_STOPS.contains(&r)
            {
                self.conn().execute("UPDATE members SET state = 'stopped', activity = 'idle' WHERE team = ?1", [team])?;
            }
            if state == "active" {
                self.conn().execute("UPDATE members SET state = 'active' WHERE team = ?1 AND state = 'stopped'", [team])?;
            }
            self.log(team, if state == "stopped" { "team_stopped" } else { "team_started" }, json!({ "reason": reason, "by": actor }))?;
            events::append(
                self.conn(),
                if state == "stopped" { "team.stopped" } else { "team.started" },
                Some(&task),
                actor,
                "system",
                json!({ "team": team, "reason": reason }),
            )?;
            Ok(())
        })
    }

    /// Delete a team with its roster, mail and log.
    pub fn delete(&self, team: &str) -> Result<()> {
        self.t.tx(|| {
            for table in ["mail", "log", "members"] {
                self.conn().execute(&format!("DELETE FROM {table} WHERE team = ?1"), [team])?;
            }
            self.conn().execute("DELETE FROM teams WHERE id = ?1", [team])?;
            Ok(())
        })
    }

    /// The member's own status line (shown in the team card).
    pub fn set_member_status(&self, team: &str, member: &str, status: &str) -> Result<()> {
        if member == ORCHESTRATOR {
            return Ok(());
        }
        self.t.tx(|| {
            let n = self.conn().execute(
                "UPDATE members SET status = ?1, status_at = ?2 WHERE team = ?3 AND name = ?4",
                params![status, now(), team, member],
            )?;
            if n == 0 {
                return Err(GenieError::not_found(format!("team {team} has no member {member}")));
            }
            self.conn().execute("UPDATE teams SET updated = ?1 WHERE id = ?2", params![now(), team])?;
            self.log(team, "status", json!({ "member": member, "status": status }))
        })
    }

    /// Runtime bookkeeping: `working` while a turn runs, `idle` after, `error` when it failed for good.
    pub fn set_activity(&self, team: &str, member: &str, activity: &str, runtime: Option<Value>) -> Result<()> {
        let at = now();
        self.conn().execute(
            "UPDATE members SET activity = ?1, activity_at = ?2, heartbeat_at = ?2, runtime = COALESCE(?3, runtime),
             state = CASE WHEN ?1 = 'error' THEN 'error' WHEN state = 'error' THEN 'active' ELSE state END
             WHERE team = ?4 AND name = ?5",
            params![activity, at, runtime.map(|r| r.to_string()), team, member],
        )?;
        Ok(())
    }

    /// Deliver a message. `to` is a member name, `orchestrator` or `all` (everyone but the sender).
    pub fn send(&self, m: SendMail<'_>) -> Result<Vec<Mail>> {
        let level = m.level.unwrap_or("normal");
        if !MAIL_LEVELS.contains(&level) {
            return Err(GenieError::invalid(format!("invalid mail level \"{level}\"; expected one of {}", MAIL_LEVELS.join(", "))));
        }
        if let Some(i) = m.intent
            && !MAIL_INTENTS.contains(&i)
        {
            return Err(GenieError::invalid(format!("invalid mail intent \"{i}\"; expected one of {}", MAIL_INTENTS.join(", "))));
        }
        if m.text.trim().is_empty() {
            return Err(GenieError::invalid("message text is empty"));
        }
        let team = self.get(m.team)?;
        let mut names: Vec<String> = team.members.iter().map(|x| x.name.clone()).collect();
        names.push(ORCHESTRATOR.into());
        let recipients: Vec<String> = if m.to == BROADCAST {
            names.iter().filter(|n| *n != m.from).cloned().collect()
        } else if names.iter().any(|n| n == m.to) {
            vec![m.to.to_string()]
        } else {
            return Err(GenieError::invalid(format!("team {} has no member \"{}\". Members: {}", team.id, m.to, names.join(", "))));
        };
        let ids = self.t.tx(|| {
            let at = now();
            let mut ids = Vec::new();
            for to in &recipients {
                self.conn().execute(
                    "INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, level, intent, kind, task) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    params![team.id, at, m.from, m.from_role, to, m.text, (level == "high") as i64, level, m.intent, m.kind, team.task],
                )?;
                ids.push(self.conn().last_insert_rowid());
            }
            let short: String = m.text.chars().take(500).collect();
            self.log(&team.id, "mail", json!({ "from": m.from, "to": m.to, "level": level, "intent": m.intent, "text": short }))?;
            events::append(
                self.conn(),
                events::MAIL_SENT,
                Some(&team.task),
                m.from,
                m.from_role,
                json!({ "team": team.id, "to": m.to, "recipients": recipients, "level": level, "intent": m.intent, "kind": m.kind }),
            )?;
            Ok(ids)
        })?;
        ids.iter().map(|id| self.mail(*id)).collect()
    }

    /// A system message to the orchestrator's global mailbox.
    pub fn notify_orchestrator(&self, from: &str, from_role: &str, kind: &str, text: &str, task: Option<&str>) -> Result<()> {
        self.t.tx(|| {
            self.conn().execute(
                "INSERT INTO mail(team, at, sender, sender_role, recipient, text, urgent, kind, task) VALUES (NULL, ?1, ?2, ?3, 'orchestrator', ?4, 0, ?5, ?6)",
                params![now(), from, from_role, text, kind, task],
            )?;
            events::append(self.conn(), events::MAIL_SENT, task, from, from_role, json!({ "to": ORCHESTRATOR, "kind": kind }))?;
            Ok(())
        })
    }

    pub fn mail(&self, id: i64) -> Result<Mail> {
        Ok(self.conn().query_row("SELECT * FROM mail WHERE id = ?1", [id], Mail::from_row)?)
    }

    /// Messages of a team, newest last.
    pub fn history(&self, team: &str, limit: i64) -> Result<Vec<Mail>> {
        let mut stmt = self.conn().prepare("SELECT * FROM (SELECT * FROM mail WHERE team = ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id")?;
        Ok(stmt.query_map(params![team, limit], Mail::from_row)?.collect::<rusqlite::Result<_>>()?)
    }

    /// Unread, unleased mail for one member (or, with `team == None`, the orchestrator).
    fn unclaimed_sql(team: Option<&str>) -> String {
        match team {
            Some(_) => "SELECT * FROM mail WHERE team = ?1 AND recipient = ?2 AND delivered_at IS NULL AND lease IS NULL ORDER BY id".into(),
            None => format!(
                "SELECT * FROM mail WHERE ?1 IS NULL AND recipient = ?2 AND delivered_at IS NULL AND lease IS NULL
                 AND (team IS NULL OR team NOT IN (SELECT id FROM teams WHERE state = 'stopped' AND COALESCE(stop_reason, 'orchestrator') IN {DELIBERATE_SQL}))
                 ORDER BY id"
            ),
        }
    }

    pub fn pending(&self, team: Option<&str>, recipient: &str) -> Result<Vec<Mail>> {
        let mut stmt = self.conn().prepare(&Self::unclaimed_sql(team))?;
        Ok(stmt.query_map(params![team, recipient], Mail::from_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn pending_count(&self, team: &str, member: &str) -> Result<i64> {
        Ok(self.conn().query_row(
            "SELECT COUNT(*) FROM mail WHERE team = ?1 AND recipient = ?2 AND delivered_at IS NULL",
            params![team, member],
            |r| r.get(0),
        )?)
    }

    /// Lease a mailbox's unread mail to a turn. Returns the leased messages.
    pub fn lease(&self, team: Option<&str>, recipient: &str, turn: i64) -> Result<Vec<Mail>> {
        self.t.tx(|| {
            let rows = self.pending(team, recipient)?;
            for r in &rows {
                self.conn().execute("UPDATE mail SET lease = ?1 WHERE id = ?2", params![turn, r.id])?;
            }
            Ok(rows)
        })
    }

    /// The turn succeeded: its leased mail is delivered.
    pub fn complete_lease(&self, turn: i64) -> Result<usize> {
        Ok(self.conn().execute("UPDATE mail SET delivered_at = ?1 WHERE lease = ?2 AND delivered_at IS NULL", params![now(), turn])?)
    }

    /// The turn failed or was interrupted: its mail is offered again.
    pub fn release_lease(&self, turn: i64) -> Result<usize> {
        Ok(self.conn().execute("UPDATE mail SET lease = NULL WHERE lease = ?1 AND delivered_at IS NULL", [turn])?)
    }

    /// After a restart no turn is running: every open lease is released.
    pub fn release_all_leases(&self) -> Result<usize> {
        Ok(self.conn().execute("UPDATE mail SET lease = NULL WHERE lease IS NOT NULL AND delivered_at IS NULL", [])?)
    }

    /// Mail addressed to a member that cannot run (removed, stopped team): drop it quietly.
    pub fn close_undeliverable(&self) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE mail SET delivered_at = ?1 WHERE delivered_at IS NULL AND recipient <> 'orchestrator' AND team IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM members m JOIN teams t ON t.id = m.team
                             WHERE m.team = mail.team AND m.name = mail.recipient AND t.state = 'active' AND m.state <> 'stopped')",
            [now()],
        )?)
    }

    /// Mailboxes that have unread, unleased mail and an agent able to read it.
    pub fn mailboxes_with_mail(&self) -> Result<Vec<Mailbox>> {
        self.close_undeliverable()?;
        let mut out = Vec::new();
        let mut stmt = self.conn().prepare(
            "SELECT DISTINCT m.team, m.recipient FROM mail m JOIN members x ON x.team = m.team AND x.name = m.recipient
             JOIN teams t ON t.id = m.team
             WHERE m.delivered_at IS NULL AND m.lease IS NULL AND t.state = 'active' AND x.state = 'active'",
        )?;
        for r in stmt.query_map([], |r| Ok(Mailbox { team: r.get(0)?, recipient: r.get(1)? }))? {
            out.push(r?);
        }
        if !self.pending(None, ORCHESTRATOR)?.is_empty() {
            out.push(Mailbox { team: None, recipient: ORCHESTRATOR.into() });
        }
        Ok(out)
    }
}

// --- names -------------------------------------------------------------------

/// Default name pools per role; the id is the lowercase name used for mail.
pub fn name_pool(role: &str) -> &'static [&'static str] {
    match role {
        "analyst" => &["sherlock", "poirot", "marple", "columbo", "scully", "mulder", "watson", "clouseau"],
        "executor" => &["bender", "baymax", "walle", "optimus", "johnny5", "r2d2", "tars", "robocop"],
        "reviewer" => &["gandalf", "yoda", "hermione", "spock", "galadriel", "dumbledore", "morpheus", "picard"],
        "tester" => &["murphy", "gremlin", "loki", "jinx", "chaos", "moriarty"],
        "documenter" => &["tolkien", "homer", "shakespeare", "pushkin", "dickens", "chekhov"],
        _ => &["agent"],
    }
}

pub fn display_name(name: &str) -> String {
    match name {
        "walle" => "WALL-E".into(),
        "johnny5" => "Johnny 5".into(),
        "r2d2" => "R2-D2".into(),
        "tars" => "TARS".into(),
        "robocop" => "RoboCop".into(),
        _ => name
            .split(['-', '_'])
            .filter(|p| !p.is_empty())
            .map(|p| {
                let mut c = p.chars();
                c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

/// Pick a free name for a role; `taken` is extended.
pub fn pick_name(role: &str, taken: &mut std::collections::HashSet<String>) -> String {
    let pool = name_pool(role);
    let free: Vec<&&str> = pool.iter().filter(|n| !taken.contains(**n)).collect();
    let name = if free.is_empty() {
        (2..).map(|i| format!("{}{i}", pool[0])).find(|c| !taken.contains(c)).unwrap_or_default()
    } else {
        let mut b = [0u8; 2];
        getrandom::fill(&mut b).expect("OS random source");
        free[u16::from_le_bytes(b) as usize % free.len()].to_string()
    };
    taken.insert(name.clone());
    name
}

// --- digest ------------------------------------------------------------------

fn rank_intent(intent: Option<&str>) -> u8 {
    match intent {
        Some("blocker" | "question") => 0,
        Some("verdict" | "done") => 1,
        Some("fyi") => 3,
        _ => 2,
    }
}

fn one_line(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > limit { format!("{}…", flat.chars().take(limit).collect::<String>()) } else { flat }
}

pub fn digest_line(m: &Mail) -> String {
    let intent = m.intent.as_deref().map(|i| format!(" · {i}")).unwrap_or_default();
    format!("- {} ({}) · {}{intent} · {}", m.from, m.from_role, m.level, one_line(&m.text, 240))
}

/// The orchestrator's batch of team messages as a digest: grouped by team, one
/// line per sender (its latest message), teams waiting for an answer first, FYI
/// last. Non-`message` rows are rendered verbatim by the caller.
pub fn render_digest(mails: &[Mail]) -> String {
    use std::collections::BTreeMap;
    let messages: Vec<&Mail> = mails.iter().filter(|m| m.kind == "message").collect();
    if messages.is_empty() {
        return String::new();
    }
    let mut latest: BTreeMap<(String, String), &Mail> = BTreeMap::new();
    for m in &messages {
        let key = (m.team.clone().unwrap_or_else(|| "(global)".into()), m.from.clone());
        if latest.get(&key).is_none_or(|p| p.id < m.id) {
            latest.insert(key, m);
        }
    }
    let mut fyi: Vec<&Mail> = Vec::new();
    let mut by_team: BTreeMap<String, Vec<&Mail>> = BTreeMap::new();
    for ((team, _), m) in latest {
        if m.intent.as_deref() == Some("fyi") {
            fyi.push(m);
        } else {
            by_team.entry(team).or_default().push(m);
        }
    }
    let mut sections: Vec<(String, Vec<&Mail>, u8, i64)> = by_team
        .into_iter()
        .map(|(team, mut lines)| {
            lines.sort_by_key(|m| m.id);
            let last = lines.iter().max_by_key(|m| m.id).expect("non-empty");
            let (rank, at) = (rank_intent(last.intent.as_deref()), last.id);
            (team, lines, rank, at)
        })
        .collect();
    sections.sort_by_key(|s| (s.2, s.3));
    fyi.sort_by_key(|m| m.id);
    let rows = sections.iter().map(|s| s.1.len()).sum::<usize>() + fyi.len();
    let mut shape = Vec::new();
    if !sections.is_empty() {
        shape.push(format!("{} team section{}", sections.len(), if sections.len() == 1 { "" } else { "s" }));
    }
    if !fyi.is_empty() {
        shape.push("FYI".to_string());
    }
    let mut out = vec![format!("[genie digest · {rows} message{} in {}]", if rows == 1 { "" } else { "s" }, shape.join(" + "))];
    for (team, lines, ..) in &sections {
        out.push(String::new());
        out.push(format!("## {team} ({})", lines.len()));
        out.extend(lines.iter().map(|m| digest_line(m)));
    }
    if !fyi.is_empty() {
        out.push(String::new());
        out.push("## FYI".into());
        out.extend(fyi.iter().map(|m| digest_line(m)));
    }
    out.join("\n")
}

/// A member's batch as one message: kickoffs and system notes verbatim, then mail.
pub fn render_batch(mails: &[Mail]) -> String {
    let mut out = Vec::new();
    for m in mails {
        let head = match m.kind.as_str() {
            "kickoff" => "## Kickoff".to_string(),
            "system" => format!("## System note ({})", m.from),
            "owner" => format!("## From the owner ({})", m.from),
            _ => format!(
                "## From {} ({}) · {}{}",
                m.from,
                m.from_role,
                m.level,
                m.intent.as_deref().map(|i| format!(" · {i}")).unwrap_or_default()
            ),
        };
        out.push(format!("{head}\n\n{}", m.text.trim()));
    }
    out.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Actor, Role};
    use crate::tracker::CreateInput;

    fn fresh() -> (tempfile::TempDir, Tracker) {
        let dir = tempfile::tempdir().unwrap();
        let t = Tracker::init(dir.path().join(".genie"), None, None).unwrap();
        t.create(&Actor::new("o", Role::Orchestrator), CreateInput { title: "x".into(), ..Default::default() }).unwrap();
        (dir, t)
    }

    fn team(t: &Tracker) {
        let m = |n: &str, r: &str| NewMember { name: n.into(), role: r.into(), ..Default::default() };
        t.bus()
            .create(
                "orchestrator",
                "orchestrator",
                NewTeam {
                    id: "G-1".into(),
                    task: "G-1".into(),
                    cwd: "/tmp".into(),
                    members: vec![m("sherlock", "analyst"), m("bender", "executor"), m("yoda", "reviewer")],
                    ..Default::default()
                },
            )
            .unwrap();
    }

    fn send<'a>(from: &'a str, to: &'a str, text: &'a str) -> SendMail<'a> {
        SendMail { team: "G-1", from, from_role: "analyst", to, text, level: None, intent: None, kind: "message" }
    }

    #[test]
    fn direct_and_broadcast_mail_with_leases() {
        let (_d, t) = fresh();
        team(&t);
        let bus = t.bus();
        bus.send(send("sherlock", "bender", "plan is ready")).unwrap();
        bus.send(send("bender", "all", "starting")).unwrap();
        assert!(bus.send(send("x", "nobody", "?")).unwrap_err().to_string().contains("no member \"nobody\""));
        assert!(bus.send(SendMail { level: Some("loud"), ..send("a", "bender", "x") }).is_err());

        let leased = bus.lease(Some("G-1"), "bender", 10).unwrap();
        assert_eq!(leased.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), vec!["plan is ready"]);
        assert!(bus.lease(Some("G-1"), "bender", 11).unwrap().is_empty(), "leased mail is not offered twice");
        assert_eq!(bus.release_lease(10).unwrap(), 1);
        let again = bus.lease(Some("G-1"), "bender", 12).unwrap();
        assert_eq!(again.len(), 1, "a failed turn gives the mail back");
        bus.complete_lease(12).unwrap();
        assert!(bus.pending(Some("G-1"), "bender").unwrap().is_empty());
        assert_eq!(bus.pending(None, ORCHESTRATOR).unwrap().len(), 1, "the orchestrator hears the broadcast");
        let boxes = bus.mailboxes_with_mail().unwrap();
        assert!(boxes.contains(&Mailbox { team: Some("G-1".into()), recipient: "yoda".into() }));
        assert!(boxes.contains(&Mailbox { team: None, recipient: ORCHESTRATOR.into() }));
        assert!(!boxes.iter().any(|b| b.recipient == "bender"));
    }

    #[test]
    fn stopped_teams_are_silenced_and_removed_members_lose_their_mail() {
        let (_d, t) = fresh();
        team(&t);
        let bus = t.bus();
        bus.send(send("bender", "yoda", "review please")).unwrap();
        bus.remove_member("G-1", "yoda").unwrap();
        assert!(bus.pending(Some("G-1"), "yoda").unwrap().is_empty());
        bus.set_state("G-1", "stopped", Some("task_closed"), "genie").unwrap();
        bus.send(send("bender", "orchestrator", "late")).unwrap();
        assert!(bus.pending(None, ORCHESTRATOR).unwrap().is_empty(), "a team stopped on purpose is silenced");
        assert!(bus.mailboxes_with_mail().unwrap().is_empty());
        let kinds: Vec<String> = t.events_after(0, 100).unwrap().into_iter().map(|e| e.kind).collect();
        assert!(kinds.contains(&"team.spawned".to_string()) && kinds.contains(&"team.stopped".to_string()));
    }

    #[test]
    fn digest_groups_by_team_and_puts_questions_first() {
        let mail = |id: i64, team: &str, from: &str, intent: Option<&str>, text: &str| Mail {
            id,
            at: String::new(),
            team: Some(team.into()),
            from: from.into(),
            from_role: "executor".into(),
            to: ORCHESTRATOR.into(),
            text: text.into(),
            urgent: false,
            level: "normal".into(),
            intent: intent.map(str::to_string),
            kind: "message".into(),
            task: None,
            delivered_at: None,
        };
        let d = render_digest(&[
            mail(1, "G-1", "bender", Some("done"), "old"),
            mail(2, "G-2", "baymax", Some("question"), "which API?"),
            mail(3, "G-1", "bender", Some("verdict"), "approved"),
            mail(4, "G-3", "walle", Some("fyi"), "note"),
        ]);
        assert!(d.starts_with("[genie digest · 3 messages in 2 team sections + FYI]"));
        let g2 = d.find("## G-2").unwrap();
        let g1 = d.find("## G-1").unwrap();
        assert!(g2 < g1, "the team waiting for an answer comes first:\n{d}");
        assert!(d.contains("approved") && !d.contains("old"));
    }

    #[test]
    fn names_are_unique_and_displayable() {
        let mut taken: std::collections::HashSet<String> = ["sherlock".to_string()].into();
        let a = pick_name("analyst", &mut taken);
        assert_ne!(a, "sherlock");
        assert_eq!(display_name("walle"), "WALL-E");
        assert_eq!(display_name("big-bird"), "Big Bird");
        let mut all: std::collections::HashSet<String> = name_pool("tester").iter().map(|s| s.to_string()).collect();
        assert_eq!(pick_name("tester", &mut all), "murphy2");
    }
}
