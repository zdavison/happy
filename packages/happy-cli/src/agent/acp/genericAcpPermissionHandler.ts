/**
 * GenericAcpPermissionHandler - phone-side permission handler for ACP agents.
 *
 * A `BasePermissionHandler` subclass whose `handleToolCall` parks a pending
 * promise (keyed by `toolCallId`), pushes the request into agent state via
 * `addPendingRequestToState`, and lets the `permission` RPC — registered by
 * `BasePermissionHandler.setupRpcHandler` — resolve it once the phone answers.
 *
 * Shared by the ACP client (`runAcp`) and the ACP proxy (`phoneRelay`).
 */
import { BasePermissionHandler, type PermissionResult } from '@/utils/BasePermissionHandler';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpPermissionHandler } from './AcpBackend';
import { logger } from '@/ui/logger';

export class GenericAcpPermissionHandler extends BasePermissionHandler implements AcpPermissionHandler {
  private readonly logPrefix: string;

  constructor(session: ApiSessionClient, agentName: string) {
    super(session);
    this.logPrefix = `[${agentName}]`;
  }

  protected getLogPrefix(): string {
    return this.logPrefix;
  }

  async handleToolCall(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, {
        resolve,
        reject,
        toolName,
        input,
      });
      this.addPendingRequestToState(toolCallId, toolName, input);
      logger.debug(`${this.logPrefix} Permission request sent for tool: ${toolName} (${toolCallId})`);
    });
  }

  /**
   * Cancel a single pending request (used when another party wins a permission
   * race). Rejecting unblocks `handleToolCall` for that `toolCallId` only;
   * unknown ids are ignored.
   */
  cancelPending(toolCallId: string, reason: string): void {
    const pending = this.pendingRequests.get(toolCallId);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(toolCallId);
    try {
      pending.reject(new Error(reason));
    } catch (error) {
      logger.debug(`${this.logPrefix} cancelPending reject failed:`, error);
    }
  }
}
