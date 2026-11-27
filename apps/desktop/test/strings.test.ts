// Both languages hold the same strings, the English labels are Title Case by apps/web's own rule,
// and the Chinese names the Help menu, Show Logs and the tray icon as the web app's desktop copy does.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { titleCase } from "../../web/scripts/title-case.ts";
import { STRINGS, type Strings, shellLanguage } from "../src/main/strings.ts";
import { isLanguage, LANGUAGES } from "../src/shared/bridge.ts";

const ROOT = join(import.meta.dirname, "../../..");
const en = STRINGS.en;
const zh = STRINGS["zh-Hans"];

/** The web app's Chinese for the English `id`, from its catalog. */
function webChinese(id: string): string {
  // A Windows checkout's catalog has CRLF line ends under Git's default autocrlf.
  const lines = readFileSync(join(ROOT, "apps/web/src/locales/zh-Hans.po"), "utf8").split(/\r?\n/);
  const msgstr = lines[lines.indexOf(`msgid ${JSON.stringify(id)}`) + 1] ?? "";
  if (!msgstr.startsWith("msgstr ")) throw new Error(`apps/web has no ${id}`);
  return JSON.parse(msgstr.slice("msgstr ".length)) as string;
}

/** Each entry's name and kind, so a string can't stand where the other language has a function. */
function shape(strings: Strings): string[] {
  return Object.entries(strings).flatMap(([group, entries]) =>
    Object.entries(entries as object).map(([key, value]) => `${group}.${key}: ${typeof value}`),
  );
}

describe("STRINGS", () => {
  test("holds the same strings in both languages, none of them blank", () => {
    expect(Object.keys(STRINGS)).toEqual([...LANGUAGES]);
    expect(shape(zh).sort()).toEqual(shape(en).sort());
    for (const language of LANGUAGES) {
      const { label, text, notice, chatNotice } = STRINGS[language];
      const blank = [
        ...Object.entries(label),
        ...Object.entries(text),
        ...Object.entries(notice),
        ...Object.entries(chatNotice),
      ]
        .filter(([, value]) => typeof value === "string" && value.trim() === "")
        .map(([key]) => `${language} ${key}`);
      expect(blank).toEqual([]);
    }
  });

  test("every English label is Title Case, as AGENTS.md and apps/web's rule have it", () => {
    expect(Object.values(en.label)).toContain("Paste and Match Style");
    const wrong = Object.entries(en.label)
      .filter(([, label]) => titleCase(label) !== label)
      .map(([key, label]) => `${key}: "${label}" → "${titleCase(label)}"`);
    expect(wrong).toEqual([]);
  });

  test("a title phrased as a sentence keeps sentence case", () => {
    const titles = [
      en.text.serverStopped,
      en.text.windowFailed,
      en.text.held,
      en.text.hideNoticeTitle,
      en.text.microphoneTitle,
      en.text.chooseFolder,
      en.text.installCommandPrompt,
      en.text.removeCommandPrompt,
    ];
    expect(titles.filter((title) => titleCase(title) === title)).toEqual([]);
  });

  test("a task notification's lines are sentence case, ending with no stop, in both languages", () => {
    const lines = Object.entries(en.notice);
    expect(lines).toHaveLength(14);
    expect(lines.filter(([, line]) => titleCase(line) === line)).toEqual([]);
    for (const language of LANGUAGES) {
      const stopped = Object.entries(STRINGS[language].notice).filter(([, line]) =>
        /[.。!！]$/.test(line),
      );
      expect([language, stopped]).toEqual([language, []]);
    }
  });

  test("chat notification lines are sentence case, ending with no stop, in both languages", () => {
    const keysAndTypes = (group: object) =>
      Object.entries(group)
        .map(([key, value]) => `${key}: ${typeof value}`)
        .sort();
    expect(keysAndTypes(zh.chatNotice)).toEqual(keysAndTypes(en.chatNotice));
    const english = [en.chatNotice.photo, en.chatNotice.photos(2), en.chatNotice.voice];
    expect(english.filter((line) => titleCase(line) === line)).toEqual([]);
    for (const language of LANGUAGES) {
      const { photo, photos, voice, listSeparator } = STRINGS[language].chatNotice;
      for (const line of [photo, photos(2), voice]) {
        expect(line).not.toMatch(/[.。!！]$/);
      }
      expect(listSeparator).toBe(language === "zh-Hans" ? "、" : ", ");
    }
  });

  test("the folder dialog and macOS's password prompt for the terminal command", () => {
    expect([en.label.chooseFolderTitle, en.label.chooseFolderButton]).toEqual([
      "Choose a Folder",
      "Choose",
    ]);
    for (const { text } of [en, zh]) {
      for (const prompt of [text.installCommandPrompt, text.removeCommandPrompt]) {
        expect(prompt).toContain("eidolon");
        expect(prompt).toContain("/usr/local/bin");
      }
    }
  });

  test("the menu's Check for Updates… label is Title Case, and matches Chinese", () => {
    expect(en.label.checkForUpdates).toBe("Check for Updates…");
    expect(zh.label.checkForUpdates).toBe("检查更新…");
    expect(en.label.restart).toBe("Restart");
    expect(webChinese("Restart")).toBe(zh.label.restart);
  });

  test("names the Help menu, Show Logs and the tray icon as the web app's desktop copy does", () => {
    const help = "Eidolon hit an internal error. Show Logs in the Help menu has the details.";
    const tray =
      "Eidolon hit an internal error. Show Logs in the tray icon's menu has the details.";
    expect(help).toContain(`${en.label.showLogs} in the ${en.label.helpMenu} menu`);
    expect(webChinese(help)).toContain(`「${zh.label.helpMenu}」菜单的「${zh.label.showLogs}」`);
    expect(webChinese(tray)).toContain("托盘图标");
    expect(en.text.hideNotice).toContain("tray icon");
    expect(zh.text.hideNotice).toContain("托盘图标");
    expect(zh.text.failed).toContain(`「${zh.label.showLogs}」`);
    expect(webChinese("Try Again")).toBe(zh.label.tryAgain);
    expect(webChinese("Cancel")).toBe(zh.label.cancel);
    expect(`${webChinese("Settings")}…`).toBe(zh.label.settings);
  });

  test("her menu's words are the web app's Chinese where its catalog has them", () => {
    expect(webChinese("Call")).toBe(zh.label.call);
    expect(webChinese("Hang Up")).toBe(zh.label.hangUp);
    expect(webChinese("Appearance")).toBe(zh.label.appearance);
    expect(webChinese("As Exported")).toBe(zh.label.asExported);
    expect(webChinese("Mute your mic")).toBe(zh.label.muteMicrophone);
    expect(webChinese("Unmute your mic")).toBe(zh.label.unmuteMicrophone);
    expect([en.label.desktopCompanion, en.label.alwaysOnTop, en.label.hangUp]).toEqual([
      "Desktop Companion",
      "Always on Top",
      "Hang Up",
    ]);
  });

  test("the tray's and the Window menu's Desktop Companion is Settings' word for her", () => {
    expect(webChinese("Desktop Companion")).toBe(zh.label.desktopCompanion);
  });

  test("names the holder of the data home by what its lock and refusal tell", () => {
    expect(en.text.heldDetail({ pid: 4821, port: 7860 })).toBe(
      "It runs as process 4821 on port 7860. This window can't connect to it. Quit it, then try again.",
    );
    expect(en.text.heldDetail({ pid: 4821, port: null })).toBe(
      "It runs as process 4821. This window can't connect to it. Quit it, then try again.",
    );
    expect(en.text.heldDetail({ pid: null, port: 7860 })).toBe(
      "It runs on port 7860. This window can't connect to it. Quit it, then try again.",
    );
    expect(en.text.heldDetail({ pid: null, port: null })).toBe(
      "This window can't connect to it. Quit it, then try again.",
    );
    expect(zh.text.heldDetail({ pid: 4821, port: 7860 })).toBe(
      "它的进程号是 4821，端口是 7860。这个窗口无法连接到它。请先退出它，然后重试。",
    );
    expect(zh.text.heldDetail({ pid: null, port: null })).toBe(
      "这个窗口无法连接到它。请先退出它，然后重试。",
    );
  });

  test("says why the server stopped in both languages, as a sentence", () => {
    const stops = [
      { reason: "exited", code: 1, signal: null },
      { reason: "exited", code: null, signal: "SIGKILL" },
      { reason: "exited" },
      { reason: "no-listening" },
      { reason: "token" },
      { reason: "unanswered" },
      { reason: "error" },
    ] as const;
    expect(stops.map((stop) => en.text.serverStop(stop))).toEqual([
      "It exited with code 1.",
      "It was ended by SIGKILL.",
      "It exited.",
      "It didn't finish starting within 60 seconds, so LAPLACE Eidolon stopped it.",
      "It started but left no local-token to connect with, so LAPLACE Eidolon stopped it.",
      "It didn't answer for 60 seconds, so LAPLACE Eidolon stopped it.",
      "It couldn't be started.",
    ]);
    expect(stops.map((stop) => zh.text.serverStop(stop))).toEqual([
      "它退出了，退出码为 1。",
      "它被 SIGKILL 信号结束了。",
      "它退出了。",
      "它没有在 60 秒内完成启动，LAPLACE Eidolon 已将它停止。",
      "它启动了，但没有留下可用于连接的 local-token，LAPLACE Eidolon 已将它停止。",
      "它已有 60 秒没有响应，LAPLACE Eidolon 已将它停止。",
      "它无法启动。",
    ]);
    const english = stops.map((stop) => en.text.serverStop(stop));
    expect(english.filter((line) => titleCase(line) === line)).toEqual([]);
  });

  test("counts what a quit stops in Chinese, and names both versions in the About panel", () => {
    expect(zh.text.quitDetail({ calls: 2, tasks: 0, jobs: 1 })).toBe(
      "2 个通话和 1 个作业会在退出时中断。",
    );
    expect(zh.text.quitDetail({ calls: 0, tasks: 3, jobs: 0 })).toBe("3 个任务会在退出时中断。");
    expect(en.text.aboutServer("0.13.0")).toBe("Server 0.13.0");
    expect(zh.text.aboutServer("0.13.0")).toBe("服务器 0.13.0");
  });

  test("names what the restart that installs an update stops, as the quit box does", () => {
    const stopping = { calls: 1, tasks: 2, jobs: 1 };
    expect(en.text.restartDetail(stopping)).toBe("Restarting stops the call, 2 tasks and a job.");
    expect(en.text.quitDetail(stopping)).toBe("Quitting stops the call, 2 tasks and a job.");
    expect(zh.text.restartDetail(stopping)).toBe("通话、2 个任务和 1 个作业会在重启时中断。");
    expect(en.text.restartUnknown).toContain("Restarting stops any call, task or job");
    expect(webChinese("Restart")).toBe(zh.label.restart);
  });

  test("says unsaved changes will be lost in the studio's own words, after what else stops", () => {
    const lost = "Your unsaved changes will be lost.";
    expect(en.text.unsavedLost(null)).toBe(lost);
    expect(titleCase(lost)).not.toBe(lost);
    expect(zh.text.unsavedLost(null)).toBe(webChinese(lost));
    const stopping = { calls: 1, tasks: 0, jobs: 2 };
    expect(en.text.unsavedLost(en.text.quitDetail(stopping))).toBe(
      "Quitting stops the call and 2 jobs. Your unsaved changes will be lost.",
    );
    expect(en.text.unsavedLost(en.text.restartUnknown)).toBe(
      "LAPLACE Eidolon couldn't check what's running. Restarting stops any call, task or job in progress. Your unsaved changes will be lost.",
    );
    expect(zh.text.unsavedLost(zh.text.quitDetail(stopping))).toBe(
      "通话和 2 个作业会在退出时中断。未保存的修改将会丢失。",
    );
    expect(zh.text.unsavedLost(zh.text.restartUnknown)).toBe(
      "LAPLACE Eidolon 无法确认正在运行的内容。进行中的通话、任务和作业都会在重启时中断。未保存的修改将会丢失。",
    );
  });
});

describe("shellLanguage", () => {
  test("is the page's once it has reported one", () => {
    expect(shellLanguage("zh-Hans", ["en-US"])).toBe("zh-Hans");
    expect(shellLanguage("en", ["zh-Hans-CN"])).toBe("en");
  });

  test("before that, the system's first Chinese or English preference, else English", () => {
    expect(shellLanguage(null, ["fr-FR", "zh-Hant-TW", "en-US"])).toBe("zh-Hans");
    expect(shellLanguage(null, ["ZH-CN"])).toBe("zh-Hans");
    expect(shellLanguage(null, ["en-GB", "zh-Hans-CN"])).toBe("en");
    expect(shellLanguage(null, ["fr-FR", "de"])).toBe("en");
    expect(shellLanguage(null, [])).toBe("en");
  });

  test("takes only the web app's languages as a report", () => {
    expect(LANGUAGES.filter(isLanguage)).toEqual(["en", "zh-Hans"]);
    for (const value of ["zh-CN", "zh", "EN", "", null, 1, {}])
      expect(isLanguage(value)).toBe(false);
  });
});
