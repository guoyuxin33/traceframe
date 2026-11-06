import { Channel, invoke } from '@tauri-apps/api/core'
import type { MemoryRecord, Message, Provider, RuntimeEventRecord, Session } from './types'

export interface NativeCapabilities {
  platform: string
  arch: string
  gitAvailable: boolean
  shell: string
}

export interface GitSnapshot {
  branch: string
  ahead: number
  behind: number
  files: Array<{
    path: string
    indexStatus: string
    worktreeStatus: string
  }>
}

export interface WorkspaceTreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory'
  depth: number
}

export interface WorkspaceTree {
  entries: WorkspaceTreeEntry[]
  truncated: boolean
}

export interface WorkspaceFile {
  path: string
  content: string
  size: number
  truncated: boolean
}

interface StoredSession {
  id: string
  title: string
  summary: string
  contextSummary: string
  compactedMessageCount: number
  branch: string
  workspacePath: string
  archived: boolean
  createdAt: number
  updatedAt: number
}

interface StoredMessage {
  id: string
  sessionId: string
  author: string
  role: Message['role']
  body: string
  meta: string
  createdAt: number
}

interface StoredMemory {
  id: string
  sessionId?: string
  workspacePath: string
  scope: MemoryRecord['scope']
  title: string
  detail: string
  kind: string
  createdAt: number
}

interface StoredEvent {
  id: string
  sessionId: string
  runId: string
  sequence: number
  eventType: string
  payload: Record<string, unknown>
  createdAt: number
}

interface StoredSnapshot {
  sessions: StoredSession[]
  messages: StoredMessage[]
  memories: StoredMemory[]
  events: StoredEvent[]
}

export interface AppSnapshot {
  sessions: Session[]
  messages: Message[]
  memories: MemoryRecord[]
  events: RuntimeEventRecord[]
}

export interface ProviderHealth {
  ok: boolean
  reachable: boolean
  authenticated?: boolean
  latency: number
  status?: number
  detail: string
  models: string[]
}

function displayTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}

function providerPayload(provider: Provider) {
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    endpoint: provider.endpoint,
    model: provider.model,
    apiKey: provider.apiKey ?? '',
  }
}

export function isDesktopRuntime() {
  return '__TAURI_INTERNALS__' in window
}

export async function getNativeCapabilities() {
  return invoke<NativeCapabilities>('native_capabilities')
}

export async function pickWorkspace() {
  return invoke<string | null>('pick_workspace')
}

export async function getRecentWorkspace() {
  return invoke<string | null>('recent_workspace')
}

export async function getGitSnapshot(path: string) {
  return invoke<GitSnapshot>('git_snapshot', { path })
}

export async function listGitBranches(path: string) {
  return invoke<string[]>('git_branches', { path })
}

export async function switchGitBranch(path: string, branch: string) {
  return invoke<GitSnapshot>('git_switch_branch', { path, branch })
}

export async function getGitDiff(path: string, staged = false, relativePath?: string) {
  return invoke<string>('git_diff', { path, staged, relativePath })
}

export async function getWorkspaceTree(path: string) {
  return invoke<WorkspaceTree>('workspace_tree', { path })
}

export async function readWorkspaceFile(path: string, relativePath: string) {
  return invoke<WorkspaceFile>('read_workspace_file', { path, relativePath })
}

export async function writeWorkspaceFile(path: string, relativePath: string, expectedOriginalContent: string, newContent: string) {
  return invoke<WorkspaceFile>('write_workspace_file', { path, relativePath, expectedOriginalContent, newContent })
}

export async function getAppSnapshot(): Promise<AppSnapshot> {
  const snapshot = await invoke<StoredSnapshot>('app_snapshot')
  return {
    sessions: snapshot.sessions.map((session) => ({ ...session, time: displayTime(session.updatedAt) })),
    messages: snapshot.messages.map((message) => ({ ...message, time: displayTime(message.createdAt) })),
    memories: snapshot.memories.map((memory) => ({
      ...memory,
      type: (memory.kind || 'Decision') as MemoryRecord['type'],
      time: displayTime(memory.createdAt),
    })),
    events: snapshot.events.map(({ eventType, createdAt, ...event }) => ({ ...event, type: eventType, timestamp: createdAt })),
  }
}

export async function createNativeSession(title: string, branch: string, workspacePath: string) {
  const session = await invoke<StoredSession>('create_session', { title, branch, workspacePath })
  return { ...session, time: displayTime(session.updatedAt) } satisfies Session
}

export async function archiveNativeSession(sessionId: string, archived = true) {
  return invoke<void>('archive_session', { sessionId, archived })
}

export async function updateNativeSessionScope(sessionId: string, branch: string, workspacePath: string) {
  return invoke<void>('update_session_scope', { sessionId, branch, workspacePath })
}

export async function appendNativeMessage(message: { sessionId: string; author: string; role: Message['role']; body: string; meta?: string }) {
  const stored = await invoke<StoredMessage>('append_message', { message })
  return { ...stored, time: displayTime(stored.createdAt) } satisfies Message
}

export async function saveNativeMemory(memory: Omit<MemoryRecord, 'id' | 'time' | 'createdAt'>) {
  const stored = await invoke<StoredMemory>('save_memory', {
    memory: {
      sessionId: memory.sessionId,
      workspacePath: memory.workspacePath ?? '',
      scope: memory.scope,
      title: memory.title,
      detail: memory.detail,
      kind: memory.type,
    },
  })
  return { ...stored, type: stored.kind as MemoryRecord['type'], time: displayTime(stored.createdAt) } satisfies MemoryRecord
}

export async function updateNativeMemory(memoryId: string, memory: Omit<MemoryRecord, 'id' | 'time' | 'createdAt'>) {
  const stored = await invoke<StoredMemory>('update_memory', {
    memoryId,
    memory: {
      sessionId: memory.sessionId,
      workspacePath: memory.workspacePath ?? '',
      scope: memory.scope,
      title: memory.title,
      detail: memory.detail,
      kind: memory.type,
    },
  })
  return { ...stored, type: stored.kind as MemoryRecord['type'], time: displayTime(stored.createdAt) } satisfies MemoryRecord
}

export async function deleteNativeMemory(memoryId: string) {
  return invoke<void>('delete_memory', { memoryId })
}

export async function compactNativeSession(sessionId: string) {
  return invoke<string>('compact_session', { sessionId })
}

export async function testNativeProvider(provider: Provider) {
  return invoke<ProviderHealth>('provider_healthcheck', { provider: providerPayload(provider) })
}

export async function startNativeRun(
  request: { runId: string; sessionId: string; workspacePath: string; branch: string; prompt: string; provider: Provider },
  onEvent: (event: RuntimeEventRecord) => void,
) {
  const channel = new Channel<RuntimeEventRecord>()
  channel.onmessage = onEvent
  return invoke<void>('runtime_start', {
    request: { ...request, provider: providerPayload(request.provider) },
    onEvent: channel,
  })
}

export async function cancelNativeRun(runId: string) {
  return invoke<boolean>('runtime_cancel', { runId })
}
