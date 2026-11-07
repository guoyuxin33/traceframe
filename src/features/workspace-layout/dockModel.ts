import { Actions, DockLocation, Model, type IJsonModel, type TabNode } from 'flexlayout-react'

export type DockPreset = 'balanced' | 'code' | 'conversation'

export const DOCK_LAYOUT_STORAGE_KEY = 'traceframe.dock-layout'
export const DOCK_LAYOUT_SCHEMA_VERSION = 7
export const DOCK_COMPONENTS = ['sessions', 'source', 'conversation', 'code', 'diff', 'preview', 'terminal', 'output', 'trace', 'context', 'agents', 'memory'] as const
export type DockComponent = typeof DOCK_COMPONENTS[number]
export type RailComponent = Extract<DockComponent, 'sessions' | 'source' | 'agents' | 'memory'>

export const DOCK_COMPONENT_LABELS: Record<DockComponent, string> = {
  sessions: 'Sessions',
  source: 'Source control',
  conversation: 'Conversation',
  code: 'Code',
  diff: 'Diff',
  preview: 'Preview',
  terminal: 'Terminal',
  output: 'Output',
  trace: 'Trace',
  context: 'Context',
  agents: 'Agents',
  memory: 'Memory',
}

const LEGACY_DOCK_LAYOUT_STORAGE_KEYS = ['traceframe.dock-layout.v4', 'traceframe.dock-layout.v3', 'traceframe.dock-layout.v2'] as const

function dockTab(id: DockComponent) {
  return { type: 'tab' as const, id, name: DOCK_COMPONENT_LABELS[id], component: id }
}

export function dockLayoutJson(preset: DockPreset): IJsonModel {
  const weights = preset === 'code' ? [18, 20, 45, 17] : preset === 'conversation' ? [18, 38, 27, 17] : [18, 28, 37, 17]
  const workspaceWeights = preset === 'code' ? [72, 28] : preset === 'conversation' ? [58, 42] : [66, 34]
  return {
    global: {
      tabEnableClose: true,
      tabEnableDrag: true,
      tabEnableFloat: false,
      tabSetEnableClose: false,
    },
    borders: [],
    layout: {
      type: 'row',
      weight: 100,
      children: [
        { type: 'tabset', weight: weights[0], minWidth: 200, children: [dockTab('sessions'), dockTab('source')] },
        { type: 'tabset', weight: weights[1], minWidth: 220, children: [dockTab('conversation')] },
        {
          type: 'row',
          weight: weights[2],
          minWidth: 360,
          children: [
            { type: 'tabset', weight: workspaceWeights[0], minHeight: 240, children: [dockTab('code'), dockTab('diff'), dockTab('preview')] },
            { type: 'tabset', weight: workspaceWeights[1], minHeight: 160, children: [dockTab('terminal'), dockTab('output'), dockTab('trace')] },
          ],
        },
        { type: 'tabset', weight: weights[3], minWidth: 220, children: [dockTab('context'), dockTab('agents'), dockTab('memory')] },
      ],
    },
  }
}

function collectDockComponents(node: unknown, result: string[] = []) {
  if (!node || typeof node !== 'object') return result
  const candidate = node as { component?: unknown; children?: unknown[] }
  if (typeof candidate.component === 'string') result.push(candidate.component)
  candidate.children?.forEach((child) => collectDockComponents(child, result))
  return result
}

function isRestorableDockLayout(value: IJsonModel) {
  const components = collectDockComponents(value.layout)
  const allowed = new Set<string>(DOCK_COMPONENTS)
  return new Set(components).size === components.length
    && components.every((component) => allowed.has(component))
}

function withCurrentDockCapabilities(value: IJsonModel) {
  const current = JSON.parse(JSON.stringify(value)) as IJsonModel
  current.global = {
    ...current.global,
    tabEnableClose: true,
    tabEnableDrag: true,
    tabEnableFloat: false,
    tabSetEnableClose: false,
  }
  return current
}

export function isValidDockLayout(value: IJsonModel) {
  const components = collectDockComponents(value.layout).sort()
  const required = [...DOCK_COMPONENTS].sort()
  return components.length === required.length && components.every((component, index) => component === required[index])
}

interface MutableDockNode {
  component?: string
  children?: MutableDockNode[]
}

interface PersistedDockLayout {
  schemaVersion: number
  model: IJsonModel
  restoreLocations?: Partial<Record<DockComponent, string>>
}

type DockRestoreLocations = Partial<Record<DockComponent, string>>

const modelRestoreLocations = new WeakMap<Model, DockRestoreLocations>()

function sanitizedRestoreLocations(value: unknown): DockRestoreLocations {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Record<string, unknown>
  return Object.fromEntries(DOCK_COMPONENTS.flatMap((component) => {
    const tabsetId = candidate[component]
    return typeof tabsetId === 'string' && tabsetId ? [[component, tabsetId]] : []
  }))
}

function visibleDockLocations(model: Model): DockRestoreLocations {
  return Object.fromEntries(DOCK_COMPONENTS.flatMap((component) => {
    const parent = model.getNodeById(component)?.getParent()
    return parent?.getType() === 'tabset' ? [[component, parent.getId()]] : []
  }))
}

function rememberVisibleDockLocations(model: Model, remembered: DockRestoreLocations = modelRestoreLocations.get(model) ?? {}) {
  const next = { ...remembered, ...visibleDockLocations(model) }
  modelRestoreLocations.set(model, next)
  return next
}

function dockParentFor(node: MutableDockNode, components: Set<string>): MutableDockNode | null {
  if (node.children?.some((child) => child.component && components.has(child.component))) return node
  for (const child of node.children ?? []) {
    const parent = dockParentFor(child, components)
    if (parent) return parent
  }
  return null
}

export function migrateDockLayout(value: IJsonModel): IJsonModel | null {
  const migrated = withCurrentDockCapabilities(value)
  if (isValidDockLayout(migrated)) return migrated
  const components = collectDockComponents(migrated.layout)
  const unique = new Set(components)
  const required = new Set<string>(DOCK_COMPONENTS)
  if (unique.size !== components.length || components.some((component) => !required.has(component))) return null
  const missing = DOCK_COMPONENTS.filter((component) => !unique.has(component))
  if (missing.some((component) => component !== 'preview' && component !== 'terminal')) return null

  const layout = migrated.layout as unknown as MutableDockNode
  if (missing.includes('preview')) {
    const workspaceParent = dockParentFor(layout, new Set(['code', 'diff']))
    if (!workspaceParent?.children) return null
    workspaceParent.children.push(dockTab('preview'))
  }
  if (missing.includes('terminal')) {
    const outputParent = dockParentFor(layout, new Set(['output', 'trace']))
    if (!outputParent?.children) return null
    outputParent.children.unshift(dockTab('terminal'))
  }
  return isValidDockLayout(migrated) ? migrated : null
}

function decodedDockLayout(raw: string): { kind: 'valid'; model: IJsonModel; restoreLocations: DockRestoreLocations } | { kind: 'future' | 'invalid' } {
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDockLayout> | IJsonModel
    if (typeof (parsed as Partial<PersistedDockLayout>).schemaVersion === 'number') {
      const stored = parsed as Partial<PersistedDockLayout>
      if (!Number.isSafeInteger(stored.schemaVersion) || !stored.model) return { kind: 'invalid' }
      if (stored.schemaVersion! > DOCK_LAYOUT_SCHEMA_VERSION) return { kind: 'future' }
      if (stored.schemaVersion === DOCK_LAYOUT_SCHEMA_VERSION) {
        return isRestorableDockLayout(stored.model)
          ? { kind: 'valid', model: withCurrentDockCapabilities(stored.model), restoreLocations: sanitizedRestoreLocations(stored.restoreLocations) }
          : { kind: 'invalid' }
      }
      if (stored.schemaVersion === 6 && isRestorableDockLayout(stored.model)) {
        return { kind: 'valid', model: withCurrentDockCapabilities(stored.model), restoreLocations: {} }
      }
      const migrated = migrateDockLayout(stored.model)
      return migrated ? { kind: 'valid', model: migrated, restoreLocations: {} } : { kind: 'invalid' }
    }
    const migrated = migrateDockLayout(parsed as IJsonModel)
    return migrated ? { kind: 'valid', model: migrated, restoreLocations: {} } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

export function persistDockModel(model: Model) {
  const stored: PersistedDockLayout = {
    schemaVersion: DOCK_LAYOUT_SCHEMA_VERSION,
    model: model.toJson(),
    restoreLocations: rememberVisibleDockLocations(model),
  }
  try {
    const current = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
    if (current) {
      const parsed = JSON.parse(current) as Partial<PersistedDockLayout>
      if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > DOCK_LAYOUT_SCHEMA_VERSION) return
    }
    localStorage.setItem(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // A restricted webview can still use the in-memory model.
  }
}

export function storedDockModel(preset: DockPreset) {
  const fallback = () => {
    const model = Model.fromJson(dockLayoutJson(preset))
    rememberVisibleDockLocations(model)
    return model
  }
  let current: string | null = null
  try {
    current = localStorage.getItem(DOCK_LAYOUT_STORAGE_KEY)
  } catch {
    return fallback()
  }
  if (current) {
    const decoded = decodedDockLayout(current)
    if (decoded.kind === 'future') return fallback()
    if (decoded.kind === 'valid') {
      try {
        const model = Model.fromJson(decoded.model)
        rememberVisibleDockLocations(model, decoded.restoreLocations)
        persistDockModel(model)
        return model
      } catch {
        // Continue through legacy layouts before resetting corrupt state.
      }
    }
  }

  for (const key of LEGACY_DOCK_LAYOUT_STORAGE_KEYS) {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(key)
    } catch {
      return fallback()
    }
    if (!raw) continue
    const decoded = decodedDockLayout(raw)
    if (decoded.kind !== 'valid') continue
    try {
      const model = Model.fromJson(decoded.model)
      rememberVisibleDockLocations(model, decoded.restoreLocations)
      persistDockModel(model)
      return model
    } catch {
      // Try the next known legacy schema.
    }
  }

  const model = fallback()
  persistDockModel(model)
  return model
}

export function selectedRailComponent(model: Model, includeSelectedFallback = false): RailComponent | null {
  const component = model.getActiveTabset()?.getSelectedNode()?.getComponent()
  if (component === 'sessions' || component === 'source' || component === 'agents' || component === 'memory') return component
  if (includeSelectedFallback) {
    const selected = (['source', 'sessions', 'agents', 'memory'] as const)
      .find((candidate) => (model.getNodeById(candidate) as TabNode | undefined)?.isSelected())
    if (selected) return selected
  }
  return null
}

export function hiddenDockComponents(model: Model) {
  return DOCK_COMPONENTS.filter((component) => !model.getNodeById(component))
}

const DOCK_GROUPS: DockComponent[][] = [
  ['sessions', 'source'],
  ['conversation'],
  ['code', 'diff', 'preview'],
  ['terminal', 'output', 'trace'],
  ['context', 'agents', 'memory'],
]

export function showOrRestoreDockComponent(model: Model, component: DockComponent) {
  if (model.getNodeById(component)) {
    model.doAction(Actions.selectTab(component))
    return
  }

  const rememberedTabsetId = modelRestoreLocations.get(model)?.[component]
  const rememberedTabset = rememberedTabsetId ? model.getNodeById(rememberedTabsetId) : undefined
  const group = DOCK_GROUPS.find((candidate) => candidate.includes(component)) ?? []
  const sibling = group.map((candidate) => model.getNodeById(candidate)).find(Boolean)
  const target = rememberedTabset?.getType() === 'tabset'
    ? rememberedTabset
    : sibling?.getParent() ?? model.getActiveTabset() ?? model.getFirstTabSet()
  if (!target) return
  model.doAction(Actions.addNode(dockTab(component), target.getId(), DockLocation.CENTER, -1, true))
  rememberVisibleDockLocations(model)
}
