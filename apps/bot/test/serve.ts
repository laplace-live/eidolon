// A test's server, on the bot's own routing.
import { type Fallback, listen, type Routes, routeRequest } from "../src/routing.ts";

export interface ServedRoutes {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Serves `routes` on 127.0.0.1 at a free port, `fallback` (else a bare 404) for the rest. */
export async function serveRoutes(
  routes: Routes,
  fallback: Fallback = () => new Response(null, { status: 404 }),
): Promise<ServedRoutes> {
  const listener = await listen({
    hostname: "127.0.0.1",
    port: 0,
    handle: routeRequest(routes, fallback),
    onError: (error) => {
      console.error(error);
      return new Response(null, { status: 500 });
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    port: listener.port,
    stop: () => listener.stop(),
  };
}
