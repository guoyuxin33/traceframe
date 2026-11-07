use axum::body::{to_bytes, Body};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Request, Response, StatusCode};
use axum::routing::any;
use axum::Router;
use futures_util::StreamExt;
use reqwest::{redirect, Client, Url};
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch};

const BRIDGE_ROUTE_PREFIX: &str = "/.traceframe";
const MAX_PROXY_REDIRECTS: usize = 5;
const MAX_PROXY_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROXY_HTML_BYTES: usize = 4 * 1024 * 1024;
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const PROXY_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProxyInfo {
    pub proxy_url: String,
    pub source_url: String,
}

pub struct PreviewProxyHandle {
    info: PreviewProxyInfo,
    shutdown: Option<oneshot::Sender<()>>,
    done: watch::Receiver<bool>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl PreviewProxyHandle {
    pub fn info(&self) -> PreviewProxyInfo {
        self.info.clone()
    }

    pub fn request_shutdown(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }

    pub async fn stop(mut self) {
        self.request_shutdown();
        let graceful = tokio::time::timeout(PROXY_SHUTDOWN_TIMEOUT, async {
            while !*self.done.borrow() {
                if self.done.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .is_ok();
        if !graceful {
            if let Some(task) = self.task.as_ref() {
                task.abort();
            }
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

#[derive(Clone)]
struct ProxyState {
    source_origin: String,
    marker: String,
    bridge_script_path: String,
    bridge_style_path: String,
    client: Client,
}

fn validate_marker(marker: &str) -> Result<(), String> {
    if marker.len() != 32 || !marker.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Preview bridge marker must be exactly 32 hexadecimal characters".into());
    }
    Ok(())
}

pub fn validate_preview_proxy_request(source_url: &str, marker: &str) -> Result<(), String> {
    validate_marker(marker)?;
    validate_loopback_url(source_url)?;
    Ok(())
}

fn validate_loopback_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value.trim())
        .map_err(|error| format!("Preview proxy URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Preview proxy URL must use HTTP or HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Preview proxy URL cannot contain credentials".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Preview proxy URL must include a host".to_string())?;
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
        return Err("Preview proxy URL must target localhost or a loopback IP address".into());
    }
    url.set_fragment(None);
    Ok(url)
}

fn source_origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn proxy_http_client(allowed_origin: String) -> Result<Client, String> {
    let localhost = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 0),
    ];
    Client::builder()
        .connect_timeout(PROXY_CONNECT_TIMEOUT)
        .timeout(PROXY_REQUEST_TIMEOUT)
        .resolve_to_addrs("localhost", &localhost)
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_PROXY_REDIRECTS {
                return attempt.error(std::io::Error::other(
                    "Preview proxy redirect limit was exceeded",
                ));
            }
            match validate_loopback_url(attempt.url().as_str()) {
                Ok(url) if source_origin(&url) == allowed_origin => attempt.follow(),
                Ok(_) => attempt.error(std::io::Error::other(
                    "Preview proxy redirects must stay on the configured preview origin",
                )),
                Err(error) => attempt.error(std::io::Error::other(error)),
            }
        }))
        .build()
        .map_err(|error| format!("Preview proxy HTTP client could not be created: {error}"))
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn copy_request_headers(source: &HeaderMap, target: &mut reqwest::header::HeaderMap) {
    for (name, value) in source {
        if is_hop_by_hop(name)
            || *name == header::HOST
            || *name == header::CONTENT_LENGTH
            || *name == header::ACCEPT_ENCODING
        {
            continue;
        }
        target.append(name.clone(), value.clone());
    }
    target.insert(
        header::ACCEPT_ENCODING,
        HeaderValue::from_static("identity"),
    );
}

fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap, injected_html: bool) {
    for (name, value) in source {
        if is_hop_by_hop(name)
            || *name == header::CONTENT_LENGTH
            || injected_html
                && (*name == header::ETAG
                    || *name == header::CONTENT_ENCODING
                    || name.as_str() == "content-md5")
        {
            continue;
        }
        target.append(name.clone(), value.clone());
    }
    if injected_html {
        target.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
}

fn bridge_asset_path(marker: &str, file: &str) -> String {
    format!("{BRIDGE_ROUTE_PREFIX}/{marker}/{file}")
}

fn bridge_markup(script_path: &str, style_path: &str) -> String {
    format!(
        "<link rel=\"stylesheet\" href=\"{style_path}\"><script src=\"{script_path}\" defer></script>"
    )
}

fn inject_bridge(html: &[u8], script_path: &str, style_path: &str) -> Result<Vec<u8>, String> {
    if html.len() > MAX_PROXY_HTML_BYTES {
        return Err(format!(
            "Preview proxy HTML exceeds the {MAX_PROXY_HTML_BYTES} byte limit"
        ));
    }
    let html = String::from_utf8_lossy(html);
    let lower = html.to_ascii_lowercase();
    let insertion = lower
        .find("</head>")
        .or_else(|| lower.find("</body>"))
        .unwrap_or(0);
    let markup = bridge_markup(script_path, style_path);
    let mut output = String::with_capacity(html.len() + markup.len());
    output.push_str(&html[..insertion]);
    output.push_str(&markup);
    output.push_str(&html[insertion..]);
    Ok(output.into_bytes())
}

fn bridge_script(marker: &str, source_origin: &str) -> String {
    let marker = serde_json::to_string(marker).expect("marker should serialize");
    let source_origin = serde_json::to_string(source_origin).expect("origin should serialize");
    format!(
        r#"(() => {{
  const marker = {marker};
  const source = 'traceframe-preview';
  const sourceOrigin = {source_origin};
  let selecting = false;
  let selected = null;
  const escapePart = (value) => window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, (character) => '\\' + character);
  const selectorFor = (element) => {{
    if (element.id) return '#' + escapePart(element.id);
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && parts.length < 5) {{
      let part = node.tagName.toLowerCase();
      const classes = Array.from(node.classList).slice(0, 2);
      if (classes.length) part += '.' + classes.map(escapePart).join('.');
      const parent = node.parentElement;
      if (parent) {{
        const peers = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
        if (peers.length > 1) part += ':nth-of-type(' + (peers.indexOf(node) + 1) + ')';
      }}
      parts.unshift(part);
      node = parent;
    }}
    return parts.join(' > ');
  }};
  const setSelecting = (enabled) => {{
    selecting = enabled;
    document.documentElement.toggleAttribute('data-traceframe-selecting', enabled);
    if (!enabled && selected) selected.removeAttribute('data-traceframe-selected');
    if (!enabled) selected = null;
  }};
  window.addEventListener('message', (event) => {{
    const data = event.data;
    if (event.source !== window.parent || !data || data.marker !== marker || data.source !== source || data.version !== 1 || data.type !== 'selection.toggle' || typeof data.enabled !== 'boolean') return;
    setSelecting(data.enabled);
  }});
  document.addEventListener('click', (event) => {{
    if (!selecting || !(event.target instanceof Element)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (selected) selected.removeAttribute('data-traceframe-selected');
    selected = event.target;
    selected.setAttribute('data-traceframe-selected', '');
    const rect = selected.getBoundingClientRect();
    const upstreamUrl = new URL(window.location.pathname + window.location.search + window.location.hash, sourceOrigin).href;
    window.parent.postMessage({{
      marker,
      source,
      version: 1,
      type: 'element.selected',
      payload: {{
        tag: selected.tagName.toLowerCase(),
        id: selected.id || '',
        classes: Array.from(selected.classList).slice(0, 24),
        selector: selectorFor(selected),
        text: (selected.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 2000),
        outerHTML: selected.outerHTML.slice(0, 20000),
        rect: {{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }},
        url: upstreamUrl,
      }},
    }}, '*');
  }}, true);
}})();"#
    )
}

fn bridge_response(state: &ProxyState, path: &str) -> Response<Body> {
    let (content_type, body) = if path == state.bridge_script_path {
        (
            "application/javascript; charset=utf-8",
            bridge_script(&state.marker, &state.source_origin),
        )
    } else {
        (
            "text/css; charset=utf-8",
            concat!(
                "html[data-traceframe-selecting],html[data-traceframe-selecting] *{cursor:crosshair!important}",
                "html[data-traceframe-selecting] *:hover{outline:2px solid #24b894!important;outline-offset:2px!important}",
                "[data-traceframe-selected]{outline:2px solid #24b894!important;outline-offset:2px!important}"
            )
            .to_string(),
        )
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(Body::from(body))
        .expect("bridge response should build")
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(message.into()))
        .expect("error response should build")
}

async fn proxy_request(
    State(state): State<Arc<ProxyState>>,
    request: Request<Body>,
) -> Response<Body> {
    let path = request.uri().path();
    if path == state.bridge_script_path || path == state.bridge_style_path {
        if request.method() != axum::http::Method::GET
            && request.method() != axum::http::Method::HEAD
        {
            return error_response(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
        }
        return bridge_response(&state, path);
    }

    let (parts, body) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    let target = match validate_loopback_url(&format!("{}{path_and_query}", state.source_origin)) {
        Ok(target) if source_origin(&target) == state.source_origin => target,
        Ok(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "Proxy request escaped the configured preview origin",
            )
        }
        Err(error) => return error_response(StatusCode::BAD_REQUEST, error),
    };
    let body = match to_bytes(body, MAX_PROXY_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(error) => {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("Preview proxy request body could not be read: {error}"),
            )
        }
    };

    let mut headers = reqwest::header::HeaderMap::new();
    copy_request_headers(&parts.headers, &mut headers);
    let upstream = match state
        .client
        .request(parts.method, target)
        .headers(headers)
        .body(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("Preview proxy upstream request failed: {error}"),
            )
        }
    };

    let status = upstream.status();
    let headers = upstream.headers().clone();
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_html =
        content_type.starts_with("text/html") || content_type.starts_with("application/xhtml+xml");

    if is_html {
        let bytes = match upstream.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    format!("Preview proxy HTML could not be read: {error}"),
                )
            }
        };
        let injected =
            match inject_bridge(&bytes, &state.bridge_script_path, &state.bridge_style_path) {
                Ok(injected) => injected,
                Err(error) => return error_response(StatusCode::BAD_GATEWAY, error),
            };
        let mut response = Response::new(Body::from(injected));
        *response.status_mut() = status;
        copy_response_headers(&headers, response.headers_mut(), true);
        return response;
    }

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut(), false);
    response
}

pub async fn start_preview_proxy(
    source_url: &str,
    marker: &str,
) -> Result<PreviewProxyHandle, String> {
    validate_preview_proxy_request(source_url, marker)?;
    let source_url = validate_loopback_url(source_url)?;
    let origin = source_origin(&source_url);
    let client = proxy_http_client(origin.clone())?;
    let readiness = client
        .get(source_url)
        .send()
        .await
        .map_err(|error| format!("Preview server is not ready: {error}"))?;
    if !readiness.status().is_success() {
        return Err(format!(
            "Preview server is not ready: HTTP {}",
            readiness.status().as_u16()
        ));
    }
    let source_url = validate_loopback_url(readiness.url().as_str())?;
    if source_origin(&source_url) != origin {
        return Err("Preview server redirected outside the configured origin".into());
    }
    drop(readiness);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|error| format!("Preview proxy could not bind to loopback: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Preview proxy address is unavailable: {error}"))?;
    let proxy_origin = format!("http://{address}");
    let path = source_url.path();
    let query = source_url
        .query()
        .map(|query| format!("?{query}"))
        .unwrap_or_default();
    let info = PreviewProxyInfo {
        proxy_url: format!("{proxy_origin}{path}{query}"),
        source_url: source_url.to_string(),
    };
    let state = Arc::new(ProxyState {
        source_origin: origin,
        marker: marker.to_owned(),
        bridge_script_path: bridge_asset_path(marker, "preview-bridge.js"),
        bridge_style_path: bridge_asset_path(marker, "preview-bridge.css"),
        client,
    });
    let router = Router::new().fallback(any(proxy_request)).with_state(state);
    let (shutdown, shutdown_receiver) = oneshot::channel();
    let (done_sender, done) = watch::channel(false);
    let task = tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_receiver.await;
            })
            .await;
        if let Err(error) = result {
            eprintln!("Preview proxy server stopped unexpectedly: {error}");
        }
        let _ = done_sender.send(true);
    });
    Ok(PreviewProxyHandle {
        info,
        shutdown: Some(shutdown),
        done,
        task: Some(task),
    })
}

#[cfg(test)]
mod tests {
    use super::{bridge_asset_path, inject_bridge, start_preview_proxy, validate_marker};
    use axum::body::Body;
    use axum::http::{header, Method, Request, Response, StatusCode};
    use axum::routing::any;
    use axum::Router;
    use reqwest::Url;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    async fn upstream(
        handler: impl Fn(Request<Body>) -> Response<Body> + Clone + Send + Sync + 'static,
    ) -> (String, oneshot::Sender<()>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        let router = Router::new().fallback(any(move |request| {
            let handler = Arc::clone(&handler);
            async move { handler(request) }
        }));
        let (shutdown, receiver) = oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = receiver.await;
                })
                .await;
        });
        (format!("http://{address}"), shutdown)
    }

    #[test]
    fn injects_only_external_bridge_assets() {
        let marker = "0123456789abcdef0123456789abcdef";
        let script_path = bridge_asset_path(marker, "preview-bridge.js");
        let style_path = bridge_asset_path(marker, "preview-bridge.css");
        let html = inject_bridge(
            b"<html><head><title>Demo</title></head><body></body></html>",
            &script_path,
            &style_path,
        )
        .unwrap();
        let html = String::from_utf8(html).unwrap();
        assert!(html.contains(&format!("<script src=\"{script_path}\" defer></script>")));
        assert!(html.contains(&format!("<link rel=\"stylesheet\" href=\"{style_path}\">")));
        assert!(!html.contains("selection.toggle"));
        assert!(validate_marker("0123456789abcdef0123456789abcdef").is_ok());
        assert!(validate_marker("not-a-marker").is_err());
    }

    #[test]
    fn proxies_html_assets_methods_queries_and_bodies() {
        tauri::async_runtime::block_on(async {
            let requests = Arc::new(Mutex::new(Vec::new()));
            let observed = requests.clone();
            let (origin, upstream_shutdown) = upstream(move |request| {
                observed.lock().unwrap().push((
                    request.method().clone(),
                    request
                        .uri()
                        .path_and_query()
                        .map(|value| value.as_str().to_string())
                        .unwrap_or_default(),
                ));
                if request.uri().path() == "/index.html" {
                    Response::builder()
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(Body::from("<html><head></head><body>Preview</body></html>"))
                        .unwrap()
                } else {
                    Response::builder()
                        .header(header::CONTENT_TYPE, "application/javascript")
                        .body(request.into_body())
                        .unwrap()
                }
            })
            .await;
            let proxy = start_preview_proxy(
                &format!("{origin}/index.html?mode=dev"),
                "0123456789abcdef0123456789abcdef",
            )
            .await
            .unwrap();
            let info = proxy.info();
            let bridge_script_path =
                bridge_asset_path("0123456789abcdef0123456789abcdef", "preview-bridge.js");
            let client = reqwest::Client::new();
            let html = client
                .get(&info.proxy_url)
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(html.contains(&bridge_script_path));
            let proxy_origin = Url::parse(&info.proxy_url)
                .unwrap()
                .origin()
                .ascii_serialization();
            let asset = client
                .request(Method::POST, format!("{proxy_origin}/asset.js?v=1"))
                .body("asset-body")
                .send()
                .await
                .unwrap();
            assert_eq!(asset.status(), StatusCode::OK);
            assert_eq!(asset.text().await.unwrap(), "asset-body");
            let bridge = client
                .get(format!("{proxy_origin}{bridge_script_path}"))
                .send()
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(bridge.contains("traceframe-preview"));
            assert!(bridge.contains(&origin));
            assert!(bridge.contains(
                "window.location.pathname + window.location.search + window.location.hash"
            ));
            assert_eq!(
                requests.lock().unwrap().as_slice(),
                &[
                    (Method::GET, "/index.html?mode=dev".into()),
                    (Method::GET, "/index.html?mode=dev".into()),
                    (Method::POST, "/asset.js?v=1".into()),
                ]
            );
            proxy.stop().await;
            let _ = upstream_shutdown.send(());
        });
    }

    #[test]
    fn uses_the_final_same_origin_redirect_path_for_the_proxy_url() {
        tauri::async_runtime::block_on(async {
            let (origin, upstream_shutdown) = upstream(|request| {
                if request.uri().path() == "/redirect" {
                    Response::builder()
                        .status(StatusCode::FOUND)
                        .header(header::LOCATION, "/app/index.html?mode=dev")
                        .body(Body::empty())
                        .unwrap()
                } else {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(Body::from("<html><head></head><body>Ready</body></html>"))
                        .unwrap()
                }
            })
            .await;
            let proxy = start_preview_proxy(
                &format!("{origin}/redirect"),
                "0123456789abcdef0123456789abcdef",
            )
            .await
            .unwrap();
            let info = proxy.info();

            assert_eq!(info.source_url, format!("{origin}/app/index.html?mode=dev"));
            let proxy_url = Url::parse(&info.proxy_url).unwrap();
            assert_eq!(proxy_url.path(), "/app/index.html");
            assert_eq!(proxy_url.query(), Some("mode=dev"));

            let html = reqwest::get(&info.proxy_url)
                .await
                .unwrap()
                .text()
                .await
                .unwrap();
            assert!(html.contains("traceframe"));

            proxy.stop().await;
            let _ = upstream_shutdown.send(());
        });
    }

    #[test]
    fn rejects_redirects_that_leave_loopback() {
        tauri::async_runtime::block_on(async {
            let (origin, upstream_shutdown) = upstream(|_request| {
                Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, "https://example.com/private")
                    .body(Body::empty())
                    .unwrap()
            })
            .await;
            let error = start_preview_proxy(
                &format!("{origin}/redirect"),
                "0123456789abcdef0123456789abcdef",
            )
            .await
            .err()
            .unwrap();
            assert!(error.contains("not ready"));
            let _ = upstream_shutdown.send(());
        });
    }

    #[test]
    fn rejects_redirects_to_a_different_loopback_origin() {
        tauri::async_runtime::block_on(async {
            let (target_origin, target_shutdown) =
                upstream(|_request| Response::new(Body::from("private local service"))).await;
            let (origin, upstream_shutdown) = upstream(move |_request| {
                Response::builder()
                    .status(StatusCode::FOUND)
                    .header(header::LOCATION, format!("{target_origin}/private"))
                    .body(Body::empty())
                    .unwrap()
            })
            .await;
            let error = start_preview_proxy(
                &format!("{origin}/redirect"),
                "0123456789abcdef0123456789abcdef",
            )
            .await
            .err()
            .unwrap();
            assert!(error.contains("not ready"));
            let _ = upstream_shutdown.send(());
            let _ = target_shutdown.send(());
        });
    }

    #[test]
    fn rejects_non_successful_upstream_before_exposing_a_proxy() {
        tauri::async_runtime::block_on(async {
            let (origin, upstream_shutdown) = upstream(|_request| {
                Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .body(Body::from("starting"))
                    .unwrap()
            })
            .await;

            let error = start_preview_proxy(&origin, "0123456789abcdef0123456789abcdef")
                .await
                .err()
                .unwrap();

            assert!(error.contains("HTTP 503"));
            let _ = upstream_shutdown.send(());
        });
    }
}
