import { type ExecFileException, execFile } from "node:child_process";
import { createServer } from "node:net";
import { describe, expect, test } from "vitest";
import { BACKEND_RUNTIME_ARGS } from "../src/main/controller.ts";
import {
  createDesktopPermissions,
  type DesktopPermissionsHost,
  LOCAL_NETWORK_CONNECT_SCRIPT,
  type LocalNetworkChildRunner,
  normalizeLocalNetworkHost,
  permissionIdsForPlatform,
} from "../src/main/desktop-permissions.ts";

function makeHost(overrides: Partial<DesktopPermissionsHost> = {}): DesktopPermissionsHost & {
  readonly logs: string[];
  readonly openedUrls: string[];
  readonly askedMicrophone: number;
  readonly promptCalls: number;
  readonly spawned: {
    readonly file: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv | undefined;
  }[];
} {
  const logs: string[] = [];
  const openedUrls: string[] = [];
  const spawned: {
    readonly file: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv | undefined;
  }[] = [];
  let askedMicrophone = 0;
  let promptCalls = 0;

  const base = {
    platform: "darwin" as NodeJS.Platform,
    background: false,
    packaged: true,
    installedCopy: true,
    execPath: "/Applications/LAPLACE Eidolon.app/Contents/MacOS/LAPLACE Eidolon",
    env: { PATH: "/usr/bin" },
    log: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    getMediaStatus: () => "not-determined",
    askMicrophone: async () => {
      askedMicrophone++;
      return true;
    },
    isAccessibilityTrusted: () => false,
    getMacNotificationStatus: async () => "not-determined" as const,
    requestMacNotification: async () => "granted" as const,
    openExternal: async (url: string) => {
      openedUrls.push(url);
    },
    triggerLocalNetworkPrompt: async () => {
      promptCalls++;
    },
    now: () => 1_795_773_000_000,
    ...overrides,
  };

  return {
    ...base,
    logs,
    openedUrls,
    spawned,
    get askedMicrophone() {
      return askedMicrophone;
    },
    get promptCalls() {
      return promptCalls;
    },
    runChild:
      overrides.runChild ??
      ((file, args, options, callback) => {
        spawned.push({ file, args, env: options.env });
        callback(null, "", "");
      }),
  };
}

function failingChildRunner(
  error: Partial<ExecFileException>,
  stderr: string,
): LocalNetworkChildRunner {
  return (_file, _args, _options, callback) => {
    callback({ name: "Error", message: "failed", ...error } as ExecFileException, "", stderr);
  };
}

describe("permissionIdsForPlatform", () => {
  test("lists macOS, Windows, and unsupported platform permissions", () => {
    expect(permissionIdsForPlatform("darwin")).toEqual([
      "microphone",
      "notifications",
      "local-network",
      "screen",
      "accessibility",
    ]);
    expect(permissionIdsForPlatform("win32")).toEqual(["microphone", "notifications"]);
    expect(permissionIdsForPlatform("linux")).toEqual([]);
  });
});

describe("background mode", () => {
  test("touches no OS permission APIs, opens no Settings pane, and refuses network probes", async () => {
    let mediaReads = 0;
    let accessibilityChecks = 0;
    let notificationReads = 0;
    const host = makeHost({
      background: true,
      getMediaStatus: () => {
        mediaReads++;
        return "granted";
      },
      isAccessibilityTrusted: () => {
        accessibilityChecks++;
        return true;
      },
      getMacNotificationStatus: async () => {
        notificationReads++;
        return "granted";
      },
    });
    const perms = createDesktopPermissions(host);

    expect(await perms.permissions()).toEqual({
      background: true,
      items: [
        { id: "microphone", status: "unavailable", unavailable: "background" },
        { id: "notifications", status: "unavailable", unavailable: "background" },
        { id: "local-network", status: "unavailable", unavailable: "background" },
        { id: "screen", status: "unavailable", unavailable: "background" },
        { id: "accessibility", status: "unavailable", unavailable: "background" },
      ],
    });
    expect(await perms.requestPermission("microphone")).toEqual({
      id: "microphone",
      status: "unavailable",
      openedSettings: false,
      unavailable: "background",
    });
    expect(await perms.openPermissionSettings("local-network")).toBe(false);
    expect(await perms.testLocalNetwork({ host: "10.0.1.5", port: 63427 })).toEqual({
      ok: false,
      host: "10.0.1.5",
      port: 63427,
      testedAt: 1_795_773_000_000,
      failure: "background",
    });

    expect(mediaReads).toBe(0);
    expect(accessibilityChecks).toBe(0);
    expect(notificationReads).toBe(0);
    expect(host.askedMicrophone).toBe(0);
    expect(host.promptCalls).toBe(0);
    expect(host.openedUrls).toEqual([]);
    expect(host.spawned).toEqual([]);
    expect(host.logs).toEqual([
      "Eidolon: background mode didn't request microphone permission",
      "Eidolon: background mode didn't open local-network settings",
      "Eidolon: background mode didn't test local network connection",
    ]);
  });
});

describe("reading and requesting permissions", () => {
  test("macOS packaged copy reads UNUserNotificationCenter, media, and accessibility", async () => {
    const host = makeHost({
      getMediaStatus: (type) => (type === "microphone" ? "granted" : "denied"),
      getMacNotificationStatus: async () => "denied",
      isAccessibilityTrusted: () => true,
    });
    const perms = createDesktopPermissions(host);
    expect(await perms.permissions()).toEqual({
      background: false,
      items: [
        { id: "microphone", status: "granted" },
        { id: "notifications", status: "denied" },
        { id: "local-network", status: "unknown" },
        { id: "screen", status: "denied" },
        { id: "accessibility", status: "granted" },
      ],
    });
  });

  test("unpackaged macOS marks notifications unavailable and asks nothing", async () => {
    let queried = false;
    const host = makeHost({
      packaged: false,
      getMacNotificationStatus: async () => {
        queried = true;
        return "granted";
      },
    });
    const perms = createDesktopPermissions(host);
    const state = await perms.permissions();
    expect(state.items.find((item) => item.id === "notifications")).toEqual({
      id: "notifications",
      status: "unavailable",
      unavailable: "unpackaged",
    });
    expect(await perms.requestPermission("notifications")).toEqual({
      id: "notifications",
      status: "unavailable",
      openedSettings: false,
      unavailable: "unpackaged",
    });
    expect(queried).toBe(false);
  });

  test("Windows installed vs non-installed copy handles notifications and ms-settings URLs", async () => {
    const portable = createDesktopPermissions(
      makeHost({ platform: "win32", installedCopy: false, getMediaStatus: () => "granted" }),
    );
    expect(await portable.permissions()).toEqual({
      background: false,
      items: [
        { id: "microphone", status: "granted" },
        { id: "notifications", status: "unavailable", unavailable: "not-installed" },
      ],
    });
    expect(await portable.testLocalNetwork({ host: "10.0.1.5", port: 63427 })).toMatchObject({
      ok: false,
      failure: "unsupported",
    });

    const host = makeHost({
      platform: "win32",
      installedCopy: true,
      getMediaStatus: () => "denied",
    });
    const installed = createDesktopPermissions(host);
    expect(await installed.permissions()).toEqual({
      background: false,
      items: [
        { id: "microphone", status: "denied" },
        { id: "notifications", status: "unknown" },
      ],
    });
    expect(await installed.requestPermission("microphone")).toEqual({
      id: "microphone",
      status: "denied",
      openedSettings: true,
    });
    expect(await installed.requestPermission("notifications")).toEqual({
      id: "notifications",
      status: "unknown",
      openedSettings: true,
    });
    expect(host.openedUrls).toEqual([
      "ms-settings:privacy-microphone",
      "ms-settings:notifications",
    ]);
  });

  test("microphone requests when undecided and opens Privacy_Microphone when denied", async () => {
    const undecidedHost = makeHost({
      getMediaStatus: () => "not-determined",
      askMicrophone: async () => true,
    });
    expect(await createDesktopPermissions(undecidedHost).requestPermission("microphone")).toEqual({
      id: "microphone",
      status: "granted",
      openedSettings: false,
    });
    expect(undecidedHost.openedUrls).toEqual([]);

    const deniedHost = makeHost({
      getMediaStatus: () => "denied",
      askMicrophone: async () => {
        throw new Error("should not ask again when already denied");
      },
    });
    expect(await createDesktopPermissions(deniedHost).requestPermission("microphone")).toEqual({
      id: "microphone",
      status: "denied",
      openedSettings: true,
    });
    expect(deniedHost.openedUrls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    ]);
  });

  test("local-network prompt triggers multicast nudge and opens Local Network pane on ask", async () => {
    const host = makeHost();
    const perms = createDesktopPermissions(host);
    expect(await perms.requestPermission("local-network")).toEqual({
      id: "local-network",
      status: "unknown",
      openedSettings: false,
    });
    expect(host.promptCalls).toBe(1);
    expect(await perms.openPermissionSettings("local-network")).toBe(true);
    expect(host.openedUrls).toEqual([
      "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork",
    ]);
  });

  test("accessibility requests prompt first and open Privacy_Accessibility if still untrusted", async () => {
    const prompted: boolean[] = [];
    const host = makeHost({
      isAccessibilityTrusted: (prompt) => {
        prompted.push(prompt);
        return false;
      },
    });
    const perms = createDesktopPermissions(host);
    expect(await perms.requestPermission("accessibility")).toEqual({
      id: "accessibility",
      status: "unknown",
      openedSettings: true,
    });
    expect(prompted).toEqual([true, false]);
    expect(host.openedUrls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    ]);
  });
});

describe("testLocalNetwork", () => {
  test("accepts LAN IPs, link-local IPs, and hostnames while rejecting loopback and public IPs", () => {
    expect(normalizeLocalNetworkHost("10.0.1.5")).toBe("10.0.1.5");
    expect(normalizeLocalNetworkHost("172.16.0.1")).toBe("172.16.0.1");
    expect(normalizeLocalNetworkHost("192.168.1.20")).toBe("192.168.1.20");
    expect(normalizeLocalNetworkHost("169.254.1.2")).toBe("169.254.1.2");
    expect(normalizeLocalNetworkHost("[fe80::1%en0]")).toBe("fe80::1%en0");
    expect(normalizeLocalNetworkHost("[fd12:3456:789a::1]")).toBe("fd12:3456:789a::1");
    expect(normalizeLocalNetworkHost("asi.local")).toBe("asi.local");
    expect(normalizeLocalNetworkHost("asi.local.")).toBe("asi.local.");

    for (const bad of [
      "",
      "-invalid",
      "localhost",
      "localhost.",
      "foo.localhost",
      "foo.localhost.",
      "127.0.0.1",
      "::1",
      "0.0.0.0",
      "8.8.8.8",
      "100.64.0.1",
      "2001:4860:4860::8888",
      "http://10.0.1.5",
      "10.0.1.5/path",
      "10.0.1.5:63427",
      "asi.local:63427",
      "10.0.1.5%en0",
      "asi.local%en0",
      "[10.0.1.5]",
      "[fe80::1",
      "fe80::1]",
      "[fe80::1%]",
    ]) {
      expect(normalizeLocalNetworkHost(bad), bad).toBeNull();
    }
  });

  test("runs the probe through Electron's Node runtime and maps errno codes", async () => {
    const okHost = makeHost();
    const okResult = await createDesktopPermissions(okHost).testLocalNetwork({
      host: "10.0.1.5",
      port: 63427,
    });
    expect(okResult).toEqual({
      ok: true,
      host: "10.0.1.5",
      port: 63427,
      testedAt: 1_795_773_000_000,
    });
    expect(okHost.spawned).toHaveLength(1);
    expect(okHost.spawned[0]?.file).toBe(okHost.execPath);
    expect(okHost.spawned[0]?.args.slice(0, BACKEND_RUNTIME_ARGS.length)).toEqual(
      BACKEND_RUNTIME_ARGS,
    );
    expect(okHost.spawned[0]?.args.slice(-2)).toEqual(["10.0.1.5", "63427"]);
    expect(okHost.spawned[0]?.env?.ELECTRON_RUN_AS_NODE).toBe("1");

    const cases: readonly [string, string][] = [
      ["EHOSTUNREACH", "blocked"],
      ["ENETUNREACH", "blocked"],
      ["ECONNREFUSED", "refused"],
      ["ETIMEDOUT", "timeout"],
      ["ENOTFOUND", "unresolved"],
      ["INVALID_TARGET", "invalid-target"],
      ["EUNKNOWN", "failed"],
    ];
    for (const [stderr, expected] of cases) {
      const perms = createDesktopPermissions(
        makeHost({ runChild: failingChildRunner({ code: 1 } as never, stderr) }),
      );
      expect(await perms.testLocalNetwork({ host: "10.0.1.5", port: 63427 })).toEqual({
        ok: false,
        host: "10.0.1.5",
        port: 63427,
        testedAt: 1_795_773_000_000,
        failure: expected,
      });
    }
    const timedOut = createDesktopPermissions(
      makeHost({ runChild: failingChildRunner({ killed: true }, "") }),
    );
    expect(await timedOut.testLocalNetwork({ host: "10.0.1.5", port: 63427 })).toMatchObject({
      ok: false,
      failure: "timeout",
    });
  });

  test("LOCAL_NETWORK_CONNECT_SCRIPT rejects loopback sockets and inspects nested AggregateError codes", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected TCP address");

    try {
      const loopback = await new Promise<{
        readonly error: ExecFileException | null;
        readonly stderr: string;
      }>((resolve) => {
        execFile(
          process.execPath,
          ["-e", LOCAL_NETWORK_CONNECT_SCRIPT, "127.0.0.1", String(address.port)],
          { timeout: 5_000 },
          (error, _stdout, stderr) => resolve({ error, stderr }),
        );
      });
      expect(loopback.error).not.toBeNull();
      expect(loopback.error?.code).toBe(1);
      expect(loopback.stderr).toBe("INVALID_TARGET");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const runWithCodes = (codes: readonly string[]): LocalNetworkChildRunner => {
      const preload = `(() => {
        const net = require("node:net");
        const { EventEmitter } = require("node:events");
        net.createConnection = () => {
          const socket = new EventEmitter();
          socket.setTimeout = () => {};
          socket.destroy = () => {};
          process.nextTick(() => {
            const nested = ${JSON.stringify(codes)}.map((code) => Object.assign(new Error(code), { code }));
            socket.emit("error", Object.assign(new AggregateError(nested, "connect"), { code: nested[0]?.code }));
          });
          return socket;
        };
      })();\n`;
      return (_file, args, options, callback) => {
        const script = args.at(-3) ?? "";
        const target = args.slice(-2);
        execFile(
          process.execPath,
          ["-e", `${preload}${script}`, ...target],
          { timeout: options.timeout },
          callback,
        );
      };
    };

    const mixed = createDesktopPermissions(
      makeHost({ runChild: runWithCodes(["EHOSTUNREACH", "ECONNREFUSED"]) }),
    );
    expect(await mixed.testLocalNetwork({ host: "asi.local", port: 63427 })).toMatchObject({
      ok: false,
      failure: "refused",
    });

    const allBlocked = createDesktopPermissions(
      makeHost({ runChild: runWithCodes(["EHOSTUNREACH", "EHOSTUNREACH"]) }),
    );
    expect(await allBlocked.testLocalNetwork({ host: "asi.local", port: 63427 })).toMatchObject({
      ok: false,
      failure: "blocked",
    });
  });
});
