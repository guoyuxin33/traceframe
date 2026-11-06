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

export async function getCcSwitchStatus() {
  return invoke<CcSwitchStatus>('cc_switch_status')
}
