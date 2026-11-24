// The shell's own words, in the web app's two languages: its menus, the tray, its dialogs, its
// notifications, and the pages main serves while the web app can't show. They follow the language
// the page reports, and the system's before it has.
import type { Language } from "../shared/bridge.ts";
import type { NotesLabels } from "../shared/release-notes.ts";
import type { NoticeKind } from "./task-notices.ts";

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
    readonly checkForUpdates: string;
    readonly settings: string;
    /** macOS's Services submenu, which the system fills. */
    readonly services: string;
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
    readonly download: string;
    readonly later: string;
    /** Opens the release's page on GitHub. */
    readonly releaseNotes: string;
    /** Restarts into a downloaded update. */
    readonly restart: string;
    /** The folder dialog's title, where the OS shows one, and its button. */
    readonly chooseFolderTitle: string;
    readonly chooseFolderButton: string;
    /** The tray's and macOS's Window menu's checkbox for her. */
    readonly desktopCompanion: string;
    /** Her own menu's items. */
    readonly call: string;
    readonly hangUp: string;
    readonly muteMicrophone: string;
    readonly unmuteMicrophone: string;
    readonly appearance: string;
    readonly outfit: string;
    /** Her outfit as her model was exported. */
    readonly asExported: string;
    readonly size: string;
    readonly small: string;
    readonly medium: string;
    readonly large: string;
    readonly alwaysOnTop: string;
    readonly hide: string;
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
    /** The same box before the restart that installs an update. */
    readonly restartTitle: string;
    readonly restartDetail: (stopping: Stopping) => string;
    readonly restartUnknown: string;
    readonly updateAvailableTitle: (version: string) => string;
    /** Under it, with the version that runs now. */
    readonly updateAvailable: (current: string) => string;
    /** The release notes under it: each kind's label, and the line counting what didn't fit. */
    readonly notes: NotesLabels;
    readonly updateDownloadedTitle: string;
    readonly updateDownloaded: (version: string) => string;
    /** Check for Updates… alone says so; the check after launch only logs it. */
    readonly upToDateTitle: string;
    readonly upToDate: (version: string) => string;
    readonly checkFailedTitle: string;
    readonly downloadFailedTitle: string;
    /** Under either failure. */
    readonly updateFailed: string;
    /** Check for Updates… on macOS, from a read-only volume: a disk image or a translocated copy. */
    readonly readOnlyTitle: string;
    readonly readOnly: string;
    /** Windows' one-time notice when closing first hides the window. */
    readonly hideNoticeTitle: string;
    readonly hideNotice: string;
    /** macOS, once the owner has denied Eidolon the microphone, which it never asks for again. */
    readonly microphoneTitle: string;
    readonly microphone: string;
    /** The About panel's line for the server the app ships, beside the app's own version. */
    readonly aboutServer: (version: string) => string;
    /** The folder dialog's message, on macOS. */
    readonly chooseFolder: string;
    /** macOS's administrator prompt, when /usr/local/bin takes one to change the terminal command. */
    readonly installCommandPrompt: string;
    readonly removeCommandPrompt: string;
  };
  /** A task notification's line under her name, by its kind: sentence case. */
  readonly notice: Readonly<Record<NoticeKind, string>>;
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

/** "the call, 2 tasks and a job". */
function stoppingEn({ calls, tasks, jobs }: Stopping): string {
  return listEn(
    [
      calls === 1 ? "the call" : calls > 1 ? `${calls} calls` : null,
      tasks === 1 ? "a task" : tasks > 1 ? `${tasks} tasks` : null,
      jobs === 1 ? "a job" : jobs > 1 ? `${jobs} jobs` : null,
    ].filter((part) => part !== null),
  );
}

/** "通话、2 个任务和 1 个作业". */
function stoppingZh({ calls, tasks, jobs }: Stopping): string {
  return listZh(
    [
      calls === 1 ? "通话" : calls > 1 ? `${calls} 个通话` : null,
      tasks > 0 ? `${tasks} 个任务` : null,
      jobs > 0 ? `${jobs} 个作业` : null,
    ].filter((part) => part !== null),
  );
}

const en: Strings = {
  label: {
    aboutEidolon: "About Eidolon",
    checkForUpdates: "Check for Updates…",
    settings: "Settings…",
    services: "Services",
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
    download: "Download",
    later: "Later",
    releaseNotes: "Release Notes",
    restart: "Restart",
    chooseFolderTitle: "Choose a Folder",
    chooseFolderButton: "Choose",
    desktopCompanion: "Desktop Companion",
    call: "Call",
    hangUp: "Hang Up",
    muteMicrophone: "Mute Microphone",
    unmuteMicrophone: "Unmute Microphone",
    appearance: "Appearance",
    outfit: "Outfit",
    asExported: "As Exported",
    size: "Size",
    small: "Small",
    medium: "Medium",
    large: "Large",
    alwaysOnTop: "Always on Top",
    hide: "Hide",
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
    quitDetail: (stopping) => `Quitting stops ${stoppingEn(stopping)}.`,
    quitUnknown:
      "Eidolon couldn't check what's running. Quitting stops any call, task or job in progress.",
    restartTitle: "Restart Eidolon?",
    restartDetail: (stopping) => `Restarting stops ${stoppingEn(stopping)}.`,
    restartUnknown:
      "Eidolon couldn't check what's running. Restarting stops any call, task or job in progress.",
    updateAvailableTitle: (version) => `Eidolon ${version} is available`,
    updateAvailable: (current) =>
      `You have ${current}. Eidolon downloads the update in the background, then asks before restarting.`,
    notes: {
      kinds: {
        feature: "New",
        performance: "Faster",
        improvement: "Improved",
        fix: "Fixed",
        other: "Other",
      },
      more: (count) =>
        count === 1
          ? "1 more change isn't listed here."
          : `${count} more changes aren't listed here.`,
    },
    updateDownloadedTitle: "Restart to finish updating",
    updateDownloaded: (version) =>
      `Eidolon ${version} is downloaded. Restart now to install it, or it installs the next time you quit Eidolon.`,
    upToDateTitle: "Eidolon is up to date",
    upToDate: (version) => `Eidolon ${version} is the latest version.`,
    checkFailedTitle: "Eidolon couldn't check for updates",
    downloadFailedTitle: "Eidolon couldn't download the update",
    updateFailed:
      "Check your internet connection, then try again. If it happens again, Show Logs has the details.",
    readOnlyTitle: "Eidolon can't update itself here",
    readOnly:
      "Eidolon updates itself only from a folder it can write to. Move it to the Applications " +
      "folder, then open it again.",
    hideNoticeTitle: "Eidolon is still running",
    hideNotice:
      "Calls, tasks and jobs keep going while the window is closed. Click the tray icon to open it " +
      "again, or quit Eidolon from the icon's menu.",
    microphoneTitle: "Eidolon can't use the microphone",
    microphone:
      "Turn on Eidolon under Privacy & Security → Microphone in System Settings, then quit Eidolon " +
      "and open it again.",
    aboutServer: (version) => `Server ${version}`,
    chooseFolder: "Her tasks can read and write in the folders you choose.",
    installCommandPrompt: "Eidolon wants to install the eidolon command in /usr/local/bin.",
    removeCommandPrompt: "Eidolon wants to remove the eidolon command from /usr/local/bin.",
  },
  notice: {
    start: "Waiting for your OK to start a task",
    read: "Waiting for your OK to read outside the task's folders",
    write: "Waiting for your OK to read and write outside the task's folders",
    fetch: "Waiting for your OK to fetch from a site",
    command: "Waiting for your OK to run a command",
    mcp: "Waiting for your OK to run a tool on an MCP server",
    spend: "The task reached its spend pause",
    stall: "The task paused after repeating itself",
    unpriced: "The task paused: its spend can't be counted",
    interrupted: "The task was interrupted",
    waiting: "Waiting for your OK to go on",
    succeeded: "Finished the task",
    failed: "The task failed",
    cancelled: "The task was stopped",
  },
};

const zhHans: Strings = {
  label: {
    aboutEidolon: "关于 Eidolon",
    checkForUpdates: "检查更新…",
    settings: "设置…",
    services: "服务",
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
    download: "下载",
    later: "稍后",
    releaseNotes: "发行说明",
    restart: "重启",
    chooseFolderTitle: "选择文件夹",
    chooseFolderButton: "选择",
    desktopCompanion: "桌面形象",
    call: "通话",
    hangUp: "挂断",
    muteMicrophone: "关闭麦克风",
    unmuteMicrophone: "打开麦克风",
    appearance: "形象",
    outfit: "服装",
    asExported: "原样",
    size: "大小",
    small: "小",
    medium: "中",
    large: "大",
    alwaysOnTop: "始终置顶",
    hide: "隐藏",
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
    quitDetail: (stopping) => `${stoppingZh(stopping)}会在退出时中断。`,
    quitUnknown: "Eidolon 无法确认正在运行的内容。进行中的通话、任务和作业都会在退出时中断。",
    restartTitle: "重启 Eidolon？",
    restartDetail: (stopping) => `${stoppingZh(stopping)}会在重启时中断。`,
    restartUnknown: "Eidolon 无法确认正在运行的内容。进行中的通话、任务和作业都会在重启时中断。",
    updateAvailableTitle: (version) => `Eidolon ${version} 已发布`,
    updateAvailable: (current) =>
      `当前版本为 ${current}。Eidolon 会在后台下载更新，下载完成后会先询问再重启。`,
    notes: {
      kinds: {
        feature: "新增",
        performance: "更快",
        improvement: "改进",
        fix: "修复",
        other: "其他",
      },
      more: (count) => `另有 ${count} 项改动未在此列出。`,
    },
    updateDownloadedTitle: "重启以完成更新",
    updateDownloaded: (version) =>
      `Eidolon ${version} 已下载完成。现在重启即可安装，否则会在下次退出 Eidolon 时安装。`,
    upToDateTitle: "Eidolon 已是最新版本",
    upToDate: (version) => `Eidolon ${version} 是最新版本。`,
    checkFailedTitle: "Eidolon 无法检查更新",
    downloadFailedTitle: "Eidolon 无法下载更新",
    updateFailed: "请检查网络连接，然后重试。如果再次出现，详情请在「显示日志」中查看。",
    readOnlyTitle: "Eidolon 无法在当前位置更新",
    readOnly: "Eidolon 只能从可写入的文件夹更新自己。请把它移到「应用程序」文件夹，然后重新打开。",
    hideNoticeTitle: "Eidolon 仍在运行",
    hideNotice:
      "关闭窗口后，通话、任务和作业会继续进行。点击托盘图标即可重新打开窗口，也可以在托盘图标的菜单中退出 Eidolon。",
    microphoneTitle: "Eidolon 无法使用麦克风",
    microphone:
      "请在「系统设置」→「隐私与安全性」→「麦克风」中打开 Eidolon，然后退出 Eidolon 再重新打开。",
    aboutServer: (version) => `服务器 ${version}`,
    chooseFolder: "她的任务可以读写你选择的文件夹。",
    installCommandPrompt: "Eidolon 想在 /usr/local/bin 安装 eidolon 命令。",
    removeCommandPrompt: "Eidolon 想从 /usr/local/bin 移除 eidolon 命令。",
  },
  notice: {
    start: "等你同意开始一个任务",
    read: "等你同意读取任务文件夹以外的内容",
    write: "等你同意读写任务文件夹以外的内容",
    fetch: "等你同意从一个网站获取内容",
    command: "等你同意运行一条命令",
    mcp: "等你同意运行 MCP 服务器的一个工具",
    spend: "任务达到了花费暂停金额",
    stall: "任务在重复相同的步骤，已暂停",
    unpriced: "任务的花费无法计算，已暂停",
    interrupted: "任务被中断了",
    waiting: "等你同意继续",
    succeeded: "任务完成了",
    failed: "任务失败了",
    cancelled: "任务已停止",
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
