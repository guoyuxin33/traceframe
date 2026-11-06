export type RuntimeEventType =
  | 'run.created'
  | 'run.completed'
  | 'run.failed'
  | 'agent.spawned'
  | 'agent.state_changed'
  | 'model.requested'
  | 'model.delta'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'file.changed'
  | 'git.branch_changed'
  | 'git.worktree_created'
  | 'context.compacted'
  | 'memory.written'

export interface RuntimeEvent<T = unknown> {
  id: string
  traceId: string
  parentId?: string
  sequence: number
  timestamp: string
  type: RuntimeEventType
  agentId: string
  payload: T
}

export interface RunRequest {
  sessionId: string
  workspacePath: string
  prompt: string
  branch: string
  model: string
  contextPolicyId: string
  permissionProfileId: string
}

export interface RunHandle {
  runId: string
  traceId: string
}

export interface AgentRuntime {
  readonly id: string
  readonly label: string
  start(request: RunRequest): Promise<RunHandle>
  cancel(runId: string): Promise<void>
  subscribe(listener: (event: RuntimeEvent) => void): () => void
}

export interface RuntimeAdapterFactory {
  id: string
  label: string
  create(config: Record<string, unknown>): Promise<AgentRuntime>
  healthcheck(): Promise<{ ok: boolean; version?: string; detail?: string }>
}
