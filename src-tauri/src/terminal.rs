use crate::WorkspaceAccess;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{ipc::Channel, State};

const DEFAULT_COLS: u16 = 100;
const DEFAULT_ROWS: u16 = 28;
const MIN_COLS: u16 = 2;
const MAX_COLS: u16 = 500;
const MIN_ROWS: u16 = 2;
const MAX_ROWS: u16 = 300;
const MAX_TERMINAL_SESSIONS: usize = 8;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
static TERMINAL_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
struct TerminalRegistry {
    sessions: HashMap<String, TerminalSession>,
    starting: usize,
}

#[derive(Default)]
pub struct TerminalManager {
    inner: Arc<Mutex<TerminalRegistry>>,
}

impl TerminalManager {
    pub fn shutdown(&self) -> Result<(), String> {
        let sessions = {
            let mut registry = self
                .inner
                .lock()
                .map_err(|_| "Terminal state is unavailable".to_string())?;
            registry
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for mut session in sessions {
            if let Err(error) = session.killer.kill() {
                first_error.get_or_insert_with(|| {
                    format!("A terminal process could not be stopped: {error}")
                });
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub id: String,
    pub process_id: Option<u32>,
    pub shell: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "dataBase64")]
        data_base64: String,
    },
    Exit {
        #[serde(rename = "sessionId")]
        session_id: String,
        code: Option<u32>,
        detail: String,
    },
    Error {
        #[serde(rename = "sessionId")]
        session_id: String,
        message: String,
    },
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(MIN_COLS..=MAX_COLS).contains(&cols) || !(MIN_ROWS..=MAX_ROWS).contains(&rows) {
        return Err(format!(
            "Terminal size must be between {MIN_COLS}x{MIN_ROWS} and {MAX_COLS}x{MAX_ROWS}"
        ));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[cfg(unix)]
fn default_shell() -> PathBuf {
    env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|shell| shell.is_absolute() && shell.is_file())
        .or_else(|| {
            let zsh = PathBuf::from("/bin/zsh");
            zsh.is_file().then_some(zsh)
        })
        .unwrap_or_else(|| PathBuf::from("/bin/sh"))
}

#[cfg(windows)]
fn default_shell() -> PathBuf {
    env::var_os("COMSPEC")
        .map(PathBuf::from)
        .filter(|shell| shell.is_file())
        .unwrap_or_else(|| PathBuf::from("cmd.exe"))
}

fn shell_command(shell: &Path, workspace: &Path) -> CommandBuilder {
    let mut command = CommandBuilder::new(shell);
    command.cwd(workspace);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Traceframe");
    command
}

fn new_session_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!(
        "terminal-{now}-{}-{}",
        std::process::id(),
        TERMINAL_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

fn reserve_start(manager: &TerminalManager) -> Result<(), String> {
    let mut registry = manager
        .inner
        .lock()
        .map_err(|_| "Terminal state is unavailable".to_string())?;
    if registry.sessions.len() + registry.starting >= MAX_TERMINAL_SESSIONS {
        return Err(format!(
            "At most {MAX_TERMINAL_SESSIONS} terminal sessions can be open"
        ));
    }
    registry.starting += 1;
    Ok(())
}

fn cancel_start(manager: &TerminalManager) {
    if let Ok(mut registry) = manager.inner.lock() {
        registry.starting = registry.starting.saturating_sub(1);
    }
}

fn finish_start(
    manager: &TerminalManager,
    id: String,
    session: TerminalSession,
) -> Result<(), String> {
    let mut registry = manager
        .inner
        .lock()
        .map_err(|_| "Terminal state is unavailable".to_string())?;
    registry.starting = registry.starting.saturating_sub(1);
    if registry.sessions.insert(id, session).is_some() {
        return Err("Terminal session ID collision".into());
    }
    Ok(())
}

fn remove_session(inner: &Weak<Mutex<TerminalRegistry>>, id: &str, kill: bool) -> bool {
    let Some(inner) = inner.upgrade() else {
        return false;
    };
    let session = inner
        .lock()
        .ok()
        .and_then(|mut registry| registry.sessions.remove(id));
    if let Some(mut session) = session {
        if kill {
            let _ = session.killer.kill();
        }
        true
    } else {
        false
    }
}

fn emit_event(on_event: &Channel<TerminalEvent>, event: TerminalEvent) -> bool {
    on_event.send(event).is_ok()
}

fn stream_terminal(
    id: String,
    mut reader: Box<dyn Read + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    inner: Weak<Mutex<TerminalRegistry>>,
    on_event: Channel<TerminalEvent>,
) {
    let mut buffer = [0_u8; OUTPUT_CHUNK_BYTES];
    let mut total_output = 0_usize;

    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                total_output = total_output.saturating_add(read);
                if total_output > MAX_OUTPUT_BYTES {
                    emit_event(
                        &on_event,
                        TerminalEvent::Error {
                            session_id: id.clone(),
                            message: format!(
                                "Terminal stopped after exceeding the {MAX_OUTPUT_BYTES} byte output limit"
                            ),
                        },
                    );
                    remove_session(&inner, &id, true);
                    break;
                }
                if !emit_event(
                    &on_event,
                    TerminalEvent::Output {
                        session_id: id.clone(),
                        data_base64: BASE64.encode(&buffer[..read]),
                    },
                ) {
                    remove_session(&inner, &id, true);
                    break;
                }
            }
            Err(error) => {
                if remove_session(&inner, &id, true) {
                    emit_event(
                        &on_event,
                        TerminalEvent::Error {
                            session_id: id.clone(),
                            message: format!("Terminal output could not be read: {error}"),
                        },
                    );
                }
                break;
            }
        }
    }

    let status = child.wait();
    remove_session(&inner, &id, false);
    let (code, detail) = match status {
        Ok(status) => (Some(status.exit_code()), status.to_string()),
        Err(error) => (
            None,
            format!("Terminal exit status is unavailable: {error}"),
        ),
    };
    emit_event(
        &on_event,
        TerminalEvent::Exit {
            session_id: id,
            code,
            detail,
        },
    );
}

#[tauri::command]
pub fn terminal_start(
    workspace_path: String,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<TerminalEvent>,
    manager: State<'_, TerminalManager>,
    access: State<'_, WorkspaceAccess>,
) -> Result<TerminalSessionInfo, String> {
    if workspace_path.as_bytes().contains(&0) {
        return Err("Workspace path contains a NUL byte".into());
    }
    let workspace = access.resolve(&workspace_path)?;
    let cols = cols.unwrap_or(DEFAULT_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS);
    let size = terminal_size(cols, rows)?;
    reserve_start(&manager)?;
    let mut reservation_active = true;

    let start_result = (|| {
        let shell = default_shell();
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|error| format!("Terminal PTY could not be opened: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Terminal output could not be opened: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Terminal input could not be opened: {error}"))?;
        let command = shell_command(&shell, &workspace);
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Terminal shell could not be started: {error}"))?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave);

        let id = new_session_id();
        reservation_active = false;
        finish_start(
            &manager,
            id.clone(),
            TerminalSession {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                killer,
            },
        )?;

        let inner = Arc::downgrade(&manager.inner);
        let thread_id = id.clone();
        std::thread::Builder::new()
            .name(format!("traceframe-{thread_id}"))
            .spawn(move || stream_terminal(thread_id, reader, child, inner, on_event))
            .map_err(|error| {
                let weak = Arc::downgrade(&manager.inner);
                remove_session(&weak, &id, true);
                format!("Terminal output thread could not be started: {error}")
            })?;

        Ok(TerminalSessionInfo {
            id,
            process_id,
            shell: shell.to_string_lossy().to_string(),
            cwd: workspace.to_string_lossy().to_string(),
            cols,
            rows,
        })
    })();

    if start_result.is_err() && reservation_active {
        cancel_start(&manager);
    }
    start_result
}

#[tauri::command]
pub fn terminal_write(
    session_id: String,
    data: String,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    if data.len() > MAX_INPUT_BYTES {
        return Err(format!(
            "Terminal input is limited to {MAX_INPUT_BYTES} bytes per write"
        ));
    }
    let writer = manager
        .inner
        .lock()
        .map_err(|_| "Terminal state is unavailable".to_string())?
        .sessions
        .get(&session_id)
        .map(|session| Arc::clone(&session.writer))
        .ok_or_else(|| "Terminal session is no longer active".to_string())?;
    let mut writer = writer
        .lock()
        .map_err(|_| "Terminal input state is unavailable".to_string())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("Terminal input could not be written: {error}"))
}

#[tauri::command]
pub fn terminal_resize(
    session_id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, TerminalManager>,
) -> Result<(), String> {
    let size = terminal_size(cols, rows)?;
    let registry = manager
        .inner
        .lock()
        .map_err(|_| "Terminal state is unavailable".to_string())?;
    let session = registry
        .sessions
        .get(&session_id)
        .ok_or_else(|| "Terminal session is no longer active".to_string())?;
    session
        .master
        .resize(size)
        .map_err(|error| format!("Terminal could not be resized: {error}"))
}

fn close_terminal(session_id: &str, manager: &TerminalManager) -> Result<bool, String> {
    let mut registry = manager
        .inner
        .lock()
        .map_err(|_| "Terminal state is unavailable".to_string())?;
    let Some(session) = registry.sessions.get_mut(session_id) else {
        return Ok(false);
    };
    session
        .killer
        .kill()
        .map_err(|error| format!("Terminal process could not be stopped: {error}"))?;
    registry.sessions.remove(session_id);
    Ok(true)
}

#[tauri::command]
pub fn terminal_close(
    session_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<bool, String> {
    close_terminal(&session_id, &manager)
}

#[tauri::command]
pub fn terminal_kill(
    session_id: String,
    manager: State<'_, TerminalManager>,
) -> Result<bool, String> {
    close_terminal(&session_id, &manager)
}

#[cfg(test)]
mod tests {
    use super::{
        close_terminal, shell_command, terminal_size, TerminalEvent, TerminalManager,
        TerminalSession, DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use portable_pty::ChildKiller;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    #[derive(Debug)]
    struct FailingKiller;

    impl ChildKiller for FailingKiller {
        fn kill(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("expected kill failure"))
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    #[cfg(unix)]
    #[test]
    fn pty_runs_a_shell_in_the_requested_workspace() {
        use portable_pty::native_pty_system;
        use std::fs;
        use std::io::{Read, Write};

        let workspace =
            std::env::temp_dir().join(format!("traceframe-terminal-test-{}", std::process::id()));
        fs::create_dir_all(&workspace).expect("workspace should be created");
        let pair = native_pty_system()
            .openpty(terminal_size(80, 24).expect("terminal size"))
            .expect("pty should open");
        let mut reader = pair.master.try_clone_reader().expect("reader should open");
        let mut writer = pair.master.take_writer().expect("writer should open");
        let resized = terminal_size(132, 43).expect("resized terminal size");
        pair.master.resize(resized).expect("pty should resize");
        let actual_size = pair.master.get_size().expect("pty size should read");
        assert_eq!(actual_size.cols, 132);
        assert_eq!(actual_size.rows, 43);
        let mut child = pair
            .slave
            .spawn_command(shell_command(Path::new("/bin/sh"), &workspace))
            .expect("shell should start");
        drop(pair.slave);
        writer
            .write_all(b"pwd\rprintf traceframe-enter\rexit\r")
            .expect("terminal input should write");
        writer.flush().expect("terminal input should flush");
        drop(writer);

        let mut output = String::new();
        reader
            .read_to_string(&mut output)
            .expect("terminal output should read");
        let status = child.wait().expect("shell should exit");
        fs::remove_dir_all(&workspace).expect("workspace should be removed");

        assert!(status.success());
        assert!(output.contains(&workspace.to_string_lossy().to_string()));
        assert!(output.contains("traceframe-enter"));
    }

    #[cfg(unix)]
    #[test]
    fn close_stops_and_removes_a_running_pty() {
        use portable_pty::native_pty_system;

        let pair = native_pty_system()
            .openpty(terminal_size(80, 24).expect("terminal size"))
            .expect("pty should open");
        let writer = pair.master.take_writer().expect("writer should open");
        let mut child = pair
            .slave
            .spawn_command(shell_command(Path::new("/bin/sh"), Path::new("/tmp")))
            .expect("shell should start");
        let killer = child.clone_killer();
        drop(pair.slave);

        let manager = TerminalManager::default();
        manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .insert(
                "close-test".into(),
                TerminalSession {
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    killer,
                },
            );

        assert!(close_terminal("close-test", &manager).expect("terminal should close"));
        assert!(!manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .contains_key("close-test"));
        child.wait().expect("shell should exit after close");
    }

    #[cfg(unix)]
    #[test]
    fn close_failure_keeps_the_session_available_for_retry() {
        use portable_pty::native_pty_system;

        let pair = native_pty_system()
            .openpty(terminal_size(80, 24).expect("terminal size"))
            .expect("pty should open");
        let writer = pair.master.take_writer().expect("writer should open");
        let mut child = pair
            .slave
            .spawn_command(shell_command(Path::new("/bin/sh"), Path::new("/tmp")))
            .expect("shell should start");
        let mut cleanup = child.clone_killer();
        drop(pair.slave);

        let manager = TerminalManager::default();
        manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .insert(
                "close-failure-test".into(),
                TerminalSession {
                    master: pair.master,
                    writer: Arc::new(Mutex::new(writer)),
                    killer: Box::new(FailingKiller),
                },
            );

        let error = close_terminal("close-failure-test", &manager)
            .expect_err("the injected killer should fail");
        assert!(error.contains("expected kill failure"));
        assert!(manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .contains_key("close-failure-test"));

        cleanup.kill().expect("test shell should stop");
        manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .remove("close-failure-test");
        child.wait().expect("test shell should exit");
    }

    #[cfg(unix)]
    #[test]
    fn manager_shutdown_stops_and_removes_all_running_ptys() {
        use portable_pty::native_pty_system;

        let manager = TerminalManager::default();
        let mut children = Vec::new();
        for id in ["shutdown-one", "shutdown-two"] {
            let pair = native_pty_system()
                .openpty(terminal_size(80, 24).expect("terminal size"))
                .expect("pty should open");
            let writer = pair.master.take_writer().expect("writer should open");
            let child = pair
                .slave
                .spawn_command(shell_command(Path::new("/bin/sh"), Path::new("/tmp")))
                .expect("shell should start");
            let killer = child.clone_killer();
            drop(pair.slave);
            manager
                .inner
                .lock()
                .expect("terminal registry")
                .sessions
                .insert(
                    id.into(),
                    TerminalSession {
                        master: pair.master,
                        writer: Arc::new(Mutex::new(writer)),
                        killer,
                    },
                );
            children.push(child);
        }

        manager
            .shutdown()
            .expect("terminal manager should shut down");
        manager
            .shutdown()
            .expect("terminal shutdown should be idempotent");
        assert!(manager
            .inner
            .lock()
            .expect("terminal registry")
            .sessions
            .is_empty());
        for mut child in children {
            child
                .wait()
                .expect("shell should exit after manager shutdown");
        }
    }

    #[test]
    fn validates_terminal_dimensions() {
        let size = terminal_size(DEFAULT_COLS, DEFAULT_ROWS).expect("default size should work");
        assert_eq!(size.cols, DEFAULT_COLS);
        assert_eq!(size.rows, DEFAULT_ROWS);
        assert!(terminal_size(1, DEFAULT_ROWS).is_err());
        assert!(terminal_size(DEFAULT_COLS, 1).is_err());
        assert!(terminal_size(MAX_COLS + 1, DEFAULT_ROWS).is_err());
        assert!(terminal_size(DEFAULT_COLS, MAX_ROWS + 1).is_err());
    }

    #[test]
    fn configures_shell_for_the_exact_workspace() {
        let workspace = Path::new("/tmp/traceframe workspace");
        let command = shell_command(Path::new("/bin/sh"), workspace);
        assert_eq!(command.get_cwd().expect("cwd"), workspace.as_os_str());
        assert_eq!(command.get_env("TERM"), Some("xterm-256color".as_ref()));
        assert_eq!(command.get_env("TERM_PROGRAM"), Some("Traceframe".as_ref()));
    }

    #[test]
    fn serializes_binary_safe_terminal_output() {
        let bytes = b"\x1b[31mhello\xe4\xb8\xad\x1b[0m";
        let value = serde_json::to_value(TerminalEvent::Output {
            session_id: "terminal-1".into(),
            data_base64: BASE64.encode(bytes),
        })
        .expect("event should serialize");
        assert_eq!(value["type"], "output");
        assert_eq!(value["sessionId"], "terminal-1");
        assert_eq!(
            BASE64
                .decode(value["dataBase64"].as_str().expect("base64"))
                .expect("event should decode"),
            bytes
        );
    }
}
