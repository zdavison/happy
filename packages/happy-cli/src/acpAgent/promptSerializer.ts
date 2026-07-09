/**
 * Serializes calls to a single async function so that only one is ever
 * in flight: each call's `run` starts only after the previous call's `run`
 * has settled (resolved OR rejected).
 *
 * Used to enforce "one turn in flight" on the downstream ACP `prompt` call.
 * `runAcpAgent.ts` has two independent sources that can call
 * `spawned.connection.prompt` -- the upstream ACP client (via
 * `HappyProxyAgent.prompt`) and the phone (via `relay.onUserMessage`) -- with
 * no coordination between them.
 * Wrapping the shared `prompt` call with this serializer guarantees the
 * downstream agent never sees two concurrent prompts, regardless of which
 * side triggered them.
 *
 * A prior call's rejection must not wedge the queue: the internal chain is
 * re-armed with a no-op `.catch` after every call so the next call always
 * gets to run, while each caller still observes its own call's real
 * resolution or rejection.
 */
export function createPromptSerializer<P, R>(run: (params: P) => Promise<R>): (params: P) => Promise<R> {
  let chain: Promise<unknown> = Promise.resolve();
  return (params) => {
    const result = chain.then(() => run(params), () => run(params));
    chain = result.catch(() => {});
    return result;
  };
}
