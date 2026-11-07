import type { GitGraphCommit, GitGraphLayout, GitGraphRef, GitGraphRow } from './types'

function refsByCommit(refs: GitGraphRef[]) {
  const grouped = new Map<string, GitGraphRef[]>()
  for (const reference of refs) {
    const commitRefs = grouped.get(reference.hash) ?? []
    commitRefs.push(reference)
    grouped.set(reference.hash, commitRefs)
  }
  return grouped
}

function compareRefs(left: GitGraphRef, right: GitGraphRef) {
  const priority = { head: 0, local: 1, remote: 2, tag: 3 }
  return priority[left.kind] - priority[right.kind]
    || Number(right.isCurrent) - Number(left.isCurrent)
    || left.name.localeCompare(right.name)
}

export function layoutGitGraph(commits: GitGraphCommit[], refs: GitGraphRef[]): GitGraphLayout {
  const activeLanes: string[] = []
  const rows: GitGraphRow[] = []
  const groupedRefs = refsByCommit(refs)
  let laneCount = commits.length ? 1 : 0

  for (const commit of commits) {
    let lane = activeLanes.indexOf(commit.hash)
    if (lane === -1) {
      lane = activeLanes.length
      activeLanes.push(commit.hash)
    }

    rows.push({
      commit,
      lane,
      refs: [...(groupedRefs.get(commit.hash) ?? [])].sort(compareRefs),
    })

    activeLanes.splice(lane, 1)
    let insertionLane = lane
    for (const parent of commit.parents) {
      if (activeLanes.includes(parent)) continue
      activeLanes.splice(insertionLane, 0, parent)
      insertionLane += 1
    }
    laneCount = Math.max(laneCount, lane + 1, activeLanes.length)
  }

  const rowByHash = new Map(rows.map((row, index) => [row.commit.hash, { row: index, lane: row.lane }]))
  let hiddenParentCount = 0
  const edges = rows.flatMap((row, fromRow) => row.commit.parents.map((parentHash) => {
    const parent = rowByHash.get(parentHash)
    if (!parent) hiddenParentCount += 1
    return {
      parentHash,
      fromRow,
      fromLane: row.lane,
      toRow: parent?.row ?? null,
      toLane: parent?.lane ?? row.lane,
    }
  }))

  return { rows, edges, laneCount, hiddenParentCount }
}
