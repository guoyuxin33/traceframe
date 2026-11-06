import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, Layout, Model, type IJsonModel, type TabNode } from 'flexlayout-react'
import 'flexlayout-react/style/dark.css'
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  GitBranch,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cpu,
  Database,
  File,
  FileCode2,
  FolderOpen,
  GitCompareArrows,
  GitFork,
  HardDrive,
  KeyRound,
  Layers3,
  ListTree,
  MemoryStick,
  MessageSquare,
  Network,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SquareTerminal,
  TestTube2,
  X,
  Zap,
} from 'lucide-react'
import {
  OFFICIAL_OPENAI_TEXT_MODELS,
  initialAgents,
  initialMemories,
  initialMessages,
  initialProviders,
  initialSessionAgents,
  initialSessionMessages,
  initialSessions,
} from './data'
import type { Agent, MemoryRecord, MemoryScope, Message, Provider, Session } from './types'
import {
  appendNativeMessage,
  archiveNativeSession,
  cancelNativeRun,
  compactNativeSession,
  createNativeSession,
  deleteNativeMemory,
  getAppSnapshot,
  getGitDiff,
  getGitSnapshot,
  getNativeCapabilities,
  getRecentWorkspace,
  getWorkspaceTree,
  isDesktopRuntime,
  listGitBranches,
  pickWorkspace,
  readWorkspaceFile,
  saveNativeMemory,
  startNativeRun,
  switchGitBranch,
  testNativeProvider,
  updateNativeMemory,
  updateNativeSessionScope,
  writeWorkspaceFile,
  type GitSnapshot,
  type NativeCapabilities,
  type WorkspaceFile,
  type WorkspaceTreeEntry,
} from './native'
import type { RuntimeEventRecord } from './types'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type SettingsSection = 'models' | 'appearance'
type EditorMode = 'view' | 'edit'

interface UiPreferences {
  theme: 'graphite' | 'light' | 'terminal'
  density: 'compact' | 'comfortable'
  layout: 'balanced' | 'code' | 'conversation'
}

const defaultUiPreferences: UiPreferences = {
  theme: 'graphite',
  density: 'compact',
  layout: 'balanced',
}

const DOCK_LAYOUT_STORAGE_KEY = 'traceframe.dock-layout.v3'
const DOCK_COMPONENTS = ['sessions', 'conversation', 'code', 'diff', 'output', 'trace', 'context', 'agents', 'memory'] as const
type DockComponent = typeof DOCK_COMPONENTS[number]

function dockTab(id: DockComponent, name: string) {
  return { type: 'tab' as const, id, name, component: id }
}

function dockLayoutJson(preset: UiPreferences['layout']): IJsonModel {
  const weights = preset === 'code' ? [18, 20, 45, 17] : preset === 'conversation' ? [18, 38, 27, 17] : [18, 28, 37, 17]
  const workspaceWeights = preset === 'code' ? [72, 28] : preset === 'conversation' ? [58, 42] : [66, 34]
  return {
    global: {
      tabEnableClose: false,
      tabEnableFloat: false,
      tabSetEnableClose: false,
    },
    borders: [],
    layout: {
      type: 'row',
      weight: 100,
      children: [
        { type: 'tabset', weight: weights[0], minWidth: 200, children: [dockTab('sessions', 'Sessions')] },
        { type: 'tabset', weight: weights[1], minWidth: 220, children: [dockTab('conversation', 'Conversation')] },
        {
          type: 'row',
          weight: weights[2],
          minWidth: 360,
          children: [
            { type: 'tabset', weight: workspaceWeights[0], minHeight: 240, children: [dockTab('code', 'Code'), dockTab('diff', 'Diff')] },
            { type: 'tabset', weight: workspaceWeights[1], minHeight: 160, children: [dockTab('output', 'Output'), dockTab('trace', 'Trace')] },
          ],
        },
        { type: 'tabset', weight: weights[3], minWidth: 220, children: [dockTab('context', 'Context'), dockTab('agents', 'Agents'), dockTab('memory', 'Memory')] },
      ],
    },
  }
}

function collectDockComponents(node: unknown, result: string[] = []) {
  if (!node || typeof node !== 'object') return result
  const candidate = node as { component?: unknown; children?: unknown[] }
  if (typeof candidate.component === 'string') result.push(candidate.component)
  candidate.children?.forEach((child) => collectDockComponents(child, result))
  return result
}

function isValidDockLayout(value: IJsonModel) {
  const components = collectDockComponents(value.layout).sort()
  const required = [...DOCK_COMPONENTS].sort()
  return components.length === required.length && components.every((component, index) => component === required[index])
}

function storedDockModel(preset: UiPreferences['layout']) {
  try {
    const stored = loadStored<IJsonModel>(DOCK_LAYOUT_STORAGE_KEY, dockLayoutJson(preset))
    return Model.fromJson(isValidDockLayout(stored) ? stored : dockLayoutJson(preset))
  } catch {
    return Model.fromJson(dockLayoutJson(preset))
  }
}

function loadStored<T>(key: string, fallback: T): T {
  const stored = localStorage.getItem(key)
  if (!stored) return fallback
  try {
    return JSON.parse(stored) as T
  } catch {
    return fallback
  }
}

export function firstActiveSessionId(sessions: Session[]) {
  return sessions.find((session) => session.active && !session.archived)?.id
    ?? sessions.find((session) => !session.archived)?.id
    ?? sessions[0]?.id
    ?? ''
}

export function activeSessionIdAfterArchive(sessions: Session[], activeId: string, session: Session) {
  if (session.archived || session.id !== activeId) return activeId
  const candidates = sessions.filter((candidate) => candidate.id !== session.id && !candidate.archived)
  return candidates.find((candidate) => candidate.active)?.id ?? candidates[0]?.id ?? ''
}

export function shouldFocusPromptShortcut(session: Pick<Session, 'archived'>, runActive: boolean, cancellationPending: boolean) {
  return !session.archived && !runActive && !cancellationPending
}

export type RunCancellationOutcome =
  | { status: 'requested' }
  | { status: 'missing'; message: string }
  | { status: 'failed'; message: string }

export async function requestRunCancellation(runId: string, cancel: (id: string) => Promise<boolean> = cancelNativeRun): Promise<RunCancellationOutcome> {
  try {
    return await cancel(runId)
      ? { status: 'requested' }
      : { status: 'missing', message: 'The active run was no longer available to stop. Traceframe returned to idle.' }
  } catch (error) {
    return { status: 'failed', message: `The active run could not be stopped: ${errorMessage(error)}` }
  }
}

export type WorkspacePickerOutcome =
  | { started: false }
  | { started: true; selected: string | null }

export async function requestWorkspaceSelection(
  lock: { current: boolean },
  setPending: (pending: boolean) => void,
  pick: () => Promise<string | null> = pickWorkspace,
): Promise<WorkspacePickerOutcome> {
  if (lock.current) return { started: false }
  lock.current = true
  setPending(true)
  try {
    return { started: true, selected: await pick() }
  } finally {
    lock.current = false
    setPending(false)
  }
}

export async function validateWorkspaceCandidate(
  selected: string | null,
  currentPath: string | undefined,
  validate: (path: string) => Promise<unknown> = getGitSnapshot,
) {
  if (selected && selected !== currentPath) await validate(selected)
  return selected
}

export function isRetiredOpenAiModel(model: string) {
  return new Set(['gpt-5', 'gpt-5-codex']).has(model.trim().toLowerCase())
}

function loadProviders() {
  const stored = loadStored<Provider[]>('traceframe.providers', [])
    .filter((provider) => String(provider.adapter) !== 'codex-cli')
  const defaults = initialProviders.map((provider) => {
    const persisted = stored.find((candidate) => candidate.id === provider.id)
    const model = persisted?.model ?? provider.model
    return {
      ...provider,
      ...persisted,
      model: isRetiredOpenAiModel(model) ? '' : model,
      apiKey: undefined,
      availableModels: undefined,
      catalogModels: provider.catalogModels,
      connected: false,
      latency: 0,
    }
  })
  const custom = stored
    .filter((provider) => !initialProviders.some((candidate) => candidate.id === provider.id))
    .map((provider) => ({
      ...provider,
      model: isRetiredOpenAiModel(provider.model) ? '' : provider.model,
      apiKey: undefined,
      availableModels: undefined,
      catalogModels: undefined,
      connected: false,
      latency: 0,
    }))
  return [...defaults, ...custom]
}

interface WorkspaceView {
  path: string
  name: string
  snapshot: GitSnapshot
  branches: string[]
  tree: WorkspaceTreeEntry[]
  treeTruncated: boolean
}

const IconButton = ({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
  children: React.ReactNode
}) => (
  <button
    className={`icon-button${active ? ' is-active' : ''}`}
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
)

export function TopBar({
  workspace,
  branch,
  branches,
  branchBusy,
  workspaceLoading,
  workspacePickerPending,
  onBranch,
  onOpenWorkspace,
  model,
  setModel,
  providers,
  runState,
  runCancelPending,
  promptDisabled,
  onRun,
  onSettings,
}: {
  workspace: WorkspaceView | null
  branch: string
  branches: string[]
  branchBusy: boolean
  workspaceLoading: boolean
  workspacePickerPending: boolean
  onBranch: (value: string) => void
  onOpenWorkspace: () => void
  model: string
  setModel: (value: string) => void
  providers: Provider[]
  runState: 'idle' | 'running'
  runCancelPending: boolean
  promptDisabled: boolean
  onRun: () => void
  onSettings: () => void
}) {
  const runActive = runState === 'running'
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="brand-name">Traceframe</span>
        <span className="version">0.3</span>
      </div>

      <button
        className={`project-switcher${workspace ? '' : ' is-empty'}`}
        type="button"
        onClick={onOpenWorkspace}
        disabled={workspacePickerPending || workspaceLoading || branchBusy || runActive}
        aria-busy={workspacePickerPending}
        title={workspacePickerPending ? 'Waiting for folder selection' : workspace?.path ?? 'Open a local workspace'}
      >
        {workspacePickerPending ? <RefreshCw className="is-spinning" size={16} /> : workspace ? <HardDrive size={16} /> : <FolderOpen size={16} />}
        <span>{workspacePickerPending ? 'Choosing workspace…' : workspace?.name ?? 'Open workspace'}</span>
        <ChevronDown size={14} />
      </button>

      <div className="topbar-spacer" />

      <label className="compact-select branch-select">
        <GitFork size={15} />
        <span className="sr-only">当前分支</span>
        <select value={branch} disabled={!workspace || branchBusy || workspacePickerPending || workspaceLoading || runActive} onChange={(event) => onBranch(event.target.value)}>
          {branches.length ? branches.map((item) => <option value={item} key={item}>{item}</option>) : <option value={branch}>{branch}</option>}
        </select>
      </label>

      <label className="compact-select model-select">
        <Cpu size={15} />
        <span className="sr-only">主智能体模型</span>
        <select value={model} disabled={runActive} onChange={(event) => setModel(event.target.value)}>
          {providers.map((provider) => (
            <option value={provider.id} key={provider.id}>{provider.name}{provider.model ? ` · ${provider.model}` : ' · select model'}{['cc-switch-responses', 'openai-responses'].includes(provider.adapter) ? '' : ' · chat only'}</option>
          ))}
        </select>
      </label>

      <button className={`run-button${runState === 'running' ? ' is-running' : ''}`} type="button" disabled={runCancelPending || (!runActive && promptDisabled)} title={runCancelPending ? 'Waiting for the active run to stop' : !runActive && promptDisabled ? 'Restore this session before sending another prompt' : undefined} onClick={onRun}>
        {runCancelPending ? <RefreshCw className="is-spinning" size={15} /> : runActive ? <SquareTerminal size={15} /> : <Play size={15} fill="currentColor" />}
        <span>{runCancelPending ? 'Stopping…' : runActive ? 'Stop run' : 'Focus prompt'}</span>
        {!runActive ? <kbd>⌘↵</kbd> : null}
      </button>

      <IconButton label="模型与 API 设置" onClick={onSettings}>
        <Settings size={17} />
      </IconButton>
    </header>
  )
}

function AppRail({ onShowSessions, onShowDock }: { onShowSessions: () => void; onShowDock: (component: DockComponent) => void }) {
  return (
    <nav className="app-rail" aria-label="主导航">
      <div className="rail-primary">
        <IconButton label="会话" onClick={onShowSessions}><MessageSquare size={18} /></IconButton>
        <IconButton label="智能体拓扑" onClick={() => onShowDock('agents')}><Network size={18} /></IconButton>
        <IconButton label="记忆库" onClick={() => onShowDock('memory')}><Database size={18} /></IconButton>
      </div>
      <div className="rail-secondary">
        <div className="user-avatar" aria-label="当前用户">GX</div>
      </div>
    </nav>
  )
}

export function SessionsPanel({
  sessions,
  activeId,
  branchCount,
  changeCount,
  onSelect,
  onNew,
  onArchive,
  onOpenWorkspace,
  busy,
  workspacePickerPending = false,
}: {
  sessions: Session[]
  activeId: string
  branchCount: number
  changeCount: number
  onSelect: (session: Session) => void
  onNew: () => void
  onArchive: (session: Session) => void
  onOpenWorkspace: () => void
  busy: boolean
  workspacePickerPending?: boolean
}) {
  const [query, setQuery] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const visibleSessions = sessions.filter((session) => {
    const matchesQuery = `${session.title} ${session.summary} ${session.branch}`.toLowerCase().includes(query.trim().toLowerCase())
    return Boolean(session.archived) === showArchived && matchesQuery && (!unreadOnly || Boolean(session.unread))
  })
  const activeSession = sessions.find((session) => session.id === activeId)
  const hasUnread = sessions.some((session) => Boolean(session.unread))

  return (
    <aside className="sessions-panel">
      <div className="panel-title-row">
        <div>
          <h2>Sessions</h2>
          <span>{sessions.filter((session) => !session.archived).length} active threads</span>
        </div>
        <div className="head-actions">
          {activeSession ? <IconButton label={activeSession.archived ? '恢复当前会话' : '归档当前会话'} disabled={busy} onClick={() => onArchive(activeSession)}><Archive size={16} /></IconButton> : null}
          <IconButton label="新建会话" disabled={busy} onClick={onNew}><Plus size={17} /></IconButton>
        </div>
      </div>

      <div className="session-filter">
        <Search size={15} />
        <input aria-label="搜索会话" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <kbd>⌘K</kbd>
      </div>

      <div className="session-group-label">
        <button
          type="button"
          aria-label={showArchived ? '显示活跃会话' : '显示已归档会话'}
          aria-pressed={showArchived}
          onClick={() => setShowArchived((current) => !current)}
        >{showArchived ? 'Archived' : 'Active'}</button>
        {hasUnread ? <button
          type="button"
          className={unreadOnly ? 'is-active' : ''}
          aria-label={unreadOnly ? '显示全部会话' : '只显示未读会话'}
          aria-pressed={unreadOnly}
          title={unreadOnly ? 'Show all sessions' : 'Unread only'}
          onClick={() => setUnreadOnly((current) => !current)}
        ><Layers3 size={14} /></button> : null}
      </div>

      <div className="session-list">
        {visibleSessions.map((session) => (
          <button
            type="button"
            key={session.id}
            disabled={busy}
            className={`session-item${session.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(session)}
          >
            <span className="trace-notch" aria-hidden="true" />
            <span className="session-main">
              <span className="session-title">{session.title}</span>
              <span className="session-summary">{session.summary}</span>
              <span className="session-branch"><GitBranch size={12} />{session.branch}</span>
            </span>
            <span className="session-meta">
              <time>{session.time}</time>
              {session.unread ? <span className="unread-count">{session.unread}</span> : null}
            </span>
          </button>
        ))}
        {!visibleSessions.length ? (
          <div className="session-empty"><Search size={16} /><span>No matching sessions</span></div>
        ) : null}
      </div>

      <button className="sessions-footer" type="button" disabled={busy} aria-busy={workspacePickerPending} onClick={onOpenWorkspace}>
        <div className="repo-state">
          <span className="repo-icon">{workspacePickerPending ? <RefreshCw className="is-spinning" size={15} /> : <GitFork size={15} />}</span>
          <span>
            <strong>{workspacePickerPending ? 'Choosing workspace…' : branchCount ? `${branchCount} branches` : 'No workspace'}</strong>
            <small>{workspacePickerPending ? 'Complete or cancel the folder dialog' : changeCount ? `${changeCount} changed files` : branchCount ? 'Working tree clean' : 'Open a local repository'}</small>
          </span>
        </div>
        <ChevronRight size={15} />
      </button>
    </aside>
  )
}

function MessageCard({ message }: { message: Message }) {
  return (
    <article className={`message message-${message.role}`}>
      <div className="message-rail" aria-hidden="true">
        <span className="message-node" />
      </div>
      <div className="message-content">
        <header>
          <span className="message-author">{message.author}</span>
          <time>{message.time}</time>
        </header>
        <p>{message.body}</p>
        {message.steps ? (
          <ol className="message-steps">
            {message.steps.map((step, index) => (
              <li key={step}>
                <span>{index + 1}</span>
                {step}
                <Check size={13} />
              </li>
            ))}
          </ol>
        ) : null}
        {message.meta ? <footer>{message.meta}</footer> : null}
      </div>
    </article>
  )
}

export function ConversationPanel({
  session,
  messages,
  liveMessage,
  agents,
  disabled,
  onSend,
}: {
  session: Session
  messages: Message[]
  liveMessage?: Message
  agents: Agent[]
  disabled: boolean
  onSend: (text: string) => Promise<boolean>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const streamEnd = useRef<HTMLDivElement>(null)
  const draft = drafts[session.id] ?? ''
  const workingAgents = agents.filter((agent) => agent.state === 'working')
  const activeWorker = workingAgents.find((agent) => agent.parent) ?? workingAgents[0]

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [liveMessage?.body, messages.length])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || !draft.trim()) return
    if (await onSend(draft.trim())) {
      setDrafts((current) => ({ ...current, [session.id]: '' }))
    }
  }

  return (
    <section className="conversation-panel" aria-label="智能体对话">
      <div className="workspace-section-head">
        <div>
          <span className="eyebrow">Session trace</span>
          <h1>{session.title}</h1>
        </div>
        <div className="head-actions">
          <span className={`live-indicator${workingAgents.length ? '' : ' is-idle'}`}><span /> {workingAgents.length} agents working</span>
        </div>
      </div>

      <div className="message-stream" aria-live="polite">
        <div className="stream-date"><span />Today · {messages[0]?.time.slice(0, 5) ?? 'now'}<span /></div>
        {messages.map((message) => <MessageCard key={message.id} message={message} />)}
        {liveMessage ? <MessageCard message={liveMessage} /> : null}
        {activeWorker ? (
          <div className="agent-thinking">
            <span className="thinking-caret">›</span>
            <span>{activeWorker.name} · <code>{activeWorker.task}</code></span>
            <span className="thinking-time">{activeWorker.progress}%</span>
          </div>
        ) : null}
        <div ref={streamEnd} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDrafts((current) => ({ ...current, [session.id]: event.target.value }))}
          disabled={disabled}
          rows={3}
          placeholder={session.archived ? 'Restore this session to continue' : disabled ? 'Run in progress' : 'Message orchestrator…'}
          aria-label="发送给主智能体"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <span className="scope-label">scope: {session.branch}</span>
          </div>
          <button className="send-button" type="submit" aria-label="发送消息" disabled={disabled || !draft.trim()}><Send size={16} /></button>
        </div>
      </form>
    </section>
  )
}

function fileStatus(snapshot: GitSnapshot, path: string) {
  const state = snapshot.files.find((file) => file.path === path)
  if (!state) return undefined
  const status = state.worktreeStatus !== ' ' ? state.worktreeStatus : state.indexStatus
  return status === '?' ? 'U' : status
}

export function FileTree({
  workspace,
  selected,
  loading,
  disabled = false,
  onSelect,
  onRefresh,
  onOpen,
}: {
  workspace: WorkspaceView | null
  selected: string
  loading: boolean
  disabled?: boolean
  onSelect: (name: string) => void
  onRefresh: () => void
  onOpen: () => void
}) {
  const [rootCollapsed, setRootCollapsed] = useState(false)
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    setRootCollapsed(false)
    setCollapsedPaths(new Set())
  }, [workspace?.path])
  const knownPaths = new Set(workspace?.tree.map((item) => item.path) ?? [])
  const changedOnly = workspace?.snapshot.files
    .filter((item) => !knownPaths.has(item.path))
    .map((item): WorkspaceTreeEntry => ({
      path: item.path,
      name: item.path,
      kind: 'file',
      depth: 0,
    })) ?? []
  const visibleTree = [...changedOnly, ...(workspace?.tree ?? [])]
  const renderedTree = rootCollapsed ? [] : visibleTree.filter((item) => (
    ![...collapsedPaths].some((directory) => item.path.startsWith(`${directory}/`))
  ))

  const toggleDirectory = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <aside className="file-tree">
      <div className="file-tree-head">
        <span>Explorer</span>
        {workspace ? (
          <button type="button" className={`tree-refresh${loading ? ' is-loading' : ''}`} onClick={onRefresh} disabled={loading || disabled} aria-busy={loading} aria-label="刷新工作区" title="刷新工作区">
            <RefreshCw size={13} className={loading ? 'is-spinning' : ''} />
          </button>
        ) : null}
      </div>
      <button className="tree-root" type="button" disabled={!workspace || loading || disabled} aria-expanded={workspace ? !rootCollapsed : undefined} onClick={() => setRootCollapsed((current) => !current)}>
        {workspace ? rootCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} /> : <FolderOpen size={13} />}
        <span>{workspace?.name ?? 'No workspace'}</span>
      </button>
      <div className="file-list">
        {!workspace ? (
          <div className="tree-empty">
            <p>Select a local Git repository to inspect its files and changes.</p>
            <button type="button" disabled={loading || disabled} onClick={onOpen}><FolderOpen size={14} />Open folder</button>
          </div>
        ) : null}
        {workspace?.treeTruncated ? <div className="tree-limit">Explorer limited to 800 entries. Changed files are listed first.</div> : null}
        {changedOnly.length ? <div className="tree-changed-label">Changed outside explorer</div> : null}
        {renderedTree.map((item) => {
          const status = item.kind === 'file' && workspace ? fileStatus(workspace.snapshot, item.path) : undefined
          if (item.kind === 'directory') {
            return (
              <button
                key={item.path}
                type="button"
                disabled={loading || disabled}
                className="file-row is-directory"
                style={{ '--depth': item.depth } as React.CSSProperties}
                title={item.path}
                aria-expanded={!collapsedPaths.has(item.path)}
                onClick={() => toggleDirectory(item.path)}
              >
                <span className="file-indent">{collapsedPaths.has(item.path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                <span className="folder-icon"><FolderOpen size={13} /></span>
                <span>{item.name}</span>
              </button>
            )
          }
          return (
          <button
            key={item.path}
            type="button"
            disabled={loading || disabled}
            className={`file-row${selected === item.path ? ' is-active' : ''}`}
            style={{ '--depth': item.depth } as React.CSSProperties}
            onClick={() => onSelect(item.path)}
            title={item.path}
          >
            <span className="file-indent" />
            <FileCode2 size={14} />
            <span>{item.name}</span>
            {status ? <b className={`file-status status-${status.toLowerCase()}`}>{status}</b> : null}
          </button>
          )
        })}
      </div>
    </aside>
  )
}

export function CodeView({
  file,
  loading,
  error,
  mode,
  draft,
  draftPath,
  dirty,
  saving,
  saveError,
  canEdit,
  onMode,
  onDraft,
  onSave,
  onRevert,
}: {
  file: WorkspaceFile | null
  loading: boolean
  error: string | null
  mode: EditorMode
  draft: string
  draftPath: string
  dirty: boolean
  saving: boolean
  saveError: string | null
  canEdit: boolean
  onMode: (mode: EditorMode) => void
  onDraft: (content: string) => void
  onSave: () => void
  onRevert: () => void
}) {
  const gutterRef = useRef<HTMLPreElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const [tabMovesFocus, setTabMovesFocus] = useState(false)
  if (loading) return <div className="workspace-empty"><RefreshCw className="is-spinning" size={18} /><strong>Reading file</strong></div>
  if (error && !file) return <div className="workspace-empty is-error"><File size={18} /><strong>Preview unavailable</strong><p>{error}</p></div>
  if (!file) return <div className="workspace-empty"><FileCode2 size={18} /><strong>Select a file</strong><p>Code and diffs stay tied to the selected workspace.</p></div>

  const content = draftPath === file.path ? draft : file.content
  const lines = content.split('\n')
  return (
    <div className={`code-editor mode-${mode}`} role="region" aria-label="代码编辑器">
      <div className="code-editor-toolbar">
        <div className="editor-mode-toggle" role="group" aria-label="编辑器模式">
          <button type="button" className={mode === 'view' ? 'is-active' : ''} aria-pressed={mode === 'view'} onClick={() => onMode('view')} disabled={saving}>View</button>
          <button type="button" className={mode === 'edit' ? 'is-active' : ''} aria-pressed={mode === 'edit'} onClick={() => onMode('edit')} disabled={!canEdit || saving}>Edit</button>
        </div>
        <span className={`editor-file-state${dirty ? ' is-dirty' : ''}`}>{dirty ? 'Unsaved changes' : file.truncated ? 'Read only' : 'Saved'}</span>
        <div className="editor-actions">
          <button type="button" onClick={onRevert} disabled={!dirty || saving} title="Revert unsaved changes"><RotateCcw size={14} />Revert</button>
          <button className="editor-save" type="button" onClick={onSave} disabled={!dirty || saving || !canEdit} title="Save file">
            {saving ? <RefreshCw className="is-spinning" size={14} /> : <Save size={14} />}
            {saving ? 'Saving' : 'Save'}
            {!saving && dirty ? <kbd>⌘S</kbd> : null}
          </button>
        </div>
      </div>
      {saveError || error ? <div className="editor-error" role="alert">{saveError ?? error}</div> : null}
      {file.truncated ? <div className="file-preview-note">Preview limited for responsiveness · source size {(file.size / 1024).toFixed(0)} KB</div> : null}
      {mode === 'edit' && canEdit ? (
        <div className="code-editor-input">
          <pre className="editor-gutter" ref={gutterRef} aria-hidden="true">{lines.map((_, index) => index + 1).join('\n')}</pre>
          <textarea
            ref={editorRef}
            value={content}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setTabMovesFocus(true)
                return
              }
              if (event.key !== 'Tab' || event.shiftKey || tabMovesFocus) return
              event.preventDefault()
              const start = event.currentTarget.selectionStart
              const end = event.currentTarget.selectionEnd
              onDraft(`${content.slice(0, start)}\t${content.slice(end)}`)
              requestAnimationFrame(() => editorRef.current?.setSelectionRange(start + 1, start + 1))
            }}
            onBlur={() => setTabMovesFocus(false)}
            onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop }}
            disabled={saving}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label={`编辑 ${file.path}`}
            aria-describedby="editor-tab-help"
          />
          <span className="sr-only" id="editor-tab-help">Press Escape then Tab to move focus out of the editor</span>
        </div>
      ) : (
        <div className="code-view">
          {lines.map((line, index) => (
            <div className="code-line" key={`${index}-${line.slice(0, 16)}`}>
              <span className="line-number">{index + 1}</span>
              <code>{line || ' '}</code>
            </div>
          ))}
        </div>
      )}
      <div className="code-editor-status"><span>{lines.length} lines</span><span>{content.length.toLocaleString()} chars</span><span>UTF-8</span><span>{mode === 'edit' ? dirty ? 'Modified' : 'Editing' : 'Viewing'}</span></div>
    </div>
  )
}

interface ParsedDiffLine {
  type: 'context' | 'add' | 'remove' | 'meta'
  old: string
  next: string
  text: string
}

function parseUnifiedDiff(diff: string): ParsedDiffLine[] {
  let oldLine = 0
  let nextLine = 0
  let inHunk = false

  return diff.split('\n').filter((line, index, lines) => line || index < lines.length - 1).map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldLine = Number(hunk[1])
      nextLine = Number(hunk[2])
      inHunk = true
      return { type: 'meta', old: '', next: '', text: line }
    }
    if (!inHunk || line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('\\ ')) {
      return { type: 'meta', old: '', next: '', text: line }
    }
    if (line.startsWith('+')) {
      const parsed = { type: 'add' as const, old: '', next: String(nextLine), text: line.slice(1) }
      nextLine += 1
      return parsed
    }
    if (line.startsWith('-')) {
      const parsed = { type: 'remove' as const, old: String(oldLine), next: '', text: line.slice(1) }
      oldLine += 1
      return parsed
    }
    const parsed = { type: 'context' as const, old: String(oldLine), next: String(nextLine), text: line.startsWith(' ') ? line.slice(1) : line }
    oldLine += 1
    nextLine += 1
    return parsed
  })
}

function DiffView({ diff, path, loading, error }: { diff: string; path: string; loading: boolean; error: string | null }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const additions = lines.filter((line) => line.type === 'add').length
  const deletions = lines.filter((line) => line.type === 'remove').length

  if (loading) return <div className="workspace-empty"><RefreshCw className="is-spinning" size={18} /><strong>Reading diff</strong></div>
  if (!path) return <div className="workspace-empty"><GitCompareArrows size={18} /><strong>Select a changed file</strong></div>
  if (error && !diff.trim()) return <div className="workspace-empty is-error"><GitCompareArrows size={18} /><strong>Diff unavailable</strong><p>{error}</p></div>
  if (!diff.trim()) return <div className="workspace-empty"><Check size={18} /><strong>No tracked diff</strong><p>The file is clean or currently untracked.</p></div>

  return (
    <div className="diff-view" role="region" aria-label="代码差异">
      {error ? <div className="diff-error-note">Partial diff · {error}</div> : null}
      <div className="diff-file-head">
        <span>{path}</span>
        <span><b>+{additions}</b><i>−{deletions}</i></span>
      </div>
      {lines.map((line, index) => (
        <div className={`diff-line diff-${line.type}`} key={`${line.old}-${line.next}-${index}-${line.text.slice(0, 12)}`}>
          <span className="diff-gutter">{line.old}</span>
          <span className="diff-gutter">{line.next}</span>
          <span className="diff-symbol">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : line.type === 'meta' ? '·' : ' '}</span>
          <code>{line.text || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function eventItem(event: RuntimeEventRecord) {
  const item = event.payload.item
  return item && typeof item === 'object' ? item as Record<string, unknown> : undefined
}

function recordValue(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function runtimeAgentState(status: unknown, eventType: string): Agent['state'] {
  const value = String(status ?? '').toLowerCase()
  if (['completed', 'complete', 'done', 'shutdown', 'closed', 'success', 'succeeded'].includes(value)) return 'done'
  if (['queued', 'pending', 'waiting', 'idle'].includes(value)) return 'queued'
  if (['running', 'working', 'active', 'in_progress', 'in-progress', 'started'].includes(value)) return 'working'
  return eventType === 'agent.completed' ? 'done' : 'working'
}

function deriveRuntimeAgents(events: RuntimeEventRecord[], root: Agent) {
  const derived = new Map<string, Agent>()
  const colors: Agent['color'][] = ['amber', 'green', 'magenta', 'cyan']
  const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp)

  const upsert = (id: string, detail: Record<string, unknown>, source: Record<string, unknown>, event: RuntimeEventRecord) => {
    const existing = derived.get(id)
    const state = runtimeAgentState(detail.status ?? detail.state ?? source.status, event.type)
    const shortId = id.length > 12 ? id.slice(0, 8) : id
    derived.set(id, {
      id,
      name: firstString(detail.name, detail.agent_name, source.name, source.agent_name) ?? `Agent ${shortId}`,
      role: firstString(detail.role, detail.agent_role, source.role, source.agent_role) ?? 'Subagent',
      model: firstString(detail.model, source.model) ?? root.model,
      state,
      progress: state === 'done' ? 100 : state === 'queued' ? 0 : 50,
      parent: root.id,
      task: firstString(detail.task, detail.message, detail.prompt, source.task, source.message, source.prompt, source.tool) ?? 'Delegated task',
      color: existing?.color ?? colors[derived.size % colors.length],
    })
  }

  orderedEvents.forEach((event) => {
    if (event.type !== 'agent.started' && event.type !== 'agent.completed') return
    const item = eventItem(event)
    const source = { ...event.payload, ...(item ?? {}) }
    const rawReceivers = source.receiver_thread_ids
    const receiverValues = Array.isArray(rawReceivers) ? rawReceivers : firstString(rawReceivers) ? [rawReceivers] : []
    const candidates = new Map<string, Record<string, unknown>>()
    const directId = firstString(source.agentId, source.agent_id, source.threadId, source.thread_id)
    if (directId) candidates.set(directId, source)

    receiverValues.forEach((value) => {
      const detail = recordValue(value)
      const id = detail
        ? firstString(detail.thread_id, detail.threadId, detail.agent_id, detail.id)
        : firstString(value)
      if (id) candidates.set(id, detail ?? {})
    })

    const states = source.agents_states ?? event.payload.agents_states
    if (Array.isArray(states)) {
      states.forEach((value) => {
        const detail = recordValue(value)
        const id = detail && firstString(detail.thread_id, detail.threadId, detail.agent_id, detail.id)
        if (id) candidates.set(id, { ...(candidates.get(id) ?? {}), ...detail })
      })
    } else {
      const stateRecord = recordValue(states)
      if (stateRecord) {
        const directId = firstString(stateRecord.thread_id, stateRecord.threadId, stateRecord.agent_id, stateRecord.id)
        if (directId) {
          candidates.set(directId, { ...(candidates.get(directId) ?? {}), ...stateRecord })
        } else if (candidates.size === 1 && ('status' in stateRecord || 'state' in stateRecord)) {
          const id = candidates.keys().next().value as string
          candidates.set(id, { ...(candidates.get(id) ?? {}), ...stateRecord })
        } else {
          Object.entries(stateRecord).forEach(([id, value]) => {
            const detail = recordValue(value) ?? { status: value }
            candidates.set(id, { ...(candidates.get(id) ?? {}), ...detail })
          })
        }
      }
    }

    candidates.forEach((detail, id) => upsert(id, detail, source, event))
  })

  return [root, ...derived.values()]
}

function TerminalView({ runState, workspace, branch, events }: { runState: 'idle' | 'running'; workspace: WorkspaceView | null; branch: string; events: RuntimeEventRecord[] }) {
  const commands = events.filter((event) => ['tool.started', 'tool.completed', 'tool.failed'].includes(event.type))
  return (
    <div className="terminal-view" role="log" aria-live="polite">
      <div><span className="prompt">trace@{branch}</span><span className="terminal-path"> {workspace?.path ?? '~'}</span> git status --short</div>
      {workspace?.snapshot.files.length ? workspace.snapshot.files.map((file) => (
        <div className="terminal-muted" key={file.path}> {file.indexStatus}{file.worktreeStatus} {file.path}</div>
      )) : <div className="terminal-pass"> ✓ Working tree clean</div>}
      {commands.slice(0, 24).reverse().map((event) => {
        const item = eventItem(event)
        const completed = event.type === 'tool.completed'
        const output = firstString(event.payload.output, item?.aggregated_output)
        return <div key={event.id} className={completed ? 'terminal-muted' : event.type === 'tool.failed' ? 'terminal-error' : 'terminal-active'}>
          <span className="prompt">{completed ? '$' : event.type === 'tool.failed' ? '×' : '›'}</span> {String(item?.command ?? item?.name ?? 'tool')}
          {output ? <pre>{output}</pre> : null}
        </div>
      })}
      {runState === 'running' ? <div className="terminal-active">› Traceframe run is active</div> : <div><span className="prompt">trace@{branch}</span><span className="cursor-block" /></div>}
    </div>
  )
}

function ActivityView({ events }: { events: RuntimeEventRecord[] }) {
  return (
    <div className="trace-list" role="log" aria-live="polite">
      {events.slice(0, 100).map((event) => {
        const item = eventItem(event)
        const detail = firstString(item?.command, item?.name, item?.text, event.payload.text, event.payload.output, event.payload.error, item?.type)
        return <article className="trace-event" key={event.id}>
          <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
          <strong>{event.type}</strong>
          <span>{detail ?? ''}</span>
        </article>
      })}
      {!events.length ? <div className="workspace-empty"><Activity size={18} /><strong>No runtime events</strong><p>Start a run to build an auditable trace.</p></div> : null}
    </div>
  )
}

interface RepositoryDockProps {
  mode: 'code' | 'diff'
  branchBusy: boolean
  interactionBusy: boolean
  workspace: WorkspaceView | null
  selectedFile: string
  file: WorkspaceFile | null
  diff: string
  loading: boolean
  fileLoading: boolean
  error: string | null
  fileError: string | null
  diffError: string | null
  onSelectFile: (path: string) => void
  onRefresh: () => void
  onOpenWorkspace: () => void
  editor: {
    mode: EditorMode
    draft: string
    draftPath: string
    dirty: boolean
    saving: boolean
    error: string | null
    canEdit: boolean
    onMode: (mode: EditorMode) => void
    onDraft: (content: string) => void
    onSave: () => void
    onRevert: () => void
  }
}

export function RepositoryDock({
  mode,
  branchBusy,
  interactionBusy,
  workspace,
  selectedFile,
  file,
  diff,
  loading,
  fileLoading,
  error,
  fileError,
  diffError,
  onSelectFile,
  onRefresh,
  onOpenWorkspace,
  editor,
}: RepositoryDockProps) {
  const breadcrumbs = selectedFile.split('/').filter(Boolean)
  const workspaceCtaDisabled = interactionBusy || branchBusy || loading || editor.saving
  return (
    <section className={`repository-dock${error ? ' has-error' : ''}`} aria-label={mode === 'code' ? '代码文件' : '代码差异'}>
      {error ? <div className="workspace-error"><span>{error}</span><button type="button" disabled={workspaceCtaDisabled} title={interactionBusy ? 'Stop the active run before changing workspaces' : workspaceCtaDisabled ? 'Wait for the current workspace operation to finish' : undefined} onClick={onOpenWorkspace}>Choose another folder</button></div> : null}
      <div className="editor-layout">
        <FileTree
          workspace={workspace}
          selected={selectedFile}
          loading={loading}
          disabled={branchBusy || interactionBusy || editor.saving}
          onSelect={onSelectFile}
          onRefresh={onRefresh}
          onOpen={onOpenWorkspace}
        />
        <div className="editor-main">
          <div className="editor-breadcrumb">
            <span>{workspace?.name ?? 'Workspace'}</span>
            {breadcrumbs.map((part, index) => (
              <span className="breadcrumb-part" key={`${part}-${index}`}><ChevronRight size={12} />{index === breadcrumbs.length - 1 ? <strong>{part}</strong> : <span>{part}</span>}</span>
            ))}
            <div className="editor-breadcrumb-spacer" />
            <span className="editing-agent"><span />{workspace ? loading ? 'Refreshing' : 'Local snapshot' : 'No workspace'}</span>
          </div>
          <div className="editor-content">
            {mode === 'code'
              ? <CodeView
                file={file}
                loading={fileLoading}
                error={fileError}
                mode={editor.mode}
                draft={editor.draft}
                draftPath={editor.draftPath}
                dirty={editor.dirty}
                saving={editor.saving}
                saveError={editor.error}
                canEdit={editor.canEdit}
                onMode={editor.onMode}
                onDraft={editor.onDraft}
                onSave={editor.onSave}
                onRevert={editor.onRevert}
              />
              : <DiffView diff={diff} path={selectedFile} loading={fileLoading} error={diffError} />}
          </div>
        </div>
      </div>
    </section>
  )
}

export function ContextPanel({ session, messages, events, memories, onCompact, canCompact = true }: { session: Session; messages: Message[]; events: RuntimeEventRecord[]; memories: MemoryRecord[]; onCompact: () => Promise<void>; canCompact?: boolean }) {
  const [compacting, setCompacting] = useState(false)
  const uncompactedMessages = messages.slice(session.compactedMessageCount ?? 0)
  const runtimeMessages = uncompactedMessages.slice(-30)
  const messageTokens = Math.ceil(runtimeMessages.reduce((total, message) => total + message.body.length, 0) / 4)
  const summaryTokens = Math.ceil((session.contextSummary?.length ?? 0) / 4)
  const memoryTokens = Math.ceil(memories.reduce((total, memory) => total + memory.title.length + memory.detail.length, 0) / 4)
  const totalTokens = messageTokens + summaryTokens + memoryTokens
  const percent = Math.round(runtimeMessages.length / 30 * 100)
  const contextSources = [
    { label: 'Recent thread', meta: `${runtimeMessages.length} uncompacted messages`, value: messageTokens, width: totalTokens ? messageTokens / totalTokens * 100 : 0 },
    { label: 'Durable summary', meta: session.contextSummary ? `${session.contextSummary.length} characters` : 'No compacted summary', value: summaryTokens, width: totalTokens ? summaryTokens / totalTokens * 100 : 0 },
    { label: 'Saved memory', meta: `${memories.length} entries`, value: memoryTokens, width: totalTokens ? memoryTokens / totalTokens * 100 : 0 },
  ]
  const lastCompaction = events.find((event) => event.type === 'context.compacted')
  return (
    <div className="inspector-scroll">
      <section className="context-summary">
        <div className="context-meter">
          <svg viewBox="0 0 88 88" aria-label={`最近消息窗口使用 ${percent}%`}>
            <circle className="meter-track" cx="44" cy="44" r="36" />
            <circle className="meter-value" cx="44" cy="44" r="36" pathLength="100" strokeDasharray={`${percent} 100`} />
          </svg>
          <div><strong>{runtimeMessages.length}</strong><span>of 30</span></div>
        </div>
        <div className="context-numbers">
          <strong>{totalTokens.toLocaleString()} <span>input est.</span></strong>
          <small>Model limit depends on the selected provider</small>
          <button
            type="button"
            onClick={async () => {
              if (compacting) return
              setCompacting(true)
              try {
                await onCompact()
              } finally {
                setCompacting(false)
              }
            }}
            disabled={!canCompact || compacting || uncompactedMessages.length < 2 || Boolean(session.archived)}
            title={canCompact ? 'Summarize older messages and remove them from future requests' : 'Available in the desktop runtime'}
          >{compacting ? 'Compacting…' : 'Compact now'}</button>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><h3>Context sources</h3><span>{totalTokens.toLocaleString()}</span></div>
        <div className="context-source-list">
          {contextSources.map((source) => (
            <div className="context-source" key={source.label}>
              <div><strong>{source.label}</strong><span>{source.value.toLocaleString()}</span></div>
              <div className="context-bar"><span style={{ width: `${source.width}%` }} /></div>
              <small>{source.meta}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><h3>Compression policy</h3></div>
        <div className="policy-stack">
          <div><span className="policy-icon"><Zap size={14} /></span><span><strong>Recent turns</strong><small>Up to 30 uncompacted messages sent verbatim</small></span><b>{runtimeMessages.length}</b></div>
          <div><span className="policy-icon"><Boxes size={14} /></span><span><strong>Runtime trace</strong><small>Stored for audit, not sent as conversation context</small></span><b>{events.length}</b></div>
          <div><span className="policy-icon"><MemoryStick size={14} /></span><span><strong>Long-term memory</strong><small>Explicit saved entries</small></span><b>{memories.length}</b></div>
        </div>
      </section>

      {lastCompaction ? <section className="compaction-event">
        <div><CircleDot size={14} /><strong>Last compaction</strong><time>{new Date(lastCompaction.timestamp).toLocaleTimeString()}</time></div>
        <p>{String(lastCompaction.payload.messageCount ?? 0)} messages removed from future verbatim input · {String(lastCompaction.payload.remainingMessageCount ?? runtimeMessages.length)} recent retained</p>
      </section> : null}
    </div>
  )
}

export function AgentPanel({ agents, onAdd, orchestrated = false }: { agents: Agent[]; onAdd: (agent: Pick<Agent, 'name' | 'role' | 'model' | 'task'>) => void; orchestrated?: boolean }) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [role, setRole] = useState('Specialist')
  const [agentModel, setAgentModel] = useState(OFFICIAL_OPENAI_TEXT_MODELS[0])
  const workingCount = agents.filter((agent) => agent.state === 'working').length
  const childCount = agents.filter((agent) => agent.parent).length

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    onAdd({ name: name.trim(), role, model: agentModel, task: 'Waiting for a scoped task' })
    setName('')
    setAdding(false)
  }

  return (
    <div className="inspector-scroll agent-panel">
      <div className="agent-overview">
        <div><strong>{agents.length}</strong><span>agents</span></div>
        <div><strong>{workingCount}</strong><span>working</span></div>
        <div><strong>{childCount}</strong><span>children</span></div>
      </div>

      <div className="agent-tree" aria-label="智能体层级">
        {agents.map((agent, index) => (
          <div className={`agent-node${agent.parent ? ' is-child' : ' is-root'} state-${agent.state}`} key={agent.id}>
            {index > 0 ? <span className="agent-branch" aria-hidden="true" /> : null}
            <div className="agent-node-head">
              <span className={`agent-symbol tone-${agent.color}`}>{agent.role === 'Security' ? <ShieldCheck size={15} /> : agent.role === 'Test' ? <TestTube2 size={15} /> : <Bot size={15} />}</span>
              <span className="agent-identity"><strong>{agent.name}</strong><small>{agent.role}</small></span>
              <span className={`agent-state state-${agent.state}`}>{agent.state}</span>
            </div>
            <p>{agent.task}</p>
            {!orchestrated ? <div className="agent-progress"><span style={{ width: `${agent.progress}%` }} /></div> : null}
            <footer><span>{agent.model}</span>{!orchestrated ? <b>{agent.progress}%</b> : null}</footer>
          </div>
        ))}
      </div>

      {orchestrated ? (
        <div className="agent-runtime-note"><Network size={14} /><span>主智能体可串行委派最多 4 个受限子任务；每个模型调用与工具步骤都会进入 Trace</span></div>
      ) : adding ? (
        <form className="inspector-form" onSubmit={submit}>
          <div className="inspector-form-head"><strong>New specialist</strong><button type="button" aria-label="取消添加智能体" onClick={() => setAdding(false)}><X size={14} /></button></div>
          <label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Index" /></label>
          <label><span>Role</span><select value={role} onChange={(event) => setRole(event.target.value)}><option>Specialist</option><option>Backend</option><option>Security</option><option>Test</option><option>Review</option></select></label>
          <label><span>Model</span><select value={agentModel} onChange={(event) => setAgentModel(event.target.value)}>{OFFICIAL_OPENAI_TEXT_MODELS.map((modelId) => <option key={modelId}>{modelId}</option>)}<option>CC Switch active route</option></select></label>
          <button className="form-submit" type="submit" disabled={!name.trim()}><Plus size={14} />Add to session</button>
        </form>
      ) : <button className="add-agent-button" type="button" onClick={() => setAdding(true)}><Plus size={15} />Add specialist</button>}
    </div>
  )
}

export function MemoryPanel({
  memories,
  activeSessionId,
  workspacePath,
  onSave,
  onUpdate,
  onRemove,
}: {
  memories: MemoryRecord[]
  activeSessionId: string
  workspacePath?: string
  onSave: (memory: Omit<MemoryRecord, 'id' | 'time'>) => Promise<boolean>
  onUpdate: (id: string, memory: Omit<MemoryRecord, 'id' | 'time'>) => Promise<boolean>
  onRemove: (id: string) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<MemoryScope>('session')
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [type, setType] = useState<MemoryRecord['type']>('Decision')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const visibleMemories = memories.filter((memory) => {
    const matchesScope = memory.scope === scope
      && (scope !== 'session' || memory.sessionId === activeSessionId)
      && (scope !== 'project' || memory.workspacePath === workspacePath)
    const matchesQuery = `${memory.title} ${memory.detail} ${memory.type}`.toLowerCase().includes(query.trim().toLowerCase())
    return matchesScope && matchesQuery
  })

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busyAction || !title.trim() || !detail.trim() || (scope === 'project' && !workspacePath)) return
    const memory = {
      title: title.trim(),
      detail: detail.trim(),
      type,
      scope,
      sessionId: scope === 'session' ? activeSessionId : undefined,
      workspacePath: scope === 'project' ? workspacePath : undefined,
    }
    setBusyAction(editingId ? `update:${editingId}` : 'create')
    let saved = false
    try {
      saved = await (editingId ? onUpdate(editingId, memory) : onSave(memory))
    } finally {
      setBusyAction(null)
    }
    if (!saved) return
    setTitle('')
    setDetail('')
    setAdding(false)
    setEditingId(null)
  }

  const editMemory = (memory: MemoryRecord) => {
    setScope(memory.scope)
    setTitle(memory.title)
    setDetail(memory.detail)
    setType(memory.type)
    setEditingId(memory.id)
    setAdding(true)
  }

  const closeForm = () => {
    if (busyAction) return
    setAdding(false)
    setEditingId(null)
    setTitle('')
    setDetail('')
  }

  return (
    <div className="inspector-scroll memory-panel">
      <div className="memory-search"><Search size={15} /><input placeholder="Search memory" aria-label="搜索记忆" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="memory-scope">
        {(['session', 'project', 'global'] as const).map((item) => (
          <button className={scope === item ? 'is-active' : ''} type="button" key={item} aria-pressed={scope === item} disabled={Boolean(busyAction) || (item === 'project' && !workspacePath)} title={item === 'project' && !workspacePath ? 'Open a workspace to use project memory' : undefined} onClick={() => setScope(item)}>{item[0].toUpperCase() + item.slice(1)}</button>
        ))}
      </div>
      <div className="memory-list">
        {visibleMemories.map((memory) => (
          <article className="memory-item" key={memory.id}>
            <div><MemoryStick size={15} /><span>{memory.type}</span><time>{memory.time}</time><button type="button" disabled={Boolean(busyAction)} aria-label={`编辑记忆 ${memory.title}`} onClick={() => editMemory(memory)}><Pencil size={12} /></button><button type="button" disabled={Boolean(busyAction)} aria-label={`删除记忆 ${memory.title}`} onClick={async () => {
              if (busyAction) return
              setBusyAction(`delete:${memory.id}`)
              try {
                await onRemove(memory.id)
              } finally {
                setBusyAction(null)
              }
            }}>{busyAction === `delete:${memory.id}` ? <RefreshCw className="is-spinning" size={12} /> : <X size={12} />}</button></div>
            <h3>{memory.title}</h3>
            <p>{memory.detail}</p>
          </article>
        ))}
        {!visibleMemories.length ? <div className="inspector-empty">No memory in this scope</div> : null}
      </div>
      {adding ? (
        <form className="inspector-form" onSubmit={submit}>
          <div className="inspector-form-head"><strong>{editingId ? 'Edit memory' : 'Save memory'}</strong><button type="button" disabled={Boolean(busyAction)} aria-label="取消保存记忆" onClick={closeForm}><X size={14} /></button></div>
          <label><span>Title</span><input autoFocus disabled={Boolean(busyAction)} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label><span>Type</span><select disabled={Boolean(busyAction)} value={type} onChange={(event) => setType(event.target.value as MemoryRecord['type'])}><option>Decision</option><option>Preference</option><option>Project</option><option>Constraint</option></select></label>
          <label className="is-stacked"><span>Detail</span><textarea disabled={Boolean(busyAction)} rows={3} value={detail} onChange={(event) => setDetail(event.target.value)} /></label>
          <button className="form-submit" type="submit" disabled={Boolean(busyAction) || !title.trim() || !detail.trim() || (scope === 'project' && !workspacePath)}>{busyAction ? <RefreshCw className="is-spinning" size={14} /> : <MemoryStick size={14} />}{busyAction ? 'Saving…' : editingId ? 'Update memory' : `Save to ${scope}`}</button>
        </form>
      ) : <button className="add-agent-button" type="button" disabled={Boolean(busyAction)} onClick={() => setAdding(true)}><Plus size={15} />Save memory</button>}
    </div>
  )
}

export function providerTestError(provider: Provider) {
  const endpoint = provider.endpoint.trim()
  if (!endpoint) return 'Enter an endpoint before testing this provider'
  try {
    const parsed = new URL(endpoint)
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Endpoint must use http:// or https://'
    if (parsed.hostname === 'api.openai.com' && provider.adapter !== 'cc-switch-responses' && !provider.apiKey?.trim()) {
      return 'Enter an OpenAI API key before testing api.openai.com'
    }
  } catch {
    return 'Enter a complete endpoint URL, including http:// or https://'
  }
  return null
}

export function ProviderSettings({
  open,
  providers,
  preferences,
  onClose,
  onSave,
}: {
  open: boolean
  providers: Provider[]
  preferences: UiPreferences
  onClose: () => void
  onSave: (providers: Provider[], preferences: UiPreferences, resetLayout: boolean) => void
}) {
  const [draft, setDraft] = useState(providers)
  const [preferenceDraft, setPreferenceDraft] = useState(preferences)
  const [testing, setTesting] = useState<string | null>(null)
  const [section, setSection] = useState<SettingsSection>('models')
  const [layoutReset, setLayoutReset] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(providers)
    setPreferenceDraft(preferences)
    setLayoutReset(false)
  }, [providers, preferences, open])
  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = document.querySelectorAll<HTMLElement>('.topbar, .app-rail, .dock-workspace, .statusbar, .app-alert')
    background.forEach((element) => element.setAttribute('inert', ''))
    requestAnimationFrame(() => drawerRef.current?.querySelector<HTMLElement>('button')?.focus())
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !drawerRef.current) return
      const controls = [...drawerRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      if (!controls.length) return
      const first = controls[0]
      const last = controls.at(-1) as HTMLElement
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleDialogKeys)
    return () => {
      window.removeEventListener('keydown', handleDialogKeys)
      background.forEach((element) => element.removeAttribute('inert'))
      previousFocusRef.current?.focus()
    }
  }, [open, onClose])

  const updateProvider = (id: string, patch: Partial<Provider>) => {
    setDraft((current) => current.map((provider) => provider.id === id ? { ...provider, ...patch } : provider))
  }

  const addProvider = () => {
    const id = `custom-${Date.now()}`
    setDraft((current) => [...current, {
      id,
      name: 'Custom provider',
      endpoint: '',
      model: '',
      adapter: 'openai-responses',
      connected: false,
      latency: 0,
    }])
  }

  const testProvider = async (id: string) => {
    const provider = draft.find((item) => item.id === id)
    if (!provider) return
    const validationError = providerTestError(provider)
    if (validationError) {
      updateProvider(id, { connected: false, latency: 0, detail: validationError, availableModels: [] })
      return
    }
    setTesting(id)
    try {
      const health = await testNativeProvider(provider)
      updateProvider(id, {
        connected: health.ok,
        latency: health.latency,
        detail: health.detail,
        availableModels: health.models,
        model: health.models.length > 0
          ? (health.models.includes(provider.model) ? provider.model : health.models.length === 1 ? health.models[0] : '')
          : provider.model,
      })
    } catch (error) {
      updateProvider(id, { connected: false, latency: 0, detail: errorMessage(error), availableModels: [] })
    } finally {
      setTesting(null)
    }
  }

  if (!open) return null

  return (
    <div className="settings-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={drawerRef} className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="eyebrow">Settings</span><h2 id="settings-title">{section === 'models' ? 'Models & API' : 'Appearance'}</h2></div>
          <IconButton label="关闭设置" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <nav className="settings-nav" aria-label="设置分类">
          <button type="button" aria-pressed={section === 'models'} className={section === 'models' ? 'is-active' : ''} onClick={() => setSection('models')}><Cpu size={15} />Models</button>
          <button type="button" aria-pressed={section === 'appearance'} className={section === 'appearance' ? 'is-active' : ''} onClick={() => setSection('appearance')}><Layers3 size={15} />Appearance</button>
        </nav>

        <div className="settings-body">
          {section === 'models' ? (
            <>
              <div className="settings-note"><KeyRound size={16} /><p>密钥只保留在当前运行时，不写入项目或本地存储。这里持久化端点和默认模型。</p></div>
              <section className="ccswitch-section">
                <div className="ccswitch-head">
                  <div className="provider-glyph">CX</div>
                  <div>
                    <h3>CC Switch local route</h3>
                    <span>Direct Responses API connection on loopback</span>
                  </div>
                </div>
                <p>打开 CC Switch 并选择上游模型后，Traceframe 直连本地 Responses 路由。上游密钥始终由 CC Switch 管理。</p>
              </section>
              {draft.map((provider) => {
                const discoveredModels = provider.availableModels ?? []
                const modelChoices = discoveredModels.length > 0 ? discoveredModels : (provider.catalogModels ?? [])
                const modelSource = discoveredModels.length > 0 ? 'Available to this connection' : provider.catalogModels?.length ? 'Current OpenAI catalog; account access is checked when connected' : ''
                const validationError = providerTestError(provider)
                const rowTesting = testing === provider.id
                const guidanceId = `provider-guidance-${provider.id}`
                return <section className="provider-row" key={provider.id} aria-busy={rowTesting}>
                  <div className="provider-title">
                    <div className="provider-glyph">{provider.name.slice(0, 1)}</div>
                    <div><h3>{provider.name}</h3><span className={provider.connected ? 'connected' : ''}>{provider.connected ? provider.latency ? `${provider.latency} ms` : 'Connected' : provider.detail ? 'Unavailable' : 'Not tested'}</span></div>
                    <div className="provider-actions">
                      <button type="button" aria-describedby={validationError ? guidanceId : undefined} title={validationError ?? 'Test connection and discover available models'} onClick={() => void testProvider(provider.id)} disabled={Boolean(testing) || Boolean(validationError)}>{rowTesting ? 'Testing…' : 'Test'}</button>
                      {provider.id.startsWith('custom-') ? <button type="button" disabled={Boolean(testing)} aria-label={`删除提供商 ${provider.name}`} title="Remove provider" onClick={() => setDraft((current) => current.filter((item) => item.id !== provider.id))}><X size={13} /></button> : null}
                    </div>
                  </div>
                  {provider.detail ? <p className="provider-detail">{provider.detail}</p> : null}
                  {validationError ? <p className="provider-detail is-guidance" id={guidanceId}>{validationError}</p> : null}
                  {provider.id.startsWith('custom-') ? <label><span>Name</span><input disabled={rowTesting} value={provider.name} onChange={(event) => updateProvider(provider.id, { name: event.target.value })} /></label> : null}
                  <label><span>Endpoint</span><input aria-describedby={validationError ? guidanceId : undefined} disabled={rowTesting} value={provider.endpoint} placeholder="https://provider.example/v1" onChange={(event) => updateProvider(provider.id, { endpoint: event.target.value, connected: false, latency: 0, detail: undefined, availableModels: [] })} /></label>
                  {provider.adapter !== 'cc-switch-responses' ? <label><span>Protocol</span><select disabled={rowTesting} value={provider.adapter} onChange={(event) => updateProvider(provider.id, { adapter: event.target.value as Provider['adapter'], connected: false, latency: 0, detail: undefined, availableModels: [] })}><option value="openai-responses">Responses API + tools</option><option value="openai-chat">OpenAI-compatible chat</option><option value="anthropic">Anthropic Messages</option><option value="google">Google native</option></select></label> : null}
                  <label><span>Default model</span>{modelChoices.length ? (
                    <select disabled={rowTesting} value={provider.model} onChange={(event) => updateProvider(provider.id, { model: event.target.value })}>
                      <option value="">Select a model</option>
                      {modelChoices.map((availableModel) => <option value={availableModel} key={availableModel}>{availableModel}</option>)}
                    </select>
                  ) : <input disabled={rowTesting} value={provider.model} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} placeholder="Refresh models or enter the current model ID" />}</label>
                  {modelSource ? <p className="model-source">{modelSource}</p> : null}
                  {provider.adapter !== 'cc-switch-responses' ? <label><span>API key</span><input disabled={rowTesting} type="password" value={provider.apiKey ?? ''} onChange={(event) => updateProvider(provider.id, { apiKey: event.target.value, connected: false, latency: 0, detail: undefined })} placeholder="Held in memory only" autoComplete="off" /></label> : null}
                </section>
              })}
              <button className="add-provider-button" type="button" disabled={Boolean(testing)} onClick={addProvider}><Plus size={14} />Add provider</button>
            </>
          ) : (
            <div className="appearance-settings">
              <section>
                <div className="appearance-heading"><h3>Theme</h3><p>Changes chrome and editor contrast</p></div>
                <div className="theme-options">
                  {(['graphite', 'light', 'terminal'] as const).map((theme) => (
                    <button type="button" key={theme} aria-pressed={preferenceDraft.theme === theme} className={preferenceDraft.theme === theme ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, theme }))}>
                      <span className={`theme-swatch swatch-${theme}`}><i /><i /><i /></span>
                      <span>{theme === 'graphite' ? 'Graphite' : theme === 'light' ? 'Light' : 'Terminal'}</span>
                      {preferenceDraft.theme === theme ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="appearance-heading"><h3>Density</h3><p>Controls rows, panel padding and message rhythm</p></div>
                <div className="segmented-setting">
                  <button type="button" aria-pressed={preferenceDraft.density === 'compact'} className={preferenceDraft.density === 'compact' ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, density: 'compact' }))}>Compact</button>
                  <button type="button" aria-pressed={preferenceDraft.density === 'comfortable'} className={preferenceDraft.density === 'comfortable' ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, density: 'comfortable' }))}>Comfortable</button>
                </div>
              </section>

              <section>
                <div className="appearance-heading"><h3>Workspace balance</h3><p>Choose the preset used when the dock is reset</p></div>
                <div className="layout-options">
                  <button type="button" aria-pressed={preferenceDraft.layout === 'balanced'} className={preferenceDraft.layout === 'balanced' ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, layout: 'balanced' }))}><span><i /><i /></span>Balanced</button>
                  <button type="button" aria-pressed={preferenceDraft.layout === 'code'} className={preferenceDraft.layout === 'code' ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, layout: 'code' }))}><span className="layout-code"><i /><i /></span>Code focus</button>
                  <button type="button" aria-pressed={preferenceDraft.layout === 'conversation'} className={preferenceDraft.layout === 'conversation' ? 'is-active' : ''} onClick={() => setPreferenceDraft((current) => ({ ...current, layout: 'conversation' }))}><span className="layout-chat"><i /><i /></span>Conversation</button>
                </div>
                <button className={`reset-layout-button${layoutReset ? ' is-pending' : ''}`} type="button" onClick={() => setLayoutReset(true)} disabled={layoutReset}>
                  {layoutReset ? <Check size={14} /> : <RefreshCw size={14} />}
                  {layoutReset ? 'Layout will reset on save' : 'Reset layout to selected preset'}
                </button>
              </section>
            </div>
          )}
        </div>

        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="button" disabled={Boolean(testing)} onClick={() => { onSave(draft, preferenceDraft, layoutReset); onClose() }}>Save settings</button>
        </footer>
      </aside>
    </div>
  )
}

function StatusBar({
  branch,
  model,
  native,
  workspace,
}: {
  branch: string
  model: string
  native: NativeCapabilities | null
  workspace: WorkspaceView | null
}) {
  return (
    <footer className="statusbar">
      <span><GitFork size={12} />{branch}</span>
      <span><CircleDot size={12} />{workspace ? `${workspace.snapshot.files.length} changed` : 'No repository'}</span>
      {workspace?.snapshot.ahead ? <span>↑ {workspace.snapshot.ahead}</span> : null}
      {workspace?.snapshot.behind ? <span>↓ {workspace.snapshot.behind}</span> : null}
      <span className="status-spacer" />
      <span>UTF-8</span>
      <span>{workspace?.name ?? 'Traceframe'}</span>
      <span><Cpu size={12} />{model}</span>
      <span className="status-connected"><span />{native ? `${native.platform} native` : 'UI preview'}</span>
    </footer>
  )
}

export default function App() {
  const desktop = isDesktopRuntime()
  const [previewInitial] = useState<{ sessions: Session[]; activeSessionId: string }>(() => {
    const sessions = desktop ? [] : loadStored('traceframe.sessions', initialSessions)
    return { sessions, activeSessionId: desktop ? '' : firstActiveSessionId(sessions) }
  })
  const [sessions, setSessions] = useState<Session[]>(previewInitial.sessions)
  const [activeSessionId, setActiveSessionId] = useState(previewInitial.activeSessionId)
  const [sessionMessages, setSessionMessages] = useState<Record<string, Message[]>>(() => desktop ? {} : loadStored('traceframe.session-messages', initialSessionMessages))
  const [sessionAgents, setSessionAgents] = useState<Record<string, Agent[]>>(() => desktop ? {} : loadStored('traceframe.session-agents', initialSessionAgents))
  const [memories, setMemories] = useState<MemoryRecord[]>(() => desktop ? [] : loadStored('traceframe.memories', initialMemories))
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEventRecord[]>([])
  const [branch, setBranch] = useState('main')
  const [model, setModel] = useState(() => loadStored('traceframe.model', 'cc-switch'))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [runState, setRunState] = useState<'idle' | 'running'>('idle')
  const [runCancelPending, setRunCancelPending] = useState(false)
  const [providers, setProviders] = useState<Provider[]>(loadProviders)
  const [native, setNative] = useState<NativeCapabilities | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null)
  const workspaceRef = useRef<WorkspaceView | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspacePickerPending, setWorkspacePickerPending] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [appError, setAppError] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState('')
  const [workspaceFile, setWorkspaceFile] = useState<WorkspaceFile | null>(null)
  const [workspaceDiff, setWorkspaceDiff] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('view')
  const [editorPath, setEditorPath] = useState('')
  const [editorBaseline, setEditorBaseline] = useState('')
  const [editorDraft, setEditorDraft] = useState('')
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const activeRunRef = useRef<string | null>(null)
  const workspacePickerPendingRef = useRef(false)
  const workspaceRequest = useRef(0)
  const fileRequest = useRef(0)
  const selectedFileRef = useRef('')
  const runtimeRefreshTimer = useRef<number | null>(null)
  const editorDirty = Boolean(editorPath && editorPath === selectedFile && editorDraft !== editorBaseline)
  const editorDirtyRef = useRef(false)
  editorDirtyRef.current = editorDirty
  const [preferences, setPreferences] = useState<UiPreferences>(() => ({ ...defaultUiPreferences, ...loadStored('traceframe.appearance', defaultUiPreferences) }))
  const [dockModel, setDockModel] = useState(() => storedDockModel(preferences.layout))

  const applySnapshot = useCallback((snapshot: Awaited<ReturnType<typeof getAppSnapshot>>) => {
    const grouped = snapshot.messages.reduce<Record<string, Message[]>>((result, message) => {
      const sessionId = message.sessionId ?? ''
      result[sessionId] = [...(result[sessionId] ?? []), message]
      return result
    }, {})
    setSessions(snapshot.sessions)
    setSessionMessages(grouped)
    setMemories(snapshot.memories)
    setRuntimeEvents(snapshot.events)
    setActiveSessionId((current) => snapshot.sessions.some((session) => session.id === current) ? current : snapshot.sessions[0]?.id ?? '')
  }, [])

  const reloadNativeState = useCallback(async () => {
    applySnapshot(await getAppSnapshot())
  }, [applySnapshot])

  const loadWorkspaceFile = useCallback(async (workspacePath: string, path: string) => {
    const request = ++fileRequest.current
    setSelectedFile(path)
    setWorkspaceFile(null)
    setWorkspaceDiff('')
    setFileLoading(true)
    setFileError(null)
    setDiffError(null)

    const [fileResult, stagedDiff, workingDiff] = await Promise.allSettled([
      readWorkspaceFile(workspacePath, path),
      getGitDiff(workspacePath, true, path),
      getGitDiff(workspacePath, false, path),
    ])
    if (request !== fileRequest.current) return

    if (fileResult.status === 'fulfilled') {
      setWorkspaceFile(fileResult.value)
    } else {
      setWorkspaceFile(null)
      setFileError(errorMessage(fileResult.reason))
    }
    setWorkspaceDiff([
      stagedDiff.status === 'fulfilled' ? stagedDiff.value : '',
      workingDiff.status === 'fulfilled' ? workingDiff.value : '',
    ].filter(Boolean).join('\n'))
    const diffFailures = [stagedDiff, workingDiff]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorMessage(result.reason))
    setDiffError([...new Set(diffFailures)].join(' · ') || null)
    setFileLoading(false)
  }, [])

  const loadWorkspace = useCallback(async (path: string, preferredFile = '') => {
    const request = ++workspaceRequest.current
    setWorkspaceLoading(true)
    setWorkspaceError(null)

    try {
      const [snapshot, branches, tree] = await Promise.all([
        getGitSnapshot(path),
        listGitBranches(path),
        getWorkspaceTree(path),
      ])
      if (request !== workspaceRequest.current) return

      fileRequest.current += 1
      const name = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
      const nextWorkspace = { path, name, snapshot, branches, tree: tree.entries, treeTruncated: tree.truncated }
      workspaceRef.current = nextWorkspace
      setWorkspace(nextWorkspace)
      setBranch(snapshot.branch)

      const files = tree.entries.filter((entry) => entry.kind === 'file')
      const nextFile = preferredFile || snapshot.files[0]?.path || files[0]?.path || ''
      if (nextFile) {
        await loadWorkspaceFile(path, nextFile)
      } else {
        setSelectedFile('')
        setWorkspaceFile(null)
        setWorkspaceDiff('')
        setFileError(null)
        setDiffError(null)
      }
      return nextWorkspace
    } catch (error) {
      if (request !== workspaceRequest.current) return
      if (!workspaceRef.current) {
        fileRequest.current += 1
        setWorkspace(null)
        setSelectedFile('')
        setWorkspaceFile(null)
        setWorkspaceDiff('')
        setFileLoading(false)
        setFileError(null)
        setDiffError(null)
      }
      setWorkspaceError(errorMessage(error) || 'The selected folder could not be opened')
      return null
    } finally {
      if (request === workspaceRequest.current) setWorkspaceLoading(false)
    }
  }, [loadWorkspaceFile])

  useEffect(() => {
    document.documentElement.classList.toggle('tauri-desktop', isDesktopRuntime())
    if (!isDesktopRuntime()) return
    getNativeCapabilities().then(setNative).catch(() => setNative(null))
    void (async () => {
      let snapshot = await getAppSnapshot()
      if (!snapshot.sessions.length) {
        await createNativeSession('Untitled task', 'main', '')
        snapshot = await getAppSnapshot()
      }
      applySnapshot(snapshot)
      const initialSession = snapshot.sessions.find((session) => !session.archived) ?? snapshot.sessions[0]
      if (initialSession) setActiveSessionId(initialSession.id)
      const recentWorkspace = await getRecentWorkspace().catch(() => null)
      const workspacePath = initialSession?.workspacePath || recentWorkspace
      if (!workspacePath) return
      if (initialSession?.workspacePath) {
        const git = await getGitSnapshot(workspacePath)
        if (git.branch !== initialSession.branch) await switchGitBranch(workspacePath, initialSession.branch)
      }
      const loaded = await loadWorkspace(workspacePath)
      if (loaded && initialSession && !initialSession.workspacePath && !initialSession.archived) {
        await updateNativeSessionScope(initialSession.id, loaded.snapshot.branch, loaded.path)
        await reloadNativeState()
      }
    })().catch((error) => setAppError(errorMessage(error)))
  }, [applySnapshot, loadWorkspace])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.dataset.density = preferences.density
    document.documentElement.dataset.layout = preferences.layout
    localStorage.setItem('traceframe.appearance', JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    selectedFileRef.current = selectedFile
  }, [selectedFile])

  useEffect(() => {
    if (!workspaceFile || workspaceFile.path !== selectedFile) return
    if (editorPath !== workspaceFile.path) {
      setEditorPath(workspaceFile.path)
      setEditorBaseline(workspaceFile.content)
      setEditorDraft(workspaceFile.content)
      setEditorMode('view')
      setEditorError(null)
      return
    }
    if (!editorDirty) {
      setEditorBaseline(workspaceFile.content)
      setEditorDraft(workspaceFile.content)
      setEditorError(null)
    } else if (workspaceFile.content !== editorBaseline) {
      setEditorError('This file changed on disk. Revert to load the current version before saving again.')
    }
  }, [editorBaseline, editorDirty, editorPath, selectedFile, workspaceFile])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!editorDirtyRef.current) return
      event.preventDefault()
      event.returnValue = ''
    }

    if (desktop) {
      void import('@tauri-apps/api/window')
        .then(({ getCurrentWindow }) => getCurrentWindow().onCloseRequested((event) => {
          if (editorDirtyRef.current && !window.confirm('Discard unsaved editor changes and close Traceframe?')) event.preventDefault()
        }))
        .then((listener) => {
          if (disposed) listener()
          else unlisten = listener
        })
        .catch((error) => {
          if (!disposed) setAppError(`Window close protection could not start: ${errorMessage(error)}`)
        })
    } else {
      window.addEventListener('beforeunload', beforeUnload)
    }

    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener('beforeunload', beforeUnload)
    }
  }, [desktop])

  useEffect(() => () => {
    if (runtimeRefreshTimer.current !== null) window.clearTimeout(runtimeRefreshTimer.current)
  }, [])

  useEffect(() => {
    if (!desktop) localStorage.setItem('traceframe.sessions', JSON.stringify(sessions))
  }, [desktop, sessions])

  useEffect(() => {
    if (!desktop) localStorage.setItem('traceframe.session-messages', JSON.stringify(sessionMessages))
  }, [desktop, sessionMessages])

  useEffect(() => {
    if (!desktop) localStorage.setItem('traceframe.session-agents', JSON.stringify(sessionAgents))
  }, [desktop, sessionAgents])

  useEffect(() => {
    if (!desktop) localStorage.setItem('traceframe.memories', JSON.stringify(memories))
  }, [desktop, memories])

  useEffect(() => {
    localStorage.setItem('traceframe.model', JSON.stringify(model))
  }, [model])

  useEffect(() => {
    if (!providers.some((provider) => provider.id === model)) setModel(providers[0]?.id ?? 'cc-switch')
  }, [model, providers])

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? {
    id: 'loading', title: 'Loading session', summary: '', time: '', branch, workspacePath: workspace?.path,
  }, [sessions, activeSessionId, branch, workspace?.path])
  const messages = sessionMessages[activeSession.id] ?? (desktop ? [] : initialMessages)
  const selectedProvider = useMemo(() => providers.find((item) => item.id === model) ?? providers[0], [model, providers])
  const activeEvents = useMemo(() => runtimeEvents.filter((event) => event.sessionId === activeSession.id), [activeSession.id, runtimeEvents])
  const activeMemories = useMemo(() => memories.filter((memory) => (
    memory.scope === 'global'
      || (memory.scope === 'session' && memory.sessionId === activeSession.id)
      || (memory.scope === 'project' && Boolean(workspace?.path) && memory.workspacePath === workspace?.path)
  )), [activeSession.id, memories, workspace?.path])
  const liveMessage = useMemo(() => {
    if (runState !== 'running' || !activeRunId) return undefined
    const deltas = activeEvents
      .filter((event) => event.runId === activeRunId && event.type === 'model.delta' && (!event.payload.agentId || event.payload.agentId === 'root'))
      .sort((left, right) => left.sequence - right.sequence)
    const body = deltas.map((event) => firstString(event.payload.text) ?? '').join('')
    if (!body) return undefined
    return {
      id: `live-${activeRunId}`,
      sessionId: activeSession.id,
      author: selectedProvider?.name ?? 'Agent',
      role: 'agent' as const,
      time: new Date(deltas.at(-1)?.timestamp ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false }),
      body,
      meta: `${selectedProvider?.model || 'Provider default'} · streaming`,
    }
  }, [activeEvents, activeRunId, activeSession.id, runState, selectedProvider])
  const agents = useMemo(() => {
    if (!desktop) return sessionAgents[activeSession.id] ?? initialAgents
    const root: Agent = {
      id: 'root', name: selectedProvider?.name ?? 'Traceframe', role: 'Orchestrator',
      model: selectedProvider?.model || 'Provider default', state: runState === 'running' ? 'working' : 'queued', progress: 0,
      task: runState === 'running' ? 'Executing the active run' : 'Ready for the next task', color: 'cyan',
    }
    return deriveRuntimeAgents(activeEvents, root)
  }, [activeEvents, activeSession.id, desktop, runState, selectedProvider, sessionAgents])

  const confirmDiscardEditorChanges = (destination: string) => {
    if (!editorDirty) return true
    if (!window.confirm(`Discard unsaved changes before ${destination}?`)) return false
    setEditorDraft(editorBaseline)
    setEditorMode('view')
    setEditorError(null)
    return true
  }

  const openWorkspace = async () => {
    if (workspacePickerPendingRef.current) return
    if (activeRunRef.current || runCancelPending) {
      setAppError('Stop the active run before changing workspaces.')
      return
    }
    if (editorSaving) {
      setAppError('Wait for the current file save before changing workspaces.')
      return
    }
    if (!isDesktopRuntime()) {
      setWorkspaceError('Folder selection is available in the native Traceframe app.')
      return
    }
    try {
      const outcome = await requestWorkspaceSelection(workspacePickerPendingRef, setWorkspacePickerPending)
      if (!outcome.started) return
      const selected = await validateWorkspaceCandidate(outcome.selected, workspace?.path)
      if (selected && selected !== workspace?.path && !confirmDiscardEditorChanges('switching workspaces')) return
      if (selected) {
        const nextWorkspace = await loadWorkspace(selected, selected === workspace?.path ? selectedFile : '')
        if (nextWorkspace && activeSession.id !== 'loading' && !activeSession.archived) {
          await updateNativeSessionScope(activeSession.id, nextWorkspace.snapshot.branch, nextWorkspace.path)
          await reloadNativeState()
        }
      }
    } catch (error) {
      setWorkspaceError(errorMessage(error))
    }
  }

  const refreshWorkspace = () => {
    if (workspace && !branchBusy && !activeRunRef.current && !runCancelPending) void loadWorkspace(workspace.path, selectedFile)
  }

  const changeBranch = async (nextBranch: string) => {
    if (activeRunRef.current || editorSaving || !workspace || nextBranch === branch) return
    if (!confirmDiscardEditorChanges('switching branches')) return
    const operation = workspaceRequest.current
    const workspacePath = workspace.path
    const previousBranch = branch
    setBranch(nextBranch)
    setBranchBusy(true)
    setWorkspaceError(null)
    try {
      await switchGitBranch(workspacePath, nextBranch)
      if (operation !== workspaceRequest.current) return
      await loadWorkspace(workspacePath, selectedFile)
      if (desktop && activeSession.id !== 'loading' && !activeSession.archived) {
        await updateNativeSessionScope(activeSession.id, nextBranch, workspacePath)
        await reloadNativeState()
      }
    } catch (error) {
      if (operation !== workspaceRequest.current) return
      setBranch(previousBranch)
      setWorkspaceError(errorMessage(error))
    } finally {
      setBranchBusy(false)
    }
  }

  const saveWorkspaceFile = async () => {
    if (!desktop || activeRunRef.current || runCancelPending || editorSaving || !editorDirty || !workspace || !workspaceFile || workspaceFile.truncated) return
    if (editorPath !== selectedFile || workspaceFile.path !== selectedFile) return
    setEditorSaving(true)
    setEditorError(null)
    try {
      const saved = await writeWorkspaceFile(workspace.path, selectedFile, editorBaseline, editorDraft)
      setWorkspaceFile(saved)
      setEditorPath(saved.path)
      setEditorBaseline(saved.content)
      setEditorDraft(saved.content)
      await loadWorkspace(workspace.path, selectedFile)
    } catch (error) {
      setEditorError(errorMessage(error))
      await loadWorkspaceFile(workspace.path, selectedFile).catch(() => undefined)
    } finally {
      setEditorSaving(false)
    }
  }

  const selectWorkspaceFile = (path: string) => {
    if (activeRunRef.current || runCancelPending || editorSaving) return
    if (path === selectedFile) return
    if (!confirmDiscardEditorChanges('opening another file')) return
    if (workspace) void loadWorkspaceFile(workspace.path, path)
  }

  const revertWorkspaceFile = () => {
    setEditorDraft(editorBaseline)
    setEditorError(null)
  }

  const selectSession = async (session: Session) => {
    if (activeRunRef.current || branchBusy || workspaceLoading || editorSaving) return
    if (!confirmDiscardEditorChanges('switching sessions')) return
    setActiveSessionId(session.id)
    setSessions((current) => current.map((item) => ({ ...item, unread: item.id === session.id ? undefined : item.unread })))
    if (!desktop) {
      if (!workspace) setBranch(session.branch)
      return
    }
    setAppError(null)
    if (!session.workspacePath) {
      if (workspace && !session.archived) {
        try {
          await updateNativeSessionScope(session.id, branch, workspace.path)
          await reloadNativeState()
        } catch (error) {
          setAppError(errorMessage(error))
        }
      } else {
        setBranch(session.branch)
      }
      return
    }
    setBranchBusy(true)
    try {
      const snapshot = await getGitSnapshot(session.workspacePath)
      if (snapshot.branch !== session.branch) await switchGitBranch(session.workspacePath, session.branch)
      const loaded = await loadWorkspace(session.workspacePath)
      if (!loaded) throw new Error('The session workspace could not be loaded')
    } catch (error) {
      setAppError(`Session scope could not be activated: ${errorMessage(error)}`)
    } finally {
      setBranchBusy(false)
    }
  }

  const createSession = async () => {
    if (activeRunRef.current || branchBusy || workspaceLoading || editorSaving) return
    if (desktop) {
      try {
        const session = await createNativeSession('Untitled task', branch, workspace?.path ?? '')
        await reloadNativeState()
        setActiveSessionId(session.id)
      } catch (error) {
        setAppError(errorMessage(error))
      }
      return
    }
    const id = `s${Date.now()}`
    const newSession: Session = { id, title: 'Untitled task', summary: 'New orchestration thread', time: 'NOW', branch }
    setSessions((current) => [newSession, ...current])
    setSessionMessages((current) => ({ ...current, [id]: [] }))
    setSessionAgents((current) => ({
      ...current,
      [id]: [{ id: `root-${id}`, name: 'Orchestrator', role: 'Lead agent', model, state: 'queued', progress: 0, task: 'Waiting for the first request', color: 'cyan' }],
    }))
    setActiveSessionId(id)
  }

  const sendMessage = async (text: string): Promise<boolean> => {
    const sessionId = activeSession.id
    if (desktop) {
      if (activeRunRef.current) return false
      if (activeSession.archived) {
        setAppError('Restore this archived session before starting another run.')
        return false
      }
      if (!workspace) {
        setAppError('Open a local workspace before starting a coding run.')
        return false
      }
      if (activeSession.workspacePath && activeSession.workspacePath !== workspace.path) {
        setAppError('This session belongs to another workspace. Select it again to activate its repository.')
        return false
      }
      if (activeSession.branch !== branch) {
        setAppError(`This session is scoped to ${activeSession.branch}, but ${branch} is checked out. Select the session again before running.`)
        return false
      }
      const provider = providers.find((item) => item.id === model) ?? providers[0]
      if (!provider) {
        setAppError('Configure a model provider before starting a run.')
        return false
      }
      if (!provider.model.trim()) {
        setAppError('Select or enter a current model in Models & API before starting a run.')
        setSettingsOpen(true)
        return false
      }
      setAppError(null)
      const runId = crypto.randomUUID()
      if (runtimeRefreshTimer.current !== null) window.clearTimeout(runtimeRefreshTimer.current)
      activeRunRef.current = runId
      setRunCancelPending(false)
      setRunState('running')
      setActiveRunId(runId)
      try {
        const message = await appendNativeMessage({
          sessionId,
          author: 'You',
          role: 'user',
          body: text,
          meta: `scope: ${branch}`,
        })
        setSessionMessages((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), message] }))
      } catch (error) {
        const detail = errorMessage(error)
        setAppError(detail)
        activeRunRef.current = null
        setRunCancelPending(false)
        setRunState('idle')
        setActiveRunId(null)
        return false
      }
      void (async () => {
        try {
          await startNativeRun({ runId, sessionId, workspacePath: workspace.path, branch, prompt: text, provider }, (event) => {
            setRuntimeEvents((current) => [event, ...current.filter((item) => item.id !== event.id)].slice(0, 500))
            if (event.type === 'file.changed') {
              if (runtimeRefreshTimer.current !== null) window.clearTimeout(runtimeRefreshTimer.current)
              runtimeRefreshTimer.current = window.setTimeout(() => {
                runtimeRefreshTimer.current = null
                void loadWorkspace(workspace.path, selectedFileRef.current)
              }, 200)
            }
          })
        } catch (error) {
          const detail = errorMessage(error)
          try {
            await appendNativeMessage({ sessionId, author: 'Runtime', role: 'system', body: detail, meta: 'run failed' })
          } catch {
            // The global alert remains available even if the trace store also failed.
          }
          setAppError(detail)
        } finally {
        if (runtimeRefreshTimer.current !== null) {
          window.clearTimeout(runtimeRefreshTimer.current)
          runtimeRefreshTimer.current = null
        }
        if (activeRunRef.current === runId) {
          activeRunRef.current = null
          setRunState('idle')
          setActiveRunId(null)
        }
        setRunCancelPending(false)
        await reloadNativeState().catch((error) => setAppError(errorMessage(error)))
        await loadWorkspace(workspace.path, selectedFile).catch(() => undefined)
        }
      })()
      return true
    }
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setSessionMessages((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] ?? []), { id: `m-${Date.now()}`, author: 'You', role: 'user', time: now, body: text, meta: `scope: ${activeSession.branch}` }],
    }))
    setSessions((current) => current.map((session) => session.id === sessionId ? { ...session, title: session.title === 'Untitled task' ? text.slice(0, 36) : session.title, summary: text.slice(0, 64), time: 'NOW' } : session))
    return true
  }

  const addAgent = (agent: Pick<Agent, 'name' | 'role' | 'model' | 'task'>) => {
    const sessionId = activeSession.id
    const rootAgent = agents[0]
    const colors: Agent['color'][] = ['amber', 'magenta', 'green', 'cyan']
    const newAgent: Agent = {
      ...agent,
      id: `agent-${Date.now()}`,
      state: 'queued',
      progress: 0,
      parent: rootAgent?.id,
      color: colors[agents.length % colors.length],
    }
    setSessionAgents((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), newAgent] }))
  }

  const saveMemory = async (memory: Omit<MemoryRecord, 'id' | 'time'>): Promise<boolean> => {
    if (memory.scope === 'project' && !workspace) {
      setAppError('Open a workspace before saving project memory.')
      return false
    }
    if (desktop) {
      try {
        await saveNativeMemory({ ...memory, workspacePath: workspace?.path ?? '' })
        await reloadNativeState()
        return true
      } catch (error) {
        setAppError(errorMessage(error))
        return false
      }
    }
    setMemories((current) => [{ ...memory, id: `memory-${Date.now()}`, time: 'now' }, ...current])
    return true
  }

  const removeMemory = async (id: string) => {
    if (desktop) {
      try {
        await deleteNativeMemory(id)
        await reloadNativeState()
      } catch (error) {
        setAppError(errorMessage(error))
      }
      return
    }
    setMemories((current) => current.filter((memory) => memory.id !== id))
  }

  const updateMemory = async (id: string, memory: Omit<MemoryRecord, 'id' | 'time'>): Promise<boolean> => {
    if (memory.scope === 'project' && !workspace) {
      setAppError('Open a workspace before updating project memory.')
      return false
    }
    if (desktop) {
      try {
        await updateNativeMemory(id, { ...memory, workspacePath: workspace?.path ?? '' })
        await reloadNativeState()
        return true
      } catch (error) {
        setAppError(errorMessage(error))
        return false
      }
    }
    setMemories((current) => current.map((item) => item.id === id ? { ...item, ...memory } : item))
    return true
  }

  const compactContext = async () => {
    if (!desktop || activeSession.id === 'loading') return
    try {
      await compactNativeSession(activeSession.id)
      await reloadNativeState()
    } catch (error) {
      setAppError(errorMessage(error))
    }
  }

  const toggleSessionArchive = async (session: Session) => {
    if (activeRunRef.current || branchBusy || workspaceLoading || editorSaving) return
    if (!desktop) {
      const nextActiveId = activeSessionIdAfterArchive(sessions, activeSession.id, session)
      setSessions((current) => current.map((item) => item.id === session.id ? { ...item, archived: !item.archived } : item))
      if (nextActiveId !== activeSession.id) setActiveSessionId(nextActiveId)
      return
    }
    try {
      await archiveNativeSession(session.id, !session.archived)
      const snapshot = await getAppSnapshot()
      applySnapshot(snapshot)
      if (!session.archived && session.id === activeSession.id) {
        setActiveSessionId(snapshot.sessions.find((item) => !item.archived && item.id !== session.id)?.id ?? '')
      }
    } catch (error) {
      setAppError(errorMessage(error))
    }
  }

  const toggleRun = async () => {
    const runId = activeRunRef.current ?? activeRunId
    if (runId) {
      if (runCancelPending) return
      setRunCancelPending(true)
      setAppError(null)
      const outcome = await requestRunCancellation(runId)
      if (outcome.status === 'requested') return
      setRunCancelPending(false)
      setAppError(outcome.message)
      if (outcome.status === 'missing') {
        if (activeRunRef.current === runId) activeRunRef.current = null
        setRunState('idle')
        setActiveRunId(null)
        await reloadNativeState().catch((error) => setAppError(errorMessage(error)))
      }
    } else {
      if (activeSession.archived) {
        setAppError('Restore this archived session before sending another prompt.')
        return
      }
      if (dockModel.getNodeById('conversation')) dockModel.doAction(Actions.selectTab('conversation'))
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
    }
  }

  const saveSettings = (next: Provider[], nextPreferences: UiPreferences, resetLayout: boolean) => {
    setProviders(next)
    if (resetLayout) {
      const nextDockModel = Model.fromJson(dockLayoutJson(nextPreferences.layout))
      setDockModel(nextDockModel)
      localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(nextDockModel.toJson()))
    }
    setPreferences(nextPreferences)
    localStorage.setItem('traceframe.providers', JSON.stringify(next.map(({ id, name, endpoint, model: providerModel, adapter }) => ({ id, name, endpoint, model: providerModel, adapter, connected: false, latency: 0 }))))
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const dockFactory = (node: TabNode) => {
    const component = node.getComponent() as DockComponent
    if (component === 'sessions') {
      return <SessionsPanel
        sessions={sessions}
        activeId={activeSessionId}
        branchCount={workspace?.branches.length ?? 0}
        changeCount={workspace?.snapshot.files.length ?? 0}
        onSelect={selectSession}
        onNew={() => void createSession()}
        onArchive={(session) => void toggleSessionArchive(session)}
        onOpenWorkspace={() => void openWorkspace()}
        busy={runState === 'running' || branchBusy || workspacePickerPending || workspaceLoading || editorSaving}
        workspacePickerPending={workspacePickerPending}
      />
    }
    if (component === 'conversation') {
      return <ConversationPanel session={activeSession} messages={messages} liveMessage={liveMessage} agents={agents} disabled={runState === 'running' || Boolean(activeSession.archived)} onSend={sendMessage} />
    }
    if (component === 'code' || component === 'diff') {
      const interactionBusy = runState === 'running' || runCancelPending || workspacePickerPending
      return <RepositoryDock
        mode={component}
        branchBusy={branchBusy}
        interactionBusy={interactionBusy}
        workspace={workspace}
        selectedFile={selectedFile}
        file={workspaceFile}
        diff={workspaceDiff}
        loading={workspacePickerPending || workspaceLoading}
        fileLoading={fileLoading}
        error={workspaceError}
        fileError={fileError}
        diffError={diffError}
        onSelectFile={selectWorkspaceFile}
        onRefresh={refreshWorkspace}
        onOpenWorkspace={() => void openWorkspace()}
        editor={{
          mode: editorMode,
          draft: editorDraft,
          draftPath: editorPath,
          dirty: editorDirty,
          saving: editorSaving,
          error: editorError,
          canEdit: desktop && !interactionBusy && Boolean(workspaceFile && !workspaceFile.truncated && workspaceFile.path === selectedFile),
          onMode: setEditorMode,
          onDraft: setEditorDraft,
          onSave: () => void saveWorkspaceFile(),
          onRevert: revertWorkspaceFile,
        }}
      />
    }
    if (component === 'output') {
      return <section className="dock-content" aria-label="运行输出"><TerminalView runState={runState} workspace={workspace} branch={branch} events={activeEvents} /></section>
    }
    if (component === 'trace') {
      return <section className="dock-content" aria-label="运行轨迹"><ActivityView events={activeEvents} /></section>
    }
    if (component === 'context') {
      return <section className="dock-content inspector-panel"><ContextPanel session={activeSession} messages={messages} events={activeEvents} memories={activeMemories} onCompact={compactContext} canCompact={desktop} /></section>
    }
    if (component === 'agents') {
      return <section className="dock-content inspector-panel"><AgentPanel agents={agents} onAdd={addAgent} orchestrated={desktop} /></section>
    }
    if (component === 'memory') {
      return <section className="dock-content inspector-panel"><MemoryPanel memories={memories} activeSessionId={activeSession.id} workspacePath={workspace?.path} onSave={saveMemory} onUpdate={updateMemory} onRemove={removeMemory} /></section>
    }
    return null
  }

  const showDock = useCallback((component: DockComponent) => {
    if (dockModel.getNodeById(component)) dockModel.doAction(Actions.selectTab(component))
  }, [dockModel])

  const focusDockControl = useCallback((component: DockComponent, selector: string) => {
    showDock(component)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus())
  }, [showDock])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (settingsOpen || event.defaultPrevented || !(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 's' && editorDirty && runState !== 'running' && !runCancelPending) {
        event.preventDefault()
        if (!editorSaving) void saveWorkspaceFile()
      } else if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        focusDockControl('sessions', '.session-filter input')
      } else if (event.key === 'Enter' && shouldFocusPromptShortcut(activeSession, Boolean(activeRunRef.current), runCancelPending)) {
        event.preventDefault()
        focusDockControl('conversation', '.composer textarea')
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [activeSession, editorDirty, editorSaving, focusDockControl, runCancelPending, runState, saveWorkspaceFile, settingsOpen])

  return (
    <div className="app-shell">
      <TopBar
        workspace={workspace}
        branch={branch}
        branches={workspace?.branches ?? []}
        branchBusy={branchBusy}
        workspaceLoading={workspaceLoading || editorSaving}
        workspacePickerPending={workspacePickerPending}
        onBranch={(value) => void changeBranch(value)}
        onOpenWorkspace={() => void openWorkspace()}
        model={model}
        setModel={(value) => { if (!activeRunRef.current) setModel(value) }}
        providers={providers}
        runState={runState}
        runCancelPending={runCancelPending}
        promptDisabled={Boolean(activeSession.archived)}
        onRun={() => void toggleRun()}
        onSettings={() => setSettingsOpen(true)}
      />
      {appError ? (
        <div className="app-alert" role="alert" aria-live="assertive">
          <span>{appError}</span>
          <button type="button" aria-label="关闭错误提示" onClick={() => setAppError(null)}><X size={14} /></button>
        </div>
      ) : null}
      <AppRail
        onShowSessions={() => focusDockControl('sessions', '.session-filter input')}
        onShowDock={showDock}
      />
      <main className="dock-workspace">
        <Layout
          model={dockModel}
          factory={dockFactory}
          realtimeResize
          onModelChange={(nextModel) => localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(nextModel.toJson()))}
        />
      </main>
      <StatusBar branch={branch} model={selectedProvider ? [selectedProvider.name, selectedProvider.model].filter(Boolean).join(' · ') : 'No provider'} native={native} workspace={workspace} />
      <ProviderSettings
        open={settingsOpen}
        providers={providers}
        preferences={preferences}
        onClose={closeSettings}
        onSave={saveSettings}
      />
    </div>
  )
}
