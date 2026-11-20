// Under Bun, `undici` is Bun's own stand-in: these agents construct, and its fetch ignores them.
import { type Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

// undici drops an idle socket after 4 s, and a call's turns come 15-40 s apart: the gate's
// requests each paid a new TLS session, ~1.4 s instead of ~0.5 s (packages/context/src/gate.ts).
const KEEP_ALIVE = { keepAliveTimeout: 90_000, keepAliveMaxTimeout: 600_000 } as const;

/**
 * Node's fetch as Bun's is: sockets kept 90 s across pauses, HTTP(S)_PROXY/NO_PROXY honored. An
 * entry that fetches calls it once at start; under Bun it does nothing harmful. It reads the proxy
 * variables then, so it runs after the .env applies.
 */
export function installHttpDefaults(): void {
  setGlobalDispatcher(new EnvHttpProxyAgent(KEEP_ALIVE));
}

const patient = new Map<number, Dispatcher>();

/**
 * The dispatcher for slow requests: headers and body may each take `timeoutMs` (undici's default
 * is 300 s), sockets and proxies as installHttpDefaults. One per timeout, made at its first use.
 * Pass as fetch's `dispatcher`.
 */
export function patientDispatcher(timeoutMs: number): Dispatcher {
  let dispatcher = patient.get(timeoutMs);
  if (dispatcher === undefined) {
    dispatcher = new EnvHttpProxyAgent({
      ...KEEP_ALIVE,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    patient.set(timeoutMs, dispatcher);
  }
  return dispatcher;
}
