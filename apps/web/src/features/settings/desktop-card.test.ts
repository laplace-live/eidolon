// Settings' Desktop App card: what each state of Open at Login and the terminal command says, and the
// controls it leaves usable. Rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { CommandState, EidolonDesktop, LoginItemState, Unavailable } from "@/lib/desktop";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { changeFailed, commandNote, loginItemNote } = await import("./desktop-notes");
const { DesktopCard, loginItemQuery, terminalCommandQuery } = await import("./desktop-card");
const { offersSystemOptions } = await import("./sections");

const REASONS: Readonly<Record<Unavailable, string>> = {
  background: "Background mode leaves this computer as it is.",
  unpackaged: "Available in the installed app only.",
  "outside-applications": "Move Eidolon to the Applications folder to use this.",
  "not-installed": "Install Eidolon with its installer to use this.",
};

const MAC_LINK = "/usr/local/bin/eidolon";
const WINDOWS_FOLDER = "C:\\Users\\me\\AppData\\Local\\Programs\\Eidolon\\resources\\bin";

describe("what each state says", () => {
  test("Open at Login says nothing beside its switch, but why it can't be used or waits for an OK", () => {
    expect(loginItemNote({ state: "on" })).toBeNull();
    expect(loginItemNote({ state: "off" })).toBeNull();
    expect(loginItemNote({ state: "needs-approval" })).toEqual({
      text: expect.objectContaining({
        message:
          "Waiting for your OK in System Settings: turn Eidolon on under General → Login Items.",
      }),
      tone: "warning",
    });
    for (const [reason, sentence] of Object.entries(REASONS)) {
      const note = loginItemNote({ state: "unavailable", reason: reason as Unavailable });
      expect(note?.text.message).toBe(sentence);
      expect(note?.tone).toBe("muted");
    }
  });

  test("the terminal command says where Install puts it, a link on macOS and a PATH folder on Windows", () => {
    const absent = (path: string) => ({ state: "absent", path }) as const;
    expect(commandNote(absent(MAC_LINK), "darwin").text.message).toBe(
      "Install puts it at /usr/local/bin/eidolon, and may ask for your password.",
    );
    expect(commandNote(absent(WINDOWS_FOLDER), "win32").text.message).toBe(
      `Install adds ${WINDOWS_FOLDER} to your PATH.`,
    );
  });

  test("installed, it says where, and on Windows that only a new terminal sees it", () => {
    const installed = (path: string) => ({ state: "installed", path }) as const;
    expect(commandNote(installed(MAC_LINK), "darwin")).toEqual({
      text: expect.objectContaining({ message: "Installed at /usr/local/bin/eidolon." }),
      tone: "muted",
    });
    expect(commandNote(installed(WINDOWS_FOLDER), "win32").text.message).toBe(
      `Added to your PATH: ${WINDOWS_FOLDER}. Open a new terminal to use it.`,
    );
  });

  test("another eidolon in its place is a warning, and an unavailable copy says why", () => {
    expect(commandNote({ state: "taken", path: MAC_LINK }, "darwin")).toEqual({
      text: expect.objectContaining({ message: "Another eidolon is at /usr/local/bin/eidolon." }),
      tone: "warning",
    });
    for (const [reason, sentence] of Object.entries(REASONS)) {
      const state = { state: "unavailable", reason: reason as Unavailable } as const;
      expect(commandNote(state, "darwin").text.message).toBe(sentence);
      expect(commandNote(state, "win32").text.message).toBe(sentence);
    }
  });

  test("a failed change says what didn't happen, and where Show Logs is on each system", () => {
    const said = (action: "install" | "remove", platform: string) => {
      const { title, detail } = changeFailed(action, platform);
      return [title.message, detail.message];
    };
    expect(said("install", "darwin")).toEqual([
      "Couldn't install the eidolon command.",
      "Show Logs in the Help menu has the details.",
    ]);
    expect(said("remove", "win32")).toEqual([
      "Couldn't remove the eidolon command.",
      "Show Logs in the tray icon's menu has the details.",
    ]);
  });
});

const ignore = () => {};
const refuse = () => Promise.reject(new Error("the card reads the seeded state"));

function bridge(platform: string): EidolonDesktop {
  return {
    platform,
    version: "0.2.0",
    serverVersion: "0.14.0",
    setTheme: ignore,
    setLanguage: ignore,
    onCommand: ignore,
    loginItem: refuse,
    setLoginItem: refuse,
    terminalCommand: refuse,
    setTerminalCommand: refuse,
  };
}

afterEach(() => {
  globalThis.eidolonDesktop = undefined;
});

/** The card as `platform`'s app shows it, with each option's state already read. */
function render(
  platform: string,
  login: LoginItemState | undefined,
  command: CommandState | undefined,
): string {
  const app = bridge(platform);
  globalThis.eidolonDesktop = app;
  if (!offersSystemOptions(app)) throw new Error("the fake bridge offers the options");
  const client = new QueryClient();
  if (login !== undefined) client.setQueryData(loginItemQuery(app).queryKey, login);
  if (command !== undefined) client.setQueryData(terminalCommandQuery(app).queryKey, command);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { i18n },
      createElement(QueryClientProvider, { client }, createElement(DesktopCard)),
    ),
  );
}

/** `markup`'s text, its tags dropped and its entities read. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const loginRow = (markup: string) =>
  markup.split('data-desktop-option="login-item"')[1]?.split("data-desktop-option")[0] ?? "";
const commandRow = (markup: string) =>
  markup.split('data-desktop-option="terminal-command"')[1] ?? "";

/** The opening tag of the button whose text ends with `label`. */
function button(markup: string, label: string): string {
  const at = markup.indexOf(`${label}</button>`);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

describe("the card", () => {
  test("a browser, or an app whose bridge predates the options, shows none", () => {
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    const markup = () =>
      renderToStaticMarkup(
        createElement(
          I18nProvider,
          { i18n },
          createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            createElement(DesktopCard),
          ),
        ),
      );
    expect(markup()).toBe("");
    const { loginItem: _, ...older } = bridge("darwin");
    globalThis.eidolonDesktop = older;
    expect(markup()).toBe("");
  });

  test("names both options and what the command gives a terminal", () => {
    const said = text(render("darwin", { state: "off" }, { state: "absent", path: MAC_LINK }));
    expect(said).toContain("Desktop App");
    expect(said).toContain(
      "Open at Login Start Eidolon in the background when you log in to this computer.",
    );
    // Each command is code, which the tags' spaces set apart here.
    expect(said).toContain(
      "Terminal Command Run eidolon <command> in a terminal, such as eidolon pipeline . With no arguments, it opens Eidolon.",
    );
  });

  test("Open at Login's switch follows the OS, and stays on while macOS waits for an OK", () => {
    const off = loginRow(render("darwin", { state: "off" }, undefined));
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('disabled=""');
    const on = loginRow(render("win32", { state: "on" }, undefined));
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain('disabled=""');
    const waiting = loginRow(render("darwin", { state: "needs-approval" }, undefined));
    expect(waiting).toContain('aria-checked="true"');
    expect(waiting).not.toContain('disabled=""');
    expect(text(waiting)).toContain("Waiting for your OK in System Settings");
  });

  test("an unavailable Open at Login, or one not read yet, can't be switched", () => {
    const unavailable = loginRow(
      render("darwin", { state: "unavailable", reason: "outside-applications" }, undefined),
    );
    expect(unavailable).toContain('disabled=""');
    expect(unavailable).toContain('aria-checked="false"');
    expect(text(unavailable)).toContain(REASONS["outside-applications"]);
    expect(loginRow(render("darwin", undefined, undefined))).toContain('disabled=""');
  });

  test("the command installs where it's absent and is removed where installed", () => {
    const absent = commandRow(render("darwin", undefined, { state: "absent", path: MAC_LINK }));
    expect(button(absent, "Install")).toMatch(/^<button/);
    expect(button(absent, "Install")).not.toContain('disabled=""');
    expect(text(absent)).toContain("Install puts it at /usr/local/bin/eidolon");
    const installed = commandRow(
      render("win32", undefined, { state: "installed", path: WINDOWS_FOLDER }),
    );
    expect(button(installed, "Install")).toBe("");
    expect(button(installed, "Remove")).toMatch(/^<button/);
    expect(button(installed, "Remove")).not.toContain('disabled=""');
    expect(text(installed)).toContain(`Added to your PATH: ${WINDOWS_FOLDER}.`);
  });

  test("Install stays off while another eidolon is in its place, the copy can't install, or it isn't read yet", () => {
    const taken = commandRow(render("darwin", undefined, { state: "taken", path: MAC_LINK }));
    expect(button(taken, "Install")).toContain('disabled=""');
    expect(text(taken)).toContain("Another eidolon is at /usr/local/bin/eidolon.");
    const unavailable = commandRow(
      render("win32", undefined, { state: "unavailable", reason: "not-installed" }),
    );
    expect(button(unavailable, "Install")).toContain('disabled=""');
    expect(text(unavailable)).toContain(REASONS["not-installed"]);
    expect(button(commandRow(render("darwin", undefined, undefined)), "Install")).toContain(
      'disabled=""',
    );
  });
});
