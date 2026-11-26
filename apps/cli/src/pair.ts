// laplace-pair (`eidolon pair`): display a QR code and pairing link for connecting a remote Eidolon or mobile client.
import {
  abortableSleep,
  dataHome,
  errorText,
  jsRuntime,
  killTree,
  type Subprocess,
  serverEntry,
  spawnProcess,
} from "@eidolon/config";
import {
  renderPairingQrTerminal,
  resolveEffectiveRelayUrl,
  type SubspaceManager,
  type SubspaceStateSnapshot,
  SubspaceStore,
} from "@eidolon/subspace";
import { ArgparseExit, INT, type ParserSpec, parseArgs, parserError } from "./argparse.ts";
import { type CommandDeps, printer, reportExit, resolveIo } from "./io.ts";
import {
  probeRunningLocalServer,
  type RunningLocalServer,
  runDeviceLoginFlow,
} from "./subspace.ts";

/** EX_TEMPFAIL: local server exited so its supervisor restarts it on the same port. */
const RESTART_EXIT_CODE = 75;

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
    { dest: "wait", flags: ["--wait", "--no-wait"], kind: "boolean_optional", default: null },
    { dest: "json", flags: ["--json"], kind: "store_true" },
  ],
};

export interface PairDeps extends CommandDeps {
  readonly serverEntry?: string;
  readonly pollMs?: number;
}

function isListeningMessage(message: unknown): message is { kind: "listening"; port: number } {
  const value = message as { kind?: unknown; port?: unknown } | null;
  return (
    value?.kind === "listening" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
  );
}

export async function startHeadlessServer(
  signal?: AbortSignal,
  options: { readonly entry?: string } = {},
): Promise<{
  readonly server: RunningLocalServer;
  stop(): Promise<void>;
}> {
  const entry = options.entry ?? serverEntry();
  let currentChild: Subprocess | null = null;
  let stopping = false;
  let boundPort: number | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let stderrLines: string[] = [];
  let stderrDone: Promise<void> = Promise.resolve();

  const spawnChild = (port: number): Subprocess => {
    boundPort = null;
    exited = false;
    exitCode = null;
    stderrLines = [];
    const runtime = jsRuntime();
    const child = spawnProcess(
      [runtime.command, ...runtime.args, entry, "--host=127.0.0.1", `--port=${port}`, "--no-open"],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        ipc(message) {
          if (isListeningMessage(message)) boundPort = message.port;
        },
      },
    );
    currentChild = child;
    if (child.stderr !== null) {
      const decoder = new TextDecoder();
      stderrDone = (async () => {
        for await (const chunk of child.stderr!) {
          if (stderrLines.length < 40) stderrLines.push(decoder.decode(chunk, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail && stderrLines.length < 40) stderrLines.push(tail);
      })().catch(() => {});
    } else {
      stderrDone = Promise.resolve();
    }

    void child.exited.then(async (code) => {
      await stderrDone;
      if (currentChild !== child) return;
      if (code === RESTART_EXIT_CODE && !stopping && !signal?.aborted) {
        try {
          spawnChild(boundPort ?? 0);
          return;
        } catch (error) {
          stderrLines.push(errorText(error));
          exitCode = 1;
          exited = true;
          return;
        }
      }
      exitCode = code;
      exited = true;
    });
    return child;
  };

  const stop = async () => {
    stopping = true;
    const child = currentChild;
    if (child !== null) {
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
      await stderrDone;
    }
  };

  currentChild = spawnChild(0);

  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Cancelled before server started");
      if (exited) {
        await stderrDone;
        throw new Error(
          `Server exited with status ${exitCode ?? 1}: ${stderrLines.join("").trim()}`,
        );
      }
      const probed = await probeRunningLocalServer();
      if (probed !== null) {
        return {
          server: { ...probed.server, pid: probed.server.pid ?? currentChild?.pid ?? null },
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

export async function pairMain(argv: readonly string[], deps: PairDeps = {}): Promise<number> {
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
  let savedAuth: ReturnType<SubspaceStore["readRelayAuth"]> = null;
  let authReadFailed = false;
  try {
    savedAuth = store.readRelayAuth();
  } catch {
    authReadFailed = true;
    savedAuth = null;
  }
  if (relay && savedAuth === null) {
    try {
      const resolvedRelayUrl = resolveEffectiveRelayUrl(
        authReadFailed ? () => store.readSavedRelayUrl() : null,
      );
      const ok = await runDeviceLoginFlow({
        relayUrl: resolvedRelayUrl,
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
    if (explicitWait === false) {
      return reportExit(
        io,
        parserError(PAIR_PARSER, "--no-wait requires an already-running Eidolon server"),
      );
    }
    try {
      ownedServer = await startHeadlessServer(deps.signal, { entry: deps.serverEntry });
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
    const recordNewGrants = (snapshot: SubspaceStateSnapshot) => {
      for (const grant of snapshot.share.grants) {
        if (seenGrants.has(grant.id)) continue;
        seenGrants.add(grant.id);
        if (json) out(JSON.stringify({ event: "paired", grant }));
        else out(`Paired device: ${grant.clientName} (${grant.id})`);
      }
    };
    const pollMs = deps.pollMs ?? 2_000;
    while (!deps.signal?.aborted) {
      await abortableSleep(pollMs, deps.signal).catch(() => {});
      if (deps.signal?.aborted) break;
      const poll = await fetch(`${server.baseUrl}/api/local/subspace`, {
        headers: { authorization: `Bearer ${server.token}` },
        signal: deps.signal,
      }).catch(() => null);
      if (poll?.ok) {
        recordNewGrants((await poll.json()) as SubspaceStateSnapshot);
      } else if (!deps.signal?.aborted) {
        const reprobed = await probeRunningLocalServer();
        if (reprobed !== null) {
          server = reprobed.server;
          recordNewGrants(reprobed.subspace);
        }
      }
    }
    return 0;
  } finally {
    await ownedServer?.stop();
  }
}
