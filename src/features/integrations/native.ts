import { invoke } from '@tauri-apps/api/core'
import type { McpApprovalDecisionRequest, McpHealth, RemoteMcpServer, SkillDescriptor } from './types'

export async function pickSkillDirectory() {
  return invoke<string | null>('pick_skill_directory')
}

export async function discoverSkills(root: string) {
  return invoke<SkillDescriptor[]>('discover_skills', { root })
}

export async function testMcpServer(server: RemoteMcpServer) {
  return invoke<McpHealth>('mcp_healthcheck', {
    server: {
      serverLabel: server.serverLabel,
      serverUrl: server.serverUrl,
      authorization: server.authorization ?? '',
    },
  })
}

export async function decideMcpApproval(request: McpApprovalDecisionRequest) {
  return invoke<boolean>('mcp_approval_decide', { request })
}
