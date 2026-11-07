import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Actions, DockLocation, Model } from 'flexlayout-react'
import { describe, expect, it } from 'vitest'
import { HiddenPanelLibrary } from './HiddenPanelLibrary'
import { dockLayoutJson, hiddenDockComponents, persistDockModel, showOrRestoreDockComponent } from './dockModel'

function WorkspaceLayoutHarness() {
  const [model] = useState(() => Model.fromJson(dockLayoutJson('balanced')))
  const [, renderRevision] = useState(0)
  const update = () => renderRevision((current) => current + 1)
  const preview = model.getNodeById('preview')
  const code = model.getNodeById('code')
  const sessions = model.getNodeById('sessions')

  return <div>
    <button type="button" onClick={() => { model.doAction(Actions.moveNode('preview', sessions!.getParent()!.getId(), DockLocation.CENTER, -1, true)); persistDockModel(model); update() }}>Move Preview to Sessions</button>
    <button type="button" onClick={() => { model.doAction(Actions.deleteTab('preview')); persistDockModel(model); update() }}>Minimize Preview</button>
    <HiddenPanelLibrary
      panels={hiddenDockComponents(model)}
      onRestore={(panel) => { showOrRestoreDockComponent(model, panel); persistDockModel(model); update() }}
    />
    <output data-testid="preview-state">{preview ? `visible:${preview.getParent()?.getId() === sessions?.getParent()?.getId() ? 'sessions' : preview.getParent()?.getId() === code?.getParent()?.getId() ? 'code' : 'other'}` : 'hidden'}</output>
  </div>
}

describe('workspace panel recovery', () => {
  it('restores a minimized panel to the tabset where the user last moved it', async () => {
    const user = userEvent.setup()
    render(<WorkspaceLayoutHarness />)

    await user.click(screen.getByRole('button', { name: 'Move Preview to Sessions' }))
    expect(screen.getByTestId('preview-state')).toHaveTextContent('visible:sessions')
    await user.click(screen.getByRole('button', { name: 'Minimize Preview' }))
    expect(screen.getByTestId('preview-state')).toHaveTextContent('hidden')
    expect(screen.getByRole('button', { name: 'Restore Preview' })).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Restore Preview' }))
    expect(screen.queryByRole('button', { name: 'Restore Preview' })).not.toBeInTheDocument()
    expect(screen.getByTestId('preview-state')).toHaveTextContent('visible:sessions')
  })
})
