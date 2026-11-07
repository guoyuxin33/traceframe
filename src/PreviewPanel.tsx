import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CircleStop,
  ExternalLink,
  Globe2,
  LoaderCircle,
  MousePointer2,
  Play,
  RefreshCw,
  Rocket,
  RotateCcw,
  Send,
  Settings2,
  TerminalSquare,
} from 'lucide-react'
import {
  nativePreviewApi,
  type PreviewLogEntry,
  type PreviewNativeApi,
  type PreviewProcessState,
} from './previewNative'
import './preview.css'

const PREVIEW_MESSAGE_SOURCE = 'traceframe-preview'
const PREVIEW_MESSAGE_VERSION = 1
const DEFAULT_URL = 'http://127.0.0.1:5173/'
export const PREVIEW_AUTO_LOAD_RETRY_LIMIT = 12
const PREVIEW_AUTO_LOAD_RETRY_DELAY_MS = 750
const EMPTY_PROCESS_STATE: PreviewProcessState = {
  phase: 'stopped',
  pid: null,
  url: null,
  startedAt: null,
  error: null,
}

export interface PreviewElementRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PreviewElementContext {
  tag: string
  id: string
  classes: string[]
  selector: string
  text: string
  outerHTML: string
  rect: PreviewElementRect
  url: string
}

export interface PreviewPanelProps {
  workspacePath: string | null
  defaultProgram?: string
  defaultArgs?: string[]
  defaultDeployCommand?: string
  initialUrl?: string
  api?: PreviewNativeApi
  disabled?: boolean
  onOpenTerminalCommand?: (command: string) => void
  onAddToConversation: (prompt: string, context: PreviewElementContext) => void
}

interface PreviewMessageData {
  marker: string
  source: typeof PREVIEW_MESSAGE_SOURCE
  version: typeof PREVIEW_MESSAGE_VERSION
  type: 'element.selected'
  payload: PreviewElementContext
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === 'string' && value.length <= maximum ? value : null
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizePreviewUrl(value: string) {
  const input = value.trim()
  if (!input) throw new Error('请输入预览地址')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `http://${input}`
  const parsed = new URL(candidate)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('预览仅支持 HTTP 或 HTTPS 地址')
  if (parsed.username || parsed.password) throw new Error('预览地址不能包含认证信息')
  return parsed.href
}

export function parseCommandArguments(value: string) {
  const args: string[] = []
  let current = ''
  let quote: 'single' | 'double' | null = null
  let escaping = false
  let started = false

  for (const character of value) {
    if (escaping) {
      current += character
      escaping = false
      started = true
      continue
    }
    if (character === '\\' && quote !== 'single') {
      escaping = true
      started = true
      continue
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single'
      started = true
      continue
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double'
      started = true
      continue
    }
    if (/\s/.test(character) && !quote) {
      if (started) args.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }

  if (escaping) throw new Error('参数末尾不能是转义符')
  if (quote) throw new Error('参数中存在未闭合的引号')
  if (started) args.push(current)
  return args
}

function formatCommandArguments(args: string[]) {
  return args.map((argument) => (/^[\w./:@=-]+$/.test(argument) ? argument : JSON.stringify(argument))).join(' ')
}

export function sanitizeTerminalCommand(command: string) {
  return command.replace(/[\r\n]+/g, ' ').trim()
}

function createBridgeMarker() {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function escapeAttribute(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function isLoopbackUrl(value: string) {
  const parsed = new URL(value)
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export function validatePreviewSelectionMessage(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  expectedSource: Window | null,
  marker: string,
  expectedProxyOrigin: string,
  expectedProjectUrl: string,
): PreviewElementContext | null {
  if (!expectedSource || event.source !== expectedSource || event.origin !== expectedProxyOrigin) return null
  const data = event.data as Partial<PreviewMessageData> | null
  if (!data || data.marker !== marker || data.source !== PREVIEW_MESSAGE_SOURCE || data.version !== PREVIEW_MESSAGE_VERSION || data.type !== 'element.selected') return null
  const payload = data.payload as Partial<PreviewElementContext> | null
  if (!payload || !Array.isArray(payload.classes) || payload.classes.length > 24) return null
  const tag = boundedString(payload.tag, 80)
  const id = boundedString(payload.id, 512)
  const selector = boundedString(payload.selector, 4000)
  const text = boundedString(payload.text, 2000)
  const outerHTML = boundedString(payload.outerHTML, 20000)
  const url = boundedString(payload.url, 4000)
  const classes = payload.classes.every((entry) => typeof entry === 'string' && entry.length <= 512) ? payload.classes : null
  const rect = payload.rect
  if (!tag || id === null || !selector || text === null || outerHTML === null || !url || !classes || !rect) return null
  if (!/^[a-z][a-z\d-]*$/i.test(tag)) return null
  let normalizedUrl = ''
  try {
    normalizedUrl = normalizePreviewUrl(url)
    const projectUrl = normalizePreviewUrl(expectedProjectUrl)
    if (!isLoopbackUrl(normalizedUrl) || new URL(normalizedUrl).origin !== new URL(projectUrl).origin) return null
  } catch {
    return null
  }
  const x = finiteNumber(rect.x)
  const y = finiteNumber(rect.y)
  const width = finiteNumber(rect.width)
  const height = finiteNumber(rect.height)
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null
  return { tag, id, classes: [...classes], selector, text, outerHTML, rect: { x, y, width, height }, url: normalizedUrl }
}

function markdownFence(content: string) {
  const longest = Math.max(2, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length))
  return '`'.repeat(longest + 1)
}

export function buildElementPrompt(context: PreviewElementContext, instruction: string) {
  const label = `<${context.tag}${context.id ? `#${context.id}` : ''}${context.classes.length ? `.${context.classes.join('.')}` : ''}>`
  const fence = markdownFence(context.outerHTML)
  const details = instruction.trim() || '请结合当前界面和代码，修复或调整这个元素。'
  return [
    '请修改当前项目预览中选中的元素。',
    '',
    `- 页面：${context.url}`,
    `- 元素：${label}`,
    `- 选择器：\`${context.selector.replaceAll('`', '\\`')}\``,
    `- 位置：x ${Math.round(context.rect.x)}, y ${Math.round(context.rect.y)}, ${Math.round(context.rect.width)} x ${Math.round(context.rect.height)}`,
    context.text ? `- 可见文本：${context.text}` : '- 可见文本：（无）',
    '',
    `${fence}html`,
    context.outerHTML,
    fence,
    '',
    '修改要求：',
    details,
    '',
    '完成代码修改后，请说明改动文件，并提醒我使用“重启并刷新”验证结果。',
  ].join('\n')
}

function emptyPreviewDocument(message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#101214;color:#a6aeaa}
  body{display:grid;place-items:center;min-height:100vh;margin:0}.empty{max-width:360px;padding:24px;text-align:center}
  strong{display:block;margin-bottom:8px;color:#edf1ef;font-size:14px}span{font-size:12px;line-height:1.6}
  </style></head><body><div class="empty"><strong>项目预览</strong><span>${escapeAttribute(message)}</span></div></body></html>`
}

function phaseLabel(phase: PreviewProcessState['phase']) {
  return ({ stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', failed: '失败' })[phase]
}

export function PreviewPanel({
  workspacePath,
  defaultProgram = 'npm',
  defaultArgs = ['run', 'dev'],
  defaultDeployCommand = 'npx vercel --prod',
  initialUrl = DEFAULT_URL,
  api = nativePreviewApi,
  disabled = false,
  onOpenTerminalCommand,
  onAddToConversation,
}: PreviewPanelProps) {
  const [marker] = useState(createBridgeMarker)
  const [url, setUrl] = useState(initialUrl)
  const [loadedUrl, setLoadedUrl] = useState('')
  const [proxyUrl, setProxyUrl] = useState('')
  const [proxyOrigin, setProxyOrigin] = useState('')
  const [restartLoadUrl, setRestartLoadUrl] = useState('')
  const emptyDocument = useMemo(() => emptyPreviewDocument(
    workspacePath ? '启动项目后将在此自动载入本地开发地址。' : '先打开工作区，再启动项目预览。',
  ), [workspacePath])
  const [processState, setProcessState] = useState<PreviewProcessState>(EMPTY_PROCESS_STATE)
  const [logs, setLogs] = useState<PreviewLogEntry[]>([])
  const [program, setProgram] = useState(defaultProgram)
  const [argsText, setArgsText] = useState(() => formatCommandArguments(defaultArgs))
  const [deployCommand, setDeployCommand] = useState(() => sanitizeTerminalCommand(defaultDeployCommand))
  const [showCommand, setShowCommand] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selectedElement, setSelectedElement] = useState<PreviewElementContext | null>(null)
  const [instruction, setInstruction] = useState('')
  const [busy, setBusy] = useState<'start' | 'restart' | 'stop' | 'load' | null>(null)
  const [error, setError] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const loadSequence = useRef(0)
  const lastLogSequence = useRef(0)
  const operationVersion = useRef(0)
  const autoLoadedProcessUrl = useRef('')

  const postSelectionMode = useCallback((enabled: boolean) => {
    if (!proxyOrigin) return
    iframeRef.current?.contentWindow?.postMessage({
      marker,
      source: PREVIEW_MESSAGE_SOURCE,
      version: PREVIEW_MESSAGE_VERSION,
      type: 'selection.toggle',
      enabled,
    }, proxyOrigin)
  }, [marker, proxyOrigin])

  useEffect(() => {
    const receiveSelection = (event: MessageEvent) => {
      if (!proxyOrigin || !loadedUrl) return
      const selection = validatePreviewSelectionMessage(
        event,
        iframeRef.current?.contentWindow ?? null,
        marker,
        proxyOrigin,
        loadedUrl,
      )
      if (selection) setSelectedElement(selection)
    }
    window.addEventListener('message', receiveSelection)
    return () => window.removeEventListener('message', receiveSelection)
  }, [loadedUrl, marker, proxyOrigin])

  useEffect(() => {
    const version = operationVersion.current
    void api.status().then((state) => {
      if (version === operationVersion.current) {
        setProcessState(state)
        if (state.url) setUrl(state.url)
      }
    }).catch(() => undefined)
  }, [api])

  useEffect(() => {
    if (processState.phase !== 'running' && processState.phase !== 'starting' && processState.phase !== 'stopping') return
    let disposed = false
    const poll = async () => {
      const version = operationVersion.current
      try {
        const [nextState, nextLogs] = await Promise.all([api.status(), api.logs(lastLogSequence.current)])
        if (disposed || version !== operationVersion.current) return
        setProcessState(nextState)
        if (nextState.url && !loadedUrl) setUrl(nextState.url)
        if (nextLogs.length) {
          lastLogSequence.current = Math.max(lastLogSequence.current, ...nextLogs.map((entry) => entry.sequence))
          setLogs((current) => [...current, ...nextLogs].slice(-500))
        }
      } catch (pollError) {
        if (!disposed) setError(errorMessage(pollError))
      }
    }
    const timer = window.setInterval(() => void poll(), 1_000)
    void poll()
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [api, loadedUrl, processState.phase])

  const loadPreview = useCallback(async (candidate = url) => {
    const request = ++loadSequence.current
    setBusy('load')
    setError('')
    try {
      const normalizedUrl = normalizePreviewUrl(candidate)
      const proxy = await api.openProxy(normalizedUrl, marker)
      if (request !== loadSequence.current) return false
      const finalUrl = normalizePreviewUrl(proxy.sourceUrl || normalizedUrl)
      const nextProxyUrl = normalizePreviewUrl(proxy.proxyUrl)
      if (!isLoopbackUrl(finalUrl)) throw new Error('项目预览必须使用本机回环地址')
      if (!isLoopbackUrl(nextProxyUrl)) throw new Error('预览代理必须使用本机回环地址')
      setUrl(finalUrl)
      setLoadedUrl(finalUrl)
      setProxyUrl(nextProxyUrl)
      setProxyOrigin(new URL(nextProxyUrl).origin)
      setRestartLoadUrl('')
      setSelectedElement(null)
      return true
    } catch (loadError) {
      if (request === loadSequence.current) setError(errorMessage(loadError))
      return false
    } finally {
      if (request === loadSequence.current) setBusy(null)
    }
  }, [api, marker, url])

  useEffect(() => {
    if (processState.phase !== 'running' && processState.phase !== 'starting') return
    const processUrl = processState.url || restartLoadUrl
    if (!processUrl || processUrl === loadedUrl || processUrl === autoLoadedProcessUrl.current) return
    let disposed = false
    let retryTimer = 0
    let attempts = 0
    const attemptLoad = async () => {
      attempts += 1
      const loaded = await loadPreview(processUrl)
      if (disposed) return
      if (loaded) {
        autoLoadedProcessUrl.current = processUrl
      } else if (
        attempts < PREVIEW_AUTO_LOAD_RETRY_LIMIT
        && (processState.phase === 'running' || processState.phase === 'starting')
      ) {
        retryTimer = window.setTimeout(() => void attemptLoad(), PREVIEW_AUTO_LOAD_RETRY_DELAY_MS)
      }
    }
    void attemptLoad()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
    }
  }, [loadPreview, loadedUrl, processState.phase, processState.url, restartLoadUrl])

  const startProject = useCallback(async () => {
    if (!workspacePath) return
    const previousOperation = operationVersion.current
    const operation = previousOperation + 1
    operationVersion.current = operation
    setBusy('start')
    setError('')
    try {
      const result = await api.start({ workspacePath, program: program.trim(), args: parseCommandArguments(argsText) })
      setProcessState(result)
      if (result.url) setUrl(result.url)
    } catch (startError) {
      if (operationVersion.current === operation) operationVersion.current = previousOperation
      setError(errorMessage(startError))
    } finally {
      setBusy(null)
    }
  }, [api, argsText, program, workspacePath])

  const stopProject = useCallback(async () => {
    const previousOperation = operationVersion.current
    const operation = previousOperation + 1
    operationVersion.current = operation
    setBusy('stop')
    setError('')
    try {
      const result = await api.stop()
      setRestartLoadUrl('')
      setProcessState(result)
    } catch (stopError) {
      if (operationVersion.current === operation) operationVersion.current = previousOperation
      setError(errorMessage(stopError))
    } finally {
      setBusy(null)
    }
  }, [api])

  const restartProject = useCallback(async () => {
    if (!workspacePath) return
    const previousOperation = operationVersion.current
    const operation = previousOperation + 1
    operationVersion.current = operation
    setBusy('restart')
    setError('')
    try {
      const result = await api.restart({ workspacePath, program: program.trim(), args: parseCommandArguments(argsText) })
      const nextUrl = result.url || loadedUrl
      loadSequence.current += 1
      autoLoadedProcessUrl.current = ''
      setLoadedUrl('')
      setProxyUrl('')
      setProxyOrigin('')
      setSelectedElement(null)
      setProcessState(result)
      if (result.url) setUrl(result.url)
      setRestartLoadUrl(nextUrl)
    } catch (restartError) {
      if (operationVersion.current === operation) operationVersion.current = previousOperation
      setError(errorMessage(restartError))
    } finally {
      setBusy(null)
    }
  }, [api, argsText, loadedUrl, program, workspacePath])

  const toggleSelection = () => {
    const enabled = !selecting
    setSelecting(enabled)
    if (!enabled) setSelectedElement(null)
    postSelectionMode(enabled)
  }

  const addToConversation = () => {
    if (!selectedElement) return
    onAddToConversation(buildElementPrompt(selectedElement, instruction), selectedElement)
  }

  const openTerminalCommand = () => {
    if (!onOpenTerminalCommand) return
    setError('')
    try {
      onOpenTerminalCommand(formatCommandArguments([program.trim(), ...parseCommandArguments(argsText)]))
    } catch (commandError) {
      setError(errorMessage(commandError))
    }
  }

  const openDeployCommand = () => {
    if (!onOpenTerminalCommand) return
    const command = sanitizeTerminalCommand(deployCommand)
    if (!command) return
    onOpenTerminalCommand(command)
  }

  const logText = useMemo(() => logs.map((entry) => `[${entry.stream}] ${entry.line}`).join('\n'), [logs])
  const processBusy = busy === 'start' || busy === 'restart' || busy === 'stop'
  const canStart = Boolean(workspacePath && program.trim() && !disabled && !processBusy)
  const activeProcess = processState.phase === 'running' || processState.phase === 'starting' || processState.phase === 'stopping'

  return <section className="preview-panel" aria-label="项目预览">
    <header className="preview-toolbar">
      <form className="preview-address" onSubmit={(event) => { event.preventDefault(); void loadPreview() }}>
        <Globe2 size={14} aria-hidden="true" />
        <label className="sr-only" htmlFor="preview-address-input">预览地址</label>
        <input
          id="preview-address-input"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://127.0.0.1:5173"
          spellCheck={false}
          disabled={disabled || busy === 'load'}
        />
        <button type="submit" className="preview-load-button" disabled={disabled || busy === 'load'}>
          {busy === 'load' ? <LoaderCircle className="is-spinning" size={13} aria-hidden="true" /> : <ExternalLink size={13} aria-hidden="true" />}
          <span>载入</span>
        </button>
      </form>
      <button className="preview-icon-button" type="button" title="刷新预览" aria-label="刷新预览" disabled={disabled || busy === 'load'} onClick={() => void loadPreview()}>
        <RefreshCw size={14} aria-hidden="true" />
      </button>
      <button
        className={`preview-icon-button${selecting ? ' is-active' : ''}`}
        type="button"
        title="选择页面元素"
        aria-label="选择页面元素"
        aria-pressed={selecting}
        disabled={disabled || !loadedUrl}
        onClick={toggleSelection}
      >
        <MousePointer2 size={14} aria-hidden="true" />
      </button>
    </header>

    <div className="preview-runtime-bar">
      <span
        className={`preview-runtime-state state-${processState.phase}`}
        aria-label={processState.pid ? `${phaseLabel(processState.phase)}，PID ${processState.pid}` : phaseLabel(processState.phase)}
        aria-live="polite"
      >
        <i />
        <span className="preview-runtime-state-label">{phaseLabel(processState.phase)}</span>
        {processState.pid ? <span className="preview-runtime-pid">· PID {processState.pid}</span> : null}
      </span>
      <div className="preview-runtime-actions">
        <button type="button" title="启动项目" disabled={!canStart || activeProcess} onClick={() => void startProject()}>
          <Play size={13} aria-hidden="true" /> <span>启动</span>
        </button>
        <button type="button" title="重启项目" disabled={!canStart} onClick={() => void restartProject()}>
          <RotateCcw size={13} aria-hidden="true" /> <span>重启</span>
        </button>
        <button type="button" title="停止项目" disabled={disabled || processBusy || !activeProcess} onClick={() => void stopProject()}>
          <CircleStop size={13} aria-hidden="true" /> <span>停止</span>
        </button>
        {onOpenTerminalCommand && <button type="button" title="在终端中编辑启动命令" aria-label="在终端中编辑启动命令" disabled={disabled || !program.trim()} onClick={openTerminalCommand}>
          <TerminalSquare size={13} aria-hidden="true" />
        </button>}
        {onOpenTerminalCommand && <button type="button" title="在终端准备部署" aria-label="在终端准备部署" disabled={disabled || !deployCommand.trim()} onClick={openDeployCommand}>
          <Rocket size={13} aria-hidden="true" />
        </button>}
        <button className={showCommand ? 'is-active' : ''} type="button" title="配置启动命令" aria-label="配置启动命令" aria-expanded={showCommand} onClick={() => setShowCommand((current) => !current)}>
          <Settings2 size={13} aria-hidden="true" />
        </button>
      </div>
    </div>

    {showCommand && <div className="preview-command-settings">
      <label>
        <span>启动程序</span>
        <input value={program} onChange={(event) => setProgram(event.target.value)} placeholder="npm" spellCheck={false} disabled={disabled || processBusy} />
      </label>
      <label>
        <span>启动参数</span>
        <input value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder="run dev" spellCheck={false} disabled={disabled || processBusy} />
      </label>
      {onOpenTerminalCommand && <label className="preview-deploy-command">
        <span>部署命令</span>
        <input value={deployCommand} onChange={(event) => setDeployCommand(event.target.value)} placeholder="npx vercel --prod" spellCheck={false} disabled={disabled} />
      </label>}
      <code title={workspacePath ?? '未打开工作区'}>{workspacePath ?? '打开工作区后可运行项目'}</code>
    </div>}

    {(error || processState.error) && <div className="preview-error" role="alert">{error || processState.error}</div>}

    <div className="preview-stage">
      {proxyUrl ? (
        <iframe
          key={proxyUrl}
          ref={iframeRef}
          title="项目预览"
          src={proxyUrl}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-same-origin"
          data-preview-marker={marker}
          onLoad={() => postSelectionMode(selecting)}
        />
      ) : (
        <iframe
          key="empty-preview"
          ref={iframeRef}
          title="项目预览"
          srcDoc={emptyDocument}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          data-preview-marker={marker}
        />
      )}
      {!loadedUrl && <span className="preview-stage-label">尚未载入页面</span>}
    </div>

    <aside className={`preview-selection${selectedElement ? ' has-selection' : ''}`} aria-label="选中元素">
      <div className="preview-selection-head">
        <MousePointer2 size={13} aria-hidden="true" />
        {selectedElement ? <>
          <code>{selectedElement.selector}</code>
          <span>{Math.round(selectedElement.rect.width)} x {Math.round(selectedElement.rect.height)}</span>
        </> : <span>{selecting ? '点击预览中的元素' : '开启“选择页面元素”后，可将元素上下文加入对话'}</span>}
      </div>
      {selectedElement && <>
        <p>{selectedElement.text || '无可见文本'}</p>
        <label>
          <span className="sr-only">补充修改要求</span>
          <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="补充修改要求，例如：减小标题字号并与左侧对齐…" rows={2} />
        </label>
        <div className="preview-selection-actions">
          <button type="button" className="preview-restart-button" disabled={!canStart} onClick={() => void restartProject()}>
            <RefreshCw size={13} aria-hidden="true" /> 重启并刷新
          </button>
          <button type="button" className="preview-conversation-button" onClick={addToConversation}>
            <Send size={13} aria-hidden="true" /> 添加到对话
          </button>
        </div>
      </>}
    </aside>

    <details className="preview-logs">
      <summary><TerminalSquare size={13} aria-hidden="true" /> 项目日志 <span>{logs.length}</span></summary>
      <pre>{logText || '暂无输出'}</pre>
    </details>
  </section>
}
