use crate::preview_proxy::{start_preview_proxy, PreviewProxyHandle, PreviewProxyInfo};
use crate::WorkspaceAccess;
use futures_util::StreamExt;
use reqwest::{redirect, Client, Url};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::Instant;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{ipc::Channel, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, watch};

const MAX_PREVIEW_HTML_BYTES: usize = 4 * 1024 * 1024;
const MAX_PREVIEW_REDIRECTS: usize = 5;
const PREVIEW_FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const PREVIEW_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PROGRAM_BYTES: usize = 1_024;
const MAX_COMMAND_ARGS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4_096;
const MAX_TOTAL_ARGUMENT_BYTES: usize = 64 * 1024;
const MAX_RETAINED_LOG_ENTRIES: usize = 1_000;
const LOG_READ_CHUNK_BYTES: usize = 4 * 1024;
const MAX_LOG_LINE_BYTES: usize = 16 * 1024;
const OUTPUT_CHANNEL_CAPACITY: usize = 128;
const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(3);
#[cfg(unix)]
const APP_EXIT_PROCESS_GRACE: Duration = Duration::from_millis(750);
#[cfg(unix)]
const STOP_PROCESS_GROUP_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDocument {
    pub url: String,
    pub html: String,
    pub source_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProcessState {
    pub phase: String,
    pub pid: Option<u32>,
    pub url: Option<String>,
    pub started_at: Option<u64>,
    pub error: Option<String>,
}

impl Default for PreviewProcessState {
    fn default() -> Self {
        Self {
            phase: "stopped".into(),
            pid: None,
            url: None,
            started_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLogEntry {
    pub sequence: u64,
    pub timestamp: u64,
    pub stream: String,
    pub line: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStartRequest {
    pub workspace_path: String,
    pub program: String,
    pub args: Vec<String>,
}

struct ActivePreview {
    generation: u64,
    process_id: Option<u32>,
    shutdown_started: AtomicBool,
    stop_sender: Mutex<Option<oneshot::Sender<()>>>,
    done: watch::Receiver<bool>,
}

#[derive(Default)]
struct PreviewManagerInner {
    generation: u64,
    next_sequence: u64,
    active: Option<Arc<ActivePreview>>,
    proxy: Option<PreviewProxyHandle>,
    state: PreviewProcessState,
    logs: VecDeque<PreviewLogEntry>,
}

#[derive(Clone, Default)]
pub struct PreviewManager {
    inner: Arc<Mutex<PreviewManagerInner>>,
    lifecycle: Arc<tokio::sync::Mutex<()>>,
}

impl PreviewManager {
    fn state(&self) -> Result<PreviewProcessState, String> {
        self.inner
            .lock()
            .map(|inner| inner.state.clone())
            .map_err(|_| "Preview process state is unavailable".to_string())
    }

    fn logs_after(&self, after_sequence: Option<u64>) -> Result<Vec<PreviewLogEntry>, String> {
        let after = after_sequence.unwrap_or(0);
        self.inner
            .lock()
            .map(|inner| {
                inner
                    .logs
                    .iter()
                    .filter(|entry| entry.sequence > after)
                    .cloned()
                    .collect()
            })
            .map_err(|_| "Preview log state is unavailable".to_string())
    }

    fn append_log(&self, stream: &str, line: String, on_event: Option<&Channel<PreviewLogEntry>>) {
        let entry = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            inner.next_sequence = inner.next_sequence.saturating_add(1);
            let entry = PreviewLogEntry {
                sequence: inner.next_sequence,
                timestamp: unix_timestamp_millis(),
                stream: stream.to_owned(),
                line,
            };
            if inner.state.url.is_none() && matches!(stream, "stdout" | "stderr") {
                inner.state.url = discover_loopback_url(&entry.line);
            }
            inner.logs.push_back(entry.clone());
            while inner.logs.len() > MAX_RETAINED_LOG_ENTRIES {
                inner.logs.pop_front();
            }
            entry
        };
        if let Some(channel) = on_event {
            let _ = channel.send(entry);
        }
    }

    async fn replace_proxy(&self, url: &str, marker: &str) -> Result<PreviewProxyInfo, String> {
        let mut replacement = start_preview_proxy(url, marker).await?;
        let info = replacement.info();
        let previous = match self.inner.lock() {
            Ok(mut inner) => inner.proxy.replace(replacement),
            Err(_) => {
                replacement.request_shutdown();
                return Err("Preview process state is unavailable".into());
            }
        };
        if let Some(previous) = previous {
            previous.stop().await;
        }
        Ok(info)
    }

    async fn stop_proxy(&self) -> Result<(), String> {
        let proxy = self
            .inner
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?
            .proxy
            .take();
        if let Some(proxy) = proxy {
            proxy.stop().await;
        }
        Ok(())
    }

    fn finish(&self, generation: u64, phase: &str, error: Option<String>) {
        let proxy = if let Ok(mut inner) = self.inner.lock() {
            let owns_active = inner
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation);
            if owns_active {
                inner.active = None;
                inner.state.phase = phase.into();
                inner.state.pid = None;
                inner.state.error = error;
                inner.proxy.take()
            } else {
                None
            }
        } else {
            None
        };
        if let Some(mut proxy) = proxy {
            proxy.request_shutdown();
        }
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let (active, proxy) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Preview process state is unavailable".to_string())?;
            let active = inner.active.clone();
            if active.is_some() {
                inner.state.phase = "stopping".into();
            }
            (active, inner.proxy.take())
        };
        if let Some(mut proxy) = proxy {
            proxy.request_shutdown();
        }
        let Some(active) = active else {
            return Ok(());
        };
        if active.shutdown_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if let Ok(mut sender) = active.stop_sender.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
        #[cfg(unix)]
        terminate_preview_group_for_app_exit(active.process_id)?;
        Ok(())
    }
}

struct ProcessOutput {
    stream: &'static str,
    message: String,
}

fn unix_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn validate_loopback_url(value: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|error| format!("Preview URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Preview URL must use HTTP or HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview URL cannot contain credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Preview URL must include a host".to_string())?;
    let ip_host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    let is_loopback = host.eq_ignore_ascii_case("localhost")
        || ip_host
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false);
    if !is_loopback {
        return Err("Preview URL must target localhost or a loopback IP address".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn discover_loopback_url(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let candidate = token.trim_matches(|character: char| {
            character.is_control()
                || matches!(character, '(' | ')' | '[' | ']' | '<' | '>' | '"' | '\'')
        });
        validate_loopback_url(candidate)
            .ok()
            .map(|url| url.to_string())
    })
}

fn preview_http_client() -> Result<Client, String> {
    let localhost = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0),
    ];
    Client::builder()
        .connect_timeout(PREVIEW_CONNECT_TIMEOUT)
        .timeout(PREVIEW_FETCH_TIMEOUT)
        .resolve_to_addrs("localhost", &localhost)
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_PREVIEW_REDIRECTS {
                return attempt.error(std::io::Error::other("Preview redirect limit was exceeded"));
            }
            match validate_loopback_url(attempt.url().as_str()) {
                Ok(_) => attempt.follow(),
                Err(error) => attempt.error(std::io::Error::other(error)),
            }
        }))
        .build()
        .map_err(|error| format!("Preview HTTP client could not be created: {error}"))
}

fn decode_preview_html(body: &[u8]) -> Result<String, String> {
    if body.len() > MAX_PREVIEW_HTML_BYTES {
        return Err(format!(
            "Preview document exceeds the {MAX_PREVIEW_HTML_BYTES} byte limit"
        ));
    }
    Ok(String::from_utf8_lossy(body).into_owned())
}

#[tauri::command]
pub async fn preview_fetch_document(url: String) -> Result<PreviewDocument, String> {
    let url = validate_loopback_url(&url)?;
    let response = preview_http_client()?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Preview document could not be fetched: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Preview server returned HTTP {}",
            response.status().as_u16()
        ));
    }
    if let Some(content_type) = response.headers().get(reqwest::header::CONTENT_TYPE) {
        let content_type = content_type
            .to_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !content_type.starts_with("text/html")
            && !content_type.starts_with("application/xhtml+xml")
        {
            return Err("Preview URL did not return an HTML document".into());
        }
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PREVIEW_HTML_BYTES.try_into().unwrap_or(u64::MAX))
    {
        return Err(format!(
            "Preview document exceeds the {MAX_PREVIEW_HTML_BYTES} byte limit"
        ));
    }

    let final_url = validate_loopback_url(response.url().as_str())?;
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Preview document could not be read: {error}"))?;
        if body.len().saturating_add(chunk.len()) > MAX_PREVIEW_HTML_BYTES {
            return Err(format!(
                "Preview document exceeds the {MAX_PREVIEW_HTML_BYTES} byte limit"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let source_bytes = body.len();
    let html = decode_preview_html(&body)?;
    Ok(PreviewDocument {
        url: final_url.to_string(),
        html,
        source_bytes,
    })
}

fn validate_command(program: &str, args: &[String]) -> Result<(), String> {
    if program.trim().is_empty() {
        return Err("Preview program is required".into());
    }
    if program.len() > MAX_PROGRAM_BYTES {
        return Err(format!(
            "Preview program exceeds the {MAX_PROGRAM_BYTES} byte limit"
        ));
    }
    if program.as_bytes().contains(&0) {
        return Err("Preview program cannot contain NUL bytes".into());
    }
    if args.len() > MAX_COMMAND_ARGS {
        return Err(format!(
            "Preview command is limited to {MAX_COMMAND_ARGS} arguments"
        ));
    }
    if args
        .iter()
        .any(|argument| argument.len() > MAX_ARGUMENT_BYTES)
    {
        return Err(format!(
            "Preview command arguments are limited to {MAX_ARGUMENT_BYTES} bytes each"
        ));
    }
    if args.iter().any(|argument| argument.as_bytes().contains(&0)) {
        return Err("Preview command arguments cannot contain NUL bytes".into());
    }
    let total_bytes = args.iter().map(String::len).sum::<usize>();
    if total_bytes > MAX_TOTAL_ARGUMENT_BYTES {
        return Err(format!(
            "Preview command arguments exceed the {MAX_TOTAL_ARGUMENT_BYTES} byte total limit"
        ));
    }
    Ok(())
}

async fn read_process_output<R>(
    mut reader: R,
    stream: &'static str,
    sender: mpsc::Sender<ProcessOutput>,
) where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; LOG_READ_CHUNK_BYTES];
    let mut pending = Vec::with_capacity(LOG_READ_CHUNK_BYTES);
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                if !pending.is_empty() {
                    let message = String::from_utf8_lossy(&pending).replace('\0', "");
                    let _ = sender.send(ProcessOutput { stream, message }).await;
                }
                break;
            }
            Ok(read) => {
                pending.extend_from_slice(&buffer[..read]);
                loop {
                    let line_end = pending
                        .iter()
                        .position(|byte| *byte == b'\n')
                        .map(|index| index + 1)
                        .or_else(|| {
                            (pending.len() >= MAX_LOG_LINE_BYTES).then_some(MAX_LOG_LINE_BYTES)
                        });
                    let Some(line_end) = line_end else {
                        break;
                    };
                    let mut line = pending.drain(..line_end).collect::<Vec<_>>();
                    while matches!(line.last(), Some(b'\n' | b'\r')) {
                        line.pop();
                    }
                    let message = String::from_utf8_lossy(&line).replace('\0', "");
                    if sender
                        .send(ProcessOutput { stream, message })
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
            }
            Err(error) => {
                let _ = sender
                    .send(ProcessOutput {
                        stream: "system",
                        message: format!("{stream} could not be read: {error}"),
                    })
                    .await;
                break;
            }
        }
    }
}

#[cfg(unix)]
fn signal_process_group(process_id: Option<u32>, signal: i32) -> Result<bool, String> {
    let Some(process_id) = process_id else {
        return Ok(false);
    };
    let process_group = i32::try_from(process_id)
        .ok()
        .filter(|process_id| *process_id > 0)
        .ok_or_else(|| "Preview process ID is outside the supported range".to_string())?;
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(format!(
            "Preview process group could not be signaled: {error}"
        ))
    }
}

#[cfg(unix)]
fn terminate_preview_group_for_app_exit(process_id: Option<u32>) -> Result<(), String> {
    if !signal_process_group(process_id, libc::SIGTERM)? {
        return Ok(());
    }
    let started = Instant::now();
    while started.elapsed() < APP_EXIT_PROCESS_GRACE {
        std::thread::sleep(Duration::from_millis(25));
        if !signal_process_group(process_id, 0)? {
            return Ok(());
        }
    }
    let _ = signal_process_group(process_id, libc::SIGKILL)?;
    Ok(())
}

#[cfg(unix)]
fn ignore_signal_error(result: Result<bool, String>) {
    if let Err(error) = result {
        eprintln!("{error}");
    }
}

#[cfg(unix)]
async fn terminate_remaining_process_group(process_id: Option<u32>) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < STOP_PROCESS_GROUP_GRACE {
        if !signal_process_group(process_id, 0)? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let _ = signal_process_group(process_id, libc::SIGKILL)?;
    Ok(())
}

async fn terminate_preview_child(child: &mut Child) -> Result<std::process::ExitStatus, String> {
    let process_id = child.id();
    #[cfg(unix)]
    ignore_signal_error(signal_process_group(process_id, libc::SIGTERM));
    #[cfg(not(unix))]
    let _ = child.start_kill();

    let status = match tokio::time::timeout(PROCESS_EXIT_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => return Err(format!("Preview process could not be reaped: {error}")),
        Err(_) => {
            #[cfg(unix)]
            ignore_signal_error(signal_process_group(process_id, libc::SIGKILL));
            let fallback_error = child.start_kill().err();
            match tokio::time::timeout(PROCESS_EXIT_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(error)) => Err(format!("Preview process could not be reaped: {error}")),
                Err(_) => Err(fallback_error.map_or_else(
                    || "Preview process did not exit after it was killed".into(),
                    |error| format!("Preview process could not be killed: {error}"),
                )),
            }?
        }
    };
    #[cfg(unix)]
    terminate_remaining_process_group(process_id).await?;
    Ok(status)
}

async fn supervise_process(
    manager: PreviewManager,
    active: Arc<ActivePreview>,
    mut child: Child,
    mut stop_receiver: oneshot::Receiver<()>,
    done_sender: watch::Sender<bool>,
    on_event: Option<Channel<PreviewLogEntry>>,
) {
    let (output_sender, mut output_receiver) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let stdout_task = child.stdout.take().map(|stdout| {
        tauri::async_runtime::spawn(read_process_output(stdout, "stdout", output_sender.clone()))
    });
    let stderr_task = child.stderr.take().map(|stderr| {
        tauri::async_runtime::spawn(read_process_output(stderr, "stderr", output_sender.clone()))
    });
    drop(output_sender);

    let mut requested_stop = false;
    let outcome = loop {
        while let Ok(output) = output_receiver.try_recv() {
            manager.append_log(output.stream, output.message, on_event.as_ref());
        }
        match stop_receiver.try_recv() {
            Ok(()) | Err(oneshot::error::TryRecvError::Closed) => {
                requested_stop = true;
                break terminate_preview_child(&mut child).await;
            }
            Err(oneshot::error::TryRecvError::Empty) => {}
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(error) => {
                break Err(format!("Preview process status could not be read: {error}"));
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    #[cfg(unix)]
    if !requested_stop {
        let cleanup = match signal_process_group(active.process_id, libc::SIGTERM) {
            Ok(_) => terminate_remaining_process_group(active.process_id).await,
            Err(error) => Err(error),
        };
        if let Err(error) = cleanup {
            manager.append_log("system", error, on_event.as_ref());
        }
    }
    while let Ok(output) = output_receiver.try_recv() {
        manager.append_log(output.stream, output.message, on_event.as_ref());
    }
    if let Some(task) = stdout_task {
        task.abort();
    }
    if let Some(task) = stderr_task {
        task.abort();
    }

    match outcome {
        Ok(status) => {
            let message = if requested_stop {
                "Preview process stopped".to_string()
            } else {
                format!("Preview process exited with status {status}")
            };
            manager.append_log("system", message, on_event.as_ref());
            manager.finish(active.generation, "stopped", None);
        }
        Err(error) => {
            manager.append_log("system", error.clone(), on_event.as_ref());
            manager.finish(active.generation, "failed", Some(error));
        }
    }
    let _ = done_sender.send(true);
}

fn prepare_preview_start(
    request: PreviewStartRequest,
    access: &WorkspaceAccess,
) -> Result<(PreviewStartRequest, std::path::PathBuf), String> {
    validate_command(&request.program, &request.args)?;
    let workspace = access.resolve(&request.workspace_path)?;
    Ok((request, workspace))
}

async fn start_preview_locked(
    request: PreviewStartRequest,
    workspace: std::path::PathBuf,
    manager: &PreviewManager,
    on_event: Option<Channel<PreviewLogEntry>>,
) -> Result<PreviewProcessState, String> {
    {
        let inner = manager
            .inner
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?;
        if inner.active.is_some() {
            return Err("A preview process is already running; stop or restart it first".into());
        }
    }

    let mut command = Command::new(&request.program);
    command
        .args(&request.args)
        .current_dir(&workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|error| format!("Preview process could not start: {error}"))?;
    let pid = child.id();
    let (stop_sender, stop_receiver) = oneshot::channel();
    let (done_sender, done) = watch::channel(false);
    let program_label = request.program.clone();
    let (active, state) = {
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?;
        inner.generation = inner.generation.saturating_add(1);
        let generation = inner.generation;
        let active = Arc::new(ActivePreview {
            generation,
            process_id: pid,
            shutdown_started: AtomicBool::new(false),
            stop_sender: Mutex::new(Some(stop_sender)),
            done,
        });
        let state = PreviewProcessState {
            phase: "running".into(),
            pid,
            url: None,
            started_at: Some(unix_timestamp_millis()),
            error: None,
        };
        inner.logs.clear();
        inner.active = Some(active.clone());
        inner.state = state.clone();
        (active, state)
    };
    manager.append_log(
        "system",
        format!(
            "Started {} with PID {}",
            program_label,
            pid.map_or_else(|| "unknown".into(), |pid| pid.to_string())
        ),
        on_event.as_ref(),
    );
    tauri::async_runtime::spawn(supervise_process(
        manager.clone(),
        active,
        child,
        stop_receiver,
        done_sender,
        on_event,
    ));
    Ok(state)
}

async fn start_preview(
    request: PreviewStartRequest,
    access: &WorkspaceAccess,
    manager: &PreviewManager,
    on_event: Option<Channel<PreviewLogEntry>>,
) -> Result<PreviewProcessState, String> {
    let (request, workspace) = prepare_preview_start(request, access)?;
    let _lifecycle_guard = manager.lifecycle.lock().await;
    start_preview_locked(request, workspace, manager, on_event).await
}

async fn stop_preview_locked(manager: &PreviewManager) -> Result<PreviewProcessState, String> {
    manager.stop_proxy().await?;
    let active = {
        let mut inner = manager
            .inner
            .lock()
            .map_err(|_| "Preview process state is unavailable".to_string())?;
        let Some(active) = inner.active.clone() else {
            return Ok(inner.state.clone());
        };
        inner.state.phase = "stopping".into();
        active
    };
    if let Ok(mut sender) = active.stop_sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(());
        }
    }
    let mut done = active.done.clone();
    while !*done.borrow() {
        if done.changed().await.is_err() {
            break;
        }
    }
    manager.state()
}

async fn stop_preview(manager: &PreviewManager) -> Result<PreviewProcessState, String> {
    let _lifecycle_guard = manager.lifecycle.lock().await;
    stop_preview_locked(manager).await
}

async fn restart_preview(
    request: PreviewStartRequest,
    access: &WorkspaceAccess,
    manager: &PreviewManager,
) -> Result<PreviewProcessState, String> {
    // Validate the replacement before stopping a working preview, then retain
    // the lifecycle lock across stop and start so another command cannot race in.
    let (request, workspace) = prepare_preview_start(request, access)?;
    let _lifecycle_guard = manager.lifecycle.lock().await;
    stop_preview_locked(manager).await?;
    start_preview_locked(request, workspace, manager, None).await
}

#[tauri::command]
pub async fn preview_start(
    request: PreviewStartRequest,
    access: State<'_, WorkspaceAccess>,
    manager: State<'_, PreviewManager>,
) -> Result<PreviewProcessState, String> {
    start_preview(request, &access, &manager, None).await
}

#[tauri::command]
pub async fn preview_start_stream(
    request: PreviewStartRequest,
    on_event: Channel<PreviewLogEntry>,
    access: State<'_, WorkspaceAccess>,
    manager: State<'_, PreviewManager>,
) -> Result<PreviewProcessState, String> {
    start_preview(request, &access, &manager, Some(on_event)).await
}

#[tauri::command]
pub async fn preview_stop(
    manager: State<'_, PreviewManager>,
) -> Result<PreviewProcessState, String> {
    stop_preview(&manager).await
}

#[tauri::command]
pub async fn preview_restart(
    request: PreviewStartRequest,
    access: State<'_, WorkspaceAccess>,
    manager: State<'_, PreviewManager>,
) -> Result<PreviewProcessState, String> {
    restart_preview(request, &access, &manager).await
}

#[tauri::command]
pub async fn preview_proxy_open(
    url: String,
    marker: String,
    manager: State<'_, PreviewManager>,
) -> Result<PreviewProxyInfo, String> {
    let _lifecycle_guard = manager.lifecycle.lock().await;
    manager.replace_proxy(&url, &marker).await
}

#[tauri::command]
pub fn preview_status(manager: State<'_, PreviewManager>) -> Result<PreviewProcessState, String> {
    manager.state()
}

#[tauri::command]
pub fn preview_logs(
    after_sequence: Option<u64>,
    manager: State<'_, PreviewManager>,
) -> Result<Vec<PreviewLogEntry>, String> {
    manager.logs_after(after_sequence)
}

#[cfg(test)]
mod tests {
    use super::{
        decode_preview_html, discover_loopback_url, preview_fetch_document, restart_preview,
        start_preview, stop_preview, terminate_preview_child, validate_command,
        validate_loopback_url, ActivePreview, PreviewManager, PreviewStartRequest,
        MAX_PREVIEW_HTML_BYTES,
    };
    use crate::WorkspaceAccess;
    use std::io::{Read, Write};
    use std::net::{Ipv4Addr, TcpListener};
    use std::process::Stdio;
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::process::Command;
    use tokio::sync::{oneshot, watch};

    fn temporary_workspace(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace = std::env::temp_dir().join(format!(
            "traceframe-preview-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&workspace).unwrap();
        workspace.canonicalize().unwrap()
    }

    fn local_http_server(responses: Vec<String>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            for response in responses {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0_u8; 2_048];
                let _ = socket.read(&mut request);
                socket.write_all(response.as_bytes()).unwrap();
                socket.flush().unwrap();
            }
        });
        (format!("http://{address}"), handle)
    }

    #[test]
    fn accepts_only_loopback_http_urls() {
        assert!(validate_loopback_url("http://localhost:4173/app").is_ok());
        assert!(validate_loopback_url("https://127.0.0.2:8443/").is_ok());
        assert!(validate_loopback_url("http://[::1]:3000/").is_ok());
        assert!(validate_loopback_url("http://127.0.0.1.evil.test/").is_err());
        assert!(validate_loopback_url("http://localhost./").is_err());
        assert!(validate_loopback_url("https://example.com/").is_err());
        assert!(validate_loopback_url("file:///tmp/index.html").is_err());
        assert!(validate_loopback_url("http://user:secret@localhost/").is_err());
    }

    #[test]
    fn bounds_raw_html_and_discovers_only_loopback_urls() {
        assert!(decode_preview_html(&vec![b'x'; MAX_PREVIEW_HTML_BYTES]).is_ok());
        assert!(decode_preview_html(&vec![b'x'; MAX_PREVIEW_HTML_BYTES + 1]).is_err());
        assert_eq!(
            discover_loopback_url("ready at http://127.0.0.1:5173/app"),
            Some("http://127.0.0.1:5173/app".into())
        );
        assert_eq!(discover_loopback_url("ready at https://example.com"), None);
    }

    #[test]
    fn validates_program_and_argument_bounds() {
        assert!(validate_command("npm", &["run".into(), "dev".into()]).is_ok());
        assert!(validate_command(" ", &[]).is_err());
        assert!(validate_command("npm\0evil", &[]).is_err());
        assert!(validate_command("npm", &["bad\0argument".into()]).is_err());
        assert!(validate_command("npm", &vec!["x".into(); 65]).is_err());
        assert!(validate_command("npm", &["x".repeat(4_097)]).is_err());
    }

    #[test]
    fn follows_loopback_redirects_and_rejects_external_redirects() {
        tauri::async_runtime::block_on(async {
            let (base_url, server) = local_http_server(vec![
                "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 14\r\nConnection: close\r\n\r\n<h1>Ready</h1>".into(),
            ]);
            let document = preview_fetch_document(format!("{base_url}/start"))
                .await
                .unwrap();
            assert_eq!(document.url, format!("{base_url}/final"));
            assert_eq!(document.html, "<h1>Ready</h1>");
            server.join().unwrap();

            let (base_url, server) = local_http_server(vec![
                "HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            ]);
            let error = preview_fetch_document(format!("{base_url}/external"))
                .await
                .expect_err("external redirects must be rejected");
            assert!(error.contains("could not be fetched"));
            server.join().unwrap();
        });
    }

    #[test]
    fn stop_and_app_exit_close_the_preview_proxy() {
        tauri::async_runtime::block_on(async {
            let marker = "0123456789abcdef0123456789abcdef";
            let manager = PreviewManager::default();
            let ready = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: 14\r\nConnection: close\r\n\r\n<h1>Ready</h1>";
            let (upstream_url, upstream) = local_http_server(vec![ready.into(), ready.into()]);
            let first = manager.replace_proxy(&upstream_url, marker).await.unwrap();
            let first_address = reqwest::Url::parse(&first.proxy_url)
                .unwrap()
                .socket_addrs(|| None)
                .unwrap()[0];
            assert!(tokio::net::TcpStream::connect(first_address).await.is_ok());
            stop_preview(&manager).await.unwrap();
            assert!(tokio::net::TcpStream::connect(first_address).await.is_err());

            let second = manager.replace_proxy(&upstream_url, marker).await.unwrap();
            let second_address = reqwest::Url::parse(&second.proxy_url)
                .unwrap()
                .socket_addrs(|| None)
                .unwrap()[0];
            manager.shutdown().unwrap();
            for _ in 0..100 {
                if tokio::net::TcpStream::connect(second_address)
                    .await
                    .is_err()
                {
                    upstream.join().unwrap();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("preview proxy survived application shutdown");
        });
    }

    #[test]
    #[cfg(unix)]
    fn restart_is_atomic_and_invalid_replacements_leave_the_active_preview_running() {
        tauri::async_runtime::block_on(async {
            let workspace = temporary_workspace("restart");
            let access = WorkspaceAccess::default();
            access.register(workspace.clone()).unwrap();
            let manager = PreviewManager::default();
            let request = PreviewStartRequest {
                workspace_path: workspace.to_string_lossy().into_owned(),
                program: "/bin/sleep".into(),
                args: vec!["30".into()],
            };

            let first = start_preview(request.clone(), &access, &manager, None)
                .await
                .unwrap();
            let invalid = PreviewStartRequest {
                program: " ".into(),
                ..request.clone()
            };
            assert!(restart_preview(invalid, &access, &manager).await.is_err());
            let unchanged = manager.state().unwrap();
            assert_eq!(unchanged.phase, "running");
            assert_eq!(unchanged.pid, first.pid);

            let restarted = restart_preview(request, &access, &manager).await.unwrap();
            assert_eq!(restarted.phase, "running");
            assert_eq!(manager.inner.lock().unwrap().generation, 2);
            assert_eq!(stop_preview(&manager).await.unwrap().phase, "stopped");
            let _ = std::fs::remove_dir_all(workspace);
        });
    }

    #[test]
    #[cfg(unix)]
    fn stopping_preview_reaps_the_process_group_leader() {
        tauri::async_runtime::block_on(async {
            let mut command = Command::new("/bin/sleep");
            command.arg("30").process_group(0);
            let mut child = command.spawn().unwrap();
            terminate_preview_child(&mut child).await.unwrap();
            assert!(child.try_wait().unwrap().is_some());
        });
    }

    #[test]
    #[cfg(unix)]
    fn stopping_preview_kills_descendants_that_ignore_term() {
        tauri::async_runtime::block_on(async {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid_file =
                std::env::temp_dir().join(format!("traceframe-preview-stop-{nonce}.pid"));
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg(
                    "trap 'exit 0' TERM; (trap '' TERM; exec sleep 30) & echo $! > \"$TRACEFRAME_PID_FILE\"; wait",
                )
                .env("TRACEFRAME_PID_FILE", &pid_file)
                .process_group(0);
            let mut child = command.spawn().unwrap();
            for _ in 0..100 {
                if pid_file.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let descendant = std::fs::read_to_string(&pid_file).unwrap();

            terminate_preview_child(&mut child).await.unwrap();
            let mut descendant_alive = true;
            for _ in 0..100 {
                descendant_alive = std::process::Command::new("/bin/kill")
                    .args(["-0", descendant.trim()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                if !descendant_alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _ = std::fs::remove_file(&pid_file);
            assert!(!descendant_alive, "preview descendant survived stop");
        });
    }

    #[test]
    #[cfg(unix)]
    fn natural_preview_exit_cleans_remaining_descendants() {
        tauri::async_runtime::block_on(async {
            let workspace = temporary_workspace("natural-exit");
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid_file =
                std::env::temp_dir().join(format!("traceframe-preview-orphan-{nonce}.pid"));
            let access = WorkspaceAccess::default();
            access.register(workspace.clone()).unwrap();
            let manager = PreviewManager::default();
            let escaped_pid_file = pid_file.to_string_lossy().replace('\'', "'\\''");
            let request = PreviewStartRequest {
                workspace_path: workspace.to_string_lossy().into_owned(),
                program: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    format!(
                        "(trap '' TERM; exec sleep 30) & echo $! > '{escaped_pid_file}'; exit 0"
                    ),
                ],
            };
            start_preview(request, &access, &manager, None)
                .await
                .unwrap();
            for _ in 0..200 {
                if pid_file.exists() && manager.state().unwrap().phase == "stopped" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let descendant = std::fs::read_to_string(&pid_file).unwrap();
            let descendant_alive = std::process::Command::new("/bin/kill")
                .args(["-0", descendant.trim()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success();
            let _ = std::fs::remove_file(&pid_file);
            let _ = std::fs::remove_dir_all(workspace);
            assert_eq!(manager.state().unwrap().phase, "stopped");
            assert!(
                !descendant_alive,
                "preview descendant survived natural exit"
            );
        });
    }

    #[test]
    #[cfg(unix)]
    fn application_exit_kills_the_preview_process_group() {
        tauri::async_runtime::block_on(async {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let pid_file =
                std::env::temp_dir().join(format!("traceframe-preview-exit-{nonce}.pid"));
            let mut command = Command::new("/bin/sh");
            command
                .arg("-c")
                .arg("trap '' TERM; sleep 30 & echo $! > \"$TRACEFRAME_PID_FILE\"; wait")
                .env("TRACEFRAME_PID_FILE", &pid_file)
                .process_group(0);
            let mut child = command.spawn().unwrap();
            for _ in 0..100 {
                if pid_file.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let descendant = std::fs::read_to_string(&pid_file).unwrap();
            let process_id = child.id();
            let manager = PreviewManager::default();
            let (stop_sender, mut stop_receiver) = oneshot::channel();
            let (_done_sender, done) = watch::channel(false);
            let active = Arc::new(ActivePreview {
                generation: 1,
                process_id,
                shutdown_started: AtomicBool::new(false),
                stop_sender: Mutex::new(Some(stop_sender)),
                done,
            });
            manager.inner.lock().unwrap().active = Some(active);

            manager.shutdown().unwrap();
            manager.shutdown().unwrap();
            assert!(stop_receiver.try_recv().is_ok());
            assert_eq!(manager.state().unwrap().phase, "stopping");
            tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .expect("preview group leader should stop before app exit")
                .unwrap();

            let mut descendant_alive = true;
            for _ in 0..100 {
                descendant_alive = std::process::Command::new("/bin/kill")
                    .args(["-0", descendant.trim()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .unwrap()
                    .success();
                if !descendant_alive {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            let _ = std::fs::remove_file(&pid_file);
            assert!(!descendant_alive, "preview descendant survived app cleanup");
        });
    }
}
