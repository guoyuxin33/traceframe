import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AgentPanel,
  CodeView,
  ContextPanel,
  ConversationPanel,
  FileTree,
  MemoryPanel,
  ProviderSettings,
  RepositoryDock,
  SessionsPanel,
  TopBar,
  activeSessionIdAfterArchive,
  agentEditTarget,
  firstActiveSessionId,
  isRetiredOpenAiModel,
  providerTestError,
  requestRunCancellation,
  requestWorkspaceSelection,
  runtimeAgentState,
  shouldFocusPromptShortcut,
  untrackedFileDiff,
  validateWorkspaceCandidate,
} from './App'
import type { Provider, Session } from './types'

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
      diff=""
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
      diff=""
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
