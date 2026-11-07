import { Channel, invoke } from '@tauri-apps/api/core'

export interface TerminalSessionInfo {
  id: string
  processId: number | null
  shell: string
  cwd: string
  cols: number
  rows: number
}

export type TerminalEvent =
  | { type: 'output'; sessionId: string; dataBase64: string }
  | { type: 'exit'; sessionId: string; code: number | null; detail: string }
  | { type: 'error'; sessionId: string; message: string }

export interface TerminalConnection {
  session: TerminalSessionInfo
  channel: Channel<TerminalEvent>
}

export function isTerminalDesktopRuntime() {
  return '__TAURI_INTERNALS__' in window
}

export function decodeTerminalOutput(dataBase64: string) {
  const binary = window.atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function startTerminal(
  workspacePath: string,
  cols: number,
  rows: number,
  onEvent: (event: TerminalEvent) => void,
): Promise<TerminalConnection> {
  const channel = new Channel<TerminalEvent>()
  channel.onmessage = onEvent
  const session = await invoke<TerminalSessionInfo>('terminal_start', {
    workspacePath,
    cols,
    rows,
    onEvent: channel,
  })
  return { session, channel }
}

export function writeTerminal(sessionId: string, data: string) {
  return invoke<void>('terminal_write', { sessionId, data })
}

export function resizeTerminal(sessionId: string, cols: number, rows: number) {
  return invoke<void>('terminal_resize', { sessionId, cols, rows })
}

export function closeTerminal(sessionId: string) {
  return invoke<boolean>('terminal_close', { sessionId })
}

export function killTerminal(sessionId: string) {
  return invoke<boolean>('terminal_kill', { sessionId })
}
