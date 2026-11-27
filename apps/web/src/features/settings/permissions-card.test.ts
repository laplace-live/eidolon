// Settings' Permissions section: what each status badge, note, button, and card shows on macOS,
// Windows, and background/unpackaged copies. Rendered to markup with Lingui macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { EidolonDesktop, PermissionsState } from "@/lib/desktop";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);

const { permissionActionKind, permissionNote, permissionStatusText, requestResultNotice } =
  await import("./permissions-notes");
const { PermissionsSection, permissionsQuery } = await import("./permissions-card");
const { offersPermissions } = await import("./sections");

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

afterEach(() => {
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
});
