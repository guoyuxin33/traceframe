import { describe, expect, it } from 'vitest'
import { layoutGitGraph } from './layout'
import type { GitGraphCommit, GitGraphRef } from './types'

const commits: GitGraphCommit[] = [
  { hash: 'merge', shortHash: 'merge', parents: ['main', 'feature'], author: 'Ada', authoredAt: '2026-11-07T09:04:00Z', subject: 'merge feature' },
  { hash: 'main', shortHash: 'main', parents: ['base'], author: 'Ada', authoredAt: '2026-11-07T09:03:00Z', subject: 'main work' },
  { hash: 'feature', shortHash: 'feature', parents: ['base'], author: 'Lin', authoredAt: '2026-11-07T09:02:00Z', subject: 'feature work' },
  { hash: 'base', shortHash: 'base', parents: [], author: 'Ada', authoredAt: '2026-11-07T09:01:00Z', subject: 'base' },
]

const refs: GitGraphRef[] = [
  { name: 'origin/main', fullName: 'refs/remotes/origin/main', hash: 'merge', kind: 'remote', isCurrent: false, symbolicTarget: null },
  { name: 'main', fullName: 'refs/heads/main', hash: 'merge', kind: 'local', isCurrent: true, symbolicTarget: null },
  { name: 'HEAD', fullName: 'HEAD', hash: 'merge', kind: 'head', isCurrent: true, symbolicTarget: 'refs/heads/main' },
  { name: 'feature/ui', fullName: 'refs/heads/feature/ui', hash: 'feature', kind: 'local', isCurrent: false, symbolicTarget: null },
]

describe('layoutGitGraph', () => {
  it('keeps both parents of a merge on separate lanes until they join', () => {
    const graph = layoutGitGraph(commits, refs)

    expect(graph.rows.map((row) => row.lane)).toEqual([0, 0, 1, 0])
    expect(graph.laneCount).toBe(2)
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentHash: 'main', fromLane: 0, toLane: 0 }),
      expect.objectContaining({ parentHash: 'feature', fromLane: 0, toLane: 1 }),
      expect.objectContaining({ parentHash: 'base', fromLane: 1, toLane: 0 }),
    ]))
  })

  it('groups and prioritizes refs on the commit they point to', () => {
    const graph = layoutGitGraph(commits, refs)

    expect(graph.rows[0].refs.map((reference) => reference.name)).toEqual(['HEAD', 'main', 'origin/main'])
    expect(graph.rows[2].refs.map((reference) => reference.name)).toEqual(['feature/ui'])
  })

  it('reports parents outside the bounded history instead of inventing rows', () => {
    const graph = layoutGitGraph([commits[1]], [])

    expect(graph.hiddenParentCount).toBe(1)
    expect(graph.edges[0]).toMatchObject({ parentHash: 'base', toRow: null })
  })

  it('returns an empty layout for an unborn repository', () => {
    expect(layoutGitGraph([], [])).toEqual({ rows: [], edges: [], laneCount: 0, hiddenParentCount: 0 })
  })
})
