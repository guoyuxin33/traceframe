import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { GitGraph, GitGraphSection } from './GitGraph'
import type { GitGraphSnapshot } from './types'

const snapshot: GitGraphSnapshot = {
  head: 'merge',
  currentBranch: 'main',
  truncated: false,
  commits: [
    { hash: 'merge', shortHash: 'abc1234', parents: ['main', 'feature'], author: 'Ada', authoredAt: '2026-11-07T09:04:00Z', subject: 'merge feature' },
    { hash: 'main', shortHash: 'def5678', parents: ['base'], author: 'Ada', authoredAt: '2026-11-07T09:03:00Z', subject: 'main work' },
    { hash: 'feature', shortHash: 'fed4321', parents: ['base'], author: 'Lin', authoredAt: '2026-11-07T09:02:00Z', subject: 'feature work' },
    { hash: 'base', shortHash: '0000000', parents: [], author: 'Ada', authoredAt: '2026-11-07T09:01:00Z', subject: 'base' },
  ],
  refs: [
    { name: 'HEAD', fullName: 'HEAD', hash: 'merge', kind: 'head', isCurrent: true, symbolicTarget: 'refs/heads/main' },
    { name: 'main', fullName: 'refs/heads/main', hash: 'merge', kind: 'local', isCurrent: true, symbolicTarget: null },
    { name: 'origin/main', fullName: 'refs/remotes/origin/main', hash: 'merge', kind: 'remote', isCurrent: false, symbolicTarget: null },
    { name: 'feature/ui', fullName: 'refs/heads/feature/ui', hash: 'feature', kind: 'local', isCurrent: false, symbolicTarget: null },
  ],
}

describe('GitGraph', () => {
  it('renders topology paths, merge lanes, refs, and commit metadata', () => {
    const { container } = render(<GitGraph snapshot={snapshot} />)

    expect(screen.getByRole('img', { name: '2 lane commit topology' })).toBeVisible()
    expect(container.querySelectorAll('.git-graph-edge')).toHaveLength(4)
    expect(container.querySelectorAll('.git-graph-node')).toHaveLength(4)
    expect(container.querySelector('.git-graph-node.is-head')).toBeTruthy()
    expect(screen.getByText('merge feature')).toBeVisible()
    expect(screen.getByText('feature/ui')).toBeVisible()
    expect(screen.getByText('origin/main')).toBeVisible()
    expect(screen.getByText('abc1234')).toBeVisible()
  })

  it('shows an explicit empty state for a repository without commits', () => {
    render(<GitGraph snapshot={{ ...snapshot, head: null, commits: [], refs: [] }} />)
    expect(screen.getByText('No commits yet')).toBeVisible()
  })
})

describe('GitGraphSection', () => {
  it('selects commits with pointer and keyboard and shows complete commit evidence', async () => {
    const user = userEvent.setup()
    render(<GitGraphSection workspacePath="/tmp/workspace" loadGraph={async () => snapshot} />)

    const head = await screen.findByRole('button', { name: 'Select commit abc1234: merge feature' })
    expect(head).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Select commit fed4321: feature work' }))
    const details = screen.getByRole('region', { name: 'Selected commit details' })
    expect(within(details).getByText('feature work')).toBeVisible()
    expect(within(details).getByText('feature/ui')).toBeVisible()
    expect(within(details).getByText('Lin')).toBeVisible()
    expect(within(details).getByText('feature')).toBeVisible()
    expect(within(details).getByRole('button', { name: '0000000' })).toHaveAttribute('title', 'base')

    const main = screen.getByRole('button', { name: 'Select commit def5678: main work' })
    main.focus()
    await user.keyboard('{Enter}')
    expect(main).toHaveAttribute('aria-pressed', 'true')
    expect(within(details).getByText('main work')).toBeVisible()
  })

  it('loads the selected repository and supports a manual refresh', async () => {
    const loadGraph = vi.fn().mockResolvedValue(snapshot)
    render(<GitGraphSection workspacePath="/tmp/workspace" limit={80} loadGraph={loadGraph} />)

    expect(screen.getByText('Loading topology')).toBeVisible()
    await screen.findByRole('button', { name: 'Select commit abc1234: merge feature' })
    expect(loadGraph).toHaveBeenCalledWith('/tmp/workspace', 80)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh commit graph' }))
    await waitFor(() => expect(loadGraph).toHaveBeenCalledTimes(2))
  })

  it('keeps failures contained in the graph section', async () => {
    const loadGraph = vi.fn().mockRejectedValue(new Error('not a repository'))
    render(<GitGraphSection workspacePath="/tmp/missing" loadGraph={loadGraph} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Topology unavailable: not a repository')
    expect(screen.queryByRole('list', { name: 'Commit graph' })).not.toBeInTheDocument()
  })

  it('does not show the previous repository while a new graph is loading', async () => {
    let resolveSecond: ((value: GitGraphSnapshot) => void) | undefined
    const loadGraph = vi.fn()
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => new Promise<GitGraphSnapshot>((resolve) => { resolveSecond = resolve }))
    const { rerender } = render(<GitGraphSection workspacePath="/tmp/first" loadGraph={loadGraph} />)
    await screen.findByRole('button', { name: 'Select commit abc1234: merge feature' })

    rerender(<GitGraphSection workspacePath="/tmp/second" loadGraph={loadGraph} />)
    expect(screen.queryByRole('button', { name: 'Select commit abc1234: merge feature' })).not.toBeInTheDocument()
    expect(screen.getByText('Loading topology')).toBeVisible()

    resolveSecond?.({ ...snapshot, commits: [{ ...snapshot.commits[0], subject: 'second repository' }] })
    expect(await screen.findByRole('button', { name: 'Select commit abc1234: second repository' })).toBeVisible()
  })
})
