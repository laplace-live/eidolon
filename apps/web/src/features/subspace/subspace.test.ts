import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { createElement, Fragment, type FunctionComponent, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Router, type RouterOptions, useLocation } from "wouter";
import type { SubspaceStateResponse } from "@/lib/api";
import { createBrowserHistory } from "@/lib/navigation";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const mockCall = vi.fn();
let actualSend!: typeof import("@/lib/api").send;
let actualCall!: typeof import("@/lib/api").call;
let actualBytes!: typeof import("@/lib/api").bytes;
vi.doMock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  actualSend = actual.send;
  actualCall = actual.call;
  actualBytes = actual.bytes;
  return { ...actual, call: mockCall };
});

const inputChangeHandlers = new Map<string, (event: { target: { value: string } }) => void>();
const buttonProps: {
  readonly text: string;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}[] = [];
let selectValueHandler: ((value: string) => void) | undefined;
let switchCheckedHandler: ((checked: boolean) => void) | undefined;
const dropdownSelectHandlers = new Map<string, () => void>();
let dropdownCloseHandler: ((event: { preventDefault(): void }) => void) | undefined;
const toastSuccess = vi.fn();
const toastErrorSpy = vi.fn();

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    return textOf((node as { readonly props?: { readonly children?: ReactNode } }).props?.children);
  }
  return "";
}

vi.doMock("sonner", () => ({
  toast: { success: toastSuccess, error: toastErrorSpy },
}));
vi.doMock("@/components/ui/button", () => ({
  Button: (props: {
    readonly type?: "button" | "submit" | "reset";
    readonly disabled?: boolean;
    readonly asChild?: boolean;
    readonly onClick?: () => void;
    readonly children?: ReactNode;
  }) => {
    if (props.asChild) return props.children ?? null;
    const text = textOf(props.children).trim();
    buttonProps.push({ text, disabled: props.disabled, onClick: props.onClick });
    return createElement(
      "button",
      { type: props.type ?? "button", disabled: props.disabled },
      props.children,
    );
  },
}));
vi.doMock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  AlertDialogAction: ({ children }: { readonly children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  AlertDialogCancel: ({ children }: { readonly children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  AlertDialogContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  AlertDialogDescription: ({ children }: { readonly children?: ReactNode }) =>
    createElement("p", null, children),
  AlertDialogFooter: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  AlertDialogHeader: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  AlertDialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", null, children),
}));
vi.doMock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { readonly open: boolean; readonly children?: ReactNode }) =>
    open ? createElement("div", { "data-dialog": "open" }, children) : null,
  DialogContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogDescription: ({ children }: { readonly children?: ReactNode }) =>
    createElement("p", null, children),
  DialogFooter: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogHeader: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DialogTitle: ({ children }: { readonly children?: ReactNode }) =>
    createElement("h2", null, children),
}));
vi.doMock("@/components/ui/switch", () => ({
  Switch: (props: {
    readonly id?: string;
    readonly checked?: boolean;
    readonly disabled?: boolean;
    readonly onCheckedChange?: (checked: boolean) => void;
  }) => {
    switchCheckedHandler = props.onCheckedChange;
    return createElement("button", {
      type: "button",
      role: "switch",
      "aria-checked": props.checked,
      disabled: props.disabled,
    });
  },
}));
vi.doMock("@/components/ui/input", () => ({
  Input: (props: {
    readonly id?: string;
    readonly value?: string;
    readonly placeholder?: string;
    readonly onChange?: (event: { target: { value: string } }) => void;
  }) => {
    if (props.id && props.onChange) inputChangeHandlers.set(props.id, props.onChange);
    return createElement("input", {
      id: props.id,
      "data-value": props.value ?? "",
      placeholder: props.placeholder,
    });
  },
}));
vi.doMock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    readonly children?: ReactNode;
    readonly onValueChange?: (value: string) => void;
  }) => {
    selectValueHandler = onValueChange;
    return createElement("div", null, children);
  },
  SelectContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectItem: ({ children, value }: { readonly children?: ReactNode; readonly value: string }) =>
    createElement("div", { "data-select-value": value }, children),
  SelectTrigger: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  SelectValue: () => null,
}));
vi.doMock("@/components/ui/toggle-group", () => ({
  ToggleGroup: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  ToggleGroupItem: ({ children }: { readonly children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
}));
vi.doMock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({
    children,
    onCloseAutoFocus,
  }: {
    readonly children?: ReactNode;
    readonly onCloseAutoFocus?: (event: { preventDefault(): void }) => void;
  }) => {
    if (onCloseAutoFocus) dropdownCloseHandler = onCloseAutoFocus;
    return createElement("div", null, children);
  },
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    readonly children?: ReactNode;
    readonly onSelect?: () => void;
  }) => {
    if (onSelect) dropdownSelectHandlers.set(textOf(children).trim(), onSelect);
    return createElement("div", null, children);
  },
  DropdownMenuLabel: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioGroup: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuRadioItem: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuSeparator: () => null,
}));
vi.doMock("@/features/call/call-context", () => ({
  useCallPresence: () => ({ up: false }),
}));

const { ShareCard } = await import("./share-card");
const { AddSubspaceServerDialog } = await import("./add-server-dialog");
const { ServersCard } = await import("./servers-card");
const {
  resetHostCacheAndRoute,
  subspaceQuery,
  useCreateShareOffer,
  usePairSubspaceServer,
  useRemoveSubspaceServer,
  useSubspaceHostEpoch,
  useSubspaceHostSync,
  useSwitchSubspaceHost,
} = await import("./queries");
const { SubspaceSwitcher } = await import("@/components/subspace-switcher");
const { RouteError } = await import("@/components/route-error");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { resetExpectedSubspaceHost, send, StaleHostMutationError } = await import("@/lib/api");
const { toastError } = await import("@/lib/feedback");

function findFormOnSubmit(root: unknown): ((event: { preventDefault(): void }) => void) | null {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as
      | {
          readonly tagName?: string;
          readonly childNodes?: unknown[];
          readonly [k: string]: unknown;
        }
      | undefined;
    if (!node) continue;
    if (node.tagName === "FORM") {
      const propsKey = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      const onSubmit = propsKey
        ? (node[propsKey] as { readonly onSubmit?: (event: { preventDefault(): void }) => void })
            ?.onSubmit
        : undefined;
      if (onSubmit) return onSubmit;
    }
    if (Array.isArray(node.childNodes)) queue.push(...node.childNodes);
  }
  return null;
}

function makeState(overrides: Partial<SubspaceStateResponse> = {}): SubspaceStateResponse {
  return {
    activeHostId: null,
    servers: [],
    share: {
      hostName: "Studio Mac",
      shareMode: "direct",
      directPort: 45123,
      directAddress: "192.0.2.50",
      addresses: [{ address: "192.168.1.10", interfaceName: "en0", kind: "lan" }],
      listening: false,
      listeningPort: null,
      relayConnected: false,
      relayError: null,
      activeOffer: null,
      grants: [],
    },
    relayAuth: {
      authUrl: "https://id.laplace.live",
      relayUrl: "https://eidolon-relay.vrp.moe",
      status: "signed-out",
      user: null,
      deviceFlow: {
        status: "idle",
        userCode: null,
        verificationUri: null,
        verificationUriComplete: null,
        expiresAt: null,
        error: null,
      },
    },
    ...overrides,
  };
}

describe("Subspace web UI regressions", () => {
  let mounted: MountedRoot | null = null;

  afterEach(async () => {
    inputChangeHandlers.clear();
    buttonProps.length = 0;
    selectValueHandler = undefined;
    switchCheckedHandler = undefined;
    dropdownSelectHandlers.clear();
    dropdownCloseHandler = undefined;
    toastSuccess.mockReset();
    toastErrorSpy.mockReset();
    mockCall.mockReset();
    resetExpectedSubspaceHost();
    vi.restoreAllMocks();
    if (mounted !== null) {
      const current = mounted;
      mounted = null;
      await current.unmount();
    }
  });

  test("ShareCard preserves unsaved customHost edits across background subspaceQuery refetches", async () => {
    const client = new QueryClient();
    const initial = makeState();
    client.setQueryData(subspaceQuery.queryKey, initial);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });

    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(ShareCard)),
      ),
    );
    expect(mounted.container.innerHTML).toContain('data-value="192.0.2.50"');

    const customChange = [...inputChangeHandlers.entries()].find(([id]) => {
      const idx = mounted!.container.innerHTML.indexOf(`id="${id}"`);
      return (
        idx !== -1 &&
        mounted!.container.innerHTML.slice(idx, idx + 120).includes('placeholder="100.x.y.z"')
      );
    })?.[1];
    expect(customChange).toBeDefined();

    await mounted.act(() => {
      customChange!({ target: { value: "100.64.0.99" } });
    });
    expect(mounted.container.innerHTML).toContain('data-value="100.64.0.99"');

    // Simulate a background refetch changing another share field (e.g. listening: true).
    await mounted.act(() => {
      client.setQueryData(
        subspaceQuery.queryKey,
        makeState({ share: { ...initial.share, listening: true, listeningPort: 45123 } }),
      );
    });
    expect(mounted.container.innerHTML).toContain('data-value="100.64.0.99"');
  });

  test("SubspaceSwitcher renders error servers with bg-destructive dot", () => {
    const client = new QueryClient();
    client.setQueryData(
      subspaceQuery.queryKey,
      makeState({
        servers: [
          {
            id: "srv_err",
            name: "Broken Peer",
            mode: "direct",
            endpoint: { host: "10.0.0.5", port: 45123 },
            relay: null,
            addedAt: 1,
            lastConnectedAt: null,
            lastVersion: null,
            connectionState: "error",
            lastError: "Connection refused",
            latencyMs: null,
          },
        ],
      }),
    );
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { ssrPath: "/" },
            createElement(
              SidebarProvider,
              null,
              createElement(SubspaceSwitcher, { side: "right" }),
            ),
          ),
        ),
      ),
    );
    expect(html).toContain("Broken Peer");
    expect(html).toContain("bg-destructive");
    expect(html).not.toContain("bg-muted-foreground");
  });

  test("useRemoveSubspaceServer cancels queries and resets host-scoped route when deleting the active server", async () => {
    const client = new QueryClient();
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const removeSpy = vi.spyOn(client, "removeQueries");
    client.setQueryData(
      subspaceQuery.queryKey,
      makeState({
        activeHostId: "srv_1",
        servers: [
          {
            id: "srv_1",
            name: "Remote Studio",
            mode: "direct",
            endpoint: { host: "10.0.0.5", port: 45123 },
            relay: null,
            addedAt: 1,
            lastConnectedAt: null,
            lastVersion: null,
            connectionState: "connected",
            lastError: null,
            latencyMs: 5,
          },
        ],
      }),
    );
    mockCall.mockResolvedValueOnce(makeState({ activeHostId: null, servers: [] }));

    const history = createBrowserHistory(null);
    history.navigate("/chats/chat_remote_1");
    let triggerRemove!: (id: string) => Promise<SubspaceStateResponse>;

    function Harness() {
      const [path] = useLocation();
      const mutation = useRemoveSubspaceServer();
      triggerRemove = (id: string) => mutation.mutateAsync(id);
      return createElement("span", null, path);
    }

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(Harness),
          ),
        ),
      ),
    );
    expect(mounted.container.textContent).toBe("/chats/chat_remote_1");

    await mounted.act(async () => {
      await triggerRemove("srv_1");
    });

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(mounted.container.textContent).toBe("/chats");
    history.dispose();
  });

  test("SubspaceSwitcher syncs expectedSubspaceHost and resets host-scoped route on cross-tab switch without double-resetting local switches", async () => {
    const client = new QueryClient();
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const removeSpy = vi.spyOn(client, "removeQueries");
    const remoteServer = {
      id: "srv_1",
      name: "Remote Studio",
      mode: "direct" as const,
      endpoint: { host: "10.0.0.5", port: 45123 },
      relay: null,
      addedAt: 1,
      lastConnectedAt: null,
      lastVersion: null,
      connectionState: "connected" as const,
      lastError: null,
      latencyMs: 5,
    };
    const initialState = makeState({ activeHostId: null, servers: [remoteServer] });
    client.setQueryData(subspaceQuery.queryKey, initialState);
    mockCall.mockImplementation(async (route: string) => {
      if (route === "GET /api/local/subspace") return initialState;
      return initialState;
    });

    const history = createBrowserHistory(null);
    history.navigate("/chats/chat_local_1");
    let switchHost!: (hostId: string | null) => Promise<SubspaceStateResponse>;

    function Harness() {
      const [path] = useLocation();
      const mutation = useSwitchSubspaceHost();
      switchHost = (hostId: string | null) => mutation.mutateAsync(hostId);
      return createElement(
        SidebarProvider,
        null,
        createElement(SubspaceSwitcher, { side: "right" }),
        createElement("span", { id: "loc" }, path),
      );
    }

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(Harness),
          ),
        ),
      ),
    );
    expect(mounted.container.innerHTML).toContain("/chats/chat_local_1");
    expect(mounted.container.innerHTML).toContain("Remote Studio");

    // Cross-tab switch via background subspaceQuery update resets cache & route and updates header.
    const switchedState = makeState({ activeHostId: "srv_1", servers: [remoteServer] });
    mockCall.mockImplementation(async (route: string) => {
      if (route === "GET /api/local/subspace") return switchedState;
      return switchedState;
    });
    await mounted.act(async () => {
      client.setQueryData(subspaceQuery.queryKey, switchedState);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mounted.container.innerHTML).toContain("Active Subspace Server: Remote Studio");
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(mounted.container.innerHTML).toContain("/chats");
    expect(mounted.container.innerHTML).not.toContain("/chats/chat_local_1");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    await send("POST /api/local/chats/:id/stop", { params: { id: "c1" } });
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("X-Eidolon-Expected-Host")).toBe(
      "srv_1",
    );

    // Switching back in this tab only calls resetHostCacheAndRoute once (not twice via effect).
    mockCall.mockResolvedValueOnce(initialState);
    await mounted.act(async () => {
      await switchHost(null);
    });
    expect(cancelSpy).toHaveBeenCalledTimes(2);
    expect(removeSpy).toHaveBeenCalledTimes(2);
    await send("POST /api/local/chats/:id/stop", { params: { id: "c1" } });
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get("X-Eidolon-Expected-Host")).toBe(
      "local",
    );
    history.dispose();
  });

  test("AddSubspaceServerDialog toasts paired server name by pairedServerId even when activate is false", async () => {
    const client = new QueryClient();
    const initial = makeState();
    client.setQueryData(subspaceQuery.queryKey, initial);
    const serverA = {
      id: "srv_existing",
      name: "Existing Box",
      mode: "direct" as const,
      endpoint: { host: "10.0.0.1", port: 45123 },
      relay: null,
      addedAt: 1,
      lastConnectedAt: null,
      lastVersion: null,
      connectionState: "connected" as const,
      lastError: null,
      latencyMs: 5,
    };
    const serverNew = { ...serverA, id: "srv_new", name: "Studio Mac Mini" };
    mockCall.mockImplementation(async (route: string) => {
      if (route === "POST /api/local/subspace/servers") {
        return {
          ...makeState({ activeHostId: null, servers: [serverNew, serverA] }),
          pairedServerId: "srv_new",
        };
      }
      return initial;
    });

    const history = createBrowserHistory(null);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(AddSubspaceServerDialog, { open: true, onOpenChange: () => {} }),
          ),
        ),
      ),
    );
    try {
      const codeHandler = [...inputChangeHandlers.entries()].find(([id]) => {
        const idx = mounted!.container.innerHTML.indexOf(`id="${id}"`);
        return (
          idx !== -1 &&
          mounted!.container.innerHTML.slice(idx, idx + 120).includes('placeholder="eidolon://pair')
        );
      })?.[1];
      expect(codeHandler).toBeDefined();
      expect(switchCheckedHandler).toBeDefined();

      await mounted.act(() => {
        codeHandler!({ target: { value: "eidolon://pair?code=abc" } });
        switchCheckedHandler!(false);
      });
      const onSubmit = findFormOnSubmit(mounted.container);
      expect(onSubmit).not.toBeNull();
      await mounted.act(async () => {
        onSubmit!({ preventDefault() {} });
      });

      expect(mockCall).toHaveBeenCalledWith("POST /api/local/subspace/servers", {
        body: { code: "eidolon://pair?code=abc", name: undefined, activate: false },
      });
      expect(toastSuccess).toHaveBeenCalledWith("Paired with Studio Mac Mini.");
    } finally {
      history.dispose();
    }
  });

  test("ShareCard refreshes pairing offer immediately when directAddress changes via selectAddress or applyCustomHost", async () => {
    const client = new QueryClient();
    const initial = makeState();
    client.setQueryData(subspaceQuery.queryKey, initial);
    mockCall.mockImplementation(async (route: string) => {
      if (route === "POST /api/local/subspace/share/settings") return initial;
      if (route === "POST /api/local/subspace/share/offer") {
        return {
          pairingUrl: "eidolon://pair?code=new",
          pairingCode: "new",
          qrSvg: "<svg/>",
          expiresAt: Date.now() + 60_000,
          state: initial,
        };
      }
      return initial;
    });

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(ShareCard)),
      ),
    );

    const customChange = [...inputChangeHandlers.entries()].find(([id]) => {
      const idx = mounted!.container.innerHTML.indexOf(`id="${id}"`);
      return (
        idx !== -1 &&
        mounted!.container.innerHTML.slice(idx, idx + 120).includes('placeholder="100.x.y.z"')
      );
    })?.[1];
    expect(customChange).toBeDefined();

    mockCall.mockClear();
    await mounted.act(() => {
      customChange!({ target: { value: "100.64.0.99" } });
    });
    const applyBtn = buttonProps.findLast((b) => b.text === "Apply");
    expect(applyBtn?.onClick).toBeDefined();
    await mounted.act(async () => {
      applyBtn!.onClick!();
    });

    expect(mockCall).toHaveBeenNthCalledWith(1, "POST /api/local/subspace/share/settings", {
      body: { directAddress: "100.64.0.99" },
    });
    expect(mockCall).toHaveBeenNthCalledWith(2, "POST /api/local/subspace/share/offer", {
      body: { mode: "direct", address: "100.64.0.99" },
    });

    mockCall.mockClear();
    expect(selectValueHandler).toBeDefined();
    await mounted.act(async () => {
      selectValueHandler!("192.168.1.10");
    });

    expect(mockCall).toHaveBeenNthCalledWith(1, "POST /api/local/subspace/share/settings", {
      body: { directAddress: "192.168.1.10" },
    });
    expect(mockCall).toHaveBeenNthCalledWith(2, "POST /api/local/subspace/share/offer", {
      body: { mode: "direct", address: "192.168.1.10" },
    });
  });

  test("ServersCard EditServerForm rejects non-integer or trailing-garbage port strings like 8080x and 80.9", async () => {
    const client = new QueryClient();
    const serversState = makeState({
      servers: [
        {
          id: "srv_edit",
          name: "Editable Peer",
          mode: "direct",
          endpoint: { host: "10.0.0.5", port: 45123 },
          relay: null,
          addedAt: 1,
          lastConnectedAt: null,
          lastVersion: null,
          connectionState: "connected",
          lastError: null,
          latencyMs: 5,
        },
      ],
    });
    client.setQueryData(subspaceQuery.queryKey, serversState);
    mockCall.mockResolvedValue(serversState);

    const history = createBrowserHistory(null);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(ServersCard),
          ),
        ),
      ),
    );
    try {
      const openEdit = dropdownSelectHandlers.get("Edit Server");
      expect(openEdit).toBeDefined();
      expect(dropdownCloseHandler).toBeDefined();
      await mounted.act(() => {
        openEdit!();
        dropdownCloseHandler!({ preventDefault() {} });
      });
      expect(mounted.container.innerHTML).toContain('data-value="45123"');

      const portHandler = [...inputChangeHandlers.entries()].find(([id]) =>
        mounted!.container.innerHTML.includes(`id="${id}" data-value="45123"`),
      )?.[1];
      expect(portHandler).toBeDefined();

      for (const badPort of ["8080x", "80.9", "0", "65536"]) {
        await mounted.act(() => {
          portHandler!({ target: { value: badPort } });
        });
        const saveBtn = buttonProps.findLast((b) => b.text === "Save");
        expect(saveBtn?.disabled).toBe(true);
      }

      await mounted.act(() => {
        portHandler!({ target: { value: "9000" } });
      });
      const saveBtn = buttonProps.findLast((b) => b.text === "Save");
      expect(saveBtn?.disabled).toBe(false);

      mockCall.mockResolvedValueOnce(makeState());
      const onSubmit = findFormOnSubmit(mounted.container);
      expect(onSubmit).not.toBeNull();
      await mounted.act(async () => {
        onSubmit!({ preventDefault() {} });
      });
      expect(mockCall).toHaveBeenCalledWith("PATCH /api/local/subspace/servers/:id", {
        params: { id: "srv_edit" },
        body: { name: "Editable Peer", host: "10.0.0.5", port: 9000 },
      });
    } finally {
      history.dispose();
    }
  });

  test("ServersCard and RouteError expose Disconnect when an active remote server is in error state", async () => {
    const baseServer = {
      id: "srv_err",
      name: "Unreachable Peer",
      mode: "direct" as const,
      endpoint: { host: "10.0.0.9", port: 45123 },
      relay: null,
      addedAt: 1,
      lastConnectedAt: null,
      lastVersion: null,
      lastError: "Connection failed",
      latencyMs: null,
    };
    const errState = makeState({
      activeHostId: "srv_err",
      servers: [{ ...baseServer, connectionState: "error" }],
    });
    const offlineState = makeState({
      activeHostId: "srv_err",
      servers: [{ ...baseServer, connectionState: "disconnected", lastError: null }],
    });

    const client = new QueryClient();
    client.setQueryData(subspaceQuery.queryKey, errState);
    mockCall.mockResolvedValue(offlineState);
    const history = createBrowserHistory(null);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });

    try {
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { hook: history.hook, searchHook: history.searchHook },
              createElement(ServersCard),
            ),
          ),
        ),
      );
      const disconnectMenuItem = dropdownSelectHandlers.get("Disconnect");
      expect(disconnectMenuItem).toBeDefined();
      await mounted.act(async () => {
        disconnectMenuItem!();
      });
      expect(mockCall).toHaveBeenCalledWith("POST /api/local/subspace/servers/:id/disconnect", {
        params: { id: "srv_err" },
      });

      await mounted.unmount();
      dropdownSelectHandlers.clear();
      buttonProps.length = 0;
      mockCall.mockClear();
      client.setQueryData(subspaceQuery.queryKey, offlineState);
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { hook: history.hook, searchHook: history.searchHook },
              createElement(ServersCard),
            ),
          ),
        ),
      );
      expect(dropdownSelectHandlers.has("Disconnect")).toBe(false);

      await mounted.unmount();
      dropdownSelectHandlers.clear();
      buttonProps.length = 0;
      client.setQueryData(subspaceQuery.queryKey, errState);
      mockCall.mockResolvedValue(offlineState);
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { hook: history.hook, searchHook: history.searchHook },
              createElement(RouteError, { error: new Error("host offline") }),
            ),
          ),
        ),
      );
      expect(buttonProps.some((b) => b.text === "Switch to This Computer")).toBe(true);
      expect(buttonProps.some((b) => b.text === "Open Subspace Settings")).toBe(true);
      const disconnectBtn = buttonProps.find((b) => b.text === "Disconnect");
      expect(disconnectBtn).toBeDefined();
      await mounted.act(async () => {
        disconnectBtn!.onClick?.();
      });
      expect(mockCall).toHaveBeenCalledWith("POST /api/local/subspace/servers/:id/disconnect", {
        params: { id: "srv_err" },
      });

      await mounted.unmount();
      buttonProps.length = 0;
      client.setQueryData(subspaceQuery.queryKey, offlineState);
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { hook: history.hook, searchHook: history.searchHook },
              createElement(RouteError, { error: new Error("host offline") }),
            ),
          ),
        ),
      );
      expect(buttonProps.some((b) => b.text === "Disconnect")).toBe(false);
    } finally {
      history.dispose();
    }
  });

  test("subspaceQuery queryFn arms expected host header and resetHostCacheAndRoute resets persona avatar cache versions", async () => {
    const { avatarSrc, avatarVersion } = await import("@/components/avatar/version");
    const { resetHostCacheAndRoute } = await import("./queries");

    const vBefore = avatarVersion("milky-green");
    const initialState = makeState({ activeHostId: "srv_remote_2" });
    mockCall.mockResolvedValueOnce(initialState);
    const client = new QueryClient();
    await client.fetchQuery(subspaceQuery);

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await send("PUT /api/local/settings", { body: {} });
    const reqInit = fetchSpy.mock.calls[0]?.[1];
    expect(
      (reqInit?.headers as Record<string, string> | undefined)?.["X-Eidolon-Expected-Host"],
    ).toBe("srv_remote_2");

    const navigate = vi.fn();
    const revalidate = vi.fn();
    await resetHostCacheAndRoute(client, "/chats/c1", navigate, revalidate);
    expect(navigate).toHaveBeenCalledWith("/chats", { replace: true });
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(avatarVersion("milky-green")).toBeGreaterThan(vBefore);
    expect(avatarSrc("milky-green", avatarVersion("milky-green"))).toContain("?v=");
  });

  test("cross-tab host switch bumps hostEpoch to discard stale Settings drafts and 409 conflict invalidates subspaceQuery", async () => {
    const client = new QueryClient();
    const initial = makeState({ activeHostId: null });
    mockCall.mockResolvedValueOnce(initial);
    await client.fetchQuery(subspaceQuery);

    // A background query poll with a new host must NOT silently overwrite expectedSubspaceHost
    // before useSubspaceHostSync resets local drafts.
    const switched = makeState({
      activeHostId: "srv_other",
      servers: [
        {
          id: "srv_other",
          name: "Other Box",
          mode: "direct",
          endpoint: { host: "10.0.0.2", port: 45123 },
          relay: null,
          addedAt: 1,
          lastConnectedAt: null,
          lastVersion: null,
          connectionState: "connected",
          lastError: null,
          latencyMs: 5,
        },
      ],
    });
    mockCall.mockResolvedValueOnce(switched);
    await client.fetchQuery({ ...subspaceQuery, queryFn: subspaceQuery.queryFn! });

    const preSyncSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "conflict", message: "Active Subspace server changed" },
        }),
        { status: 409 },
      ),
    );
    await expect(send("PUT /api/local/settings", { body: {} })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    expect(new Headers(preSyncSpy.mock.calls[0]?.[1]?.headers).get("X-Eidolon-Expected-Host")).toBe(
      "local",
    );

    // Reset back to initial before mounting the shell-level host sync harness.
    client.setQueryData(subspaceQuery.queryKey, initial);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    let setDraftExternal: ((val: string) => void) | null = null;
    let setDrawerOpenExternal: ((open: boolean) => void) | null = null;
    let pairServerExternal: ((code: string) => Promise<void>) | null = null;
    function DraftForm() {
      const [draft, setDraft] = useState("clean");
      setDraftExternal = setDraft;
      return createElement("div", { "data-draft": draft }, draft);
    }
    function DrawerSyncStub() {
      useSubspaceHostSync();
      return null;
    }
    function ShellHarness() {
      useSubspaceHostSync();
      const [drawerOpen, setDrawerOpen] = useState(true);
      const pair = usePairSubspaceServer();
      const hostEpoch = useSubspaceHostEpoch();
      setDrawerOpenExternal = setDrawerOpen;
      pairServerExternal = async (code) => {
        await pair.mutateAsync({ code, activate: true });
      };
      return createElement(
        Fragment,
        null,
        drawerOpen ? createElement(DrawerSyncStub) : null,
        createElement(Fragment, { key: hostEpoch }, createElement(DraftForm)),
      );
    }

    const history = createBrowserHistory(null);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Router as FunctionComponent<RouterOptions>,
            { hook: history.hook, searchHook: history.searchHook },
            createElement(ShellHarness),
          ),
        ),
      ),
    );
    try {
      await mounted.act(() => {
        setDraftExternal!("unsaved-tab-a-value");
      });
      expect(mounted.container.innerHTML).toContain('data-draft="unsaved-tab-a-value"');

      // Closing a secondary sync subscriber (e.g. mobile drawer sidebar) must NOT drop route 409 refresh.
      await mounted.act(() => {
        setDrawerOpenExternal!(false);
      });

      // Receiving a 409 conflict invalidates subspaceQuery so stale tabs refetch promptly.
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "conflict", message: "Active Subspace server changed" },
          }),
          { status: 409 },
        ),
      );
      await expect(send("PUT /api/local/settings", { body: {} })).rejects.toMatchObject({
        status: 409,
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: subspaceQuery.queryKey });

      // Cross-tab host switch bumps hostEpoch and remounts DraftForm, wiping stale draft state.
      mockCall.mockResolvedValueOnce(switched);
      await mounted.act(async () => {
        client.setQueryData(subspaceQuery.queryKey, switched);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mounted.container.innerHTML).toContain('data-draft="clean"');
      expect(mounted.container.innerHTML).not.toContain("unsaved-tab-a-value");

      // Re-pairing the already-active host with activate: true keeps activeHostId unchanged and preserves drafts.
      await mounted.act(() => {
        setDraftExternal!("keep-same-host-draft");
      });
      mockCall.mockResolvedValueOnce({ ...switched, pairedServerId: "srv_other" });
      await mounted.act(async () => {
        await pairServerExternal!("eidolon://pair?c=1");
      });
      expect(mounted.container.innerHTML).toContain('data-draft="keep-same-host-draft"');
    } finally {
      history.dispose();
    }
  });

  test("stale host-scoped mutation resolves after resetHostCacheAndRoute without writing cache or showing error toast", async () => {
    const client = new QueryClient();
    const promptKey = ["personas", "milky-green", "prompt"] as const;
    let resolveFetch: ((res: Response) => void) | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const onSuccess = vi.fn((saved: { text: string }) => {
      client.setQueryData(promptKey, saved);
    });

    let triggerSave!: () => Promise<unknown>;
    function PromptSaveHarness() {
      const save = useMutation({
        mutationFn: () =>
          actualCall("PUT /api/local/personas/:id/prompt", {
            params: { id: "milky-green" },
            body: { text: "old-host-prompt" },
          }),
        onSuccess,
        onError: toastError,
      });
      triggerSave = () => save.mutateAsync();
      return null;
    }

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    mounted = await mountFakeDom(
      createElement(
        I18nProvider,
        { i18n },
        createElement(QueryClientProvider, { client }, createElement(PromptSaveHarness)),
      ),
    );

    let inflight!: Promise<unknown>;
    await mounted.act(async () => {
      inflight = triggerSave();
      await vi.waitFor(() => {
        expect(resolveFetch).not.toBeNull();
      });
    });
    await mounted.act(async () => {
      await resetHostCacheAndRoute(client, "/", vi.fn(), async () => {});
      resolveFetch!(Response.json({ text: "old-host-prompt", source: "persona" }));
      await expect(inflight).rejects.toBeInstanceOf(StaleHostMutationError);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(client.getQueryData(promptKey)).toBeUndefined();
    expect(toastErrorSpy).not.toHaveBeenCalled();
    client.clear();
  });

  test("stale host-scoped errors in send(), call(), and bytes() surface StaleHostMutationError after host switch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const switchHost = () =>
      resetHostCacheAndRoute(new QueryClient(), "/", vi.fn(), async () => {});

    // 1. send(): rejected fetch after host switch
    let rejectFetch: ((reason: unknown) => void) | null = null;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((_, reject) => {
          rejectFetch = reject;
        }),
    );
    const sendRejectPromise = actualSend("PUT /api/local/settings", { body: {} });
    await vi.waitFor(() => {
      expect(rejectFetch).not.toBeNull();
    });
    await switchHost();
    rejectFetch!(new TypeError("network down"));
    await expect(sendRejectPromise).rejects.toBeInstanceOf(StaleHostMutationError);

    // 2. send(): !response.ok body-read settles after host switch
    let resolveErrBody: ((value: unknown) => void) | null = null;
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () =>
        new Promise((resolve) => {
          resolveErrBody = resolve;
        }),
    } as unknown as Response);
    const sendErrPromise = actualSend("PUT /api/local/settings", { body: {} });
    await vi.waitFor(() => {
      expect(resolveErrBody).not.toBeNull();
    });
    await switchHost();
    resolveErrBody!({ error: { code: "internal", message: "boom" } });
    await expect(sendErrPromise).rejects.toBeInstanceOf(StaleHostMutationError);

    // 3. call(): response.json() failure after host switch
    let rejectJson: ((reason: unknown) => void) | null = null;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_, reject) => {
          rejectJson = reject;
        }),
    } as unknown as Response);
    const callPromise = actualCall("PUT /api/local/personas/:id/prompt", {
      params: { id: "milky-green" },
      body: { text: "old-host" },
    });
    await vi.waitFor(() => {
      expect(rejectJson).not.toBeNull();
    });
    await switchHost();
    rejectJson!(new SyntaxError("unexpected EOF"));
    await expect(callPromise).rejects.toBeInstanceOf(StaleHostMutationError);

    // 4. bytes(): response.arrayBuffer() failure after host switch
    let rejectBytes: ((reason: unknown) => void) | null = null;
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((_, reject) => {
          rejectBytes = reject;
        }),
    } as unknown as Response);
    const bytesPromise = actualBytes("POST /api/local/chats/:id/messages", {
      params: { id: "chat-1" },
      body: { text: "hi" },
    });
    await vi.waitFor(() => {
      expect(rejectBytes).not.toBeNull();
    });
    await switchHost();
    rejectBytes!(new Error("aborted mid-stream"));
    await expect(bytesPromise).rejects.toBeInstanceOf(StaleHostMutationError);

    // 5. send(): discarded streaming response body is cancelled on stale host switch
    const cancelSpy = vi.fn(async () => {});
    let resolveStreamFetch: ((res: Response) => void) | null = null;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveStreamFetch = resolve;
        }),
    );
    const streamPromise = actualSend("POST /api/local/chats/:id/messages", {
      params: { id: "chat-1" },
      body: { text: "hi" },
    });
    await vi.waitFor(() => {
      expect(resolveStreamFetch).not.toBeNull();
    });
    await switchHost();
    resolveStreamFetch!({
      ok: true,
      status: 200,
      bodyUsed: false,
      body: { cancel: cancelSpy },
    } as unknown as Response);
    await expect(streamPromise).rejects.toBeInstanceOf(StaleHostMutationError);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test("ServersCard shows Check Permissions only when macOS reports local-network-blocked", () => {
    const originalDesktop = globalThis.eidolonDesktop;
    const baseServer: SubspaceStateResponse["servers"][number] = {
      id: "srv-lan",
      name: "Studio LAN",
      mode: "direct",
      endpoint: { host: "10.0.1.5", port: 63427 },
      relay: null,
      addedAt: 1,
      lastConnectedAt: null,
      lastVersion: null,
      connectionState: "error",
      lastError: "Could not reach the server on your local network",
      latencyMs: null,
    };
    const renderServers = (lastErrorCode: string | null) => {
      const history = createBrowserHistory(null);
      const client = new QueryClient();
      client.setQueryData(
        subspaceQuery.queryKey,
        makeState({
          servers: [{ ...baseServer, lastErrorCode }],
        }),
      );
      const i18n = setupI18n({ locale: "en", messages: { en: {} } });
      try {
        return renderToStaticMarkup(
          createElement(
            I18nProvider,
            { i18n },
            createElement(
              QueryClientProvider,
              { client },
              createElement(
                Router as FunctionComponent<RouterOptions>,
                { hook: history.hook, searchHook: history.searchHook },
                createElement(ServersCard),
              ),
            ),
          ),
        );
      } finally {
        history.dispose();
      }
    };

    try {
      globalThis.eidolonDesktop = {
        platform: "darwin",
        version: "0.10.0",
        serverVersion: "0.22.0",
        setTheme: () => {},
        setLanguage: () => {},
        onCommand: () => {},
        permissions: async () => ({ background: false, items: [] }),
        requestPermission: async () => ({
          id: "local-network",
          status: "unknown",
          openedSettings: false,
        }),
        openPermissionSettings: async () => true,
        testLocalNetwork: async () => ({
          ok: true,
          host: "10.0.1.5",
          port: 63427,
          testedAt: 1,
        }),
      };

      expect(renderServers("subspace-unreachable")).not.toContain("Check Permissions");
      expect(renderServers("local-network-blocked")).toContain("Check Permissions");
    } finally {
      globalThis.eidolonDesktop = originalDesktop;
    }
  });

  test("useCreateShareOffer invalidates subspaceQuery on error so relayError surfaces promptly", async () => {
    const client = new QueryClient();
    client.setQueryData(subspaceQuery.queryKey, makeState());
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mockCall.mockRejectedValueOnce(new Error("Relay unreachable"));

    let trigger: (() => Promise<void>) | undefined;
    function Probe() {
      const offer = useCreateShareOffer();
      trigger = async () => {
        await offer.mutateAsync({ mode: "relay" }).catch(() => {});
      };
      return null;
    }

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const history = createBrowserHistory(null);
    try {
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              Router as FunctionComponent<RouterOptions>,
              { hook: history.hook, searchHook: history.searchHook },
              createElement(Probe),
            ),
          ),
        ),
      );
      await mounted.act(async () => {
        await trigger?.();
        // Flush TanStack Query's batched notifyManager timer before unmount clears window.
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["subspace"] });
      expect(toastErrorSpy).toHaveBeenCalledTimes(1);
    } finally {
      client.clear();
      history.dispose();
    }
  });
});
