import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Actions, Layout, Model, type IJsonModel, type TabNode } from 'flexlayout-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import 'flexlayout-react/style/dark.css'
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  CircleX,
  Clock,
  Command,
  GitBranch,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Cpu,
  Crosshair,
  Database,
  Download,
  File,
  FileCode2,
  FilePenLine,
  FolderOpen,
  GitCompareArrows,
  GitCommitHorizontal,
  GitFork,
  HardDrive,
  KeyRound,
  Layers3,
  ListTree,
  LoaderCircle,
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
  Upload,
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
  commitGitChanges,
  compactNativeSession,
  createGitBranch,
  createNativeSession,
  deleteNativeMemory,
  getAppSnapshot,
  getGitDiff,
  getGitHistory,
  getGitSnapshot,
  getNativeCapabilities,
  getRecentWorkspace,
  getSessionRuntimeEvents,
  getWorkspaceTree,
  isDesktopRuntime,
  listGitBranches,
  pickWorkspace,
  pullGitBranch,
  pushGitBranch,
  readWorkspaceFile,
  saveNativeMemory,
  startNativeRun,
  stageAllGitChanges,
  steerNativeRun,
  switchGitBranch,
  testNativeProvider,
  updateNativeMemory,
  updateNativeSessionScope,
  unstageAllGitChanges,
  writeWorkspaceFile,
  type GitSnapshot,
  type GitCommitRecord,
  type NativeCapabilities,
  type WorkspaceFile,
  type WorkspaceTreeEntry,
} from './native'
import type { RuntimeEventRecord } from './types'
import { PreviewPanel } from './PreviewPanel'
import { TerminalPanel } from './TerminalPanel'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

type SettingsSection = 'models' | 'appearance'
type EditorMode = 'view' | 'edit'

export interface AgentEditTarget {
  path: string
  startLine: number
  endLine: number
  eventId: string
}

export interface QueuedPrompt {
  id: string
  sessionId: string
  text: string
}

export interface ComposerDraftRequest {
  id: string
  sessionId: string
  text: string
}

export function terminalDraftAfterConsume(current: string, consumed: string) {
  return current === consumed ? '' : current
}

export type ComposerSendMode = 'run' | 'steer' | 'queue'

const MAX_RENDERER_EVENTS = 6_000

function replaceSessionEvents(current: RuntimeEventRecord[], sessionId: string, events: RuntimeEventRecord[]) {
  return [...events, ...current.filter((event) => event.sessionId !== sessionId)].slice(0, MAX_RENDERER_EVENTS)
}

export function mergeSnapshotEvents(
  snapshot: RuntimeEventRecord[],
  current: RuntimeEventRecord[],
  activeSessionId: string,
  runActive: boolean,
) {
  if (!activeSessionId) return snapshot
  const snapshotActive = snapshot.filter((event) => event.sessionId === activeSessionId)
  const known = new Set(snapshotActive.map((event) => event.id))
  const preservedActive = current.filter((event) => (
    event.sessionId === activeSessionId
    && !known.has(event.id)
    && (runActive || event.type !== 'model.delta')
  ))
  return replaceSessionEvents(
    snapshot.filter((event) => event.sessionId !== activeSessionId),
    activeSessionId,
    [...snapshotActive, ...preservedActive].slice(0, 1_000),
  )
}

export function agentEditTarget(event: RuntimeEventRecord): AgentEditTarget | null {
  if (event.type !== 'file.changed') return null
  const path = typeof event.payload.path === 'string' ? event.payload.path : ''
  const segments = path.split('/')
  if (!path.trim() || path.startsWith('/') || path.includes('\\') || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  const rawStart = typeof event.payload.startLine === 'number' ? event.payload.startLine : 1
  const rawEnd = typeof event.payload.endLine === 'number' ? event.payload.endLine : rawStart
  const startLine = Number.isSafeInteger(rawStart) && rawStart > 0 ? rawStart : 1
  const endLine = Number.isSafeInteger(rawEnd) && rawEnd >= startLine ? rawEnd : startLine
  return { path, startLine, endLine, eventId: event.id }
}

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

export const DOCK_LAYOUT_STORAGE_KEY = 'traceframe.dock-layout'
export const DOCK_LAYOUT_SCHEMA_VERSION = 5
const LEGACY_DOCK_LAYOUT_STORAGE_KEYS = ['traceframe.dock-layout.v4', 'traceframe.dock-layout.v3', 'traceframe.dock-layout.v2'] as const
const DOCK_COMPONENTS = ['sessions', 'source', 'conversation', 'code', 'diff', 'preview', 'terminal', 'output', 'trace', 'context', 'agents', 'memory'] as const
type DockComponent = typeof DOCK_COMPONENTS[number]
type RailComponent = Extract<DockComponent, 'sessions' | 'source' | 'agents' | 'memory'>

function selectedRailComponent(model: Model, includeSelectedFallback = false): RailComponent | null {
  const component = model.getActiveTabset()?.getSelectedNode()?.getComponent()
  if (component === 'sessions' || component === 'source' || component === 'agents' || component === 'memory') return component
  if (includeSelectedFallback) {
    const selected = (['source', 'sessions', 'agents', 'memory'] as const)
      .find((candidate) => (model.getNodeById(candidate) as TabNode | undefined)?.isSelected())
    if (selected) return selected
  }
  return null
}

function dockTab(id: DockComponent, name: string) {
  return { type: 'tab' as const, id, name, component: id }
}

export function dockLayoutJson(preset: UiPreferences['layout']): IJsonModel {
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
        { type: 'tabset', weight: weights[0], minWidth: 200, children: [dockTab('sessions', 'Sessions'), dockTab('source', 'Source')] },
        { type: 'tabset', weight: weights[1], minWidth: 220, children: [dockTab('conversation', 'Conversation')] },
        {
          type: 'row',
          weight: weights[2],
          minWidth: 360,
          children: [
            { type: 'tabset', weight: workspaceWeights[0], minHeight: 240, children: [dockTab('code', 'Code'), dockTab('diff', 'Diff'), dockTab('preview', 'Preview')] },
            { type: 'tabset', weight: workspaceWeights[1], minHeight: 160, children: [dockTab('terminal', 'Terminal'), dockTab('output', 'Output'), dockTab('trace', 'Trace')] },
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

export function isValidDockLayout(value: IJsonModel) {
  const components = collectDockComponents(value.layout).sort()
  const required = [...DOCK_COMPONENTS].sort()
  return components.length === required.length && components.every((component, index) => component === required[index])
}

interface MutableDockNode {
  component?: string
  children?: MutableDockNode[]
}

interface PersistedDockLayout {
  schemaVersion: number
  model: IJsonModel
}

function dockParentFor(node: MutableDockNode, components: Set<string>): MutableDockNode | null {
  if (node.children?.some((child) => child.component && components.has(child.component))) return node
  for (const child of node.children ?? []) {
    const parent = dockParentFor(child, components)
    if (parent) return parent
  }
  return null
}

export function migrateDockLayout(value: IJsonModel): IJsonModel | null {
  if (isValidDockLayout(value)) return value
  const components = collectDockComponents(value.layout)
  const unique = new Set(components)
  const required = new Set<string>(DOCK_COMPONENTS)
  if (unique.size !== components.length || components.some((component) => !required.has(component))) return null
  const missing = DOCK_COMPONENTS.filter((component) => !unique.has(component))
  if (missing.some((component) => component !== 'preview' && component !== 'terminal')) return null

  const migrated = JSON.parse(JSON.stringify(value)) as IJsonModel
  const layout = migrated.layout as unknown as MutableDockNode
  if (missing.includes('preview')) {
    const workspaceParent = dockParentFor(layout, new Set(['code', 'diff']))
    if (!workspaceParent?.children) return null
    workspaceParent.children.push(dockTab('preview', 'Preview'))
  }
  if (missing.includes('terminal')) {
    const outputParent = dockParentFor(layout, new Set(['output', 'trace']))
    if (!outputParent?.children) return null
    outputParent.children.unshift(dockTab('terminal', 'Terminal'))
  }
  return isValidDockLayout(migrated) ? migrated : null
}

function decodedDockLayout(raw: string): { kind: 'valid'; model: IJsonModel } | { kind: 'future' | 'invalid' } {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDockLayout> | IJsonModel
    if (typeof (parsed as Partial<PersistedDockLayout>).schemaVersion === 'number') {
      const stored = parsed as Partial<PersistedDockLayout>
      if (!Number.isSafeInteger(stored.schemaVersion) || !stored.model) return { kind: 'invalid' }
      if (stored.schemaVersion! > DOCK_LAYOUT_SCHEMA_VERSION) return { kind: 'future' }
      const migrated = migrateDockLayout(stored.model)
      return migrated ? { kind: 'valid', model: migrated } : { kind: 'invalid' }
    }
    const migrated = migrateDockLayout(parsed as IJsonModel)
    return migrated ? { kind: 'valid', model: migrated } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

export function persistDockModel(model: Model) {
  const stored: PersistedDockLayout = { schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION, model: model.toJson() }
  try {
    const current = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
    if (current) {
      const parsed = JSON.parse(current) as Partial<PersistedDockLayout>
      if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > DOCK_LAYOUT_SCHEMA_VERSION) return
    }
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // A restricted webview can still use the in-memory model.
  }
}

export function storedDockModel(preset: UiPreferences['layout']) {
  const fallback = () => Model.fromJson(dockLayoutJson(preset))
  let current: string | null = null
  try {
    current = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
  } catch {
    return fallback()
  }
  if (current) {
    const decoded = decodedDockLayout(current)
    if (decoded.kind === 'future') return fallback()
    if (decoded.kind === 'valid') {
      try {
        const model = Model.fromJson(decoded.model)
        persistDockModel(model)
        return model
      } catch {
        // Continue through legacy layouts before resetting corrupt state.
      }
    }
  }

  for (const key of LEGACY_DOCK_LAYOUT_STORAGE_KEYS) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      return fallback()
    }
    if (!raw) continue
    const decoded = decodedDockLayout(raw)
    if (decoded.kind !== 'valid') continue
    try {
      const model = Model.fromJson(decoded.model)
      persistDockModel(model)
      return model
    } catch {
      // Try the next known legacy schema.
    }
  }

  const model = fallback()
  persistDockModel(model)
  return model
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
    .map((provider) => String(provider.adapter) === 'google' ? { ...provider, adapter: 'openai-chat' as const } : provider)
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
    aria-pressed={active === undefined ? undefined : active}
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

export function AppRail({
  changeCount,
  active,
  onShowSessions,
  onShowDock,
}: {
  changeCount: number
  active?: RailComponent | null
  onShowSessions: () => void
  onShowDock: (component: DockComponent) => void
}) {
  return (
    <nav className="app-rail" aria-label="主导航">
      <div className="rail-primary">
        <IconButton label="会话" active={active === 'sessions'} onClick={onShowSessions}><MessageSquare size={18} /></IconButton>
        <div className="rail-control">
          <IconButton label={`源代码管理${changeCount ? `，${changeCount} 个更改` : ''}`} active={active === 'source'} onClick={() => onShowDock('source')}><GitCompareArrows size={18} /></IconButton>
          {changeCount ? <span aria-hidden="true">{changeCount > 99 ? '99+' : changeCount}</span> : null}
        </div>
        <IconButton label="智能体拓扑" active={active === 'agents'} onClick={() => onShowDock('agents')}><Network size={18} /></IconButton>
        <IconButton label="记忆库" active={active === 'memory'} onClick={() => onShowDock('memory')}><Database size={18} /></IconButton>
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
        {message.role === 'agent'
          ? <MarkdownBody body={message.body} />
          : <p className="message-plain">{message.body}</p>}
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

export function MarkdownBody({ body }: { body: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => {
            void node
            return <a {...props} target="_blank" rel="noreferrer" />
          },
        }}
      >{body}</ReactMarkdown>
    </div>
  )
}

type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'info'

interface ExecutionDisclosureCommand {
  open: boolean
  revision: number
}

export interface ExecutionFileChange {
  path: string
  startLine: number
  endLine: number
}

export interface ExecutionStep {
  id: string
  sequence: number
  kind: 'run' | 'model' | 'tool' | 'file' | 'agent' | 'guidance' | 'context'
  title: string
  summary: string
  status: ExecutionStatus
  timestamp: number
  durationMs?: number
  arguments?: Record<string, unknown>
  details?: Record<string, unknown>
  output?: string
  files: ExecutionFileChange[]
}

function parsedArguments(value: unknown) {
  const direct = recordValue(value)
  if (direct) return direct
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    return recordValue(JSON.parse(value))
  } catch {
    return { raw: value }
  }
}

function displayArgument(value: unknown) {
  if (typeof value !== 'string') return String(value ?? '')
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)
}

function toolTitle(name: string) {
  const names: Record<string, string> = {
    list_files: 'List files', read_file: 'Read file', edit_file: 'Edit file', create_file: 'Create file',
    git_status: 'Inspect Git status', git_diff: 'Inspect Git diff', run_command: 'Run command', delegate_task: 'Delegate task',
  }
  return names[name] ?? name.replaceAll('_', ' ')
}

function toolSummary(name: string, args?: Record<string, unknown>) {
  if (!args) return toolTitle(name)
  if (name === 'run_command') {
    const program = firstString(args.program)
    const commandArgs = Array.isArray(args.args) ? args.args.map(displayArgument) : []
    return [program, ...commandArgs].filter(Boolean).join(' ') || 'Command arguments unavailable'
  }
  if (name === 'delegate_task') return firstString(args.task, args.name) ?? 'Delegated task'
  return firstString(args.path, args.relative_path, args.query, args.workdir) ?? toolTitle(name)
}

function eventAgentId(event: RuntimeEventRecord) {
  return firstString(event.payload.agentId, event.payload.agent_id) ?? 'root'
}

export function executionSteps(events: RuntimeEventRecord[]) {
  const steps: ExecutionStep[] = []
  const tools = new Map<string, ExecutionStep>()
  const models = new Map<string, ExecutionStep>()
  const agents = new Map<string, ExecutionStep>()
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence || left.timestamp - right.timestamp)

  ordered.forEach((event) => {
    const item = eventItem(event)
    if (event.type === 'model.delta') return
    if (event.type === 'tool.started') {
      const callId = firstString(item?.callId, item?.call_id) ?? event.id
      const name = firstString(item?.name) ?? 'tool'
      const args = parsedArguments(item?.arguments)
      const step: ExecutionStep = {
        id: callId, sequence: event.sequence, kind: 'tool', title: toolTitle(name), summary: toolSummary(name, args),
        status: 'running', timestamp: event.timestamp, arguments: args, files: [],
      }
      tools.set(callId, step)
      steps.push(step)
      return
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const callId = firstString(item?.callId, item?.call_id) ?? event.id
      const name = firstString(item?.name) ?? 'tool'
      const step = tools.get(callId) ?? {
        id: callId, sequence: event.sequence, kind: 'tool' as const, title: toolTitle(name), summary: toolTitle(name),
        status: 'running' as const, timestamp: event.timestamp, files: [],
      }
      step.status = event.type === 'tool.failed' ? 'failed' : 'completed'
      step.durationMs = typeof event.payload.durationMs === 'number' ? event.payload.durationMs : undefined
      step.output = firstString(event.payload.output, item?.output)
      if (!tools.has(callId)) steps.push(step)
      tools.set(callId, step)
      return
    }
    if (event.type === 'file.changed') {
      const path = firstString(event.payload.path) ?? 'Unknown file'
      const change = {
        path,
        startLine: typeof event.payload.startLine === 'number' ? event.payload.startLine : 1,
        endLine: typeof event.payload.endLine === 'number' ? event.payload.endLine : typeof event.payload.startLine === 'number' ? event.payload.startLine : 1,
      }
      const callId = firstString(event.payload.callId, event.payload.call_id)
      const owner = callId ? tools.get(callId) : [...tools.values()].reverse().find((step) => step.status === 'running')
      if (owner) owner.files.push(change)
      else steps.push({
        id: event.id, sequence: event.sequence, kind: 'file', title: 'File changed', summary: path,
        status: 'completed', timestamp: event.timestamp, files: [change],
      })
      return
    }
    if (event.type === 'model.requested') {
      const round = typeof event.payload.round === 'number' ? event.payload.round : 1
      const key = `${eventAgentId(event)}:${round}`
      const step: ExecutionStep = {
        id: event.id, sequence: event.sequence, kind: 'model', title: `Model turn ${round}`,
        summary: firstString(event.payload.model) ?? 'Provider model', status: 'running', timestamp: event.timestamp,
        details: {
          endpoint: event.payload.endpoint,
          model: event.payload.model,
          toolRound: event.payload.toolRound,
          toolsEnabled: event.payload.toolsEnabled,
          agentId: eventAgentId(event),
        },
        files: [],
      }
      models.set(key, step)
      steps.push(step)
      return
    }
    if (event.type === 'model.completed') {
      const round = typeof event.payload.round === 'number' ? event.payload.round : 1
      const key = `${eventAgentId(event)}:${round}`
      const step = models.get(key) ?? {
        id: event.id, sequence: event.sequence, kind: 'model' as const, title: `Model turn ${round}`,
        summary: 'Provider model', status: 'running' as const, timestamp: event.timestamp, files: [],
      }
      step.status = 'completed'
      step.durationMs = typeof event.payload.durationMs === 'number' ? event.payload.durationMs : undefined
      step.details = { ...step.details, ...event.payload }
      if (!models.has(key)) steps.push(step)
      models.set(key, step)
      return
    }

    const common = { id: event.id, sequence: event.sequence, timestamp: event.timestamp, files: [] as ExecutionFileChange[] }
    if (event.type === 'run.created') steps.push({
      ...common, kind: 'run', title: 'Run started',
      summary: [firstString(event.payload.provider), firstString(event.payload.model)].filter(Boolean).join(' · '),
      status: 'completed', details: event.payload,
    })
    else if (event.type === 'run.completed') steps.push({ ...common, kind: 'run', title: 'Run completed', summary: `${String(event.payload.rounds ?? '')} model turns`.trim(), status: 'completed', details: event.payload })
    else if (event.type === 'run.failed') steps.push({ ...common, kind: 'run', title: 'Run failed', summary: firstString(event.payload.error, event.payload.reason) ?? 'Runtime failure', status: 'failed', details: event.payload })
    else if (event.type === 'run.cancelled') steps.push({ ...common, kind: 'run', title: 'Run cancelled', summary: firstString(event.payload.reason) ?? 'Cancelled', status: 'cancelled', details: event.payload })
    else if (event.type === 'run.steered') steps.push({ ...common, kind: 'guidance', title: 'Guidance applied', summary: `${String(event.payload.count ?? 1)} instruction`, status: 'completed', details: event.payload })
    else if (event.type === 'agent.started') {
      const agentId = eventAgentId(event)
      const step = { ...common, id: `agent:${agentId}`, kind: 'agent' as const, title: `Agent · ${firstString(event.payload.name) ?? agentId}`, summary: firstString(event.payload.task) ?? 'Delegated task', status: 'running' as const, details: event.payload }
      agents.set(agentId, step)
      steps.push(step)
    }
    else if (event.type === 'agent.completed') {
      const agentId = eventAgentId(event)
      const step = agents.get(agentId) ?? { ...common, id: `agent:${agentId}`, kind: 'agent' as const, title: `Agent · ${firstString(event.payload.name) ?? agentId}`, summary: 'Delegated task', status: 'running' as const }
      step.status = runtimeAgentState(event.payload.status, event.type) === 'failed' ? 'failed' : runtimeAgentState(event.payload.status, event.type) === 'cancelled' ? 'cancelled' : 'completed'
      step.summary = firstString(event.payload.error, event.payload.result, event.payload.task) ?? 'Delegated task finished'
      step.details = { ...step.details, ...event.payload }
      if (!agents.has(agentId)) steps.push(step)
      agents.set(agentId, step)
    }
    else if (event.type === 'context.compacted') steps.push({ ...common, kind: 'context', title: 'Context compacted', summary: `${String(event.payload.messageCount ?? 0)} messages`, status: 'completed', details: event.payload })
  })
  const terminal = [...ordered].reverse().find((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
  if (terminal) {
    const finalStatus: ExecutionStatus = terminal.type === 'run.failed' ? 'failed' : terminal.type === 'run.cancelled' ? 'cancelled' : 'completed'
    steps.forEach((step) => {
      if (step.status === 'running') step.status = finalStatus
    })
  }
  return steps.sort((left, right) => left.sequence - right.sequence)
}

function executionStatus(events: RuntimeEventRecord[]) {
  const terminal = [...events]
    .sort((left, right) => right.sequence - left.sequence)
    .find((event) => ['run.completed', 'run.failed', 'run.cancelled'].includes(event.type))
  if (terminal?.type === 'run.failed') return 'failed' as const
  if (terminal?.type === 'run.cancelled') return 'cancelled' as const
  if (terminal?.type === 'run.completed') return 'completed' as const
  return 'running' as const
}

function formatDuration(durationMs?: number) {
  if (durationMs === undefined) return ''
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`
}

function ExecutionStatusIcon({ status }: { status: ExecutionStatus }) {
  if (status === 'running') return <LoaderCircle className="is-spinning" size={14} />
  if (status === 'failed') return <CircleX size={14} />
  if (status === 'cancelled') return <Clock size={14} />
  return <CheckCircle2 size={14} />
}

function ExecutionStepDisclosure({
  step,
  command,
  onOpenFile,
}: {
  step: ExecutionStep
  command?: ExecutionDisclosureCommand | null
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(step.status === 'running')
  const userToggled = useRef(false)
  const previousStatus = useRef(step.status)
  const disclosureLabel = `${step.title}: ${step.summary} (step ${step.sequence})`
  useEffect(() => {
    if (!command) return
    userToggled.current = true
    setOpen(command.open)
  }, [command?.revision])
  useEffect(() => {
    if (previousStatus.current === 'running' && step.status !== 'running' && !userToggled.current) setOpen(false)
    previousStatus.current = step.status
  }, [step.status])
  return <details aria-label={disclosureLabel} className={`execution-step state-${step.status}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary aria-label={disclosureLabel} onClick={() => { userToggled.current = true }}>
      <span className="execution-status"><ExecutionStatusIcon status={step.status} /></span>
      <span className="execution-step-copy"><strong><code>#{step.sequence}</code><span>{step.title}</span></strong><small>{step.summary}</small></span>
      {step.durationMs !== undefined ? <time>{formatDuration(step.durationMs)}</time> : null}
      <ChevronRight className="execution-chevron" size={14} />
    </summary>
    <div className="execution-evidence">
      {step.arguments ? <section><span>Arguments</span><pre>{JSON.stringify(step.arguments, null, 2)}</pre></section> : null}
      {step.files.length ? <section><span>Files</span><div className="execution-files">{step.files.map((file) => (
        <button type="button" key={`${file.path}:${file.startLine}`} onClick={() => onOpenFile?.(file.path)} disabled={!onOpenFile}>
          <FilePenLine size={13} /><span>{file.path}</span><code>{file.startLine === file.endLine ? `L${file.startLine}` : `L${file.startLine}-${file.endLine}`}</code>
        </button>
      ))}</div></section> : null}
      {step.output ? <section><span>Result</span><pre>{step.output}</pre></section> : null}
      {step.details && !step.arguments && !step.output ? <section><span>Evidence</span><pre>{JSON.stringify(step.details, null, 2)}</pre></section> : null}
    </div>
  </details>
}

function ExecutionStepList({ steps, command, onOpenFile }: { steps: ExecutionStep[]; command?: ExecutionDisclosureCommand | null; onOpenFile?: (path: string) => void }) {
  return <div className="execution-steps">
    {steps.map((step) => <ExecutionStepDisclosure step={step} command={command} onOpenFile={onOpenFile} key={step.id} />)}
  </div>
}

function ExecutionDisclosureControls({ onExpand, onCollapse }: { onExpand: () => void; onCollapse: () => void }) {
  return <span className="execution-controls" role="group" aria-label="Execution step display">
    <button type="button" onClick={onExpand} aria-label="Expand all execution steps" title="Expand all execution steps"><ChevronsDown size={13} /></button>
    <button type="button" onClick={onCollapse} aria-label="Collapse all execution steps" title="Collapse all execution steps"><ChevronsUp size={13} /></button>
  </span>
}

function latestRunId(events: RuntimeEventRecord[]) {
  return [...events]
    .filter((event) => event.type === 'run.created')
    .sort((left, right) => right.timestamp - left.timestamp || right.sequence - left.sequence)[0]?.runId
    ?? events[0]?.runId
}

export function currentExecutionSummary(events: RuntimeEventRecord[], runId?: string | null) {
  const relevant = events
    .filter((event) => (!runId || event.runId === runId) && event.type !== 'model.delta')
    .sort((left, right) => right.sequence - left.sequence || right.timestamp - left.timestamp)
  const latest = relevant[0]
  if (!latest) return 'Preparing run'
  const item = eventItem(latest)
  if (latest.type === 'tool.started') {
    const name = firstString(item?.name) ?? 'tool'
    return `${toolTitle(name)} · ${toolSummary(name, parsedArguments(item?.arguments))}`
  }
  if (latest.type === 'model.requested') return `Waiting for ${firstString(latest.payload.model) ?? 'model'} · turn ${String(latest.payload.round ?? 1)}`
  if (latest.type === 'file.changed') return `Changed ${firstString(latest.payload.path) ?? 'workspace file'}`
  if (latest.type === 'agent.started') return `Delegated · ${firstString(latest.payload.task) ?? 'specialist task'}`
  if (latest.type === 'run.steered') return 'Applying active-run guidance'
  if (latest.type === 'tool.completed') return `${toolTitle(firstString(item?.name) ?? 'tool')} completed`
  if (latest.type === 'tool.failed') return `${toolTitle(firstString(item?.name) ?? 'tool')} failed`
  return latest.type.replaceAll('.', ' ')
}

function ExecutionTimeline({ events, onOpenFile }: { events: RuntimeEventRecord[]; onOpenFile?: (path: string) => void }) {
  const [command, setCommand] = useState<ExecutionDisclosureCommand | null>(null)
  const runId = latestRunId(events)
  if (!runId) return null
  const runEvents = events.filter((event) => event.runId === runId)
  const started = runEvents.find((event) => event.type === 'run.created')
  const status = executionStatus(runEvents)
  const steps = executionSteps(runEvents)
  return <section className={`execution-timeline state-${status}`} aria-label="运行执行步骤">
    <header>
      <span className="execution-run-mark"><Command size={14} /></span>
      <span><strong>{firstString(started?.payload.provider) ?? 'Agent run'}</strong><small>{firstString(started?.payload.model) ?? runId.slice(0, 8)}</small></span>
      <b>{status}</b>
      <ExecutionDisclosureControls
        onExpand={() => setCommand((current) => ({ open: true, revision: (current?.revision ?? 0) + 1 }))}
        onCollapse={() => setCommand((current) => ({ open: false, revision: (current?.revision ?? 0) + 1 }))}
      />
    </header>
    <ExecutionStepList steps={steps} command={command} onOpenFile={onOpenFile} />
  </section>
}

export function ConversationPanel({
  session,
  messages,
  liveMessage,
  agents,
  disabled,
  runActive = false,
  queuedPrompts = [],
  draftRequest,
  notice,
  events = [],
  onOpenExecutionFile,
  onSend,
  onRemoveQueued = () => undefined,
  onRunQueued = async () => undefined,
}: {
  session: Session
  messages: Message[]
  liveMessage?: Message
  agents: Agent[]
  disabled: boolean
  runActive?: boolean
  queuedPrompts?: QueuedPrompt[]
  draftRequest?: ComposerDraftRequest | null
  notice?: string
  events?: RuntimeEventRecord[]
  onOpenExecutionFile?: (path: string) => void
  onSend: (text: string, mode: ComposerSendMode) => Promise<boolean>
  onRemoveQueued?: (id: string) => void
  onRunQueued?: (prompt: QueuedPrompt) => Promise<void>
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [runInputMode, setRunInputMode] = useState<'steer' | 'queue'>('steer')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const wasRunActive = useRef(runActive)
  const streamEnd = useRef<HTMLDivElement>(null)
  const composerInput = useRef<HTMLTextAreaElement>(null)
  const handledDraftRequest = useRef('')
  const draft = drafts[session.id] ?? ''
  const workingAgents = agents.filter((agent) => agent.state === 'working')
  const activeWorker = workingAgents.find((agent) => agent.parent) ?? workingAgents[0]

  useEffect(() => {
    streamEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [session.id, liveMessage?.body, messages.length])

  useEffect(() => {
    if (runActive && !wasRunActive.current) setRunInputMode('steer')
    wasRunActive.current = runActive
  }, [runActive])

  useEffect(() => {
    if (!draftRequest || draftRequest.sessionId !== session.id || handledDraftRequest.current === draftRequest.id) return
    handledDraftRequest.current = draftRequest.id
    const requestedText = draftRequest.text.trim()
    if (!requestedText) return
    setDrafts((current) => {
      const existing = (current[session.id] ?? '').trim()
      return { ...current, [session.id]: existing ? `${existing}\n\n${requestedText}` : requestedText }
    })
    requestAnimationFrame(() => composerInput.current?.focus())
  }, [draftRequest, session.id])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (disabled || submittingRef.current || !draft.trim()) return
    const submittedDraft = draft
    submittingRef.current = true
    setSubmitting(true)
    try {
      const mode: ComposerSendMode = runActive ? runInputMode : 'run'
      if (await onSend(submittedDraft.trim(), mode)) {
        setDrafts((current) => current[session.id] === submittedDraft ? { ...current, [session.id]: '' } : current)
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
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
        {events.length ? <ExecutionTimeline events={events} onOpenFile={onOpenExecutionFile} /> : null}
        {activeWorker ? (
          <div className="agent-thinking">
            <span className="thinking-caret">›</span>
            <span>{activeWorker.name} · <code>{activeWorker.task}</code></span>
            <span className="thinking-time">{activeWorker.progress}%</span>
          </div>
        ) : null}
        <div ref={streamEnd} />
      </div>

      {queuedPrompts.length ? (
        <div className="prompt-queue" aria-label="待执行消息队列">
          {queuedPrompts.map((prompt, index) => (
            <div className="prompt-queue-row" key={prompt.id}>
              <span>{index + 1}</span>
              <p>{prompt.text}</p>
              {!runActive && index === 0 ? <button type="button" onClick={() => void onRunQueued(prompt)} aria-label="运行下一条排队消息" title="Run next queued message"><Play size={13} /></button> : null}
              <button type="button" onClick={() => onRemoveQueued(prompt.id)} aria-label={`移除排队消息 ${index + 1}`} title="Remove queued message"><X size={13} /></button>
            </div>
          ))}
        </div>
      ) : null}

      <form className="composer" onSubmit={submit}>
        {runActive ? (
          <div className="composer-mode-row">
            <div className="composer-mode" role="group" aria-label="Active run message behavior">
              <button
                type="button"
                className={runInputMode === 'steer' ? 'is-active' : ''}
                aria-pressed={runInputMode === 'steer'}
                title="Apply this instruction after the active run's current step"
                disabled={submitting}
                onClick={() => setRunInputMode('steer')}
              >Guide run</button>
              <button
                type="button"
                className={runInputMode === 'queue' ? 'is-active' : ''}
                aria-pressed={runInputMode === 'queue'}
                title="Start a new turn after this run finishes"
                disabled={submitting}
                onClick={() => setRunInputMode('queue')}
              >Queue next</button>
            </div>
          </div>
        ) : null}
        {notice ? <div className="composer-notice" role="status" aria-live="polite">{notice}</div> : null}
        <textarea
          ref={composerInput}
          value={draft}
          onChange={(event) => setDrafts((current) => ({ ...current, [session.id]: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
          disabled={disabled}
          rows={3}
          placeholder={session.archived ? 'Restore this session to continue' : runActive && runInputMode === 'steer' ? 'Guide the active run…' : runActive ? 'Queue the next turn…' : 'Message orchestrator…'}
          aria-label={runActive && runInputMode === 'steer' ? '引导当前运行' : runActive ? '排队下一轮' : '发送给主智能体'}
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <span className="scope-label">scope: {session.branch}</span>
            {runActive || queuedPrompts.length ? <span className="composer-queue-state">{queuedPrompts.length} queued</span> : null}
          </div>
          <button className="send-button" type="submit" aria-label={runActive && runInputMode === 'steer' ? '引导当前运行' : runActive ? '排队消息' : '发送消息'} disabled={disabled || submitting || !draft.trim()}><Send size={16} /></button>
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

export function untrackedFileDiff(file: WorkspaceFile) {
  if (file.truncated) return ''
  const lines = file.content ? file.content.split('\n') : []
  const hunk = lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)] : []
  return [
    `diff --git a/${file.path} b/${file.path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${file.path}`,
    ...hunk,
  ].join('\n')
}

export function FileTree({
  workspace,
  selected,
  loading,
  disabled = false,
  controlsDisabled = false,
  onSelect,
  onRefresh,
  onOpen,
}: {
  workspace: WorkspaceView | null
  selected: string
  loading: boolean
  disabled?: boolean
  controlsDisabled?: boolean
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
          <button type="button" className={`tree-refresh${loading ? ' is-loading' : ''}`} onClick={onRefresh} disabled={loading || disabled || controlsDisabled} aria-busy={loading} aria-label="刷新工作区" title="刷新工作区">
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
            <button type="button" disabled={loading || disabled || controlsDisabled} onClick={onOpen}><FolderOpen size={14} />Open folder</button>
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
  agentEdit = null,
  followAgent = true,
  followBlocked = false,
  onMode,
  onDraft,
  onSave,
  onRevert,
  onFollowAgent = () => undefined,
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
  agentEdit?: AgentEditTarget | null
  followAgent?: boolean
  followBlocked?: boolean
  onMode: (mode: EditorMode) => void
  onDraft: (content: string) => void
  onSave: () => void
  onRevert: () => void
  onFollowAgent?: (enabled: boolean) => void
}) {
  const gutterRef = useRef<HTMLPreElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const viewerRef = useRef<HTMLDivElement>(null)
  const [tabMovesFocus, setTabMovesFocus] = useState(false)
  const content = file ? draftPath === file.path ? draft : file.content : ''
  const contentRef = useRef(content)
  contentRef.current = content
  const lines = content.split('\n')
  const activeEdit = file && agentEdit?.path === file.path ? agentEdit : null

  useEffect(() => {
    if (!activeEdit || !file) return
    const currentLines = contentRef.current.split('\n')
    const startLine = Math.min(activeEdit.startLine, currentLines.length)
    const endLine = Math.min(Math.max(activeEdit.endLine, startLine), currentLines.length)
    const frame = requestAnimationFrame(() => {
      if (mode === 'edit' && canEdit && editorRef.current) {
        const beforeStart = currentLines.slice(0, startLine - 1).join('\n')
        const startOffset = beforeStart.length + (startLine > 1 ? 1 : 0)
        editorRef.current.setSelectionRange(startOffset, startOffset)
        editorRef.current.scrollTop = Math.max(0, (startLine - 1) * 20 - editorRef.current.clientHeight * 0.35)
        if (gutterRef.current) gutterRef.current.scrollTop = editorRef.current.scrollTop
        return
      }
      const line = viewerRef.current?.querySelector<HTMLElement>(`[data-line="${startLine}"]`)
      if (line && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeEdit?.eventId, canEdit, file?.path, mode])

  if (loading) return <div className="workspace-empty"><RefreshCw className="is-spinning" size={18} /><strong>Reading file</strong></div>
  if (error && !file) return <div className="workspace-empty is-error"><File size={18} /><strong>Preview unavailable</strong><p>{error}</p></div>
  if (!file) return <div className="workspace-empty"><FileCode2 size={18} /><strong>Select a file</strong><p>Code and diffs stay tied to the selected workspace.</p></div>

  return (
    <div className={`code-editor mode-${mode}`} role="region" aria-label="代码编辑器">
      <div className="code-editor-toolbar">
        <div className="editor-mode-toggle" role="group" aria-label="编辑器模式">
          <button type="button" className={mode === 'view' ? 'is-active' : ''} aria-pressed={mode === 'view'} onClick={() => onMode('view')} disabled={saving}>View</button>
          <button type="button" className={mode === 'edit' ? 'is-active' : ''} aria-pressed={mode === 'edit'} onClick={() => onMode('edit')} disabled={!canEdit || saving}>Edit</button>
        </div>
        <span className={`editor-file-state${dirty ? ' is-dirty' : ''}`}>{dirty ? 'Unsaved changes' : activeEdit ? `Agent edit · L${activeEdit.startLine}${activeEdit.endLine > activeEdit.startLine ? `–${activeEdit.endLine}` : ''}` : file.truncated ? 'Read only' : 'Saved'}</span>
        <div className="editor-actions">
          <button className={`editor-follow${followAgent ? ' is-active' : ''}${followBlocked ? ' is-blocked' : ''}`} type="button" aria-pressed={followAgent} onClick={() => onFollowAgent(!followAgent)} title={followBlocked ? 'Save or revert local changes before following the agent' : followAgent ? 'Pause automatic agent navigation' : 'Follow the latest agent edit'}>
            <Crosshair size={14} />
            {followBlocked ? 'Blocked' : followAgent ? 'Following' : 'Follow'}
          </button>
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
        <div className="code-view" ref={viewerRef} data-agent-edit={activeEdit?.eventId}>
          {lines.map((line, index) => (
            <div className={`code-line${activeEdit && index + 1 >= activeEdit.startLine && index + 1 <= activeEdit.endLine ? ' is-agent-edit' : ''}`} data-line={index + 1} key={`${activeEdit?.eventId ?? 'line'}-${index}-${line.slice(0, 16)}`}>
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

export function DiffView({ stagedDiff, workingDiff, path, loading, error }: { stagedDiff: string; workingDiff: string; path: string; loading: boolean; error: string | null }) {
  const [scope, setScope] = useState<'staged' | 'working'>('working')
  const hasStaged = Boolean(stagedDiff.trim())
  const hasWorking = Boolean(workingDiff.trim())
  const activeScope = scope === 'staged' && hasStaged || !hasWorking && hasStaged ? 'staged' : 'working'
  const diff = activeScope === 'staged' ? stagedDiff : workingDiff
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff])
  const additions = lines.filter((line) => line.type === 'add').length
  const deletions = lines.filter((line) => line.type === 'remove').length

  useEffect(() => {
    if (scope === 'staged' && !hasStaged && hasWorking) setScope('working')
    if (scope === 'working' && !hasWorking && hasStaged) setScope('staged')
  }, [hasStaged, hasWorking, path, scope])

  if (loading) return <div className="workspace-empty"><RefreshCw className="is-spinning" size={18} /><strong>Reading diff</strong></div>
  if (!path) return <div className="workspace-empty"><GitCompareArrows size={18} /><strong>Select a changed file</strong></div>
  if (error && !hasStaged && !hasWorking) return <div className="workspace-empty is-error"><GitCompareArrows size={18} /><strong>Diff unavailable</strong><p>{error}</p></div>
  if (!hasStaged && !hasWorking) return <div className="workspace-empty"><Check size={18} /><strong>No tracked diff</strong><p>The file is clean.</p></div>

  return (
    <div className="diff-view" role="region" aria-label="代码差异">
      {error ? <div className="diff-error-note">Partial diff · {error}</div> : null}
      <div className="diff-scope" aria-label="Diff scope">
        <button type="button" className={activeScope === 'working' ? 'is-active' : ''} disabled={!hasWorking} onClick={() => setScope('working')}>Working</button>
        <button type="button" className={activeScope === 'staged' ? 'is-active' : ''} disabled={!hasStaged} onClick={() => setScope('staged')}>Staged</button>
      </div>
      <div className="diff-file-head">
        <span>{path} · {activeScope === 'staged' ? 'staged for commit' : 'working tree'}</span>
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

export function runtimeAgentState(status: unknown, eventType: string): Agent['state'] {
  const value = String(status ?? '').toLowerCase()
  if (['failed', 'error', 'errored'].includes(value)) return 'failed'
  if (['cancelled', 'canceled', 'aborted', 'stopped'].includes(value)) return 'cancelled'
  if (['completed', 'complete', 'done', 'shutdown', 'closed', 'success', 'succeeded'].includes(value)) return 'done'
  if (['idle', 'ready'].includes(value)) return 'idle'
  if (['queued', 'pending', 'waiting'].includes(value)) return 'queued'
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
    const role = firstString(detail.role, detail.agent_role, source.role, source.agent_role) ?? 'Subagent'
    const profile = firstString(detail.profile, source.profile)
    derived.set(id, {
      id,
      name: firstString(detail.name, detail.agent_name, source.name, source.agent_name) ?? `Agent ${shortId}`,
      role: profile ? `${role} · ${profile}` : role,
      model: firstString(detail.model, source.model) ?? root.model,
      state,
      progress: ['done', 'failed', 'cancelled'].includes(state) ? 100 : ['queued', 'idle'].includes(state) ? 0 : 50,
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

export function TerminalView({ runState, workspace, branch, events }: { runState: 'idle' | 'running'; workspace: WorkspaceView | null; branch: string; events: RuntimeEventRecord[] }) {
  const commands = [...new Set(events.map((event) => event.runId))]
    .flatMap((runId) => executionSteps(events.filter((event) => event.runId === runId))
      .filter((step) => step.kind === 'tool')
      .map((step) => ({ runId, step })))
    .sort((left, right) => right.step.timestamp - left.step.timestamp)
    .slice(0, 24)
  return (
    <div className="terminal-view" role="log" aria-live="polite">
      <div><span className="prompt">trace@{branch}</span><span className="terminal-path"> {workspace?.path ?? '~'}</span> git status --short</div>
      {workspace?.snapshot.files.length ? workspace.snapshot.files.map((file) => (
        <div className="terminal-muted" key={file.path}> {file.indexStatus}{file.worktreeStatus} {file.path}</div>
      )) : <div className="terminal-pass"> ✓ Working tree clean</div>}
      {commands.map(({ runId, step }) => {
        const completed = step.status === 'completed'
        return <div key={`${runId}:${step.id}`} className={completed ? 'terminal-muted' : step.status === 'failed' ? 'terminal-error' : 'terminal-active'}>
          <span className="prompt">{completed ? '$' : step.status === 'failed' ? '×' : '›'}</span> {step.summary}
          {step.output ? <details><summary>Show result · {formatDuration(step.durationMs) || step.status}</summary><pre>{step.output}</pre></details> : null}
        </div>
      })}
      {runState === 'running' ? <div className="terminal-active">› Traceframe run is active</div> : <div><span className="prompt">trace@{branch}</span><span className="cursor-block" /></div>}
    </div>
  )
}

function TraceRunDisclosure({
  run,
  defaultOpen,
  command,
  onOpenFile,
}: {
  run: { runId: string; events: RuntimeEventRecord[]; status: ExecutionStatus; steps: ExecutionStep[] }
  defaultOpen: boolean
  command?: ExecutionDisclosureCommand | null
  onOpenFile?: (path: string) => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (command) setOpen(command.open)
  }, [command?.revision])
  return <details className={`trace-run state-${run.status}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <ExecutionStatusIcon status={run.status} />
      <span><strong>Run {run.runId.slice(0, 8)}</strong><small>{run.steps.length} recorded steps</small></span>
      <time>{new Date(run.events[0]?.timestamp ?? Date.now()).toLocaleTimeString()}</time>
      <ChevronRight size={14} />
    </summary>
    <ExecutionStepList steps={run.steps} command={command} onOpenFile={onOpenFile} />
  </details>
}

function ActivityView({ events, onOpenFile }: { events: RuntimeEventRecord[]; onOpenFile?: (path: string) => void }) {
  const [command, setCommand] = useState<ExecutionDisclosureCommand | null>(null)
  const runIds = [...new Set(events.map((event) => event.runId))]
  const runs = runIds.map((runId) => {
    const runEvents = events.filter((event) => event.runId === runId)
    return { runId, events: runEvents, status: executionStatus(runEvents), steps: executionSteps(runEvents) }
  }).sort((left, right) => (right.events.at(-1)?.timestamp ?? 0) - (left.events.at(-1)?.timestamp ?? 0))
  return (
    <div className="trace-list" role="log" aria-live="polite">
      {runs.length ? <div className="trace-toolbar"><span>Runs</span><ExecutionDisclosureControls
        onExpand={() => setCommand((current) => ({ open: true, revision: (current?.revision ?? 0) + 1 }))}
        onCollapse={() => setCommand((current) => ({ open: false, revision: (current?.revision ?? 0) + 1 }))}
      /></div> : null}
      {runs.map((run, index) => (
        <TraceRunDisclosure run={run} defaultOpen={index === 0 || run.status === 'failed'} command={command} onOpenFile={onOpenFile} key={run.runId} />
      ))}
      {!runs.length ? <div className="workspace-empty"><Activity size={18} /><strong>No runtime events</strong><p>Streaming text stays in Conversation; tool and lifecycle evidence appears here.</p></div> : null}
    </div>
  )
}

type GitOperationName = 'refresh' | 'switch' | 'create' | 'stage' | 'unstage' | 'commit' | 'pull' | 'push'

export function GitPanel({
  workspace,
  history,
  historyLoading,
  historyError,
  busy,
  operation,
  error,
  output,
  disabled,
  onRefresh,
  onSwitchBranch,
  onCreateBranch,
  onStageAll,
  onUnstageAll,
  onCommit,
  onPull,
  onPush,
  onOpenFile,
}: {
  workspace: WorkspaceView | null
  history: GitCommitRecord[]
  historyLoading: boolean
  historyError: string | null
  busy: boolean
  operation: GitOperationName | null
  error: string | null
  output: string
  disabled: boolean
  onRefresh: () => Promise<boolean>
  onSwitchBranch: (branch: string) => Promise<boolean>
  onCreateBranch: (branch: string) => Promise<boolean>
  onStageAll: () => Promise<boolean>
  onUnstageAll: () => Promise<boolean>
  onCommit: (message: string) => Promise<boolean>
  onPull: () => Promise<boolean>
  onPush: () => Promise<boolean>
  onOpenFile: (path: string) => void
}) {
  const [branchDraft, setBranchDraft] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [openSections, setOpenSections] = useState({ changes: true, history: false, branches: false })
  const snapshot = workspace?.snapshot
  const staged = snapshot?.files.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?') ?? []
  const unstaged = snapshot?.files.filter((file) => file.worktreeStatus !== ' ') ?? []
  const locked = busy || disabled || !workspace
  useEffect(() => {
    setBranchDraft('')
    setCommitMessage('')
    setOpenSections({ changes: true, history: false, branches: false })
  }, [workspace?.path])
  const setSectionOpen = (section: keyof typeof openSections, open: boolean) => {
    setOpenSections((current) => current[section] === open ? current : { ...current, [section]: open })
  }
  const submitBranch = async (event: FormEvent) => {
    event.preventDefault()
    const value = branchDraft.trim()
    if (!value || locked) return
    if (await onCreateBranch(value)) setBranchDraft('')
  }
  const submitCommit = async (event: FormEvent) => {
    event.preventDefault()
    const value = commitMessage.trim()
    if (!value || locked || !staged.length) return
    if (await onCommit(value)) setCommitMessage('')
  }

  if (!workspace || !snapshot) {
    return <div className="source-panel source-empty"><GitFork size={18} /><strong>No Git repository</strong><p>Open a local repository to manage branches and changes.</p></div>
  }

  return <div className="source-panel">
    <header className="source-head">
      <div><span>Repository</span><strong>{workspace.name}</strong></div>
      <button type="button" aria-label="Refresh Git status" title="Refresh Git status" disabled={locked} onClick={() => void onRefresh()}>
        <RefreshCw className={operation === 'refresh' ? 'is-spinning' : ''} size={15} />
      </button>
    </header>

    <form className="source-commit" onSubmit={submitCommit}>
      <label htmlFor="source-commit-message">Commit staged changes</label>
      <textarea id="source-commit-message" aria-label="Commit message" value={commitMessage} maxLength={2000} rows={3} disabled={locked} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" />
      <button type="submit" disabled={locked || !staged.length || !commitMessage.trim()}><GitCommitHorizontal size={14} />Commit {staged.length || ''}</button>
    </form>

    <details className="source-section source-changes" open={openSections.changes} onToggle={(event) => setSectionOpen('changes', event.currentTarget.open)}>
      <summary className="source-section-title"><ChevronRight size={13} /><span>Changes</span><code>{snapshot.files.length}</code></summary>
      <div className="source-section-body">
        <div className="source-change-actions">
          <button type="button" disabled={locked || !unstaged.length} onClick={() => void onStageAll()}><Plus size={13} />Stage all</button>
          <button type="button" disabled={locked || !staged.length} onClick={() => void onUnstageAll()}><RotateCcw size={13} />Unstage all</button>
        </div>
        {staged.length ? <div className="source-change-group">
          <span>Staged</span>
          <div className="source-file-list">{staged.map((file) => (
            <button type="button" key={`staged:${file.path}`} disabled={busy} onClick={() => onOpenFile(file.path)}>
              <FileCode2 size={13} /><span>{file.path}</span><code>{file.indexStatus}</code>
            </button>
          ))}</div>
        </div> : null}
        {unstaged.length ? <div className="source-change-group">
          <span>Working tree</span>
          <div className="source-file-list">{unstaged.map((file) => (
            <button type="button" key={`working:${file.path}`} disabled={busy} onClick={() => onOpenFile(file.path)}>
              <FileCode2 size={13} /><span>{file.path}</span><code>{file.worktreeStatus === '?' ? '??' : file.worktreeStatus}</code>
            </button>
          ))}</div>
        </div> : null}
        {!snapshot.files.length ? <div className="source-file-list"><p>Working tree clean</p></div> : null}
      </div>
    </details>

    <details className="source-section source-history" aria-label="Commit history" open={openSections.history} onToggle={(event) => setSectionOpen('history', event.currentTarget.open)}>
      <summary className="source-section-title"><ChevronRight size={13} /><span>History</span><code>{history.length || ''}</code></summary>
      <div className="source-section-body">
        {historyLoading ? <div className="source-operation"><LoaderCircle className="is-spinning" size={13} />Loading history</div> : null}
        {historyError ? <div className="source-result is-error" role="alert">History unavailable: {historyError}</div> : null}
        {!historyLoading && !historyError && !history.length ? <p className="source-history-empty">No commits yet</p> : null}
        <div className="source-history-list">
          {history.map((commit) => (
            <details className="source-history-entry" key={commit.hash}>
              <summary>
                <GitCommitHorizontal size={13} />
                <span>{commit.subject || 'Commit without a subject'}</span>
                <code>{commit.shortHash}</code>
              </summary>
              <div className="source-history-meta">
                <span>{commit.author}</span>
                <time dateTime={commit.authoredAt}>{new Date(commit.authoredAt).toLocaleString('zh-CN', { hour12: false })}</time>
                <code title={commit.hash}>{commit.hash}</code>
                {commit.refs.length ? <div>{commit.refs.map((reference) => <span key={reference}>{reference}</span>)}</div> : null}
              </div>
            </details>
          ))}
        </div>
      </div>
    </details>

    <details className="source-section source-branches" open={openSections.branches} onToggle={(event) => setSectionOpen('branches', event.currentTarget.open)}>
      <summary className="source-section-title"><ChevronRight size={13} /><span>Branches & remote</span><code>{snapshot.branch}</code></summary>
      <div className="source-section-body">
        <label className="source-field">
          <span>Switch branch</span>
          <select aria-label="Switch branch" value={snapshot.branch} disabled={locked} onChange={(event) => void onSwitchBranch(event.target.value)}>
            {workspace.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
          </select>
        </label>
        <form className="source-inline-form" onSubmit={submitBranch}>
          <input aria-label="New branch name" value={branchDraft} maxLength={200} disabled={locked} onChange={(event) => setBranchDraft(event.target.value)} placeholder="New branch name" />
          <button type="submit" disabled={locked || !branchDraft.trim()}><GitBranch size={14} />Create</button>
        </form>
        <div className="source-divergence">
          <span>ahead {snapshot.ahead}</span><span>behind {snapshot.behind}</span>
          <div />
          <button type="button" disabled={locked} onClick={() => void onPull()}><Download size={13} />Pull</button>
          <button type="button" disabled={locked} onClick={() => void onPush()}><Upload size={13} />Push</button>
        </div>
      </div>
    </details>

    {operation ? <div className="source-operation" role="status"><LoaderCircle className="is-spinning" size={13} />{operation}</div> : null}
    {error ? <div className="source-result is-error" role="alert">{error}</div> : null}
    {output ? <details className="source-result"><summary>Last Git result</summary><pre>{output}</pre></details> : null}
  </div>
}

interface RepositoryDockProps {
  mode: 'code' | 'diff'
  branchBusy: boolean
  interactionBusy: boolean
  workspace: WorkspaceView | null
  selectedFile: string
  file: WorkspaceFile | null
  stagedDiff: string
  workingDiff: string
  loading: boolean
  fileLoading: boolean
  error: string | null
  fileError: string | null
  diffError: string | null
  agentEdit?: AgentEditTarget | null
  followAgent?: boolean
  followBlocked?: boolean
  onSelectFile: (path: string) => void
  onRefresh: () => void
  onOpenWorkspace: () => void
  onFollowAgent?: (enabled: boolean) => void
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
  stagedDiff,
  workingDiff,
  loading,
  fileLoading,
  error,
  fileError,
  diffError,
  agentEdit = null,
  followAgent = true,
  followBlocked = false,
  onSelectFile,
  onRefresh,
  onOpenWorkspace,
  onFollowAgent = () => undefined,
  editor,
}: RepositoryDockProps) {
  const breadcrumbs = selectedFile.split('/').filter(Boolean)
  const workspaceCtaDisabled = interactionBusy || branchBusy || loading || editor.saving
  const displayedWorkingDiff = workingDiff.trim() || !workspace || !file || file.path !== selectedFile || fileStatus(workspace.snapshot, selectedFile) !== 'U'
    ? workingDiff
    : untrackedFileDiff(file)
  return (
    <section className={`repository-dock${error ? ' has-error' : ''}`} aria-label={mode === 'code' ? '代码文件' : '代码差异'}>
      {error ? <div className="workspace-error"><span>{error}</span><button type="button" disabled={workspaceCtaDisabled} title={interactionBusy ? 'Stop the active run before changing workspaces' : workspaceCtaDisabled ? 'Wait for the current workspace operation to finish' : undefined} onClick={onOpenWorkspace}>Choose another folder</button></div> : null}
      <div className="editor-layout">
        <FileTree
          workspace={workspace}
          selected={selectedFile}
          loading={loading}
          disabled={branchBusy || editor.saving}
          controlsDisabled={interactionBusy}
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
                agentEdit={agentEdit}
                followAgent={followAgent}
                followBlocked={followBlocked}
                onMode={editor.onMode}
                onDraft={editor.onDraft}
                onSave={editor.onSave}
                onRevert={editor.onRevert}
                onFollowAgent={onFollowAgent}
              />
              : <DiffView stagedDiff={stagedDiff} workingDiff={displayedWorkingDiff} path={selectedFile} loading={fileLoading} error={diffError} />}
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
          <svg viewBox="0 0 88 88" aria-label={`最近消息保留窗口 ${runtimeMessages.length} / 30`}>
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
        <div className="agent-runtime-note"><Network size={14} /><span>主智能体可串行委派最多 4 个子任务；scout/reviewer 只读，worker 可写入；每一步都会进入 Trace</span></div>
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
                const protocolDetail = ['cc-switch-responses', 'openai-responses'].includes(provider.adapter)
                  ? 'Coding agent: file, Git, command, and delegated-agent tools are available'
                  : 'Chat only: this protocol cannot read, edit, or test workspace files'
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
                  {provider.adapter !== 'cc-switch-responses' ? <label><span>Protocol</span><select disabled={rowTesting} value={provider.adapter} onChange={(event) => updateProvider(provider.id, { adapter: event.target.value as Provider['adapter'], connected: false, latency: 0, detail: undefined, availableModels: [] })}><option value="openai-responses">Responses API + coding tools</option><option value="openai-chat">OpenAI-compatible chat (chat only)</option><option value="anthropic">Anthropic Messages (chat only)</option></select></label> : null}
                  <p className="provider-mode-detail">{protocolDetail}</p>
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
  const activeSessionIdRef = useRef(previewInitial.activeSessionId)
  activeSessionIdRef.current = activeSessionId
  const [sessionMessages, setSessionMessages] = useState<Record<string, Message[]>>(() => desktop ? {} : loadStored('traceframe.session-messages', initialSessionMessages))
  const [sessionAgents, setSessionAgents] = useState<Record<string, Agent[]>>(() => desktop ? {} : loadStored('traceframe.session-agents', initialSessionAgents))
  const [memories, setMemories] = useState<MemoryRecord[]>(() => desktop ? [] : loadStored('traceframe.memories', initialMemories))
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEventRecord[]>([])
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([])
  const [composerNotices, setComposerNotices] = useState<Record<string, string>>({})
  const [composerDraftRequest, setComposerDraftRequest] = useState<ComposerDraftRequest | null>(null)
  const [terminalCommandDraft, setTerminalCommandDraft] = useState('')
  const composerDraftSequence = useRef(0)
  const queuedPromptsRef = useRef<QueuedPrompt[]>([])
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
  const [workspaceStagedDiff, setWorkspaceStagedDiff] = useState('')
  const [workspaceWorkingDiff, setWorkspaceWorkingDiff] = useState('')
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('view')
  const [editorPath, setEditorPath] = useState('')
  const [editorBaseline, setEditorBaseline] = useState('')
  const [editorDraft, setEditorDraft] = useState('')
  const [editorSaving, setEditorSaving] = useState(false)
  const [editorError, setEditorError] = useState<string | null>(null)
  const [followAgentEdits, setFollowAgentEdits] = useState(true)
  const followAgentEditsRef = useRef(true)
  const [latestAgentEdit, setLatestAgentEdit] = useState<AgentEditTarget | null>(null)
  const latestAgentEditRef = useRef<AgentEditTarget | null>(null)
  const [branchBusy, setBranchBusy] = useState(false)
  const [gitOperation, setGitOperation] = useState<GitOperationName | null>(null)
  const [gitOutput, setGitOutput] = useState('')
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitHistory, setGitHistory] = useState<GitCommitRecord[]>([])
  const [gitHistoryLoading, setGitHistoryLoading] = useState(false)
  const [gitHistoryError, setGitHistoryError] = useState<string | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const activeRunRef = useRef<string | null>(null)
  const cancelledRunIdsRef = useRef(new Set<string>())
  const workspacePickerPendingRef = useRef(false)
  const workspaceRequest = useRef(0)
  const gitHistoryRequest = useRef(0)
  const gitHistoryPathRef = useRef('')
  const fileRequest = useRef(0)
  const selectedFileRef = useRef('')
  const handledFileEventIdsRef = useRef(new Set<string>())
  const lastLoadedAgentEditIdRef = useRef('')
  const agentNavigationTokenRef = useRef(0)
  const agentNavigationPendingRef = useRef(false)
  const agentNavigationOriginRef = useRef('')
  const editorDirty = Boolean(editorPath && editorPath === selectedFile && editorDraft !== editorBaseline)
  const editorDirtyRef = useRef(false)
  editorDirtyRef.current = editorDirty
  const [preferences, setPreferences] = useState<UiPreferences>(() => ({ ...defaultUiPreferences, ...loadStored('traceframe.appearance', defaultUiPreferences) }))
  const [dockModel, setDockModel] = useState(() => storedDockModel(preferences.layout))
  const [activeRail, setActiveRail] = useState<RailComponent | null>(() => selectedRailComponent(dockModel, true))

  const showDock = useCallback((component: DockComponent) => {
    if (dockModel.getNodeById(component)) dockModel.doAction(Actions.selectTab(component))
  }, [dockModel])

  const setFollowAgent = useCallback((enabled: boolean) => {
    followAgentEditsRef.current = enabled
    setFollowAgentEdits(enabled)
  }, [])

  const updateQueuedPrompts = useCallback((update: (current: QueuedPrompt[]) => QueuedPrompt[]) => {
    const next = update(queuedPromptsRef.current)
    queuedPromptsRef.current = next
    setQueuedPrompts(next)
  }, [])

  const removeQueuedPrompt = useCallback((id: string) => {
    updateQueuedPrompts((current) => current.filter((prompt) => prompt.id !== id))
  }, [updateQueuedPrompts])

  const applySnapshot = useCallback((snapshot: Awaited<ReturnType<typeof getAppSnapshot>>) => {
    const grouped = snapshot.messages.reduce<Record<string, Message[]>>((result, message) => {
      const sessionId = message.sessionId ?? ''
      result[sessionId] = [...(result[sessionId] ?? []), message]
      return result
    }, {})
    setSessions(snapshot.sessions)
    setSessionMessages(grouped)
    setMemories(snapshot.memories)
    setRuntimeEvents((current) => mergeSnapshotEvents(snapshot.events, current, activeSessionIdRef.current, Boolean(activeRunRef.current)))
    setActiveSessionId((current) => snapshot.sessions.some((session) => session.id === current) ? current : snapshot.sessions[0]?.id ?? '')
  }, [])

  const reloadNativeState = useCallback(async () => {
    applySnapshot(await getAppSnapshot())
  }, [applySnapshot])

  const loadGitHistory = useCallback(async (path: string) => {
    const request = ++gitHistoryRequest.current
    if (gitHistoryPathRef.current !== path) {
      gitHistoryPathRef.current = path
      setGitHistory([])
    }
    setGitHistoryLoading(true)
    setGitHistoryError(null)
    try {
      const history = await getGitHistory(path)
      if (request !== gitHistoryRequest.current) return
      setGitHistory(history)
    } catch (error) {
      if (request !== gitHistoryRequest.current) return
      setGitHistory([])
      setGitHistoryError(errorMessage(error))
    } finally {
      if (request === gitHistoryRequest.current) setGitHistoryLoading(false)
    }
  }, [])

  const loadWorkspaceFile = useCallback(async (workspacePath: string, path: string) => {
    const request = ++fileRequest.current
    setSelectedFile(path)
    setWorkspaceFile(null)
    setWorkspaceStagedDiff('')
    setWorkspaceWorkingDiff('')
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
    setWorkspaceStagedDiff(stagedDiff.status === 'fulfilled' ? stagedDiff.value : '')
    setWorkspaceWorkingDiff(workingDiff.status === 'fulfilled' ? workingDiff.value : '')
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
        setWorkspaceStagedDiff('')
        setWorkspaceWorkingDiff('')
        setFileError(null)
        setDiffError(null)
      }
      return nextWorkspace
    } catch (error) {
      if (request !== workspaceRequest.current) return
      if (!workspaceRef.current) {
        gitHistoryRequest.current += 1
        gitHistoryPathRef.current = ''
        setGitHistory([])
        setGitHistoryLoading(false)
        setGitHistoryError(null)
        fileRequest.current += 1
        setWorkspace(null)
        setSelectedFile('')
        setWorkspaceFile(null)
        setWorkspaceStagedDiff('')
        setWorkspaceWorkingDiff('')
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

  const navigateToAgentEdit = useCallback((target: AgentEditTarget, workspacePath: string) => {
    const token = ++agentNavigationTokenRef.current
    agentNavigationPendingRef.current = true
    agentNavigationOriginRef.current = selectedFileRef.current
    showDock('code')
    void loadWorkspaceFile(workspacePath, target.path)
      .then(() => {
        if (agentNavigationTokenRef.current === token) lastLoadedAgentEditIdRef.current = target.eventId
      })
      .finally(() => {
        if (agentNavigationTokenRef.current === token) agentNavigationPendingRef.current = false
      })
  }, [loadWorkspaceFile, showDock])

  const cancelAgentNavigation = useCallback((restoreOrigin: boolean) => {
    if (!agentNavigationPendingRef.current) return
    const origin = agentNavigationOriginRef.current
    agentNavigationTokenRef.current += 1
    agentNavigationPendingRef.current = false
    workspaceRequest.current += 1
    fileRequest.current += 1
    setWorkspaceLoading(false)
    setFileLoading(false)
    const currentWorkspace = workspaceRef.current
    if (restoreOrigin && origin && currentWorkspace && origin !== selectedFileRef.current) {
      void loadWorkspaceFile(currentWorkspace.path, origin)
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
      if (initialSession) {
        setActiveSessionId(initialSession.id)
        try {
          const events = await getSessionRuntimeEvents(initialSession.id)
          setRuntimeEvents((current) => replaceSessionEvents(current, initialSession.id, events))
        } catch (error) {
          setAppError(`Session trace could not be loaded: ${errorMessage(error)}`)
        }
      }
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
    setGitError(null)
    setGitOutput('')
  }, [workspace?.path])

  useEffect(() => {
    if (!workspace?.path) {
      gitHistoryRequest.current += 1
      gitHistoryPathRef.current = ''
      setGitHistory([])
      setGitHistoryLoading(false)
      setGitHistoryError(null)
      return
    }
    void loadGitHistory(workspace.path)
  }, [loadGitHistory, workspace?.path])

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
    const latestSteeringBoundary = activeEvents
      .filter((event) => event.runId === activeRunId && event.type === 'run.steered' && (!event.payload.agentId || event.payload.agentId === 'root'))
      .reduce((latest, event) => Math.max(latest, event.sequence), -1)
    const deltas = activeEvents
      .filter((event) => event.runId === activeRunId && event.type === 'model.delta' && event.sequence > latestSteeringBoundary && (!event.payload.agentId || event.payload.agentId === 'root'))
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
      model: selectedProvider?.model || 'Provider default', state: runState === 'running' ? 'working' : 'idle', progress: 0,
      task: runState === 'running' ? currentExecutionSummary(activeEvents, activeRunId) : 'Ready for the next task', color: 'cyan',
    }
    return deriveRuntimeAgents(activeEvents, root)
  }, [activeEvents, activeRunId, activeSession.id, desktop, runState, selectedProvider, sessionAgents])

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
    if (activeRunRef.current || editorSaving || gitOperation || !workspace || nextBranch === branch) return false
    if (!confirmDiscardEditorChanges('switching branches')) return false
    const operation = workspaceRequest.current
    const workspacePath = workspace.path
    const previousBranch = branch
    setBranch(nextBranch)
    setBranchBusy(true)
    setGitOperation('switch')
    setWorkspaceError(null)
    let switched: Awaited<ReturnType<typeof switchGitBranch>>
    try {
      switched = await switchGitBranch(workspacePath, nextBranch)
    } catch (error) {
      if (operation !== workspaceRequest.current) return false
      setBranch(previousBranch)
      setWorkspaceError(errorMessage(error))
      setBranchBusy(false)
      setGitOperation(null)
      return false
    }

    const switchedBranch = switched.snapshot?.branch ?? nextBranch
    setBranch(switchedBranch)
    const operationOutput = switched.output.trim() || `Switched to ${switchedBranch}`
    setGitOutput(switched.refreshError ? `${operationOutput}\n\nStatus refresh pending: ${switched.refreshError}` : operationOutput)
    await Promise.all([
      loadWorkspace(workspacePath, selectedFile),
      loadGitHistory(workspacePath),
    ])
    if (desktop && activeSession.id !== 'loading' && !activeSession.archived) {
      try {
        await updateNativeSessionScope(activeSession.id, switchedBranch, workspacePath)
        await reloadNativeState()
      } catch (error) {
        setAppError(`Branch switched, but the session scope could not be updated: ${errorMessage(error)}`)
      }
    }
    setBranchBusy(false)
    setGitOperation(null)
    return true
  }

  const refreshGit = async () => {
    if (!workspace || gitOperation || branchBusy || activeRunRef.current || runCancelPending) return false
    setGitOperation('refresh')
    setGitError(null)
    try {
      const [loaded] = await Promise.all([
        loadWorkspace(workspace.path, selectedFile),
        loadGitHistory(workspace.path),
      ])
      return Boolean(loaded)
    } catch (error) {
      setGitError(errorMessage(error))
      return false
    } finally {
      setGitOperation(null)
    }
  }

  const performGitOperation = async (
    name: Exclude<GitOperationName, 'refresh' | 'switch'>,
    operation: (path: string) => Promise<{ snapshot: GitSnapshot | null; output: string; refreshError: string | null }>,
  ) => {
    if (!workspace || gitOperation || branchBusy || activeRunRef.current || runCancelPending || editorSaving) return false
    const workspacePath = workspace.path
    setGitOperation(name)
    setGitError(null)
    try {
      const result = await operation(workspacePath)
      const operationOutput = result.output.trim() || `${name} completed`
      setGitOutput(result.refreshError ? `${operationOutput}\n\nStatus refresh pending: ${result.refreshError}` : operationOutput)
      const [loaded] = await Promise.all([
        loadWorkspace(workspacePath, selectedFile),
        loadGitHistory(workspacePath),
      ])
      if (loaded && loaded.snapshot.branch !== activeSession.branch && desktop && activeSession.id !== 'loading' && !activeSession.archived) {
        try {
          await updateNativeSessionScope(activeSession.id, loaded.snapshot.branch, workspacePath)
          await reloadNativeState()
        } catch (error) {
          setAppError(`Git ${name} completed, but the session scope could not be updated: ${errorMessage(error)}`)
        }
      }
      return true
    } catch (error) {
      setGitError(errorMessage(error))
      return false
    } finally {
      setGitOperation(null)
    }
  }

  const createBranch = async (name: string) => {
    if (!confirmDiscardEditorChanges('creating a branch')) return false
    return performGitOperation('create', (path) => createGitBranch(path, name))
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
    if (runCancelPending || editorSaving) return
    if (path === selectedFile) return
    if (!confirmDiscardEditorChanges('opening another file')) return
    cancelAgentNavigation(false)
    if (latestAgentEditRef.current) setFollowAgent(false)
    if (workspace) void loadWorkspaceFile(workspace.path, path)
  }

  const revertWorkspaceFile = () => {
    setEditorDraft(editorBaseline)
    setEditorError(null)
  }

  useEffect(() => {
    const target = latestAgentEditRef.current
    const currentWorkspace = workspaceRef.current
    if (editorDirty || !followAgentEdits || !target || !currentWorkspace || agentNavigationPendingRef.current || lastLoadedAgentEditIdRef.current === target.eventId) return
    navigateToAgentEdit(target, currentWorkspace.path)
  }, [editorDirty, followAgentEdits, navigateToAgentEdit, selectedFile])

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
    void getSessionRuntimeEvents(session.id)
      .then((events) => setRuntimeEvents((current) => replaceSessionEvents(current, session.id, events)))
      .catch((error) => setAppError(`Session trace could not be loaded: ${errorMessage(error)}`))
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

  const sendMessage = async (text: string, mode: ComposerSendMode = 'run'): Promise<boolean> => {
    const sessionId = activeSession.id
    if (desktop) {
      if (activeSession.archived) {
        setAppError('Restore this archived session before starting another run.')
        return false
      }
      if (activeRunRef.current) {
        if (mode === 'steer') {
          const runId = activeRunRef.current
          try {
            const message = await steerNativeRun(runId, text)
            if (message) {
              setSessionMessages((current) => ({
                ...current,
                [message.sessionId ?? sessionId]: [...(current[message.sessionId ?? sessionId] ?? []), message],
              }))
              setComposerNotices((current) => ({ ...current, [sessionId]: 'Guidance queued for the active run' }))
              return true
            }
          } catch (error) {
            setAppError(errorMessage(error))
            return false
          }
          updateQueuedPrompts((current) => [...current, { id: crypto.randomUUID(), sessionId, text }])
          setComposerNotices((current) => ({
            ...current,
            [sessionId]: 'The active run could not accept guidance. Added to the queue as the next turn.',
          }))
          return true
        }
        updateQueuedPrompts((current) => [...current, { id: crypto.randomUUID(), sessionId, text }])
        setComposerNotices((current) => ({ ...current, [sessionId]: 'Added to the queue for the next turn' }))
        return true
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
      setComposerNotices((current) => ({ ...current, [sessionId]: '' }))
      const runId = crypto.randomUUID()
      cancelAgentNavigation(false)
      setFollowAgent(true)
      handledFileEventIdsRef.current.clear()
      lastLoadedAgentEditIdRef.current = ''
      latestAgentEditRef.current = null
      setLatestAgentEdit(null)
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
            setRuntimeEvents((current) => [event, ...current.filter((item) => item.id !== event.id)].slice(0, MAX_RENDERER_EVENTS))
            if (event.type === 'run.steered' && (!event.payload.agentId || event.payload.agentId === 'root')) {
              setComposerNotices((current) => ({ ...current, [sessionId]: 'Guidance applied at the next turn boundary' }))
            }
            if (event.type === 'file.changed') {
              const target = agentEditTarget(event)
              if (!target) return
              if (handledFileEventIdsRef.current.has(target.eventId)) return
              handledFileEventIdsRef.current.add(target.eventId)
              latestAgentEditRef.current = target
              setLatestAgentEdit(target)
              if (!followAgentEditsRef.current) return
              showDock('code')
              if (editorDirtyRef.current) return
              navigateToAgentEdit(target, workspace.path)
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
          await reloadNativeState().catch((error) => setAppError(errorMessage(error)))
          setComposerNotices((current) => ({ ...current, [sessionId]: '' }))
          const latestTarget = latestAgentEditRef.current
          const finalFile = followAgentEditsRef.current && !editorDirtyRef.current && latestTarget ? latestTarget.path : selectedFileRef.current
          await loadWorkspace(workspace.path, finalFile).catch(() => undefined)
          if (activeRunRef.current === runId) {
            const wasCancelled = cancelledRunIdsRef.current.delete(runId)
            const nextPrompt = wasCancelled ? undefined : queuedPromptsRef.current.find((prompt) => prompt.sessionId === sessionId)
            activeRunRef.current = null
            setActiveRunId(null)
            setRunCancelPending(false)
            if (nextPrompt) {
              updateQueuedPrompts((current) => current.filter((prompt) => prompt.id !== nextPrompt.id))
              void sendMessage(nextPrompt.text).then((accepted) => {
                if (!accepted) {
                  updateQueuedPrompts((current) => [nextPrompt, ...current])
                  setRunState('idle')
                }
              })
            } else {
              setRunState('idle')
            }
          } else {
            setRunCancelPending(false)
          }
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

  const runQueuedPrompt = async (prompt: QueuedPrompt) => {
    updateQueuedPrompts((current) => current.filter((item) => item.id !== prompt.id))
    if (!await sendMessage(prompt.text)) {
      updateQueuedPrompts((current) => [prompt, ...current])
    }
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
      cancelledRunIdsRef.current.add(runId)
      setRunCancelPending(true)
      setAppError(null)
      const outcome = await requestRunCancellation(runId)
      if (outcome.status === 'requested') return
      setRunCancelPending(false)
      setAppError(outcome.message)
      if (outcome.status === 'missing') {
        cancelledRunIdsRef.current.delete(runId)
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
      setActiveRail(selectedRailComponent(nextDockModel, true))
      persistDockModel(nextDockModel)
    }
    setPreferences(nextPreferences)
    localStorage.setItem('traceframe.providers', JSON.stringify(next.map(({ id, name, endpoint, model: providerModel, adapter }) => ({ id, name, endpoint, model: providerModel, adapter, connected: false, latency: 0 }))))
  }

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const changeFollowAgent = useCallback((enabled: boolean) => {
    setFollowAgent(enabled)
    if (!enabled) {
      cancelAgentNavigation(true)
      return
    }
    const target = latestAgentEditRef.current
    const currentWorkspace = workspaceRef.current
    if (!target || !currentWorkspace || editorDirtyRef.current) return
    navigateToAgentEdit(target, currentWorkspace.path)
  }, [cancelAgentNavigation, navigateToAgentEdit, setFollowAgent])

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
    if (component === 'source') {
      return <GitPanel
        workspace={workspace}
        history={gitHistory}
        historyLoading={gitHistoryLoading}
        historyError={gitHistoryError}
        busy={Boolean(gitOperation) || branchBusy}
        operation={gitOperation}
        error={gitError}
        output={gitOutput}
        disabled={runState === 'running' || runCancelPending || workspacePickerPending || workspaceLoading || editorSaving}
        onRefresh={refreshGit}
        onSwitchBranch={changeBranch}
        onCreateBranch={createBranch}
        onStageAll={() => performGitOperation('stage', stageAllGitChanges)}
        onUnstageAll={() => performGitOperation('unstage', unstageAllGitChanges)}
        onCommit={(message) => performGitOperation('commit', (path) => commitGitChanges(path, message))}
        onPull={() => performGitOperation('pull', pullGitBranch)}
        onPush={() => performGitOperation('push', pushGitBranch)}
        onOpenFile={(path) => { showDock('code'); selectWorkspaceFile(path) }}
      />
    }
    if (component === 'conversation') {
      return <ConversationPanel
        session={activeSession}
        messages={messages}
        liveMessage={liveMessage}
        agents={agents}
        disabled={Boolean(activeSession.archived)}
        runActive={runState === 'running'}
        queuedPrompts={queuedPrompts.filter((prompt) => prompt.sessionId === activeSession.id)}
        draftRequest={composerDraftRequest}
        notice={composerNotices[activeSession.id]}
        events={activeEvents}
        onOpenExecutionFile={(path) => { showDock('code'); selectWorkspaceFile(path) }}
        onSend={sendMessage}
        onRemoveQueued={removeQueuedPrompt}
        onRunQueued={runQueuedPrompt}
      />
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
        stagedDiff={workspaceStagedDiff}
        workingDiff={workspaceWorkingDiff}
        loading={workspacePickerPending || workspaceLoading}
        fileLoading={fileLoading}
        error={workspaceError}
        fileError={fileError}
        diffError={diffError}
        agentEdit={latestAgentEdit}
        followAgent={followAgentEdits}
        followBlocked={followAgentEdits && editorDirty}
        onSelectFile={selectWorkspaceFile}
        onRefresh={refreshWorkspace}
        onOpenWorkspace={() => void openWorkspace()}
        onFollowAgent={changeFollowAgent}
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
    if (component === 'preview') {
      return <PreviewPanel
        workspacePath={workspace?.path ?? null}
        disabled={!desktop || workspaceLoading || workspacePickerPending}
        onAddToConversation={(prompt) => {
          if (!activeSession.id || activeSession.archived) {
            setAppError('Restore an active session before adding preview context.')
            return
          }
          composerDraftSequence.current += 1
          setComposerDraftRequest({
            id: `preview-${Date.now()}-${composerDraftSequence.current}`,
            sessionId: activeSession.id,
            text: prompt,
          })
          showDock('conversation')
        }}
        onOpenTerminalCommand={(command) => {
          setTerminalCommandDraft(command)
          showDock('terminal')
        }}
      />
    }
    if (component === 'terminal') {
      return <TerminalPanel
        workspacePath={workspace?.path}
        commandDraft={terminalCommandDraft}
        onCommandDraftConsumed={(command) => {
          setTerminalCommandDraft((current) => terminalDraftAfterConsume(current, command))
        }}
      />
    }
    if (component === 'output') {
      return <section className="dock-content" aria-label="运行输出"><TerminalView runState={runState} workspace={workspace} branch={branch} events={activeEvents} /></section>
    }
    if (component === 'trace') {
      return <section className="dock-content" aria-label="运行轨迹"><ActivityView events={activeEvents} onOpenFile={(path) => { showDock('code'); selectWorkspaceFile(path) }} /></section>
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
        changeCount={workspace?.snapshot.files.length ?? 0}
        active={activeRail}
        onShowSessions={() => focusDockControl('sessions', '.session-filter input')}
        onShowDock={showDock}
      />
      <main className="dock-workspace">
        <Layout
          model={dockModel}
          factory={dockFactory}
          realtimeResize
          onModelChange={(nextModel) => {
            persistDockModel(nextModel)
            const selected = selectedRailComponent(nextModel)
            if (selected) setActiveRail(selected)
          }}
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
