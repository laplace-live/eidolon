import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FunctionComponent, type ReactNode } from "react";
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
vi.doMock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
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

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    return textOf((node as { readonly props?: { readonly children?: ReactNode } }).props?.children);
  }
  return "";
}

vi.doMock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
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
const { subspaceQuery, useRemoveSubspaceServer, useSwitchSubspaceHost } = await import("./queries");
const { SubspaceSwitcher } = await import("@/components/subspace-switcher");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { send } = await import("@/lib/api");

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
    mockCall.mockReset();
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
});
