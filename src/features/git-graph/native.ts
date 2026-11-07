import { invoke } from '@tauri-apps/api/core'
import type { GitGraphSnapshot } from './types'

export function getGitGraph(path: string, limit = 200) {
  return invoke<GitGraphSnapshot>('git_graph', { path, limit })
}
