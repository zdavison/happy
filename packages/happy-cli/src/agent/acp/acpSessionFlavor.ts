/**
 * Maps an ACP agent name to a Happy session flavor. Shared by the ACP client
 * (`runAcp`) and the ACP proxy (`phoneRelay`) so both classify agents the same
 * way. Unknown agents fall back to the generic `'acp'` flavor.
 */
export function resolveSessionFlavor(agentName: string): 'gemini' | 'opencode' | 'acp' {
  if (agentName === 'gemini') {
    return 'gemini';
  }
  if (agentName === 'opencode') {
    return 'opencode';
  }
  return 'acp';
}
