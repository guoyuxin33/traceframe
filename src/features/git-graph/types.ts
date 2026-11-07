export type GitGraphRefKind = 'head' | 'local' | 'remote' | 'tag'

export interface GitGraphCommit {
  hash: string
  shortHash: string
  parents: string[]
  author: string
  authoredAt: string
  subject: string
}

export interface GitGraphRef {
  name: string
  fullName: string
  hash: string
  kind: GitGraphRefKind
  isCurrent: boolean
  symbolicTarget: string | null
}

export interface GitGraphSnapshot {
  head: string | null
  currentBranch: string | null
  commits: GitGraphCommit[]
  refs: GitGraphRef[]
  truncated: boolean
}

export interface GitGraphRow {
  commit: GitGraphCommit
  lane: number
  refs: GitGraphRef[]
}

export interface GitGraphEdge {
  parentHash: string
  fromRow: number
  fromLane: number
  toRow: number | null
  toLane: number
}

export interface GitGraphLayout {
  rows: GitGraphRow[]
  edges: GitGraphEdge[]
  laneCount: number
  hiddenParentCount: number
}
