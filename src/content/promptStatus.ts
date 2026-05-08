import type { RoleToBackgroundMessage, RuntimeRoleStatus } from '../group/runtimeProtocol'

export function promptStatusMessage(
  status: RuntimeRoleStatus,
  chatId: string,
  roleId: string,
  error?: string,
): Extract<RoleToBackgroundMessage, { type: 'TEAM_ROLE_STATUS' }> {
  return {
    type: 'TEAM_ROLE_STATUS',
    status,
    chatId,
    roleId,
    ...(error ? { error } : {}),
  }
}
