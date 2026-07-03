/**
 * Phone relay: Phase-1 (ACP-tier) tap mapper.
 *
 * Maps a raw ACP `SessionUpdate` directly into Happy `SessionEnvelope`s for
 * the phone, without going through Happy's internal `AgentMessage` layer.
 * This is a pure, best-effort mapping — it only handles the four core
 * variants exercised by the ACP proxy (text/thinking chunks and tool-call
 * start/end); everything else maps to `[]` and is left for the enrichment
 * done in later phases.
 *
 * Mirrors the envelope shapes built by `AcpSessionManager`
 * (`src/agent/acp/AcpSessionManager.ts`), which remains the source of truth
 * for `createEnvelope`/`turnOptions` usage.
 */
import { createEnvelope, type CreateEnvelopeOptions, type SessionEnvelope } from '@slopus/happy-wire';
import type { SessionUpdate } from '@agentclientprotocol/sdk';

function turnOptions(turnId: string | null, time: number): CreateEnvelopeOptions {
  return turnId ? { turn: turnId, time } : { time };
}

/**
 * Monotonic clock, mirroring `AcpSessionManager.nextTime()`: max(lastTime + 1, Date.now()).
 * Module-level so envelope ordering stays stable even if this pure function is
 * called multiple times within the same millisecond.
 */
let lastTime = 0;
function nextTime(): number {
  lastTime = Math.max(lastTime + 1, Date.now());
  return lastTime;
}

function buildToolTitle(toolName: string): string {
  return toolName;
}

function buildToolDescription(toolName: string): string {
  return `Running ${toolName}`;
}

/** Coerce ACP's `rawInput: unknown` into the record shape `tool-call-start` requires. */
function toArgsRecord(rawInput: unknown): Record<string, unknown> {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return rawInput as Record<string, unknown>;
  }
  return {};
}

/**
 * Maps a raw ACP `SessionUpdate` into zero or more Happy `SessionEnvelope`s
 * for the phone. Pure function: no I/O, no console output.
 */
export function sessionUpdateToEnvelopes(update: SessionUpdate, turnId: string | null): SessionEnvelope[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text') {
        return [];
      }
      return [createEnvelope('agent', { t: 'text', text: update.content.text }, turnOptions(turnId, nextTime()))];
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') {
        return [];
      }
      return [createEnvelope('agent', { t: 'text', text: update.content.text, thinking: true }, turnOptions(turnId, nextTime()))];
    }
    case 'tool_call': {
      return [createEnvelope('agent', {
        t: 'tool-call-start',
        call: update.toolCallId,
        name: update.title,
        title: buildToolTitle(update.title),
        description: buildToolDescription(update.title),
        args: toArgsRecord(update.rawInput),
      }, turnOptions(turnId, nextTime()))];
    }
    case 'tool_call_update': {
      if (update.status === 'completed' || update.status === 'failed') {
        return [createEnvelope('agent', { t: 'tool-call-end', call: update.toolCallId }, turnOptions(turnId, nextTime()))];
      }
      return [];
    }
    default:
      return [];
  }
}
