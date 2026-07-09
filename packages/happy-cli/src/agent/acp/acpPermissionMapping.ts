/**
 * Pure mappers between ACP permission requests/responses and Happy's
 * `PermissionResult`. `kind`-based: option ids are resolved from the request's
 * own `options` by `kind` rather than hardcoded, so they work across ACP
 * agents that name their options differently.
 *
 * (Note: `AcpBackend` still has its own, name-based permission mapping inline.
 * These two implementations are intentionally left separate for now — unifying
 * them is a follow-up, since the name-based path has different fallback
 * behaviour and its own regression coverage.)
 */
import { randomUUID } from 'node:crypto';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
} from '@agentclientprotocol/sdk';
import type { PermissionResult } from '@/utils/BasePermissionHandler';

/** Extended shape covering non-standard `toolCall`/param fields other ACP agents emit. */
type ExtendedPermissionRequest = RequestPermissionRequest & {
  toolCall?: RequestPermissionRequest['toolCall'] & {
    id?: string;
    toolName?: string;
    input?: unknown;
    arguments?: unknown;
    content?: unknown;
  };
};

/**
 * Pulls `{ toolCallId, toolName, input }` out of an ACP `RequestPermissionRequest`,
 * tolerating the field variations different ACP agents emit.
 */
export function extractPermissionRequestInput(request: RequestPermissionRequest): {
  toolCallId: string;
  toolName: string;
  input: unknown;
} {
  const toolCall = (request as ExtendedPermissionRequest).toolCall;
  return {
    toolCallId: toolCall?.toolCallId ?? toolCall?.id ?? randomUUID(),
    toolName: toolCall?.kind ?? toolCall?.toolName ?? toolCall?.title ?? 'Unknown tool',
    input: toolCall?.rawInput ?? toolCall?.input ?? toolCall?.arguments ?? toolCall?.content ?? {},
  };
}

/**
 * Maps a resolved `PermissionResult` to an ACP `RequestPermissionResponse`,
 * choosing the option id from the request's own `options` by `kind` (never
 * hardcoded).
 */
export function permissionResultToOutcome(
  result: PermissionResult,
  options: PermissionOption[],
): RequestPermissionResponse {
  const allowOnce = options.find((opt) => opt.kind === 'allow_once');
  const allowAlways = options.find((opt) => opt.kind === 'allow_always');
  const allowAny = options.find((opt) => opt.kind.startsWith('allow'));
  const rejectAny = options.find((opt) => opt.kind === 'reject_once' || opt.kind === 'reject_always');

  if (result.decision === 'approved' || result.decision === 'approved_for_session') {
    const chosen: PermissionOption | undefined =
      result.decision === 'approved_for_session'
        ? (allowAlways ?? allowOnce ?? allowAny)
        : (allowOnce ?? allowAlways ?? allowAny);
    if (chosen) {
      return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }

  // denied / abort
  if (rejectAny) {
    return { outcome: { outcome: 'selected', optionId: rejectAny.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}
