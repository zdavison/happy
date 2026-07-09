import { describe, it, expect } from 'vitest';
import { stripTerminal } from './runAcpAgent';
import type { InitializeRequest } from '@agentclientprotocol/sdk';

describe('stripTerminal', () => {
  it('removes clientCapabilities.terminal but keeps fs', () => {
    const req = {
      protocolVersion: 1,
      clientCapabilities: {
        terminal: true,
        fs: { readTextFile: true, writeTextFile: true },
      },
    } as unknown as InitializeRequest;

    const out = stripTerminal(req);

    expect(out.clientCapabilities?.terminal).toBeUndefined();
    expect(out.clientCapabilities?.fs).toEqual({ readTextFile: true, writeTextFile: true });
    // original is untouched (deep clone)
    expect(req.clientCapabilities?.terminal).toBe(true);
  });

  it('is a no-op when clientCapabilities is absent', () => {
    const req = { protocolVersion: 1 } as unknown as InitializeRequest;
    const out = stripTerminal(req);
    expect(out.clientCapabilities).toBeUndefined();
  });
});
