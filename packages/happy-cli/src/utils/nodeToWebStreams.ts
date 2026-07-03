/**
 * nodeToWebStreams - Convert Node.js streams to Web Streams
 *
 * Shared by any code that needs to bridge Node.js `Writable`/`Readable`
 * streams (e.g. a child process's stdio, or our own process's stdio) to the
 * Web Streams API expected by `@agentclientprotocol/sdk`'s `ndJsonStream`.
 */

import { Readable, Writable } from 'node:stream';
import { logger } from '@/ui/logger';

/**
 * Convert Node.js streams to Web Streams for ACP SDK
 *
 * NOTE: This function registers event handlers on stdout. If you also register
 * handlers directly on stdout (e.g., for logging), both will fire.
 */
export function nodeToWebStreams(
  stdin: Writable,
  stdout: Readable
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
  // Convert Node writable to Web WritableStream
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        const ok = stdin.write(chunk, (err) => {
          if (err) {
            logger.debug(`[AcpBackend] Error writing to stdin:`, err);
            reject(err);
          }
        });
        if (ok) {
          resolve();
        } else {
          stdin.once('drain', resolve);
        }
      });
    },
    close() {
      return new Promise((resolve) => {
        stdin.end(resolve);
      });
    },
    abort(reason) {
      stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
    }
  });

  // Convert Node readable to Web ReadableStream
  // Filter out non-JSON debug output from gemini CLI (experiments, flags, etc.)
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      stdout.on('end', () => {
        controller.close();
      });
      stdout.on('error', (err) => {
        logger.debug(`[AcpBackend] Stdout error:`, err);
        controller.error(err);
      });
    },
    cancel() {
      stdout.destroy();
    }
  });

  return { writable, readable };
}
