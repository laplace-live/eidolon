// laplace-pair (`eidolon pair`): display a QR code and pairing link for connecting a remote Eidolon or mobile client.
import {
  abortableSleep,
  dataHome,
  errorText,
  jsRuntime,
  killTree,
  serverEntry,
  spawnProcess,
} from "@eidolon/config";
import {
  renderPairingQrTerminal,
  type SubspaceManager,
  type SubspaceStateSnapshot,
  SubspaceStore,
  subspaceRelayUrl,
} from "@eidolon/subspace";
import { ArgparseExit, INT, type ParserSpec, parseArgs, parserError } from "./argparse.ts";
import { type CommandDeps, printer, reportExit, resolveIo } from "./io.ts";
import {
  probeRunningLocalServer,
  type RunningLocalServer,
  runDeviceLoginFlow,
} from "./subspace.ts";

const PROG = "laplace-pair";

const USAGE = `usage: ${PROG} [-h] [--relay] [--address HOST] [--port PORT] [--name NAME] [--rotate] [--wait | --no-wait] [--json]
`;

const HELP = `${USAGE}
Pair a remote LAPLACE Eidolon desktop or mobile client with this computer via Subspace.

If the Eidolon local/desktop app is already running on this data home, prints its
pairing link and QR code directly. Otherwise starts a headless Eidolon server in the
foreground until Ctrl-C.

options:
  -h, --help       show this help message and exit
  --relay          Pair through the signed-in Subspace Relay (default: direct network)
  --address HOST   IP or hostname to advertise in the Direct pairing link
  --port PORT      TCP port for Direct WebSocket connections
  --name NAME      Display name for this computer
  --rotate         Invalidate any active pairing link and generate a new one
  --wait           Stay running in the foreground watching for paired devices
  --no-wait        Print the pairing link and exit immediately (when attached to running app)
  --json           Write JSON output to stdout
`;

export const PAIR_PARSER: ParserSpec = {
  prog: PROG,
  usage: USAGE,
  help: HELP,
  actions: [
    { dest: "relay", flags: ["--relay"], kind: "store_true" },
    { dest: "address", flags: ["--address"], kind: "store" },
    { dest: "port", flags: ["--port"], kind: "store", type: INT },
    { dest: "name", flags: ["--name"], kind: "store" },
    { dest: "rotate", flags: ["--rotate"], kind: "store_true" },
    { dest: "wait", flags: ["--wait"], kind: "boolean_optional", default: null },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

async function startHeadlessServer(signal?: AbortSignal): Promise<{
  readonly server: RunningLocalServer;
  stop(): Promise<void>;
}> {
  const runtime = jsRuntime();
  const child = spawnProcess(
    [runtime.command, ...runtime.args, serverEntry(), "--host=127.0.0.1", "--port=0", "--no-open"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderrLines: string[] = [];
  if (child.stderr !== null) {
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of child.stderr!) {
        if (stderrLines.length < 40) stderrLines.push(decoder.decode(chunk, { stream: true }));
      }
    })().catch(() => {});
  }
  const stop = async () => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore already exited child.
      }
      await Promise.race([child.exited, new Promise<void>((r) => setTimeout(r, 2_000))]).catch(
        () => {},
      );
    }
    if (child.exitCode === null) killTree(child.pid, { wait: true });
    await child.exited.catch(() => {});
  };

  let exited = false;
  let exitCode: number | null = null;
  void child.exited.then((code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Cancelled before server started");
      if (exited) {
        throw new Error(
          `Server exited with status ${exitCode ?? 1}: ${stderrLines.join("").trim()}`,
        );
      }
      const probed = await probeRunningLocalServer();
      if (probed !== null) {
        return {
          server: { ...probed.server, pid: probed.server.pid ?? child.pid ?? null },
          stop,
        };
      }
      await abortableSleep(200, signal);
    }
    throw new Error("Timed out waiting for local Eidolon server to start");
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function pairMain(argv: readonly string[], deps: CommandDeps = {}): Promise<number> {
  const io = resolveIo(deps);
  const out = printer(io.stdout);
  const err = printer(io.stderr);
  let ns: Record<string, unknown>;
  try {
    ns = parseArgs(PAIR_PARSER, argv);
  } catch (error) {
    if (error instanceof ArgparseExit) return reportExit(io, error);
    throw error;
  }

  const relay = Boolean(ns.relay);
  const address =
    typeof ns.address === "string" && ns.address.trim() ? ns.address.trim() : undefined;
  const port = typeof ns.port === "number" ? ns.port : undefined;
  const name = typeof ns.name === "string" && ns.name.trim() ? ns.name.trim() : undefined;
  const rotate = Boolean(ns.rotate);
  const json = Boolean(ns.json);
  const explicitWait = ns.wait as boolean | null;

  if (port !== undefined && (port < 0 || port > 65535)) {
    return reportExit(io, parserError(PAIR_PARSER, `--port ${port} must be between 0 and 65535`));
  }

  const store = new SubspaceStore(dataHome());
  if (relay && store.readRelayAuth() === null) {
    try {
      const ok = await runDeviceLoginFlow({
        relayUrl: subspaceRelayUrl(),
        store,
        json,
        out,
        signal: deps.signal,
      });
      if (!ok) return deps.signal?.aborted ? 130 : 1;
    } catch (error) {
      err(`Relay sign-in failed: ${errorText(error)}`);
      return 1;
    }
  }

  const existing = await probeRunningLocalServer();
  let ownedServer: { readonly server: RunningLocalServer; stop(): Promise<void> } | null = null;
  let server: RunningLocalServer;

  if (existing !== null) {
    server = existing.server;
  } else {
    try {
      ownedServer = await startHeadlessServer(deps.signal);
      server = ownedServer.server;
    } catch (error) {
      err(`Could not start local Eidolon server: ${errorText(error)}`);
      return deps.signal?.aborted ? 130 : 1;
    }
  }

  try {
    let result: Awaited<ReturnType<SubspaceManager["createShareOffer"]>>;
    try {
      if (name !== undefined) {
        const settingsRes = await fetch(`${server.baseUrl}/api/local/subspace/share/settings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${server.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ hostName: name }),
          signal: deps.signal,
        });
        if (!settingsRes.ok) {
          err(`Could not update host name: ${await settingsRes.text()}`);
          return 1;
        }
      }

      const offerRes = await fetch(`${server.baseUrl}/api/local/subspace/share/offer`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode: relay ? "relay" : "direct",
          ...(address !== undefined ? { address } : {}),
          ...(port !== undefined ? { port } : {}),
          rotate,
        }),
        signal: deps.signal,
      });
      if (!offerRes.ok) {
        err(`Could not generate pairing offer: ${await offerRes.text()}`);
        return 1;
      }
      result = (await offerRes.json()) as Awaited<ReturnType<SubspaceManager["createShareOffer"]>>;
    } catch (error) {
      if (deps.signal?.aborted) return 130;
      err(`Could not prepare pairing offer: ${errorText(error)}`);
      return 1;
    }
    const seenGrants = new Set(result.state.share.grants.map((g) => g.id));

    if (json) {
      out(
        JSON.stringify({
          event: "offer",
          mode: relay ? "relay" : "direct",
          hostName: result.state.share.hostName,
          pairingUrl: result.pairingUrl,
          pairingCode: result.pairingCode,
          expiresAt: result.expiresAt,
          listeningPort: result.state.share.listeningPort,
          relayConnected: result.state.share.relayConnected,
        }),
      );
    } else {
      out(`Subspace pairing ready (${relay ? "Subspace Relay" : "Direct Network"})`);
      out(`Host: ${result.state.share.hostName}`);
      if (!relay && result.state.share.listeningPort !== null) {
        out(`Listening on port ${result.state.share.listeningPort}`);
      }
      out("");
      out(renderPairingQrTerminal(result.pairingUrl));
      out("");
      out(`Pairing Link: ${result.pairingUrl}`);
      out(`Pairing Code: ${result.pairingCode}`);
      out(`Expires: ${new Date(result.expiresAt).toLocaleString()}`);
    }

    const shouldWait = explicitWait ?? ownedServer !== null;
    if (!shouldWait) return 0;

    if (!json) {
      out("");
      out("Waiting for clients to pair… Press Ctrl-C to stop.");
    }
    while (!deps.signal?.aborted) {
      await abortableSleep(2_000, deps.signal).catch(() => {});
      if (deps.signal?.aborted) break;
      const poll = await fetch(`${server.baseUrl}/api/local/subspace`, {
        headers: { authorization: `Bearer ${server.token}` },
        signal: deps.signal,
      }).catch(() => null);
      if (poll?.ok) {
        const snapshot = (await poll.json()) as SubspaceStateSnapshot;
        for (const grant of snapshot.share.grants) {
          if (seenGrants.has(grant.id)) continue;
          seenGrants.add(grant.id);
          if (json) out(JSON.stringify({ event: "paired", grant }));
          else out(`Paired device: ${grant.clientName} (${grant.id})`);
        }
      }
    }
    return 0;
  } finally {
    await ownedServer?.stop();
  }
}
