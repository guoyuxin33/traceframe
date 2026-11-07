import type { IntegrationSettingsValue } from './types'
import { emptyIntegrationSettings } from './types'

export const INTEGRATIONS_STORAGE_KEY = 'traceframe.integrations'

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

export function sanitizeIntegrationSettings(value: unknown): IntegrationSettingsValue {
  if (!value || typeof value !== 'object') return emptyIntegrationSettings
  const candidate = value as Partial<IntegrationSettingsValue>
  const skillRoots = stringList(candidate.skillRoots)
  const skills = Array.isArray(candidate.skills)
    ? candidate.skills.flatMap((skill) => {
      if (!skill || typeof skill !== 'object') return []
      const item = skill as Partial<IntegrationSettingsValue['skills'][number]>
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.path !== 'string') return []
      return [{
        id: item.id,
        name: item.name,
        description: typeof item.description === 'string' ? item.description : '',
        path: item.path,
        sourceRoot: typeof item.sourceRoot === 'string' ? item.sourceRoot : '',
        enabled: item.enabled !== false,
      }]
    })
    : []
  const mcpServers = Array.isArray(candidate.mcpServers)
    ? candidate.mcpServers.flatMap((server) => {
      if (!server || typeof server !== 'object') return []
      const item = server as Partial<IntegrationSettingsValue['mcpServers'][number]>
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.serverUrl !== 'string') return []
      return [{
        id: item.id,
        name: item.name,
        serverLabel: typeof item.serverLabel === 'string' ? item.serverLabel : item.id,
        serverUrl: item.serverUrl,
        description: typeof item.description === 'string' ? item.description : '',
        allowedTools: stringList(item.allowedTools),
        approvalPolicy: item.approvalPolicy === 'never' ? 'never' as const : 'always' as const,
        enabled: item.enabled !== false,
      }]
    })
    : []
  return { skillRoots, skills, mcpServers }
}

export function loadIntegrationSettings(storage: Pick<Storage, 'getItem'> = localStorage) {
  try {
    const stored = storage.getItem(INTEGRATIONS_STORAGE_KEY)
    return stored ? sanitizeIntegrationSettings(JSON.parse(stored)) : emptyIntegrationSettings
  } catch {
    return emptyIntegrationSettings
  }
}

export function persistIntegrationSettings(value: IntegrationSettingsValue, storage: Pick<Storage, 'setItem'> = localStorage) {
  const durable = sanitizeIntegrationSettings(value)
  storage.setItem(INTEGRATIONS_STORAGE_KEY, JSON.stringify(durable))
}
