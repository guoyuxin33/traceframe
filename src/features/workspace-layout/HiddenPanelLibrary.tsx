import {
  Activity,
  Boxes,
  Code2,
  Database,
  Eye,
  FileCode2,
  GitCompareArrows,
  ListTree,
  MessageSquare,
  Network,
  ScrollText,
  SquareTerminal,
} from 'lucide-react'
import { DOCK_COMPONENT_LABELS, type DockComponent } from './dockModel'

const panelIcons: Record<DockComponent, typeof Activity> = {
  sessions: MessageSquare,
  source: GitCompareArrows,
  conversation: MessageSquare,
  code: FileCode2,
  diff: Code2,
  preview: Eye,
  terminal: SquareTerminal,
  output: ScrollText,
  trace: Activity,
  context: Boxes,
  agents: Network,
  memory: Database,
}

export function HiddenPanelLibrary({ panels, onRestore }: { panels: DockComponent[]; onRestore: (panel: DockComponent) => void }) {
  if (!panels.length) return null
  return <div className="rail-hidden-panels" aria-label="Minimized panels">
    <span className="rail-panel-divider" aria-hidden="true" />
    <span className="sr-only"><ListTree size={14} />Minimized panels</span>
    {panels.map((panel) => {
      const Icon = panelIcons[panel]
      const label = DOCK_COMPONENT_LABELS[panel]
      return <button type="button" key={panel} className="rail-panel-restore" aria-label={`Restore ${label}`} title={`Restore ${label}`} onClick={() => onRestore(panel)}>
        <Icon size={17} />
        <span aria-hidden="true" />
      </button>
    })}
  </div>
}
