import { useMemo, useState } from 'react'
import { Check, FolderOpen, PlugZap, Plus, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { discoverSkills, pickSkillDirectory, testMcpServer } from './native'
import type { IntegrationSettingsValue, RemoteMcpServer } from './types'
import './integrations.css'

function nextMcpServer(): RemoteMcpServer {
  const id = `mcp-${Date.now()}`
  return {
    id,
    name: 'MCP server',
    serverLabel: id,
    serverUrl: '',
    description: '',
    allowedTools: [],
    approvalPolicy: 'always',
    enabled: true,
  }
}

function normalizedLabel(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '')
}

export function mcpValidationError(server: RemoteMcpServer) {
  if (!server.name.trim()) return 'Enter a server name'
  if (!normalizedLabel(server.serverLabel)) return 'Enter a label using letters, numbers, underscores, or hyphens'
  try {
    const url = new URL(server.serverUrl)
    const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'Remote MCP servers must use HTTPS; HTTP is limited to loopback'
    if (url.username || url.password) return 'Keep credentials out of the URL and use the token field'
  } catch {
    return 'Enter a complete MCP URL'
  }
  return null
}

export function IntegrationSettings({
  value,
  onChange,
  desktop,
}: {
  value: IntegrationSettingsValue
  onChange: (value: IntegrationSettingsValue) => void
  desktop: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const enabledSkillCount = value.skills.filter((skill) => skill.enabled).length
  const enabledMcpCount = value.mcpServers.filter((server) => server.enabled).length
  const skillPathSet = useMemo(() => new Set(value.skills.map((skill) => skill.path)), [value.skills])

  const updateServer = (id: string, patch: Partial<RemoteMcpServer>) => {
    onChange({
      ...value,
      mcpServers: value.mcpServers.map((server) => server.id === id ? { ...server, ...patch } : server),
    })
  }

  const addSkillRoot = async () => {
    if (!desktop || busy) return
    setBusy('skill-picker')
    try {
      const root = await pickSkillDirectory()
      if (!root) return
      setBusy('skill-discovery')
      const found = await discoverSkills(root)
      const additions = found.filter((skill) => !skillPathSet.has(skill.path)).map((skill) => ({ ...skill, enabled: true }))
      onChange({
        ...value,
        skillRoots: value.skillRoots.includes(root) ? value.skillRoots : [...value.skillRoots, root],
        skills: [...value.skills, ...additions],
      })
      setStatus((current) => ({ ...current, skills: { ok: true, detail: `${found.length} skill${found.length === 1 ? '' : 's'} discovered` } }))
    } catch (error) {
      setStatus((current) => ({ ...current, skills: { ok: false, detail: error instanceof Error ? error.message : String(error) } }))
    } finally {
      setBusy(null)
    }
  }

  const refreshSkills = async () => {
    if (!desktop || busy || value.skillRoots.length === 0) return
    setBusy('skill-discovery')
    try {
      const found = (await Promise.all(value.skillRoots.map(discoverSkills))).flat()
      const enabledByPath = new Map(value.skills.map((skill) => [skill.path, skill.enabled]))
      const deduped = [...new Map(found.map((skill) => [skill.path, { ...skill, enabled: enabledByPath.get(skill.path) ?? true }])).values()]
      onChange({ ...value, skills: deduped })
      setStatus((current) => ({ ...current, skills: { ok: true, detail: `${deduped.length} skill${deduped.length === 1 ? '' : 's'} available` } }))
    } catch (error) {
      setStatus((current) => ({ ...current, skills: { ok: false, detail: error instanceof Error ? error.message : String(error) } }))
    } finally {
      setBusy(null)
    }
  }

  const testServer = async (server: RemoteMcpServer) => {
    const validationError = mcpValidationError(server)
    if (validationError) {
      setStatus((current) => ({ ...current, [server.id]: { ok: false, detail: validationError } }))
      return
    }
    setBusy(server.id)
    try {
      const health = await testMcpServer(server)
      setStatus((current) => ({ ...current, [server.id]: { ok: health.ok, detail: health.detail } }))
    } catch (error) {
      setStatus((current) => ({ ...current, [server.id]: { ok: false, detail: error instanceof Error ? error.message : String(error) } }))
    } finally {
      setBusy(null)
    }
  }

  return <div className="integration-settings">
    <section className="integration-section" aria-labelledby="skills-settings-heading">
      <header>
        <div><h3 id="skills-settings-heading">Skills</h3><p>{enabledSkillCount} enabled · local instructions loaded for each run</p></div>
        <div className="integration-actions">
          <button type="button" title="Refresh skill folders" disabled={!desktop || Boolean(busy) || value.skillRoots.length === 0} onClick={() => void refreshSkills()}><RefreshCw size={13} /></button>
          <button type="button" disabled={!desktop || Boolean(busy)} onClick={() => void addSkillRoot()}><FolderOpen size={13} />Add folder</button>
        </div>
      </header>
      {!desktop ? <p className="integration-empty">Open the desktop app to discover local skills.</p> : null}
      {value.skills.length === 0 && desktop ? <p className="integration-empty">No skill folders configured</p> : null}
      <div className="integration-list">
        {value.skills.map((skill) => <label className="skill-row" key={skill.path}>
          <input type="checkbox" checked={skill.enabled} onChange={(event) => onChange({ ...value, skills: value.skills.map((item) => item.path === skill.path ? { ...item, enabled: event.target.checked } : item) })} />
          <span><strong>{skill.name}</strong><small>{skill.description || skill.path}</small></span>
          <code title={skill.path}>{skill.sourceRoot}</code>
        </label>)}
      </div>
      {status.skills ? <p className={`integration-status${status.skills.ok ? ' is-ok' : ' is-error'}`}>{status.skills.ok ? <Check size={13} /> : <XCircle size={13} />}{status.skills.detail}</p> : null}
    </section>

    <section className="integration-section" aria-labelledby="mcp-settings-heading">
      <header>
        <div><h3 id="mcp-settings-heading">Remote MCP</h3><p>{enabledMcpCount} enabled · Streamable HTTP or HTTP/SSE</p></div>
        <button type="button" onClick={() => onChange({ ...value, mcpServers: [...value.mcpServers, nextMcpServer()] })}><Plus size={13} />Add server</button>
      </header>
      <div className="mcp-list">
        {value.mcpServers.map((server) => {
          const validationError = mcpValidationError(server)
          const serverStatus = status[server.id]
          return <article className="mcp-server" key={server.id}>
            <div className="mcp-server-title">
              <label className="mcp-enabled"><input type="checkbox" checked={server.enabled} onChange={(event) => updateServer(server.id, { enabled: event.target.checked })} /><PlugZap size={14} /><span>{server.name || 'MCP server'}</span></label>
              <div>
                <button type="button" disabled={!desktop || busy === server.id || Boolean(validationError)} onClick={() => void testServer(server)}>{busy === server.id ? 'Testing…' : 'Test'}</button>
                <button type="button" aria-label={`Remove MCP server ${server.name}`} title="Remove server" onClick={() => onChange({ ...value, mcpServers: value.mcpServers.filter((item) => item.id !== server.id) })}><Trash2 size={13} /></button>
              </div>
            </div>
            <div className="mcp-fields">
              <label><span>Name</span><input value={server.name} onChange={(event) => updateServer(server.id, { name: event.target.value })} /></label>
              <label><span>Server label</span><input value={server.serverLabel} onChange={(event) => updateServer(server.id, { serverLabel: normalizedLabel(event.target.value) })} /></label>
              <label className="mcp-url"><span>Server URL</span><input value={server.serverUrl} placeholder="https://service.example/mcp" onChange={(event) => updateServer(server.id, { serverUrl: event.target.value })} /></label>
              <label><span>Approval</span><select value={server.approvalPolicy} onChange={(event) => updateServer(server.id, { approvalPolicy: event.target.value as RemoteMcpServer['approvalPolicy'] })}><option value="always">Request every call</option><option value="never">Full access</option></select></label>
              <label><span>Allowed tools</span><input value={server.allowedTools.join(', ')} placeholder="All tools" onChange={(event) => updateServer(server.id, { allowedTools: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
              <label className="mcp-token"><span>OAuth token</span><input type="password" value={server.authorization ?? ''} autoComplete="off" placeholder="Held in memory only" onChange={(event) => updateServer(server.id, { authorization: event.target.value })} /></label>
            </div>
            {server.approvalPolicy === 'never' ? <p className="mcp-warning"><ShieldCheck size={13} />This server may receive model context and act without per-call confirmation</p> : null}
            {validationError ? <p className="integration-status is-error"><XCircle size={13} />{validationError}</p> : serverStatus ? <p className={`integration-status${serverStatus.ok ? ' is-ok' : ' is-error'}`}>{serverStatus.ok ? <Check size={13} /> : <XCircle size={13} />}{serverStatus.detail}</p> : null}
          </article>
        })}
      </div>
      {value.mcpServers.length === 0 ? <p className="integration-empty">No remote MCP servers configured</p> : null}
    </section>
  </div>
}
