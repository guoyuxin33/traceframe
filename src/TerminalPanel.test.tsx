import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalPanel, terminalCommandDraft } from './TerminalPanel'
import {
  closeTerminal,
  decodeTerminalOutput,
  isTerminalDesktopRuntime,
  resizeTerminal,
  startTerminal,
  writeTerminal,
  type TerminalEvent,
} from './terminalNative'

const terminalHarness = vi.hoisted(() => ({
  input: undefined as ((data: string) => void) | undefined,
  instances: [] as Array<{
    cols: number
    rows: number
    write: ReturnType<typeof vi.fn>
  }>,
  resize: undefined as ResizeObserverCallback | undefined,
  onEvent: undefined as ((event: TerminalEvent) => void) | undefined,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon = vi.fn()
    open = vi.fn()
    reset = vi.fn()
    write = vi.fn()
    writeln = vi.fn()
    focus = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn((callback: (data: string) => void) => {
      terminalHarness.input = callback
      return { dispose: vi.fn() }
    })

    constructor() {
      terminalHarness.instances.push(this)
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('./terminalNative', () => ({
  closeTerminal: vi.fn().mockResolvedValue(true),
  decodeTerminalOutput: vi.fn(() => new Uint8Array()),
  isTerminalDesktopRuntime: vi.fn(),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  startTerminal: vi.fn(),
  writeTerminal: vi.fn().mockResolvedValue(undefined),
}))

const session = {
  id: 'terminal-test',
  processId: 123,
  shell: '/bin/zsh',
  cwd: '/workspace/project',
  cols: 80,
  rows: 24,
}

describe('TerminalPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    terminalHarness.input = undefined
    terminalHarness.instances.length = 0
    terminalHarness.resize = undefined
    terminalHarness.onEvent = undefined
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        terminalHarness.resize = callback
      }

      observe() {}
      disconnect() {}
      unobserve() {}
    })
    vi.mocked(closeTerminal).mockResolvedValue(true)
    vi.mocked(resizeTerminal).mockResolvedValue(undefined)
    vi.mocked(writeTerminal).mockResolvedValue(undefined)
    vi.mocked(startTerminal).mockImplementation(async (_workspace, _cols, _rows, onEvent) => {
      terminalHarness.onEvent = onEvent
      return {
        session,
        channel: {} as never,
      }
    })
  })

  it('shows a clear browser-only unavailable state', () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(false)
    render(<TerminalPanel workspacePath="/workspace/project" />)

    expect(screen.getByText('Desktop terminal unavailable')).toBeInTheDocument()
    expect(startTerminal).not.toHaveBeenCalled()
  })

  it('inserts a staged command without a newline only after explicit user action', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const consumed = vi.fn()
    const user = userEvent.setup()
    render(
      <TerminalPanel
        workspacePath="/workspace/project"
        pendingCommand={'npm run dev\n\u001b[31m'}
        onCommandDraftConsumed={consumed}
      />,
    )

    await screen.findByText('running')
    expect(writeTerminal).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Insert command' }))

    expect(writeTerminal).toHaveBeenCalledWith('terminal-test', 'npm run dev')
    expect(consumed).toHaveBeenCalledWith('npm run dev')
    expect(vi.mocked(writeTerminal).mock.calls[0][1]).not.toMatch(/[\r\n]/)
  })

  it('does not insert the same staged command twice while its write is pending', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    let finishWrite: (() => void) | undefined
    vi.mocked(writeTerminal).mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishWrite = resolve
    }))
    const consumed = vi.fn()
    const user = userEvent.setup()
    render(
      <TerminalPanel
        workspacePath="/workspace/project"
        pendingCommand="npm run dev"
        onCommandDraftConsumed={consumed}
      />,
    )
    await screen.findByText('running')

    await user.click(screen.getByRole('button', { name: 'Insert command' }))
    await user.click(screen.getByRole('button', { name: 'Insert command' }))

    expect(writeTerminal).toHaveBeenCalledTimes(1)
    expect(consumed).not.toHaveBeenCalled()
    finishWrite?.()
    await waitFor(() => expect(consumed).toHaveBeenCalledOnce())
  })

  it('restarts the single terminal from an accurately labelled toolbar action', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const user = userEvent.setup()
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    await user.click(screen.getByRole('button', { name: 'Restart terminal' }))

    await waitFor(() => expect(startTerminal).toHaveBeenCalledTimes(2))
    expect(closeTerminal).toHaveBeenCalledWith('terminal-test')
  })

  it('does not overlap replacement terminals while the current PTY is closing', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    let finishClose: (() => void) | undefined
    vi.mocked(closeTerminal).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishClose = () => resolve(true)
    }))
    const user = userEvent.setup()
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    await user.click(screen.getByRole('button', { name: 'Restart terminal' }))
    await user.click(screen.getByRole('button', { name: 'Restart terminal' }))

    expect(closeTerminal).toHaveBeenCalledTimes(1)
    expect(startTerminal).toHaveBeenCalledTimes(1)
    finishClose?.()
    await waitFor(() => expect(startTerminal).toHaveBeenCalledTimes(2))
  })

  it('starts the new workspace after an earlier terminal start finishes', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    let finishFirstStart: ((connection: Awaited<ReturnType<typeof startTerminal>>) => void) | undefined
    vi.mocked(startTerminal)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirstStart = resolve }))
      .mockImplementationOnce(async (_workspace, _cols, _rows, onEvent) => {
        terminalHarness.onEvent = onEvent
        return {
          session: { ...session, id: 'terminal-new', cwd: '/workspace/new' },
          channel: {} as never,
        }
      })
    const view = render(<TerminalPanel workspacePath="/workspace/old" />)
    await waitFor(() => expect(startTerminal).toHaveBeenCalledTimes(1))

    view.rerender(<TerminalPanel workspacePath="/workspace/new" />)
    finishFirstStart?.({
      session: { ...session, id: 'terminal-old', cwd: '/workspace/old' },
      channel: {} as never,
    })

    await waitFor(() => expect(startTerminal).toHaveBeenCalledTimes(2))
    expect(startTerminal).toHaveBeenLastCalledWith(
      '/workspace/new',
      expect.any(Number),
      expect.any(Number),
      expect.any(Function),
    )
    expect(closeTerminal).toHaveBeenCalledWith('terminal-old')
    await screen.findByText('running')
  })

  it('does not revive a terminal that exits before its start response arrives', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const onReady = vi.fn()
    vi.mocked(startTerminal).mockImplementationOnce(async (_workspace, _cols, _rows, onEvent) => {
      onEvent({
        type: 'exit',
        sessionId: session.id,
        code: 0,
        detail: 'exited before connection',
      })
      return { session, channel: {} as never }
    })

    render(<TerminalPanel workspacePath="/workspace/project" onReady={onReady} />)

    await screen.findByText('exited before connection')
    expect(onReady).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeDisabled()
  })

  it('forwards typed input and Enter to the active PTY without rewriting it', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    terminalHarness.input?.('printf ready')
    terminalHarness.input?.('\r')

    await waitFor(() => expect(writeTerminal).toHaveBeenCalledTimes(2))
    expect(vi.mocked(writeTerminal).mock.calls).toEqual([
      ['terminal-test', 'printf ready'],
      ['terminal-test', '\r'],
    ])
  })

  it('serializes terminal writes so Enter cannot overtake pending input', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    let finishFirstWrite: (() => void) | undefined
    vi.mocked(writeTerminal)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirstWrite = resolve }))
      .mockResolvedValue(undefined)
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    terminalHarness.input?.('echo ready')
    terminalHarness.input?.('\r')
    await waitFor(() => expect(writeTerminal).toHaveBeenCalledTimes(1))
    expect(writeTerminal).toHaveBeenLastCalledWith('terminal-test', 'echo ready')

    finishFirstWrite?.()
    await waitFor(() => expect(writeTerminal).toHaveBeenCalledTimes(2))
    expect(writeTerminal).toHaveBeenLastCalledWith('terminal-test', '\r')
  })

  it('streams decoded ANSI bytes to xterm without text conversion', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const ansi = new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe4, 0xb8, 0xad])
    vi.mocked(decodeTerminalOutput).mockReturnValueOnce(ansi)
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    terminalHarness.onEvent?.({
      type: 'output',
      sessionId: 'terminal-test',
      dataBase64: 'G1szMW3kuK0=',
    })

    expect(decodeTerminalOutput).toHaveBeenCalledWith('G1szMW3kuK0=')
    expect(terminalHarness.instances[0].write).toHaveBeenCalledWith(ansi)
  })

  it('resizes the native PTY after the fitted terminal changes size', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')
    vi.mocked(resizeTerminal).mockClear()

    const terminal = terminalHarness.instances[0]
    terminal.cols = 132
    terminal.rows = 43
    terminalHarness.resize?.([], {} as ResizeObserver)

    await waitFor(() => {
      expect(resizeTerminal).toHaveBeenCalledWith('terminal-test', 132, 43)
    })
  })

  it('closes the active PTY and exposes the stopped state', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const user = userEvent.setup()
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    await user.click(screen.getByRole('button', { name: 'Close terminal' }))

    expect(closeTerminal).toHaveBeenCalledWith('terminal-test')
    await screen.findAllByText('exited')
  })

  it('keeps the session available when native close fails', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    vi.mocked(closeTerminal).mockRejectedValueOnce(new Error('close failed'))
    const user = userEvent.setup()
    render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')

    await user.click(screen.getByRole('button', { name: 'Close terminal' }))

    await screen.findByText('close failed')
    expect(screen.getByRole('button', { name: 'Close terminal' })).toBeEnabled()
  })

  it('closes the active PTY when the terminal panel unmounts', async () => {
    vi.mocked(isTerminalDesktopRuntime).mockReturnValue(true)
    const view = render(<TerminalPanel workspacePath="/workspace/project" />)
    await screen.findByText('running')
    vi.mocked(closeTerminal).mockClear()

    view.unmount()

    await waitFor(() => expect(closeTerminal).toHaveBeenCalledWith('terminal-test'))
  })
})

describe('terminalCommandDraft', () => {
  it('removes every control character that could submit a command', () => {
    expect(terminalCommandDraft('  pnpm test\r\ngit status\u0000\u0007  ')).toBe('pnpm test git status')
  })
})
