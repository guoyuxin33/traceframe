import { FormEvent, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Archive,
  Bot,
  Boxes,
  Braces,
  GitBranch,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Command,
  Cpu,
  Database,
  File,
  FileCode2,
  Files,
  GitCompareArrows,
  GitFork,
  HardDrive,
  KeyRound,
  Layers3,
  ListTree,
  MemoryStick,
  MessageSquare,
  Network,
  PanelRight,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Split,
  SquareTerminal,
  TestTube2,
  X,
  Zap,
} from 'lucide-react'
import {
  codeLines,
  diffLines,
  initialAgents,
  initialMessages,
  initialProviders,
  initialSessions,
} from './data'
import type { Agent, Message, Provider, Session } from './types'
import {
  getCcSwitchStatus,
  getNativeCapabilities,
  isDesktopRuntime,
  type CcSwitchStatus,
  type NativeCapabilities,
} from './native'

type WorkspaceTab = 'code' | 'diff' | 'terminal' | 'activity'
type InspectorTab = 'context' | 'agents' | 'memory'
type SettingsSection = 'models' | 'appearance'

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

const IconButton = ({
  label,
  active,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  onClick?: () => void
  children: React.ReactNode
}) => (
  <button
    className={`icon-button${active ? ' is-active' : ''}`}
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    {children}
  </button>
)

function TopBar({
  branch,
  setBranch,
  model,
  setModel,
  runState,
  onRun,
  onSettings,
}: {
  branch: string
  setBranch: (value: string) => void
  model: string
  setModel: (value: string) => void
  runState: 'idle' | 'running'
  onRun: () => void
  onSettings: () => void
}) {
  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="brand-name">Traceframe</span>
        <span className="version">0.1</span>
      </div>

      <button className="project-switcher" type="button">
        <HardDrive size={16} />
        <span>acme / console</span>
        <ChevronDown size={14} />
      </button>

      <div className="topbar-spacer" />

      <label className="compact-select branch-select">
        <GitFork size={15} />
        <span className="sr-only">当前分支</span>
        <select value={branch} onChange={(event) => setBranch(event.target.value)}>
          <option value="feat/auth-v2">feat/auth-v2</option>
          <option value="main">main</option>
          <option value="perf/dashboard">perf/dashboard</option>
          <option value="fix/stripe-hook">fix/stripe-hook</option>
        </select>
      </label>

      <label className="compact-select model-select">
        <Cpu size={15} />
        <span className="sr-only">主智能体模型</span>
        <select value={model} onChange={(event) => setModel(event.target.value)}>
          <option value="Claude Sonnet 4.5">Claude Sonnet 4.5</option>
          <option value="GPT-5 Codex">GPT-5 Codex</option>
          <option value="Gemini 2.5 Pro">Gemini 2.5 Pro</option>
          <option value="Qwen3 Coder 30B">Qwen3 Coder 30B · local</option>
          <option value="CC Switch active route">CC Switch · active route</option>
        </select>
      </label>

      <button className={`run-button${runState === 'running' ? ' is-running' : ''}`} type="button" onClick={onRun}>
        {runState === 'running' ? <SquareTerminal size={15} /> : <Play size={15} fill="currentColor" />}
        <span>{runState === 'running' ? 'Running' : 'Run task'}</span>
        <kbd>⌘↵</kbd>
      </button>

      <IconButton label="模型与 API 设置" onClick={onSettings}>
        <Settings size={17} />
      </IconButton>
    </header>
  )
}

function AppRail({ inspectorTab, setInspectorTab }: { inspectorTab: InspectorTab; setInspectorTab: (tab: InspectorTab) => void }) {
  return (
    <nav className="app-rail" aria-label="主导航">
      <div className="rail-primary">
        <IconButton label="会话" active><MessageSquare size={18} /></IconButton>
        <IconButton label="代码文件"><Files size={18} /></IconButton>
        <IconButton label="搜索"><Search size={18} /></IconButton>
        <IconButton label="智能体拓扑" active={inspectorTab === 'agents'} onClick={() => setInspectorTab('agents')}><Network size={18} /></IconButton>
        <IconButton label="记忆库" active={inspectorTab === 'memory'} onClick={() => setInspectorTab('memory')}><Database size={18} /></IconButton>
      </div>
      <div className="rail-secondary">
        <IconButton label="归档"><Archive size={18} /></IconButton>
        <div className="user-avatar" aria-label="当前用户">GX</div>
      </div>
    </nav>
  )
}

function SessionsPanel({
  sessions,
  activeId,
  onSelect,
  onNew,
}: {
  sessions: Session[]
  activeId: string
  onSelect: (session: Session) => void
  onNew: () => void
}) {
  return (
    <aside className="sessions-panel">
      <div className="panel-title-row">
        <div>
          <h2>Sessions</h2>
          <span>{sessions.length} active threads</span>
        </div>
        <IconButton label="新建会话" onClick={onNew}><Plus size={17} /></IconButton>
      </div>

      <div className="session-filter">
        <Search size={15} />
        <input aria-label="搜索会话" placeholder="Search" />
        <kbd>⌘K</kbd>
      </div>

      <div className="session-group-label">
        <span>Today</span>
        <button type="button" aria-label="会话筛选"><Layers3 size={14} /></button>
      </div>

      <div className="session-list">
        {sessions.map((session) => (
          <button
            type="button"
            key={session.id}
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
      </div>

      <div className="sessions-footer">
        <div className="repo-state">
          <span className="repo-icon"><GitFork size={15} /></span>
          <span>
            <strong>4 branches</strong>
            <small>2 worktrees active</small>
          </span>
        </div>
        <ChevronRight size={15} />
      </div>
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

function ConversationPanel({ messages, onSend }: { messages: Message[]; onSend: (text: string) => void }) {
  const [draft, setDraft] = useState('')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!draft.trim()) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <section className="conversation-panel" aria-label="智能体对话">
      <div className="workspace-section-head">
        <div>
          <span className="eyebrow">Live thread</span>
          <h1>Auth flow rebuild</h1>
        </div>
        <div className="head-actions">
          <span className="live-indicator"><span /> 3 agents working</span>
          <IconButton label="对话面板选项"><PanelRight size={16} /></IconButton>
        </div>
      </div>

      <div className="message-stream" aria-live="polite">
        <div className="stream-date"><span />Today · 14:28<span /></div>
        {messages.map((message) => <MessageCard key={message.id} message={message} />)}
        <div className="agent-thinking">
          <span className="thinking-caret">›</span>
          <span>Forge is editing <code>route.ts</code></span>
          <span className="thinking-time">01:42</span>
        </div>
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event)
          }}
          rows={3}
          placeholder="Message orchestrator…"
          aria-label="发送给主智能体"
        />
        <div className="composer-footer">
          <div className="composer-tools">
            <button type="button"><Plus size={15} />Attach</button>
            <button type="button"><Command size={15} />Command</button>
            <span className="scope-label">scope: auth/*</span>
          </div>
          <button className="send-button" type="submit" aria-label="发送消息"><Send size={16} /></button>
        </div>
      </form>
    </section>
  )
}

const files = [
  { name: 'app', type: 'folder', depth: 0, open: true },
  { name: 'api', type: 'folder', depth: 1, open: true },
  { name: 'auth', type: 'folder', depth: 2, open: true },
  { name: 'refresh', type: 'folder', depth: 3, open: true },
  { name: 'route.ts', type: 'file', depth: 4, status: 'M' },
  { name: 'lib', type: 'folder', depth: 0, open: true },
  { name: 'auth', type: 'folder', depth: 1, open: true },
  { name: 'token.ts', type: 'file', depth: 2, status: 'M' },
  { name: 'client.ts', type: 'file', depth: 2, status: 'M' },
  { name: 'refresh.test.ts', type: 'file', depth: 2, status: 'A' },
  { name: 'middleware.ts', type: 'file', depth: 0 },
]

function FileTree({ selected, onSelect }: { selected: string; onSelect: (name: string) => void }) {
  return (
    <aside className="file-tree">
      <div className="file-tree-head">
        <span>Explorer</span>
        <span className="file-change-summary"><b>+86</b><i>−24</i></span>
      </div>
      <div className="tree-root"><ChevronDown size={13} />acme-console</div>
      <div className="file-list">
        {files.map((item, index) => (
          <button
            key={`${item.name}-${index}`}
            type="button"
            className={`file-row${selected === item.name && item.type === 'file' ? ' is-active' : ''}`}
            style={{ '--depth': item.depth } as React.CSSProperties}
            onClick={() => item.type === 'file' && onSelect(item.name)}
          >
            {item.type === 'folder' ? <ChevronDown size={12} /> : <span className="file-indent" />}
            {item.type === 'folder' ? <span className="folder-icon"><ChevronRight size={13} /></span> : <FileCode2 size={14} />}
            <span>{item.name}</span>
            {item.status ? <b className={`file-status status-${item.status.toLowerCase()}`}>{item.status}</b> : null}
          </button>
        ))}
      </div>
    </aside>
  )
}

function CodeView() {
  return (
    <div className="code-view" role="region" aria-label="代码编辑器">
      {codeLines.map(([number, line]) => (
        <div className={`code-line${['15', '16', '17', '18', '19', '20', '21'].includes(number) ? ' changed-line' : ''}`} key={number}>
          <span className="line-number">{number}</span>
          <code>{line || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function DiffView() {
  return (
    <div className="diff-view" role="region" aria-label="代码差异">
      <div className="diff-file-head">
        <span>src/auth/client.ts</span>
        <span><b>+7</b><i>−3</i></span>
      </div>
      {diffLines.map((line, index) => (
        <div className={`diff-line diff-${line.type}`} key={`${line.old}-${line.next}-${index}`}>
          <span className="diff-gutter">{line.old}</span>
          <span className="diff-gutter">{line.next}</span>
          <span className="diff-symbol">{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
          <code>{line.text || ' '}</code>
        </div>
      ))}
    </div>
  )
}

function TerminalView({ runState }: { runState: 'idle' | 'running' }) {
  return (
    <div className="terminal-view" role="log" aria-live="polite">
      <div><span className="prompt">trace@feat/auth-v2</span><span className="terminal-path"> ~/acme-console</span> pnpm test auth --runInBand</div>
      <div className="terminal-muted"> RUN  v2.1.8 /workspace/acme-console</div>
      <div className="terminal-pass"> ✓ src/auth/refresh.test.ts (8 tests) 418ms</div>
      <div className="terminal-pass"> ✓ src/lib/auth/token.test.ts (12 tests) 622ms</div>
      <div className="terminal-muted"> Test Files  2 passed (2)</div>
      <div className="terminal-muted"> Tests       20 passed (20)</div>
      {runState === 'running' ? <div className="terminal-active">› Running integration/auth-concurrency.test.ts…</div> : <div><span className="prompt">trace@feat/auth-v2</span><span className="cursor-block" /></div>}
    </div>
  )
}

function ActivityView({ agents }: { agents: Agent[] }) {
  return (
    <div className="activity-view">
      <div className="activity-scale"><span>14:28</span><span>14:29</span><span>14:30</span><span>14:31</span></div>
      {agents.slice(0, 4).map((agent, index) => (
        <div className="activity-lane" key={agent.id}>
          <span className="lane-name">{agent.name}</span>
          <div className="lane-track">
            <span className={`lane-bar tone-${agent.color}`} style={{ left: `${6 + index * 8}%`, width: `${agent.progress * 0.72}%` }}>
              {agent.task}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function CodeWorkspace({ agents, runState }: { agents: Agent[]; runState: 'idle' | 'running' }) {
  const [tab, setTab] = useState<WorkspaceTab>('diff')
  const [selectedFile, setSelectedFile] = useState('route.ts')

  const tabs: { id: WorkspaceTab; label: string; icon: React.ReactNode; count?: string }[] = [
    { id: 'code', label: 'Code', icon: <Code2 size={15} /> },
    { id: 'diff', label: 'Diff', icon: <GitCompareArrows size={15} />, count: '4' },
    { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={15} /> },
    { id: 'activity', label: 'Trace', icon: <Activity size={15} /> },
  ]

  return (
    <section className="code-workspace" aria-label="实时开发工作区">
      <div className="workspace-tabs" role="tablist" aria-label="开发视图">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'is-active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.icon}{item.label}{item.count ? <span>{item.count}</span> : null}
          </button>
        ))}
        <div className="workspace-tab-spacer" />
        <div className="change-stat"><span className="insertions">+86</span><span className="deletions">−24</span></div>
        <IconButton label="拆分编辑器"><Split size={16} /></IconButton>
      </div>

      <div className="editor-layout">
        <FileTree selected={selectedFile} onSelect={setSelectedFile} />
        <div className="editor-main">
          <div className="editor-breadcrumb">
            <span>acme-console</span><ChevronRight size={12} /><span>src</span><ChevronRight size={12} /><span>auth</span><ChevronRight size={12} /><strong>{selectedFile}</strong>
            <div className="editor-breadcrumb-spacer" />
          <span className="editing-agent"><span />Forge editing</span>
          </div>
          <div className="editor-content">
            {tab === 'code' ? <CodeView /> : null}
            {tab === 'diff' ? <DiffView /> : null}
            {tab === 'terminal' ? <TerminalView runState={runState} /> : null}
            {tab === 'activity' ? <ActivityView agents={agents} /> : null}
          </div>
        </div>
      </div>

      <div className="build-strip">
        <div className="build-step is-complete"><Check size={13} /><span>Plan</span></div>
        <span className="build-connector is-complete" />
        <div className="build-step is-complete"><Check size={13} /><span>Tests</span><b>20</b></div>
        <span className="build-connector is-active" />
        <div className="build-step is-active"><Braces size={13} /><span>Implement</span><b>3/4</b></div>
        <span className="build-connector" />
        <div className="build-step"><ShieldCheck size={13} /><span>Review</span></div>
        <span className="build-connector" />
        <div className="build-step"><GitCompareArrows size={13} /><span>Merge</span></div>
        <div className="elapsed-time"><Clock3 size={13} />03:18</div>
      </div>
    </section>
  )
}

function ContextPanel() {
  const contextSources = [
    { label: 'Current thread', meta: '12 messages', value: '18.4k', width: 71 },
    { label: 'Repository map', meta: '143 files', value: '9.2k', width: 48 },
    { label: 'Pinned decisions', meta: '8 entries', value: '4.8k', width: 32 },
    { label: 'Tool results', meta: '24 calls', value: '11.1k', width: 56 },
  ]
  return (
    <div className="inspector-scroll">
      <section className="context-summary">
        <div className="context-meter">
          <svg viewBox="0 0 88 88" aria-label="上下文使用 64%">
            <circle className="meter-track" cx="44" cy="44" r="36" />
            <circle className="meter-value" cx="44" cy="44" r="36" pathLength="100" strokeDasharray="64 100" />
          </svg>
          <div><strong>64%</strong><span>used</span></div>
        </div>
        <div className="context-numbers">
          <strong>82.4k <span>/ 128k</span></strong>
          <small>Context window</small>
          <button type="button">Compact now</button>
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><h3>Context sources</h3><span>43.5k</span></div>
        <div className="context-source-list">
          {contextSources.map((source) => (
            <div className="context-source" key={source.label}>
              <div><strong>{source.label}</strong><span>{source.value}</span></div>
              <div className="context-bar"><span style={{ width: `${source.width}%` }} /></div>
              <small>{source.meta}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <div className="inspector-heading"><h3>Compression policy</h3><button type="button">Edit</button></div>
        <div className="policy-stack">
          <div><span className="policy-icon"><Zap size={14} /></span><span><strong>Recent turns</strong><small>Keep verbatim · 30 min</small></span><b>32k</b></div>
          <div><span className="policy-icon"><Boxes size={14} /></span><span><strong>Tool output</strong><small>Summarize after 3 turns</small></span><b>12k</b></div>
          <div><span className="policy-icon"><MemoryStick size={14} /></span><span><strong>Long-term memory</strong><small>Retrieve on relevance</small></span><b>8k</b></div>
        </div>
      </section>

      <section className="compaction-event">
        <div><CircleDot size={14} /><strong>Last compaction</strong><time>14:24</time></div>
        <p>38.2k → 11.6k tokens · 9 decisions preserved</p>
      </section>
    </div>
  )
}

function AgentPanel({ agents }: { agents: Agent[] }) {
  return (
    <div className="inspector-scroll agent-panel">
      <div className="agent-overview">
        <div><strong>5</strong><span>agents</span></div>
        <div><strong>3</strong><span>working</span></div>
        <div><strong>2</strong><span>worktrees</span></div>
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
            <div className="agent-progress"><span style={{ width: `${agent.progress}%` }} /></div>
            <footer><span>{agent.model}</span><b>{agent.progress}%</b></footer>
          </div>
        ))}
      </div>

      <button className="add-agent-button" type="button"><Plus size={15} />Add specialist</button>
    </div>
  )
}

function MemoryPanel() {
  const memories = [
    { title: 'Auth architecture', detail: 'Refresh tokens remain server-only', type: 'Decision', time: '2m' },
    { title: 'Testing preference', detail: 'Use fake timers for rotation tests', type: 'Preference', time: '18m' },
    { title: 'Repository convention', detail: 'API routes return typed errors', type: 'Project', time: '2h' },
    { title: 'Migration constraint', detail: 'Support legacy cookie for 7 days', type: 'Constraint', time: '2m' },
  ]
  return (
    <div className="inspector-scroll memory-panel">
      <div className="memory-search"><Search size={15} /><input placeholder="Search memory" aria-label="搜索记忆" /></div>
      <div className="memory-scope">
        <button className="is-active" type="button">Session</button>
        <button type="button">Project</button>
        <button type="button">Global</button>
      </div>
      <div className="memory-list">
        {memories.map((memory) => (
          <article className="memory-item" key={memory.title}>
            <div><MemoryStick size={15} /><span>{memory.type}</span><time>{memory.time}</time></div>
            <h3>{memory.title}</h3>
            <p>{memory.detail}</p>
          </article>
        ))}
      </div>
      <button className="add-agent-button" type="button"><Plus size={15} />Save memory</button>
    </div>
  )
}

function Inspector({ tab, setTab, agents }: { tab: InspectorTab; setTab: (tab: InspectorTab) => void; agents: Agent[] }) {
  return (
    <aside className="inspector-panel">
      <div className="inspector-tabs" role="tablist" aria-label="运行信息">
        <button type="button" className={tab === 'context' ? 'is-active' : ''} onClick={() => setTab('context')}>Context</button>
        <button type="button" className={tab === 'agents' ? 'is-active' : ''} onClick={() => setTab('agents')}>Agents <span>5</span></button>
        <button type="button" className={tab === 'memory' ? 'is-active' : ''} onClick={() => setTab('memory')}>Memory</button>
      </div>
      {tab === 'context' ? <ContextPanel /> : null}
      {tab === 'agents' ? <AgentPanel agents={agents} /> : null}
      {tab === 'memory' ? <MemoryPanel /> : null}
    </aside>
  )
}

function ProviderSettings({
  open,
  providers,
  preferences,
  onClose,
  onSave,
  onPreferences,
}: {
  open: boolean
  providers: Provider[]
  preferences: UiPreferences
  onClose: () => void
  onSave: (providers: Provider[]) => void
  onPreferences: (preferences: UiPreferences) => void
}) {
  const [draft, setDraft] = useState(providers)
  const [testing, setTesting] = useState<string | null>(null)
  const [section, setSection] = useState<SettingsSection>('models')
  const [ccSwitch, setCcSwitch] = useState<CcSwitchStatus | null>(null)

  useEffect(() => setDraft(providers), [providers, open])
  useEffect(() => {
    if (!open) return
    if (isDesktopRuntime()) getCcSwitchStatus().then(setCcSwitch).catch(() => setCcSwitch(null))
  }, [open])

  const updateProvider = (id: string, patch: Partial<Provider>) => {
    setDraft((current) => current.map((provider) => provider.id === id ? { ...provider, ...patch } : provider))
  }

  const testProvider = (id: string) => {
    setTesting(id)
    window.setTimeout(() => {
      updateProvider(id, { connected: true, latency: Math.floor(120 + Math.random() * 180) })
      setTesting(null)
    }, 650)
  }

  const connectCcSwitch = () => {
    if (!ccSwitch) return
    const provider: Provider = {
      id: 'ccswitch',
      name: 'CC Switch',
      endpoint: `http://127.0.0.1:${ccSwitch.proxyPort}`,
      model: 'active route',
      connected: ccSwitch.proxyEnabled,
      latency: 0,
    }
    setDraft((current) => current.some((item) => item.id === provider.id)
      ? current.map((item) => item.id === provider.id ? provider : item)
      : [provider, ...current])
  }

  if (!open) return null

  return (
    <div className="settings-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header>
          <div><span className="eyebrow">Settings</span><h2 id="settings-title">{section === 'models' ? 'Models & API' : 'Appearance'}</h2></div>
          <IconButton label="关闭设置" onClick={onClose}><X size={18} /></IconButton>
        </header>

        <nav className="settings-nav" aria-label="设置分类">
          <button type="button" className={section === 'models' ? 'is-active' : ''} onClick={() => setSection('models')}><Cpu size={15} />Models</button>
          <button type="button" className={section === 'appearance' ? 'is-active' : ''} onClick={() => setSection('appearance')}><Layers3 size={15} />Appearance</button>
        </nav>

        <div className="settings-body">
          {section === 'models' ? (
            <>
              <div className="settings-note"><KeyRound size={16} /><p>密钥只保留在当前运行时，不写入项目或本地存储。这里持久化端点和默认模型。</p></div>
              <section className="ccswitch-section">
                <div className="ccswitch-head">
                  <div className="provider-glyph">CC</div>
                  <div>
                    <h3>CC Switch</h3>
                    <span>{ccSwitch ? `${ccSwitch.providers.length} providers · proxy ${ccSwitch.proxyEnabled ? 'online' : 'offline'}` : isDesktopRuntime() ? 'Detecting local runtime' : 'Available in desktop app'}</span>
                  </div>
                  <button type="button" onClick={connectCcSwitch} disabled={!ccSwitch?.databaseFound}>{draft.some((item) => item.id === 'ccswitch') ? 'Refresh' : 'Connect'}</button>
                </div>
                {ccSwitch?.providers.some((provider) => provider.isCurrent) ? (
                  <div className="ccswitch-routes">
                    {ccSwitch.providers.filter((provider) => provider.isCurrent).slice(0, 4).map((provider) => (
                      <span key={`${provider.appType}-${provider.id}`}><b>{provider.appType}</b>{provider.name}</span>
                    ))}
                  </div>
                ) : null}
                <p>只读本地路由与代理状态。凭据继续由 CC Switch 保管。</p>
              </section>
              {draft.map((provider) => (
                <section className="provider-row" key={provider.id}>
                  <div className="provider-title">
                    <div className="provider-glyph">{provider.name.slice(0, 1)}</div>
                    <div><h3>{provider.name}</h3><span className={provider.connected ? 'connected' : ''}>{provider.connected ? provider.latency ? `${provider.latency} ms` : 'Connected' : 'Offline'}</span></div>
                    <button type="button" onClick={() => testProvider(provider.id)} disabled={testing === provider.id}>{testing === provider.id ? 'Testing…' : 'Test'}</button>
                  </div>
                  <label><span>Endpoint</span><input value={provider.endpoint} onChange={(event) => updateProvider(provider.id, { endpoint: event.target.value })} /></label>
                  <label><span>Default model</span><input value={provider.model} onChange={(event) => updateProvider(provider.id, { model: event.target.value })} /></label>
                  {provider.id !== 'ccswitch' ? <label><span>API key</span><input type="password" placeholder="Not stored" autoComplete="off" /></label> : null}
                </section>
              ))}
            </>
          ) : (
            <div className="appearance-settings">
              <section>
                <div className="appearance-heading"><h3>Theme</h3><p>Changes chrome and editor contrast</p></div>
                <div className="theme-options">
                  {(['graphite', 'light', 'terminal'] as const).map((theme) => (
                    <button type="button" key={theme} className={preferences.theme === theme ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, theme })}>
                      <span className={`theme-swatch swatch-${theme}`}><i /><i /><i /></span>
                      <span>{theme === 'graphite' ? 'Graphite' : theme === 'light' ? 'Light' : 'Terminal'}</span>
                      {preferences.theme === theme ? <Check size={14} /> : null}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="appearance-heading"><h3>Density</h3><p>Controls rows, panel padding and message rhythm</p></div>
                <div className="segmented-setting">
                  <button type="button" className={preferences.density === 'compact' ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, density: 'compact' })}>Compact</button>
                  <button type="button" className={preferences.density === 'comfortable' ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, density: 'comfortable' })}>Comfortable</button>
                </div>
              </section>

              <section>
                <div className="appearance-heading"><h3>Workspace balance</h3><p>Sets the default conversation and code split</p></div>
                <div className="layout-options">
                  <button type="button" className={preferences.layout === 'balanced' ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, layout: 'balanced' })}><span><i /><i /></span>Balanced</button>
                  <button type="button" className={preferences.layout === 'code' ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, layout: 'code' })}><span className="layout-code"><i /><i /></span>Code focus</button>
                  <button type="button" className={preferences.layout === 'conversation' ? 'is-active' : ''} onClick={() => onPreferences({ ...preferences, layout: 'conversation' })}><span className="layout-chat"><i /><i /></span>Conversation</button>
                </div>
              </section>
            </div>
          )}
        </div>

        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
          <button className="primary-button" type="button" onClick={() => { onSave(draft); onClose() }}>Save settings</button>
        </footer>
      </aside>
    </div>
  )
}

function StatusBar({ branch, model, native }: { branch: string; model: string; native: NativeCapabilities | null }) {
  return (
    <footer className="statusbar">
      <span><GitFork size={12} />{branch}</span>
      <span><CircleDot size={12} />4 modified</span>
      <span><Check size={12} />20 tests</span>
      <span className="status-spacer" />
      <span>UTF-8</span>
      <span>TypeScript</span>
      <span><Cpu size={12} />{model}</span>
      <span className="status-connected"><span />{native ? `${native.platform} native` : 'UI preview'}</span>
    </footer>
  )
}

export default function App() {
  const [sessions, setSessions] = useState(initialSessions)
  const [activeSessionId, setActiveSessionId] = useState('s1')
  const [messages, setMessages] = useState(initialMessages)
  const [agents, setAgents] = useState(initialAgents)
  const [branch, setBranch] = useState('feat/auth-v2')
  const [model, setModel] = useState('Claude Sonnet 4.5')
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('context')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [runState, setRunState] = useState<'idle' | 'running'>('running')
  const [providers, setProviders] = useState<Provider[]>(() => {
    const stored = localStorage.getItem('traceframe.providers')
    if (!stored) return initialProviders
    try { return JSON.parse(stored) as Provider[] } catch { return initialProviders }
  })
  const [native, setNative] = useState<NativeCapabilities | null>(null)
  const [preferences, setPreferences] = useState<UiPreferences>(() => {
    const stored = localStorage.getItem('traceframe.appearance')
    if (!stored) return defaultUiPreferences
    try { return { ...defaultUiPreferences, ...JSON.parse(stored) as UiPreferences } } catch { return defaultUiPreferences }
  })

  useEffect(() => {
    document.documentElement.classList.toggle('tauri-desktop', isDesktopRuntime())
    if (isDesktopRuntime()) getNativeCapabilities().then(setNative).catch(() => setNative(null))
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
    document.documentElement.dataset.density = preferences.density
    document.documentElement.dataset.layout = preferences.layout
    localStorage.setItem('traceframe.appearance', JSON.stringify(preferences))
  }, [preferences])

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId), [sessions, activeSessionId])

  const selectSession = (session: Session) => {
    setActiveSessionId(session.id)
    setBranch(session.branch)
    setSessions((current) => current.map((item) => ({ ...item, unread: item.id === session.id ? undefined : item.unread })))
  }

  const createSession = () => {
    const id = `s${Date.now()}`
    const newSession: Session = { id, title: 'Untitled task', summary: 'New orchestration thread', time: 'NOW', branch: 'main' }
    setSessions((current) => [newSession, ...current])
    setActiveSessionId(id)
    setBranch('main')
  }

  const sendMessage = (text: string) => {
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setMessages((current) => [...current, { id: `m-${Date.now()}`, author: 'You', role: 'user', time: now, body: text, meta: `scope: ${activeSession?.branch ?? branch}` }])
    setRunState('running')
    setAgents((current) => current.map((agent) => agent.id === 'root' ? { ...agent, progress: Math.min(agent.progress + 4, 92) } : agent))
    window.setTimeout(() => {
      setMessages((current) => [...current, {
        id: `m-agent-${Date.now()}`,
        author: 'Orchestrator',
        role: 'agent',
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        body: '任务已进入执行轨迹。我会先定位受影响文件，再把实现、测试与审查分派到隔离 worktree；每一步都会同步到 Diff 和 Trace 视图。',
        meta: `${model} · orchestration started`,
      }])
    }, 500)
  }

  const saveProviders = (next: Provider[]) => {
    setProviders(next)
    localStorage.setItem('traceframe.providers', JSON.stringify(next.map(({ id, name, endpoint, model: providerModel, connected, latency }) => ({ id, name, endpoint, model: providerModel, connected, latency }))))
  }

  return (
    <div className="app-shell">
      <TopBar
        branch={branch}
        setBranch={setBranch}
        model={model}
        setModel={setModel}
        runState={runState}
        onRun={() => setRunState((current) => current === 'running' ? 'idle' : 'running')}
        onSettings={() => setSettingsOpen(true)}
      />
      <AppRail inspectorTab={inspectorTab} setInspectorTab={setInspectorTab} />
      <SessionsPanel sessions={sessions} activeId={activeSessionId} onSelect={selectSession} onNew={createSession} />
      <main className="main-workspace">
        <ConversationPanel messages={messages} onSend={sendMessage} />
        <CodeWorkspace agents={agents} runState={runState} />
      </main>
      <Inspector tab={inspectorTab} setTab={setInspectorTab} agents={agents} />
      <StatusBar branch={branch} model={model} native={native} />
      <ProviderSettings
        open={settingsOpen}
        providers={providers}
        preferences={preferences}
        onClose={() => setSettingsOpen(false)}
        onSave={saveProviders}
        onPreferences={setPreferences}
      />
    </div>
  )
}
