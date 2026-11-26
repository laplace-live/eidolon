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
  Select: ({ children }: { readonly children?: ReactNode }) => createElement("div", null, children),
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
  DropdownMenuContent: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({ children }: { readonly children?: ReactNode }) =>
    createElement("div", null, children),
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
const { subspaceQuery, useRemoveSubspaceServer } = await import("./queries");
const { SubspaceSwitcher } = await import("@/components/subspace-switcher");
const { SidebarProvider } = await import("@/components/ui/sidebar");

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
    mockCall.mockReset();
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
});
