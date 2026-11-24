// Settings' Desktop App card: what each state of Open at Login, the desktop companion and the
// terminal command says, the controls it leaves usable, and when it reads Open at Login and her
// again. Rendered to markup, with the macros stubbed.
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActiveCharacterModel, Status } from "@/lib/api";
import type {
  CommandChange,
  CommandState,
  CompanionState,
  EidolonDesktop,
  LoginItemState,
  Unavailable,
} from "@/lib/desktop";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { changeFailed, commandNote, companionNotes, loginItemNote } = await import(
  "./desktop-notes"
);
const { companionQuery, DesktopCard, loginItemQuery, terminalCommandQuery } = await import(
  "./desktop-card"
);
const { offersCompanion, offersSystemOptions } = await import("./sections");

const REASONS: Readonly<Record<Unavailable, string>> = {
  background: "Background mode leaves this computer as it is.",
  unpackaged: "Available in the installed app only.",
  "outside-applications": "Move Eidolon to the Applications folder to use this.",
  "not-installed": "Install Eidolon with its installer to use this.",
};

const MAC_LINK = "/usr/local/bin/eidolon";
const WINDOWS_FOLDER = "C:\\Users\\me\\AppData\\Local\\Programs\\Eidolon\\resources\\bin";

/** The desktop companion as the app reports her: shown, or turned off, outside background mode. */
const ON: CompanionState = { on: true, showAtLogin: true, background: false };
const OFF: CompanionState = { on: false, showAtLogin: true, background: false };

const MODEL: ActiveCharacterModel = {
  id: "tml",
  name: "TML",
  kind: "psd2live",
  sha256: "0".repeat(64),
  updatedAt: "2026-11-23T00:00:00.000Z",
};

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
    const said = (change: CommandChange, action: "install" | "remove", platform: string) => {
      const toast = changeFailed(change, action, platform);
      return toast === null ? null : [toast.title.message, toast.detail.message];
    };
    const absent = { state: "absent", path: MAC_LINK } as const;
    const installed = { state: "installed", path: WINDOWS_FOLDER } as const;
    expect(said({ command: absent, error: "failed" }, "install", "darwin")).toEqual([
      "Couldn't install the eidolon command.",
      "Show Logs in the Help menu has the details.",
    ]);
    expect(said({ command: installed, error: "failed" }, "remove", "win32")).toEqual([
      "Couldn't remove the eidolon command.",
      "Show Logs in the tray icon's menu has the details.",
    ]);
  });

  test("a change that went through, or one the owner cancelled at the password prompt, says nothing", () => {
    const absent = { state: "absent", path: MAC_LINK } as const;
    const installed = { state: "installed", path: MAC_LINK } as const;
    expect(changeFailed({ command: installed }, "install", "darwin")).toBeNull();
    expect(changeFailed({ command: absent, error: "cancelled" }, "install", "darwin")).toBeNull();
    expect(changeFailed({ command: installed, error: "cancelled" }, "remove", "darwin")).toBeNull();
  });

  test("the desktop companion says when background mode keeps her off screen, and when she shows as her picture", () => {
    const said = (state: CompanionState, hasModel: boolean) =>
      companionNotes(state, hasModel).map((note) => [note.text.message, note.tone]);
    const background = ["Background mode never shows her.", "muted"];
    const picture = ["She shows as her picture until she has an active character model.", "muted"];
    expect(said(ON, true)).toEqual([]);
    expect(said(OFF, true)).toEqual([]);
    expect(said({ ...ON, background: true }, true)).toEqual([background]);
    expect(said(ON, false)).toEqual([picture]);
    expect(said({ ...OFF, background: true }, false)).toEqual([background, picture]);
  });
});

describe("reading Open at Login", () => {
  test("again every 3 s while macOS waits for the owner's OK, which System Settings gives, and not otherwise", () => {
    const app = bridge("darwin");
    if (!offersSystemOptions(app)) throw new Error("the fake bridge offers the options");
    const { refetchInterval } = loginItemQuery(app);
    const every = (data: LoginItemState | undefined) =>
      typeof refetchInterval === "function"
        ? refetchInterval({ state: { data } } as Parameters<typeof refetchInterval>[0])
        : refetchInterval;
    expect(every({ state: "needs-approval" })).toBe(3000);
    for (const data of [
      { state: "on" },
      { state: "off" },
      { state: "unavailable", reason: "background" },
      undefined,
    ] as const) {
      expect(every(data)).toBe(false);
    }
  });
});

describe("reading the desktop companion", () => {
  test("again every 2 s while the card shows, since her menu, the tray, the Window menu and Pop Out switch her too", () => {
    const app = bridge("darwin", { companion: true });
    if (!offersCompanion(app)) throw new Error("the fake bridge offers her");
    expect(companionQuery(app).refetchInterval).toBe(2000);
  });
});

const ignore = () => {};
const refuse = () => Promise.reject(new Error("the card reads the seeded state"));

/** An app's bridge: Open at Login and the terminal command unless `system` is false, and her with `companion`. */
function bridge(platform: string, { system = true, companion = false } = {}): EidolonDesktop {
  return {
    platform,
    version: "0.2.0",
    serverVersion: "0.14.0",
    setTheme: ignore,
    setLanguage: ignore,
    onCommand: ignore,
    ...(system
      ? {
          loginItem: refuse,
          setLoginItem: refuse,
          terminalCommand: refuse,
          setTerminalCommand: refuse,
        }
      : {}),
    ...(companion ? { companion: refuse, setCompanion: refuse } : {}),
  };
}

/** An app that offers the desktop companion, as the card reads her. */
interface Her {
  /** As the app reports her; unread without it. */
  readonly state?: CompanionState;
  /** Her active character model, as status names it: none for null. */
  readonly model?: ActiveCharacterModel | null;
  /** The app offers Open at Login and the terminal command too. */
  readonly system?: boolean;
}

afterEach(() => {
  globalThis.eidolonDesktop = undefined;
});

/** The card as `platform`'s app shows it, with each option's state already read, and her with `her`. */
function render(
  platform: string,
  login: LoginItemState | undefined,
  command: CommandState | undefined,
  her?: Her,
): string {
  const app = bridge(platform, { system: her?.system ?? true, companion: her !== undefined });
  globalThis.eidolonDesktop = app;
  const client = new QueryClient();
  if (offersSystemOptions(app)) {
    if (login !== undefined) client.setQueryData(loginItemQuery(app).queryKey, login);
    if (command !== undefined) client.setQueryData(terminalCommandQuery(app).queryKey, command);
  }
  if (her !== undefined) {
    if (!offersCompanion(app)) throw new Error("the fake bridge offers her");
    const { state, model = MODEL } = her;
    if (state !== undefined) client.setQueryData(companionQuery(app).queryKey, state);
    const status = { persona: { id: "milky-green", appearance: { model } } };
    client.setQueryData(statusQuery.queryKey, status as unknown as Status);
  }
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

/** The row of `option`, up to the next. */
const row = (markup: string, option: string) =>
  markup.split(`data-desktop-option="${option}"`)[1]?.split("data-desktop-option")[0] ?? "";
const loginRow = (markup: string) => row(markup, "login-item");
const companionRow = (markup: string) => row(markup, "companion");
const atLoginRow = (markup: string) => row(markup, "companion-at-login");
const commandRow = (markup: string) => row(markup, "terminal-command");
/** The card's rows, in order. */
const options = (markup: string) =>
  [...markup.matchAll(/data-desktop-option="([^"]+)"/g)].map((match) => match[1]);

/** The opening tag of the button whose text ends with `label`. */
function button(markup: string, label: string): string {
  const at = markup.indexOf(`${label}</button>`);
  if (at < 0) return "";
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf(">", start) + 1);
}

describe("the card", () => {
  test("a browser, or an app whose bridge predates the options and her, shows none", () => {
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
    const { setCompanion: __, ...half } = bridge("darwin", { system: false, companion: true });
    globalThis.eidolonDesktop = half;
    expect(markup()).toBe("");
  });

  test("names both options and what the command gives a terminal, and nothing of her in an app before her", () => {
    const markup = render("darwin", { state: "off" }, { state: "absent", path: MAC_LINK });
    const said = text(markup);
    expect(said).toContain("Desktop App");
    expect(said).toContain(
      "Open at Login Start Eidolon in the background when you log in to this computer.",
    );
    // Each command is code, which the tags' spaces set apart here.
    expect(said).toContain(
      "Terminal Command Run eidolon <command> in a terminal, such as eidolon pipeline . With no arguments, it opens Eidolon.",
    );
    expect(options(markup)).toEqual(["login-item", "terminal-command"]);
  });

  test("an app that offers the desktop companion shows her two rows after Open at Login", () => {
    const markup = render(
      "darwin",
      { state: "off" },
      { state: "absent", path: MAC_LINK },
      { state: OFF },
    );
    expect(options(markup)).toEqual([
      "login-item",
      "companion",
      "companion-at-login",
      "terminal-command",
    ]);
    const said = text(markup);
    expect(said).toContain(
      "Desktop Companion Keep her on your desktop, above your other windows. Right-click her for her menu.",
    );
    expect(said).toContain(
      "Show at Login When Eidolon opens at login, she shows too, before you open its window.",
    );
  });

  test("says each option is added only when the owner chooses it, which for her may be in her menu, the tray or Pop Out rather than here", () => {
    const markup = render("darwin", undefined, undefined, { state: OFF });
    expect(text(markup)).toContain(
      "Desktop App What Eidolon can add to this computer, each only when you choose it.",
    );
  });

  test("Desktop Companion's switch follows her, and Show at Login's can't be switched while she is off", () => {
    const off = render("darwin", undefined, undefined, { state: OFF });
    expect(companionRow(off)).toContain('role="switch"');
    expect(companionRow(off)).toContain('aria-checked="false"');
    expect(companionRow(off)).not.toContain('disabled=""');
    expect(atLoginRow(off)).toContain('role="switch"');
    expect(atLoginRow(off)).toContain('aria-checked="true"');
    expect(atLoginRow(off)).toContain('disabled=""');
    const on = render("win32", undefined, undefined, { state: { ...ON, showAtLogin: false } });
    expect(companionRow(on)).toContain('aria-checked="true"');
    expect(companionRow(on)).not.toContain('disabled=""');
    expect(atLoginRow(on)).toContain('aria-checked="false"');
    expect(atLoginRow(on)).not.toContain('disabled=""');
  });

  test("neither of her switches can be used before her state is read", () => {
    const unread = render("darwin", undefined, undefined, {});
    expect(companionRow(unread)).toContain('disabled=""');
    expect(atLoginRow(unread)).toContain('disabled=""');
  });

  test("says background mode never shows her, and that she shows as her picture without a model", () => {
    const shown = (her: Her) => text(companionRow(render("darwin", undefined, undefined, her)));
    const background = shown({ state: { ...ON, background: true } });
    expect(background).toContain("Background mode never shows her.");
    expect(background).not.toContain("her picture");
    const picture = shown({ state: ON, model: null });
    expect(picture).toContain("She shows as her picture until she has an active character model.");
    expect(picture).not.toContain("Background mode");
    expect(shown({ state: ON })).not.toMatch(/Background mode|her picture/);
  });

  test("an app that offers the desktop companion alone shows her rows and none of the system's", () => {
    const markup = render("win32", undefined, undefined, { state: OFF, system: false });
    expect(options(markup)).toEqual(["companion", "companion-at-login"]);
    expect(text(markup)).toContain("Desktop App");
    expect(markup).not.toContain("Open at Login");
    expect(markup).not.toContain("Terminal Command");
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
