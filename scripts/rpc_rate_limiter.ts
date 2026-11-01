// Shared adaptive RPC pacing for scanner workflows.
// Four consecutive failed RPC requests trigger a 3-second pause and reduce
// the sustained request rate by one per second, down to one request/second.
export function createAdaptiveRpcFetch(initialRps = 10) {
  let rps = Math.max(1, Math.min(10, Math.floor(initialRps)));
  let failures = 0;
  let nextAllowedAt = 0;
  let queue: Promise<void> = Promise.resolve();
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  async function acquire(): Promise<() => void> {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const wait = Math.max(0, nextAllowedAt - Date.now());
    if (wait) await sleep(wait);
    nextAllowedAt = Date.now() + Math.ceil(1000 / rps);
    return release;
  }

  return async function fetchWithPacing(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const release = await acquire();
    try {
      const response = await fetch(input, init);
      let failed = !response.ok;
      if (!failed) {
        try {
          const body: any = await response.clone().json();
          const hasRpcError = (value: any): boolean => Array.isArray(value)
            ? value.some(hasRpcError)
            : Boolean(value && typeof value === "object" && value.error);
          failed = hasRpcError(body);
        } catch { /* Non-JSON success bodies are not JSON-RPC failures. */ }
      }
      if (failed) failures++; else failures = 0;
      if (failures > 3) {
        await sleep(3000);
        rps = Math.max(1, rps - 1);
        failures = 0;
        console.warn(`RPC adaptive limiter: paused 3s; request rate reduced to ${rps}/s`);
      }
      return response;
    } catch (error) {
      failures++;
      if (failures > 3) {
        await sleep(3000);
        rps = Math.max(1, rps - 1);
        failures = 0;
        console.warn(`RPC adaptive limiter: paused 3s; request rate reduced to ${rps}/s`);
      }
      throw error;
    } finally { release(); }
  };
}
