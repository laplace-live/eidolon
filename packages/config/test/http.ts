// A loopback HTTP server for a test's fakes: what Bun.serve({ fetch }) stood up, through srvx.
import { serve } from "srvx";

export interface ServedFetch {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

/** Serves `handler` on 127.0.0.1 at a free port; `url` has no trailing slash. */
export async function serveFetch(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<ServedFetch> {
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    reusePort: false,
    silent: true,
    gracefulShutdown: false,
    fetch: handler,
  });
  await server.ready();
  const address = server.node?.server?.address();
  if (typeof address !== "object" || address === null) throw new Error("serveFetch: not listening");
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: () => server.close(true),
  };
}
