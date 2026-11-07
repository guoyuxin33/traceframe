import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Eraser, LoaderCircle, RotateCcw, SquareTerminal, TextCursorInput, X } from 'lucide-react'
import {
  closeTerminal,
  decodeTerminalOutput,
  isTerminalDesktopRuntime,
  resizeTerminal,
  startTerminal,
  writeTerminal,
  type TerminalConnection,
  type TerminalEvent,
  type TerminalSessionInfo,
} from './terminalNative'
import './terminal.css'

type TerminalStatus = 'idle' | 'starting' | 'running' | 'exited' | 'error'

export interface TerminalPanelProps {
  workspacePath?: string
  className?: string
  commandDraft?: string
  pendingCommand?: string
  onCommandDraftConsumed?: (command: string) => void
  onReady?: (session: TerminalSessionInfo) => void
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function workspaceLabel(workspacePath: string) {
  const normalized = workspacePath.replace(/\\/g, '/').replace(/\/$/, '')
  return normalized.split('/').pop() || normalized
}

export function terminalCommandDraft(command: string) {
  return command
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

export function TerminalPanel({
  workspacePath = '',
  className = '',
  commandDraft,
  pendingCommand,
  onCommandDraftConsumed,
  onReady,
}: TerminalPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const connectionRef = useRef<TerminalConnection | null>(null)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const onReadyRef = useRef(onReady)
  const generationRef = useRef(0)
  const launchPendingRef = useRef(false)
  const queuedAutomaticLaunchRef = useRef(false)
  const launchLatestRef = useRef<() => void>(() => undefined)
  const insertPendingRef = useRef(false)
  const resizeFrameRef = useRef<number | null>(null)
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const [detail, setDetail] = useState('')
  const [session, setSession] = useState<TerminalSessionInfo | null>(null)
  const desktop = isTerminalDesktopRuntime()
  const stagedCommand = useMemo(
    () => terminalCommandDraft(pendingCommand ?? commandDraft ?? ''),
    [commandDraft, pendingCommand],
  )

  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  const scheduleFit = useCallback(() => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null
      const terminal = terminalRef.current
      const fit = fitRef.current
      if (!terminal || !fit) return
      fit.fit()
      const activeSession = connectionRef.current?.session
      if (activeSession) {
        void resizeTerminal(activeSession.id, terminal.cols, terminal.rows).catch(() => undefined)
      }
    })
  }, [])

  const stopCurrent = useCallback(async () => {
    const active = connectionRef.current
    connectionRef.current = null
    setSession(null)
    if (!active) return
    try {
      await closeTerminal(active.session.id)
    } catch (error) {
      if (!connectionRef.current) {
        connectionRef.current = active
        setSession(active.session)
      }
      throw error
    }
  }, [])

  const queueWrite = useCallback((sessionId: string, data: string) => {
    const write = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (connectionRef.current?.session.id !== sessionId) {
          throw new Error('Terminal session is no longer active')
        }
        await writeTerminal(sessionId, data)
      })
    writeQueueRef.current = write.catch(() => undefined)
    return write
  }, [])

  const launch = useCallback(async (queueWhenBusy = false) => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    if (!terminal || !fit || !desktop || !workspacePath) return
    if (launchPendingRef.current) {
      if (queueWhenBusy) queuedAutomaticLaunchRef.current = true
      return
    }
    launchPendingRef.current = true

    const previousGeneration = generationRef.current
    const generation = previousGeneration + 1
    generationRef.current = generation
    try {
      try {
        await stopCurrent()
      } catch (error) {
        if (generationRef.current === generation) {
          generationRef.current = previousGeneration
          setStatus('error')
          setDetail(errorMessage(error))
        }
        return
      }
      if (generationRef.current !== generation) return
      terminal.reset()
      fit.fit()
      setStatus('starting')
      setDetail('Starting shell')

      let terminalStopped = false
      const handleEvent = (event: TerminalEvent) => {
        if (generationRef.current !== generation) return
        if (event.type === 'output') {
          terminal.write(decodeTerminalOutput(event.dataBase64))
          return
        }
        if (event.type === 'error') {
          terminalStopped = true
          setStatus('error')
          setDetail(event.message)
          terminal.writeln(`\r\n\x1b[31m${event.message}\x1b[0m`)
          return
        }
        terminalStopped = true
        connectionRef.current = null
        setSession(null)
        setStatus(event.code === 0 ? 'exited' : 'error')
        setDetail(event.detail)
      }

      try {
        const connection = await startTerminal(
          workspacePath,
          Math.max(2, terminal.cols),
          Math.max(2, terminal.rows),
          handleEvent,
        )
        if (generationRef.current !== generation) {
          await closeTerminal(connection.session.id).catch(() => false)
          return
        }
        if (terminalStopped) return
        connectionRef.current = connection
        setSession(connection.session)
        setStatus('running')
        setDetail(connection.session.shell)
        onReadyRef.current?.(connection.session)
        terminal.focus()
      } catch (error) {
        if (generationRef.current !== generation) return
        const message = errorMessage(error)
        setStatus('error')
        setDetail(message)
        terminal.writeln(`\r\n\x1b[31mTerminal could not start: ${message}\x1b[0m`)
      }
    } finally {
      launchPendingRef.current = false
      if (queuedAutomaticLaunchRef.current) {
        queuedAutomaticLaunchRef.current = false
        launchLatestRef.current()
      }
    }
  }, [desktop, stopCurrent, workspacePath])
  launchLatestRef.current = () => void launch(true)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !desktop || !workspacePath) return

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: '#0a0c0d',
        foreground: '#c4cec9',
        cursor: '#62d9bb',
        cursorAccent: '#092a22',
        selectionBackground: '#2a594f99',
        black: '#0a0c0d',
        brightBlack: '#75807a',
        red: '#dd7379',
        brightRed: '#ef8e93',
        green: '#55c893',
        brightGreen: '#75d9aa',
        yellow: '#d3ad62',
        brightYellow: '#e2c27d',
        blue: '#6ca8d9',
        brightBlue: '#8abce4',
        magenta: '#c28bb8',
        brightMagenta: '#d5a5cb',
        cyan: '#62d9bb',
        brightCyan: '#83e5ca',
        white: '#c4cec9',
        brightWhite: '#edf1ef',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    terminalRef.current = terminal
    fitRef.current = fit
    scheduleFit()

    const input = terminal.onData((data) => {
      const activeSession = connectionRef.current?.session
      if (!activeSession) return
      void queueWrite(activeSession.id, data).catch((error) => {
        if (connectionRef.current?.session.id === activeSession.id) {
          setStatus('error')
          setDetail(errorMessage(error))
        }
      })
    })
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(scheduleFit)
    observer?.observe(host)
    window.addEventListener('resize', scheduleFit)
    void launch(true)

    return () => {
      generationRef.current += 1
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleFit)
      input.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
      void stopCurrent().catch(() => undefined)
    }
  }, [desktop, launch, queueWrite, scheduleFit, stopCurrent, workspacePath])

  const insertDraft = useCallback(async () => {
    const activeSession = connectionRef.current?.session
    if (!activeSession || !stagedCommand || insertPendingRef.current) return
    insertPendingRef.current = true
    try {
      await queueWrite(activeSession.id, stagedCommand)
      onCommandDraftConsumed?.(stagedCommand)
      terminalRef.current?.focus()
    } catch (error) {
      setStatus('error')
      setDetail(errorMessage(error))
    } finally {
      insertPendingRef.current = false
    }
  }, [onCommandDraftConsumed, queueWrite, stagedCommand])

  if (!desktop) {
    return (
      <section className={`terminal-panel terminal-panel--unavailable ${className}`.trim()} aria-label="Terminal">
        <SquareTerminal size={22} aria-hidden="true" />
        <strong>Desktop terminal unavailable</strong>
        <span>Open this workspace in the Traceframe desktop app.</span>
      </section>
    )
  }

  if (!workspacePath) {
    return (
      <section className={`terminal-panel terminal-panel--unavailable ${className}`.trim()} aria-label="Terminal">
        <SquareTerminal size={22} aria-hidden="true" />
        <strong>No workspace open</strong>
        <span>Select a workspace before starting a terminal.</span>
      </section>
    )
  }

  return (
    <section className={`terminal-panel ${className}`.trim()} aria-label="Terminal">
      <header className="terminal-toolbar">
        <div className="terminal-identity">
          <SquareTerminal size={14} aria-hidden="true" />
          <strong>{workspaceLabel(workspacePath)}</strong>
          <span className={`terminal-status terminal-status--${status}`} role="status">
            {status === 'starting' && <LoaderCircle size={11} aria-hidden="true" />}
            {status}
          </span>
        </div>
        <div className="terminal-actions">
          {stagedCommand && (
            <button
              type="button"
              className="terminal-draft-action"
              onClick={() => void insertDraft()}
              disabled={status !== 'running'}
              aria-label="Insert command"
              title="Insert the staged command without running it"
            >
              <TextCursorInput size={13} aria-hidden="true" />
              <span>Insert command</span>
            </button>
          )}
          <button type="button" onClick={() => void launch()} title="Restart terminal" aria-label="Restart terminal">
            <RotateCcw size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => terminalRef.current?.clear()}
            title="Clear terminal"
            aria-label="Clear terminal"
          >
            <Eraser size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => {
              const previousGeneration = generationRef.current
              const closingGeneration = previousGeneration + 1
              generationRef.current = closingGeneration
              void stopCurrent()
                .then(() => {
                  setStatus('exited')
                  setDetail('Terminal closed')
                })
                .catch((error) => {
                  if (generationRef.current === closingGeneration) {
                    generationRef.current = previousGeneration
                  }
                  setStatus('error')
                  setDetail(errorMessage(error))
                })
            }}
            disabled={!session}
            title="Close terminal"
            aria-label="Close terminal"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="terminal-host" ref={hostRef} />
      <footer className="terminal-footer" title={detail}>
        <span>{session ? `PID ${session.processId ?? 'n/a'}` : status}</span>
        <span>{detail}</span>
      </footer>
    </section>
  )
}

export default TerminalPanel
