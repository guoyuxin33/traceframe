import { invoke } from '@tauri-apps/api/core'

export type PreviewProcessPhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface PreviewProcessState {
  phase: PreviewProcessPhase
  pid: number | null
  url: string | null
  startedAt: number | null
  error: string | null
}

export interface PreviewLogEntry {
  sequence: number
  stream: 'stdout' | 'stderr' | 'system'
  line: string
  timestamp: number
}

export interface PreviewStartRequest {
  workspacePath: string
  program: string
  args: string[]
}

export interface PreviewProxy {
  proxyUrl: string
  sourceUrl: string
}

export interface PreviewNativeApi {
  start(request: PreviewStartRequest): Promise<PreviewProcessState>
  restart(request: PreviewStartRequest): Promise<PreviewProcessState>
  stop(): Promise<PreviewProcessState>
  status(): Promise<PreviewProcessState>
  logs(afterSequence: number): Promise<PreviewLogEntry[]>
  openProxy(url: string, marker: string): Promise<PreviewProxy>
}

export const nativePreviewApi: PreviewNativeApi = {
  start(request) {
    return invoke<PreviewProcessState>('preview_start', { request })
  },
  restart(request) {
    return invoke<PreviewProcessState>('preview_restart', { request })
  },
  stop() {
    return invoke<PreviewProcessState>('preview_stop')
  },
  status() {
    return invoke<PreviewProcessState>('preview_status')
  },
  logs(afterSequence) {
    return invoke<PreviewLogEntry[]>('preview_logs', { afterSequence })
  },
  openProxy(url, marker) {
    return invoke<PreviewProxy>('preview_proxy_open', { url, marker })
  },
}
