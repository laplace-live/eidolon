// Settings' Permissions section: what each status badge, note, button, and card shows on macOS,
// Windows, and background/unpackaged copies. Rendered to markup with Lingui macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cloneElement,
  createContext,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useContext,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EidolonDesktop, PermissionsState } from "@/lib/desktop";
import { type MountedRoot, mountFakeDom } from "@/test/fake-dom";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

const CollapsibleCtx = createContext<{ open: boolean; toggle: () => void }>({
  open: false,
  toggle: () => {},
});

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
vi.doMock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    open,
    onOpenChange,
    className,
    children,
  }: {
    readonly open?: boolean;
    readonly onOpenChange?: (next: boolean) => void;
    readonly className?: string;
    readonly children?: ReactNode;
  }) =>
    createElement(
      CollapsibleCtx.Provider,
      { value: { open: open === true, toggle: () => onOpenChange?.(!open) } },
      createElement("div", { className }, children),
    ),
  CollapsibleTrigger: ({
    asChild,
    children,
  }: {
    readonly asChild?: boolean;
    readonly children?: ReactNode;
  }) => {
    const { toggle } = useContext(CollapsibleCtx);
    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<{ readonly onClick?: () => void }>;
      return cloneElement(child, {
        onClick: () => {
          child.props.onClick?.();
          toggle();
        },
      });
    }
    return createElement("button", { type: "button", onClick: toggle }, children);
  },
  CollapsibleContent: ({ children }: { readonly children?: ReactNode }) => {
    const { open } = useContext(CollapsibleCtx);
    return open ? createElement("div", null, children) : null;
  },
}));

const { permissionActionKind, permissionNote, permissionStatusText, requestResultNotice } =
  await import("./permissions-notes");
const { PermissionsSection, permissionsQuery } = await import("./permissions-card");
const { offersPermissions } = await import("./sections");
const { subspaceQuery } = await import("@/features/subspace/queries");

const ignore = () => {};
const refuse = () => Promise.reject(new Error("card reads seeded state"));

function bridge(platform: string, withPerms = true): EidolonDesktop {
  return {
    platform,
    version: "0.9.0",
    serverVersion: "0.20.0",
    setTheme: ignore,
    setLanguage: ignore,
    onCommand: ignore,
    ...(withPerms
      ? {
          permissions: refuse,
          requestPermission: refuse,
          openPermissionSettings: refuse,
          testLocalNetwork: refuse,
        }
      : {}),
  };
}

let mounted: MountedRoot | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  globalThis.eidolonDesktop = undefined;
});

function render(platform: string, state: PermissionsState | undefined): string {
  const app = bridge(platform);
  globalThis.eidolonDesktop = app;
  if (!offersPermissions(app)) throw new Error("expected permissions bridge");
  const client = new QueryClient();
  if (state !== undefined) client.setQueryData(permissionsQuery(app).queryKey, state);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(QueryClientProvider, { client }, createElement(PermissionsSection)),
    ),
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const row = (markup: string, id: string) =>
  markup.split(`data-permission="${id}"`)[1]?.split("data-permission=")[0] ?? "";

const rows = (markup: string) =>
  [...markup.matchAll(/data-permission="([^"]+)"/g)].map((match) => match[1]);

describe("permissions helpers", () => {
  test("maps status badges, notes, action kinds, and request toasts", () => {
    expect(permissionStatusText("local-network", "unknown", "darwin").message).toBe(
      "Managed by macOS",
    );
    expect(permissionStatusText("notifications", "unknown", "win32").message).toBe(
      "Managed by Windows",
    );
    expect(permissionStatusText("accessibility", "unknown", "darwin").message).toBe(
      "Check Manually",
    );
    expect(permissionStatusText("microphone", "not-determined", "darwin").message).toBe(
      "Not Requested",
    );
    expect(
      permissionNote({ id: "microphone", status: "denied" }, "darwin")?.text.message,
    ).toContain("macOS no longer prompts");
    expect(
      permissionNote(
        { id: "notifications", status: "unavailable", unavailable: "background" },
        "darwin",
      )?.text.message,
    ).toBe("Background mode leaves this computer as it is.");
    expect(permissionActionKind({ id: "local-network", status: "unknown" }, "darwin")).toBe(
      "request-access",
    );
    expect(permissionActionKind({ id: "microphone", status: "not-determined" }, "darwin")).toBe(
      "request",
    );
    expect(permissionActionKind({ id: "microphone", status: "denied" }, "darwin")).toBe(
      "open-settings",
    );
    expect(permissionActionKind({ id: "screen", status: "unknown" }, "darwin")).toBe(
      "open-settings",
    );
    expect(permissionActionKind({ id: "microphone", status: "denied" }, "win32")).toBe(
      "open-settings",
    );
    expect(
      requestResultNotice(
        { id: "local-network", status: "unknown", openedSettings: false },
        "darwin",
      ),
    ).toMatchObject({ kind: "info", showSettingsButton: true });
    expect(
      requestResultNotice({ id: "microphone", status: "granted", openedSettings: false }, "darwin"),
    ).toMatchObject({ kind: "success" });
  });
});

describe("PermissionsSection", () => {
  test("renders nothing in a browser or older desktop shell without permissions bridge", () => {
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const renderBare = () =>
      renderToStaticMarkup(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(PermissionsSection),
          ),
        ),
      );
    expect(renderBare()).toBe("");
    globalThis.eidolonDesktop = bridge("darwin", false);
    expect(renderBare()).toBe("");
  });

  test("splits macOS permissions into Permissions and Assistant Tools cards with Test Connection", () => {
    const markup = render("darwin", {
      background: false,
      items: [
        { id: "microphone", status: "not-determined" },
        { id: "notifications", status: "granted" },
        { id: "local-network", status: "unknown" },
        { id: "screen", status: "denied" },
        { id: "accessibility", status: "unknown" },
      ],
    });
    expect(rows(markup)).toEqual([
      "microphone",
      "notifications",
      "local-network",
      "screen",
      "accessibility",
    ]);
    const said = text(markup);
    expect(said).toContain("Permissions");
    expect(said).toContain("Assistant Tools");
    expect(said).toContain("Microphone Not Requested");
    expect(said).toContain("Notifications Granted");
    expect(said).toContain("Local Network Managed by macOS");
    expect(said).toContain("Test Connection");
    expect(said).toContain("No successful test saved.");
    expect(said).toContain("Screen Recording Denied");
    expect(said).toContain("Accessibility Check Manually");
    expect(row(markup, "microphone")).toContain("Request");
    expect(row(markup, "local-network")).toContain("Request Access");
    expect(row(markup, "notifications")).not.toContain(">Request<");
  });

  test("shows Windows permissions alone without Assistant Tools or Local Network", () => {
    const markup = render("win32", {
      background: false,
      items: [
        { id: "microphone", status: "granted" },
        { id: "notifications", status: "unknown" },
      ],
    });
    expect(rows(markup)).toEqual(["microphone", "notifications"]);
    const said = text(markup);
    expect(said).toContain("Permissions");
    expect(said).not.toContain("Assistant Tools");
    expect(said).toContain("Notifications Managed by Windows");
    expect(said).toContain("Open Settings");
    expect(said).not.toContain("Open System Settings");
  });

  test("disables permission actions and says why in background mode", () => {
    const markup = render("darwin", {
      background: true,
      items: [
        { id: "microphone", status: "unavailable", unavailable: "background" },
        { id: "notifications", status: "unavailable", unavailable: "background" },
        { id: "local-network", status: "unavailable", unavailable: "background" },
      ],
    });
    expect(text(markup)).toContain("Background mode leaves this computer as it is.");
    expect(row(markup, "microphone")).toContain('data-disabled="true"');
    expect(row(markup, "microphone")).toContain('disabled=""');
    expect(row(markup, "local-network")).toContain('disabled=""');
  });

  test("clears the local-network success status once host or port is edited", async () => {
    const testLocalNetwork = vi.fn(async () => ({
      ok: true as const,
      host: "10.0.1.5",
      port: 63427,
      testedAt: 1_795_773_000_000,
    }));
    const app: EidolonDesktop = { ...bridge("darwin"), testLocalNetwork };
    globalThis.eidolonDesktop = app;
    if (!offersPermissions(app)) throw new Error("expected permissions bridge");

    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
    });
    client.setQueryData(permissionsQuery(app).queryKey, {
      background: false,
      items: [{ id: "local-network", status: "unknown" }],
    });
    client.setQueryData(subspaceQuery.queryKey, {
      activeHostId: null,
      servers: [],
      relayAuth: { status: "signed-out" },
    } as never);

    type FakeNode = {
      readonly tagName?: string;
      readonly textContent?: string;
      readonly childNodes?: readonly FakeNode[];
      readonly [key: string]: unknown;
    };
    const findProps = (
      match: (node: FakeNode, props: Record<string, unknown>) => boolean,
    ): Record<string, unknown> => {
      const queue: unknown[] = [mounted?.container];
      while (queue.length > 0) {
        const current = queue.shift() as FakeNode | undefined;
        if (!current) continue;
        const propsKey = Object.keys(current).find((k) => k.startsWith("__reactProps$"));
        const props = propsKey ? (current[propsKey] as Record<string, unknown>) : undefined;
        if (props && match(current, props)) return props;
        if (Array.isArray(current.childNodes)) queue.push(...current.childNodes);
      }
      throw new Error(
        `expected React node in mounted PermissionsSection (${mounted?.container.innerHTML ?? ""})`,
      );
    };

    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    try {
      mounted = await mountFakeDom(
        createElement(
          I18nProvider,
          { i18n },
          createElement(QueryClientProvider, { client }, createElement(PermissionsSection)),
        ),
      );

      const toggleProps = findProps(
        (node) =>
          node.tagName === "BUTTON" && (node.textContent?.includes("Test Connection") ?? false),
      ) as { readonly onClick?: () => void };
      await mounted.act(() => toggleProps.onClick?.());

      const hostProps = findProps(
        (node, props) => node.tagName === "INPUT" && props.name === "host",
      ) as { readonly onChange?: (event: { target: { value: string } }) => void };
      const portProps = findProps(
        (node, props) => node.tagName === "INPUT" && props.name === "port",
      ) as { readonly onChange?: (event: { target: { value: string } }) => void };

      await mounted.act(() => {
        hostProps.onChange?.({ target: { value: "10.0.1.5" } });
        portProps.onChange?.({ target: { value: "63427" } });
      });
      const formProps = findProps((node) => node.tagName === "FORM") as {
        readonly onSubmit?: (event: { preventDefault(): void }) => void;
      };
      await mounted.act(async () => {
        formProps.onSubmit?.({ preventDefault() {} });
      });

      expect(testLocalNetwork).toHaveBeenCalledWith({ host: "10.0.1.5", port: 63427 });
      expect(mounted.container.textContent).toContain(
        "Connection succeeded over your local network.",
      );

      const updatedHostProps = findProps(
        (node, props) => node.tagName === "INPUT" && props.name === "host",
      ) as { readonly onChange?: (event: { target: { value: string } }) => void };
      await mounted.act(() => {
        updatedHostProps.onChange?.({ target: { value: "10.0.1.6" } });
      });

      expect(mounted.container.textContent).not.toContain(
        "Connection succeeded over your local network.",
      );
    } finally {
      client.clear();
    }
  });
});
