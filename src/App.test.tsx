import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AppRail,
  AgentPanel,
  CodeView,
  ContextPanel,
  ConversationPanel,
  DiffView,
  FileTree,
  GitPanel,
  MarkdownBody,
  MemoryPanel,
  ProviderSettings,
  RepositoryDock,
  TerminalView,
  SessionsPanel,
  TopBar,
  DOCK_LAYOUT_SCHEMA_VERSION,
  DOCK_LAYOUT_STORAGE_KEY,
  activeSessionIdAfterArchive,
  agentEditTarget,
  currentExecutionSummary,
  dockLayoutJson,
  executionSteps,
  filePreviewNotice,
  firstActiveSessionId,
  isRetiredOpenAiModel,
  mergeSnapshotEvents,
  providerTestError,
  requestRunCancellation,
  requestWorkspaceSelection,
  runtimeAgentState,
  shouldFocusPromptShortcut,
  storedDockModel,
  terminalDraftAfterConsume,
  untrackedFileDiff,
  validateWorkspaceCandidate,
} from './App'
import type { Provider, Session } from './types'
import type { RuntimeEventRecord } from './types'

const sessions: Session[] = [
  { id: 'archived', title: 'Archived', summary: '', time: '', branch: 'main', archived: true },
  { id: 'first', title: 'First', summary: '', time: '', branch: 'main', unread: 1 },
  { id: 'preferred', title: 'Preferred', summary: '', time: '', branch: 'main', active: true },
]

const provider: Provider = {
  id: 'cc-switch',
  name: 'CC Switch',
  endpoint: 'http://127.0.0.1:15721/v1',
  model: 'gpt-current',
  adapter: 'cc-switch-responses',
  connected: false,
  latency: 0,
}

const workspace = {
  path: '/repo',
  name: 'repo',
  snapshot: { branch: 'main', ahead: 0, behind: 0, files: [] },
  branches: ['main'],
  tree: [{ path: 'src/App.tsx', name: 'App.tsx', kind: 'file' as const, depth: 1 }],
  treeTruncated: false,
}

const activeSession: Session = { id: 'first', title: 'First', summary: 'Active work', time: 'NOW', branch: 'main' }

function runtimeEvent(sequence: number, type: RuntimeEventRecord['type'], payload: Record<string, unknown> = {}): RuntimeEventRecord {
  return { id: `event-${sequence}`, sessionId: 'first', runId: 'run-1', sequence, type, payload, timestamp: 1_700_000_000_000 + sequence }
}

function legacyDockLayout(omitted: Set<string>) {
  const layout = structuredClone(dockLayoutJson('balanced'))
  const visit = (node: { children?: Array<{ component?: string; children?: unknown[] }> }) => {
    if (!node.children) return
    node.children = node.children.filter((child) => !child.component || !omitted.has(child.component))
    node.children.forEach((child) => visit(child as { children?: Array<{ component?: string; children?: unknown[] }> }))
  }
  visit(layout.layout as unknown as { children?: Array<{ component?: string; children?: unknown[] }> })
  return layout
}

describe('dock layout schema migration', () => {
  it('migrates v4 layouts in place and persists an explicit schema envelope', () => {
    const legacy = legacyDockLayout(new Set(['preview', 'terminal']))
    ;(legacy.layout as { children: Array<{ weight?: number }> }).children[0].weight = 31
    localStorage.setItem('traceframe.dock-layout.v4', JSON.stringify(legacy))

    const model = storedDockModel('code')
    const preview = model.getNodeById('preview')
    const terminal = model.getNodeById('terminal')
    expect(preview).toBeTruthy()
    expect(terminal).toBeTruthy()
    expect(preview?.getParent()).toBe(model.getNodeById('code')?.getParent())
    expect(terminal?.getParent()).toBe(model.getNodeById('output')?.getParent())
    expect((model.toJson().layout as { children: Array<{ weight?: number }> }).children[0].weight).toBe(31)

    const stored = JSON.parse(localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)!)
    expect(stored.schemaVersion).toBe(DOCK_LAYOUT_SCHEMA_VERSION)
    expect(JSON.stringify(stored.model)).toContain('"component":"preview"')
    expect(JSON.stringify(stored.model)).toContain('"component":"terminal"')
  })

  it('repairs stale same-key schemas and resets structurally incomplete layouts', () => {
    const stale = legacyDockLayout(new Set(['preview']))
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify({ schemaVersion: 4, model: stale }))
    expect(storedDockModel('balanced').getNodeById('preview')).toBeTruthy()

    localStorage.clear()
    const corrupt = legacyDockLayout(new Set(['conversation', 'preview', 'terminal']))
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify({ schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION, model: corrupt }))
    const reset = storedDockModel('conversation')
    expect(reset.getNodeById('conversation')).toBeTruthy()
    expect(reset.getNodeById('preview')).toBeTruthy()
    expect(reset.getNodeById('terminal')).toBeTruthy()
  })

  it('does not overwrite a layout written by a newer app schema', () => {
    const future = JSON.stringify({ schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION + 1, model: legacyDockLayout(new Set()) })
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, future)
    const fallback = storedDockModel('balanced')
    expect(fallback.getNodeById('preview')).toBeTruthy()
    expect(localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)).toBe(future)
  })
})

describe('session interaction state', () => {
  it('chooses the explicit active preview session and moves away after archiving it', () => {
    expect(firstActiveSessionId(sessions)).toBe('preferred')
    expect(activeSessionIdAfterArchive(sessions, 'preferred', sessions[2])).toBe('first')
    expect(activeSessionIdAfterArchive(sessions, 'first', sessions[2])).toBe('first')
  })

  it('does not consume the prompt shortcut for archived or running sessions', () => {
    expect(shouldFocusPromptShortcut({ archived: true }, false, false)).toBe(false)
    expect(shouldFocusPromptShortcut({ archived: false }, true, false)).toBe(false)
    expect(shouldFocusPromptShortcut({ archived: false }, false, true)).toBe(false)
    expect(shouldFocusPromptShortcut({ archived: false }, false, false)).toBe(true)
  })

  it('filters, selects, archives, creates, and opens the workspace through real controls', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onNew = vi.fn()
    const onArchive = vi.fn()
    const onOpenWorkspace = vi.fn()
    render(<SessionsPanel
      sessions={sessions}
      activeId="preferred"
      branchCount={2}
      changeCount={1}
      onSelect={onSelect}
      onNew={onNew}
      onArchive={onArchive}
      onOpenWorkspace={onOpenWorkspace}
      busy={false}
    />)

    await user.click(screen.getByRole('button', { name: /First/ }))
    expect(onSelect).toHaveBeenCalledWith(sessions[1])
    await user.click(screen.getByRole('button', { name: '归档当前会话' }))
    expect(onArchive).toHaveBeenCalledWith(sessions[2])
    await user.click(screen.getByRole('button', { name: '新建会话' }))
    expect(onNew).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: /2 branches/ }))
    expect(onOpenWorkspace).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: '只显示未读会话' }))
    expect(screen.getByRole('button', { name: '显示全部会话' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /Preferred/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '显示全部会话' }))

    await user.type(screen.getByRole('textbox', { name: '搜索会话' }), 'First')
    expect(screen.getByRole('button', { name: /First/ })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Preferred/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '显示已归档会话' }))
    expect(screen.getByRole('button', { name: '显示活跃会话' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('No matching sessions')).toBeVisible()
  })
})

describe('conversation controls', () => {
  it('scrolls to the latest message when switching between equal-length sessions', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const view = render(<ConversationPanel session={activeSession} messages={[]} agents={[]} disabled={false} onSend={vi.fn().mockResolvedValue(true)} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))

    view.rerender(<ConversationPanel session={{ ...activeSession, id: 'second' }} messages={[]} agents={[]} disabled={false} onSend={vi.fn().mockResolvedValue(true)} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
  })

  it('keeps drafts isolated per session and clears only after a successful send', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(true)
    const secondSession = { ...activeSession, id: 'second', title: 'Second' }
    const view = render(<ConversationPanel session={activeSession} messages={[]} agents={[]} disabled={false} onSend={onSend} />)
    const composer = screen.getByRole('textbox', { name: '发送给主智能体' })

    await user.type(composer, 'first draft')
    view.rerender(<ConversationPanel session={secondSession} messages={[]} agents={[]} disabled={false} onSend={onSend} />)
    expect(screen.getByRole('textbox', { name: '发送给主智能体' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: '发送给主智能体' }), 'second draft')

    view.rerender(<ConversationPanel session={activeSession} messages={[]} agents={[]} disabled={false} onSend={onSend} />)
    expect(screen.getByRole('textbox', { name: '发送给主智能体' })).toHaveValue('first draft')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('first draft', 'run'))
    expect(screen.getByRole('textbox', { name: '发送给主智能体' })).toHaveValue('')
  })

  it('adds selected preview context to the active draft without sending it', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const view = render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      draftRequest={{ id: 'selection-1', sessionId: activeSession.id, text: 'Update `button.save` in the preview' }}
      onSend={onSend}
    />)

    const composer = screen.getByRole('textbox', { name: '发送给主智能体' })
    await waitFor(() => expect(composer).toHaveValue('Update `button.save` in the preview'))
    expect(composer).toHaveFocus()
    expect(onSend).not.toHaveBeenCalled()

    view.rerender(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      draftRequest={{ id: 'selection-2', sessionId: activeSession.id, text: 'Keep the existing hover state' }}
      onSend={onSend}
    />)
    await waitFor(() => expect(composer).toHaveValue('Update `button.save` in the preview\n\nKeep the existing hover state'))
  })

  it('keeps an unsuccessful draft and disables archived composers', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(false)
    const view = render(<ConversationPanel session={activeSession} messages={[]} agents={[]} disabled={false} onSend={onSend} />)
    await user.type(screen.getByRole('textbox', { name: '发送给主智能体' }), 'retry me')
    await user.click(screen.getByRole('button', { name: '发送消息' }))
    expect(screen.getByRole('textbox', { name: '发送给主智能体' })).toHaveValue('retry me')

    view.rerender(<ConversationPanel session={{ ...activeSession, archived: true }} messages={[]} agents={[]} disabled onSend={onSend} />)
    expect(screen.getByRole('textbox', { name: '发送给主智能体' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled()
  })

  it('sends with Enter and keeps Shift+Enter for a new line', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(true)
    render(<ConversationPanel session={activeSession} messages={[]} agents={[]} disabled={false} onSend={onSend} />)
    const composer = screen.getByRole('textbox', { name: '发送给主智能体' })

    await user.type(composer, 'first line{shift>}{enter}{/shift}second line')
    expect(composer).toHaveValue('first line\nsecond line')
    expect(onSend).not.toHaveBeenCalled()
    await user.type(composer, '{enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('first line\nsecond line', 'run'))
    expect(composer).toHaveValue('')
  })

  it('guides an active run by default and can explicitly queue the next turn', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn().mockResolvedValue(true)
    const onRemoveQueued = vi.fn()
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      runActive
      queuedPrompts={[
        { id: 'queued-1', sessionId: activeSession.id, text: 'Run the integration tests next' },
        { id: 'queued-2', sessionId: activeSession.id, text: 'Then summarize the failures' },
      ]}
      onSend={onSend}
      onRemoveQueued={onRemoveQueued}
    />)

    const composer = screen.getByRole('textbox', { name: '引导当前运行' })
    expect(composer).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Guide run' })).toHaveAttribute('aria-pressed', 'true')
    expect(composer).toHaveAttribute('placeholder', 'Guide the active run…')
    expect(screen.getByText('2 queued')).toBeVisible()
    await user.click(screen.getByRole('button', { name: '移除排队消息 1' }))
    expect(onRemoveQueued).toHaveBeenCalledWith('queued-1')
    await user.type(composer, 'Inspect the changed files{enter}')
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('Inspect the changed files', 'steer'))

    await user.click(screen.getByRole('button', { name: 'Queue next' }))
    expect(screen.getByRole('button', { name: 'Queue next' })).toHaveAttribute('aria-pressed', 'true')
    expect(composer).toHaveAttribute('placeholder', 'Queue the next turn…')
    expect(composer).toHaveAccessibleName('排队下一轮')
    await user.type(composer, 'Run the integration tests{enter}')
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith('Run the integration tests', 'queue'))
  })

  it('announces steering fallback without turning it into an error', () => {
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      runActive
      notice="The active run could not accept guidance. Added to the queue as the next turn."
      onSend={vi.fn().mockResolvedValue(true)}
    />)

    expect(screen.getByRole('status')).toHaveTextContent('Added to the queue as the next turn')
  })

  it('lets a stopped queue resume explicitly without duplicating the prompt', async () => {
    const user = userEvent.setup()
    const onRunQueued = vi.fn().mockResolvedValue(undefined)
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      queuedPrompts={[{ id: 'queued-1', sessionId: activeSession.id, text: 'Continue after review' }]}
      onSend={vi.fn().mockResolvedValue(true)}
      onRunQueued={onRunQueued}
    />)

    await user.click(screen.getByRole('button', { name: '运行下一条排队消息' }))
    expect(onRunQueued).toHaveBeenCalledWith(expect.objectContaining({ id: 'queued-1', text: 'Continue after review' }))
  })
})

describe('preview terminal command handoff', () => {
  it('clears only the command that Terminal actually consumed', () => {
    expect(terminalDraftAfterConsume('npm run dev', 'npm run dev')).toBe('')
    expect(terminalDraftAfterConsume('npm run build', 'npm run dev')).toBe('npm run build')
  })
})

describe('model response presentation', () => {
  it('renders GFM without mounting raw HTML', () => {
    const { container } = render(<MarkdownBody body={'# Result\n\n- one\n- two\n\n```ts\nconst value = 1\n```\n\n| File | State |\n| --- | --- |\n| App.tsx | changed |\n\n<script>alert(1)</script>'} />)

    expect(screen.getByRole('heading', { name: 'Result' })).toBeVisible()
    expect(screen.getByText('const value = 1')).toBeVisible()
    expect(screen.getByRole('table')).toBeVisible()
    expect(container.querySelector('script')).toBeNull()
  })

  it('shows streaming agent content as Markdown', () => {
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      liveMessage={{ id: 'live-run-1', author: 'Agent', role: 'agent', time: 'now', body: '**working**' }}
      agents={[]}
      disabled={false}
      onSend={vi.fn().mockResolvedValue(true)}
    />)

    expect(screen.getByText('working').tagName).toBe('STRONG')
  })
})

describe('execution evidence', () => {
  const events = [
    runtimeEvent(1, 'run.created', { provider: 'CC Switch', model: 'gpt-current' }),
    runtimeEvent(2, 'model.requested', { model: 'gpt-current', round: 1 }),
    runtimeEvent(3, 'tool.started', { item: { callId: 'call-1', name: 'run_command', arguments: '{"program":"npm","args":["test"]}' } }),
    runtimeEvent(4, 'file.changed', { callId: 'call-1', path: 'src/App.tsx', startLine: 10, endLine: 12 }),
    runtimeEvent(5, 'tool.completed', { item: { callId: 'call-1', name: 'run_command' }, durationMs: 45, output: '39 tests passed' }),
    runtimeEvent(6, 'model.completed', { model: 'gpt-current', round: 1, durationMs: 80 }),
    runtimeEvent(7, 'agent.started', { agentId: 'reviewer', name: 'Reviewer', task: 'Inspect the patch' }),
    runtimeEvent(8, 'agent.completed', { agentId: 'reviewer', name: 'Reviewer', status: 'completed', result: 'No blocking findings' }),
    runtimeEvent(9, 'run.completed', { rounds: 1 }),
  ] satisfies RuntimeEventRecord[]

  it('pairs tool, model, file, and agent lifecycle records', () => {
    const steps = executionSteps(events)
    const tool = steps.find((step) => step.id === 'call-1')
    const agent = steps.filter((step) => step.id === 'agent:reviewer')

    expect(tool).toMatchObject({ status: 'completed', output: '39 tests passed', durationMs: 45 })
    expect(tool?.files).toEqual([{ path: 'src/App.tsx', startLine: 10, endLine: 12 }])
    expect(agent).toHaveLength(1)
    expect(agent[0]).toMatchObject({ status: 'completed', summary: 'No blocking findings' })
  })

  it('describes the active command instead of a generic running label', () => {
    expect(currentExecutionSummary(events.slice(0, 3), 'run-1')).toBe('Run command · npm test')
  })

  it('renders collapsible arguments, results, and clickable file evidence in Conversation', async () => {
    const user = userEvent.setup()
    const onOpenExecutionFile = vi.fn()
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      events={events}
      onOpenExecutionFile={onOpenExecutionFile}
      onSend={vi.fn().mockResolvedValue(true)}
    />)

    const command = screen.getByRole('group', { name: /Run command: npm test/ })
    await user.click(command.querySelector('summary') as HTMLElement)
    expect(screen.getByText('39 tests passed')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /src\/App\.tsx/ }))
    expect(onOpenExecutionFile).toHaveBeenCalledWith('src/App.tsx')
  })

  it('expands and collapses every execution step from the timeline controls', async () => {
    const user = userEvent.setup()
    render(<ConversationPanel
      session={activeSession}
      messages={[]}
      agents={[]}
      disabled={false}
      events={events}
      onSend={vi.fn().mockResolvedValue(true)}
    />)

    const disclosures = screen.getAllByRole('group').filter((element) => element.classList.contains('execution-step'))
    expect(disclosures).toHaveLength(executionSteps(events).length)
    expect(disclosures.every((element) => !element.hasAttribute('open'))).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Expand all execution steps' }))
    expect(disclosures.every((element) => element.hasAttribute('open'))).toBe(true)
    expect(screen.getByText('#3')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Collapse all execution steps' }))
    expect(disclosures.every((element) => !element.hasAttribute('open'))).toBe(true)
  })

  it('auto-collapses a completed step unless the user changed its disclosure', async () => {
    const baseProps = { session: activeSession, messages: [], agents: [], disabled: false, onSend: vi.fn().mockResolvedValue(true) }
    const { rerender } = render(<ConversationPanel {...baseProps} events={events.slice(0, 3)} />)
    const command = screen.getByRole('group', { name: /Run command: npm test/ })
    expect(command).toHaveAttribute('open')

    rerender(<ConversationPanel {...baseProps} events={events.slice(0, 6)} />)
    await waitFor(() => expect(command).not.toHaveAttribute('open'))
  })

  it('keeps active tools active when an earlier run in the session completed', () => {
    const oldRun = [
      { ...runtimeEvent(1, 'run.created'), runId: 'run-old' },
      { ...runtimeEvent(2, 'tool.started', { item: { callId: 'old-tool', name: 'run_command', arguments: '{"program":"npm","args":["run","old"]}' } }), runId: 'run-old' },
      { ...runtimeEvent(3, 'tool.completed', { item: { callId: 'old-tool', name: 'run_command' } }), runId: 'run-old' },
      { ...runtimeEvent(4, 'run.completed'), runId: 'run-old' },
    ] satisfies RuntimeEventRecord[]
    const activeRun = [
      { ...runtimeEvent(1, 'run.created'), runId: 'run-new', timestamp: 1_800_000_000_001 },
      { ...runtimeEvent(2, 'tool.started', { item: { callId: 'new-tool', name: 'run_command', arguments: '{"program":"npm","args":["run","new"]}' } }), runId: 'run-new', timestamp: 1_800_000_000_002 },
    ] satisfies RuntimeEventRecord[]

    render(<TerminalView runState="running" workspace={workspace} branch="main" events={[...oldRun, ...activeRun]} />)
    expect(screen.getByText(/npm run new/).closest('div')).toHaveClass('terminal-active')
    expect(screen.getByText(/npm run old/).closest('div')).toHaveClass('terminal-muted')
  })

  it('preserves live model deltas across a snapshot reload only while the run is active', () => {
    const delta = runtimeEvent(3, 'model.delta', { delta: 'partial reply' })
    const snapshot = [runtimeEvent(1, 'run.created')]

    expect(mergeSnapshotEvents(snapshot, [delta], 'first', true)).toContainEqual(delta)
    expect(mergeSnapshotEvents(snapshot, [delta], 'first', false)).not.toContainEqual(delta)
  })
})

describe('source control panel', () => {
  const gitWorkspace = {
    ...workspace,
    branches: ['main', 'review'],
    snapshot: {
      branch: 'main', ahead: 1, behind: 0,
      files: [
        { path: 'src/staged.ts', indexStatus: 'M', worktreeStatus: ' ' },
        { path: 'src/new.ts', indexStatus: '?', worktreeStatus: '?' },
      ],
    },
  }

  const gitProps = () => ({
    workspace: gitWorkspace,
    history: [{
      hash: '4e8798f9e0c5bdaf9e6b467d218389c0d07b4576',
      shortHash: '4e8798f',
      author: 'Traceframe Test',
      authoredAt: '2026-11-07T15:26:33+08:00',
      refs: ['HEAD -> main', 'origin/main'],
      subject: 'fix: recover interrupted agent runs',
    }],
    historyLoading: false,
    historyError: null,
    busy: false,
    operation: null,
    error: null,
    output: '',
    disabled: false,
    onRefresh: vi.fn().mockResolvedValue(true),
    onSwitchBranch: vi.fn().mockResolvedValue(true),
    onCreateBranch: vi.fn().mockResolvedValue(true),
    onStageAll: vi.fn().mockResolvedValue(true),
    onUnstageAll: vi.fn().mockResolvedValue(true),
    onCommit: vi.fn().mockResolvedValue(true),
    onPull: vi.fn().mockResolvedValue(true),
    onPush: vi.fn().mockResolvedValue(true),
    onOpenFile: vi.fn(),
  })

  it('wires branch, stage, commit, sync, refresh, and file controls', async () => {
    const user = userEvent.setup()
    const props = gitProps()
    render(<GitPanel {...props} />)

    await user.click(screen.getByText('Branches & remote'))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Switch branch' }), 'review')
    await user.type(screen.getByRole('textbox', { name: 'New branch name' }), 'feature/source')
    await user.click(screen.getByRole('button', { name: /Create/ }))
    await user.click(screen.getByRole('button', { name: /Stage all/ }))
    await user.click(screen.getByRole('button', { name: /Unstage all/ }))
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'feat: source controls')
    await user.click(screen.getByRole('button', { name: /Commit 1/ }))
    await user.click(screen.getByRole('button', { name: /Pull/ }))
    await user.click(screen.getByRole('button', { name: /Push/ }))
    await user.click(screen.getByRole('button', { name: 'Refresh Git status' }))
    await user.click(screen.getByRole('button', { name: /src\/new\.ts/ }))

    expect(props.onSwitchBranch).toHaveBeenCalledWith('review')
    expect(props.onCreateBranch).toHaveBeenCalledWith('feature/source')
    expect(props.onStageAll).toHaveBeenCalledTimes(1)
    expect(props.onUnstageAll).toHaveBeenCalledTimes(1)
    expect(props.onCommit).toHaveBeenCalledWith('feat: source controls')
    expect(props.onPull).toHaveBeenCalledTimes(1)
    expect(props.onPush).toHaveBeenCalledTimes(1)
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(props.onOpenFile).toHaveBeenCalledWith('src/new.ts')
  })

  it('opens source control from the activity rail and exposes the change count', async () => {
    const user = userEvent.setup()
    const onShowDock = vi.fn()
    render(<AppRail changeCount={16} active="source" onShowSessions={vi.fn()} onShowDock={onShowDock} />)

    await user.click(screen.getByRole('button', { name: '源代码管理，16 个更改' }))

    expect(onShowDock).toHaveBeenCalledWith('source')
    expect(screen.getByText('16')).toBeVisible()
    expect(screen.getByRole('button', { name: '源代码管理，16 个更改' })).toHaveClass('is-active')
    expect(screen.getByRole('button', { name: '源代码管理，16 个更改' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '会话' })).not.toHaveClass('is-active')
    expect(screen.getByRole('button', { name: '会话' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps changes, history, and branch controls in independent disclosures', () => {
    render(<GitPanel {...gitProps()} />)

    expect(screen.getByText('Changes').closest('details')).toHaveAttribute('open')
    expect(screen.getByText('History').closest('details')).not.toHaveAttribute('open')
    expect(screen.getByText('Branches & remote').closest('details')).not.toHaveAttribute('open')
  })

  it('shows expandable commit history with identity, refs, and timestamp', async () => {
    const user = userEvent.setup()
    render(<GitPanel {...gitProps()} />)

    await user.click(screen.getByText('History'))
    const commit = screen.getByText('fix: recover interrupted agent runs').closest('details')
    expect(commit).not.toHaveAttribute('open')
    await user.click(screen.getByText('fix: recover interrupted agent runs'))

    expect(commit).toHaveAttribute('open')
    expect(screen.getByText('Traceframe Test')).toBeVisible()
    expect(screen.getByText('origin/main')).toBeVisible()
    expect(screen.getByText('4e8798f9e0c5bdaf9e6b467d218389c0d07b4576')).toBeVisible()
  })

  it('locks every mutating Git control while an agent run owns the workspace', async () => {
    const user = userEvent.setup()
    render(<GitPanel {...gitProps()} disabled />)
    await user.click(screen.getByText('Branches & remote'))
    expect(screen.getByRole('combobox', { name: 'Switch branch' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Stage all/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Commit 1/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Push/ })).toBeDisabled()
  })

  it('shows a partially staged file in both source groups', () => {
    const mixedWorkspace = {
      ...gitWorkspace,
      snapshot: { ...gitWorkspace.snapshot, files: [{ path: 'src/mixed.ts', indexStatus: 'M', worktreeStatus: 'M' }] },
    }
    render(<GitPanel {...gitProps()} workspace={mixedWorkspace} />)

    expect(screen.getByText('Staged')).toBeVisible()
    expect(screen.getByText('Working tree')).toBeVisible()
    expect(screen.getAllByRole('button', { name: /src\/mixed\.ts/ })).toHaveLength(2)
  })

  it('clears commit and branch drafts when the repository changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<GitPanel {...gitProps()} />)
    await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'repo A commit')
    await user.type(screen.getByRole('textbox', { name: 'New branch name' }), 'repo-a-branch')

    rerender(<GitPanel {...gitProps()} workspace={{ ...gitWorkspace, path: '/tmp/other-repo', name: 'other-repo' }} />)
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Commit message' })).toHaveValue(''))
    expect(screen.getByRole('textbox', { name: 'New branch name' })).toHaveValue('')
  })

  it('separates staged and working-tree patches', async () => {
    const user = userEvent.setup()
    render(<DiffView
      path="src/mixed.ts"
      stagedDiff={'diff --git a/src/mixed.ts b/src/mixed.ts\n@@ -1 +1 @@\n-old staged\n+new staged'}
      workingDiff={'diff --git a/src/mixed.ts b/src/mixed.ts\n@@ -2 +2 @@\n-old working\n+new working'}
      loading={false}
      error={null}
    />)

    expect(screen.getByText('src/mixed.ts · working tree')).toBeVisible()
    expect(screen.getByText('new working')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Staged' }))
    expect(screen.getByText('src/mixed.ts · staged for commit')).toBeVisible()
    expect(screen.getByText('new staged')).toBeVisible()
  })
})

describe('run cancellation', () => {
  it('turns a missing native run into an explicit outcome', async () => {
    await expect(requestRunCancellation('run-1', vi.fn().mockResolvedValue(false))).resolves.toEqual({
      status: 'missing',
      message: 'The active run was no longer available to stop. Traceframe returned to idle.',
    })
  })

  it('shows a disabled pending stop action', () => {
    render(<TopBar
      workspace={null}
      branch="main"
      branches={[]}
      branchBusy={false}
      workspaceLoading={false}
      workspacePickerPending={false}
      onBranch={vi.fn()}
      onOpenWorkspace={vi.fn()}
      model="cc-switch"
      setModel={vi.fn()}
      providers={[provider]}
      runState="running"
      runCancelPending
      promptDisabled={false}
      onRun={vi.fn()}
      onSettings={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
  })

  it('connects every idle top bar control to its callback', async () => {
    const user = userEvent.setup()
    const onBranch = vi.fn()
    const onOpenWorkspace = vi.fn()
    const setModel = vi.fn()
    const onRun = vi.fn()
    const onSettings = vi.fn()
    const secondProvider = { ...provider, id: 'local', name: 'Local', model: 'local-model' }
    render(<TopBar
      workspace={{ ...workspace, branches: ['main', 'feature/test'] }}
      branch="main"
      branches={['main', 'feature/test']}
      branchBusy={false}
      workspaceLoading={false}
      workspacePickerPending={false}
      onBranch={onBranch}
      onOpenWorkspace={onOpenWorkspace}
      model="cc-switch"
      setModel={setModel}
      providers={[provider, secondProvider]}
      runState="idle"
      runCancelPending={false}
      promptDisabled={false}
      onRun={onRun}
      onSettings={onSettings}
    />)

    await user.click(screen.getByRole('button', { name: /repo/ }))
    await user.selectOptions(screen.getByRole('combobox', { name: '当前分支' }), 'feature/test')
    await user.selectOptions(screen.getByRole('combobox', { name: '主智能体模型' }), 'local')
    await user.click(screen.getByRole('button', { name: /Focus prompt/ }))
    await user.click(screen.getByRole('button', { name: '模型与 API 设置' }))

    expect(onOpenWorkspace).toHaveBeenCalledTimes(1)
    expect(onBranch).toHaveBeenCalledWith('feature/test')
    expect(setModel).toHaveBeenCalledWith('local')
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onSettings).toHaveBeenCalledTimes(1)
  })
})

describe('workspace picker guard', () => {
  it('allows only one picker while a selection is pending', async () => {
    const lock = { current: false }
    const pending: boolean[] = []
    let resolvePick: (value: string | null) => void = () => undefined
    const pick = vi.fn(() => new Promise<string | null>((resolve) => { resolvePick = resolve }))

    const first = requestWorkspaceSelection(lock, (value) => pending.push(value), pick)
    await expect(requestWorkspaceSelection(lock, (value) => pending.push(value), pick)).resolves.toEqual({ started: false })
    expect(pick).toHaveBeenCalledTimes(1)
    expect(lock.current).toBe(true)

    resolvePick('/repo')
    await expect(first).resolves.toEqual({ started: true, selected: '/repo' })
    expect(lock.current).toBe(false)
    expect(pending).toEqual([true, false])
  })

  it('unlocks after cancellation and errors', async () => {
    const lock = { current: false }
    const setPending = vi.fn()

    await expect(requestWorkspaceSelection(lock, setPending, vi.fn().mockResolvedValue(null))).resolves.toEqual({ started: true, selected: null })
    expect(lock.current).toBe(false)

    await expect(requestWorkspaceSelection(lock, setPending, vi.fn().mockRejectedValue(new Error('picker failed')))).rejects.toThrow('picker failed')
    expect(lock.current).toBe(false)
    expect(setPending.mock.calls).toEqual([[true], [false], [true], [false]])
  })

  it('shows a disabled pending workspace action', () => {
    render(<TopBar
      workspace={null}
      branch="main"
      branches={[]}
      branchBusy={false}
      workspaceLoading={false}
      workspacePickerPending
      onBranch={vi.fn()}
      onOpenWorkspace={vi.fn()}
      model="cc-switch"
      setModel={vi.fn()}
      providers={[provider]}
      runState="idle"
      runCancelPending={false}
      promptDisabled={false}
      onRun={vi.fn()}
      onSettings={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: 'Choosing workspace…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Choosing workspace…' })).toHaveAttribute('aria-busy', 'true')
  })

  it('rejects a non-repository candidate before switching away from the current workspace', async () => {
    const validate = vi.fn().mockRejectedValue(new Error('not a Git repository'))

    await expect(validateWorkspaceCandidate('/parent', '/repo', validate)).rejects.toThrow('not a Git repository')
    expect(validate).toHaveBeenCalledWith('/parent')
    await expect(validateWorkspaceCandidate(null, '/repo', validate)).resolves.toBeNull()
    await expect(validateWorkspaceCandidate('/repo', '/repo', validate)).resolves.toBe('/repo')
    expect(validate).toHaveBeenCalledTimes(1)
  })
})

describe('repository interaction lock', () => {
  it('disables file selection while a run owns the workspace', () => {
    render(<FileTree
      workspace={workspace}
      selected=""
      loading={false}
      disabled
      onSelect={vi.fn()}
      onRefresh={vi.fn()}
      onOpen={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: '刷新工作区' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /repo/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /App\.tsx/ })).toBeDisabled()
  })

  it('disables the workspace replacement CTA while interactions are busy', () => {
    render(<RepositoryDock
      mode="code"
      branchBusy={false}
      interactionBusy
      workspace={workspace}
      selectedFile=""
      file={null}
      stagedDiff=""
      workingDiff=""
      loading={false}
      fileLoading={false}
      error="Workspace unavailable"
      fileError={null}
      diffError={null}
      onSelectFile={vi.fn()}
      onRefresh={vi.fn()}
      onOpenWorkspace={vi.fn()}
      editor={{
        mode: 'view',
        draft: '',
        draftPath: '',
        dirty: false,
        saving: false,
        error: null,
        canEdit: false,
        onMode: vi.fn(),
        onDraft: vi.fn(),
        onSave: vi.fn(),
        onRevert: vi.fn(),
      }}
    />)

    expect(screen.getByRole('button', { name: 'Choose another folder' })).toBeDisabled()
  })

  it('keeps file navigation available while an agent run owns write actions', async () => {
    const user = userEvent.setup()
    const onSelectFile = vi.fn()
    render(<RepositoryDock
      mode="code"
      branchBusy={false}
      interactionBusy
      workspace={workspace}
      selectedFile=""
      file={null}
      stagedDiff=""
      workingDiff=""
      loading={false}
      fileLoading={false}
      error={null}
      fileError={null}
      diffError={null}
      onSelectFile={onSelectFile}
      onRefresh={vi.fn()}
      onOpenWorkspace={vi.fn()}
      editor={{
        mode: 'view', draft: '', draftPath: '', dirty: false, saving: false, error: null, canEdit: false,
        onMode: vi.fn(), onDraft: vi.fn(), onSave: vi.fn(), onRevert: vi.fn(),
      }}
    />)

    await user.click(screen.getByRole('button', { name: /App\.tsx/ }))
    expect(onSelectFile).toHaveBeenCalledWith('src/App.tsx')
    expect(screen.getByRole('button', { name: '刷新工作区' })).toBeDisabled()
  })

  it('refreshes, collapses, expands, and selects explorer entries', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const onRefresh = vi.fn()
    render(<FileTree
      workspace={{
        ...workspace,
        tree: [
          { path: 'src', name: 'src', kind: 'directory', depth: 0 },
          { path: 'src/App.tsx', name: 'App.tsx', kind: 'file', depth: 1 },
        ],
      }}
      selected=""
      loading={false}
      onSelect={onSelect}
      onRefresh={onRefresh}
      onOpen={vi.fn()}
    />)

    await user.click(screen.getByRole('button', { name: '刷新工作区' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'repo' }))
    expect(screen.queryByRole('button', { name: 'src' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'repo' }))
    await user.click(screen.getByRole('button', { name: 'src' }))
    expect(screen.queryByRole('button', { name: /App\.tsx/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'src' }))
    await user.click(screen.getByRole('button', { name: /App\.tsx/ }))
    expect(onSelect).toHaveBeenCalledWith('src/App.tsx')
  })
})

describe('context controls', () => {
  it('prevents duplicate compaction while pending and unlocks after completion', async () => {
    const user = userEvent.setup()
    let resolveCompact: () => void = () => undefined
    const onCompact = vi.fn(() => new Promise<void>((resolve) => { resolveCompact = resolve }))
    render(<ContextPanel
      session={activeSession}
      messages={[
        { id: 'one', author: 'You', role: 'user', time: 'now', body: 'one' },
        { id: 'two', author: 'Agent', role: 'agent', time: 'now', body: 'two' },
      ]}
      events={[]}
      memories={[]}
      onCompact={onCompact}
    />)

    const compact = screen.getByRole('button', { name: 'Compact now' })
    await user.click(compact)
    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Compacting…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Compacting…' }))
    expect(onCompact).toHaveBeenCalledTimes(1)

    await act(async () => resolveCompact())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Compact now' })).toBeEnabled())
  })
})

describe('agent controls', () => {
  it('keeps failed, cancelled, and idle states distinct from completion', () => {
    expect(runtimeAgentState('failed', 'agent.completed')).toBe('failed')
    expect(runtimeAgentState('cancelled', 'agent.completed')).toBe('cancelled')
    expect(runtimeAgentState('ready', 'agent.completed')).toBe('idle')
    expect(runtimeAgentState('completed', 'agent.completed')).toBe('done')
  })

  it('adds a configured specialist in preview mode', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(<AgentPanel agents={[]} onAdd={onAdd} />)

    await user.click(screen.getByRole('button', { name: 'Add specialist' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Probe')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'Test')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'gpt-6.1-sol')
    await user.click(screen.getByRole('button', { name: 'Add to session' }))

    expect(onAdd).toHaveBeenCalledWith({
      name: 'Probe',
      role: 'Test',
      model: 'gpt-6.1-sol',
      task: 'Waiting for a scoped task',
    })
    expect(screen.getByRole('button', { name: 'Add specialist' })).toBeVisible()
  })

  it('does not present a fake manual add action in runtime-orchestrated mode', () => {
    const onAdd = vi.fn()
    render(<AgentPanel agents={[]} onAdd={onAdd} orchestrated />)

    expect(screen.queryByRole('button', { name: 'Add specialist' })).not.toBeInTheDocument()
    expect(screen.getByText(/scout\/reviewer 只读，worker 可写入/)).toBeVisible()
    expect(onAdd).not.toHaveBeenCalled()
  })
})

describe('memory controls', () => {
  it('passes project scope and workspace identity through the save control', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(<MemoryPanel
      memories={[]}
      activeSessionId="first"
      workspacePath="/repo"
      onSave={onSave}
      onUpdate={vi.fn().mockResolvedValue(true)}
      onRemove={vi.fn().mockResolvedValue(undefined)}
    />)

    await user.click(screen.getByRole('button', { name: 'Project' }))
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Project rule')
    await user.type(screen.getByRole('textbox', { name: 'Detail' }), 'Keep this with the repository')
    await user.click(screen.getByRole('button', { name: 'Save to project' }))

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Project rule',
      scope: 'project',
      workspacePath: '/repo',
      sessionId: undefined,
    })))
    expect(screen.getByRole('button', { name: 'Save memory' })).toBeEnabled()
  })

  it('locks all memory mutations during an async delete and unlocks afterward', async () => {
    const user = userEvent.setup()
    let resolveRemove: () => void = () => undefined
    const onRemove = vi.fn(() => new Promise<void>((resolve) => { resolveRemove = resolve }))
    render(<MemoryPanel
      memories={[{ id: 'memory', title: 'Rule', detail: 'Detail', type: 'Decision', scope: 'session', time: 'now', sessionId: 'first' }]}
      activeSessionId="first"
      workspacePath="/repo"
      onSave={vi.fn().mockResolvedValue(true)}
      onUpdate={vi.fn().mockResolvedValue(true)}
      onRemove={onRemove}
    />)

    await user.click(screen.getByRole('button', { name: '删除记忆 Rule' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '编辑记忆 Rule' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save memory' })).toBeDisabled()

    await act(async () => resolveRemove())
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑记忆 Rule' })).toBeEnabled())
  })

  it('loads an existing memory into the form and submits its update', async () => {
    const user = userEvent.setup()
    const onUpdate = vi.fn().mockResolvedValue(true)
    render(<MemoryPanel
      memories={[{ id: 'memory', title: 'Rule', detail: 'Detail', type: 'Decision', scope: 'session', time: 'now', sessionId: 'first' }]}
      activeSessionId="first"
      workspacePath="/repo"
      onSave={vi.fn().mockResolvedValue(true)}
      onUpdate={onUpdate}
      onRemove={vi.fn().mockResolvedValue(undefined)}
    />)

    await user.click(screen.getByRole('button', { name: '编辑记忆 Rule' }))
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    await user.type(title, 'Updated rule')
    await user.click(screen.getByRole('button', { name: 'Update memory' }))

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith('memory', expect.objectContaining({
      title: 'Updated rule',
      scope: 'session',
      sessionId: 'first',
    })))
  })
})

describe('provider configuration', () => {
  it('clears only explicitly retired model IDs', () => {
    expect(isRetiredOpenAiModel('gpt-5')).toBe(true)
    expect(isRetiredOpenAiModel('gpt-5.6-sol')).toBe(false)
    expect(isRetiredOpenAiModel('gpt-5-codex')).toBe(true)
    expect(isRetiredOpenAiModel('gpt-6.1-sol')).toBe(false)
  })

  it('creates a blank custom endpoint and exposes the disabled Test reason', async () => {
    const user = userEvent.setup()
    render(<ProviderSettings
      open
      providers={[]}
      preferences={{ theme: 'graphite', density: 'compact', layout: 'balanced' }}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />)

    await user.click(screen.getByRole('button', { name: 'Add provider' }))
    const endpoint = screen.getByPlaceholderText('https://provider.example/v1')
    const test = screen.getByRole('button', { name: 'Test' })
    const guidance = screen.getByText('Enter an endpoint before testing this provider')

    expect(endpoint).toHaveValue('')
    expect(test).toBeDisabled()
    expect(test).toHaveAttribute('aria-describedby', guidance.id)
    expect(endpoint).toHaveAttribute('aria-describedby', guidance.id)

    await user.click(screen.getByRole('button', { name: '删除提供商 Custom provider' }))
    expect(screen.queryByPlaceholderText('https://provider.example/v1')).not.toBeInTheDocument()
  })

  it('requires a key before testing the official OpenAI endpoint', () => {
    expect(providerTestError({ ...provider, id: 'openai', endpoint: 'https://api.openai.com/v1', adapter: 'openai-responses' }))
      .toBe('Enter an OpenAI API key before testing api.openai.com')
  })

  it('saves appearance and dock reset choices through the settings footer', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onSave = vi.fn()
    render(<ProviderSettings
      open
      providers={[provider]}
      preferences={{ theme: 'graphite', density: 'compact', layout: 'balanced' }}
      onClose={onClose}
      onSave={onSave}
    />)

    await user.click(screen.getByRole('button', { name: 'Appearance' }))
    await user.click(screen.getByRole('button', { name: 'Light' }))
    await user.click(screen.getByRole('button', { name: 'Comfortable' }))
    await user.click(screen.getByRole('button', { name: 'Code focus' }))
    await user.click(screen.getByRole('button', { name: 'Reset layout to selected preset' }))
    await user.click(screen.getByRole('button', { name: 'Save settings' }))

    expect(onSave).toHaveBeenCalledWith(
      [provider],
      { theme: 'light', density: 'comfortable', layout: 'code' },
      true,
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('narrow editor toolbar', () => {
  it('keeps both file actions mounted', () => {
    render(<CodeView
      file={{ path: 'src/App.tsx', content: 'const value = 1', size: 15, truncated: false }}
      loading={false}
      error={null}
      mode="edit"
      draft="const value = 2"
      draftPath="src/App.tsx"
      dirty
      saving={false}
      saveError={null}
      canEdit
      onMode={vi.fn()}
      onDraft={vi.fn()}
      onSave={vi.fn()}
      onRevert={vi.fn()}
    />)

    expect(screen.getByRole('button', { name: /Revert/ })).toBeVisible()
    expect(screen.getByRole('button', { name: /Save/ })).toBeVisible()

    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toContain('@container (max-width: 420px)')
    expect(styles).toContain('.editor-actions { grid-column: 1 / -1; }')
    expect(styles).toContain('.editor-layout { grid-template-columns: 136px minmax(0, 1fr); }')
    expect(styles).toMatch(/\.code-view,[\s\S]*\.terminal-view \{[\s\S]*min-width: 0;/)
  })

  it('invokes edit, draft, revert, and save controls', async () => {
    const user = userEvent.setup()
    const onMode = vi.fn()
    const onDraft = vi.fn()
    const onSave = vi.fn()
    const onRevert = vi.fn()
    render(<CodeView
      file={{ path: 'src/App.tsx', content: 'a', size: 1, truncated: false }}
      loading={false}
      error={null}
      mode="edit"
      draft="b"
      draftPath="src/App.tsx"
      dirty
      saving={false}
      saveError={null}
      canEdit
      onMode={onMode}
      onDraft={onDraft}
      onSave={onSave}
      onRevert={onRevert}
    />)

    await user.click(screen.getByRole('button', { name: 'View' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: '编辑 src/App.tsx' }), 'c')
    await user.click(screen.getByRole('button', { name: /Revert/ }))
    await user.click(screen.getByRole('button', { name: /Save/ }))

    expect(onMode).toHaveBeenCalledWith('view')
    expect(onMode).toHaveBeenCalledWith('edit')
    expect(onDraft).toHaveBeenCalled()
    expect(onRevert).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('scrolls to each new agent edit and exposes a working follow control', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const onFollowAgent = vi.fn()
    const file = { path: 'src/App.tsx', content: 'one\ntwo\nthree', size: 13, truncated: false }
    const view = render(<CodeView
      file={file}
      loading={false}
      error={null}
      mode="view"
      draft={file.content}
      draftPath={file.path}
      dirty={false}
      saving={false}
      saveError={null}
      canEdit={false}
      agentEdit={{ path: file.path, startLine: 2, endLine: 2, eventId: 'change-1' }}
      followAgent
      followBlocked={false}
      onMode={vi.fn()}
      onDraft={vi.fn()}
      onSave={vi.fn()}
      onRevert={vi.fn()}
      onFollowAgent={onFollowAgent}
    />)

    await waitFor(() => expect(view.container.querySelector('[data-line="2"]')).toHaveClass('is-agent-edit'))
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    view.rerender(<CodeView
      file={file}
      loading={false}
      error={null}
      mode="view"
      draft={file.content}
      draftPath={file.path}
      dirty={false}
      saving={false}
      saveError={null}
      canEdit={false}
      agentEdit={{ path: file.path, startLine: 3, endLine: 3, eventId: 'change-2' }}
      followAgent
      followBlocked={false}
      onMode={vi.fn()}
      onDraft={vi.fn()}
      onSave={vi.fn()}
      onRevert={vi.fn()}
      onFollowAgent={onFollowAgent}
    />)
    await waitFor(() => expect(view.container.querySelector('[data-line="3"]')).toHaveClass('is-agent-edit'))
    expect(scrollIntoView).toHaveBeenCalledTimes(2)
    await userEvent.click(screen.getByRole('button', { name: /Following/ }))
    expect(onFollowAgent).toHaveBeenCalledWith(false)
  })

  it('moves the caret to an agent edit without selecting code that typing could replace', async () => {
    const commonProps = {
      file: { path: 'note.txt', content: 'alpha\nbeta\ngamma', size: 16, truncated: false },
      loading: false,
      error: null,
      mode: 'edit' as const,
      draftPath: 'note.txt',
      dirty: true,
      saving: false,
      saveError: null,
      canEdit: true,
      agentEdit: { path: 'note.txt', startLine: 2, endLine: 2, eventId: 'edit-1' },
      followAgent: true,
      followBlocked: true,
      onMode: vi.fn(),
      onDraft: vi.fn(),
      onSave: vi.fn(),
      onRevert: vi.fn(),
      onFollowAgent: vi.fn(),
    }
    const view = render(<CodeView
      {...commonProps}
      draft={'alpha\nlocal beta\ngamma'}
    />)

    const editor = screen.getByRole('textbox', { name: '编辑 note.txt' }) as HTMLTextAreaElement
    await waitFor(() => expect(editor.selectionStart).toBe(6))
    expect(editor.selectionEnd).toBe(6)
    expect(editor).toHaveValue('alpha\nlocal beta\ngamma')
    expect(screen.getByRole('button', { name: /Blocked/ })).toHaveAttribute('aria-pressed', 'true')

    view.rerender(<CodeView {...commonProps} draft={'alpha\nlocal beta!\ngamma'} />)
    editor.setSelectionRange(0, 0)
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    expect(editor.selectionStart).toBe(0)
    expect(editor.selectionEnd).toBe(0)
  })
})

describe('agent edit event validation', () => {
  const event = (payload: Record<string, unknown>) => ({
    id: 'event-1', sessionId: 'session-1', runId: 'run-1', sequence: 1,
    type: 'file.changed' as const, payload, timestamp: Date.now(),
  })

  it('uses a safe first-line fallback when older runtimes omit line metadata', () => {
    expect(agentEditTarget(event({ path: 'src/App.tsx' }))).toEqual({
      path: 'src/App.tsx', startLine: 1, endLine: 1, eventId: 'event-1',
    })
    expect(agentEditTarget(event({ path: ' notes.txt ' }))?.path).toBe(' notes.txt ')
  })

  it('rejects absolute and parent-traversal paths', () => {
    expect(agentEditTarget(event({ path: '../secret.txt', startLine: 4 }))).toBeNull()
    expect(agentEditTarget(event({ path: '/tmp/secret.txt', startLine: 4 }))).toBeNull()
    expect(agentEditTarget(event({ path: 'src\\secret.txt', startLine: 4 }))).toBeNull()
  })
})

describe('untracked diff', () => {
  it('renders a complete added-file patch from the bounded preview', () => {
    expect(untrackedFileDiff({ path: 'src/new.ts', content: 'one\ntwo', size: 7, truncated: false })).toContain([
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
    ].join('\n'))
    expect(untrackedFileDiff({ path: 'large.txt', content: 'partial', size: 100, truncated: true })).toBe('')
  })
})

describe('large file previews', () => {
  it('reports the loaded range and the limit that truncated the file', () => {
    const notice = filePreviewNotice({
      path: 'generated.log',
      content: 'partial',
      size: 2 * 1024 * 1024,
      truncated: true,
      previewBytes: 768 * 1024,
      previewLines: 12_000,
      truncationReason: 'lines',
    })

    expect(notice).toContain('Showing first 12,000 lines')
    expect(notice).toContain('768 KB of 2.0 MB')
    expect(notice).toContain('line safety limit')
  })

  it('distinguishes byte and combined limits and measures UTF-8 fallbacks accurately', () => {
    const byteLimited = filePreviewNotice({
      path: 'unicode.txt',
      content: '你\n好\n',
      size: 20,
      truncated: true,
      truncationReason: 'bytes',
    })
    expect(byteLimited).toContain('Showing first 2 lines')
    expect(byteLimited).toContain('8 B of 20 B')
    expect(byteLimited).toContain('size safety limit')

    expect(filePreviewNotice({
      path: 'combined.txt',
      content: 'partial',
      size: 3 * 1024 * 1024,
      truncated: true,
      previewBytes: 1024 * 1024,
      previewLines: 12_000,
      truncationReason: 'bytes-and-lines',
    })).toContain('line and size safety limits')
    expect(filePreviewNotice({ path: 'small.txt', content: 'complete', size: 8, truncated: false })).toBe('')
  })

  it('shows the current read-only preview when an unsaved draft becomes truncated', () => {
    render(<CodeView
      file={{
        path: 'generated.log',
        content: 'current disk preview\n',
        size: 2 * 1024 * 1024,
        truncated: true,
        previewBytes: 21,
        previewLines: 1,
        truncationReason: 'bytes',
      }}
      loading={false}
      error={null}
      mode="edit"
      draft="stale unsaved draft"
      draftPath="generated.log"
      dirty
      saving={false}
      saveError={null}
      canEdit={false}
      onMode={vi.fn()}
      onDraft={vi.fn()}
      onSave={vi.fn()}
      onRevert={vi.fn()}
    />)

    expect(screen.getByText('current disk preview')).toBeVisible()
    expect(screen.queryByText('stale unsaved draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: '编辑 generated.log' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled()
    expect(screen.getByText('Read only · unsaved draft retained')).toBeVisible()
    expect(screen.getByText('1 line')).toBeVisible()
    expect(screen.getByText('Viewing')).toBeVisible()
  })
})
