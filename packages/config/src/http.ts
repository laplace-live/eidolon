// Under Bun, `undici` is Bun's own stand-in: these agents construct, and its fetch ignores them.
import { type Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Node's fetch as Bun's was: sockets kept 90 s across pauses, HTTP(S)_PROXY/NO_PROXY honored.
 * Each entry calls it once at start; under Bun it does nothing harmful. It reads the proxy
 * variables then, so it runs after the .env applies.
 */
export function installHttpDefaults(): void {
  // undici drops an idle socket after 4 s, and a call's turns come 15-40 s apart: the gate's
  // requests each paid a new TLS session, ~1.4 s instead of ~0.5 s (packages/context/src/gate.ts).
  setGlobalDispatcher(
    new EnvHttpProxyAgent({ keepAliveTimeout: 90_000, keepAliveMaxTimeout: 600_000 }),
  );
}

/**
 * A dispatcher for one slow request: headers and body may each take `timeoutMs` (undici's default
 * is 300 s), proxies as installHttpDefaults. Pass as fetch's `dispatcher`.
 */
export function patientDispatcher(timeoutMs: number): Dispatcher {
  return new EnvHttpProxyAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
}
