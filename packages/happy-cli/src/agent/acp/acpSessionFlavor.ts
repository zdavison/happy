/**
 * Maps an ACP agent name to a Happy session flavor. Shared by the ACP client
 * (`runAcp`) and the ACP proxy (`phoneRelay`) so both classify agents the same
 * way.
 *
 * Only `gemini` and `opencode` are special-cased because they are the ACP
 * agents that flow through this generic ACP path *and* have first-class mobile
 * branding. The other `BackendFlavor`s do not belong here: `claude` and `codex`
 * run through their own dedicated (non-ACP) backends, and `openclaw` has its
 * own launcher — none reach `resolveSessionFlavor`. Every other downstream
 * (including `claude-code-acp` and any BYO ACP agent) intentionally falls back
 * to the generic `'acp'` flavor. Adding a new branded flavor here is a
 * one-line change once mobile has a matching view for it.
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
