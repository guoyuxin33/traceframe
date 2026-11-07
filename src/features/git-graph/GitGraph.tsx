import { GitBranch, GitFork, LoaderCircle, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { layoutGitGraph } from './layout'
import { getGitGraph } from './native'
import type { GitGraphCommit, GitGraphEdge, GitGraphRef, GitGraphSnapshot } from './types'
import './gitGraph.css'

const ROW_HEIGHT = 58
const LANE_WIDTH = 18
const GRAPH_GUTTER = 13

function laneX(lane: number) {
  return GRAPH_GUTTER + lane * LANE_WIDTH
}

function rowY(row: number) {
  return ROW_HEIGHT / 2 + row * ROW_HEIGHT
}

function edgePath(edge: GitGraphEdge, height: number) {
  const fromX = laneX(edge.fromLane)
  const fromY = rowY(edge.fromRow)
  const toX = laneX(edge.toLane)
  const toY = edge.toRow === null ? Math.min(height, fromY + ROW_HEIGHT / 2) : rowY(edge.toRow)
  if (fromX === toX) return `M ${fromX} ${fromY} L ${toX} ${toY}`
  const bendY = Math.min(toY, fromY + ROW_HEIGHT * 0.72)
  return `M ${fromX} ${fromY} C ${fromX} ${bendY}, ${toX} ${bendY}, ${toX} ${toY}`
}

function formattedDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return value
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function GitGraph({ snapshot, selectedHash = null, onSelect }: {
  snapshot: GitGraphSnapshot
  selectedHash?: string | null
  onSelect?: (hash: string) => void
}) {
  const graph = useMemo(() => layoutGitGraph(snapshot.commits, snapshot.refs), [snapshot])
  const width = Math.max(38, graph.laneCount * LANE_WIDTH + GRAPH_GUTTER * 2)
  const height = graph.rows.length * ROW_HEIGHT

  if (!graph.rows.length) {
    return <div className="git-graph-empty"><GitFork size={16} /><span>No commits yet</span></div>
  }

  return <div className="git-graph" style={{ '--git-graph-width': `${width}px` } as CSSProperties}>
    <svg className="git-graph-topology" width={width} height={height} aria-label={`${graph.laneCount} lane commit topology`} role="img">
      {graph.edges.map((edge) => (
        <path
          className={`git-graph-edge lane-${edge.fromLane % 6}`}
          d={edgePath(edge, height)}
          key={`${edge.fromRow}:${edge.parentHash}`}
          data-parent={edge.parentHash}
        />
      ))}
      {graph.rows.map((row, index) => (
        <circle
          className={`git-graph-node lane-${row.lane % 6}${row.commit.hash === snapshot.head ? ' is-head' : ''}${row.commit.hash === selectedHash ? ' is-selected' : ''}`}
          cx={laneX(row.lane)}
          cy={rowY(index)}
          r={row.commit.hash === snapshot.head ? 5 : 4}
          key={row.commit.hash}
        />
      ))}
    </svg>
    <ol className="git-graph-commits" aria-label="Commit graph">
      {graph.rows.map((row) => <li className={`git-graph-commit${row.commit.hash === selectedHash ? ' is-selected' : ''}`} key={row.commit.hash} title={row.commit.hash}>
        <button
          type="button"
          aria-label={`Select commit ${row.commit.shortHash}: ${row.commit.subject || 'Commit without a subject'}`}
          aria-pressed={row.commit.hash === selectedHash}
          onClick={() => onSelect?.(row.commit.hash)}
        >
          <span className="git-graph-refs">
            {row.refs.map((reference) => <span className={`git-graph-ref is-${reference.kind}${reference.isCurrent ? ' is-current' : ''}`} title={reference.fullName} key={reference.fullName}>
              {reference.kind === 'local' ? <GitBranch size={10} /> : null}{reference.name}
            </span>)}
          </span>
          <span className="git-graph-subject">{row.commit.subject || 'Commit without a subject'}</span>
          <span className="git-graph-meta"><span>{row.commit.author}</span><time dateTime={row.commit.authoredAt}>{formattedDate(row.commit.authoredAt)}</time><code>{row.commit.shortHash}</code></span>
        </button>
      </li>)}
    </ol>
    {snapshot.truncated || graph.hiddenParentCount ? <div className="git-graph-truncated">
      Showing {graph.rows.length} commits{graph.hiddenParentCount ? ` · ${graph.hiddenParentCount} parent connection${graph.hiddenParentCount === 1 ? '' : 's'} continue below` : ''}
    </div> : null}
  </div>
}

function CommitDetails({ commit, refs, commits, onSelect }: {
  commit: GitGraphCommit
  refs: GitGraphRef[]
  commits: GitGraphCommit[]
  onSelect: (hash: string) => void
}) {
  const loaded = new Map(commits.map((candidate) => [candidate.hash, candidate]))
  return <section className="git-commit-details" aria-label="Selected commit details">
    <header><span>Selected commit</span><code>{commit.shortHash}</code></header>
    <strong>{commit.subject || 'Commit without a subject'}</strong>
    <dl>
      <div><dt>Author</dt><dd>{commit.author}</dd></div>
      <div><dt>Authored</dt><dd><time dateTime={commit.authoredAt}>{formattedDate(commit.authoredAt)}</time></dd></div>
      <div><dt>Commit</dt><dd><code>{commit.hash}</code></dd></div>
      <div><dt>Refs</dt><dd>{refs.length ? refs.map((reference) => <span className={`git-detail-ref is-${reference.kind}`} title={reference.fullName} key={reference.fullName}>{reference.name}</span>) : <span>None</span>}</dd></div>
      <div><dt>Parents</dt><dd>{commit.parents.length ? commit.parents.map((hash) => {
        const parent = loaded.get(hash)
        return parent ? <button type="button" title={parent.subject} onClick={() => onSelect(hash)} key={hash}>{parent.shortHash}</button> : <code key={hash}>{hash.slice(0, 7)}</code>
      }) : <span>Root commit</span>}</dd></div>
    </dl>
  </section>
}

export function GitGraphSection({
  workspacePath,
  refreshToken = '',
  limit = 200,
  loadGraph = getGitGraph,
}: {
  workspacePath: string
  refreshToken?: string
  limit?: number
  loadGraph?: (path: string, limit: number) => Promise<GitGraphSnapshot>
}) {
  const [snapshot, setSnapshot] = useState<GitGraphSnapshot | null>(null)
  const [snapshotPath, setSnapshotPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState(0)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void loadGraph(workspacePath, limit).then((next) => {
      if (active) {
        setSnapshot(next)
        setSnapshotPath(workspacePath)
        setSelectedHash((current) => next.commits.some((commit) => commit.hash === current)
          ? current
          : next.commits.find((commit) => commit.hash === next.head)?.hash ?? next.commits[0]?.hash ?? null)
      }
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [workspacePath, refreshToken, limit, loadGraph, request])

  const activeSnapshot = snapshotPath === workspacePath ? snapshot : null
  const selectedCommit = activeSnapshot?.commits.find((commit) => commit.hash === selectedHash) ?? null
  const selectedRefs = activeSnapshot?.refs.filter((reference) => reference.hash === selectedHash) ?? []

  return <section className="git-graph-section" aria-label="Branch topology">
    <header className="git-graph-toolbar">
      <div><GitFork size={13} /><span>Branch topology</span>{activeSnapshot ? <code>{activeSnapshot.commits.length}</code> : null}</div>
      <button type="button" aria-label="Refresh commit graph" title="Refresh commit graph" disabled={loading} onClick={() => setRequest((value) => value + 1)}>
        <RefreshCw className={loading ? 'is-spinning' : ''} size={13} />
      </button>
    </header>
    {loading && !activeSnapshot ? <div className="git-graph-state" role="status"><LoaderCircle className="is-spinning" size={13} />Loading topology</div> : null}
    {error ? <div className="git-graph-state is-error" role="alert">Topology unavailable: {error}</div> : null}
    {activeSnapshot ? <GitGraph snapshot={activeSnapshot} selectedHash={selectedHash} onSelect={setSelectedHash} /> : null}
    {activeSnapshot && selectedCommit ? <CommitDetails commit={selectedCommit} refs={selectedRefs} commits={activeSnapshot.commits} onSelect={setSelectedHash} /> : null}
  </section>
}
