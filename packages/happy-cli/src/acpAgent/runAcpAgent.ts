/**
 * runAcpAgent - stub
 *
 * The native-Claude ACP agent implementation was removed (see
 * `refactor(cli): remove native-Claude acp-agent, keep launcher loop-exit fix`).
 * This is a placeholder kept only so the tree compiles and `index.ts`'s
 * `acp-agent` subcommand still has something to import; the real BYO ACP
 * proxy is rebuilt in Task 6 of the Happy ACP Proxy plan.
 */

import type { Credentials } from '@/persistence';

export async function runAcpAgent(_opts: { credentials: Credentials }): Promise<void> {
  throw new Error('acp-agent proxy not yet wired'); // rebuilt in Task 6
}
