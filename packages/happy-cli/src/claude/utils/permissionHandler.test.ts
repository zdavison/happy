import { describe, expect, it, vi } from 'vitest';
import { PermissionHandler } from './permissionHandler';
import type { Session } from '../session';
import type { PermissionResult } from '../sdk/types';
import type { EnhancedMode } from '../loop';

/**
 * Builds a minimal fake Session sufficient for exercising PermissionHandler.
 * Tracks agent state so we can assert requests move to completedRequests.
 */
function createFakeSession() {
    let agentState: any = { requests: {}, completedRequests: {} };
    const onPermissionRequest = vi.fn();
    const onPermissionResolved = vi.fn();

    const session = {
        client: {
            sessionId: 'session-1',
            getMetadata: () => ({}),
            rpcHandlerManager: {
                registerHandler: vi.fn(),
            },
            updateAgentState: (updater: (state: any) => any) => {
                agentState = updater(agentState);
            },
        },
        api: {
            push: () => ({
                sendSessionNotification: vi.fn(),
            }),
        },
        onPermissionRequest,
        onPermissionResolved,
    } as unknown as Session;

    return {
        session,
        onPermissionRequest,
        onPermissionResolved,
        getAgentState: () => agentState,
    };
}

const mode: EnhancedMode = { permissionMode: 'default' };

function startPendingRequest(handler: PermissionHandler, id: string) {
    const controller = new AbortController();
    const promise = handler.handleToolCall(
        'Write',
        { file_path: '/tmp/x', content: 'hi' },
        mode,
        { signal: controller.signal, toolUseID: id }
    ) as Promise<PermissionResult>;
    return { promise, controller };
}

describe('PermissionHandler.resolveExternally', () => {
    it('resolves a pending request with behavior allow and moves it to completedRequests', async () => {
        const { session, onPermissionRequest, onPermissionResolved, getAgentState } = createFakeSession();
        const handler = new PermissionHandler(session);

        const { promise } = startPendingRequest(handler, 'req-1');

        // Request should be pending and observers notified
        expect(onPermissionRequest).toHaveBeenCalledWith({
            id: 'req-1',
            toolName: 'Write',
            input: { file_path: '/tmp/x', content: 'hi' },
        });
        expect(getAgentState().requests['req-1']).toBeDefined();

        const resolved = handler.resolveExternally('req-1', { approved: true });
        expect(resolved).toBe(true);

        const result = await promise;
        expect(result.behavior).toBe('allow');

        // Request moved from pending to completed
        expect(getAgentState().requests['req-1']).toBeUndefined();
        expect(getAgentState().completedRequests['req-1']).toMatchObject({ status: 'approved' });
        expect(onPermissionResolved).toHaveBeenCalledWith('req-1');
    });

    it('resolves a pending request as deny when not approved', async () => {
        const { session, getAgentState } = createFakeSession();
        const handler = new PermissionHandler(session);

        const { promise } = startPendingRequest(handler, 'req-2');
        expect(handler.resolveExternally('req-2', { approved: false })).toBe(true);

        const result = await promise;
        expect(result.behavior).toBe('deny');
        expect(getAgentState().completedRequests['req-2']).toMatchObject({ status: 'denied' });
    });

    it('returns false for an unknown request id', () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        expect(handler.resolveExternally('does-not-exist', { approved: true })).toBe(false);
    });

    it('is first-response-wins: a second resolution returns false', async () => {
        const { session } = createFakeSession();
        const handler = new PermissionHandler(session);

        const { promise } = startPendingRequest(handler, 'req-3');
        expect(handler.resolveExternally('req-3', { approved: true })).toBe(true);
        await promise;
        expect(handler.resolveExternally('req-3', { approved: false })).toBe(false);
    });
});
