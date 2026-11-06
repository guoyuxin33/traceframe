import { invoke } from '@tauri-apps/api/core'

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

export interface CcSwitchProvider {
  id: string
  name: string
  appType: string
  isCurrent: boolean
  inFailoverQueue: boolean
  endpoint?: string
}

export interface CcSwitchStatus {
  installed: boolean
  databaseFound: boolean
  proxyEnabled: boolean
  proxyPort: number
  providers: CcSwitchProvider[]
}

export function isDesktopRuntime() {
  return '__TAURI_INTERNALS__' in window
}

export async function getNativeCapabilities() {
  return invoke<NativeCapabilities>('native_capabilities')
}

export async function getGitSnapshot(path: string) {
  return invoke<GitSnapshot>('git_snapshot', { path })
}

export async function listGitBranches(path: string) {
  return invoke<string[]>('git_branches', { path })
}

export async function getGitDiff(path: string, staged = false) {
  return invoke<string>('git_diff', { path, staged })
}

export async function getCcSwitchStatus() {
  return invoke<CcSwitchStatus>('cc_switch_status')
}
