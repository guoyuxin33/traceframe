use rusqlite::{params, Connection, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const MAX_CONTEXT_MEMORIES: usize = 24;
const MAX_CONTEXT_SUMMARY_CHARS: usize = 12_000;
const RECENT_MESSAGES_AFTER_COMPACTION: usize = 4;
const MAX_SNAPSHOT_EVENTS_PER_SESSION: i64 = 1_000;
const MAX_SNAPSHOT_EVENTS: i64 = 5_000;
static ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct AppStore {
    path: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub context_summary: String,
    pub compacted_message_count: u64,
    pub branch: String,
    pub workspace_path: String,
    pub archived: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub session_id: String,
    pub author: String,
    pub role: String,
    pub body: String,
    pub meta: String,
    pub created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub session_id: Option<String>,
    pub workspace_path: String,
    pub scope: String,
    pub title: String,
    pub detail: String,
    pub kind: String,
    pub created_at: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub id: String,
    pub session_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub event_type: String,
    pub payload: Value,
    pub created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub sessions: Vec<SessionRecord>,
    pub messages: Vec<MessageRecord>,
    pub memories: Vec<MemoryRecord>,
    pub events: Vec<EventRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMessage {
    pub session_id: String,
    pub author: String,
    pub role: String,
    pub body: String,
    #[serde(default)]
    pub meta: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemory {
    pub session_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    pub scope: String,
    pub title: String,
    pub detail: String,
    pub kind: String,
}

fn normalize_memory(mut memory: NewMemory) -> Result<NewMemory, String> {
    if !matches!(memory.scope.as_str(), "session" | "project" | "global") {
        return Err("Memory scope is invalid".into());
    }
    if memory.title.trim().is_empty() || memory.detail.trim().is_empty() {
        return Err("Memory title and detail are required".into());
    }
    if memory.scope == "session" && memory.session_id.is_none() {
        return Err("Session memory requires an active session".into());
    }
    if memory.scope == "project" && memory.workspace_path.trim().is_empty() {
        return Err("Project memory requires an open workspace".into());
    }
    memory.title = memory.title.trim().to_owned();
    memory.detail = memory.detail.trim().to_owned();
    if memory.scope != "session" {
        memory.session_id = None;
    }
    if memory.scope == "global" {
        memory.workspace_path.clear();
    }
    Ok(memory)
}

fn ensure_session_context_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(sessions)")
        .map_err(|error| format!("Session schema could not be inspected: {error}"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Session schema could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Session schema could not be decoded: {error}"))?;
    if !columns.iter().any(|column| column == "context_summary") {
        connection
            .execute(
                "ALTER TABLE sessions ADD COLUMN context_summary TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("Session context summary could not be migrated: {error}"))?;
    }
    if !columns
        .iter()
        .any(|column| column == "compacted_message_count")
    {
        connection
            .execute(
                "ALTER TABLE sessions ADD COLUMN compacted_message_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Session compaction cursor could not be migrated: {error}"))?;
    }
    Ok(())
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn new_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        now_millis(),
        std::process::id(),
        ID_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

impl AppStore {
    pub fn initialize(&self, path: PathBuf) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Application data directory could not be created: {error}")
            })?;
        }
        {
            let mut stored_path = self
                .path
                .lock()
                .map_err(|_| "Application store state is unavailable".to_string())?;
            *stored_path = Some(path);
        }
        self.with_connection(|connection| {
            connection.execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 CREATE TABLE IF NOT EXISTS sessions (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   summary TEXT NOT NULL DEFAULT '',
                   context_summary TEXT NOT NULL DEFAULT '',
                   compacted_message_count INTEGER NOT NULL DEFAULT 0,
                   branch TEXT NOT NULL,
                   workspace_path TEXT NOT NULL DEFAULT '',
                   archived INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS messages (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                   author TEXT NOT NULL,
                   role TEXT NOT NULL,
                   body TEXT NOT NULL,
                   meta TEXT NOT NULL DEFAULT '',
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, created_at);
                 CREATE TABLE IF NOT EXISTS memories (
                   id TEXT PRIMARY KEY,
                   session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
                   workspace_path TEXT NOT NULL DEFAULT '',
                   scope TEXT NOT NULL,
                   title TEXT NOT NULL,
                   detail TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS memories_scope_time ON memories(scope, created_at);
                 CREATE TABLE IF NOT EXISTS runtime_events (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                   run_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   event_type TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS runtime_events_session_time ON runtime_events(session_id, created_at);",
            )
            .map_err(|error| format!("Application store could not be migrated: {error}"))?;
            ensure_session_context_columns(connection)?;
            Ok(())
        })
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let path = self
            .path
            .lock()
            .map_err(|_| "Application store state is unavailable".to_string())?
            .clone()
            .ok_or_else(|| "Application store has not been initialized".to_string())?;
        let connection = Connection::open(path)
            .map_err(|error| format!("Application store is unavailable: {error}"))?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;")
            .map_err(|error| format!("Application store could not be configured: {error}"))?;
        operation(&connection)
    }

    pub fn snapshot(&self) -> Result<AppSnapshot, String> {
        self.with_connection(|connection| {
            let sessions = query_sessions(connection)?;
            let messages = query_messages(connection)?;
            let memories = query_memories(connection)?;
            let events = query_events(connection)?;
            Ok(AppSnapshot {
                sessions,
                messages,
                memories,
                events,
            })
        })
    }

    pub fn session_events(&self, session_id: &str) -> Result<Vec<EventRecord>, String> {
        let session_id = session_id.trim();
        if session_id.is_empty() {
            return Err("Session ID is required".into());
        }
        self.with_connection(|connection| query_session_events(connection, session_id))
    }

    pub fn reconcile_interrupted_runs(&self) -> Result<usize, String> {
        self.with_connection(|connection| {
            let transaction = Transaction::new_unchecked(
                connection,
                TransactionBehavior::Immediate,
            )
            .map_err(|error| format!("Run recovery transaction could not be started: {error}"))?;
            let interrupted_runs = {
                let mut statement = transaction
                    .prepare(
                        "SELECT session_id, run_id, MAX(sequence), MAX(created_at)
                         FROM runtime_events
                         GROUP BY session_id, run_id
                         HAVING MAX(CASE WHEN event_type = 'run.created' THEN 1 ELSE 0 END) = 1
                            AND MAX(CASE WHEN event_type IN ('run.completed', 'run.failed', 'run.cancelled') THEN 1 ELSE 0 END) = 0
                         ORDER BY MAX(created_at) ASC, run_id ASC",
                    )
                    .map_err(|error| format!("Interrupted runs could not be inspected: {error}"))?;
                let records = statement
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, u64>(2)?,
                            row.get::<_, u64>(3)?,
                        ))
                    })
                    .map_err(|error| format!("Interrupted runs could not be read: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Interrupted runs could not be decoded: {error}"))?;
                records
            };

            for (session_id, run_id, last_sequence, last_created_at) in &interrupted_runs {
                let recovered_at = now_millis().max(last_created_at.saturating_add(1));
                let payload = serde_json::json!({
                    "reason": "app_interrupted",
                    "error": "Traceframe closed before this run reached a terminal state.",
                    "interrupted": true,
                    "recoveredOnStartup": true,
                    "recoveredAt": recovered_at,
                    "lastSequence": last_sequence,
                });
                let encoded = serde_json::to_string(&payload).map_err(|error| {
                    format!("Recovered run event could not be encoded: {error}")
                })?;
                transaction
                    .execute(
                        "INSERT INTO runtime_events (id, session_id, run_id, sequence, event_type, payload, created_at)
                         VALUES (?1, ?2, ?3, ?4, 'run.failed', ?5, ?6)",
                        params![
                            new_id("event"),
                            session_id,
                            run_id,
                            last_sequence.saturating_add(1),
                            encoded,
                            recovered_at
                        ],
                    )
                    .map_err(|error| format!("Interrupted run could not be finalized: {error}"))?;
                transaction
                    .execute(
                        "INSERT INTO messages (id, session_id, author, role, body, meta, created_at)
                         VALUES (?1, ?2, 'Runtime', 'system', ?3, ?4, ?5)",
                        params![
                            new_id("message"),
                            session_id,
                            "This run was interrupted before a final result was recorded. Partial output and workspace changes may remain; review the trace and working tree before continuing.",
                            format!("run interrupted · {run_id}"),
                            recovered_at
                        ],
                    )
                    .map_err(|error| format!("Interrupted run message could not be saved: {error}"))?;
                transaction
                    .execute(
                        "UPDATE sessions SET updated_at = MAX(updated_at, ?2) WHERE id = ?1",
                        params![session_id, recovered_at],
                    )
                    .map_err(|error| format!("Interrupted run session could not be updated: {error}"))?;
            }

            transaction
                .commit()
                .map_err(|error| format!("Run recovery could not be committed: {error}"))?;
            Ok(interrupted_runs.len())
        })
    }

    pub fn create_session_record(
        &self,
        title: String,
        branch: String,
        workspace_path: String,
    ) -> Result<SessionRecord, String> {
        let timestamp = now_millis();
        let session = SessionRecord {
            id: new_id("session"),
            title,
            summary: String::new(),
            context_summary: String::new(),
            compacted_message_count: 0,
            branch,
            workspace_path,
            archived: false,
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO sessions (id, title, summary, context_summary, compacted_message_count, branch, workspace_path, archived, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '', 0, ?4, ?5, 0, ?6, ?6)",
                params![session.id, session.title, session.summary, session.branch, session.workspace_path, timestamp],
            ).map_err(|error| format!("Session could not be created: {error}"))?;
            Ok(session.clone())
        })
    }

    pub fn append_message_record(&self, message: NewMessage) -> Result<MessageRecord, String> {
        if !matches!(message.role.as_str(), "user" | "agent" | "system") {
            return Err("Message role is invalid".into());
        }
        if message.body.trim().is_empty() {
            return Err("Message body cannot be empty".into());
        }
        let record = MessageRecord {
            id: new_id("message"),
            session_id: message.session_id,
            author: message.author,
            role: message.role,
            body: message.body,
            meta: message.meta,
            created_at: now_millis(),
        };
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("Message transaction could not be started: {error}"))?;
            transaction.execute(
                "INSERT INTO messages (id, session_id, author, role, body, meta, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![record.id, record.session_id, record.author, record.role, record.body, record.meta, record.created_at],
            ).map_err(|error| format!("Message could not be saved: {error}"))?;
            let updated = transaction.execute(
                "UPDATE sessions SET updated_at = ?2,
                 summary = CASE WHEN summary = '' THEN substr(?3, 1, 160) ELSE summary END,
                 title = CASE WHEN title = 'Untitled task' THEN substr(?3, 1, 48) ELSE title END WHERE id = ?1",
                params![record.session_id, record.created_at, record.body],
            ).map_err(|error| format!("Session could not be updated: {error}"))?;
            if updated != 1 {
                return Err("Session could not be found".into());
            }
            transaction
                .commit()
                .map_err(|error| format!("Message could not be committed: {error}"))?;
            Ok(record.clone())
        })
    }

    pub fn update_session_scope_record(
        &self,
        session_id: &str,
        branch: String,
        workspace_path: String,
    ) -> Result<(), String> {
        let branch = branch.trim();
        if branch.is_empty() {
            return Err("Session branch cannot be empty".into());
        }
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE sessions SET branch = ?2, workspace_path = ?3, updated_at = ?4 WHERE id = ?1",
                    params![session_id, branch, workspace_path, now_millis()],
                )
                .map_err(|error| format!("Session scope could not be updated: {error}"))?;
            if updated != 1 {
                return Err("Session could not be found".into());
            }
            Ok(())
        })
    }

    pub fn archive_session_record(&self, session_id: &str, archived: bool) -> Result<(), String> {
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE sessions SET archived = ?2, updated_at = ?3 WHERE id = ?1",
                    params![session_id, archived as i64, now_millis()],
                )
                .map_err(|error| format!("Session could not be archived: {error}"))?;
            if updated != 1 {
                return Err("Session could not be found".into());
            }
            Ok(())
        })
    }

    pub fn save_memory_record(&self, memory: NewMemory) -> Result<MemoryRecord, String> {
        let memory = normalize_memory(memory)?;
        let record = MemoryRecord {
            id: new_id("memory"),
            session_id: memory.session_id,
            workspace_path: memory.workspace_path,
            scope: memory.scope,
            title: memory.title,
            detail: memory.detail,
            kind: memory.kind,
            created_at: now_millis(),
        };
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO memories (id, session_id, workspace_path, scope, title, detail, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![record.id, record.session_id, record.workspace_path, record.scope, record.title, record.detail, record.kind, record.created_at],
            ).map_err(|error| format!("Memory could not be saved: {error}"))?;
            Ok(record.clone())
        })
    }

    pub fn update_memory_record(
        &self,
        memory_id: &str,
        memory: NewMemory,
    ) -> Result<MemoryRecord, String> {
        let memory = normalize_memory(memory)?;
        self.with_connection(|connection| {
            let updated = connection
                .execute(
                    "UPDATE memories SET session_id = ?2, workspace_path = ?3, scope = ?4, title = ?5, detail = ?6, kind = ?7 WHERE id = ?1",
                    params![memory_id, memory.session_id, memory.workspace_path, memory.scope, memory.title, memory.detail, memory.kind],
                )
                .map_err(|error| format!("Memory could not be updated: {error}"))?;
            if updated != 1 {
                return Err("Memory could not be found".into());
            }
            connection
                .query_row(
                    "SELECT id, session_id, workspace_path, scope, title, detail, kind, created_at FROM memories WHERE id = ?1",
                    [memory_id],
                    map_memory,
                )
                .map_err(|error| format!("Updated memory could not be read: {error}"))
        })
    }

    pub fn delete_memory_record(&self, memory_id: &str) -> Result<(), String> {
        self.with_connection(|connection| {
            let deleted = connection
                .execute("DELETE FROM memories WHERE id = ?1", [memory_id])
                .map_err(|error| format!("Memory could not be deleted: {error}"))?;
            if deleted != 1 {
                return Err("Memory could not be found".into());
            }
            Ok(())
        })
    }

    pub fn append_event(
        &self,
        session_id: &str,
        run_id: &str,
        sequence: u64,
        event_type: &str,
        payload: &Value,
    ) -> Result<EventRecord, String> {
        let record = EventRecord {
            id: new_id("event"),
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            sequence,
            event_type: event_type.to_owned(),
            payload: payload.clone(),
            created_at: now_millis(),
        };
        let encoded = serde_json::to_string(payload)
            .map_err(|error| format!("Runtime event could not be encoded: {error}"))?;
        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO runtime_events (id, session_id, run_id, sequence, event_type, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![record.id, record.session_id, record.run_id, record.sequence, record.event_type, encoded, record.created_at],
            ).map_err(|error| format!("Runtime event could not be saved: {error}"))?;
            Ok(record.clone())
        })
    }

    pub fn context_messages(
        &self,
        session_id: &str,
    ) -> Result<(String, Vec<MessageRecord>), String> {
        self.with_connection(|connection| {
            let (summary, compacted_message_count) = connection
                .query_row(
                    "SELECT context_summary, compacted_message_count FROM sessions WHERE id = ?1",
                    [session_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
                )
                .map_err(|error| format!("Session context is unavailable: {error}"))?;
            let mut statement = connection
                .prepare(
                    "WITH uncompacted AS (
                       SELECT id, session_id, author, role, body, meta, created_at, rowid AS source_rowid
                       FROM messages
                       WHERE session_id = ?1
                       ORDER BY created_at ASC, rowid ASC
                       LIMIT -1 OFFSET ?2
                     )
                     SELECT id, session_id, author, role, body, meta, created_at
                     FROM uncompacted
                     ORDER BY created_at DESC, source_rowid DESC
                     LIMIT 30",
                )
                .map_err(|error| format!("Session messages are unavailable: {error}"))?;
            let mut messages = statement
                .query_map(params![session_id, compacted_message_count], map_message)
                .map_err(|error| format!("Session messages could not be read: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Session messages could not be decoded: {error}"))?;
            messages.reverse();
            Ok((summary, messages))
        })
    }

    pub fn context_memories(
        &self,
        session_id: &str,
        workspace_path: &str,
    ) -> Result<Vec<MemoryRecord>, String> {
        self.with_connection(|connection| {
            let mut statement = connection
                .prepare(
                    "SELECT id, session_id, workspace_path, scope, title, detail, kind, created_at
                     FROM memories
                     WHERE (scope = 'session' AND session_id = ?1)
                        OR (scope = 'project' AND workspace_path = ?2)
                        OR scope = 'global'
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?3",
                )
                .map_err(|error| format!("Session memories are unavailable: {error}"))?;
            let memories = statement
                .query_map(
                    params![session_id, workspace_path, MAX_CONTEXT_MEMORIES as u64],
                    map_memory,
                )
                .map_err(|error| format!("Session memories could not be read: {error}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| format!("Session memories could not be decoded: {error}"))?;
            Ok(memories)
        })
    }

    pub fn compact_session_record(&self, session_id: &str) -> Result<String, String> {
        let (summary, compacted_count, message_count, messages_to_compact) =
            self.with_connection(|connection| {
                let (summary, compacted_count) = connection
                    .query_row(
                        "SELECT context_summary, compacted_message_count FROM sessions WHERE id = ?1",
                        [session_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?)),
                    )
                    .map_err(|error| format!("Session context is unavailable: {error}"))?;
                let message_count = connection
                    .query_row(
                        "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                        [session_id],
                        |row| row.get::<_, u64>(0),
                    )
                    .map_err(|error| format!("Session message count is unavailable: {error}"))?;
                if message_count.saturating_sub(compacted_count) < 2 {
                    return Err("At least two uncompacted messages are required".into());
                }
                let uncompacted_count = message_count.saturating_sub(compacted_count);
                let retain = RECENT_MESSAGES_AFTER_COMPACTION
                    .min(uncompacted_count.saturating_sub(1) as usize) as u64;
                let next_compacted_count = message_count.saturating_sub(retain);
                let to_compact = next_compacted_count.saturating_sub(compacted_count);
                let mut statement = connection
                    .prepare(
                        "SELECT id, session_id, author, role, body, meta, created_at
                         FROM messages WHERE session_id = ?1
                         ORDER BY created_at ASC, rowid ASC
                         LIMIT ?2 OFFSET ?3",
                    )
                    .map_err(|error| format!("Session messages are unavailable: {error}"))?;
                let messages = statement
                    .query_map(params![session_id, to_compact, compacted_count], map_message)
                    .map_err(|error| format!("Session messages could not be read: {error}"))?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| format!("Session messages could not be decoded: {error}"))?;
                Ok((summary, next_compacted_count, message_count, messages))
            })?;
        let transcript = messages_to_compact
            .iter()
            .map(|message| {
                let body = message.body.chars().take(320).collect::<String>();
                format!("{}: {}", message.author, body)
            })
            .collect::<Vec<_>>()
            .join("\n");
        let merged = if summary.trim().is_empty() {
            transcript
        } else {
            format!("{}\n{}", summary.trim(), transcript)
        };
        let summary = merged
            .chars()
            .rev()
            .take(MAX_CONTEXT_SUMMARY_CHARS)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>();
        let payload = serde_json::json!({
            "messageCount": messages_to_compact.len(),
            "totalMessageCount": message_count,
            "remainingMessageCount": message_count.saturating_sub(compacted_count),
            "summaryChars": summary.chars().count()
        });
        let event = EventRecord {
            id: new_id("event"),
            session_id: session_id.to_owned(),
            run_id: "manual-compaction".into(),
            sequence: 0,
            event_type: "context.compacted".into(),
            payload: payload.clone(),
            created_at: now_millis(),
        };
        let encoded = serde_json::to_string(&payload)
            .map_err(|error| format!("Runtime event could not be encoded: {error}"))?;
        self.with_connection(|connection| {
            let transaction = connection
                .unchecked_transaction()
                .map_err(|error| format!("Compaction transaction could not be started: {error}"))?;
            let updated = transaction
                .execute(
                    "UPDATE sessions SET context_summary = ?2, compacted_message_count = ?3, updated_at = ?4 WHERE id = ?1",
                    params![session_id, summary, compacted_count, now_millis()],
                )
                .map_err(|error| format!("Session could not be compacted: {error}"))?;
            if updated != 1 {
                return Err("Session could not be found for compaction".into());
            }
            transaction.execute(
                "INSERT INTO runtime_events (id, session_id, run_id, sequence, event_type, payload, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![event.id, event.session_id, event.run_id, event.sequence, event.event_type, encoded, event.created_at],
            ).map_err(|error| format!("Compaction event could not be saved: {error}"))?;
            transaction
                .commit()
                .map_err(|error| format!("Session compaction could not be committed: {error}"))?;
            Ok(())
        })?;
        Ok(summary)
    }
}

fn map_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        context_summary: row.get(3)?,
        compacted_message_count: row.get(4)?,
        branch: row.get(5)?,
        workspace_path: row.get(6)?,
        archived: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn map_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRecord> {
    Ok(MessageRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        author: row.get(2)?,
        role: row.get(3)?,
        body: row.get(4)?,
        meta: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn map_memory(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        workspace_path: row.get(2)?,
        scope: row.get(3)?,
        title: row.get(4)?,
        detail: row.get(5)?,
        kind: row.get(6)?,
        created_at: row.get(7)?,
    })
}

fn query_sessions(connection: &Connection) -> Result<Vec<SessionRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT id, title, summary, context_summary, compacted_message_count, branch, workspace_path, archived, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
    ).map_err(|error| format!("Sessions are unavailable: {error}"))?;
    let records = statement
        .query_map([], map_session)
        .map_err(|error| format!("Sessions could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Sessions could not be decoded: {error}"))?;
    Ok(records)
}

fn query_messages(connection: &Connection) -> Result<Vec<MessageRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT id, session_id, author, role, body, meta, created_at FROM messages ORDER BY created_at ASC, rowid ASC",
    ).map_err(|error| format!("Messages are unavailable: {error}"))?;
    let records = statement
        .query_map([], map_message)
        .map_err(|error| format!("Messages could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Messages could not be decoded: {error}"))?;
    Ok(records)
}

fn query_memories(connection: &Connection) -> Result<Vec<MemoryRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT id, session_id, workspace_path, scope, title, detail, kind, created_at FROM memories ORDER BY created_at DESC",
    ).map_err(|error| format!("Memories are unavailable: {error}"))?;
    let records = statement
        .query_map([], map_memory)
        .map_err(|error| format!("Memories could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Memories could not be decoded: {error}"))?;
    Ok(records)
}

fn query_events(connection: &Connection) -> Result<Vec<EventRecord>, String> {
    let mut statement = connection.prepare(
        "SELECT id, session_id, run_id, sequence, event_type, payload, created_at
           FROM (
             SELECT id, session_id, run_id, sequence, event_type, payload, created_at,
                    ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, rowid DESC) AS session_rank,
                    rowid AS event_rowid
               FROM runtime_events
              WHERE event_type <> 'model.delta'
           )
          WHERE session_rank <= ?1
          ORDER BY created_at DESC, event_rowid DESC
          LIMIT ?2",
    ).map_err(|error| format!("Runtime events are unavailable: {error}"))?;
    let records = statement
        .query_map(
            params![MAX_SNAPSHOT_EVENTS_PER_SESSION, MAX_SNAPSHOT_EVENTS],
            map_event,
        )
        .map_err(|error| format!("Runtime events could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Runtime events could not be decoded: {error}"))?;
    Ok(records)
}

fn map_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRecord> {
    let payload: String = row.get(5)?;
    Ok(EventRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        run_id: row.get(2)?,
        sequence: row.get(3)?,
        event_type: row.get(4)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: row.get(6)?,
    })
}

fn query_session_events(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<EventRecord>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, session_id, run_id, sequence, event_type, payload, created_at
           FROM runtime_events
          WHERE session_id = ?1 AND event_type <> 'model.delta'
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?2",
        )
        .map_err(|error| format!("Session events are unavailable: {error}"))?;
    let records = statement
        .query_map(
            params![session_id, MAX_SNAPSHOT_EVENTS_PER_SESSION],
            map_event,
        )
        .map_err(|error| format!("Session events could not be read: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Session events could not be decoded: {error}"))?;
    Ok(records)
}

#[tauri::command]
pub fn app_snapshot(store: State<'_, AppStore>) -> Result<AppSnapshot, String> {
    store.snapshot()
}

#[tauri::command]
pub fn session_events(
    session_id: String,
    store: State<'_, AppStore>,
) -> Result<Vec<EventRecord>, String> {
    store.session_events(&session_id)
}

#[tauri::command]
pub fn create_session(
    title: String,
    branch: String,
    workspace_path: String,
    store: State<'_, AppStore>,
) -> Result<SessionRecord, String> {
    store.create_session_record(title, branch, workspace_path)
}

#[tauri::command]
pub fn update_session_scope(
    session_id: String,
    branch: String,
    workspace_path: String,
    store: State<'_, AppStore>,
) -> Result<(), String> {
    store.update_session_scope_record(&session_id, branch, workspace_path)
}

#[tauri::command]
pub fn archive_session(
    session_id: String,
    archived: bool,
    store: State<'_, AppStore>,
) -> Result<(), String> {
    store.archive_session_record(&session_id, archived)
}

#[tauri::command]
pub fn append_message(
    message: NewMessage,
    store: State<'_, AppStore>,
) -> Result<MessageRecord, String> {
    store.append_message_record(message)
}

#[tauri::command]
pub fn save_memory(memory: NewMemory, store: State<'_, AppStore>) -> Result<MemoryRecord, String> {
    store.save_memory_record(memory)
}

#[tauri::command]
pub fn update_memory(
    memory_id: String,
    memory: NewMemory,
    store: State<'_, AppStore>,
) -> Result<MemoryRecord, String> {
    store.update_memory_record(&memory_id, memory)
}

#[tauri::command]
pub fn delete_memory(memory_id: String, store: State<'_, AppStore>) -> Result<(), String> {
    store.delete_memory_record(&memory_id)
}

#[tauri::command]
pub fn compact_session(session_id: String, store: State<'_, AppStore>) -> Result<String, String> {
    store.compact_session_record(&session_id)
}

#[cfg(test)]
mod tests {
    use super::{query_events, query_session_events, AppStore, NewMemory, NewMessage};
    use rusqlite::Connection;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn session_event_query_recovers_traces_omitted_from_the_global_snapshot() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE runtime_events (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   run_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   event_type TEXT NOT NULL,
                   payload TEXT NOT NULL,
                   created_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        for session in 0..6 {
            for sequence in 0..1_000 {
                let ordinal = session * 1_000 + sequence;
                transaction
                    .execute(
                        "INSERT INTO runtime_events (id, session_id, run_id, sequence, event_type, payload, created_at)
                         VALUES (?1, ?2, ?3, ?4, 'tool.completed', '{}', ?5)",
                        rusqlite::params![
                            format!("event-{ordinal}"),
                            format!("session-{session}"),
                            format!("run-{session}"),
                            sequence,
                            ordinal,
                        ],
                    )
                    .unwrap();
            }
        }
        transaction
            .execute(
                "INSERT INTO runtime_events (id, session_id, run_id, sequence, event_type, payload, created_at)
                 VALUES ('delta', 'session-0', 'run-0', 1001, 'model.delta', '{}', 10000)",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();

        let snapshot = query_events(&connection).unwrap();
        assert_eq!(snapshot.len(), 5_000);
        assert!(!snapshot.iter().any(|event| event.session_id == "session-0"));

        let restored = query_session_events(&connection, "session-0").unwrap();
        assert_eq!(restored.len(), 1_000);
        assert!(restored
            .iter()
            .all(|event| event.event_type != "model.delta"));
    }

    #[test]
    fn persists_sessions_messages_memories_and_compaction() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-store-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("traceframe.sqlite3");
        let store = AppStore::default();
        store.initialize(database.clone()).unwrap();
        let session = store
            .create_session_record("Test run".into(), "main".into(), "/tmp/project".into())
            .unwrap();
        let other_session = store
            .create_session_record("Other run".into(), "main".into(), "/tmp/other".into())
            .unwrap();
        store
            .append_message_record(NewMessage {
                session_id: session.id.clone(),
                author: "You".into(),
                role: "user".into(),
                body: "Keep the API stable".into(),
                meta: String::new(),
            })
            .unwrap();
        store
            .append_message_record(NewMessage {
                session_id: session.id.clone(),
                author: "Agent".into(),
                role: "agent".into(),
                body: "The public interface remains unchanged".into(),
                meta: String::new(),
            })
            .unwrap();
        store
            .save_memory_record(NewMemory {
                session_id: Some(session.id.clone()),
                workspace_path: "/tmp/project".into(),
                scope: "session".into(),
                title: "API".into(),
                detail: "Keep it stable".into(),
                kind: "constraint".into(),
            })
            .unwrap();
        let project_memory = store
            .save_memory_record(NewMemory {
                session_id: None,
                workspace_path: "/tmp/project".into(),
                scope: "project".into(),
                title: "Build".into(),
                detail: "Run cargo test".into(),
                kind: "workflow".into(),
            })
            .unwrap();
        let global_memory = store
            .save_memory_record(NewMemory {
                session_id: None,
                workspace_path: String::new(),
                scope: "global".into(),
                title: "Style".into(),
                detail: "Prefer small focused changes".into(),
                kind: "preference".into(),
            })
            .unwrap();
        let other_session_memory = store
            .save_memory_record(NewMemory {
                session_id: Some(other_session.id.clone()),
                workspace_path: "/tmp/other".into(),
                scope: "session".into(),
                title: "Other session".into(),
                detail: "Must not leak".into(),
                kind: "constraint".into(),
            })
            .unwrap();
        let other_project_memory = store
            .save_memory_record(NewMemory {
                session_id: None,
                workspace_path: "/tmp/other".into(),
                scope: "project".into(),
                title: "Other project".into(),
                detail: "Must not leak".into(),
                kind: "constraint".into(),
            })
            .unwrap();
        store
            .append_event(
                &session.id,
                "run-1",
                0,
                "run.created",
                &serde_json::json!({ "provider": "test" }),
            )
            .unwrap();
        let summary = store.compact_session_record(&session.id).unwrap();
        assert!(summary.contains("Keep the API stable"));

        drop(store);
        let reopened = AppStore::default();
        reopened.initialize(database).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(snapshot.sessions.len(), 2);
        assert_eq!(snapshot.messages.len(), 2);
        assert_eq!(snapshot.memories.len(), 5);
        assert!(snapshot
            .sessions
            .iter()
            .find(|record| record.id == session.id)
            .is_some_and(|record| {
                record.context_summary == summary && record.compacted_message_count == 1
            }));
        assert!(snapshot.events.iter().any(|event| {
            event.session_id == session.id && event.event_type == "context.compacted"
        }));
        assert!(snapshot
            .events
            .iter()
            .any(|event| event.run_id == "run-1" && event.event_type == "run.created"));

        let context = reopened
            .context_memories(&session.id, "/tmp/project")
            .unwrap();
        let context_ids = context
            .iter()
            .map(|memory| memory.id.as_str())
            .collect::<Vec<_>>();
        assert!(context_ids.contains(&project_memory.id.as_str()));
        assert!(context_ids.contains(&global_memory.id.as_str()));
        assert!(!context_ids.contains(&other_session_memory.id.as_str()));
        assert!(!context_ids.contains(&other_project_memory.id.as_str()));
        let persisted_messages = reopened.context_messages(&session.id).unwrap().1;
        assert_eq!(persisted_messages.len(), 1);
        assert_eq!(
            persisted_messages[0].body,
            "The public interface remains unchanged"
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_interrupted_runs_once_with_a_visible_runtime_message() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-recovery-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("traceframe.sqlite3");
        let store = AppStore::default();
        store.initialize(database.clone()).unwrap();
        let session = store
            .create_session_record("Recovery".into(), "main".into(), "/tmp/project".into())
            .unwrap();
        store
            .append_event(
                &session.id,
                "interrupted-run",
                0,
                "run.created",
                &serde_json::json!({ "provider": "test" }),
            )
            .unwrap();
        for event_type in ["run.failed", "run.cancelled"] {
            let run_id = format!("terminal-{event_type}");
            store
                .append_event(
                    &session.id,
                    &run_id,
                    0,
                    "run.created",
                    &serde_json::json!({ "provider": "test" }),
                )
                .unwrap();
            store
                .append_event(&session.id, &run_id, 1, event_type, &serde_json::json!({}))
                .unwrap();
        }
        store
            .append_event(
                &session.id,
                "interrupted-run",
                1,
                "tool.completed",
                &serde_json::json!({ "tool": "read_file" }),
            )
            .unwrap();
        store
            .append_event(
                &session.id,
                "completed-run",
                0,
                "run.created",
                &serde_json::json!({ "provider": "test" }),
            )
            .unwrap();
        store
            .append_event(
                &session.id,
                "completed-run",
                1,
                "run.completed",
                &serde_json::json!({ "usage": {} }),
            )
            .unwrap();
        store
            .append_event(
                &session.id,
                "event-without-run",
                0,
                "tool.failed",
                &serde_json::json!({ "error": "fixture" }),
            )
            .unwrap();

        assert_eq!(store.reconcile_interrupted_runs().unwrap(), 1);
        assert_eq!(store.reconcile_interrupted_runs().unwrap(), 0);
        let snapshot = store.snapshot().unwrap();
        let recovered = snapshot
            .events
            .iter()
            .filter(|event| event.run_id == "interrupted-run" && event.event_type == "run.failed")
            .collect::<Vec<_>>();
        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered[0].sequence, 2);
        assert_eq!(recovered[0].payload["reason"], "app_interrupted");
        assert_eq!(recovered[0].payload["lastSequence"], 1);
        assert!(!snapshot
            .events
            .iter()
            .any(|event| event.run_id == "completed-run" && event.event_type == "run.failed"));
        assert!(!snapshot
            .events
            .iter()
            .any(|event| event.run_id == "event-without-run" && event.event_type == "run.failed"));
        assert_eq!(
            snapshot
                .events
                .iter()
                .filter(|event| event.payload["reason"] == "app_interrupted")
                .count(),
            1
        );
        let messages = snapshot
            .messages
            .iter()
            .filter(|message| message.meta == "run interrupted · interrupted-run")
            .collect::<Vec<_>>();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].author, "Runtime");
        assert_eq!(messages[0].role, "system");
        drop(store);

        let reopened = AppStore::default();
        reopened.initialize(database).unwrap();
        assert_eq!(reopened.reconcile_interrupted_runs().unwrap(), 0);
        let snapshot = reopened.snapshot().unwrap();
        assert_eq!(
            snapshot
                .events
                .iter()
                .filter(|event| {
                    event.run_id == "interrupted-run" && event.event_type == "run.failed"
                })
                .count(),
            1
        );
        assert_eq!(
            snapshot
                .messages
                .iter()
                .filter(|message| message.meta == "run interrupted · interrupted-run")
                .count(),
            1
        );
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_run_recovery_rolls_back_event_when_message_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-recovery-rollback-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("traceframe.sqlite3");
        let store = AppStore::default();
        store.initialize(database.clone()).unwrap();
        let session = store
            .create_session_record("Recovery".into(), "main".into(), "/tmp/project".into())
            .unwrap();
        store
            .append_event(
                &session.id,
                "interrupted-run",
                0,
                "run.created",
                &serde_json::json!({}),
            )
            .unwrap();
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TRIGGER reject_recovery_message
                         BEFORE INSERT ON messages
                         WHEN NEW.meta LIKE 'run interrupted%'
                         BEGIN SELECT RAISE(ABORT, 'recovery message rejected'); END;",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();

        assert!(store.reconcile_interrupted_runs().is_err());
        let connection = Connection::open(database).unwrap();
        let recovered_events = connection
            .query_row(
                "SELECT COUNT(*) FROM runtime_events WHERE run_id = 'interrupted-run' AND event_type = 'run.failed'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap();
        assert_eq!(recovered_events, 0);
        drop(connection);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn persists_session_lifecycle_and_memory_mutations_across_reopen() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-lifecycle-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("traceframe.sqlite3");
        let store = AppStore::default();
        store.initialize(database.clone()).unwrap();
        let session = store
            .create_session_record("Untitled task".into(), "main".into(), "/tmp/old".into())
            .unwrap();
        let message = store
            .append_message_record(NewMessage {
                session_id: session.id.clone(),
                author: "You".into(),
                role: "user".into(),
                body: "Persist this contract".into(),
                meta: "scope: feature/persistence".into(),
            })
            .unwrap();
        let memory = store
            .save_memory_record(NewMemory {
                session_id: Some(session.id.clone()),
                workspace_path: "/tmp/old".into(),
                scope: "session".into(),
                title: "Original title".into(),
                detail: "Original detail".into(),
                kind: "Decision".into(),
            })
            .unwrap();
        store
            .update_memory_record(
                &memory.id,
                NewMemory {
                    session_id: None,
                    workspace_path: "/tmp/new".into(),
                    scope: "project".into(),
                    title: "  Updated title  ".into(),
                    detail: "  Updated detail  ".into(),
                    kind: "Constraint".into(),
                },
            )
            .unwrap();
        store
            .update_session_scope_record(
                &session.id,
                "  feature/persistence  ".into(),
                "/tmp/new".into(),
            )
            .unwrap();
        store.archive_session_record(&session.id, true).unwrap();
        drop(store);

        let reopened = AppStore::default();
        reopened.initialize(database.clone()).unwrap();
        let snapshot = reopened.snapshot().unwrap();
        let persisted_session = snapshot
            .sessions
            .iter()
            .find(|record| record.id == session.id)
            .unwrap();
        assert!(persisted_session.archived);
        assert_eq!(persisted_session.branch, "feature/persistence");
        assert_eq!(persisted_session.workspace_path, "/tmp/new");
        assert_eq!(persisted_session.title, "Persist this contract");
        assert_eq!(persisted_session.summary, "Persist this contract");
        assert!(snapshot.messages.iter().any(|record| {
            record.id == message.id && record.meta == "scope: feature/persistence"
        }));
        assert!(snapshot.memories.iter().any(|record| {
            record.id == memory.id
                && record.session_id.is_none()
                && record.scope == "project"
                && record.workspace_path == "/tmp/new"
                && record.title == "Updated title"
                && record.detail == "Updated detail"
        }));

        reopened.archive_session_record(&session.id, false).unwrap();
        reopened.delete_memory_record(&memory.id).unwrap();
        assert_eq!(
            reopened.delete_memory_record(&memory.id).unwrap_err(),
            "Memory could not be found"
        );
        assert_eq!(
            reopened
                .archive_session_record("missing-session", true)
                .unwrap_err(),
            "Session could not be found"
        );
        assert_eq!(
            reopened
                .update_session_scope_record(
                    "missing-session",
                    "main".into(),
                    "/tmp/missing".into(),
                )
                .unwrap_err(),
            "Session could not be found"
        );
        drop(reopened);

        let restored = AppStore::default();
        restored.initialize(database).unwrap();
        let snapshot = restored.snapshot().unwrap();
        assert!(
            !snapshot
                .sessions
                .iter()
                .find(|record| record.id == session.id)
                .unwrap()
                .archived
        );
        assert!(!snapshot
            .memories
            .iter()
            .any(|record| record.id == memory.id));
        drop(restored);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rolls_back_multi_table_mutations_when_the_follow_up_write_fails() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-atomicity-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record("Untitled task".into(), "main".into(), "/tmp/project".into())
            .unwrap();

        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TRIGGER reject_session_summary
                         BEFORE UPDATE OF summary ON sessions
                         BEGIN SELECT RAISE(ABORT, 'summary update rejected'); END;",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(store
            .append_message_record(NewMessage {
                session_id: session.id.clone(),
                author: "You".into(),
                role: "user".into(),
                body: "Must roll back".into(),
                meta: String::new(),
            })
            .is_err());
        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.messages.is_empty());
        assert!(snapshot.sessions[0].summary.is_empty());

        store
            .with_connection(|connection| {
                connection
                    .execute_batch("DROP TRIGGER reject_session_summary;")
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        for body in ["first", "second"] {
            store
                .append_message_record(NewMessage {
                    session_id: session.id.clone(),
                    author: "Agent".into(),
                    role: "agent".into(),
                    body: body.into(),
                    meta: String::new(),
                })
                .unwrap();
        }
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "CREATE TRIGGER reject_compaction_event
                         BEFORE INSERT ON runtime_events
                         BEGIN SELECT RAISE(ABORT, 'event insert rejected'); END;",
                    )
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(store.compact_session_record(&session.id).is_err());
        let snapshot = store.snapshot().unwrap();
        let persisted_session = snapshot
            .sessions
            .iter()
            .find(|record| record.id == session.id)
            .unwrap();
        assert!(persisted_session.context_summary.is_empty());
        assert_eq!(persisted_session.compacted_message_count, 0);
        assert!(snapshot.events.is_empty());

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repeated_compaction_only_advances_the_context_cursor() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-compaction-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record("Compaction".into(), "main".into(), "/tmp/project".into())
            .unwrap();

        for index in 0..6 {
            store
                .append_message_record(NewMessage {
                    session_id: session.id.clone(),
                    author: "Agent".into(),
                    role: "agent".into(),
                    body: format!("message-{index}"),
                    meta: String::new(),
                })
                .unwrap();
        }
        store.compact_session_record(&session.id).unwrap();
        let first = store
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|record| record.id == session.id)
            .unwrap();
        assert_eq!(first.compacted_message_count, 2);

        for index in 6..8 {
            store
                .append_message_record(NewMessage {
                    session_id: session.id.clone(),
                    author: "Agent".into(),
                    role: "agent".into(),
                    body: format!("message-{index}"),
                    meta: String::new(),
                })
                .unwrap();
        }
        let summary = store.compact_session_record(&session.id).unwrap();
        let second = store
            .snapshot()
            .unwrap()
            .sessions
            .into_iter()
            .find(|record| record.id == session.id)
            .unwrap();
        assert_eq!(second.compacted_message_count, 4);
        assert!(summary.contains("message-0"));
        assert!(summary.contains("message-3"));
        let remaining = store.context_messages(&session.id).unwrap().1;
        assert_eq!(remaining.len(), 4);
        assert_eq!(remaining[0].body, "message-4");

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_memory_creation_and_updates_before_writing() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-memory-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let store = AppStore::default();
        store.initialize(root.join("traceframe.sqlite3")).unwrap();
        let session = store
            .create_session_record("Memory".into(), "main".into(), "/tmp/project".into())
            .unwrap();

        let invalid = NewMemory {
            session_id: Some(session.id.clone()),
            workspace_path: "/tmp/project".into(),
            scope: "unknown".into(),
            title: "Title".into(),
            detail: "Detail".into(),
            kind: "constraint".into(),
        };
        assert_eq!(
            store.save_memory_record(invalid).err().unwrap(),
            "Memory scope is invalid"
        );

        let saved = store
            .save_memory_record(NewMemory {
                session_id: Some(session.id),
                workspace_path: "/tmp/project".into(),
                scope: "session".into(),
                title: "Original".into(),
                detail: "Keep this".into(),
                kind: "constraint".into(),
            })
            .unwrap();
        let update_error = store
            .update_memory_record(
                &saved.id,
                NewMemory {
                    session_id: saved.session_id.clone(),
                    workspace_path: saved.workspace_path.clone(),
                    scope: "session".into(),
                    title: "Original".into(),
                    detail: "  ".into(),
                    kind: "constraint".into(),
                },
            )
            .err()
            .unwrap();
        assert_eq!(update_error, "Memory title and detail are required");
        assert_eq!(store.snapshot().unwrap().memories[0].detail, "Keep this");

        let updated = store
            .update_memory_record(
                &saved.id,
                NewMemory {
                    session_id: saved.session_id,
                    workspace_path: saved.workspace_path,
                    scope: "global".into(),
                    title: "  Shared rule  ".into(),
                    detail: "  Keep it focused  ".into(),
                    kind: "constraint".into(),
                },
            )
            .unwrap();
        assert_eq!(updated.title, "Shared rule");
        assert_eq!(updated.detail, "Keep it focused");
        assert!(updated.session_id.is_none());
        assert!(updated.workspace_path.is_empty());

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migrates_existing_session_tables_with_context_columns() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("traceframe-migration-test-{nonce}"));
        std::fs::create_dir_all(&root).unwrap();
        let database = root.join("traceframe.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (
                   id TEXT PRIMARY KEY,
                   title TEXT NOT NULL,
                   summary TEXT NOT NULL DEFAULT '',
                   branch TEXT NOT NULL,
                   workspace_path TEXT NOT NULL DEFAULT '',
                   archived INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        drop(connection);

        let store = AppStore::default();
        store.initialize(database).unwrap();
        let session = store
            .create_session_record("Migrated".into(), "main".into(), "/tmp/project".into())
            .unwrap();
        assert!(session.context_summary.is_empty());
        assert_eq!(session.compacted_message_count, 0);

        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
