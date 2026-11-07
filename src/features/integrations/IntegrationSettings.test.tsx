import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { IntegrationSettings, mcpValidationError } from './IntegrationSettings'
import { loadIntegrationSettings, persistIntegrationSettings, sanitizeIntegrationSettings } from './storage'
import type { IntegrationSettingsValue, RemoteMcpServer } from './types'

const server: RemoteMcpServer = {
  id: 'docs',
  name: 'Docs',
  serverLabel: 'openai_docs',
  serverUrl: 'https://developers.openai.com/mcp',
  description: '',
  allowedTools: ['search'],
  approvalPolicy: 'always',
  enabled: true,
}

const value: IntegrationSettingsValue = {
  skillRoots: ['/skills'],
  skills: [{ id: 'review', name: 'Review', description: 'Review changes', path: '/skills/review/SKILL.md', sourceRoot: '/skills', enabled: true }],
  mcpServers: [server],
}

describe('integration settings', () => {
  it('rejects insecure remote MCP endpoints and URL credentials', () => {
    expect(mcpValidationError({ ...server, serverUrl: 'http://example.com/mcp' })).toContain('HTTPS')
    expect(mcpValidationError({ ...server, serverUrl: 'https://user:pass@example.com/mcp' })).toContain('credentials')
    expect(mcpValidationError({ ...server, serverUrl: 'http://127.0.0.1:9000/mcp' })).toBeNull()
  })

  it('does not persist MCP authorization tokens', () => {
    const storage = { setItem: vi.fn() }
    persistIntegrationSettings({ ...value, mcpServers: [{ ...server, authorization: 'secret' }] }, storage)
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(storage.setItem.mock.calls[0][1]).not.toContain('secret')
  })

  it('loads safe defaults from corrupt storage', () => {
    expect(loadIntegrationSettings({ getItem: () => '{' })).toEqual({ skillRoots: [], skills: [], mcpServers: [] })
    expect(sanitizeIntegrationSettings(null)).toEqual({ skillRoots: [], skills: [], mcpServers: [] })
  })

  it('toggles skills and adds an MCP server', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IntegrationSettings value={value} onChange={onChange} desktop={false} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /Review/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ skills: [expect.objectContaining({ enabled: false })] }))

    onChange.mockClear()
    rerender(<IntegrationSettings value={{ ...value, mcpServers: [] }} onChange={onChange} desktop={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(onChange.mock.calls[0][0].mcpServers).toHaveLength(1)
  })

  it('surfaces the full-access warning', () => {
    render(<IntegrationSettings value={{ ...value, mcpServers: [{ ...server, approvalPolicy: 'never' }] }} onChange={vi.fn()} desktop />)
    expect(screen.getByText(/without per-call confirmation/)).toBeInTheDocument()
  })
})
