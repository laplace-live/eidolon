// The shell's own words, in the web app's two languages: its menus, the tray, its dialogs, and the
// pages main serves while the web app can't show. They follow the language the page reports, and
// the system's before it has.
import type { Language } from "../shared/bridge.ts";

/** What a quit would stop. */
export interface Stopping {
  readonly calls: number;
  readonly tasks: number;
  readonly jobs: number;
}

/** The Eidolon that holds the data home, as far as its lock and its refusal name it. */
export interface Holder {
  readonly pid: number | null;
  readonly port: number | null;
}

/**
 * Why the server stopped, or never started: `no-listening`, `token` and `unanswered` are main
 * stopping it, after 60 s without listening, with no local-token, or 60 s without an answer.
 */
export interface ServerStop {
  readonly reason: "exited" | "no-listening" | "token" | "unanswered" | "error";
  readonly code?: number | null;
  readonly signal?: string | null;
}

export interface Strings {
  /** Menu items, buttons and the tray's tooltip: Title Case in English. */
  readonly label: {
    readonly aboutEidolon: string;
    readonly settings: string;
    readonly hideEidolon: string;
    readonly hideOthers: string;
    readonly showAll: string;
    readonly quitEidolon: string;
    readonly editMenu: string;
    readonly undo: string;
    readonly redo: string;
    readonly cut: string;
    readonly copy: string;
    readonly paste: string;
    readonly pasteAndMatchStyle: string;
    readonly delete: string;
    readonly selectAll: string;
    readonly viewMenu: string;
    readonly actualSize: string;
    readonly zoomIn: string;
    readonly zoomOut: string;
    readonly toggleFullScreen: string;
    /** Unpackaged builds only. */
    readonly toggleDevTools: string;
    readonly windowMenu: string;
    readonly minimize: string;
    readonly zoom: string;
    /** ⌘W, which hides the window. */
    readonly closeWindow: string;
    readonly bringAllToFront: string;
    readonly helpMenu: string;
    readonly showLogs: string;
    readonly openDataFolder: string;
    readonly licenses: string;
    /** The tray menu's first item, which a click on the icon also does. */
    readonly openEidolon: string;
    readonly trayTooltip: string;
    readonly quit: string;
    readonly cancel: string;
    readonly ok: string;
    readonly tryAgain: string;
    /** Over the failure page's last lines of the server's stderr. */
    readonly details: string;
  };
  /** Sentences, titles phrased as one, and statuses: sentence case. */
  readonly text: {
    /** The loading page, before the backend is ready. */
    readonly loading: string;
    /** The page served in place of a document while no backend answers. */
    readonly waiting: string;
    /** The failure page's title when the backend ended or never got ready. */
    readonly serverStopped: string;
    /** The failure page's title when the window's page failed: a load, the preload, the renderer. */
    readonly windowFailed: string;
    /** The failure page's text under either title. */
    readonly failed: string;
    /** The failure page's first line under `serverStopped`: why. */
    readonly serverStop: (stop: ServerStop) => string;
    /** The failure page's title when another Eidolon holds the data home. */
    readonly held: string;
    readonly heldDetail: (holder: Holder) => string;
    readonly quitTitle: string;
    readonly quitDetail: (stopping: Stopping) => string;
    /** The quit box's text when the backend didn't say in time what runs. */
    readonly quitUnknown: string;
    /** Windows' one-time notice when closing first hides the window. */
    readonly hideNoticeTitle: string;
    readonly hideNotice: string;
    /** macOS, once the owner has denied Eidolon the microphone, which it never asks for again. */
    readonly microphoneTitle: string;
    readonly microphone: string;
    /** The About panel's line for the server the app ships, beside the app's own version. */
    readonly aboutServer: (version: string) => string;
  };
}

/** "a", "a and b", "a, b and c". */
function listEn(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "a", "a和b", "a、b和c"; a number after 和 gets a space, as in the web app's Chinese. */
function listZh(items: readonly string[]): string {
  const last = items.at(-1);
  if (last === undefined || items.length === 1) return last ?? "";
  return `${items.slice(0, -1).join("、")}和${/^[0-9A-Za-z]/.test(last) ? " " : ""}${last}`;
}

const en: Strings = {
  label: {
    aboutEidolon: "About Eidolon",
    settings: "Settings…",
    hideEidolon: "Hide Eidolon",
    hideOthers: "Hide Others",
    showAll: "Show All",
    quitEidolon: "Quit Eidolon",
    editMenu: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    pasteAndMatchStyle: "Paste and Match Style",
    delete: "Delete",
    selectAll: "Select All",
    viewMenu: "View",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    toggleFullScreen: "Toggle Full Screen",
    toggleDevTools: "Toggle Developer Tools",
    windowMenu: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    closeWindow: "Close Window",
    bringAllToFront: "Bring All to Front",
    helpMenu: "Help",
    showLogs: "Show Logs",
    openDataFolder: "Open Data Folder",
    licenses: "Licenses",
    openEidolon: "Open Eidolon",
    trayTooltip: "Eidolon",
    quit: "Quit",
    cancel: "Cancel",
    ok: "OK",
    tryAgain: "Try Again",
    details: "Details",
  },
  text: {
    loading: "Starting Eidolon…",
    waiting: "Waiting for Eidolon's server…",
    serverStopped: "Eidolon's server stopped",
    windowFailed: "Eidolon's window ran into a problem",
    failed: "Try again. If it happens again, Show Logs has the details.",
    serverStop: ({ reason, code, signal }) => {
      switch (reason) {
        case "exited":
          if (signal) return `It was ended by ${signal}.`;
          return typeof code === "number" ? `It exited with code ${code}.` : "It exited.";
        case "no-listening":
          return "It didn't finish starting within 60 seconds, so Eidolon stopped it.";
        case "token":
          return "It started but left no local-token to connect with, so Eidolon stopped it.";
        case "unanswered":
          return "It didn't answer for 60 seconds, so Eidolon stopped it.";
        case "error":
          return "It couldn't be started.";
      }
    },
    held: "Another Eidolon is using this data home",
    heldDetail: ({ pid, port }) => {
      const known =
        pid !== null && port !== null
          ? `It runs as process ${pid} on port ${port}. `
          : pid !== null
            ? `It runs as process ${pid}. `
            : port !== null
              ? `It runs on port ${port}. `
              : "";
      return `${known}This window can't connect to it. Quit it, then try again.`;
    },
    quitTitle: "Quit Eidolon?",
    quitDetail: ({ calls, tasks, jobs }) => {
      const parts = [
        calls === 1 ? "the call" : calls > 1 ? `${calls} calls` : null,
        tasks === 1 ? "a task" : tasks > 1 ? `${tasks} tasks` : null,
        jobs === 1 ? "a job" : jobs > 1 ? `${jobs} jobs` : null,
      ].filter((part) => part !== null);
      return `Quitting stops ${listEn(parts)}.`;
    },
    quitUnknown:
      "Eidolon couldn't check what's running. Quitting stops any call, task or job in progress.",
    hideNoticeTitle: "Eidolon is still running",
    hideNotice:
      "Calls, tasks and jobs keep going while the window is closed. Click the tray icon to open it " +
      "again, or quit Eidolon from the icon's menu.",
    microphoneTitle: "Eidolon can't use the microphone",
    microphone:
      "Turn on Eidolon under Privacy & Security → Microphone in System Settings, then quit Eidolon " +
      "and open it again.",
    aboutServer: (version) => `Server ${version}`,
  },
};

const zhHans: Strings = {
  label: {
    aboutEidolon: "关于 Eidolon",
    settings: "设置…",
    hideEidolon: "隐藏 Eidolon",
    hideOthers: "隐藏其他",
    showAll: "全部显示",
    quitEidolon: "退出 Eidolon",
    editMenu: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    pasteAndMatchStyle: "粘贴并匹配样式",
    delete: "删除",
    selectAll: "全选",
    viewMenu: "显示",
    actualSize: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    toggleFullScreen: "切换全屏",
    toggleDevTools: "切换开发者工具",
    windowMenu: "窗口",
    minimize: "最小化",
    zoom: "缩放",
    closeWindow: "关闭窗口",
    bringAllToFront: "前置全部窗口",
    helpMenu: "帮助",
    showLogs: "显示日志",
    openDataFolder: "打开数据目录",
    licenses: "许可证",
    openEidolon: "打开 Eidolon",
    trayTooltip: "Eidolon",
    quit: "退出",
    cancel: "取消",
    ok: "确定",
    tryAgain: "重试",
    details: "详情",
  },
  text: {
    loading: "正在启动 Eidolon…",
    waiting: "正在等待 Eidolon 的服务器…",
    serverStopped: "Eidolon 的服务器停止了",
    windowFailed: "Eidolon 的窗口出了问题",
    failed: "请重试。如果再次出现，详情请在「显示日志」中查看。",
    serverStop: ({ reason, code, signal }) => {
      switch (reason) {
        case "exited":
          if (signal) return `它被 ${signal} 信号结束了。`;
          return typeof code === "number" ? `它退出了，退出码为 ${code}。` : "它退出了。";
        case "no-listening":
          return "它没有在 60 秒内完成启动，Eidolon 已将它停止。";
        case "token":
          return "它启动了，但没有留下可用于连接的 local-token，Eidolon 已将它停止。";
        case "unanswered":
          return "它已有 60 秒没有响应，Eidolon 已将它停止。";
        case "error":
          return "它无法启动。";
      }
    },
    held: "另一个 Eidolon 正在使用这个数据目录",
    heldDetail: ({ pid, port }) => {
      const known =
        pid !== null && port !== null
          ? `它的进程号是 ${pid}，端口是 ${port}。`
          : pid !== null
            ? `它的进程号是 ${pid}。`
            : port !== null
              ? `它的端口是 ${port}。`
              : "";
      return `${known}这个窗口无法连接到它。请先退出它，然后重试。`;
    },
    quitTitle: "退出 Eidolon？",
    quitDetail: ({ calls, tasks, jobs }) => {
      const parts = [
        calls === 1 ? "通话" : calls > 1 ? `${calls} 个通话` : null,
        tasks > 0 ? `${tasks} 个任务` : null,
        jobs > 0 ? `${jobs} 个作业` : null,
      ].filter((part) => part !== null);
      return `${listZh(parts)}会在退出时中断。`;
    },
    quitUnknown: "Eidolon 无法确认正在运行的内容。进行中的通话、任务和作业都会在退出时中断。",
    hideNoticeTitle: "Eidolon 仍在运行",
    hideNotice:
      "关闭窗口后，通话、任务和作业会继续进行。点击托盘图标即可重新打开窗口，也可以在托盘图标的菜单中退出 Eidolon。",
    microphoneTitle: "Eidolon 无法使用麦克风",
    microphone:
      "请在「系统设置」→「隐私与安全性」→「麦克风」中打开 Eidolon，然后退出 Eidolon 再重新打开。",
    aboutServer: (version) => `服务器 ${version}`,
  },
};

export const STRINGS: Readonly<Record<Language, Strings>> = { en, "zh-Hans": zhHans };

/**
 * The language the page last reported, else the first Chinese or English entry of the system's
 * preferences (`app.getPreferredSystemLanguages()`), as the web app picks from the browser's.
 */
export function shellLanguage(reported: Language | null, system: readonly string[]): Language {
  if (reported !== null) return reported;
  for (const tag of system) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary === "zh") return "zh-Hans";
    if (primary === "en") return "en";
  }
  return "en";
}
