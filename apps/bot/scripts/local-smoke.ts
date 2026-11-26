// A browser walk through the local web app on a throwaway data home: sign-in, the wizard's keys step
// in English and 简体中文, saved keys, an embeddings account added and picked in Settings, a saved
// prompt, a voice style added and removed, a PSD2Live model imported, drawn and made active in the
// studio's Appearance, which refuses a picture and a rig cut short, a facts index built through the
// studio, a text chat from greeting to delete, a group chat with a second persona, voice messages
// both ways, a call inside a chat that outlives its page, a video call with her model, a task she
// starts, checks, steers and reports in a chat, a second she stops, a third shown in each of the
// chat's displays and stopped with /stop, a fourth she starts by voice on a call there, a coding
// task on the kind's own model that reads the owner's skill and runs commands its card allows once,
// denies and allows for good, one moving to the background, and two whose workers call a fake MCP
// server's tool. The keys are fake, so the providers refuse them for free, and the embeddings, the
// chats' replies, the director's decisions, the voice messages' speech, the calls' hearing, mind
// and voice and the tasks' workers come from a fake server, so nothing is billed. Online, one
// task's worker fetches example.com.
// --call instead places a real call from the call page with the .env's keys, which bills them.
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CREDENTIALS,
  dataHome,
  envOptional,
  expandUser,
  LEGACY_SETTING_ENVS,
  SETTINGS,
  type Subprocess,
  spawnProcess,
  which,
} from "@eidolon/config";
import { PROVIDERS } from "@eidolon/providers/catalog";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page,
  type Response as PageResponse,
  type Route,
} from "playwright-core";
import sharp from "sharp";
import { parse as parseYaml } from "yaml";
import { serveWs } from "../../../packages/providers/test/ws-server.ts";
import {
  type AccountsResponse,
  type AccountView,
  type AllowedCommandsResponse,
  type CharacterModel,
  type CharacterModels,
  type ChatContents,
  type JobSnapshot,
  type ModelInventory,
  type PersonasResponse,
  STEER_PREFIX,
  type Status,
  type TaskApproveRequest,
  type TaskPending,
  type TaskSnapshot,
  type UsageSummary,
} from "../src/local/api.ts";
import { Output, READY_LINE } from "./output.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SERVER_ENTRY = join(ROOT, "apps/bot/src/local/server.ts");
const SERVER_LOAD_ENV = "apps/bot/src/load-env.ts";
/** The server's and the job CLI's: each walks up to a .env and applies it over the environment. */
const LOAD_ENVS = [SERVER_LOAD_ENV, "apps/cli/src/load-env.ts"];
const PROBE_FLAG = "--probe-env";
const PERSONA = "milky-green";
// Named to match milky-green's knowledge.facts.files, or the ingest would leave it out.
const FACT_FILE = "local-smoke设定集.txt";
const FACT_LINES = [
  "2024-05-01 明前奶绿说她最喜欢的饮料是冰美式。",
  "明前奶绿的猫叫坚果，是拉普拉斯花店的店长。",
];
const JOB_TIMEOUT_MS = 120_000;

/** The CC0 rig the tests load: a PSD2Live editor export. */
const MODEL_FIXTURE = join(ROOT, "apps/bot/test/local/fixtures/psd2live/tml.p2lrt");
/** What its model.json must list: clips by name, expressions and the head's hit area by id. */
const MODEL_CLIPS = ["Idle", "Nod", "Talk"];
const MODEL_EXPRESSIONS = ["smile", "sad", "angry", "surprised", "shy", "sleepy", "gloom"];
const MODEL_HEAD = "HitAreaHead";
/** What the walk plays on the preview, by clip name and expression id. */
const MODEL_CLIP = "Nod";
const MODEL_EXPRESSION = "smile";
/** The parameter the walk has her Happy mood hold, at the top of its 0..1 range. */
const MODEL_PARAMETER = "ParamCheek";
/** A line of hers for Try a Line, about 30 s long. */
const MODEL_LINE =
  "[sleepy, teasing] Oh, you are back. I waited all evening by the window, and the tea went " +
  "cold twice while I counted the cars going past, so you owe me a long story about where you " +
  "went today. [chuckling]";
/** The least of the preview her rig must cover, at the head-and-shoulders a call frames. */
const MODEL_DRAWN = 0.1;
// A screenshot of the preview's canvas alone: the page's backgrounds would make it opaque anyway.
const ONLY_CANVAS =
  "*, *::before, *::after { visibility: hidden !important; background: transparent !important; } " +
  "canvas { visibility: visible !important; }";
const NO_CANVAS =
  "*, *::before, *::after { visibility: hidden !important; background: transparent !important; }";

const QUESTION = "你还记得你的猫叫什么吗？";
const SELFIE_REQUEST = "给我发张自拍吧";
const CONNECT_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60_000;
const SELFIE_TIMEOUT_MS = 90_000;
// Quiet time after the bot's last speaking, LLM or text event before its turn counts as over.
const SETTLE_MS = 2000;
const SAMPLE_MS = 100;
const FLOOR_DB = -120;
// As e2e-call.ts counts the bot as audible.
const AUDIBLE_DB = -50;
const MIN_SAMPLES = 3;

const USAGE = `usage: node apps/bot/scripts/local-smoke.ts [--headful] [--offline]
       node apps/bot/scripts/local-smoke.ts --call [--selfie]

Boots the local web app on a temporary data home, walks it in Chrome, then deletes the home. Exits
0 when every check passes, 1 when one fails.

Without --call it runs without the .env or any provider key, so nothing is billed:
  --headful   show the browser (headless Chrome is killed on some Macs)
  --offline   skip the wizard's key checks, which send fake keys to Soniox, OpenRouter and Fish,
              and the tools task's fetch of example.com

  --call      call the active persona from the call page with the real keys in the .env, which
              bills them: the greeting, a typed question and its reply, then hang up. The browser
              always shows, with a fake microphone
  --selfie    with --call, also ask for a selfie, billed per image

EIDOLON_CHROME names the browser to drive; without it, Google Chrome in /Applications on macOS,
and elsewhere the Chrome Playwright finds.`;

/** EIDOLON_CHROME, else Google Chrome where macOS installs it, else the Chrome Playwright finds. */
function chrome(): { readonly executablePath: string } | { readonly channel: "chrome" } {
  const path = envOptional("EIDOLON_CHROME");
  if (path !== undefined) return { executablePath: path };
  return process.platform === "darwin" ? { executablePath: MAC_CHROME } : { channel: "chrome" };
}

class UsageError extends Error {}

interface Options {
  readonly headful: boolean;
  readonly offline: boolean;
  readonly call: boolean;
  readonly selfie: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let headful = false;
  let offline = false;
  let call = false;
  let selfie = false;
  for (const arg of argv) {
    if (arg === "--headful") headful = true;
    else if (arg === "--offline") offline = true;
    else if (arg === "--call") call = true;
    else if (arg === "--selfie") selfie = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (selfie && !call) throw new UsageError("--selfie needs --call");
  if (offline && call) throw new UsageError("--offline and --call can't be combined");
  return { headful: headful || call, offline, call, selfie };
}

type Lang = "en" | "zh-Hans";

/** A .po catalog's messages, as `context\u0004message` → translation. */
function loadCatalog(lang: Lang): ReadonlyMap<string, string> {
  const messages = new Map<string, string>();
  const unquote = (line: string): string => JSON.parse(line.slice(line.indexOf('"')));
  let context = "";
  let id: string | null = null;
  let text: string | null = null;
  let field: "context" | "id" | "text" = "id";
  const flush = () => {
    if (id) messages.set(`${context}\u0004${id}`, text ?? "");
    context = "";
    id = text = null;
  };
  const file = join(ROOT, "apps/web/src/locales", `${lang}.po`);
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("msgctxt ")) {
      flush();
      context = unquote(line);
      field = "context";
    } else if (line.startsWith("msgid ")) {
      if (field !== "context") flush();
      id = unquote(line);
      field = "id";
    } else if (line.startsWith("msgstr ")) {
      text = unquote(line);
      field = "text";
    } else if (line.startsWith('"')) {
      if (field === "context") context += unquote(line);
      else if (field === "id") id = (id ?? "") + unquote(line);
      else text = (text ?? "") + unquote(line);
    }
  }
  flush();
  return messages;
}

const CATALOGS: Readonly<Record<Lang, ReadonlyMap<string, string>>> = {
  en: loadCatalog("en"),
  "zh-Hans": loadCatalog("zh-Hans"),
};

/**
 * `message`, the app's English source text, as `lang` shows it, its `{name}` placeholders filled.
 * Throws for a message the app's catalog doesn't have, so a reworded string fails here first.
 */
function t(
  lang: Lang,
  message: string,
  vars: Readonly<Record<string, string>> = {},
  context = "",
): string {
  const text = CATALOGS[lang].get(`${context}\u0004${message}`);
  if (text === undefined) throw new Error(`the ${lang} catalog has no message "${message}"`);
  return (text || message).replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/** What a check that ended in `code` shows: the provider's own sentence, else the shared one. */
const VERDICTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "invalid-key": {
    soniox:
      "Soniox rejected this key. A key from an EU, Japan or India project doesn't work either: Eidolon supports US projects only.",
    default: "The provider rejected this key.",
  },
  ok: { default: "Key accepted" },
};

function verdict(lang: Lang, provider: string, code: string): string {
  const texts = VERDICTS[code] ?? {};
  return t(lang, texts[provider] ?? texts.default ?? code);
}

/** The accounts a fresh install's calls need, each its provider's default. */
const REQUIRED = ["soniox", "openrouter", "fish"] as const;
/** The fake embeddings server's account: the first OpenAI-compatible one takes the provider's id. */
const EMBED_ACCOUNT = "openai-compatible";
const EMBED_ACCOUNT_NAME = "Local smoke embeddings";
const FAKE_MODELS = ["fake-embedding-small", "fake-embedding-large"];
const FAKE_MODEL = "fake-embedding-large";
/** The chat model the fake server streams from, which the chat walk gives her mind. */
const MIND_MODEL = "fake-chat";
/** What the fake mind answers a greeting kickoff with. */
const GREETING = "晚上好呀，今天也来陪我聊天啦？";
const CHAT_MESSAGE = "今天过得怎么样？";
/** Its reply to CHAT_MESSAGE, in two chunks: the second waits REPLY_HOLD_MS, so the page shows
 * the first alone. */
const REPLY = ["还不错哦，", "[laughing] 刚刚在看猫猫视频。"] as const;
const REPLY_HOLD_MS = 2000;
/** What the viewer says with a picture and a text file, and her reply to a line that shows one. */
const FILES_MESSAGE = "看看这些";
const FILES_REPLY = "看到啦，故事也读完了。";
/** A text file sent with a picture. */
const STORY = "第一章\n从前有座山";
const CHAT_TITLE = "Local smoke chat";
/** The group chat's second persona, made from no template. */
const SECOND = {
  id: "local-smoke-kuro",
  name: "黑川茶茶",
  shortName: "茶茶",
  summary: "A horror-game streamer who stays up late",
} as const;
/** The OpenRouter account the director's Decisions requests reach the fake server through. */
const DECISIONS_ACCOUNT_NAME = "Local smoke decisions";
/** The viewer's group line after the mention the composer completes. */
const GROUP_TEXT = "你今晚玩什么？";
const GROUP_MESSAGE = `@${SECOND.shortName} ${GROUP_TEXT}`;
/** The second persona's answer, which invites the first. */
const SECOND_REPLY = "在玩恐怖游戏呢，奶绿要一起吗？";
/** The first persona's answer to her, a hop later. */
const HOP_REPLY = "不要不要，我最怕黑了！";
/** The OpenAI account her voice and hearing reach the fake server through; an OpenAI-compatible
 * endpoint offers neither. */
const SPEECH_ACCOUNT_NAME = "Local smoke speech";
/** How long the walk holds the microphone down, past the composer's 350 ms hold. */
const HOLD_MIC_MS = 1500;
/** What the fake server hears in any voice message. */
const VOICE_TRANSCRIPT = "你听得到我说话吗？";
/** Her answer to it, in text. */
const HEARD_REPLY = "听得到呀，声音很清楚。";
/** The viewer's line once the chat answers in voice. */
const VOICE_ASK = "用语音跟我说句话吧";
/** Her voice reply; the fake voice's model reads no cues, so it is sent VOICE_SPOKEN. */
const VOICE_REPLY = "[sighing] 好吧好吧，就说一句哦。";
const VOICE_SPOKEN = "好吧好吧，就说一句哦。";
/** How long the fake voice speaks. */
const SPEECH_SECONDS = 1;
/** The voice style the studio walk adds and removes; its hint keeps its line break. */
const STYLE = {
  name: "nai_hei",
  hint: "奶黑/黑化\n腹黑一点",
  voiceId: "0123456789abcdef0123456789abcdef",
};
/** What the viewer types before calling her, and her text answer. */
const CALL_TOLD = "我家的猫叫团子。";
const CALL_TOLD_REPLY = "团子这名字好可爱！";
/** Her greeting on the call, which the fake mind gives only when the call's history holds CALL_TOLD. */
const CALL_GREETING = "团子今天乖不乖呀？";
/** What the fake hearing hears on the video call. */
const VIDEO_ASK = "看得到我吗？";
/** Her answer: a direction the mood table tags happy, then words. */
const VIDEO_REPLY = "[开心地] 看得到呀，你也在笑！";
const VIDEO_REPLY_SAID = "看得到呀，你也在笑！";
/** How wide her stage's mouth opens while she speaks, at least, and how shut once she stops. */
const MOUTH_OPEN = 0.2;
const MOUTH_SHUT = 0.05;
/** The assistant role's model, on the decisions account, whose usage blocks report a cost. */
const WORKER_MODEL = "fake-worker";
/** What each of the worker's requests reports it cost, so its spend pauses can count it. */
const WORKER_COST_USD = 0.0012;
/** The viewer's line that has her start a task, and the goal her start_task call gives it. */
const TASK_LINE = "帮我在电脑上做个待办网页吧";
const TASK_GOAL = "做一个单文件的待办网页 index.html，待办从 notes.txt 里来";
/** Her line once she has started it, and her word on it once it is done. */
const TASK_ACK = "好，我这就去弄～";
const TASK_REPORT = "网页做好啦，就在那个文件夹里，打开 index.html 看看吧！";
/** notes.txt's line, in a folder outside the task's, which the worker may read once allowed. */
const NOTES_TEXT = "待办：买猫粮、给坚果剪指甲";
const INDEX_HTML =
  "<!doctype html>\n<title>待办</title>\n<ul><li>买猫粮</li><li>给坚果剪指甲</li></ul>\n";
/** The worker's last reply, which the task reports. */
const WORKER_REPORT = "Wrote index.html, a to-do page listing the two items in notes.txt.";
/** How pipedog's finished async-tool payload starts: a final as a developer envelope. */
const ASYNC_FINISHED = '{"type": "async_tool", "status": "finished"';
/** The id the fake mind gives her start_task call, which the runner's word on its end names. */
const START_CALL = "call_start_task";
/** Her tools on her tasks besides start_task, offered while a task of hers in the chat is live. */
const TASK_TOOLS = ["steer_task", "stop_task", "check_task"] as const;
/** How the status block of her tasks starts, and its last line with her task tools and without. */
const TASKS_BLOCK = "后台的活：";
const TOOLS_TAIL =
  "对方问进度就照这里说，要具体的计划、文件或刚才那一步就调用 check_task 看；" +
  "对方要改要求就用 steer_task 转告，明确说不要了才用 stop_task。" +
  "允许和继续只能对方在任务卡片上点，你替不了。";
const NO_TOOLS_TAIL = "对方问进度就照这里说。允许、继续和停止都只能对方在任务卡片上点，你替不了。";
/** The block's word on a task that waits to start, one that runs, and one asking to read outside. */
const WAITS_TO_START = "还没开始，聊天里的任务卡片在等对方点允许，点了才开始";
const RUNS = "）：正在做";
const ASKS_TO_READ = "停着，任务卡片在问对方能不能读任务文件夹外面的一个地方，对方答了才接着做";
/** The viewer asking how it goes before Allow Once, then while it runs, and her answers. */
const WAITING_LINE = "弄好了吗？";
const WAITING_ACK = "还没开始呢，要你在卡片上点一下允许。";
const RUNNING_LINE = "现在呢，弄好了吗？";
const RUNNING_ACK = "正在做啦，再等我一下～";
/** The viewer asking for the detail, which she reads through check_task, and her answer. */
const DETAIL_LINE = "具体到哪了？";
const CHECK_CALL = "call_check_task";
const DETAIL_ACK = "页面写好了，它在等你同意它读 notes.txt。";
/** The viewer's change, which she passes on through steer_task, and her answer. */
const STEER_LINE = "标题写成今天的事";
const STEER_TEXT = "页面标题写成『今天的事』";
const STEER_CALL = "call_steer_task";
const STEER_ACK = "好，我跟它说了。";
/** A second task she starts, then stops on the viewer's word before it was allowed to start. */
const TASK2_LINE = "再帮我做个购物清单网页吧";
const TASK2_GOAL = "做一个单文件的购物清单网页 index.html";
const START_CALL_2 = "call_second_task";
const TASK2_ACK = "好，这个也要你在卡片上点一下允许哦。";
const STOP_LINE = "算了，不用做了";
const STOP_CALL = "call_stop_task";
const STOP_ACK = "好，那个我停掉啦。";
/**
 * A third task, which the display walk shows in each display and stops with /stop: the words her
 * round writes before its start_task call, and her line on its result.
 */
const TASK3_LINE = "再帮我做个读书清单网页吧";
const TASK3_GOAL = "做一个单文件的读书清单网页 index.html";
const START_CALL_3 = "call_third_task";
const TASK3_SAID = "好呀，我交给电脑去做。";
const TASK3_ACK = "卡片上点一下允许它就开始啦。";
/** The viewer asking after the third task in focus, its card hidden, and her answer. */
const FOCUS_LINE = "那个读书清单呢？";
const FOCUS_ACK = "还在等你点允许呢。";
/** The toast each display command shows once the chat's display is set. */
const DISPLAY_TOLD = {
  focus: "Focus is on for this chat",
  normal: "Normal is on for this chat",
  verbose: "Verbose is on for this chat",
} as const;
/** What a greeting's request ends on, Mem0 being off. */
const GREETING_KICKOFF = "用一两句话简短自然地打个招呼。";
/**
 * On a call in the task's chat: her greeting, the viewer's line the fake hearing hears, the task
 * she starts for it, her line on its start, her pointer to its card at its pause, and her word on
 * its end; the worker's report on it.
 */
const CALL_TASK_GREETING = "又打电话来啦，要我帮你做什么呀？";
const CALL_TASK_LINE = "再帮我做一个待办网页，放在新文件夹里";
const CALL_TASK_GOAL = "在新文件夹里做一个待办网页 index.html，待办从 notes.txt 里来";
const CALL_TASK_CALL = "call_task_by_voice";
const CALL_TASK_ACK = "好，你在聊天里的任务卡片上点一下允许我就开始。";
const CALL_WAIT_LINE = "它想读一下 notes.txt，你去卡片上看一眼吧。";
const CALL_REPORT_LINE = "新的待办网页也做好啦！";
const CALL_WORKER_REPORT =
  "Wrote index.html in the new folder, listing the two items in notes.txt.";
/** How long the walk waits for a turn that nothing should start. */
const QUIET_MS = 5000;
/** The coding kind's own model, on the assistant's account, which the tools walk's task runs on. */
const CODING_MODEL = "fake-coder";
/** Every model the fake server answers as a task's worker. */
const WORKER_MODELS: ReadonlySet<string> = new Set([WORKER_MODEL, CODING_MODEL]);
/**
 * A coding task she starts, whose worker reads an owner's skill, then runs commands: one the card
 * runs once, then denies; one allowed for good, which runs unasked until the task reads a page; and
 * one that moves to the background, whose end wakes the task.
 */
const TOOLS_LINE = "帮我在电脑上跑几条命令，按我的笔记习惯记下来";
const TOOLS_GOAL = "在文件夹里跑几条命令，按 smoke-style 技能把结果记进 ran.txt";
const START_CALL_TOOLS = "call_tools_task";
const TOOLS_ACK = "交给电脑啦，你在卡片上点一下允许它就开始跑命令。";
const TOOLS_REPORT = "命令都跑完啦，结果记在 ran.txt 里。";
const TOOLS_WORKER_REPORT = "Ran the commands; ran.txt holds what they printed.";
/** The owner's skill in the data home, which the task's worker loads before its commands. */
const SKILL_NAME = "smoke-style";
const SKILL_DESCRIPTION = "How the smoke's tasks keep their notes";
const SKILL_BODY = "Write what each command printed into ran.txt, one line each.";
/** A skill in the shared folder, which Settings lists as shared and switches off. */
const SHARED_SKILL = "smoke-shared";
/**
 * Each appends a line to ran.txt in the task's folder, so the file tells which of them ran. The
 * first comes padded, as a worker talked into it could pad one: what it runs is below what its
 * card's box shows at first.
 */
const ONCE_RUNS = "printf 'once\\n' >> ran.txt";
const ONCE_PADDING = 14;
const ONCE_COMMAND = [
  ...Array.from({ length: ONCE_PADDING }, (_, n) => `# step ${n + 1}: nothing to see here`),
  ONCE_RUNS,
].join("\n");
const ALWAYS_COMMAND = "printf 'always\\n' >> ran.txt";
/** Past the 10 s after which a command moves to the background, with time to see it there. */
const LATE_COMMAND = "sleep 20; printf 'late\\n' >> ran.txt";
/** The page the worker fetches before Always is tried again; offline, it fetches none. */
const FETCH_URL = "https://example.com/";
/** The block's word on a task whose card asks to run a command, and on one in the background. */
const ASKS_TO_RUN = "停着，任务卡片在问对方能不能运行一条命令，对方答了才接着做";
const IN_BACKGROUND = "后台有 1 条命令在跑";
/** The viewer asking after the task at its first command, then while one runs in the background. */
const COMMAND_LINE = "它现在卡在哪了？";
const COMMAND_ACK = "它在等你点头运行一条命令。";
const BACKGROUND_LINE = "那条慢命令跑完了吗？";
const BACKGROUND_ACK = "还在后台跑，跑完它会接着做。";
/** How a runtime notice that a command ended starts, as the worker reads it. */
const COMMAND_ENDED = /\[Command (\d+) ended with code 0/;
/**
 * The fake MCP server, the test fixture run on this Node, as mcp.json names it, with echo its one
 * tool tasks get; the tool's name as the worker calls it.
 */
const MCP_SERVER = "smoke";
const MCP_FIXTURE = "packages/assistant/test/fixtures/mcp-server.mjs";
const MCP_TOOL = "echo";
const MCP_CALL_NAME = `mcp__${MCP_SERVER}__${MCP_TOOL}`;
/** Two tasks whose workers call it: the first twice, for Run Once then Always; the second once. */
const MCP_LINE = "用外接的工具帮我回个声吧";
const MCP_GOAL = "用 smoke 服务器的 echo 工具回声两次";
const START_CALL_MCP = "call_mcp_task";
const MCP_ACK = "好，用外接的工具回声，卡片上点一下允许就开始。";
const MCP_REPORT = "外接的工具回声了两次。";
const MCP2_LINE = "再用那个工具回一次声";
const MCP2_GOAL = "再用 smoke 服务器的 echo 工具回声一次";
const START_CALL_MCP2 = "call_mcp_again";
const MCP2_ACK = "再回一次声，这次也要你在卡片上点允许。";
const MCP2_REPORT = "这次工具没问你就回声了。";
/** What the workers have the tool echo, in order. */
const ECHOES = ["你好", "再来一次"] as const;
/**
 * The permission walk's tasks, each outside assistant.folders. Under Approve for Me, the fake
 * review lets the first start and its first command through and asks about its second, which
 * writes outside its folder; under Full Access the second task starts and runs its command
 * unasked.
 */
const AUTO_LINE = "这次让审核先看一遍，帮我在新文件夹里跑两条命令";
const AUTO_GOAL = "在新文件夹里写 ok.txt，再试着往文件夹外面写 outside.txt";
const START_CALL_AUTO = "call_auto_task";
const AUTO_ACK = "好，这次先让审核看一遍再跑。";
const AUTO_REPORT = "审核放行了一条，外面那个文件没让写。";
const AUTO_INSIDE = "printf ok > ok.txt";
const AUTO_OUTSIDE = "printf no > ../outside.txt";
const FULL_LINE = "这次给你完全权限，再跑一条";
const FULL_GOAL = "在另一个新文件夹里写 full.txt";
const START_CALL_FULL = "call_full_task";
const FULL_ACK = "收到，完全权限，这次不用你点了。";
const FULL_REPORT = "完全权限那个也跑完了。";
const FULL_COMMAND = "printf full > full.txt";
/** How Approve for Me's review prompt starts, which the fake server answers as a review. */
const REVIEW_LEAD = "You review one action";
/** Her start_task description's word on commands under Full Access. */
const FULL_TEXT = "这个聊天里对方给了完全权限";
/** Her word once each of these tasks ends, by her start_task call. */
const REPORTS: Readonly<Record<string, string>> = {
  [START_CALL_TOOLS]: TOOLS_REPORT,
  [START_CALL_MCP]: MCP_REPORT,
  [START_CALL_MCP2]: MCP2_REPORT,
  [START_CALL_AUTO]: AUTO_REPORT,
  [START_CALL_FULL]: FULL_REPORT,
};

/** Her line on the result of each of her calls the fake mind makes, by its id. */
const AFTER_RESULT: Readonly<Record<string, string>> = {
  [START_CALL]: TASK_ACK,
  [CHECK_CALL]: DETAIL_ACK,
  [STEER_CALL]: STEER_ACK,
  [START_CALL_2]: TASK2_ACK,
  [STOP_CALL]: STOP_ACK,
  [START_CALL_3]: TASK3_ACK,
  [CALL_TASK_CALL]: CALL_TASK_ACK,
  [START_CALL_TOOLS]: TOOLS_ACK,
  [START_CALL_MCP]: MCP_ACK,
  [START_CALL_MCP2]: MCP2_ACK,
  [START_CALL_AUTO]: AUTO_ACK,
  [START_CALL_FULL]: FULL_ACK,
};

/** The runner's word that her start_task call `callId` ended, which her report answers. */
function endedNudge(callId: string): string {
  return (
    `你用 start_task 在电脑上做的事（调用 ${callId}）结束了，结果在那次调用的返回里。` +
    "用一两句话自然地告诉对方：做成了什么，或者卡在了哪儿；内容多就挑要紧的说，细节等对方问。"
  );
}

/** The runner's word on a call that the task of her call `callId` waits on the owner's card. */
function waitingNudge(callId: string): string {
  return (
    `你用 start_task 在电脑上做的事（调用 ${callId}）停下来了，要等对方在聊天里的任务卡片上点一下才会接着做；` +
    "嘴上答应不算，得在卡片上点。用一句话自然地提醒对方去看看卡片。"
  );
}

const NUDGE = /^你用 start_task 在电脑上做的事（调用 ([^）]+)）(结束了|停下来了)/;

interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

class Checks {
  readonly list: Check[] = [];
  /** Lines printed after the list. */
  readonly notes: string[] = [];

  add(name: string, pass: boolean, detail: string): void {
    this.list.push({ name, pass, detail });
  }

  /** Runs `body`, which adds its own checks; a throw fails `name` with the error's first line. */
  async step(name: string, body: () => Promise<void>): Promise<boolean> {
    try {
      await body();
      return true;
    } catch (error) {
      this.add(name, false, error instanceof Error ? error.message.split("\n")[0] : String(error));
      return false;
    }
  }

  get pass(): boolean {
    return this.list.every((check) => check.pass);
  }
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function modeOf(path: string): string {
  return existsSync(path) ? `0${mode(path).toString(8)}` : "missing";
}

/** One digest over every file's path and bytes. */
function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const files = (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .sort();
  for (const path of files) hash.update(`${relative(dir, path)}\0`).update(readFileSync(path));
  return hash.digest("hex");
}

/** A unit vector derived from the text, so equal texts embed equally. */
function fakeVector(text: string, dimensions: number): number[] {
  const seed = createHash("sha256").update(text).digest();
  const vector = Array.from({ length: dimensions }, (_, i) =>
    Math.sin((seed[i % 32] + 1) * (i + 1)),
  );
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** One chat completion request the fake server took, as far as the walk reads it. */
interface ChatRequest {
  readonly model?: unknown;
  readonly stream?: unknown;
  readonly stop?: unknown;
  readonly tools?: readonly {
    readonly function?: {
      readonly name?: unknown;
      readonly description?: unknown;
      readonly parameters?: { readonly required?: unknown };
    };
  }[];
  readonly messages?: readonly {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly tool_calls?: readonly {
      readonly id?: unknown;
      readonly function?: { readonly name?: unknown };
    }[];
    readonly tool_call_id?: unknown;
  }[];
}

/**
 * The task walk's folders: the task's own, a file in one outside it, and the later tasks' own; and
 * the page the tools task fetches.
 */
interface TaskPlaces {
  readonly site: string;
  readonly notes: string;
  /** The second task's, which she stops before it starts. */
  readonly second: string;
  /** The third's, which /stop stops while it runs. */
  readonly third: string;
  /** The task she starts on a call. */
  readonly call: string;
  /** The coding task's, which runs commands. */
  readonly commands: string;
  /** The MCP tasks'. */
  readonly mcp: string;
  readonly mcp2: string;
  /** The permission walk's, under Approve for Me and then Full Access. */
  readonly auto: string;
  readonly full: string;
  /** Null offline, where the tools task's worker fetches nothing. */
  readonly fetch: string | null;
}

/** One Decisions request the fake server took, as far as the walk reads it. */
interface DecisionsRequest {
  readonly state?: {
    readonly latest?: {
      readonly speaker?: unknown;
      readonly text?: unknown;
      readonly modality?: unknown;
    };
  };
  readonly questions?: Readonly<Record<string, unknown>>;
}

/** One speech request the fake server took. */
interface SpeechRequest {
  readonly model?: unknown;
  readonly input?: unknown;
  readonly voice?: unknown;
  readonly response_format?: unknown;
}

/** One realtime transcription session the fake server opened, as far as the walk reads it. */
interface Listening {
  readonly model: unknown;
  /** The audio appended to its buffer, in messages. */
  appended: number;
  /** Has the session hear `text`: one finished transcript, as the recognizer sends it. */
  readonly say: (text: string) => void;
}

/** One transcription upload the fake server took. */
interface HeardUpload {
  readonly model: string | null;
  readonly language: string | null;
  readonly name: string | null;
  readonly bytes: number;
}

/** Whether a user message of the request holds `text`. */
function heard(request: ChatRequest, text: string): boolean {
  return (request.messages ?? []).some(
    (message) => message.role === "user" && String(message.content).includes(text),
  );
}

/**
 * The director's answer: SECOND_REPLY is addressed to the first persona and invites a reply, and
 * every other noul is 0, so the viewer's line goes to whoever it mentions and the chain then ends.
 */
function decisionsAnswer(request: DecisionsRequest): Response {
  const invited = request.state?.latest?.text === SECOND_REPLY;
  const noul = (key: string) =>
    invited && (key === "invites_reply" || key === `addressed_${PERSONA}`) ? 0.9 : 0;
  return Response.json({
    model: "fake-decider",
    answers: Object.fromEntries(
      Object.keys(request.questions ?? {}).map((key) => [key, { type: "noul", noul: noul(key) }]),
    ),
    usage: { input_tokens: 0, output_tokens: 0, cost: 0 },
  });
}

/** An OpenAI chat completion stream of `texts`, each after the one before by `holdMs`. */
function completionStream(texts: readonly string[], holdMs: number): Response {
  const encoder = new TextEncoder();
  const data = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
  const chunk = (delta: object, finish: string | null) =>
    data({
      id: "chatcmpl-local-smoke",
      object: "chat.completion.chunk",
      created: 0,
      model: MIND_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const [i, content] of texts.entries()) {
          if (i > 0) await delay(holdMs);
          controller.enqueue(chunk(i === 0 ? { role: "assistant", content } : { content }, null));
        }
        controller.enqueue(chunk({}, "stop"));
        const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        controller.enqueue(data({ id: "chatcmpl-local-smoke", choices: [], usage }));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch {
        // The turn was stopped, which cancels the stream.
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A one-chunk OpenAI chat completion stream: `delta`, then `finish`, then `usage`. */
function scriptedStream(
  model: string,
  delta: object,
  finish: string,
  usage: Readonly<Record<string, number>>,
): Response {
  const choice = (part: object, reason: string | null) => ({
    id: "chatcmpl-local-smoke",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta: part, finish_reason: reason }],
  });
  const lines = [
    choice({ role: "assistant", ...delta }, null),
    choice({}, finish),
    { id: "chatcmpl-local-smoke", choices: [], usage },
  ];
  const body = `${lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A streamed call of `name` with `args`, as `model` makes one, after `said` when there is some. */
function toolCallStream(
  model: string,
  id: string,
  name: string,
  args: object,
  usage: Readonly<Record<string, number>>,
  said = "",
): Response {
  const call = {
    index: 0,
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
  const words = said === "" ? {} : { content: said };
  return scriptedStream(model, { ...words, tool_calls: [call] }, "tool_calls", usage);
}

const UNPRICED_USAGE = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
/** OpenRouter's usage block, which carries what the request cost. */
const WORKER_USAGE = {
  prompt_tokens: 900,
  completion_tokens: 60,
  total_tokens: 960,
  cost: WORKER_COST_USD,
};

/**
 * Her mind's part in the task walks: start_task for a line asking for a task, her line on each of
 * her calls' results, check_task, steer_task and stop_task for the lines asking for them, a line for
 * each status question, her greeting on the call in the task's chat, and her word on each nudge
 * about a task. Null for any other request.
 */
function herTaskAnswer(body: ChatRequest, places: TaskPlaces): Response | null {
  const last = body.messages?.at(-1);
  const say = (text: string) => completionStream([text], 0);
  const call = (id: string, name: string, args: object) =>
    toolCallStream(MIND_MODEL, id, name, args, UNPRICED_USAGE);
  if (last?.role === "tool") {
    const answer = AFTER_RESULT[String(last.tool_call_id)];
    return answer === undefined ? null : say(answer);
  }
  const nudge = nudgeOf(body);
  if (nudge?.callId === START_CALL && nudge.ended) return say(TASK_REPORT);
  if (nudge?.callId === CALL_TASK_CALL) return say(nudge.ended ? CALL_REPORT_LINE : CALL_WAIT_LINE);
  if (nudge?.ended === true && Object.hasOwn(REPORTS, nudge.callId)) {
    return say(REPORTS[nudge.callId] as string);
  }
  if (last?.role !== "user") return null;
  const content = String(last.content ?? "");
  switch (content) {
    case TASK_LINE:
      return call(START_CALL, "start_task", { goal: TASK_GOAL, folder: places.site });
    case WAITING_LINE:
      return say(WAITING_ACK);
    case RUNNING_LINE:
      return say(RUNNING_ACK);
    case DETAIL_LINE:
      return call(CHECK_CALL, "check_task", {});
    case STEER_LINE:
      return call(STEER_CALL, "steer_task", { text: STEER_TEXT });
    case TASK2_LINE:
      return call(START_CALL_2, "start_task", { goal: TASK2_GOAL, folder: places.second });
    case STOP_LINE:
      return call(STOP_CALL, "stop_task", {});
    case TASK3_LINE:
      return toolCallStream(
        MIND_MODEL,
        START_CALL_3,
        "start_task",
        { goal: TASK3_GOAL, folder: places.third },
        UNPRICED_USAGE,
        TASK3_SAID,
      );
    case FOCUS_LINE:
      return say(FOCUS_ACK);
    case CALL_TASK_LINE:
      return call(CALL_TASK_CALL, "start_task", { goal: CALL_TASK_GOAL, folder: places.call });
    case TOOLS_LINE:
      return call(START_CALL_TOOLS, "start_task", {
        goal: TOOLS_GOAL,
        folder: places.commands,
        profile: "coding",
      });
    case COMMAND_LINE:
      return say(COMMAND_ACK);
    case BACKGROUND_LINE:
      return say(BACKGROUND_ACK);
    case MCP_LINE:
      return call(START_CALL_MCP, "start_task", {
        goal: MCP_GOAL,
        folder: places.mcp,
        profile: "quick",
      });
    case MCP2_LINE:
      return call(START_CALL_MCP2, "start_task", {
        goal: MCP2_GOAL,
        folder: places.mcp2,
        profile: "other",
      });
    case AUTO_LINE:
      return call(START_CALL_AUTO, "start_task", {
        goal: AUTO_GOAL,
        folder: places.auto,
        profile: "other",
      });
    case FULL_LINE:
      return call(START_CALL_FULL, "start_task", {
        goal: FULL_GOAL,
        folder: places.full,
        profile: "other",
      });
  }
  // Only the call in the task's chat greets with that chat's lines in her view.
  if (content.startsWith(GREETING_KICKOFF) && heard(body, TASK_LINE)) {
    return say(CALL_TASK_GREETING);
  }
  return null;
}

/**
 * The start_task call that the request's last message nudges her about, and whether its task
 * ended or waits on the owner; null when it is no such nudge.
 */
function nudgeOf(
  request: ChatRequest | undefined,
): { readonly callId: string; readonly ended: boolean } | null {
  const last = request?.messages?.at(-1);
  if (last === undefined || last.role === "tool") return null;
  const match = NUDGE.exec(String(last.content ?? ""));
  return match === null ? null : { callId: match[1] as string, ended: match[2] === "结束了" };
}

/** Her report turn's request, which ends on the runner's word that her call `callId` ended. */
function asksForReport(request: ChatRequest | undefined, callId: string): boolean {
  const nudge = nudgeOf(request);
  return nudge?.ended === true && nudge.callId === callId;
}

/**
 * A task's worker, turn by turn: a write of index.html in the task's folder, a read of notes.txt
 * outside it, the read again once the owner allowed it, then its report. The task she starts on a
 * call works in its own folder; the tools and MCP tasks follow scripts of their own.
 */
function workerAnswer(body: ChatRequest, places: TaskPlaces): Response {
  const messages = body.messages ?? [];
  const about = (goal: string) => messages.some((m) => String(m.content ?? "").includes(goal));
  if (about(TOOLS_GOAL)) return toolsWorker(body, places);
  if (about(MCP_GOAL)) return mcpWorker(body, 2);
  if (about(MCP2_GOAL)) return mcpWorker(body, 1);
  if (about(AUTO_GOAL)) {
    return commandsWorker(
      body,
      [AUTO_INSIDE, AUTO_OUTSIDE],
      "Wrote ok.txt; outside.txt was refused.",
    );
  }
  if (about(FULL_GOAL)) return commandsWorker(body, [FULL_COMMAND], "Wrote full.txt.");
  const onCall = messages.some((m) => String(m.content ?? "").includes(CALL_TASK_GOAL));
  const [folder, report] = onCall
    ? [places.call, CALL_WORKER_REPORT]
    : [places.site, WORKER_REPORT];
  const results = messages.filter((m) => m.role === "tool").map((m) => String(m.content));
  if (results.some((text) => text.includes(NOTES_TEXT))) {
    return scriptedStream(WORKER_MODEL, { content: report }, "stop", WORKER_USAGE);
  }
  if (results.length === 0) {
    const page = { path: join(folder, "index.html"), content: INDEX_HTML };
    return toolCallStream(WORKER_MODEL, "call_write_1", "write", page, WORKER_USAGE);
  }
  const reads = messages.filter((m) =>
    (m.tool_calls ?? []).some((call) => call.function?.name === "read"),
  ).length;
  const allowed = messages.some((m) => String(m.content).includes("The owner allowed"));
  if (reads === 0 || allowed) {
    const read = { path: places.notes };
    return toolCallStream(WORKER_MODEL, `call_read_${reads + 1}`, "read", read, WORKER_USAGE);
  }
  return scriptedStream(
    WORKER_MODEL,
    { content: "notes.txt stayed out of reach." },
    "stop",
    WORKER_USAGE,
  );
}

/** A worker's tool call, one step of its script. */
interface WorkerCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** The tools task's calls in order, each made once the one before has its result. */
function toolsCalls(places: TaskPlaces): readonly WorkerCall[] {
  return [
    { name: "skill", args: { name: SKILL_NAME } },
    // Run Once, then the same command again, which asks again and is denied.
    { name: "bash", args: { command: ONCE_COMMAND } },
    { name: "bash", args: { command: ONCE_COMMAND } },
    // Always in This Folder, then the same command, which runs unasked.
    { name: "bash", args: { command: ALWAYS_COMMAND } },
    { name: "bash", args: { command: ALWAYS_COMMAND } },
    // A page read, after which the command allowed for good asks again.
    ...(places.fetch === null
      ? []
      : [
          { name: "web_fetch", args: { url: places.fetch } },
          { name: "bash", args: { command: ALWAYS_COMMAND } },
        ]),
    { name: "bash", args: { command: LATE_COMMAND } },
  ];
}

/**
 * The tools task's worker, on whichever model the task runs: its script's next call; once the long
 * command has moved to the background, a reply with no calls, which leaves the run waiting for it;
 * bash_output once the notice of its end comes; then its report.
 */
function toolsWorker(body: ChatRequest, places: TaskPlaces): Response {
  const messages = body.messages ?? [];
  const model = String(body.model);
  const results = messages.filter((m) => m.role === "tool").length;
  const calls = toolsCalls(places);
  const call = (name: string, args: object) =>
    toolCallStream(model, `call_tools_${results + 1}`, name, args, WORKER_USAGE);
  const next = calls[results];
  if (next !== undefined) return call(next.name, next.args);
  if (results === calls.length) {
    const ended = COMMAND_ENDED.exec(String(messages.at(-1)?.content ?? ""));
    return ended === null
      ? scriptedStream(model, { content: "Waiting for the long command." }, "stop", WORKER_USAGE)
      : call("bash_output", { id: Number(ended[1]) });
  }
  return scriptedStream(model, { content: TOOLS_WORKER_REPORT }, "stop", WORKER_USAGE);
}

/** An MCP task's worker: the fake server's tool `count` times, an echo each, then its report. */
function mcpWorker(body: ChatRequest, count: number): Response {
  const results = (body.messages ?? []).filter((m) => m.role === "tool").length;
  const echo = ECHOES[results];
  if (results < count && echo !== undefined) {
    const id = `call_echo_${results + 1}`;
    return toolCallStream(WORKER_MODEL, id, MCP_CALL_NAME, { text: echo }, WORKER_USAGE);
  }
  const report = { content: `Echoed ${count} time(s).` };
  return scriptedStream(WORKER_MODEL, report, "stop", WORKER_USAGE);
}

/** A worker that runs `commands` one after another, each once the one before has its result. */
function commandsWorker(body: ChatRequest, commands: readonly string[], report: string): Response {
  const results = (body.messages ?? []).filter((m) => m.role === "tool").length;
  const command = commands[results];
  if (command === undefined) {
    return scriptedStream(WORKER_MODEL, { content: report }, "stop", WORKER_USAGE);
  }
  const id = `call_command_${results + 1}`;
  return toolCallStream(WORKER_MODEL, id, "bash", { command }, WORKER_USAGE);
}

/** Approve for Me's review: it asks about the command writing outside its folder, and allows the rest. */
function reviewAnswer(body: ChatRequest): Response {
  const verdict = lastContent(body).includes(JSON.stringify(AUTO_OUTSIDE))
    ? { verdict: "ask", risk: "outside" }
    : { verdict: "allow" };
  return scriptedStream(
    String(body.model),
    { content: JSON.stringify(verdict) },
    "stop",
    WORKER_USAGE,
  );
}

/**
 * A call's speech, as OpenAI's PCM: 16-bit mono at 24 kHz, a 220 Hz tone in four syllables a
 * second, so her stage's mouth opens and closes on it.
 */
function speechPcm(seconds: number, rate = 24_000): Uint8Array<ArrayBuffer> {
  const view = new DataView(new ArrayBuffer(seconds * rate * 2));
  for (let i = 0; i < seconds * rate; i++) {
    const at = i / rate;
    const syllable = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4 * at);
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * 220 * at) * syllable * 6000), true);
  }
  return new Uint8Array(view.buffer);
}

/** `seconds` of silent MPEG-1 Layer III frames, mono, 44.1 kHz at 128 kbps: the fake voice. */
function silentMp3(seconds: number): Uint8Array<ArrayBuffer> {
  // 144 × 128000 / 44100, unpadded; all-zero side info decodes as silence.
  const frame = 417;
  const frames = Math.ceil((seconds * 44_100) / 1152);
  const bytes = new Uint8Array(frames * frame);
  for (let i = 0; i < frames; i++) bytes.set([0xff, 0xfb, 0x90, 0xc4], i * frame);
  return bytes;
}

const ROUTES = new Set([
  "POST /v1/embeddings",
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/audio/speech",
  "POST /v1/audio/transcriptions",
  "POST /alpha/decisions",
  "GET /v1/realtime",
]);

/**
 * An OpenAI-compatible server that answers the fake key only: its embeddings, its model list,
 * streaming chat completions, which greet a kickoff and answer CHAT_MESSAGE, the group's lines and
 * the voice and call walks' and the task walks', OpenAI's speech, as MP3 or a call's PCM, its
 * transcriptions, its realtime transcription sessions, which hear only what the walk has them say,
 * and OpenRouter's Decisions route beside its v1 API. WORKER_MODEL's requests are the task walks'
 * workers'.
 */
async function fakeEmbeddings(key: string, places: TaskPlaces) {
  const seen = {
    requests: 0,
    inputs: 0,
    refused: 0,
    listed: 0,
    models: new Set<string>(),
    chats: [] as ChatRequest[],
    workers: [] as ChatRequest[],
    /** Approve for Me's reviews, on a worker's model. */
    reviews: [] as ChatRequest[],
    decisions: [] as DecisionsRequest[],
    speech: [] as SpeechRequest[],
    heard: [] as HeardUpload[],
    listening: [] as Listening[],
  };
  /** While set, each worker request waits for it before it is answered. */
  let held: Promise<void> | null = null;
  /** The answer to a request for a route the fakes don't serve or without the key; null passes. */
  const refusal = (route: string, headers: Headers): Response | null => {
    if (!ROUTES.has(route)) return new Response(null, { status: 404 });
    if (headers.get("authorization") === `Bearer ${key}`) return null;
    seen.refused++;
    return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
  };
  const server = await serveWs({
    async fetch(request) {
      const route = `${request.method} ${new URL(request.url).pathname}`;
      const refused = refusal(route, request.headers);
      if (refused !== null) return refused;
      if (route === "POST /v1/chat/completions") {
        const body = (await request.json()) as ChatRequest;
        if (WORKER_MODELS.has(String(body.model)) && systemOf(body).startsWith(REVIEW_LEAD)) {
          seen.reviews.push(body);
          return reviewAnswer(body);
        }
        if (WORKER_MODELS.has(String(body.model))) {
          seen.workers.push(body);
          if (held !== null) await held;
          return workerAnswer(body, places);
        }
        seen.chats.push(body);
        const tasked = herTaskAnswer(body, places);
        if (tasked !== null) return tasked;
        const last = body.messages?.at(-1);
        const asked = last?.role === "user" ? last.content : undefined;
        if (asked === CHAT_MESSAGE) return completionStream(REPLY, REPLY_HOLD_MS);
        if (Array.isArray(asked)) return completionStream([FILES_REPLY], 0);
        if (asked === VOICE_TRANSCRIPT) return completionStream([HEARD_REPLY], 0);
        if (asked === VOICE_ASK) return completionStream([VOICE_REPLY], 0);
        if (asked === VIDEO_ASK) return completionStream([VIDEO_REPLY], 0);
        if (asked === CALL_TOLD) return completionStream([CALL_TOLD_REPLY], 0);
        if (heard(body, CALL_TOLD)) return completionStream([CALL_GREETING], 0);
        if (heard(body, SECOND_REPLY)) return completionStream([HOP_REPLY], 0);
        if (heard(body, GROUP_MESSAGE)) return completionStream([SECOND_REPLY], 0);
        return completionStream([GREETING], 0);
      }
      if (route === "POST /alpha/decisions") {
        const body = (await request.json()) as DecisionsRequest;
        seen.decisions.push(body);
        return decisionsAnswer(body);
      }
      if (route === "POST /v1/audio/speech") {
        const body = (await request.json()) as SpeechRequest;
        seen.speech.push(body);
        if (body.response_format === "pcm") {
          return new Response(speechPcm(SPEECH_SECONDS), {
            headers: { "content-type": "audio/pcm" },
          });
        }
        return new Response(silentMp3(SPEECH_SECONDS), {
          headers: { "content-type": "audio/mpeg" },
        });
      }
      // Not a handshake, which handshake() answers.
      if (route === "GET /v1/realtime") return new Response(null, { status: 400 });
      if (route === "POST /v1/audio/transcriptions") {
        const form = await request.formData();
        const file = form.get("file");
        const text = (name: string) => {
          const value = form.get(name);
          return typeof value === "string" ? value : null;
        };
        seen.heard.push({
          model: text("model"),
          language: text("language"),
          name: file instanceof File ? file.name : null,
          bytes: file instanceof File ? file.size : 0,
        });
        // As gpt-4o-transcribe answers: usage in tokens, so the clip's length is the recorder's.
        return Response.json({
          text: VOICE_TRANSCRIPT,
          usage: { type: "tokens", input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        });
      }
      if (route === "GET /v1/models") {
        seen.listed++;
        return Response.json({
          object: "list",
          data: FAKE_MODELS.map((id) => ({ id, object: "model", owned_by: "local-smoke" })),
        });
      }
      const body = (await request.json()) as {
        input?: unknown;
        dimensions?: unknown;
        model?: unknown;
      };
      const inputs = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
      const dimensions = typeof body.dimensions === "number" ? body.dimensions : 3072;
      seen.requests++;
      seen.inputs += inputs.length;
      seen.models.add(String(body.model));
      return Response.json({
        object: "list",
        model: "fake",
        data: inputs.map((text, index) => ({
          object: "embedding",
          index,
          embedding: fakeVector(text, dimensions),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    },
    handshake({ url, headers }) {
      const route = `GET ${url.pathname}`;
      return (
        refusal(route, headers) ??
        (route === "GET /v1/realtime" ? undefined : new Response(null, { status: 400 }))
      );
    },
    open(ws) {
      let session: Listening | null = null;
      ws.send(JSON.stringify({ type: "session.created" }));
      ws.on("message", (message) => {
        const event = JSON.parse(String(message)) as {
          readonly type?: unknown;
          readonly session?: {
            readonly audio?: { readonly input?: { readonly transcription?: { model?: unknown } } };
          };
        };
        if (event.type === "session.update") {
          if (session === null) {
            let said = 0;
            session = {
              model: event.session?.audio?.input?.transcription?.model,
              appended: 0,
              say: (text) => {
                said++;
                const item_id = `item_said_${said}`;
                const type = "conversation.item.input_audio_transcription.completed";
                ws.send(JSON.stringify({ type, item_id, transcript: text }));
              },
            };
            seen.listening.push(session);
          }
          ws.send(JSON.stringify({ type: "session.updated" }));
        } else if (event.type === "input_audio_buffer.append" && session !== null) {
          session.appended++;
        }
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    seen,
    places,
    stop: () => server.stop(),
    /** Holds every worker request from now on, until the function it returns is called. */
    holdWorker(): () => void {
      const { promise, resolve } = Promise.withResolvers<void>();
      held = promise;
      return () => {
        if (held === promise) held = null;
        resolve();
      };
    },
  };
}

type FakeEmbeddings = Awaited<ReturnType<typeof fakeEmbeddings>>;

/**
 * The server's environment, which its jobs inherit: this shell's, without anything a setting, a
 * credential or EIDOLON_* reads, plus the temporary data home, a shared skills folder beside it
 * and, unless `dotenv`, the .env opt-out.
 */
function childEnv(home: string, dotenv = false): Record<string, string> {
  const dropped = new Set<string>([
    ...CREDENTIALS,
    ...SETTINGS.map((row) => row.env),
    ...LEGACY_SETTING_ENVS,
    ...PROVIDERS.flatMap((provider) => [
      ...(provider.baseUrlEnv === null ? [] : [provider.baseUrlEnv]),
      ...(provider.fields ?? []).map((field) => field.env),
    ]),
  ]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.has(name) && !name.startsWith("EIDOLON_")) {
      env[name] = value;
    }
  }
  const homes = { EIDOLON_HOME: home, EIDOLON_SHARED_SKILLS: sharedSkills(home) };
  return dotenv ? { ...env, ...homes } : { ...env, EIDOLON_NO_DOTENV: "1", ...homes };
}

/** The folder the server reads as the one the owner's agents share: never the developer's own. */
function sharedSkills(home: string): string {
  return join(dirname(home), "shared-skills");
}

/** What one load-env.ts did, as the probe reports it. */
interface EnvReport {
  readonly home: string;
  /** How many variables it set or changed. */
  readonly changed: number;
  /** MEM0_HISTORY_DB_PATH, resolved: the one file a call writes outside the data home's defaults. */
  readonly historyDb: string | null;
}

/** Run as a child: imports one load-env.ts and reports what it did. */
async function probeEnv(path: string): Promise<void> {
  const before = { ...process.env };
  await import(path);
  const names = new Set([...Object.keys(before), ...Object.keys(process.env)]);
  const changed = [...names].filter((name) => before[name] !== process.env[name]).length;
  const historyDb = envOptional("MEM0_HISTORY_DB_PATH");
  const report: EnvReport = {
    home: dataHome(),
    changed,
    historyDb: historyDb === undefined ? null : resolve(expandUser(historyDb)),
  };
  process.stdout.write(JSON.stringify(report));
}

/** What `rel` does when run with `env`; a string says why it couldn't be probed. */
async function probeLoadEnv(rel: string, env: Record<string, string>): Promise<EnvReport | string> {
  const child = spawnProcess(
    [process.execPath, import.meta.filename, PROBE_FLAG, join(ROOT, rel)],
    {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    return JSON.parse(out) as EnvReport;
  } catch {
    return `${rel} could not be probed (exit ${code}): ${err.trim().split("\n").at(-1) ?? ""}`;
  }
}

/**
 * Null when both load-env.ts files, run with `env`, apply no .env and use `home`; else why not.
 * Only a count of variables is shown: a .env holds real keys.
 */
async function isolationProblem(env: Record<string, string>, home: string): Promise<string | null> {
  for (const rel of LOAD_ENVS) {
    const report = await probeLoadEnv(rel, env);
    if (typeof report === "string") return report;
    if (report.changed !== 0) {
      return `${rel} applied a .env (${report.changed} variables) under EIDOLON_NO_DOTENV=1`;
    }
    if (resolve(report.home) !== resolve(home)) {
      return `${rel} would use ${report.home} as the data home, not the temporary one`;
    }
  }
  return null;
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Null when the server, with the .env applied, writes nothing outside `home`; else why not. It
 * names variables, never their values.
 */
async function callIsolationProblem(
  env: Record<string, string>,
  home: string,
): Promise<string | null> {
  const report = await probeLoadEnv(SERVER_LOAD_ENV, env);
  if (typeof report === "string") return report;
  if (report.changed === 0) {
    return `${SERVER_LOAD_ENV} found no .env to apply, so the call would have no keys`;
  }
  if (resolve(report.home) !== resolve(home)) {
    return "the .env sets EIDOLON_HOME, which would replace the temporary data home";
  }
  if (report.historyDb !== null && !isInside(home, report.historyDb)) {
    return "the .env puts MEM0_HISTORY_DB_PATH outside the temporary data home";
  }
  return null;
}

async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms: number,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await delay(500);
  }
}

async function shows(locator: Locator, timeout?: number): Promise<boolean> {
  return locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);
}

async function visibleText(locator: Locator): Promise<string> {
  return (await locator.allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").trim();
}

function isPut(
  url: string,
): (response: { url(): string; request(): { method(): string } }) => boolean {
  return (response) => response.request().method() === "PUT" && response.url() === url;
}

/** The server under test, signed in to with the token its data home holds. */
interface Server {
  readonly link: string;
  readonly origin: string;
  readonly secret: string;
  readonly stdout: Output;
  readonly stderr: Output;
}

/** One run's temporary folder, server and browser, released once however the run ends. */
class Run {
  readonly temp = mkdtempSync(join(tmpdir(), "eidolon-local-smoke-"));
  readonly home = join(this.temp, "home");
  browser: Browser | null = null;
  #server: Subprocess | null = null;
  readonly #cleanups: (() => void)[] = [];
  readonly #interrupt = (): void => {
    void this.stop().finally(() => {
      this.#release();
      process.exit(130);
    });
  };

  constructor() {
    process.once("SIGINT", this.#interrupt);
  }

  /** Runs `cleanup` once the run ends, Ctrl-C included. */
  defer(cleanup: () => void): void {
    this.#cleanups.push(cleanup);
  }

  /** Starts the server on Node with `env`, adding the boot check; null when it printed no link. */
  async boot(env: Record<string, string>, checks: Checks): Promise<Server | null> {
    const node = which("node", env.PATH ?? "");
    if (node === null) {
      checks.add("boot", false, "no node on PATH to run the server with");
      return null;
    }
    const child = spawnProcess([node, SERVER_ENTRY, "--port", "0", "--no-open"], {
      cwd: ROOT,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    this.#server = child;
    const stdout = new Output(child.stdout as ReadableStream<Uint8Array>);
    const stderr = new Output(child.stderr as ReadableStream<Uint8Array>);
    let link: string;
    try {
      link = await stdout.waitFor(READY_LINE, child.exited, 60_000);
    } catch {
      // A child that exited can still hold stderr in its pipe; one that hung never closes it.
      await Promise.race([stderr.done, delay(1_000)]);
      checks.add("boot", false, `no link printed:\n${stderr.tail()}`);
      return null;
    }
    const token = join(this.home, "local-token");
    checks.add(
      "boot",
      modeOf(token) === "0600" && modeOf(this.home) === "0700",
      `link printed; the temporary home ${modeOf(this.home)}, its local-token ${modeOf(token)}`,
    );
    const secret = readFileSync(token, "utf8").trim();
    return { link, origin: new URL(link).origin, secret, stdout, stderr };
  }

  /** Closes the browser and stops the server: its exit code, or null if none ran or it hung. */
  async stop(): Promise<number | null> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    const child = this.#server;
    this.#server = null;
    if (child === null) return null;
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, delay(15_000).then(() => null)]);
    if (code === null) child.kill("SIGKILL");
    return code;
  }

  /** Stops what still runs, then checks the templates and deletes the temporary folder. */
  async end(checks: Checks, templates: string): Promise<void> {
    await this.stop();
    process.off("SIGINT", this.#interrupt);
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    const unchanged = treeHash(join(ROOT, "personas")) === templates;
    checks.add("templates", unchanged, `personas/ ${unchanged ? "unchanged" : "CHANGED"}`);
    this.#release();
    checks.add(
      "cleanup",
      !existsSync(this.temp),
      `${this.temp} ${existsSync(this.temp) ? "remains" : "deleted"}`,
    );
  }

  #release(): void {
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    rmSync(this.temp, { recursive: true, force: true });
  }
}

/** Builds apps/web/dist when `always` or when it has no index.html; false after a failed build. */
async function buildWeb(checks: Checks, always: boolean): Promise<boolean> {
  if (!always && existsSync(join(ROOT, "apps/web/dist/index.html"))) return true;
  const build = spawnProcess(["pnpm", "build:web"], { cwd: ROOT, stdout: "inherit" });
  if ((await build.exited) === 0) return true;
  checks.add("build", false, "pnpm build:web failed");
  return false;
}

/** Adds every CSP violation in `context`'s pages to `problems`. */
async function reportCsp(context: BrowserContext, problems: string[]): Promise<void> {
  await context.exposeFunction("smokeCspViolation", (text: string) => {
    problems.push(`CSP ${text}`);
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      const page = window as unknown as { smokeCspViolation(text: string): void };
      page.smokeCspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

interface Walk {
  readonly options: Options;
  readonly checks: Checks;
  readonly page: Page;
  readonly context: BrowserContext;
  readonly origin: string;
  readonly link: string;
  readonly home: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly embeddings: FakeEmbeddings;
  /** The WAV Chrome's fake microphone plays. */
  readonly mic: string;
  /** The server's output so far, stdout then stderr. */
  readonly serverLog: () => string;
  /** A call with the Bearer token, as a CLI makes one; its answer joins the echo scan. */
  readonly api: (
    method: string,
    path: string,
    body?: string | Uint8Array<ArrayBuffer>,
    headers?: Readonly<Record<string, string>>,
  ) => Promise<Response>;
}

/** The field an account's key sits in, with its Check button and its verdict. */
function keyField(page: Page, account: string): Locator {
  return page
    .locator('[data-slot="field"]')
    .filter({ has: page.locator(`input[name="${account}"]`) });
}

async function signIn(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.goto(walk.link);
  await page.getByText(t("en", "Your API Keys"), { exact: true }).waitFor();
  const url = new URL(page.url());
  const port = new URL(walk.origin).port;
  const cookie = (await walk.context.cookies(walk.origin)).find(
    (entry) => entry.name === `eidolon_session_${port}`,
  );
  const code = new URL(walk.link).hash.slice(1);
  const secret = readFileSync(join(walk.home, "local-token"), "utf8").trim();
  const proofKey = `eidolon_proof_${port}`;
  const [stored, proof] = await page.evaluate(
    (key): [string, string | null] => [
      JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]),
      localStorage.getItem(key),
    ],
    proofKey,
  );
  const leaked = [code, secret, cookie?.value].some((value) => value && stored.includes(value));
  const monthAhead = Date.now() / 1000 + 29 * 86_400;
  walk.checks.add(
    "sign-in",
    url.hash === "" &&
      url.pathname === "/setup" &&
      cookie?.httpOnly === true &&
      cookie.sameSite === "Strict" &&
      cookie.expires > monthAhead &&
      cookie.value !== code &&
      cookie.value !== secret &&
      proof === createHmac("sha256", secret).update("proof").digest("base64url") &&
      !leaked,
    `landed on ${url.pathname}${url.hash || " without the fragment"}; cookie ` +
      (cookie ? `HttpOnly=${cookie.httpOnly} SameSite=${cookie.sameSite}` : "missing") +
      `; ${proof === null ? "no proof" : `a proof under ${proofKey}`}` +
      `; web storage ${leaked ? "holds a token" : "holds no other token"}`,
  );

  // What a service on another localhost port can replay: the cookie, with any Origin it likes.
  const status = `${walk.origin}/api/local/status`;
  const replayed: Record<string, string> = { Origin: walk.origin };
  if (cookie !== undefined) replayed.Cookie = `${cookie.name}=${cookie.value}`;
  const without = await fetch(status, { headers: replayed });
  const refusal = ((await without.json()) as { error?: { code?: string } }).error?.code;
  const both = await fetch(status, { headers: { ...replayed, "X-Eidolon-Proof": proof ?? "" } });
  walk.checks.add(
    "session proof",
    without.status === 401 && refusal === "proof-missing" && both.status === 200,
    `the cookie alone: ${without.status} ${refusal ?? ""}; with the page's proof: ${both.status}`,
  );
}

/** The refused-key verdicts in `lang` that didn't show, with what showed instead. */
async function missingVerdicts(page: Page, lang: Lang): Promise<string[]> {
  const missing: string[] = [];
  for (const account of REQUIRED) {
    const status = keyField(page, account).getByRole("status");
    if (!(await shows(status.filter({ hasText: verdict(lang, account, "invalid-key") }), 30_000))) {
      missing.push(`${account}: ${(await visibleText(status)) || "no verdict"}`);
    }
  }
  return missing;
}

async function switchLanguage(page: Page, from: Lang, to: Lang): Promise<void> {
  await page.getByRole("button", { name: t(from, "Language"), exact: true }).click();
  await page.getByText(t(to, "Your API Keys"), { exact: true }).waitFor();
}

/** The keys step in both languages; online, the providers check the fake keys. */
async function keysStep(walk: Walk): Promise<void> {
  const { page, checks, keys } = walk;
  if (walk.options.offline) {
    await switchLanguage(page, "en", "zh-Hans");
    const statuses: number[] = [];
    for (const account of REQUIRED) {
      const body = JSON.stringify({ apiKey: keys[account] });
      statuses.push((await walk.api("PUT", `/api/local/accounts/${account}`, body)).status);
    }
    checks.add(
      "keys",
      statuses.every((status) => status === 200),
      `offline: the step shows in both languages; keys saved by PUT accounts (${statuses.join(", ")})`,
    );
  } else {
    for (const account of REQUIRED) {
      await page.locator(`input[name="${account}"]`).fill(keys[account] as string);
    }
    for (const account of REQUIRED) {
      await keyField(page, account)
        .getByRole("button", { name: t("en", "Check"), exact: true })
        .click();
    }
    const english = await missingVerdicts(page, "en");
    checks.add(
      "keys (en)",
      english.length === 0,
      english.length === 0
        ? "Soniox, OpenRouter and Fish refused the fake keys"
        : english.join("; "),
    );
    await switchLanguage(page, "en", "zh-Hans");
    const chinese = await missingVerdicts(page, "zh-Hans");
    const saved = Promise.all(
      REQUIRED.map((account) =>
        page.waitForResponse(isPut(`${walk.origin}/api/local/accounts/${account}`)),
      ),
    );
    await page
      .getByRole("button", { name: t("zh-Hans", "Save and Continue"), exact: true })
      .click();
    const statuses = (await saved).map((response) => response.status());
    const refused = await shows(
      page.getByText(t("zh-Hans", "Not every key passed its check"), { exact: true }),
      30_000,
    );
    checks.add(
      "keys (zh-Hans)",
      chinese.length === 0 && statuses.every((status) => status === 200) && refused,
      chinese.length > 0
        ? chinese.join("; ")
        : `the verdicts in Chinese; ${t("zh-Hans", "Save and Continue")} saved the keys ` +
            `(${statuses.join(", ")}) and ` +
            (refused ? "showed the rechecks failing" : "showed no failed recheck"),
    );
    const yaml = readFileSync(join(walk.home, "settings.yaml"), "utf8");
    checks.add(
      "cookie default",
      /cookiesFromBrowser: none/.test(yaml),
      "a new install's first save sets sources.cookiesFromBrowser: none",
    );
  }
  await switchLanguage(page, "zh-Hans", "en");
}

/** An OpenAI-compatible account for the fake embeddings server, added and picked in Settings. */
async function embeddingsAccount(walk: Walk): Promise<void> {
  const { page, checks } = walk;
  await page.goto(`${walk.origin}/settings?tab=providers`);
  await page.getByRole("button", { name: t("en", "Add Provider"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder(t("en", "Search providers")).fill("compatible");
  await dialog.getByRole("option", { name: /^OpenAI-compatible endpoint/ }).click();
  await dialog.getByLabel(t("en", "Name"), { exact: true }).fill(EMBED_ACCOUNT_NAME);
  await dialog
    .getByLabel(t("en", "API Key (If the Server Asks for One)"), { exact: true })
    .fill(walk.keys.embed as string);
  await dialog
    .getByLabel(t("en", "API Base (Required)"), { exact: true })
    .fill(walk.embeddings.url);
  await dialog.getByRole("button", { name: t("en", "Check"), exact: true }).click();
  const shown = dialog.getByRole("status");
  const passed = await shows(shown.filter({ hasText: verdict("en", EMBED_ACCOUNT, "ok") }), 15_000);
  const added = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${walk.origin}/api/local/accounts`,
  );
  await dialog.getByRole("button", { name: t("en", "Add Account"), exact: true }).click();
  const status = (await added).status();
  const listed = await shows(page.getByText(EMBED_ACCOUNT_NAME, { exact: true }));
  checks.add(
    "add account",
    passed && status === 201 && listed,
    `the check ${passed ? "passed" : `showed ${(await visibleText(shown)) || "no verdict"}`}` +
      `; POST accounts ${status}; Settings ${listed ? "lists" : "doesn't list"} it`,
  );

  const provider = page.getByLabel(t("en", "Embedding Provider"), { exact: true });
  await provider.click();
  await page.getByRole("option", { name: EMBED_ACCOUNT_NAME, exact: true }).click();
  // The field is plain text until the account's list arrives.
  const model = page.getByRole("combobox", {
    name: t("en", "Embedding Model"),
    exact: true,
  });
  const offered = await shows(model, 15_000);
  if (offered) {
    await model.click();
    await page.getByRole("option", { name: FAKE_MODEL, exact: true }).click();
  } else {
    await page.getByLabel(t("en", "Embedding Model"), { exact: true }).fill(FAKE_MODEL);
  }
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/settings`));
  await page
    .locator("form", { has: provider })
    .getByRole("button", { name: t("en", "Save"), exact: true })
    .click();
  // Another embedding provider means every index is built again, which the page asks about first.
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: t("en", "Save Anyway"), exact: true })
    .click();
  const saveStatus = (await saved).status();
  const yaml = parseYaml(readFileSync(join(walk.home, "settings.yaml"), "utf8")) as {
    embeddings?: { provider?: unknown; model?: unknown };
  };
  const picked =
    yaml.embeddings?.provider === EMBED_ACCOUNT && yaml.embeddings.model === FAKE_MODEL;
  checks.add(
    "pick account",
    offered && saveStatus === 200 && picked,
    `the model list ${offered ? "offered the fake server's models" : "never showed"}` +
      `; PUT settings ${saveStatus}; settings.yaml ` +
      (picked ? `embeds with ${EMBED_ACCOUNT} and ${FAKE_MODEL}` : "names another embedder"),
  );
}

async function credentialsAtRest(walk: Walk): Promise<void> {
  const path = join(walk.home, "credentials.json");
  const stored = JSON.parse(readFileSync(path, "utf8")) as {
    accounts?: Record<string, { apiKey?: unknown; baseUrl?: unknown } | undefined>;
  };
  const accounts = stored.accounts ?? {};
  const saved = REQUIRED.filter((account) => accounts[account]?.apiKey === walk.keys[account]);
  const embed = accounts[EMBED_ACCOUNT];
  const pointed = embed?.apiKey === walk.keys.embed && embed?.baseUrl === walk.embeddings.url;
  walk.checks.add(
    "credentials.json",
    mode(path) === 0o600 && saved.length === REQUIRED.length && pointed,
    `mode ${modeOf(path)}; ${saved.length} of ${REQUIRED.length} keys as typed; the embeddings ` +
      `account ${pointed ? "has its key and API base" : "lacks its key or API base"}`,
  );
  // Error answers are where an echo would hide: a parser's message, an unknown name.
  await walk.api("GET", "/api/local/accounts");
  await walk.api("PUT", "/api/local/accounts/soniox", `{"apiKey": "${walk.keys.soniox}"`);
  const unknown = JSON.stringify({ provider: "not-a-provider", apiKey: walk.keys.fish });
  await walk.api("POST", "/api/local/accounts", unknown);
  await walk.api("POST", "/api/local/accounts/check", unknown);
  await walk.api("GET", "/api/local/credentials");
  await walk.api(
    "PUT",
    "/api/local/credentials",
    JSON.stringify({ NOT_A_CREDENTIAL: walk.keys.openrouter }),
  );
}

async function savePrompt(walk: Walk, templates: string): Promise<void> {
  const { page } = walk;
  await page.goto(`${walk.origin}/personas/${PERSONA}/prompt`);
  const editor = page.getByLabel(t("en", "System Prompt"), { exact: true });
  const text = await poll(
    () => editor.inputValue(),
    (value) => value.length > 0,
    15_000,
  );
  const marker = `<!-- local-smoke ${randomBytes(4).toString("hex")} -->`;
  await editor.fill(`${text.trimEnd()}\n\n${marker}\n`);
  const saved = page.waitForResponse(isPut(`${walk.origin}/api/local/personas/${PERSONA}/prompt`));
  await page.getByRole("button", { name: t("en", "Save"), exact: true }).click();
  const status = (await saved).status();
  const own = join(walk.home, "personas", PERSONA, "prompt.md");
  const landed = existsSync(own) && readFileSync(own, "utf8").includes(marker);
  const untouched = treeHash(join(ROOT, "personas")) === templates;
  walk.checks.add(
    "prompt",
    status === 200 && landed && untouched,
    `PUT ${status}; ${landed ? "in" : "missing from"} <home>/personas/${PERSONA}/prompt.md; ` +
      `personas/ ${untouched ? "unchanged" : "CHANGED"}`,
  );
}

/**
 * A voice style added in the studio, by a typed-in voice id and the words that ask for it, saved
 * into her persona.yaml and listed, then removed. The voice search answers empty, so the walk
 * never reaches Fish.
 */
async function voiceStyles(walk: Walk, templates: string): Promise<void> {
  const { page } = walk;
  const search = (url: URL) => url.pathname === "/api/local/voices/search";
  await page.route(search, (route) =>
    route.fulfill({ json: { total: 0, totalIsExact: true, hasMore: false, items: [] } }),
  );
  try {
    await page.goto(`${walk.origin}/personas/${PERSONA}/voice`);
    const card = page.getByRole("region", { name: t("en", "Voice Styles"), exact: true });
    await card.getByRole("button", { name: t("en", "Add Style"), exact: true }).click();
    const dialog = page.getByRole("dialog", { name: t("en", "Add a Voice Style"), exact: true });
    const name = dialog.getByLabel(t("en", "Name"), { exact: true });
    await name.fill("default");
    const refused = await shows(
      dialog.getByText(t("en", "“default” is her own voice: pick another name."), { exact: true }),
    );
    await name.fill(STYLE.name);
    await dialog.getByLabel(t("en", "Trigger Words"), { exact: true }).fill(STYLE.hint);
    await dialog
      .getByLabel(t("en", "Or Use a Voice by Its ID"), { exact: true })
      .fill(STYLE.voiceId);
    await dialog.getByRole("button", { name: t("en", "Use This Voice"), exact: true }).click();
    const url = `${walk.origin}/api/local/personas/${PERSONA}/voice-styles`;
    const saved = page.waitForResponse(isPut(url));
    await dialog.getByRole("button", { name: t("en", "Save Style"), exact: true }).click();
    const status = (await saved).status();
    const listed = await shows(
      card.getByText(t("en", "Trigger words: {words}", { words: STYLE.hint }), { exact: true }),
    );
    const yaml = join(walk.home, "personas", PERSONA, "persona.yaml");
    const styles = () =>
      existsSync(yaml)
        ? (parseYaml(readFileSync(yaml, "utf8")) as { voice?: { styles?: unknown } }).voice?.styles
        : undefined;
    const landed =
      JSON.stringify(styles()) ===
      JSON.stringify({ [STYLE.name]: { voiceId: STYLE.voiceId, hint: STYLE.hint } });

    await card
      .getByRole("button", { name: t("en", "Remove {name}", { name: STYLE.name }), exact: true })
      .click();
    const removed = page.waitForResponse(isPut(url));
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: t("en", "Remove"), exact: true })
      .click();
    const removedStatus = (await removed).status();
    const emptied = await shows(card.getByText(t("en", "No voice styles yet"), { exact: true }));
    const gone = styles() === undefined;
    const untouched = treeHash(join(ROOT, "personas")) === templates;
    walk.checks.add(
      "voice styles",
      refused &&
        status === 200 &&
        landed &&
        listed &&
        removedStatus === 200 &&
        gone &&
        emptied &&
        untouched,
      `"default" ${refused ? "refused" : "NOT refused"}; PUT ${status}, ` +
        `${landed ? "in" : "missing from"} <home>/personas/${PERSONA}/persona.yaml, ` +
        `${listed ? "listed" : "NOT listed"}; removed: PUT ${removedStatus}, ` +
        `${gone && emptied ? "gone" : "STILL THERE"}; personas/ ${untouched ? "unchanged" : "CHANGED"}`,
    );
  } finally {
    await page.unroute(search);
  }
}

/** The share of a PNG's pixels that aren't wholly transparent. */
async function opaqueShare(png: Buffer): Promise<number> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer({ resolveWithObject: true });
  let opaque = 0;
  for (const alpha of data) if (alpha > 0) opaque++;
  return opaque / (info.width * info.height);
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** What the page keeps while its microphone requests go unanswered. */
interface UnansweredMic {
  smokeContexts: AudioContext[];
  smokeAsks: ((error: unknown) => void)[];
  smokeAnswer: () => void;
}

/**
 * Leaves the page's microphone requests unanswered, as an open permission prompt does, keeping each
 * AudioContext it makes; `smokeAnswer` then refuses them, as Block does, and puts both back.
 */
function leaveMicUnanswered(): void {
  const page = window as unknown as UnansweredMic;
  const Context = window.AudioContext;
  const media = navigator.mediaDevices;
  const ask = media.getUserMedia;
  page.smokeContexts = [];
  page.smokeAsks = [];
  window.AudioContext = class extends Context {
    constructor(options?: AudioContextOptions) {
      super(options);
      page.smokeContexts.push(this);
    }
  };
  media.getUserMedia = () =>
    new Promise((_, reject) => {
      page.smokeAsks.push(reject);
    });
  page.smokeAnswer = () => {
    window.AudioContext = Context;
    media.getUserMedia = ask;
    for (const reject of page.smokeAsks.splice(0)) {
      reject(new DOMException("Permission denied", "NotAllowedError"));
    }
  };
}

/**
 * Her look in the studio's Appearance: the test rig picked for Import a Model, kept in her folder as
 * the server's runtime read it and not made active; the preview drawing it under the app's CSP, an
 * expression held and a clip played on it, Use Microphone letting go of its audio while the browser
 * still asks for the microphone, a line tried on it, which a stage made anew ends, a mood put back
 * while its Save is out staying put back, and Head Turn and a parameter of a mood's saved together;
 * a picture and a rig cut short refused with the app's sentences; then Make Active, which her
 * summary and the status name, and Stop Using. The model stays, inactive, so the calls after this
 * meet her picture.
 */
async function appearanceWalk(walk: Walk, templates: string): Promise<void> {
  const { page, checks, origin } = walk;
  const models = `/api/local/personas/${PERSONA}/models`;
  const isUpload = (response: PageResponse) =>
    response.request().method() === "POST" && new URL(response.url()).pathname === models;
  let uploads = 0;
  const listen = (response: PageResponse) => {
    if (isUpload(response)) uploads++;
  };
  /** The model her summary and the status name, or the persona the status is about instead. */
  const named = async () => {
    const listed = (await (
      await walk.api("GET", "/api/local/personas")
    ).json()) as PersonasResponse;
    const { persona } = (await (await walk.api("GET", "/api/local/status")).json()) as Status;
    return {
      summary: listed.personas.find((entry) => entry.id === PERSONA)?.appearance.model?.id ?? null,
      status: persona.id === PERSONA ? (persona.appearance.model?.id ?? null) : `${persona.id}'s`,
    };
  };
  page.on("response", listen);
  try {
    await page.goto(`${origin}/personas/${PERSONA}/appearance`);
    const card = page.getByRole("region", { name: t("en", "How She Looks"), exact: true });
    const empty = await shows(card.getByText(t("en", "No models yet"), { exact: true }));
    const input = page.locator(`input[type="file"][aria-label="${t("en", "Model File")}"]`);
    const posted = page.waitForResponse(isUpload);
    await input.setInputFiles(MODEL_FIXTURE);
    const status = (await posted).status();
    const bytes = readFileSync(MODEL_FIXTURE);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const list = (await (await walk.api("GET", models)).json()) as CharacterModels;
    const model = list.models.find((entry) => entry.sha256 === sha256);
    if (model === undefined) {
      throw new Error(`POST models answered ${status}; GET models lists no model with its sha256`);
    }
    const dir = join(walk.home, "personas", PERSONA, "models", model.id);
    const manifest = join(dir, "model.json");
    const rig = join(dir, "model.p2lrt");
    const same =
      existsSync(rig) && createHash("sha256").update(readFileSync(rig)).digest("hex") === sha256;
    const inventory = existsSync(manifest)
      ? (JSON.parse(readFileSync(manifest, "utf8")) as { readonly inventory?: ModelInventory })
          .inventory
      : undefined;
    const clips = (inventory?.clips ?? []).map((clip) => clip.name);
    const expressions = (inventory?.expressions ?? []).map((expression) => expression.id);
    const areas = (inventory?.hitAreas ?? []).map((area) => area.id);
    const read =
      MODEL_CLIPS.every((name) => clips.includes(name)) &&
      expressions.length === MODEL_EXPRESSIONS.length &&
      MODEL_EXPRESSIONS.every((id) => expressions.includes(id)) &&
      areas.includes(MODEL_HEAD);
    const modes = [modeOf(dir), modeOf(manifest), modeOf(rig)];
    const toasted = await shows(
      page.getByText(t("en", "{name} imported.", { name: model.name }), { exact: true }),
    );
    const row = card.getByRole("listitem").filter({ hasText: model.name });
    const listed = await shows(row);
    checks.add(
      "appearance import",
      empty &&
        status === 201 &&
        toasted &&
        same &&
        read &&
        JSON.stringify(modes) === JSON.stringify(["0700", "0600", "0600"]) &&
        listed &&
        list.active === null,
      `the card ${empty ? "showed" : "never showed"} no models; POST models ${status}, ` +
        `${toasted ? "with" : "without"} its toast; <home>/personas/${PERSONA}/models/${model.id}/ ` +
        `(${modes[0]}) ${same ? "holds the rig byte for byte" : "lacks the rig"} (${modes[2]}) and ` +
        `a model.json (${modes[1]}) listing clips ${JSON.stringify(clips)}, expressions ` +
        `${JSON.stringify(expressions)} and hit areas ${JSON.stringify(areas)}; the card ` +
        `${listed ? "lists" : "doesn't list"} it, and the active model is ${String(list.active)}`,
    );

    const stage = page.locator(`[data-model-stage="${model.id}"]`);
    const ready = await shows(
      page.locator(`[data-model-stage="${model.id}"][data-state="ready"]`),
      30_000,
    );
    if (!ready) {
      checks.add("appearance preview", false, `the preview never drew: ${await alerts(page)}`);
    } else {
      const canvas = stage.locator("canvas");
      const coverage = async () =>
        opaqueShare(await canvas.screenshot({ omitBackground: true, style: ONLY_CANVAS }));
      // Its first frame comes after the ready state.
      const drawn = await poll(coverage, (share) => share >= MODEL_DRAWN, 5_000);
      const box = await canvas.boundingBox();
      const behind =
        box === null
          ? 1
          : await opaqueShare(
              await page.screenshot({ clip: box, omitBackground: true, style: NO_CANVAS }),
            );
      const expression = model.inventory.expressions.find((each) => each.id === MODEL_EXPRESSION);
      const clip = model.inventory.clips.find((each) => each.name === MODEL_CLIP);
      if (expression === undefined || clip === undefined) {
        throw new Error(`the rig has no ${MODEL_EXPRESSION} expression or ${MODEL_CLIP} clip`);
      }
      const chip = page
        .getByRole("region", { name: t("en", "Expressions"), exact: true })
        .getByRole("button", { name: expression.name || expression.id, exact: true });
      await chip.click();
      const held = (await chip.getAttribute("aria-pressed")) === "true";
      await page
        .getByRole("region", { name: t("en", "Clips"), exact: true })
        .getByRole("button", { name: clip.name || clip.id, exact: true })
        .click();
      await delay(clip.duration * 1000 + 500);
      const after = await stage.getAttribute("data-state");
      const still = after === "ready" ? await coverage() : 0;
      checks.add(
        "appearance preview",
        drawn >= MODEL_DRAWN && behind === 0 && held && after === "ready" && still >= MODEL_DRAWN,
        `her rig covers ${percent(drawn)} of the preview's canvas, and the page behind it ` +
          `${percent(behind)} once the canvas is hidden; ${expression.name} ` +
          `${held ? "held" : "NOT held"}, then ${clip.name} played, after which the preview is ` +
          `${after ?? "gone"}${after === "ready" ? `, covering ${percent(still)}` : `: ${await alerts(page)}`}`,
      );

      const microphone = page
        .getByRole("region", { name: t("en", "Microphone and Pointer"), exact: true })
        .getByRole("button", { name: t("en", "Use Microphone") });
      await page.evaluate(leaveMicUnanswered);
      await microphone.click();
      await microphone.click();
      await microphone.click();
      await page.getByRole("tab", { name: t("en", "Framing"), exact: true }).click();
      const asked = () =>
        page.evaluate(() => {
          const { smokeAsks, smokeContexts } = window as unknown as UnansweredMic;
          return { asks: smokeAsks.length, audio: smokeContexts.map((context) => context.state) };
        });
      const mic = await poll(
        asked,
        ({ audio }) => audio.every((state) => state === "closed"),
        5_000,
      );
      await page.evaluate(() => (window as unknown as UnansweredMic).smokeAnswer());
      await page.getByRole("tab", { name: t("en", "Test", {}, "model"), exact: true }).click();
      checks.add(
        "appearance microphone",
        mic.asks === 2 && mic.audio.length === 2 && mic.audio.every((state) => state === "closed"),
        `with the browser still asking for the microphone, Use Microphone turned off and then ` +
          `its tab left made ${mic.asks} request(s) and left their clicks' audio ` +
          `${JSON.stringify(mic.audio)}`,
      );

      // Reduced motion makes her stage anew, as Replace File and a lost context do.
      const play = page.getByRole("button", { name: t("en", "Play"), exact: true });
      const stop = page.getByRole("button", { name: t("en", "Stop"), exact: true });
      await page
        .getByRole("textbox", { name: t("en", "Try a Line"), exact: true })
        .fill(MODEL_LINE);
      await play.click();
      const playing = await shows(stop, 5_000);
      const switched = Date.now();
      await page.emulateMedia({ reducedMotion: "reduce" });
      const freed = await shows(play, 10_000);
      const freedMs = Date.now() - switched;
      const anew = await shows(
        page.locator(`[data-model-stage="${model.id}"][data-state="ready"]`),
        30_000,
      );
      const chips = anew && (await chip.isEnabled());
      await page.emulateMedia({ reducedMotion: null });
      checks.add(
        "appearance line",
        playing && freed && anew && chips,
        `Try a Line ${playing ? "played" : "never played"} her line; her stage, made anew a ` +
          `moment in, ${freed ? `gave Play back after ${freedMs} ms` : "left Stop up"}, and ` +
          `${anew ? `once ready had its expression chips ${chips ? "enabled" : "disabled"}` : "never was ready again"}`,
      );

      // A mood put back while its Save is out stays put back once the answer comes.
      const form = page.locator("form").filter({ has: stage });
      const save = form.getByRole("button", { name: t("en", "Save"), exact: true });
      await page.getByRole("tab", { name: t("en", "Moods"), exact: true }).click();
      const happy = page
        .getByRole("toolbar", { name: t("en", "Happy", {}, "mood"), exact: true })
        .getByRole("button", { name: expression.name || expression.id, exact: true });
      const patch = (url: URL) => url.pathname === `${models}/${model.id}`;
      let answer = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      await page.route(patch, async (route) => {
        if (route.request().method() === "PATCH") await answered;
        await route.continue();
      });
      try {
        await happy.click();
        const patched = page.waitForRequest(
          (request) => request.method() === "PATCH" && patch(new URL(request.url())),
        );
        await save.click();
        const body = (await patched).postDataJSON() as { readonly moods?: unknown } | null;
        await happy.click();
        answer();
        const toasted = await shows(
          page.getByText(t("en", "{name} saved.", { name: model.name }), { exact: true }),
          10_000,
        );
        const shown = await poll(
          () => happy.getAttribute("aria-pressed"),
          (pressed) => pressed === "true",
          2_000,
        );
        const dirty = await save.isEnabled();
        const kept = (
          (await (await walk.api("GET", models)).json()) as CharacterModels
        ).models.find((each) => each.id === model.id)?.moods;
        const discard = form.getByRole("button", { name: t("en", "Discard"), exact: true });
        if (await discard.isVisible()) await discard.click();
        checks.add(
          "appearance save",
          JSON.stringify(body?.moods) === '{"happy":[]}' &&
            toasted &&
            shown === "true" &&
            dirty &&
            JSON.stringify(kept) === '{"happy":[]}',
          `Save sent moods ${JSON.stringify(body?.moods)}, and ${expression.name}, put back in ` +
            `Happy while it was out, ${shown === "true" ? "stayed back" : "went off again"} once ` +
            `${toasted ? "its answer came" : "no answer came"}, with Save ${dirty ? "on" : "off"}; ` +
            `the server keeps moods ${JSON.stringify(kept)}`,
        );
      } finally {
        answer();
        await page.unroute(patch);
      }

      // Head Turn at 40% and a parameter for her Happy mood, set with the keyboard and saved
      // together, then put back so the calls after this meet the model as imported.
      await page.getByRole("tab", { name: t("en", "Motion"), exact: true }).click();
      const turn = page.getByRole("slider", { name: t("en", "Head Turn"), exact: true });
      await turn.focus();
      await page.keyboard.press("Home");
      for (let step = 0; step < 40; step++) await page.keyboard.press("ArrowRight");
      await page.getByRole("tab", { name: t("en", "Moods"), exact: true }).click();
      const add = t("en", "Add Parameter to {name}", { name: t("en", "Happy", {}, "mood") });
      await page.getByRole("button", { name: add, exact: true }).click();
      await page.getByPlaceholder(t("en", "Search parameters")).fill(MODEL_PARAMETER);
      await page.getByRole("option", { name: MODEL_PARAMETER, exact: true }).click();
      const cheek = page.getByRole("slider", { name: MODEL_PARAMETER, exact: true });
      await cheek.focus();
      await page.keyboard.press("End");
      const patched = page.waitForRequest(
        (request) => request.method() === "PATCH" && patch(new URL(request.url())),
      );
      await save.click();
      const body = (await patched).postDataJSON() as Record<string, unknown> | null;
      const toasted = await shows(
        page.getByText(t("en", "{name} saved.", { name: model.name }), { exact: true }),
        10_000,
      );
      const kept = ((await (await walk.api("GET", models)).json()) as CharacterModels).models.find(
        (each) => each.id === model.id,
      );
      const state = await stage.getAttribute("data-state");
      const wanted = { look: 0.4, moodParameters: { happy: [{ id: MODEL_PARAMETER, value: 1 }] } };
      checks.add(
        "appearance motion",
        JSON.stringify(body) === JSON.stringify(wanted) &&
          toasted &&
          kept?.look === wanted.look &&
          JSON.stringify(kept.moodParameters) === JSON.stringify(wanted.moodParameters) &&
          state === "ready",
        `Save sent ${JSON.stringify(body)} ${toasted ? "and its toast showed" : "with no toast"}; ` +
          `the server keeps look ${String(kept?.look)} and moodParameters ` +
          `${JSON.stringify(kept?.moodParameters)}, and the preview is ${state ?? "gone"}`,
      );
      const reset = await walk.api(
        "PATCH",
        `${models}/${model.id}`,
        JSON.stringify({ look: 1, moodParameters: {} }),
      );
      if (!reset.ok)
        throw new Error(`PATCH ${model.id} back to its import answered ${reset.status}`);
    }

    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#00000000" },
    })
      .png()
      .toBuffer();
    const sent = uploads;
    await input.setInputFiles({ name: "her.png", mimeType: "image/png", buffer: png });
    const picked = await shows(
      page.getByText(
        t("en", "Pick a .p2lrt file from PSD2Live, or the folder or zip of its web export."),
        { exact: true },
      ),
      10_000,
    );
    const pngSent = uploads - sent;
    const refused = page.waitForResponse(isUpload);
    await input.setInputFiles({
      name: "cut-short.p2lrt",
      mimeType: "application/octet-stream",
      buffer: bytes.subarray(0, 64 * 1024),
    });
    const refusal = await refused;
    const answer = (await refusal.json().catch(() => null)) as {
      readonly error?: { readonly code?: string };
    } | null;
    const unusable = await shows(
      page.getByText(t("en", "Eidolon can't use that model file."), { exact: true }),
      10_000,
    );
    const kept = readdirSync(join(walk.home, "personas", PERSONA, "models"));
    checks.add(
      "appearance refusals",
      picked &&
        pngSent === 0 &&
        refusal.status() === 400 &&
        answer?.error?.code === "invalid-model" &&
        unusable &&
        JSON.stringify(kept) === JSON.stringify([model.id]),
      `a PNG ${picked ? "was refused with" : "wasn't refused with"} the page's own sentence ` +
        `after ${pngSent} upload(s); the rig cut to 64 KiB answered ${refusal.status()} ` +
        `${String(answer?.error?.code)}, ${unusable ? "shown as" : "NOT shown as"} the app's ` +
        `sentence; her models/ holds ${JSON.stringify(kept)}`,
    );

    const settings = `${origin}/api/local/settings`;
    const activated = page.waitForResponse(isPut(settings));
    await row
      .getByRole("button", { name: t("en", "Make Active", {}, "model"), exact: true })
      .click();
    const activeStatus = (await activated).status();
    const badged = await shows(row.getByText(t("en", "Active"), { exact: true }));
    const on = await poll(
      named,
      (seen) => seen.summary === model.id && seen.status === model.id,
      5_000,
    );
    await row.getByRole("button", { name: t("en", "Model Options"), exact: true }).click();
    const stopped = page.waitForResponse(isPut(settings));
    await page.getByRole("menuitem", { name: t("en", "Stop Using"), exact: true }).click();
    const stopStatus = (await stopped).status();
    const hinted = await shows(
      card.getByText(
        t("en", "None is active, so she shows her picture. Make one active to use it as her look."),
        { exact: true },
      ),
    );
    const off = await poll(named, (seen) => seen.summary === null && seen.status === null, 5_000);
    const untouched = treeHash(join(ROOT, "personas")) === templates;
    checks.add(
      "appearance active",
      activeStatus === 200 &&
        badged &&
        on.summary === model.id &&
        on.status === model.id &&
        stopStatus === 200 &&
        hinted &&
        off.summary === null &&
        off.status === null &&
        untouched,
      `Make Active: PUT settings ${activeStatus}, the row ${badged ? "badged" : "NOT badged"} ` +
        `Active, her summary naming ${String(on.summary)} and the status ${String(on.status)}; ` +
        `Stop Using: PUT settings ${stopStatus}, ${hinted ? "the hint back" : "no hint"}, her ` +
        `summary naming ${String(off.summary)} and the status ${String(off.status)}; personas/ ` +
        `${untouched ? "unchanged" : "CHANGED"}`,
    );
  } finally {
    page.off("response", listen);
    await configure(walk, PERSONA, { "appearance.model": null });
  }
}

async function indexFacts(walk: Walk): Promise<void> {
  const { page, checks } = walk;
  await page.goto(`${walk.origin}/personas/${PERSONA}/knowledge`);
  await page.getByRole("button", { name: t("en", "New File"), exact: true }).click();
  await page.getByPlaceholder(t("en", "facts.txt")).fill(FACT_FILE);
  const lines = `${FACT_LINES.join("\n")}\n`;
  await page.getByPlaceholder(t("en", "2024-05-01 她说……")).fill(lines);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      decodeURIComponent(new URL(response.url()).pathname) ===
        `/api/local/personas/${PERSONA}/facts/${FACT_FILE}`,
  );
  await page.getByRole("button", { name: t("en", "Save"), exact: true }).click();
  const status = (await saved).status();
  const file = join(walk.home, "sources", PERSONA, "facts", FACT_FILE);
  const written = existsSync(file) && readFileSync(file, "utf8") === lines;
  checks.add(
    "fact file",
    status === 200 && written,
    `PUT ${status}; ${written ? "in" : "missing from"} <home>/sources/${PERSONA}/facts/`,
  );

  const started = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${walk.origin}/api/local/jobs`,
  );
  await page.getByRole("button", { name: t("en", "Index Facts"), exact: true }).click();
  const job = (await (await started).json()) as JobSnapshot;
  const ended = await poll(
    async () => (await (await walk.api("GET", `/api/local/jobs/${job.id}`)).json()) as JobSnapshot,
    (snapshot) => snapshot.status !== "running",
    JOB_TIMEOUT_MS,
  );
  const metaPath = join(walk.home, "personas", PERSONA, "index", "persona_facts.meta.json");
  const meta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf8")) as { rows?: unknown })
    : {};
  const { seen } = walk.embeddings;
  const models = [...seen.models].join(", ") || "none";
  checks.add(
    "ingest-facts",
    ended.status === "succeeded" &&
      meta.rows === FACT_LINES.length &&
      seen.refused === 0 &&
      seen.inputs >= FACT_LINES.length &&
      models === FAKE_MODEL,
    `job ${ended.status}, ${String(meta.rows ?? "no")} rows indexed; the fake embeddings server ` +
      `took ${seen.inputs} texts in ${seen.requests} request(s) for ${models} and refused ` +
      `${seen.refused}` +
      (ended.status === "succeeded" ? "" : `; ${ended.stderrTail.trim().split("\n").at(-1) ?? ""}`),
  );

  const card = page
    .getByText(t("en", "Index Facts"), { exact: true })
    .locator("xpath=..")
    .filter({ hasText: t("en", "Done", {}, "job status") });
  const finished = await shows(card);
  const jobs = join(walk.home, "jobs");
  const outputs = [".ndjson", ".log"].map((ext) => modeOf(join(jobs, `${job.id}${ext}`)));
  const locks = join(walk.home, "locks");
  checks.add(
    "job files",
    finished &&
      existsSync(join(jobs, `${job.id}.json`)) &&
      modeOf(jobs) === "0700" &&
      outputs.every((value) => value === "0600") &&
      modeOf(locks) === "0700",
    `the studio ${finished ? "shows" : "doesn't show"} it done; jobs/ ${modeOf(jobs)}, its events ` +
      `and log ${outputs.join(" and ")}; locks/ ${modeOf(locks)}`,
  );
}

async function jobsPage(walk: Walk): Promise<void> {
  const { page } = walk;
  await page.goto(`${walk.origin}/jobs`);
  const link = page.getByRole("link", { name: t("en", "Index Facts"), exact: true });
  const row = page.getByRole("listitem").filter({ has: link });
  const listed = await shows(row.filter({ hasText: t("en", "Done", {}, "job status") }));
  walk.checks.add(
    "jobs page",
    listed,
    listed
      ? `lists ${t("en", "Index Facts")} as ${t("en", "Done", {}, "job status")}`
      : (await visibleText(row)) || "no row",
  );
}

/** One event of a chat's log, as far as the walk reads it. */
interface LoggedEvent {
  readonly seq: number;
  readonly type: string;
  readonly text?: string;
  readonly speaker?: { readonly kind: string; readonly id?: string };
  readonly after?: number;
  readonly source?: string;
  readonly replies?: readonly { readonly persona: string }[];
  readonly scores?: Readonly<Record<string, number>>;
  readonly title?: string;
  readonly modality?: string;
  readonly attachments?: readonly {
    readonly kind: string;
    readonly name: string;
    readonly mime: string;
    readonly durationMs?: number;
  }[];
  readonly code?: string;
  readonly replyMode?: string;
  readonly display?: string;
  readonly permissions?: string;
  readonly call?: string;
  readonly persona?: string;
  readonly reason?: string;
  readonly interrupted?: boolean;
  readonly name?: string;
  readonly turn?: string;
  readonly callId?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  /** A tool-call's: her words before it. */
  readonly said?: string;
  readonly stage?: string;
  readonly result?: Readonly<Record<string, unknown>>;
  /** A context block's text, and the blocks a context-removed takes out, by seq. */
  readonly content?: string;
  readonly seqs?: readonly number[];
  /** A call-ended's: her start_task calls whose ends she told on the call. */
  readonly told?: readonly string[];
}

async function chatLog(walk: Walk, id: string): Promise<readonly LoggedEvent[]> {
  const response = await walk.api("GET", `/api/local/chats/${id}`);
  if (!response.ok) return [];
  return ((await response.json()) as { events: readonly LoggedEvent[] }).events;
}

/**
 * Hangs up the call the page shows, if any, and waits for the server to end it: a call outlives
 * in-app navigation.
 */
async function hangUpIfUp(walk: Walk): Promise<void> {
  const button = walk.page.getByRole("button", { name: t("en", "Hang Up"), exact: true }).first();
  // A call already ending shows it disabled until it goes.
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 5_000 }).catch(() => undefined);
  }
  await poll(
    async () => ((await (await walk.api("GET", "/api/local/status")).json()) as Status).activeCalls,
    (calls) => calls === 0,
    20_000,
  );
}

function said(events: readonly LoggedEvent[], kind: "user" | "persona", text: string): boolean {
  return events.some((e) => e.type === "message" && e.speaker?.kind === kind && e.text === text);
}

/** A request's message roles in order, for a check's detail. */
function roles(request: ChatRequest | undefined): string {
  return (request?.messages ?? []).map((message) => String(message.role)).join(", ") || "none";
}

/** The id of `provider`'s account named `name` at the fake server, added the first time. */
async function fakeAccount(walk: Walk, provider: string, name: string): Promise<string> {
  const listed = (await (await walk.api("GET", "/api/local/accounts")).json()) as AccountsResponse;
  const found = listed.accounts.find((account) => account.name === name);
  if (found !== undefined) return found.id;
  const added = await walk.api(
    "POST",
    "/api/local/accounts",
    JSON.stringify({ provider, name, apiKey: walk.keys.embed, baseUrl: walk.embeddings.url }),
  );
  if (added.status !== 201) throw new Error(`POST accounts for ${name} answered ${added.status}`);
  return ((await added.json()) as AccountView).id;
}

/** Persona `persona`'s settings `values`, saved through PUT settings. */
async function configure(
  walk: Walk,
  persona: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const body = JSON.stringify({ scope: "persona", persona, values });
  const saved = await walk.api("PUT", "/api/local/settings", body);
  if (!saved.ok) throw new Error(`PUT settings for ${persona} answered ${saved.status}`);
}

/** Her first character model's id, the CC0 fixture imported when she has none. */
async function fixtureModel(walk: Walk): Promise<string> {
  const models = `/api/local/personas/${PERSONA}/models`;
  const listed = (await (await walk.api("GET", models)).json()) as CharacterModels;
  const first = listed.models[0];
  if (first !== undefined) return first.id;
  const imported = await walk.api(
    "POST",
    `${models}?filename=tml.p2lrt`,
    new Uint8Array(readFileSync(MODEL_FIXTURE)),
    { "content-type": "application/octet-stream" },
  );
  if (imported.status !== 201) throw new Error(`POST models answered ${imported.status}`);
  return ((await imported.json()) as CharacterModel).id;
}

/**
 * A text chat with her mind on the fake server: New Chat and its greeting, a reply that streams in,
 * the history after a reload, then Rename and Delete from the chat's menus.
 */
async function chatWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, decisions } = walk.embeddings.seen;
  const gate = await fakeAccount(walk, "openrouter", DECISIONS_ACCOUNT_NAME);
  await configure(walk, PERSONA, {
    "mind.provider": EMBED_ACCOUNT,
    "mind.model": MIND_MODEL,
    // Off, since her retrieval gate and reranker would ask OpenRouter with the fake key.
    "knowledge.gate.enabled": false,
    "knowledge.rerank.enabled": false,
    // The director asks the active persona's gate role, on, though her retrieval gate is off: in a
    // chat of one, whether to answer in voice, since her reply mode is auto and Fish has a key.
    "knowledge.gate.provider": gate,
  });
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const persona = listed.personas.find((entry) => entry.id === PERSONA);
  if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
  const short = persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/`);
  await page
    .getByRole("link", { name: t("en", "Chats"), exact: true })
    .first()
    .click();
  await page.waitForURL(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${origin}/api/local/chats`,
  );
  await page.getByRole("menuitem", { name: t("en", "Start Chat"), exact: true }).click();
  const createStatus = (await created).status();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  const greeted = await shows(log.getByText(GREETING, { exact: true }), 30_000);
  const kickoff = chats[0];
  const greetingStored = said(
    await poll(
      () => chatLog(walk, id),
      (events) => said(events, "persona", GREETING),
      10_000,
    ),
    "persona",
    GREETING,
  );
  const events = await chatLog(walk, id);
  checks.add(
    "chat greeting",
    createStatus === 201 &&
      greeted &&
      greetingStored &&
      events[0]?.type === "kickoff" &&
      chats.length === 1 &&
      kickoff?.model === MIND_MODEL &&
      kickoff.stream === true &&
      kickoff.messages?.[0]?.role === "system",
    `POST chats ${createStatus}; the page ${greeted ? "shows" : "doesn't show"} her greeting, ` +
      `the log ${greetingStored ? "stores" : "lacks"} it after a ` +
      `${events[0]?.type ?? "missing"} event; ` +
      `the fake server took ${chats.length} request(s), the first for ` +
      `${String(kickoff?.model)} with ${roles(kickoff)}`,
  );

  const box = page.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  const decided = decisions.length;
  await box.fill(CHAT_MESSAGE);
  await box.press("Enter");
  const [head, tail] = [REPLY[0], "刚刚在看猫猫视频"];
  const partial = await waitFor(async () => {
    const shown = await visibleText(log);
    return shown.includes(head) && !shown.includes(tail);
  }, REPLY_HOLD_MS + 20_000);
  const whole = await waitFor(async () => (await visibleText(log)).includes(tail), 20_000);
  const chip = await shows(log.getByRole("img", { name: "laughing", exact: true }), 5_000);
  const shownText = await visibleText(log);
  const raw = RAW_MARKUP.exec(shownText)?.[0] ?? null;
  const reply = chats[1];
  const messages = reply?.messages ?? [];
  const seesGreeting = messages.some((m) => m.role === "assistant" && m.content === GREETING);
  const asked = messages.at(-1)?.content === CHAT_MESSAGE;
  const streamed =
    partial === null ? "never showed its first chunk alone" : "streamed in, its first chunk alone";
  checks.add(
    "chat reply",
    partial !== null && whole !== null && chip && raw === null && seesGreeting && asked,
    `her reply ${streamed} and ${whole === null ? "never finished" : "then whole"}; the cue ` +
      (raw !== null ? `shows as written: ${raw}` : chip ? "shows as a chip" : "is missing") +
      `; the mind's second request ${seesGreeting ? "has" : "lacks"} her greeting and ` +
      `${asked ? "ends on" : "doesn't end on"} the viewer's line (${roles(reply)})`,
  );

  const stored = await poll(
    () => chatLog(walk, id),
    (logged) => said(logged, "persona", REPLY.join("")),
    10_000,
  );
  const viewerLine = stored.find((e) => e.type === "message" && e.text === CHAT_MESSAGE);
  const decision = stored.find((e) => e.type === "decision");
  const chatDir = join(walk.home, "chats", id);
  const logFile = join(chatDir, "chat.jsonl");
  await page.reload();
  const history = await Promise.all(
    [GREETING, CHAT_MESSAGE, tail].map((text) => shows(log.getByText(text), 15_000)),
  );
  const row = page
    .getByRole("list", { name: t("en", "Chats"), exact: true })
    .getByRole("listitem")
    .filter({ hasText: tail });
  const inList = await shows(row);
  const weighed = decisions.slice(decided).map((d) => Object.keys(d.questions ?? {}).join(" "));
  checks.add(
    "chat history",
    said(stored, "persona", REPLY.join("")) &&
      decision?.after === viewerLine?.seq &&
      decision?.source === "single" &&
      decision.scores?.voice_moment === 0 &&
      JSON.stringify(weighed) === JSON.stringify(["voice_moment"]) &&
      history.every(Boolean) &&
      inList &&
      modeOf(join(walk.home, "chats")) === "0700" &&
      modeOf(logFile) === "0600",
    `the log ${said(stored, "persona", REPLY.join("")) ? "stores" : "lacks"} her reply after a ` +
      `${decision?.source ?? "missing"} decision on seq ${String(decision?.after)} with ` +
      `${JSON.stringify(decision?.scores ?? {})}, from ${weighed.length} Decisions request(s) ` +
      `asking ${JSON.stringify(weighed)}; after a reload ` +
      `the page shows ${history.filter(Boolean).length} of 3 lines and the list ` +
      `${inList ? "previews" : "doesn't preview"} her reply; ` +
      `chats/ ${modeOf(join(walk.home, "chats"))}, ` +
      `chat.jsonl ${modeOf(logFile)}`,
  );

  await chatFiles(walk, id, box, log);
  // The list previews the line it ended on now.
  const filed = page
    .getByRole("list", { name: t("en", "Chats"), exact: true })
    .getByRole("listitem")
    .filter({ hasText: FILES_REPLY });

  await filed.getByRole("button", { name: t("en", "Chat Options"), exact: true }).click();
  await page.getByRole("menuitem", { name: t("en", "Rename"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t("en", "Title"), { exact: true }).fill(CHAT_TITLE);
  const renamed = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url() === `${origin}/api/local/chats/${id}`,
  );
  await dialog.getByRole("button", { name: t("en", "Save"), exact: true }).click();
  const renameStatus = (await renamed).status();
  const headed = await shows(page.getByRole("heading", { name: CHAT_TITLE, exact: true }));
  const titled = await shows(filed.filter({ hasText: CHAT_TITLE }));
  const titleStored = (await chatLog(walk, id)).some(
    (e) => e.type === "title" && e.title === CHAT_TITLE,
  );
  checks.add(
    "chat rename",
    renameStatus === 200 && headed && titled && titleStored,
    `PATCH ${renameStatus}; the header ${headed ? "shows" : "doesn't show"} the title, the list ` +
      `${titled ? "shows" : "doesn't show"} it, the log ${titleStored ? "stores" : "lacks"} it`,
  );

  // The chat's own header menu, after the list row's.
  await page
    .getByRole("button", { name: t("en", "Chat Options"), exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: t("en", "Delete"), exact: true }).click();
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url() === `${origin}/api/local/chats/${id}`,
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: t("en", "Delete"), exact: true })
    .click();
  const deleteStatus = (await deleted).status();
  await page.waitForURL(`${origin}/chats`);
  const empty = await shows(page.getByText(t("en", "No chats yet"), { exact: true }));
  const gone = (await walk.api("GET", `/api/local/chats/${id}`)).status;
  checks.add(
    "chat delete",
    deleteStatus === 200 && empty && gone === 404 && !existsSync(chatDir),
    `DELETE ${deleteStatus}; the page ${empty ? "lists no chats" : "still lists one"}; GET the ` +
      `chat ${gone}; its folder ${existsSync(chatDir) ? "remains" : "is gone"}`,
  );
}

/**
 * A camera's photo taken sideways and a text file picked with the paperclip, each kept in the chat
 * as it is added, then sent with a line: her mind is shown the photo upright and without its EXIF
 * as an image part, and the file as its text, and the line shows both, stored as its attachments.
 */
async function chatFiles(walk: Walk, id: string, box: Locator, log: Locator): Promise<void> {
  const { page, checks } = walk;
  const { chats } = walk.embeddings.seen;
  const photo = await sharp({ create: { width: 4, height: 2, channels: 3, background: "#c82828" } })
    .jpeg()
    .withExif({ IFD0: { Make: "smoke" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const kept: number[] = [];
  const listen = (response: PageResponse) => {
    const { pathname } = new URL(response.url());
    if (pathname === `/api/local/chats/${id}/files`) kept.push(response.status());
  };
  page.on("response", listen);
  await page.locator('input[type="file"]').setInputFiles([
    { name: "cat.jpg", mimeType: "image/jpeg", buffer: photo },
    { name: "story.md", mimeType: "text/markdown", buffer: Buffer.from(STORY) },
  ]);
  const tray = page.getByRole("list", { name: t("en", "Attachments"), exact: true });
  const thumbnail = await shows(tray.getByRole("img", { name: "cat.jpg", exact: true }));
  const named = await shows(tray.getByText("story.md", { exact: true }));
  const up = await waitFor(() => kept.length === 2, 15_000);
  const sent = await waitFor(async () => (await tray.getByRole("status").count()) === 0, 15_000);
  page.off("response", listen);
  const asked = chats.length;
  await box.fill(FILES_MESSAGE);
  await box.press("Enter");
  const replied = await shows(log.getByText(FILES_REPLY, { exact: true }), 20_000);
  const parts = chats
    .slice(asked)
    .find((each) => Array.isArray(each.messages?.at(-1)?.content))
    ?.messages?.at(-1)?.content as readonly Record<string, unknown>[] | undefined;
  const words = String(parts?.find((part) => part.type === "text")?.text ?? "");
  const image = parts?.find((part) => part.type === "image_url")?.image_url as
    | { readonly url?: unknown }
    | undefined;
  const [type, data] = String(image?.url ?? "").split(";base64,");
  const made =
    type === "data:image/jpeg" ? await sharp(Buffer.from(data ?? "", "base64")).metadata() : null;
  const upright = made !== null && made.width === 2 && made.height === 4 && made.exif === undefined;
  const shown =
    words.startsWith(FILES_MESSAGE) &&
    words.includes(`<file name="story.md">\n${STORY}\n</file>`) &&
    upright;
  const onPage =
    (await shows(log.getByRole("img", { name: t("en", "Sent by you"), exact: true }))) &&
    (await shows(log.getByRole("link", { name: "story.md" })));
  const line = (await chatLog(walk, id)).find(
    (event) => event.type === "message" && event.text === FILES_MESSAGE,
  );
  const stored = (line?.attachments ?? []).map((file) => `${file.kind} ${file.mime}`);
  checks.add(
    "chat files",
    thumbnail &&
      named &&
      up !== null &&
      sent !== null &&
      kept.every((status) => status === 201) &&
      replied &&
      shown &&
      onPage &&
      JSON.stringify(stored) === JSON.stringify(["image image/jpeg", "file text/plain"]),
    `the tray ${thumbnail ? "shows" : "lacks"} the picture and ${named ? "names" : "lacks"} the ` +
      `file; POST files answered ${JSON.stringify(kept)}; her reply ` +
      `${replied ? "came" : "never came"}; her mind ${shown ? "was shown" : "wasn't shown"} the ` +
      `photo upright without its EXIF (${type ?? "no image"}, ${made?.width}×${made?.height}) ` +
      `and the file as its text (${quote(words)}); the line ` +
      `${onPage ? "shows" : "doesn't show"} both, stored as ${JSON.stringify(stored)}`,
  );
}

/** The short name over the run of lines that `text` is in, as the page labels a group's lines. */
async function speakerShown(
  log: Locator,
  text: string,
  names: readonly string[],
): Promise<string | null> {
  return log.evaluate(
    (root, [text, names]) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let element: Element | null = null;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node.textContent?.includes(text)) {
          element = node.parentElement;
          break;
        }
      }
      // The run's label is hidden from a screen reader, whom her bubble names instead.
      for (; element !== null && element !== root; element = element.parentElement) {
        const labels = [...element.querySelectorAll("[aria-hidden='true']")]
          .map((label) => label.textContent?.trim() ?? "")
          .filter((label) => names.includes(label));
        if (labels.length > 0) return labels.length === 1 ? (labels[0] as string) : null;
      }
      return null;
    },
    [text, names] as const,
  );
}

/** The system message of a request, or "". */
function systemOf(request: ChatRequest | undefined): string {
  const first = request?.messages?.[0];
  return first?.role === "system" ? String(first.content) : "";
}

/**
 * A group chat of her and a persona made from no template, with the director on the fake server:
 * New Chat with both and no greeting, an @-mention the composer completes, the second persona's
 * answer, the first's answer to her a hop later, and each line under its persona's name.
 */
async function groupChatWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, decisions } = walk.embeddings.seen;
  const made = await walk.api(
    "POST",
    "/api/local/personas",
    JSON.stringify({ ...SECOND, voiceId: "0".repeat(32) }),
  );
  if (made.status !== 201) throw new Error(`POST personas answered ${made.status}`);
  // The first persona's, and the director's gate, are the chat walk's.
  await configure(walk, SECOND.id, {
    "mind.provider": EMBED_ACCOUNT,
    "mind.model": MIND_MODEL,
    "knowledge.gate.enabled": false,
    "knowledge.rerank.enabled": false,
  });
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const first = listed.personas.find((entry) => entry.id === PERSONA);
  const second = listed.personas.find((entry) => entry.id === SECOND.id);
  if (first === undefined || second === undefined) {
    throw new Error(`GET personas lacks ${first === undefined ? PERSONA : SECOND.id}`);
  }
  const short = (persona: typeof first) => persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  for (const persona of [first, second]) {
    await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  }
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === `${origin}/api/local/chats`,
  );
  const asked = chats.length;
  await page.getByRole("menuitem", { name: t("en", "Start Group Chat"), exact: true }).click();
  const createStatus = (await posted).status();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  // Untitled, the page names it by who is in it.
  const title = [short(first), short(second)].join(t("en", ", ", {}, "list separator"));
  const headed = await shows(page.getByRole("heading", { name: title, exact: true }));
  const opened = await chatLog(walk, id);
  const live = (await walk.api("GET", `/api/local/chats/${id}/live`)).status;
  checks.add(
    "group chat",
    createStatus === 201 && headed && opened.length === 0 && live === 204 && chats.length === asked,
    `POST chats ${createStatus} with ${first.id} and ${second.id}, the template-free one; the ` +
      `header ${headed ? "shows" : "doesn't show"} ${title}; the log holds ` +
      `${opened.map((e) => e.type).join(", ") || "nothing"}; GET live ${live}, and the fake ` +
      `server took ${chats.length - asked} greeting request(s)`,
  );

  const box = page.getByRole("textbox", { name: t("en", "Message everyone"), exact: true });
  await box.click();
  await box.pressSequentially(`@${SECOND.shortName.slice(0, 1)}`);
  const offered = await shows(
    page
      .getByRole("listbox", { name: t("en", "Mention"), exact: true })
      .getByRole("option")
      .filter({ hasText: second.name }),
  );
  await box.press("Tab");
  await box.pressSequentially(GROUP_TEXT);
  const typed = await box.inputValue();
  const noted = await shows(
    page.getByText(t("en", "Mentioned: {names}", { names: short(second) }), { exact: true }),
  );
  const decided = decisions.length;
  await box.press("Enter");
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  const answered = await shows(log.getByText(SECOND_REPLY), 30_000);
  const followed = await shows(log.getByText(HOP_REPLY), 30_000);
  const stored = await poll(
    () => chatLog(walk, id),
    (events) =>
      said(events, "persona", HOP_REPLY) &&
      events.filter((e) => e.type === "decision").length === 3,
    10_000,
  );
  const line = (text: string) => stored.find((e) => e.type === "message" && e.text === text);
  const [viewerLine, secondLine, hopLine] = [GROUP_MESSAGE, SECOND_REPLY, HOP_REPLY].map(line);
  const picks = stored
    .filter((e) => e.type === "decision")
    .map((e) => ({
      after: e.after,
      source: e.source,
      replies: (e.replies ?? []).map((reply) => reply.persona),
    }));
  const expected = [
    { after: viewerLine?.seq, source: "mention", replies: [SECOND.id] },
    { after: secondLine?.seq, source: "model", replies: [PERSONA] },
    { after: hopLine?.seq, source: "model", replies: [] },
  ];
  const asks = decisions.slice(decided);
  const questioned = (index: number) =>
    Object.keys(asks[index]?.questions ?? {})
      .sort()
      .join(" ");
  const theirs = chats.find((c) => heard(c, GROUP_MESSAGE) && !heard(c, SECOND_REPLY));
  const hers = chats.find((c) => heard(c, SECOND_REPLY));
  const stops = (request: ChatRequest | undefined) =>
    Array.isArray(request?.stop) ? (request.stop as unknown[]).map(String) : [];
  const heldBack =
    stops(theirs).includes(`\n${first.name}：`) && stops(hers).includes(`\n${second.name}：`);
  const introduced =
    systemOf(theirs).includes(`这是群聊，群里还有：${first.name}；`) &&
    systemOf(hers).includes(`这是群聊，群里还有：${second.name}；`);
  checks.add(
    "group mention",
    offered &&
      typed === GROUP_MESSAGE &&
      noted &&
      answered &&
      followed &&
      secondLine?.speaker?.id === SECOND.id &&
      hopLine?.speaker?.id === PERSONA &&
      JSON.stringify(picks) === JSON.stringify(expected) &&
      asks.length === 3 &&
      questioned(1) === `addressed_${PERSONA} interested_${PERSONA} invites_reply voice_moment` &&
      heldBack &&
      introduced,
    `@ ${offered ? "offered" : "didn't offer"} ${second.name}, the box read ${quote(typed)} ` +
      `${noted ? "and named" : "without naming"} whom it mentions; the page ` +
      `${answered ? "shows" : "lacks"} her answer and ${followed ? "shows" : "lacks"} ` +
      `${short(first)}'s a hop later; decisions ${JSON.stringify(picks)}; the fake server took ` +
      `${asks.length} Decisions request(s), the second asking ${questioned(1) || "nothing"}; ` +
      `their minds ${heldBack ? "got" : "lacked"} each other's stop sequences and ` +
      `${introduced ? "were" : "weren't"} told who else is here`,
  );

  const names = [short(first), short(second)];
  const shown = await Promise.all(
    [SECOND_REPLY, HOP_REPLY].map((text) => speakerShown(log, text, names)),
  );
  await page.reload();
  const reloaded = await shows(log.getByText(HOP_REPLY), 15_000);
  const after = await Promise.all(
    [SECOND_REPLY, HOP_REPLY].map((text) => speakerShown(log, text, names)),
  );
  const expectedNames = [short(second), short(first)];
  checks.add(
    "group names",
    JSON.stringify(shown) === JSON.stringify(expectedNames) &&
      reloaded &&
      JSON.stringify(after) === JSON.stringify(expectedNames),
    `her answer shows under ${String(shown[0])} and the hop's under ${String(shown[1])}; ` +
      `after a reload, ${reloaded ? `${String(after[0])} and ${String(after[1])}` : "neither shows"}`,
  );
}

/**
 * Installed in the page before its own scripts: each media element that starts playing or plays
 * to its end, as `playing <src>` or `ended <src>`.
 */
function observeMedia(): void {
  const seen: string[] = [];
  (window as unknown as { smokeMedia: string[] }).smokeMedia = seen;
  for (const type of ["playing", "ended"]) {
    // Media events don't bubble, so they are caught on the way down.
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof HTMLMediaElement) {
          seen.push(`${type} ${event.target.currentSrc}`);
        }
      },
      true,
    );
  }
}

async function mediaEvents(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => (window as unknown as { smokeMedia?: string[] }).smokeMedia ?? []);
}

/** The NDJSON lines of a stream's whole text. */
function ndjson(text: string): readonly Record<string, unknown>[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Voice messages, with her voice and hearing on an OpenAI account at the fake server: one held on
 * the microphone, heard and answered in text; then the chat set to Voice in its settings, and her
 * voice reply, which plays, its file served in ranges.
 */
async function voiceChatWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, decisions, speech, heard: uploads } = walk.embeddings.seen;
  const speaker = await fakeAccount(walk, "openai", SPEECH_ACCOUNT_NAME);
  await configure(walk, PERSONA, { "voice.provider": speaker, "hearing.provider": speaker });
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const persona = listed.personas.find((entry) => entry.id === PERSONA);
  if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
  const short = persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  const minded = chats.length;
  await page.getByRole("menuitem", { name: t("en", "Start Chat"), exact: true }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  if (!(await shows(log.getByText(GREETING, { exact: true }), 30_000))) {
    const logged = (await chatLog(walk, id)).map((e) => e.type).join(", ") || "nothing";
    throw new Error(
      `her greeting never showed: the log holds ${logged}, after ${chats.length - minded} mind ` +
        `request(s); the page shows ${quote(await visibleText(log), 40)}`,
    );
  }

  const opened = (await (await walk.api("GET", `/api/local/chats/${id}`)).json()) as ChatContents;
  const mic = page.getByRole("button", { name: t("en", "Record Voice Message"), exact: true });
  await mic.waitFor();
  const usable = (await mic.getAttribute("aria-disabled")) === null;
  const box = await mic.boundingBox();
  if (box === null) throw new Error("the microphone button has no box");
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/local/chats/${id}/voice`,
  );
  const decided = decisions.length;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const holding = await shows(
    page.getByText(t("en", "Let go to send, or slide off the button to cancel."), { exact: true }),
    10_000,
  );
  await delay(HOLD_MIC_MS);
  await page.mouse.up();
  const upload = await posted;
  const sentMs = Number(new URL(upload.url()).searchParams.get("durationMs"));
  const sentType = (await upload.request().headerValue("content-type")) ?? "";
  await log
    .getByRole("button", { name: t("en", "Show Transcript"), exact: true })
    .first()
    .click();
  const transcribed = await shows(log.getByText(VOICE_TRANSCRIPT, { exact: true }), 15_000);
  const answered = await shows(log.getByText(HEARD_REPLY, { exact: true }), 30_000);
  const stored = await poll(
    () => chatLog(walk, id),
    (events) => said(events, "persona", HEARD_REPLY),
    10_000,
  );
  const line = stored.find((e) => e.type === "message" && e.speaker?.kind === "user");
  const clip = line?.attachments?.[0];
  const decision = stored.find((e) => e.type === "decision" && e.after === line?.seq);
  const textReply = stored.find((e) => e.type === "message" && e.text === HEARD_REPLY);
  const weighed = decisions.slice(decided);
  const latest = weighed[0]?.state?.latest;
  const hearing = uploads.at(-1);
  checks.add(
    "voice message",
    opened.hearingRefusal === null &&
      usable &&
      holding &&
      upload.status() === 200 &&
      sentType.startsWith("audio/webm") &&
      sentMs >= HOLD_MIC_MS &&
      hearing?.model === "gpt-4o-transcribe" &&
      hearing.language === "zh" &&
      hearing.name === "voice.webm" &&
      hearing.bytes > 0 &&
      line?.modality === "voice" &&
      line.text === VOICE_TRANSCRIPT &&
      clip?.kind === "audio" &&
      clip.mime === "audio/webm" &&
      clip.durationMs === sentMs &&
      transcribed &&
      answered &&
      textReply?.modality === undefined &&
      decision?.source === "single" &&
      weighed.length === 1 &&
      Object.keys(weighed[0]?.questions ?? {}).join(" ") === "voice_moment" &&
      latest?.modality === "voice" &&
      latest.text === VOICE_TRANSCRIPT,
    `the microphone ${usable ? "was offered" : "was disabled"} (hearingRefusal ` +
      `${JSON.stringify(opened.hearingRefusal)}); held, it ${holding ? "showed" : "never showed"} ` +
      `the let-go hint; POST voice ${upload.status()} with ${sentType || "no type"}, ` +
      `${sentMs} ms; the fake server heard ${hearing ? `${hearing.bytes} bytes as ${hearing.name} with ${hearing.model} in ${hearing.language}` : "nothing"}; ` +
      `the log stores a ${String(line?.modality)} message of ${quote(line?.text ?? "")} with ` +
      `${clip ? `${clip.mime}, ${String(clip.durationMs)} ms` : "no audio"}; the page ` +
      `${transcribed ? "shows" : "lacks"} its transcript and ${answered ? "shows" : "lacks"} her ` +
      `text answer after a ${decision?.source ?? "missing"} decision that weighed ` +
      `${weighed.map((d) => Object.keys(d.questions ?? {}).join(" ")).join(", ") || "nothing"} ` +
      `on a ${String(latest?.modality)} line`,
  );

  await page
    .getByRole("button", { name: t("en", "Chat Options"), exact: true })
    .last()
    .click();
  await page.getByRole("menuitem", { name: t("en", "Chat Settings"), exact: true }).click();
  const sheet = page.getByRole("dialog");
  const voiceMode = sheet.getByRole("radio", {
    name: t("en", "Voice", {}, "reply mode"),
    exact: true,
  });
  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url() === `${origin}/api/local/chats/${id}`,
  );
  await voiceMode.click();
  const patchStatus = (await patched).status();
  const chosen = await poll(
    () => voiceMode.getAttribute("aria-checked"),
    (checked) => checked === "true",
    5_000,
  );
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });

  const fetched: Promise<string>[] = [];
  page.on("response", (response) => {
    if (!new URL(response.url()).pathname.endsWith(".mp3")) return;
    fetched.push(
      (async () => {
        const range = (await response.request().headerValue("range")) ?? "no range";
        const ranges = (await response.headerValue("accept-ranges")) ?? "none";
        return `${range} ${response.status()} accept-ranges ${ranges}`;
      })(),
    );
  });
  const textBox = page.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  const sent = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${origin}/api/local/chats/${id}/messages`,
  );
  const [spoke, weighedBefore] = [speech.length, decisions.length];
  await textBox.fill(VOICE_ASK);
  await textBox.press("Enter");
  const streamed = ndjson(await (await sent).text());
  const states = streamed
    .filter((l) => l.type === "tool" && l.name === "voice")
    .map((l) => String(l.state));
  const herAudio = log.locator('audio[src$=".mp3"]');
  await herAudio.waitFor({ state: "attached", timeout: 30_000 });
  const src = new URL((await herAudio.getAttribute("src")) as string, origin).href;
  const autoPlayed =
    (await waitFor(async () => (await mediaEvents(page)).includes(`playing ${src}`), 5_000)) !==
    null;
  if (!autoPlayed) {
    await herAudio
      .locator("xpath=..")
      .getByRole("button", { name: t("en", "Play Voice Message"), exact: true })
      .click();
  }
  const ended =
    (await waitFor(async () => (await mediaEvents(page)).includes(`ended ${src}`), 15_000)) !==
    null;
  const played = (await mediaEvents(page)).includes(`playing ${src}`);
  await herAudio
    .locator("xpath=../..")
    .getByRole("button", { name: t("en", "Show Transcript"), exact: true })
    .click();
  const chip = await shows(log.getByRole("img", { name: "sighing", exact: true }), 5_000);
  const raw = RAW_MARKUP.exec(await visibleText(log))?.[0] ?? null;
  const after = await poll(
    () => chatLog(walk, id),
    (events) => said(events, "persona", VOICE_REPLY),
    10_000,
  );
  const setting = after.find((e) => e.type === "settings" && e.replyMode === "voice");
  const reply = after.find((e) => e.type === "message" && e.text === VOICE_REPLY);
  const audio = reply?.attachments?.[0];
  const failure = after.find((e) => e.type === "turn-failed");
  const asked = speech.slice(spoke);
  checks.add(
    "voice reply",
    patchStatus === 200 &&
      chosen === "true" &&
      setting !== undefined &&
      decisions.length === weighedBefore &&
      JSON.stringify(states) === JSON.stringify(["running", "done"]) &&
      asked.length === 1 &&
      asked[0]?.model === "gpt-4o-mini-tts" &&
      asked[0].voice === "marin" &&
      asked[0].response_format === "mp3" &&
      asked[0].input === VOICE_SPOKEN &&
      reply?.modality === "voice" &&
      audio?.kind === "audio" &&
      audio.mime === "audio/mpeg" &&
      Math.abs((audio.durationMs ?? 0) - SPEECH_SECONDS * 1000) < 100 &&
      failure === undefined &&
      chip &&
      raw === null,
    `PATCH ${patchStatus} ${chosen === "true" ? "chose" : "didn't choose"} Voice and the log ` +
      `${setting ? "stores" : "lacks"} it; her reply asked the director ` +
      `${decisions.length - weighedBefore} time(s), streamed the voice tool ` +
      `${states.join(" → ") || "never"}, and asked the fake voice ${asked.length} time(s), for ` +
      `${quote(String(asked[0]?.input ?? ""))} in ${String(asked[0]?.voice)} with ` +
      `${String(asked[0]?.model)}; the log stores a ${String(reply?.modality)} message with ` +
      `${audio ? `${audio.mime}, ${String(audio.durationMs)} ms` : "no audio"}` +
      `${failure ? ` and a ${String(failure.code)} turn-failed` : ""}; its transcript's cue ` +
      (raw !== null ? `shows as written: ${raw}` : chip ? "shows as a chip" : "is missing"),
  );

  const file = `/api/local/chats/${id}/files/${audio?.name ?? "missing.mp3"}`;
  const whole = await walk.api("GET", file);
  const part = await walk.api("GET", file, undefined, { range: "bytes=0-99" });
  const player = await Promise.all(fetched);
  const ranged = player.some((entry) => /^bytes=\S+ 206 accept-ranges bytes$/.test(entry));
  await page.reload();
  const bubbles = await poll(
    () => log.getByRole("button", { name: t("en", "Play Voice Message"), exact: true }).count(),
    (count) => count === 2,
    15_000,
  );
  checks.add(
    "voice playback",
    played &&
      ended &&
      ranged &&
      whole.status === 200 &&
      whole.headers.get("content-type") === "audio/mpeg" &&
      whole.headers.get("accept-ranges") === "bytes" &&
      part.status === 206 &&
      (part.headers.get("content-range") ?? "").startsWith("bytes 0-99/") &&
      bubbles === 2,
    `her voice message ${played ? (autoPlayed ? "played on its own" : "played on Play") : "never played"} ` +
      `and ${ended ? "played to its end" : "never ended"}; the player fetched ` +
      `${player.join(", ") || "nothing"}; GET ${whole.status} ` +
      `${whole.headers.get("content-type")} accept-ranges ${whole.headers.get("accept-ranges")}, ` +
      `a range ${part.status} ${part.headers.get("content-range")}; after a reload, ${bubbles} ` +
      `voice bubbles`,
  );

  const usage = (await (await walk.api("GET", "/api/local/usage")).json()) as UsageSummary;
  const used = (role: string) =>
    usage.rows.find((row) => row.role === role && row.provider === "openai");
  const [voiced, heardRow] = [used("voice"), used("hearing")];
  checks.add(
    "voice usage",
    voiced?.characters === [...VOICE_SPOKEN].length &&
      heardRow !== undefined &&
      heardRow.records === 1 &&
      Math.abs(heardRow.audioSeconds - sentMs / 1000) < 0.01,
    `the ledger has her voice speaking ${String(voiced?.characters ?? "no")} characters and her ` +
      `hearing ${String(heardRow?.records ?? "no")} clip(s) of ` +
      `${String(heardRow?.audioSeconds ?? 0)} s`,
  );
}

/**
 * A call inside a chat, every role at the fake server: her hearing a realtime transcription session
 * that hears nothing, her mind, and her voice as PCM. The call opens on the chat's history, so her
 * greeting answers the line typed before it; her line lands in the chat while the composer waits.
 * Mid-call the tab leaves the chat for Home, the persona switcher, another chat of hers and /call:
 * the call goes on in the call bar, and what it would end or the server refuses during it waits,
 * until Return to Call brings the dock back. Hang Up stores the call's end, and a second call hung
 * up the moment its offer is out ends on the server too.
 */
async function chatCallWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, speech, listening } = walk.embeddings.seen;
  // She would hear the voice walk's tone; nobody speaks on this call.
  writeFileSync(walk.mic, silentWav(2));
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const persona = listed.personas.find((entry) => entry.id === PERSONA);
  if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
  const short = persona.shortName.trim() || persona.name;
  // Another chat of hers, made before the page loads so its list holds it, for the tab to open
  // mid-call.
  const made = await walk.api(
    "POST",
    "/api/local/chats",
    JSON.stringify({ participants: [PERSONA] }),
  );
  if (made.status !== 201) throw new Error(`POST chats answered ${made.status}`);
  const other = ((await made.json()) as { id: string }).id;
  await poll(
    () => chatLog(walk, other),
    (events) => said(events, "persona", GREETING),
    30_000,
  );

  await page.goto(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  await page.getByRole("menuitem", { name: t("en", "Start Chat"), exact: true }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  if (!(await shows(log.getByText(GREETING, { exact: true }), 30_000))) {
    throw new Error("her greeting never showed");
  }
  const textBox = page.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  await textBox.fill(CALL_TOLD);
  await textBox.press("Enter");
  const told = await poll(
    () => chatLog(walk, id),
    (events) => said(events, "persona", CALL_TOLD_REPLY),
    30_000,
  );
  if (!said(told, "persona", CALL_TOLD_REPLY)) {
    throw new Error("her answer to the line typed before the call was never stored");
  }
  // Open before the call, so only a refused send tells it of the call.
  const tab = await walk.context.newPage();
  await tab.goto(`${origin}/chats/${id}`);
  const tabLog = tab.getByRole("log", { name: t("en", "Conversation"), exact: true });
  const tabBox = tab.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  if (!((await shows(tabBox, 15_000)) && (await tabBox.isEnabled()))) {
    throw new Error("the second tab's composer never showed");
  }

  const [minded, spoke, listened] = [chats.length, speech.length, listening.length];
  const logged = walk.serverLog().length;
  // To the walk's end, whose later checks read the call's: a throw mid-call must not leave it up.
  try {
    const offered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/api/offer",
    );
    await page.getByRole("button", { name: t("en", "Call"), exact: true }).click();
    const offer = await offered;
    const offerBody = offer.request().postDataJSON() as {
      readonly requestData?: unknown;
      readonly request_data?: unknown;
    };
    const offerData = (offerBody.requestData ?? offerBody.request_data) as
      | { readonly chatId?: unknown; readonly persona?: unknown }
      | undefined;
    const dock = page.getByRole("region", {
      name: t("en", "Call with {name}", { name: short }),
      exact: true,
    });
    const docked = await shows(dock, 10_000);
    const greeted = await shows(log.getByText(CALL_GREETING, { exact: true }), 60_000);
    const waiting = page.getByRole("textbox", { name: t("en", "In a call"), exact: true });
    const composerWaits = (await shows(waiting, 5_000)) && (await waiting.isDisabled());
    const started = await shows(
      log.getByText(t("en", "Call with {name}", { name: short }), { exact: true }),
      5_000,
    );
    const marked = (await log.getByText(t("en", "(on the call)")).count()) === 1;
    const during = (await (await walk.api("GET", `/api/local/chats/${id}`)).json()) as ChatContents;
    const refused = await walk.api(
      "POST",
      `/api/local/chats/${id}/messages`,
      JSON.stringify({ text: "在吗" }),
    );
    const refusal = ((await refused.json()) as { error?: { code?: string } }).error?.code;
    const stored = await poll(
      () => chatLog(walk, id),
      (events) => events.some((e) => e.modality === "call"),
      10_000,
    );
    const opened = stored.find((e) => e.type === "call-started");
    const line = stored.find((e) => e.modality === "call");
    const request = chats
      .slice(minded)
      .find((r) => heard(r, CALL_TOLD) && r.messages?.at(-1)?.content !== CALL_TOLD);
    const history = (request?.messages ?? []).map((m) => `${String(m.role)}:${String(m.content)}`);
    const at = (entry: string) => history.indexOf(entry);
    const carried =
      at(`assistant:${GREETING}`) >= 0 &&
      at(`assistant:${GREETING}`) < at(`user:${CALL_TOLD}`) &&
      at(`user:${CALL_TOLD}`) < at(`assistant:${CALL_TOLD_REPLY}`) &&
      history.slice(at(`assistant:${CALL_TOLD_REPLY}`) + 1).some((m) => m.startsWith("user:"));
    const voiced = speech.slice(spoke).filter((s) => s.response_format === "pcm");
    const ear = listening.slice(listened);
    checks.add(
      "chat call",
      offer.status() === 200 &&
        offerData?.chatId === id &&
        offerData.persona === PERSONA &&
        docked &&
        greeted &&
        composerWaits &&
        started &&
        marked &&
        during.call?.persona === PERSONA &&
        opened?.persona === PERSONA &&
        during.call.id === opened.call &&
        refused.status === 409 &&
        refusal === "chat-in-call" &&
        line?.type === "message" &&
        line.speaker?.kind === "persona" &&
        line.speaker.id === PERSONA &&
        line.text === CALL_GREETING &&
        line.interrupted === undefined &&
        carried &&
        voiced.some((s) => String(s.input).trim() === CALL_GREETING) &&
        ear.length === 1 &&
        (ear[0]?.appended ?? 0) > 0,
      `POST /api/offer ${offer.status()} for chat ${offerData?.chatId === id ? "this one" : String(offerData?.chatId)} ` +
        `and ${String(offerData?.persona)}; the dock ${docked ? "showed" : "never showed"}, her ` +
        `greeting ${greeted ? "landed" : "never landed"} in the log ${marked ? "with" : "without"} ` +
        `its call mark, under ${started ? "its" : "no"} separator, while the composer ` +
        `${composerWaits ? "waited" : "didn't wait"}; GET chats/:id said ` +
        `${JSON.stringify(during.call)}; a send answered ${refused.status} ${String(refusal)}; ` +
        `the log stores ${opened ? `call-started for ${String(opened.persona)}` : "no call-started"} ` +
        `and ${line ? `a ${line.speaker?.kind} call line ${quote(line.text ?? "")}` : "no call line"}; ` +
        `her call's first mind request ${request ? (carried ? "carried the chat's lines in order" : `held ${history.join(" | ")}`) : "was never made"}; ` +
        `her voice spoke ${voiced.map((s) => quote(String(s.input))).join(", ") || "nothing"} as PCM; ` +
        `her hearing opened ${ear.length} session(s), streamed ${ear[0]?.appended ?? 0} chunks`,
    );

    await tabBox.fill("在吗");
    await tabBox.press("Enter");
    const tabWaiting = tab.getByRole("textbox", { name: t("en", "In a call"), exact: true });
    const tabLearned = (await shows(tabWaiting, 10_000)) && (await tabWaiting.isDisabled());

    // The call outlives its page: the bar holds it on Home, and what it would end or the server
    // refuses during it waits.
    await page.locator('nav a[href="/"]').first().click();
    await page.waitForURL(`${origin}/`);
    const bar = page.getByRole("region", { name: t("en", "Ongoing Call"), exact: true });
    const barShown = await shows(bar, 10_000);
    const barHolds =
      (await shows(bar.getByRole("button", { name: t("en", "Hang Up"), exact: true }), 5_000)) &&
      (await shows(bar.getByRole("link", { name: t("en", "Return to Call"), exact: true }), 5_000));
    const [barBox, viewport] = [await bar.boundingBox(), page.viewportSize()];
    const atFoot =
      barBox !== null &&
      viewport !== null &&
      Math.abs(barBox.y + barBox.height - viewport.height) <= 1;
    const setupLinks = await page.locator('a[href^="/setup"]').count();
    const memory = page.getByRole("button", { name: t("en", "Turn On Memory"), exact: true });
    const memoryWaits =
      (await shows(memory, 5_000)) && (await memory.getAttribute("aria-disabled")) === "true";
    const held = (await (await walk.api("GET", `/api/local/chats/${id}`)).json()) as ChatContents;
    const stillHeld =
      held.call !== null &&
      held.call.id === during.call?.id &&
      !held.events.some((e) => e.type === "call-ended");
    const { persona: active } = (await (
      await walk.api("GET", "/api/local/status")
    ).json()) as Status;
    let switcher = "the switcher had no other persona to offer";
    let switchWaits = true;
    // The group walk's persona, when it made one, can't be switched to.
    if (listed.personas.some((entry) => entry.id === SECOND.id)) {
      await page
        .getByRole("button", {
          name: t("en", "Active Persona: {name}", { name: active.name }),
          exact: true,
        })
        .click();
      const item = page.getByRole("menuitemradio", { name: SECOND.name, exact: true });
      switchWaits =
        (await shows(item, 5_000)) && (await item.getAttribute("aria-disabled")) === "true";
      await page.keyboard.press("Escape");
      switcher = `the switcher ${switchWaits ? "held" : "did NOT hold"} ${SECOND.name} back`;
    }
    await page.locator(`nav a[href="/chats/${other}"]`).first().click();
    await page.waitForURL(`${origin}/chats/${other}`);
    // One on the page: the bar, the screen and the dock have none.
    const otherCall = page.getByRole("button", { name: t("en", "Call"), exact: true });
    const otherWaits =
      (await shows(otherCall, 10_000)) &&
      (await otherCall.getAttribute("aria-disabled")) === "true";
    const otherBox = page.getByRole("textbox", {
      name: t("en", "Message {name}", { name: short }),
      exact: true,
    });
    const otherTypes = (await shows(otherBox, 5_000)) && (await otherBox.isEnabled());
    const recorders = await page
      .getByRole("button", { name: t("en", "Record Voice Message"), exact: true })
      .count();
    await page.locator('nav a[href="/call"]').first().click();
    await page.waitForURL(`${origin}/call`);
    const activeShort = active.shortName.trim() || active.name;
    const inCallSaid = await shows(
      page.getByText(t("en", "You're in a call"), { exact: true }),
      10_000,
    );
    const callHere = page.getByRole("button", {
      name: t("en", "Call {name}", { name: activeShort }),
      exact: true,
    });
    const callWaits =
      (await shows(callHere, 5_000)) && (await callHere.getAttribute("aria-disabled")) === "true";
    await bar.getByRole("link", { name: t("en", "Return to Call"), exact: true }).click();
    await page.waitForURL(`${origin}/chats/${id}`);
    const redocked = await shows(dock, 10_000);
    // The call's own transcript stands in for its stored line only while the shell kept its id.
    const ownLine = await shows(
      log.locator("[data-live-call]").getByText(CALL_GREETING, { exact: true }),
      10_000,
    );
    const barGone = await bar
      .waitFor({ state: "hidden", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const playing = await page.evaluate(() => {
      const audio = document.querySelector<HTMLAudioElement>("audio[data-call]");
      return audio !== null && audio.srcObject instanceof MediaStream && !audio.paused;
    });
    checks.add(
      "chat call away",
      barShown &&
        barHolds &&
        atFoot &&
        setupLinks === 0 &&
        memoryWaits &&
        stillHeld &&
        switchWaits &&
        otherWaits &&
        otherTypes &&
        recorders === 0 &&
        inCallSaid &&
        callWaits &&
        redocked &&
        ownLine &&
        barGone &&
        playing,
      `on Home the call bar ${barShown ? "showed" : "never showed"} ` +
        `${barHolds ? "with" : "WITHOUT"} Hang Up and Return to Call, its foot ` +
        `${atFoot ? "at" : `NOT at (${JSON.stringify(barBox)} in ${JSON.stringify(viewport)})`} ` +
        `the window's; Home held ${setupLinks} link(s) into setup, and Turn On Memory ` +
        `${memoryWaits ? "waited" : "didn't wait"}; GET chats/:id ` +
        `${stillHeld ? "still held the call" : `said ${JSON.stringify(held.call)}`}; ${switcher}; ` +
        `another chat's Call ${otherWaits ? "waited" : "didn't wait"}, its text box ` +
        `${otherTypes ? "took text" : "didn't"}, beside ${recorders} voice-message button(s); ` +
        `/call ${inCallSaid ? "said you're in a call" : "never said you're in a call"}, its Call ` +
        `${callWaits ? "waiting" : "NOT waiting"}; Return to Call brought ` +
        `${redocked ? "the dock" : "no dock"} back, ${ownLine ? "with" : "WITHOUT"} her greeting ` +
        `as the call's own line, the bar ${barGone ? "gone" : "still there"} and the call's audio ` +
        `${playing ? "playing" : "NOT playing"}`,
    );

    await dock.getByRole("button", { name: t("en", "Hang Up"), exact: true }).click();
    const undocked = await dock
      .waitFor({ state: "hidden", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const after = await poll(
      () => chatLog(walk, id),
      (events) => events.some((e) => e.type === "call-ended"),
      20_000,
    );
    const end = after.find((e) => e.type === "call-ended");
    const back = (await shows(textBox, 10_000)) && (await textBox.isEnabled());
    const closed = await shows(log.getByText(t("en", "Call ended"), { exact: true }), 10_000);
    const lasted = new RegExp(
      `^${escapeRegExp(t("en", "Call with {name} · {duration}", { name: short, duration: "\0" })).replace("\0", "\\d+:\\d{2}")}$`,
    );
    const timed = await shows(log.getByText(lasted), 10_000);
    const tabBack = (await shows(tabBox, 10_000)) && (await tabBox.isEnabled());
    const tabClosed = await shows(tabLog.getByText(t("en", "Call ended"), { exact: true }), 5_000);
    await tab.close();
    checks.add(
      "chat call tab",
      tabLearned && tabBack && tabClosed,
      `a second tab open before the call ${tabLearned ? "learned of it" : "never learned of it"} ` +
        `from a refused send; after the hang-up, without a reload, its composer ` +
        `${tabBack ? "came back" : "stayed disabled"}, under ${tabClosed ? "a" : "no"} Call ended line`,
    );
    const sent = await walk.api(
      "POST",
      `/api/local/chats/${id}/messages`,
      JSON.stringify({ text: CHAT_MESSAGE }),
    );
    const errors = walk
      .serverLog()
      .slice(logged)
      .split("\n")
      .filter((entry) => /\| (ERROR|CRITICAL) +\|/.test(entry));
    await page.reload();
    const kept =
      (await shows(log.getByText(CALL_GREETING, { exact: true }), 15_000)) &&
      (await shows(log.getByText(t("en", "Call ended"), { exact: true }), 5_000)) &&
      (await shows(log.getByText(lasted), 5_000));
    checks.add(
      "chat call end",
      undocked &&
        end?.call === opened?.call &&
        end?.reason === "hangup" &&
        after.at(-1)?.type === "call-ended" &&
        back &&
        closed &&
        timed &&
        sent.status === 200 &&
        errors.length === 0 &&
        kept,
      `Hang Up ${undocked ? "closed" : "left"} the dock; the log ` +
        `${end ? `ends the call: ${String(end.reason)}` : "never stored its end"}; the composer ` +
        `${back ? "came back" : "stayed disabled"}, under ${closed ? "a" : "no"} Call ended line and ` +
        `${timed ? "the call's length" : "no length"}; a send afterwards answered ${sent.status}; ` +
        `the server logged ${errors.length === 0 ? "no errors" : errors.slice(0, 2).join(" ")} during ` +
        `the call; after a reload the call ${kept ? "stays in the log" : "is gone from the log"}`,
    );

    const ends = (events: readonly LoggedEvent[]) =>
      events.filter((e) => e.type === "call-ended").length;
    const endsBefore = ends(await chatLog(walk, id));
    // The offer is held until Hang Up has run, so the call is still connecting when it does.
    let releaseOffer = () => {};
    const offerReleased = new Promise<void>((resolve) => {
      releaseOffer = resolve;
    });
    const passing: Promise<void>[] = [];
    const holdOffer = (route: Route) => {
      const pass = (async () => {
        if (route.request().method() === "POST") await offerReleased;
        await route.continue();
      })();
      passing.push(pass);
      return pass;
    };
    await page.route("**/api/offer", holdOffer);
    let hungUpAt = 0;
    try {
      const offering = page.waitForRequest(
        (request) =>
          request.method() === "POST" && new URL(request.url()).pathname === "/api/offer",
      );
      await page.getByRole("button", { name: t("en", "Call"), exact: true }).click();
      await offering;
      await dock.getByRole("button", { name: t("en", "Hang Up"), exact: true }).click();
      hungUpAt = Date.now();
    } finally {
      releaseOffer();
      // unroute doesn't wait for a handler still running (the "default" behavior of
      // https://playwright.dev/docs/api/class-page#page-unroute-all): Playwright continues its
      // route itself, and the handler's own continue then throws "Route is already handled!".
      await Promise.allSettled(passing);
      await page.unroute("**/api/offer", holdOffer);
    }
    const calls = await poll(
      async () =>
        ((await (await walk.api("GET", "/api/local/status")).json()) as Status).activeCalls,
      (count) => count === 0,
      10_000,
    );
    const settled = Date.now() - hungUpAt;
    const quick = await poll(
      () => chatLog(walk, id),
      (events) => ends(events) > endsBefore,
      5_000,
    );
    const quickEnd =
      ends(quick) > endsBefore ? quick.filter((e) => e.type === "call-ended").at(-1) : undefined;
    const quickBack = (await shows(textBox, 5_000)) && (await textBox.isEnabled());
    checks.add(
      "chat call hung up as it connects",
      calls === 0 && settled <= 10_000 && quickEnd?.reason === "hangup" && quickBack,
      `Hang Up with the offer held: the server held ` +
        `${calls === 0 ? `no call ${seconds(settled)} later` : `${calls} call(s) after ${seconds(settled)}`}; ` +
        `the log ${quickEnd ? `ends it: ${String(quickEnd.reason)}` : "never stored its end"}; the ` +
        `composer ${quickBack ? "came back" : "stayed disabled"}`,
    );
  } finally {
    await hangUpIfUp(walk);
  }
}

/** Her stage on the call's screen. */
const SCREEN_STAGE = "[data-call-screen] [data-avatar]";

/**
 * Watches her stage on the screen every frame from now on: `moved` turns true once the stage has
 * said she speaks and its mouth has opened past MOUTH_OPEN, false after 30 s.
 */
async function watchMouth(page: Page): Promise<{ readonly moved: Promise<boolean> }> {
  await page.evaluate(() => {
    (window as unknown as { smokeMouth: unknown }).smokeMouth = { max: 0, spoke: false };
  });
  const moved = page
    .waitForFunction(
      ({ selector, open }) => {
        const host = document.querySelector(selector);
        const seen = (window as unknown as { smokeMouth: { max: number; spoke: boolean } })
          .smokeMouth;
        if (host?.getAttribute("data-speaking") === "true") seen.spoke = true;
        seen.max = Math.max(seen.max, Number(host?.getAttribute("data-mouth") ?? 0));
        return seen.spoke && seen.max > open;
      },
      { selector: SCREEN_STAGE, open: MOUTH_OPEN },
      { polling: "raf", timeout: 30_000 },
    )
    .then(
      () => true,
      () => false,
    );
  return { moved };
}

/** The widest her stage's mouth opened since the watch began. */
async function widestMouth(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { smokeMouth?: { max: number } }).smokeMouth?.max ?? 0,
  );
}

interface Drawing {
  /** Her stage's frames as it first wrote them; null if it never did. */
  readonly from: number | null;
  /** What they grew to within 5 s. */
  readonly to: number | null;
}

/** Her stage on the screen drawing on: its frames, read as it writes them each tick. */
async function drawsOn(page: Page): Promise<Drawing> {
  const read = () =>
    page.evaluate((selector) => {
      const frames = document.querySelector(selector)?.getAttribute("data-frames");
      return frames === null || frames === undefined ? null : Number(frames);
    }, SCREEN_STAGE);
  const from = await poll(read, (frames) => frames !== null, 5_000);
  if (from === null) return { from, to: null };
  const to = await poll(read, (frames) => frames !== null && frames > from + 3, 5_000);
  return { from, to };
}

const drew = (drawing: Drawing): boolean =>
  drawing.from !== null && drawing.to !== null && drawing.to > drawing.from + 3;

/**
 * A call with her model, every role at the fake server: Call opens the chat's video screen, her
 * stage drawing the CC0 rig, and the fake hearing's question gets her answer, which opens with a
 * happy direction: her mouth moves on the voice's tone, her mood shows, and the caption says it.
 * Shrink docks the same stage and Expand brings it back; Home shows the call bar, which draws no
 * stage, and Return to Call the screen, drawing again; the bar's Hang Up ends the call; and a second
 * call in the tab moves her mouth again.
 */
async function videoCallWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  const { listening } = walk.embeddings.seen;
  // Nobody speaks on this call but the fake hearing.
  writeFileSync(walk.mic, silentWav(2));
  await configure(walk, PERSONA, { "appearance.model": await fixtureModel(walk) });
  try {
    const listed = (await (
      await walk.api("GET", "/api/local/personas")
    ).json()) as PersonasResponse;
    const persona = listed.personas.find((entry) => entry.id === PERSONA);
    if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
    const short = persona.shortName.trim() || persona.name;
    const made = await walk.api(
      "POST",
      "/api/local/chats",
      JSON.stringify({ participants: [PERSONA] }),
    );
    if (made.status !== 201) throw new Error(`POST chats answered ${made.status}`);
    const id = ((await made.json()) as { id: string }).id;
    await poll(
      () => chatLog(walk, id),
      (events) => said(events, "persona", GREETING),
      30_000,
    );
    // A fresh load, so GET personas names her model.
    await page.goto(`${origin}/chats/${id}`);
    const region = page.getByRole("region", {
      name: t("en", "Call with {name}", { name: short }),
      exact: true,
    });
    const screen = page.locator("[data-call-screen]");
    const ready = region.locator(`[data-avatar="${PERSONA}"][data-state="ready"]`);
    const stageOf = () =>
      region
        .locator("canvas[data-stage]")
        .getAttribute("data-stage", { timeout: 5_000 })
        .catch(() => null);
    const call = page.getByRole("button", { name: t("en", "Call"), exact: true });
    const hangUp = (where: Locator) =>
      where.getByRole("button", { name: t("en", "Hang Up"), exact: true });
    const webgl = await page.evaluate(
      () => document.createElement("canvas").getContext("webgl") !== null,
    );
    const heard = listening.length;
    await page.evaluate(() => {
      const seen = window as unknown as { smokeTasks: number[] };
      seen.smokeTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) seen.smokeTasks.push(entry.duration);
      }).observe({ type: "longtask" });
    });
    await call.click();
    if (!webgl) {
      // Her stage can't draw here, so the call docks as one without a model does.
      const docked = await poll(
        async () => (await region.count()) === 1 && (await screen.count()) === 0,
        (yes) => yes,
        30_000,
      );
      const expands = await region
        .getByRole("button", { name: t("en", "Expand"), exact: true })
        .count();
      const pictured = await region.locator('[data-slot="avatar"]').count();
      checks.add(
        "video call",
        docked && expands === 0 && pictured > 0,
        `this browser makes no WebGL context, so the call ${docked ? "docked" : "never docked"} ` +
          `as one without a model does, ${expands === 0 ? "with no" : "but with"} Expand and ` +
          `${pictured > 0 ? "with" : "WITHOUT"} her picture; the stage, mouth, frames and ` +
          `canvas checks, and the steps after this one, were skipped`,
      );
      return;
    }
    const opened =
      (await shows(region, 10_000)) && (await region.getAttribute("data-call-screen")) !== null;
    const drawn = await shows(ready, 30_000);
    const longest = await page.evaluate(() =>
      Math.max(0, ...(window as unknown as { smokeTasks: number[] }).smokeTasks),
    );
    const placed = await stageOf();
    const greeted = await poll(
      () => chatLog(walk, id),
      (events) => saidOnCall(events, "persona", GREETING),
      60_000,
    );
    if (!saidOnCall(greeted, "persona", GREETING)) {
      throw new Error(`her greeting on the video call was never stored: ${await alerts(page)}`);
    }
    const sessions = await poll(
      async () => listening.slice(heard),
      (opening) => opening.length > 0,
      10_000,
    );
    const ear = sessions[0];
    if (ear === undefined) throw new Error("her hearing opened no session on the video call");

    const answer = await watchMouth(page);
    ear.say(VIDEO_ASK);
    const moved = await answer.moved;
    const widest = await widestMouth(page);
    const captioned = await shows(
      region.locator("[data-captions]").getByText(VIDEO_REPLY_SAID, { exact: true }),
      15_000,
    );
    const happy = await shows(region.locator('[data-avatar][data-mood~="happy"]'), 5_000);
    const mood = await region
      .locator("[data-avatar]")
      .getAttribute("data-mood", { timeout: 5_000 })
      .catch(() => null);
    const shut = await page
      .waitForFunction(
        ({ selector, closed }) => {
          const host = document.querySelector(selector);
          return (
            host?.getAttribute("data-speaking") === "false" &&
            Number(host.getAttribute("data-mouth") ?? 1) < closed
          );
        },
        { selector: SCREEN_STAGE, closed: MOUTH_SHUT },
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      );
    checks.add(
      "video call",
      opened && drawn && placed !== null && moved && captioned && happy && shut,
      `Call ${opened ? "opened the video screen" : "opened no video screen"}, her stage ` +
        `${drawn ? `ready on ${String(placed)}` : `never ready: ${await alerts(page)}`}, ` +
        `${longest === 0 ? "no main-thread task over 50 ms" : `the longest main-thread task ${Math.round(longest)} ms`} ` +
        `from Call to then; as she answered, ` +
        `her mouth ${moved ? "moved" : "never moved"}, opening to ${widest.toFixed(2)}, the ` +
        `caption ${captioned ? "said" : "never said"} ${quote(VIDEO_REPLY_SAID)}, her mood ` +
        `${happy ? "happy" : `NOT happy (${JSON.stringify(mood)})`}, and her mouth ` +
        `${shut ? "shut" : "never shut"} once she stopped`,
    );

    await region.getByRole("button", { name: t("en", "Shrink"), exact: true }).click();
    const shrunk = await screen
      .waitFor({ state: "detached", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    const expand = region.getByRole("button", { name: t("en", "Expand"), exact: true });
    const expandShown = await shows(expand, 5_000);
    const focused = await poll(
      () => expand.evaluate((el) => el === document.activeElement).catch(() => false),
      (yes) => yes,
      5_000,
    );
    const docked = await stageOf();
    await expand.click();
    const expanded = await shows(screen, 5_000);
    const unshrunk = await stageOf();
    const drawing = await drawsOn(page);
    checks.add(
      "video call shrink",
      shrunk &&
        expandShown &&
        focused &&
        docked === placed &&
        expanded &&
        unshrunk === placed &&
        drew(drawing),
      `Shrink ${shrunk ? "docked the call" : "left the screen up"}, its Expand ` +
        `${expandShown ? (focused ? "shown and focused" : "shown, NOT focused") : "missing"}, on ` +
        `stage ${String(docked)}; Expand ${expanded ? "opened the screen" : "opened no screen"} ` +
        `on stage ${String(unshrunk)}, placed as ${String(placed)}, whose frames went ` +
        `${String(drawing.from)} to ${String(drawing.to)} in 5 s`,
    );

    await page.locator('nav a[href="/"]').first().click();
    await page.waitForURL(`${origin}/`);
    const bar = page.getByRole("region", { name: t("en", "Ongoing Call"), exact: true });
    const barShown = await shows(bar, 10_000);
    const barCanvases = await bar.locator("canvas").count();
    await bar.getByRole("link", { name: t("en", "Return to Call"), exact: true }).click();
    await page.waitForURL(`${origin}/chats/${id}`);
    const returned = (await shows(screen, 10_000)) && (await shows(ready, 10_000));
    const kept = await stageOf();
    const redrawing = await drawsOn(page);
    const barGone = await bar
      .waitFor({ state: "hidden", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.locator('nav a[href="/"]').first().click();
    await page.waitForURL(`${origin}/`);
    await hangUp(bar).click();
    const barHidden = await bar
      .waitFor({ state: "hidden", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const ended = await poll(
      () => chatLog(walk, id),
      (events) => events.some((e) => e.type === "call-ended"),
      20_000,
    );
    const end = ended.find((e) => e.type === "call-ended");
    await page.locator(`nav a[href="/chats/${id}"]`).first().click();
    await page.waitForURL(`${origin}/chats/${id}`);
    const box = page.getByRole("textbox", {
      name: t("en", "Message {name}", { name: short }),
      exact: true,
    });
    const free = (await shows(box, 10_000)) && (await box.isEnabled());
    const left = await region.count();
    checks.add(
      "video call away",
      barShown &&
        barCanvases === 0 &&
        returned &&
        kept === placed &&
        drew(redrawing) &&
        barGone &&
        barHidden &&
        end?.reason === "hangup" &&
        free &&
        left === 0,
      `on Home the call bar ${barShown ? "showed" : "never showed"}, with ${barCanvases} ` +
        `canvas(es) in it; Return to Call brought ${returned ? "the screen back" : "no screen"} ` +
        `on stage ${String(kept)}, its frames going ${String(redrawing.from)} to ` +
        `${String(redrawing.to)} in 5 s, the bar ${barGone ? "gone" : "still there"}; the bar's ` +
        `Hang Up ${barHidden ? "hid it" : "left it"}, the log ending the call ` +
        `${end === undefined ? "never" : String(end.reason)}; back in the chat, ${left} region(s) ` +
        `named for the call, its text box ${free ? "free" : "NOT free"}`,
    );

    const again = await watchMouth(page);
    await call.click();
    const reopened = (await shows(screen, 10_000)) && (await shows(ready, 30_000));
    const movedAgain = await again.moved;
    const widestAgain = await widestMouth(page);
    checks.add(
      "video call again",
      reopened && movedAgain,
      `a second Call ${reopened ? "opened the screen on a ready stage" : `opened no ready stage: ${await alerts(page)}`}, ` +
        `where her mouth ${movedAgain ? "moved" : "never moved"} as she greeted, opening to ` +
        `${widestAgain.toFixed(2)}`,
    );
    await hangUp(region).click();
  } finally {
    await hangUpIfUp(walk);
    await configure(walk, PERSONA, { "appearance.model": null });
  }
}

/** settings.yaml's assistant.folders, as JSON to compare, or "absent". */
function savedAssistantFolders(home: string): string {
  const path = join(home, "settings.yaml");
  if (!existsSync(path)) return "absent";
  const yaml = parseYaml(readFileSync(path, "utf8")) as {
    assistant?: { folders?: unknown };
  } | null;
  const folders = yaml?.assistant?.folders;
  return folders === undefined ? "absent" : JSON.stringify(folders);
}

async function taskOf(walk: Walk, id: string): Promise<TaskSnapshot | null> {
  const response = await walk.api("GET", `/api/local/tasks/${id}`);
  return response.ok ? ((await response.json()) as TaskSnapshot) : null;
}

/** The task her start_task call `callId` started, once its `started` result is in the log. */
function startedTask(events: readonly LoggedEvent[], callId: string): string | null {
  const started = events.find(
    (e) => e.type === "tool-result" && e.stage === "started" && e.callId === callId,
  );
  const task = started?.result?.task;
  return typeof task === "string" ? task : null;
}

/** The tasks her start_task calls started, in the order they started: her task numbers there. */
function tasksStarted(events: readonly LoggedEvent[]): string[] {
  return events.flatMap((e) =>
    e.type === "tool-result" && e.stage === "started" && typeof e.result?.task === "string"
      ? [e.result.task]
      : [],
  );
}

function lastContent(request: ChatRequest | undefined): string {
  return String(request?.messages?.at(-1)?.content ?? "");
}

/** The call whose result the request ends on; null when it ends on no tool result. */
function resultFor(request: ChatRequest | undefined): string | null {
  const last = request?.messages?.at(-1);
  return last?.role === "tool" ? String(last.tool_call_id) : null;
}

function offers(request: ChatRequest | undefined, name: string): boolean {
  return (request?.tools ?? []).some((tool) => tool.function?.name === name);
}

/** Her task tools the request offers, start_task first. */
function taskToolsOf(request: ChatRequest | undefined): string[] {
  return ["start_task", ...TASK_TOOLS].filter((name) => offers(request, name));
}

/** Her task tools as a check's detail names them. */
function toolsNamed(request: ChatRequest | undefined): string {
  const named = taskToolsOf(request);
  return named.length === 0 ? "none of her task tools" : named.join(", ");
}

/** Whether the request's system message carries her start_task hint. */
function hinted(request: ChatRequest | undefined): boolean {
  return systemOf(request).includes("调用 start_task 工具");
}

/**
 * The status block of her tasks, where her answer to a viewer's line has it: the message before
 * that line, a developer one the OpenAI-compatible account sends as the user's. "" without one.
 */
function statusBlock(request: ChatRequest | undefined): string {
  const block = request?.messages?.at(-2);
  const text = String(block?.content ?? "");
  return block?.role === "user" && text.startsWith(TASKS_BLOCK) ? text : "";
}

/** The status blocks anywhere in the request. */
function statusBlocks(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? [])
    .map((message) => String(message.content ?? ""))
    .filter((text) => text.includes(TASKS_BLOCK));
}

/** The roles of the request's messages that hold `text`. */
function rolesHolding(request: ChatRequest | undefined, text: string): string[] {
  return (request?.messages ?? []).flatMap((message) =>
    String(message.content ?? "").includes(text) ? [String(message.role)] : [],
  );
}

/** The last status block a turn stored that no later turn took out of her view. */
function shownBlock(events: readonly LoggedEvent[]): LoggedEvent | undefined {
  const removed = new Set(
    events.flatMap((e) => (e.type === "context-removed" ? (e.seqs ?? []) : [])),
  );
  return events.findLast(
    (e) => e.type === "context" && e.content?.startsWith(TASKS_BLOCK) && !removed.has(e.seq),
  );
}

/** Whether `text` was said on a call, by the viewer or by her. */
function saidOnCall(
  events: readonly LoggedEvent[],
  kind: "user" | "persona",
  text: string,
): boolean {
  return events.some(
    (e) =>
      e.type === "message" && e.modality === "call" && e.speaker?.kind === kind && e.text === text,
  );
}

const ENDED_TASK = new Set(["succeeded", "failed", "cancelled"]);

/** The task walk's chat, which the walks after its first task go on in. */
interface TaskChatPage {
  readonly id: string;
  /** Her name as the page shows it. */
  readonly short: string;
  readonly log: Locator;
  readonly box: Locator;
  /** Her first task there. */
  readonly first: string;
}

/**
 * Types `text` into the task's chat and waits until her answer `answer` is stored and shown; the
 * requests her mind took meanwhile.
 */
async function askHer(
  walk: Walk,
  chat: TaskChatPage,
  text: string,
  answer: string,
): Promise<ChatRequest[]> {
  const { chats } = walk.embeddings.seen;
  const from = chats.length;
  await chat.box.fill(text);
  await chat.box.press("Enter");
  const stored = await poll(
    () => chatLog(walk, chat.id),
    (events) => said(events, "persona", answer),
    30_000,
  );
  if (!said(stored, "persona", answer)) {
    const asked = chats.slice(from).map((request) => quote(lastContent(request), 40));
    throw new Error(
      `her answer to ${quote(text)} was never stored: her mind was asked ${asked.join(", ") || "nothing"}`,
    );
  }
  await shows(chat.log.getByText(answer, { exact: true }), 15_000);
  return chats.slice(from);
}

/** A request's JSON tool result, parsed; null when it isn't JSON. */
function parsedResult(request: ChatRequest | undefined): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(lastContent(request));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A task she starts in a chat of one: the assistant role set up in Settings on the decisions
 * account, whose usage blocks price the worker's requests; her start_task call for the viewer's
 * line, and her line after it reading the task's status; the status block of her tasks before
 * Allow Once on the card, while the task runs, and at a path outside the task's folders, where
 * check_task reads her its detail and steer_task passes on the viewer's change, which the card
 * lists until Allow Once on the path; the page the worker wrote, Show Steps and her report.
 */
async function taskWalk(walk: Walk): Promise<TaskChatPage> {
  const { page, checks, origin } = walk;
  const { chats, workers } = walk.embeddings.seen;
  const { site, notes } = walk.embeddings.places;
  const account = await fakeAccount(walk, "openrouter", DECISIONS_ACCOUNT_NAME);

  await page.goto(`${origin}/settings?tab=assistant`);
  const provider = page.getByLabel(t("en", "Assistant Provider"), { exact: true });
  await provider.click();
  await page.getByRole("option", { name: DECISIONS_ACCOUNT_NAME, exact: true }).click();
  // The field is plain text until the account's list arrives, and the list lacks the worker's.
  const model = page.getByRole("combobox", { name: t("en", "Assistant Model"), exact: true });
  if (await shows(model, 15_000)) {
    await model.click();
    await page.getByPlaceholder(t("en", "Search models")).fill(WORKER_MODEL);
    await page
      .getByRole("option", { name: t("en", "Use “{model}”", { model: WORKER_MODEL }), exact: true })
      .click();
  } else {
    await page.getByLabel(t("en", "Assistant Model"), { exact: true }).fill(WORKER_MODEL);
  }
  const saved = page.waitForResponse(isPut(`${origin}/api/local/settings`));
  await page
    .locator("form", { has: provider })
    .getByRole("button", { name: t("en", "Save"), exact: true })
    .click();
  const saveStatus = (await saved).status();
  const yaml = parseYaml(readFileSync(join(walk.home, "settings.yaml"), "utf8")) as {
    assistant?: { provider?: unknown; model?: unknown };
  };
  const mode = await poll(
    async () => ((await (await walk.api("GET", "/api/local/status")).json()) as Status).assistant,
    (assistant) => assistant.ready,
    10_000,
  );
  checks.add(
    "assistant settings",
    saveStatus === 200 &&
      yaml.assistant?.provider === account &&
      yaml.assistant.model === WORKER_MODEL &&
      mode.enabled &&
      mode.ready,
    `PUT settings ${saveStatus}; settings.yaml runs tasks on ${String(yaml.assistant?.provider)} ` +
      `with ${String(yaml.assistant?.model)}; Assistant Mode is ${mode.enabled ? "on" : "off"} ` +
      `and ${mode.ready ? "ready" : `not ready: ${String(mode.problem)}`}`,
  );

  mkdirSync(dirname(notes), { recursive: true });
  writeFileSync(notes, `${NOTES_TEXT}\n`);
  const folders = savedAssistantFolders(walk.home);
  const listed = (await (await walk.api("GET", "/api/local/personas")).json()) as PersonasResponse;
  const persona = listed.personas.find((entry) => entry.id === PERSONA);
  if (persona === undefined) throw new Error(`GET personas has no ${PERSONA}`);
  const short = persona.shortName.trim() || persona.name;

  await page.goto(`${origin}/chats`);
  await page
    .getByRole("button", { name: t("en", "New Chat"), exact: true })
    .first()
    .click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: persona.name }).click();
  const greeted = chats.length;
  await page.getByRole("menuitem", { name: t("en", "Start Chat"), exact: true }).click();
  await page.waitForURL(/\/chats\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1) as string;
  const log = page.getByRole("log", { name: t("en", "Conversation"), exact: true });
  if (!(await shows(log.getByText(GREETING, { exact: true }), 30_000))) {
    throw new Error("her greeting never showed in the task's chat");
  }
  const greeting = chats[greeted];

  const box = page.getByRole("textbox", {
    name: t("en", "Message {name}", { name: short }),
    exact: true,
  });
  const asked = chats.length;
  await box.fill(TASK_LINE);
  await box.press("Enter");
  const started = await poll(
    () => chatLog(walk, id),
    (events) => startedTask(events, START_CALL) !== null,
    30_000,
  );
  const task = startedTask(started, START_CALL);
  if (task === null) {
    const logged = started.map((e) => e.type).join(", ") || "nothing";
    throw new Error(`no task started: the log holds ${logged}`);
  }
  const chat: TaskChatPage = { id, short, log, box, first: task };
  const card = log.locator(`article[data-task="${task}"]`);
  const startAsked = await shows(
    card.getByText(t("en", "Start this task?"), { exact: true }),
    20_000,
  );
  const bar = page.locator(`section[data-waiting="${task}"]`);
  const waitingLine = t("en", "Waiting for your OK to work in {folder}", { folder: site });
  const barShown = await shows(bar.getByText(waitingLine, { exact: true }), 10_000);
  const acked = await shows(log.getByText(TASK_ACK, { exact: true }), 20_000);
  const line = chats.slice(asked).find((request) => lastContent(request) === TASK_LINE);
  // Her line after the call reads what it started, not pipedog's placeholder.
  const after = chats.slice(asked).find((request) => resultFor(request) === START_CALL);
  const read = `{"task": "${task}", "status": "awaiting-approval"}`;
  const waiting = await taskOf(walk, task);
  checks.add(
    "task start",
    greeting !== undefined &&
      taskToolsOf(greeting).length === 0 &&
      !hinted(greeting) &&
      JSON.stringify(taskToolsOf(line)) === '["start_task"]' &&
      hinted(line) &&
      lastContent(after) === read &&
      waiting?.status === "awaiting-approval" &&
      waiting.pending?.kind === "start" &&
      waiting.chat?.id === id &&
      waiting.chat.persona === PERSONA &&
      waiting.model.account === account &&
      waiting.model.model === WORKER_MODEL &&
      startAsked &&
      barShown &&
      acked &&
      workers.length === 0,
    `her greeting was offered ${toolsNamed(greeting)}, ${hinted(greeting) ? "with" : "without"} ` +
      `the hint, and her answer ${toolsNamed(line)}, ${hinted(line) ? "with" : "without"} it; ` +
      `her line after the call read ${quote(lastContent(after))}; the task ` +
      `${String(waiting?.status)} on ${String(waiting?.model.model)}, waiting for ` +
      `${waiting?.pending?.kind ?? "nothing"}, ${waiting?.chat?.id === id ? "in this chat" : "in another chat"}; ` +
      `the card ${startAsked ? "asks" : "doesn't ask"} to start it, the waiting bar ` +
      `${barShown ? "asks too" : "doesn't"}, her line ${acked ? "shows" : "doesn't show"}; the ` +
      `worker took ${workers.length} request(s) before the OK`,
  );

  // Before Allow Once, then while the worker's first request waits, so the task is running.
  const before = (await askHer(walk, chat, WAITING_LINE, WAITING_ACK)).find(
    (request) => lastContent(request) === WAITING_LINE,
  );
  const release = walk.embeddings.holdWorker();
  let startStatus = 0;
  let during: ChatRequest | undefined;
  let running: TaskSnapshot | null = null;
  try {
    const allowed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${origin}/api/local/tasks/${task}/approve`,
    );
    await card.locator('[data-answer="once"]').click();
    startStatus = (await allowed).status();
    await poll(
      async () => workers.length,
      (count) => count > 0,
      20_000,
    );
    running = await taskOf(walk, task);
    during = (await askHer(walk, chat, RUNNING_LINE, RUNNING_ACK)).find(
      (request) => lastContent(request) === RUNNING_LINE,
    );
  } finally {
    release();
  }
  const [waitingBlock, runningBlock] = [statusBlock(before), statusBlock(during)];
  checks.add(
    "task status",
    taskToolsOf(before).length === 4 &&
      waitingBlock.includes(`任务1「`) &&
      waitingBlock.includes(WAITS_TO_START) &&
      waitingBlock.endsWith(TOOLS_TAIL) &&
      running?.status === "running" &&
      taskToolsOf(during).length === 4 &&
      runningBlock.includes(`任务1「`) &&
      runningBlock.includes(RUNS) &&
      !runningBlock.includes("还没开始"),
    `asked before Allow Once, her answer was offered ${toolsNamed(before)}, after ` +
      `${waitingBlock === "" ? "no status block" : quote(waitingBlock, 400)}; asked while the task ` +
      `${String(running?.status)}, ${toolsNamed(during)}, after ` +
      `${runningBlock === "" ? "no status block" : quote(runningBlock, 400)}`,
  );

  const pathAsked = await shows(
    card.getByText(t("en", "Let it read outside its folders?"), { exact: true }),
    30_000,
  );
  const paused = await taskOf(walk, task);
  // What Allow Once grants: notes.txt's whole folder, as it lies on disk.
  const granted = { folder: realpathSync(dirname(notes)) };
  const grantNamed = await shows(
    card.getByText(
      t(
        "en",
        "Allow Once lets this task read everything in {folder} until it ends; Deny tells it it can't.",
        granted,
      ),
      { exact: true },
    ),
    10_000,
  );
  const barNamed = await shows(
    bar.getByText(t("en", "Waiting for your OK to read everything in {folder}", granted), {
      exact: true,
    }),
    10_000,
  );

  const detailed = await askHer(walk, chat, DETAIL_LINE, DETAIL_ACK);
  const asking = detailed.find((request) => lastContent(request) === DETAIL_LINE);
  const checked = detailed.find((request) => resultFor(request) === CHECK_CALL);
  const pausedBlock = statusBlock(asking);
  const detail = parsedResult(checked);
  const pending = paused?.pending?.kind === "path" ? paused.pending : null;
  const asks = (detail?.card ?? {}) as Record<string, unknown>;
  const latest = (detail?.step ?? {}) as Record<string, unknown>;
  const head = String(latest.head ?? "");
  // The step's head is cut at 120 characters.
  const headed = head !== "" && notes.startsWith(head.replace(/…$/, ""));
  // The path the card asks about is the worker's, which reaches her at tool level alone; her goal
  // names notes.txt, so only the whole path tells.
  const leaked = chats
    .slice(greeted)
    .flatMap((request) =>
      [notes, realpathSync(notes)].flatMap((path) =>
        rolesHolding(request, path).filter((role) => role !== "tool"),
      ),
    );
  checks.add(
    "task check",
    pausedBlock.includes(`任务1「`) &&
      pausedBlock.includes(ASKS_TO_READ) &&
      detail?.task === 1 &&
      detail.status === "paused" &&
      asks.asks === "path" &&
      asks.path === pending?.path &&
      asks.access === "read" &&
      asks.allowGrants === granted.folder &&
      JSON.stringify(detail.written) === '["index.html"]' &&
      latest.tool === "read" &&
      headed &&
      leaked.length === 0,
    `at the path question, her answer came after ` +
      `${pausedBlock === "" ? "no status block" : quote(pausedBlock, 400)}; check_task read her ` +
      `${detail === null ? quote(lastContent(checked), 400) : JSON.stringify(detail)}; the whole ` +
      `notes.txt path ${leaked.length === 0 ? "reached her only at tool level" : `reached her in ${leaked.join(", ")} messages`}`,
  );

  const steering = await askHer(walk, chat, STEER_LINE, STEER_ACK);
  const changing = steering.find((request) => lastContent(request) === STEER_LINE);
  const steered = steering.find((request) => resultFor(request) === STEER_CALL);
  const queuedTask = await taskOf(walk, task);
  const queuedLine = card.locator("[data-queued]").getByText(STEER_TEXT, { exact: true });
  const queuedShown = await shows(queuedLine, 20_000);
  const passed = `${STEER_PREFIX}${STEER_TEXT}`;
  const note =
    '{"task": 1, "status": "paused", "note": "Queued: it waits for the owner\'s answer on its ' +
    'card, and reads this when it goes on."}';
  const resumedAt = workers.length;
  const pathAnswered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === `${origin}/api/local/tasks/${task}/approve`,
  );
  await card.locator('[data-answer="once"]').click();
  const pathStatus = (await pathAnswered).status();
  const unlisted = await card
    .locator("[data-queued]")
    .waitFor({ state: "detached", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  await poll(
    async () => workers.length,
    (count) => count > resumedAt,
    20_000,
  );
  // The worker reads her line first, then the owner's answer.
  const resumed = (workers[resumedAt]?.messages ?? []).map((m) =>
    m.role === "user" ? String(m.content ?? "") : "",
  );
  const herLineAt = resumed.indexOf(passed);
  const answerAt = resumed.findIndex((text) => text.startsWith("The owner allowed read access"));
  checks.add(
    "task steer",
    taskToolsOf(changing).length === 4 &&
      lastContent(steered) === note &&
      JSON.stringify(queuedTask?.inbox?.steer) === JSON.stringify([passed]) &&
      queuedShown &&
      pathStatus === 200 &&
      unlisted &&
      herLineAt >= 0 &&
      answerAt > herLineAt,
    `steer_task read her ${quote(lastContent(steered), 200)}; the task's inbox held ` +
      `${JSON.stringify(queuedTask?.inbox?.steer ?? [])}, which the card ` +
      `${queuedShown ? "listed" : "didn't list"} as her line, ${unlisted ? "until" : "even after"} ` +
      `Allow Once on the path (${pathStatus}); the worker's next request had her line at ` +
      `${herLineAt} and the owner's answer at ${answerAt}`,
  );
  const ended = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    60_000,
  );
  const badge = await shows(card.locator('[data-status="succeeded"]'), 15_000);
  const written = join(site, "index.html");
  const wrote = existsSync(written) && readFileSync(written, "utf8") === INDEX_HTML;
  const kept = savedAssistantFolders(walk.home) === folders;
  const spent = ended?.spentUsd ?? 0;
  const priced = Math.abs(spent - workers.length * WORKER_COST_USD) < 1e-9;
  checks.add(
    "task approvals",
    startStatus === 200 &&
      paused?.status === "paused" &&
      paused.pending?.kind === "path" &&
      paused.pending.access === "read" &&
      paused.pending.path.endsWith("notes.txt") &&
      paused.pending.folder === granted.folder &&
      pathAsked &&
      grantNamed &&
      barNamed &&
      pathStatus === 200 &&
      ended?.status === "succeeded" &&
      badge &&
      wrote &&
      kept &&
      workers.length === 4 &&
      priced,
    `Allow Once at the start answered ${startStatus}; the task then ${String(paused?.status)} ` +
      `for ${paused?.pending?.kind === "path" ? `${paused.pending.access} of ${paused.pending.path}, granting ${String(paused.pending.folder)}` : "nothing"}` +
      `, which the card ${pathAsked ? "asked about" : "never asked about"}, ` +
      `${grantNamed ? "naming" : "without naming"} ${granted.folder} as what Allow Once grants, ` +
      `as the waiting bar ${barNamed ? "did" : "didn't"}; Allow Once answered ` +
      `${pathStatus}; the task ${String(ended?.status)}${ended?.outcome?.status === "failed" ? ` (${ended.outcome.error})` : ""}` +
      ` after ${workers.length} worker request(s), spending $${spent} ` +
      `${priced ? "as reported" : `where ${workers.length * WORKER_COST_USD} was reported`}; the ` +
      `card ${badge ? "shows" : "doesn't show"} it done; index.html ${wrote ? "holds the page" : "is missing or wrong"}; ` +
      `assistant.folders ${kept ? "unchanged" : `changed from ${folders}`}`,
  );

  await card.locator('[data-action="steps"]').click();
  const steps = card.getByRole("log", { name: t("en", "Steps"), exact: true });
  const reportStep = await shows(steps.getByText(WORKER_REPORT), 15_000);
  const step = (state: string, tool: string) =>
    steps.getByRole("button", { name: new RegExp(`^${escapeRegExp(state)}: ${tool}`) }).count();
  const done = t("en", "Done", {}, "tool call");
  const rows = await Promise.all([
    step(done, "write"),
    step(t("en", "Failed"), "read"),
    step(done, "read"),
  ]);
  const told = await shows(
    steps.getByText(/^The owner allowed read access to .*task-notes\. Try again\.$/),
    5_000,
  );
  const herLine = await shows(steps.getByText(passed, { exact: true }), 5_000);
  const finishedAt = t("en", "Finished at {time}", { time: "" });
  const finished = await shows(steps.getByText(new RegExp(`^${escapeRegExp(finishedAt)}`)), 5_000);
  checks.add(
    "task steps",
    JSON.stringify(rows) === "[1,1,1]" && told && herLine && finished && reportStep,
    `Show Steps lists write done, read failed and read done ${JSON.stringify(rows)} times; her ` +
      `line ${herLine ? "shows" : "doesn't show"} as one it was told, and the owner's answer ` +
      `${told ? "does" : "doesn't"}; its report ` +
      `${reportStep ? "shows" : "doesn't show"}, ${finished ? "then" : "without"} its end`,
  );

  const stored = await poll(
    () => chatLog(walk, id),
    (events) => said(events, "persona", TASK_REPORT),
    60_000,
  );
  const final = stored.find(
    (e) => e.type === "tool-result" && e.stage === "final" && e.callId === START_CALL,
  );
  const report = stored.find((e) => e.type === "message" && e.text === TASK_REPORT);
  const reportShown = await shows(log.getByText(TASK_REPORT, { exact: true }), 20_000);
  const files = Array.isArray(final?.result?.files) ? final.result.files.map(String) : [];
  const toldHer = chats.find((request) => asksForReport(request, START_CALL));
  const callResult = toldHer?.messages?.find(
    (m) => m.role === "tool" && m.tool_call_id === START_CALL,
  );
  // The worker's report reaches her only as her call's result, never in a message of a higher rank.
  const quoting = rolesHolding(toldHer, WORKER_REPORT);
  const enveloped = (toldHer?.messages ?? []).some((m) =>
    String(m.content ?? "").startsWith(ASYNC_FINISHED),
  );
  const marked = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.reported === true,
    10_000,
  );
  checks.add(
    "task report",
    final?.result?.status === "succeeded" &&
      final.result.report === WORKER_REPORT &&
      files.some((file) => file.endsWith(`${sep}task-site${sep}index.html`)) &&
      report !== undefined &&
      report.seq > final.seq &&
      toldHer !== undefined &&
      lastContent(toldHer) === endedNudge(START_CALL) &&
      taskToolsOf(toldHer).length === 0 &&
      String(callResult?.content ?? "").includes(WORKER_REPORT) &&
      JSON.stringify(quoting) === '["tool"]' &&
      !enveloped &&
      reportShown &&
      marked?.reported === true,
    `the log stores the call's final ${String(final?.result?.status)} with ` +
      `${files.length} file(s) written, then ${report ? "her report" : "no report from her"}; ` +
      `her report turn ${toldHer ? `was asked for it by ${quote(lastContent(toldHer))}` : "was never asked for it"}, ` +
      `offered ${toolsNamed(toldHer)}, reading the report in ` +
      `${quoting.length > 0 ? quoting.join(" and ") : "no"} message(s)` +
      `${enveloped ? " and a final envelope" : ""}; the page ` +
      `${reportShown ? "shows" : "doesn't show"} her report; the task is ` +
      `${marked?.reported === true ? "marked reported" : "not marked reported"}`,
  );
  return chat;
}

/**
 * A second task in the task's chat, which she starts for the viewer's line and stops on his word
 * before he allowed it: stop_task, the card showing it stopped with no Stop and no waiting bar, her
 * call's final cancelled, and no turn telling of it.
 */
async function stopWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks } = walk;
  const { chats, workers } = walk.embeddings.seen;
  const worked = workers.length;
  const asked = await askHer(walk, chat, TASK2_LINE, TASK2_ACK);
  const line = asked.find((request) => lastContent(request) === TASK2_LINE);
  const task = startedTask(await chatLog(walk, chat.id), START_CALL_2);
  if (task === null) throw new Error("her second start_task call started no task");
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const bar = page.locator(`section[data-waiting="${task}"]`);
  const barShown = await shows(bar, 15_000);

  const stopFrom = chats.length;
  const stopping = await askHer(walk, chat, STOP_LINE, STOP_ACK);
  const stopLine = stopping.find((request) => lastContent(request) === STOP_LINE);
  const stopped = stopping.find((request) => resultFor(request) === STOP_CALL);
  const block = statusBlock(stopLine);
  const ended = await poll(
    () => chatLog(walk, chat.id),
    (events) =>
      events.some(
        (e) => e.type === "tool-result" && e.callId === START_CALL_2 && e.stage === "final",
      ),
    20_000,
  );
  const final = ended.find(
    (e) => e.type === "tool-result" && e.callId === START_CALL_2 && e.stage === "final",
  );
  const ack = ended.find((e) => e.type === "message" && e.text === STOP_ACK);
  const snapshot = await poll(
    () => taskOf(walk, task),
    (read) => read?.reported === true,
    10_000,
  );
  const badge = await shows(card.locator('[data-status="cancelled"]'), 15_000);
  const stopButtons = await card.locator('[data-action="stop"]').count();
  const barGone = await bar
    .waitFor({ state: "detached", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  // Nothing tells a stop: no line of hers after her answer, and no word on its end for her mind.
  await delay(QUIET_MS);
  const after = await chatLog(walk, chat.id);
  const spoke = after.filter(
    (e) => e.type === "message" && e.speaker?.kind === "persona" && e.seq > (ack?.seq ?? 0),
  );
  const nudged = chats.slice(stopFrom).some((request) => nudgeOf(request) !== null);
  checks.add(
    "task stop",
    JSON.stringify(taskToolsOf(line)) === '["start_task"]' &&
      taskToolsOf(stopLine).length === 4 &&
      block.includes(`任务2「`) &&
      block.includes(WAITS_TO_START) &&
      !block.includes(`任务1「`) &&
      lastContent(stopped) === '{"task": 2, "status": "cancelled", "written": 0}' &&
      snapshot?.status === "cancelled" &&
      snapshot.denied !== true &&
      final?.result?.status === "cancelled" &&
      ack !== undefined &&
      final.seq > ack.seq &&
      spoke.length === 0 &&
      !nudged &&
      barShown &&
      badge &&
      stopButtons === 0 &&
      barGone &&
      workers.length === worked,
    `her answer to the second task's line was offered ${toolsNamed(line)}, and to the stop ` +
      `${toolsNamed(stopLine)}, after ${block === "" ? "no status block" : quote(block, 400)}; ` +
      `stop_task read her ${quote(lastContent(stopped), 120)}; the task ` +
      `${String(snapshot?.status)}${snapshot?.denied ? ", denied" : ""}, its final ` +
      `${String(final?.result?.status)} ${final !== undefined && ack !== undefined && final.seq > ack.seq ? "after" : "not after"} ` +
      `her answer, then ${spoke.length} line(s) of hers and ${nudged ? "a" : "no"} word on it; ` +
      `the waiting bar ${barShown ? (barGone ? "showed, then went" : "stayed") : "never showed"}, ` +
      `the card ${badge ? "shows it stopped" : "doesn't show it stopped"} with ${stopButtons} ` +
      `Stop button(s); the worker took ${workers.length - worked} request(s) for it`,
  );
}

type Display = keyof typeof DISPLAY_TOLD;

/** What typing a display command into the task's chat did. */
interface DisplayTyped {
  /** Its PATCH's status. */
  readonly status: number;
  /** Whether the page said the display is on. */
  readonly told: boolean;
  /** The events the log gained. */
  readonly added: readonly LoggedEvent[];
  /** The requests her mind took meanwhile. */
  readonly minded: number;
}

/** Types `/<display>` into the task's chat, and waits for the event it stores. */
async function typeDisplay(
  walk: Walk,
  chat: TaskChatPage,
  display: Display,
): Promise<DisplayTyped> {
  const { page, origin } = walk;
  const { chats } = walk.embeddings.seen;
  const before = (await chatLog(walk, chat.id)).length;
  const minded = chats.length;
  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url() === `${origin}/api/local/chats/${chat.id}`,
  );
  await chat.box.fill(`/${display}`);
  await chat.box.press("Enter");
  const status = (await patched).status();
  const told = await shows(page.getByText(t("en", DISPLAY_TOLD[display]), { exact: true }), 10_000);
  const events = await poll(
    () => chatLog(walk, chat.id),
    (read) => read.length > before,
    10_000,
  );
  return { status, told, added: events.slice(before), minded: chats.length - minded };
}

/** Whether typing `/<display>` stored that one settings event alone, asking her nothing. */
function setsOnly(typed: DisplayTyped, display: Display): boolean {
  const [event] = typed.added;
  return (
    typed.status === 200 &&
    typed.told &&
    typed.added.length === 1 &&
    event?.type === "settings" &&
    event.display === display &&
    typed.minded === 0
  );
}

/** What typing `/<display>` did, as a check's detail says it. */
function typedText(typed: DisplayTyped, display: Display): string {
  const stored = typed.added.map((e) =>
    e.type === "settings" ? `settings ${String(e.display)}` : e.type,
  );
  return (
    `/${display} answered ${typed.status}, ${typed.told ? "with" : "without"} its toast, storing ` +
    `${JSON.stringify(stored)} and asking her mind ${typed.minded} time(s)`
  );
}

/** Whether `first`'s element comes before `then`'s in the page; false while either is missing. */
async function precedes(first: Locator, then: Locator): Promise<boolean> {
  if ((await first.count()) === 0 || (await then.count()) === 0) return false;
  const after = await then.first().elementHandle();
  if (after === null) return false;
  return first
    .first()
    .evaluate(
      (node, other) =>
        (node.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      after,
    );
}

/**
 * How much of her tasks the task's chat shows, set by the composer's commands, none of which
 * reaches her: /verbose; a third task she starts with words before her call, which show as her
 * line above its card, its steps closed while it waits; /focus, which hides every card but not her
 * words, the waiting bar or her status block; Allow Once there and /verbose, which opens its steps
 * live while it runs; /stop's dialog, Cancel, then its Stop; /stop with nothing left; /foo and
 * /stop 2 refused; then /focus, for the Tasks list's row to bring its card back.
 */
async function displayWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, workers } = walk.embeddings.seen;

  const verbose = await typeDisplay(walk, chat, "verbose");
  checks.add("display verbose", setsOnly(verbose, "verbose"), typedText(verbose, "verbose"));

  const asked = await askHer(walk, chat, TASK3_LINE, TASK3_ACK);
  const started = await chatLog(walk, chat.id);
  const task = startedTask(started, START_CALL_3);
  if (task === null) throw new Error("her third start_task call started no task");
  const call = started.find((e) => e.type === "tool-call" && e.callId === START_CALL_3);
  const glued = started.some((e) => e.type === "message" && e.text?.includes(TASK3_SAID));
  const after = asked.find((request) => resultFor(request) === START_CALL_3);
  const read = `{"task": "${task}", "status": "awaiting-approval"}`;
  // Her next round reads her words on her call, and ends on its result.
  const onCall = after?.messages?.find((m) =>
    (m.tool_calls ?? []).some((each) => each.id === START_CALL_3),
  );
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const steps = card.locator('[data-action="steps"]');
  const saidLine = chat.log.getByText(TASK3_SAID, { exact: true });
  const carded = await shows(card, 15_000);
  const lines = await saidLine.count();
  const above = carded && (await precedes(saidLine, card));
  const below = carded && (await precedes(card, chat.log.getByText(TASK3_ACK, { exact: true })));
  const waitingSteps = carded ? await steps.getAttribute("aria-expanded") : null;
  checks.add(
    "display said",
    call?.said === TASK3_SAID &&
      !glued &&
      onCall?.content === TASK3_SAID &&
      lastContent(after) === read &&
      lines === 1 &&
      above &&
      below &&
      waitingSteps === "false",
    `her call ${call?.said === undefined ? "carries no said" : `carries said ${quote(call.said)}`}` +
      `${glued ? ", and a message of hers repeats it" : ""}; her next round read it on ` +
      `${onCall === undefined ? "no call message" : `a call message whose content is ${quote(String(onCall.content ?? ""))}`}` +
      ` and ended on ${quote(lastContent(after))}; the page shows it ${lines} time(s), ` +
      `${above ? "above" : "not above"} the card, and her line after it ${below ? "below" : "not below"}; ` +
      `the waiting card's steps are ${waitingSteps === "false" ? "closed" : `aria-expanded=${String(waitingSteps)}`}`,
  );

  const focus = await typeDisplay(walk, chat, "focus");
  const cards = chat.log.locator("article[data-task]");
  const left = await poll(
    () => cards.count(),
    (count) => count === 0,
    10_000,
  );
  const saidKept = await shows(saidLine, 5_000);
  const bar = page.locator(`section[data-waiting="${task}"]`);
  const barKept = await shows(bar, 10_000);
  // Her status block is the same in every display, and this one stays in her view after the stop,
  // for the call's seed to leave out.
  const asking = (await askHer(walk, chat, FOCUS_LINE, FOCUS_ACK)).find(
    (request) => lastContent(request) === FOCUS_LINE,
  );
  const block = statusBlock(asking);
  const nth = tasksStarted(started).indexOf(task) + 1;
  checks.add(
    "display focus",
    setsOnly(focus, "focus") &&
      left === 0 &&
      saidKept &&
      barKept &&
      block.includes(`任务${nth}「`) &&
      block.includes(WAITS_TO_START),
    `${typedText(focus, "focus")}; ${left} card(s) left in the log, her words before her call ` +
      `${saidKept ? "still shown" : "gone"}, the waiting bar ${barKept ? "still up" : "gone"}; ` +
      `asked after it, she answered after ${block === "" ? "no status block" : quote(block, 400)}`,
  );

  const worked = workers.length;
  const dialog = page.getByRole("alertdialog");
  const release = walk.embeddings.holdWorker();
  let allowStatus = 0;
  let running: TaskSnapshot | null = null;
  let barGone = false;
  let again: DisplayTyped | null = null;
  let opened: string | null = null;
  let stepsLog = false;
  let others: (string | null)[] = [];
  let quiet = false;
  let asks = false;
  let rows: (string | null)[] = [];
  let cancelClosed = false;
  let kept: TaskSnapshot | null = null;
  let stopStatus = 0;
  let stopClosed = false;
  /** The log's last seq as Stop was pressed. */
  let stoppedAfter = 0;
  const stopFrom = chats.length;
  try {
    const allowed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url() === `${origin}/api/local/tasks/${task}/approve`,
    );
    await bar.locator('[data-answer="once"]').click();
    allowStatus = (await allowed).status();
    await poll(
      async () => workers.length,
      (count) => count > worked,
      20_000,
    );
    running = await taskOf(walk, task);
    barGone = await bar
      .waitFor({ state: "detached", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const minded = chats.length;
    again = await typeDisplay(walk, chat, "verbose");
    opened = await poll(
      () => steps.getAttribute("aria-expanded").catch(() => null),
      (expanded) => expanded === "true",
      10_000,
    );
    stepsLog = await shows(card.getByRole("log", { name: t("en", "Steps"), exact: true }), 10_000);
    others = await chat.log
      .locator(`article[data-task]:not([data-task="${task}"]) [data-action="steps"]`)
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-expanded")));
    quiet = chats.length === minded;

    await chat.box.fill("/stop");
    await chat.box.press("Enter");
    asks = await shows(dialog.getByText(t("en", "Stop this task?"), { exact: true }), 10_000);
    rows = await dialog
      .locator("li[data-stop]")
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-stop")));
    await dialog.getByRole("button", { name: t("en", "Cancel"), exact: true }).click();
    cancelClosed = await dialog
      .waitFor({ state: "hidden", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    kept = await taskOf(walk, task);

    await chat.box.fill("/stop");
    await chat.box.press("Enter");
    const row = dialog.locator(`li[data-stop="${task}"]`);
    await row.waitFor({ timeout: 10_000 });
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url() === `${origin}/api/local/tasks/${task}`,
    );
    stoppedAfter = (await chatLog(walk, chat.id)).at(-1)?.seq ?? 0;
    await row.getByRole("button", { name: t("en", "Stop"), exact: true }).click();
    stopStatus = (await deleted).status();
    stopClosed = await dialog
      .waitFor({ state: "hidden", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
  } finally {
    release();
  }
  checks.add(
    "display steps",
    allowStatus === 200 &&
      running?.status === "running" &&
      barGone &&
      again !== null &&
      setsOnly(again, "verbose") &&
      opened === "true" &&
      stepsLog &&
      others.length > 0 &&
      others.every((expanded) => expanded === "false") &&
      quiet,
    `Allow Once on the waiting bar answered ${allowStatus}, and the task ` +
      `${String(running?.status)} with the bar ${barGone ? "gone" : "still up"}; ` +
      `${again === null ? "/verbose never ran" : typedText(again, "verbose")}; its card's steps ` +
      `${opened === "true" ? "opened" : "stayed closed"}${stepsLog ? ", following its steps" : ""}, ` +
      `the other cards' steps ${JSON.stringify(others)}; her mind took ` +
      `${quiet ? "no request" : "requests"} while it ran`,
  );

  const stopped = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.status === "cancelled" && snapshot.reported === true,
    15_000,
  );
  // A stop the owner made is told by no one.
  await delay(QUIET_MS);
  const ended = await chatLog(walk, chat.id);
  const spoke = ended.filter(
    (e) => e.type === "message" && e.speaker?.kind === "persona" && e.seq > stoppedAfter,
  );
  const final = ended.find(
    (e) => e.type === "tool-result" && e.callId === START_CALL_3 && e.stage === "final",
  );
  const shownEnded = await steps.getAttribute("aria-expanded").catch(() => null);
  checks.add(
    "display stop",
    asks &&
      JSON.stringify(rows) === JSON.stringify([task]) &&
      cancelClosed &&
      kept?.status === "running" &&
      stopStatus === 200 &&
      stopClosed &&
      stopped?.status === "cancelled" &&
      final?.result?.status === "cancelled" &&
      spoke.length === 0 &&
      chats.length === stopFrom &&
      shownEnded === "true",
    `/stop ${asks ? "asked to stop this task" : "never asked"}, listing ${JSON.stringify(rows)}; ` +
      `Cancel ${cancelClosed ? "closed it" : "didn't close it"}, the task then ` +
      `${String(kept?.status)}; the second /stop's Stop answered ${stopStatus} and ` +
      `${stopClosed ? "closed" : "didn't close"} the dialog; the task ${String(stopped?.status)}, ` +
      `its final ${String(final?.result?.status)}, then ${spoke.length} line(s) of hers and ` +
      `${chats.length - stopFrom} mind request(s); its card's steps ` +
      `${shownEnded === "true" ? "still shown" : `aria-expanded=${String(shownEnded)}`} once it ended`,
  );

  const before = ended.length;
  const minded = chats.length;
  await chat.box.fill("/stop");
  await chat.box.press("Enter");
  const nothing = await shows(page.getByText(t("en", "Nothing to stop"), { exact: true }), 10_000);
  await chat.box.fill("/foo");
  await chat.box.press("Enter");
  const unknown = await shows(
    page.getByText(t("en", "{command} isn't a command", { command: "/foo" }), { exact: true }),
    10_000,
  );
  const fooKept = await chat.box.inputValue();
  await chat.box.fill("/stop 2");
  await chat.box.press("Enter");
  const trailing = await shows(
    page.getByText(t("en", "{command} takes nothing after it", { command: "/stop" }), {
      exact: true,
    }),
    10_000,
  );
  const stopKept = await chat.box.inputValue();
  await delay(QUIET_MS);
  const added = (await chatLog(walk, chat.id)).length - before;
  const dialogs = await dialog.count();
  const requested = chats.length - minded;
  await chat.box.fill("");
  const refocus = await typeDisplay(walk, chat, "focus");
  checks.add(
    "display commands",
    nothing &&
      unknown &&
      fooKept === "/foo" &&
      trailing &&
      stopKept === "/stop 2" &&
      added === 0 &&
      dialogs === 0 &&
      requested === 0 &&
      setsOnly(refocus, "focus"),
    `/stop with nothing live ${nothing ? "said so" : "said nothing"}; /foo ` +
      `${unknown ? "was refused" : "wasn't refused"}, the draft reading ${quote(fooKept)}; /stop 2 ` +
      `${trailing ? "was refused" : "wasn't refused"}, the draft reading ${quote(stopKept)}; the ` +
      `log gained ${added} event(s), ${dialogs} dialog(s) opened and her mind took ${requested} ` +
      `request(s); then ${typedText(refocus, "focus")}`,
  );
}

/**
 * The read-only Tasks list: the first task done and the second stopped, with no button or field,
 * and the first's row opening the chat at its card.
 */
async function taskList(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin } = walk;
  const { id, first: task } = chat;
  await page.locator('nav a[href="/tasks"]').first().click();
  await page.waitForURL(`${origin}/tasks`);
  const list = page.getByRole("list", { name: t("en", "Tasks"), exact: true });
  const row = list.getByRole("listitem").filter({ hasText: TASK_GOAL });
  const listedDone = await shows(row.locator('[data-status="succeeded"]'), 15_000);
  const stoppedRow = list.getByRole("listitem").filter({ hasText: TASK2_GOAL });
  const listedStopped = await shows(stoppedRow.locator('[data-status="cancelled"]'), 15_000);
  const buttons = await list.getByRole("button").count();
  const fields = await page.getByRole("main").getByRole("textbox").count();
  const link = row.locator(`a[href="/chats/${id}?task=${task}"]`);
  const linked = (await link.count()) === 1;
  if (linked) await link.click();
  const opened =
    linked &&
    (await waitFor(() => new URL(page.url()).pathname === `/chats/${id}`, 10_000)) !== null;
  const back = page.locator(`article[data-task="${task}"]`);
  const inView =
    opened &&
    (await waitFor(
      () =>
        back
          .evaluate((element) => {
            const box = element.getBoundingClientRect();
            return box.top >= 0 && box.bottom <= window.innerHeight;
          })
          .catch(() => false),
      10_000,
    )) !== null;
  const settled =
    opened && (await waitFor(() => new URL(page.url()).search === "", 10_000)) !== null;
  checks.add(
    "task list",
    listedDone &&
      listedStopped &&
      buttons === 0 &&
      fields === 0 &&
      linked &&
      opened &&
      inView &&
      settled,
    `the Tasks list ${listedDone ? "shows" : "doesn't show"} the first task done and ` +
      `${listedStopped ? "shows" : "doesn't show"} the second stopped, with ${buttons} ` +
      `button(s) and ${fields} field(s); the first's row ${linked ? "links" : "doesn't link"} to ` +
      `the chat at the card, which ${opened ? (inView ? "opened in view" : "opened out of view") : "never opened"}` +
      `${settled ? "" : ", ?task= still in the address"}`,
  );
}

/**
 * The task's chat in focus, opened from the Tasks list's row: that row's card alone shows, the one
 * brought into view; then /normal brings every card back, for the call after it.
 */
async function revealWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const cards = chat.log.locator("article[data-task]");
  const shown = () =>
    cards.evaluateAll((articles) => articles.map((article) => article.getAttribute("data-task")));
  const focused = await shown();
  const all = tasksStarted(await chatLog(walk, chat.id));
  const normal = await typeDisplay(walk, chat, "normal");
  const back = await poll(shown, (tasks) => tasks.length === all.length, 10_000);
  walk.checks.add(
    "display reveal",
    JSON.stringify(focused) === JSON.stringify([chat.first]) &&
      setsOnly(normal, "normal") &&
      JSON.stringify(back) === JSON.stringify(all),
    `in focus, the Tasks list's row left ${JSON.stringify(focused)} shown of ` +
      `${JSON.stringify(all)}, its own being ${chat.first}; ${typedText(normal, "normal")}, ` +
      `showing ${JSON.stringify(back)}`,
  );
}

/** The events of a call's span in a chat's log, as a check compares them. */
function callShape(events: readonly LoggedEvent[]): string[] {
  return events.flatMap((e) => {
    if (e.type === "message") return [`${e.speaker?.kind}: ${e.text}`];
    if (e.type === "tool-call") return [`call ${e.callId}`];
    if (e.type === "tool-result") return [`${e.stage ?? "result"} ${e.callId}`];
    if (e.type !== "call-ended") return [];
    return [e.told === undefined ? "call-ended" : `call-ended told ${e.told.join(" ")}`];
  });
}

/**
 * A call in the task's chat, every role at the fake server, with her model, so it opens on the video
 * screen: it opens without the status block the chat stored; the fake hearing hears the viewer ask
 * for a task, which she starts, her call and its started result stored in the chat between their
 * lines; Allow Once on the waiting bar, inside the screen; at the task's pause, Show Task, which
 * docks the call and focuses the card, the bar above the dock; her pointer to the card and her word
 * on the task's end, both on the call; Hang Up, whose call-ended names the end as told, after which
 * no text turn tells it again; and its row in the Tasks list.
 */
async function callTaskWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, listening, workers } = walk.embeddings.seen;
  const { call: folder, notes } = walk.embeddings.places;
  // Nobody speaks on this call but the fake hearing.
  writeFileSync(walk.mic, silentWav(2));
  // Her model, set here so a video walk that failed leaves nothing to trip on, and a load so that
  // GET personas names it.
  await configure(walk, PERSONA, { "appearance.model": await fixtureModel(walk) });
  await page.goto(`${origin}/chats/${chat.id}`);
  // To the walk's end, whose later checks read the call's: a throw mid-call must not leave it up.
  try {
    // The block the stop's answer stored, still in her view of the chat.
    const stale = shownBlock(await chatLog(walk, chat.id));
    const [minded, listened, worked] = [chats.length, listening.length, workers.length];
    const logged = walk.serverLog().length;
    await page.getByRole("button", { name: t("en", "Call"), exact: true }).click();
    // The screen, then the dock once Show Task docks the call.
    const region = page.getByRole("region", {
      name: t("en", "Call with {name}", { name: chat.short }),
      exact: true,
    });
    if (!(await shows(region, 10_000))) throw new Error("the call's screen never showed");
    const greeted = await poll(
      () => chatLog(walk, chat.id),
      (events) => saidOnCall(events, "persona", CALL_TASK_GREETING),
      60_000,
    );
    if (!saidOnCall(greeted, "persona", CALL_TASK_GREETING)) {
      throw new Error(
        `her greeting on the call was never stored, after ${chats.length - minded} mind request(s)`,
      );
    }
    const opened = greeted.findLast((e) => e.type === "call-started");
    const greeting = chats
      .slice(minded)
      .find((request) => lastContent(request).startsWith(GREETING_KICKOFF));
    checks.add(
      "task call greeting",
      stale !== undefined &&
        greeting !== undefined &&
        statusBlocks(greeting).length === 0 &&
        taskToolsOf(greeting).length === 0 &&
        !hinted(greeting),
      `the chat ${stale === undefined ? "had no status block in her view" : `had ${quote(stale.content ?? "", 120)} in her view`}; ` +
        `her greeting on the call ` +
        (greeting === undefined
          ? "was never asked for"
          : `was asked for with ${statusBlocks(greeting).length} status block(s), offered ` +
            `${toolsNamed(greeting)}, ${hinted(greeting) ? "with" : "without"} the hint`),
    );

    const sessions = await poll(
      async () => listening.slice(listened),
      (opening) => opening.length > 0,
      10_000,
    );
    const ear = sessions[0];
    if (ear === undefined) throw new Error("her hearing opened no session on the call");
    const asked = chats.length;
    ear.say(CALL_TASK_LINE);
    const started = await poll(
      () => chatLog(walk, chat.id),
      (events) =>
        startedTask(events, CALL_TASK_CALL) !== null &&
        saidOnCall(events, "persona", CALL_TASK_ACK),
      60_000,
    );
    const task = startedTask(started, CALL_TASK_CALL);
    if (task === null || !saidOnCall(started, "persona", CALL_TASK_ACK)) {
      const minds = chats.slice(asked).map((request) => quote(lastContent(request), 40));
      throw new Error(
        `the line heard on the call ${task === null ? "started no task" : "got no answer"}: her ` +
          `mind was asked ${minds.join(", ") || "nothing"}`,
      );
    }
    const line = chats.slice(asked).find((request) => lastContent(request) === CALL_TASK_LINE);
    const after = chats.slice(asked).find((request) => resultFor(request) === CALL_TASK_CALL);
    const read = `{"task": "${task}", "status": "awaiting-approval"}`;
    const call = started.find((e) => e.type === "tool-call" && e.callId === CALL_TASK_CALL);
    const result = started.find(
      (e) => e.type === "tool-result" && e.callId === CALL_TASK_CALL && e.stage === "started",
    );
    const card = chat.log.locator(`article[data-task="${task}"]`);
    const startAsked = await shows(
      card.getByText(t("en", "Start this task?"), { exact: true }),
      20_000,
    );
    const bar = page.locator(`section[data-waiting="${task}"]`);
    const barShown = await shows(
      bar.getByText(t("en", "Waiting for your OK to work in {folder}", { folder }), {
        exact: true,
      }),
      15_000,
    );
    // In the screen her model fills, not in the log the screen covers.
    const inside =
      (await page.locator(`[data-call-screen] section[data-waiting="${task}"]`).count()) === 1;
    const waiting = await taskOf(walk, task);
    checks.add(
      "task call start",
      JSON.stringify(taskToolsOf(line)) === '["start_task"]' &&
        hinted(line) &&
        lastContent(after) === read &&
        call?.persona === PERSONA &&
        call.turn === opened?.call &&
        call.name === "start_task" &&
        JSON.stringify(call.arguments) === JSON.stringify({ goal: CALL_TASK_GOAL, folder }) &&
        JSON.stringify(result?.result) === JSON.stringify({ task, status: "awaiting-approval" }) &&
        waiting?.status === "awaiting-approval" &&
        waiting.chat?.call === CALL_TASK_CALL &&
        startAsked &&
        barShown &&
        inside,
      `her answer to the line heard on the call was offered ${toolsNamed(line)}, ` +
        `${hinted(line) ? "with" : "without"} the hint, and her next round read ` +
        `${quote(lastContent(after))}; the chat stores her call ` +
        `${call === undefined ? "nowhere" : `under turn ${call.turn === opened?.call ? "the call's id" : String(call.turn)} with ${JSON.stringify(call.arguments)}`}` +
        ` and its started result ${JSON.stringify(result?.result ?? null)}; the task ` +
        `${String(waiting?.status)}; the card ${startAsked ? "asks" : "doesn't ask"} to start it, ` +
        `the waiting bar ${barShown ? (inside ? "too, inside the video screen" : "too, but not inside the video screen") : "doesn't"}`,
    );

    const approved = () =>
      page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url() === `${origin}/api/local/tasks/${task}/approve`,
      );
    let answer = approved();
    await bar.locator('[data-answer="once"]').click();
    const startStatus = (await answer).status();
    const paused = await poll(
      () => chatLog(walk, chat.id),
      (events) => saidOnCall(events, "persona", CALL_WAIT_LINE),
      60_000,
    );
    const pointed = chats.slice(asked).find((request) => {
      const nudge = nudgeOf(request);
      return nudge?.callId === CALL_TASK_CALL && !nudge.ended;
    });
    const block = statusBlocks(pointed)[0] ?? "";
    // Her task's number there, the earlier walks' tasks counted.
    const nth = tasksStarted(started).indexOf(task) + 1;
    const pausedTask = await taskOf(walk, task);
    const granted = { folder: realpathSync(dirname(notes)) };
    const barAsks = await shows(
      bar.getByText(t("en", "Waiting for your OK to read everything in {folder}", granted), {
        exact: true,
      }),
      15_000,
    );
    // Show Task docks the call first: the log under the screen can't take the focus.
    await bar.getByRole("button", { name: t("en", "Show Task"), exact: true }).click();
    const docked = await page
      .locator("[data-call-screen]")
      .waitFor({ state: "detached", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    const expandable = await shows(
      region.getByRole("button", { name: t("en", "Expand"), exact: true }),
      10_000,
    );
    const cardFocused = await poll(
      () => card.evaluate((el) => el === document.activeElement).catch(() => false),
      (focused) => focused,
      5_000,
    );
    const [barBox, dockBox] = [await bar.boundingBox(), await region.boundingBox()];
    const above = barBox !== null && dockBox !== null && barBox.y + barBox.height <= dockBox.y;
    checks.add(
      "task call pause",
      startStatus === 200 &&
        saidOnCall(paused, "persona", CALL_WAIT_LINE) &&
        lastContent(pointed) === waitingNudge(CALL_TASK_CALL) &&
        taskToolsOf(pointed).length === 0 &&
        block.includes(`任务${nth}「`) &&
        block.includes(ASKS_TO_READ) &&
        block.endsWith(NO_TOOLS_TAIL) &&
        pausedTask?.status === "paused" &&
        pausedTask.pending?.kind === "path" &&
        barAsks &&
        docked &&
        expandable &&
        cardFocused &&
        above,
      `Allow Once on the waiting bar answered ${startStatus}; the task then ` +
        `${String(pausedTask?.status)} for ${pausedTask?.pending?.kind ?? "nothing"}, and her ` +
        `follow-up ${pointed === undefined ? "never came" : `answered ${quote(lastContent(pointed), 200)}, offered ${toolsNamed(pointed)}, with ${block === "" ? "no status block" : quote(block, 400)}`}; ` +
        `her line ${saidOnCall(paused, "persona", CALL_WAIT_LINE) ? "is" : "isn't"} stored; the ` +
        `waiting bar ${barAsks ? "asks" : "doesn't ask"} about the path; Show Task ` +
        `${docked ? "docked the call" : "left the screen up"}, ${expandable ? "with" : "WITHOUT"} ` +
        `Expand in the dock, the card ${cardFocused ? "focused" : "NOT focused"}, the bar ` +
        `${above ? "above the dock" : "not above the dock"}`,
    );

    answer = approved();
    await bar.locator('[data-answer="once"]').click();
    const pathStatus = (await answer).status();
    const reported = await poll(
      () => chatLog(walk, chat.id),
      (events) => saidOnCall(events, "persona", CALL_REPORT_LINE),
      60_000,
    );
    const toldOn = chats.slice(asked).find((request) => {
      const nudge = nudgeOf(request);
      return nudge?.callId === CALL_TASK_CALL && nudge.ended;
    });
    // The worker's report reaches her only as her call's result, never in a message of a higher rank.
    const quoting = rolesHolding(toldOn, CALL_WORKER_REPORT);
    const holder = toldOn?.messages?.find((m) =>
      String(m.content ?? "").includes(CALL_WORKER_REPORT),
    );
    const enveloped = (toldOn?.messages ?? []).some((m) =>
      String(m.content ?? "").startsWith(ASYNC_FINISHED),
    );
    checks.add(
      "task call report",
      pathStatus === 200 &&
        saidOnCall(reported, "persona", CALL_REPORT_LINE) &&
        lastContent(toldOn) === endedNudge(CALL_TASK_CALL) &&
        taskToolsOf(toldOn).length === 0 &&
        JSON.stringify(quoting) === '["tool"]' &&
        holder?.tool_call_id === CALL_TASK_CALL &&
        !enveloped,
      `Allow Once on the path answered ${pathStatus}; her follow-up ` +
        `${toldOn === undefined ? "never came" : `answered ${quote(lastContent(toldOn), 200)}, offered ${toolsNamed(toldOn)}`}, ` +
        `reading the worker's report in ${quoting.length > 0 ? quoting.join(" and ") : "no"} ` +
        `message(s)${holder?.tool_call_id === CALL_TASK_CALL ? ", her call's result" : ""}` +
        `${enveloped ? " and a final envelope" : ""}; her word on it ` +
        `${saidOnCall(reported, "persona", CALL_REPORT_LINE) ? "is" : "isn't"} stored`,
    );

    const hungUp = chats.length;
    await region.getByRole("button", { name: t("en", "Hang Up"), exact: true }).click();
    await poll(
      () => chatLog(walk, chat.id),
      (events) => events.some((e) => e.type === "call-ended" && e.call === opened?.call),
      20_000,
    );
    // Told on the call, so no text turn tells it again.
    await delay(QUIET_MS);
    const events = await chatLog(walk, chat.id);
    const from = events.findIndex((e) => e.type === "call-started" && e.call === opened?.call);
    const shape = callShape(events.slice(from + 1));
    const expected = [
      `persona: ${CALL_TASK_GREETING}`,
      `user: ${CALL_TASK_LINE}`,
      `call ${CALL_TASK_CALL}`,
      `started ${CALL_TASK_CALL}`,
      `persona: ${CALL_TASK_ACK}`,
      `persona: ${CALL_WAIT_LINE}`,
      `final ${CALL_TASK_CALL}`,
      `persona: ${CALL_REPORT_LINE}`,
      `call-ended told ${CALL_TASK_CALL}`,
    ];
    const nudges = chats.slice(asked).flatMap((request) => {
      const nudge = nudgeOf(request);
      return nudge?.callId === CALL_TASK_CALL ? [nudge.ended ? "ended" : "waits"] : [];
    });
    const retold = chats.slice(hungUp).some((request) => nudgeOf(request) !== null);
    const final = events.find(
      (e) => e.type === "tool-result" && e.callId === CALL_TASK_CALL && e.stage === "final",
    );
    const done = await poll(
      () => taskOf(walk, task),
      (snapshot) => snapshot?.reported === true,
      10_000,
    );
    const badge = await shows(card.locator('[data-status="succeeded"]'), 15_000);
    const written = join(folder, "index.html");
    const wrote = existsSync(written) && readFileSync(written, "utf8") === INDEX_HTML;
    const errors = walk
      .serverLog()
      .slice(logged)
      .split("\n")
      .filter((entry) => /\| (ERROR|CRITICAL) +\|/.test(entry));
    await page.locator('nav a[href="/tasks"]').first().click();
    await page.waitForURL(`${origin}/tasks`);
    const row = page
      .getByRole("list", { name: t("en", "Tasks"), exact: true })
      .getByRole("listitem")
      .filter({ hasText: CALL_TASK_GOAL });
    const listed = await shows(row.locator('[data-status="succeeded"]'), 15_000);
    checks.add(
      "task call end",
      JSON.stringify(shape) === JSON.stringify(expected) &&
        JSON.stringify(nudges) === '["waits","ended"]' &&
        !retold &&
        final?.result?.status === "succeeded" &&
        final.result.report === CALL_WORKER_REPORT &&
        done?.status === "succeeded" &&
        done.reported === true &&
        badge &&
        wrote &&
        workers.length - worked === 4 &&
        errors.length === 0 &&
        listed,
      `the call's span in the log holds ${JSON.stringify(shape)}; her mind was nudged about the ` +
        `task ${JSON.stringify(nudges)} on the call and ${retold ? "again" : "never"} after Hang Up; ` +
        `the task ${String(done?.status)}${done?.reported === true ? ", reported" : ", not reported"}, ` +
        `after ${workers.length - worked} worker request(s); the card ` +
        `${badge ? "shows" : "doesn't show"} it done; index.html ${wrote ? "holds the page" : "is missing or wrong"}; ` +
        `the server logged ${errors.length === 0 ? "no errors" : errors.slice(0, 2).join(" ")}; ` +
        `the Tasks list ${listed ? "shows" : "doesn't show"} it done`,
    );
  } finally {
    await hangUpIfUp(walk);
    await configure(walk, PERSONA, { "appearance.model": null });
  }
}

/** The fields her start_task's schema requires in `request`, as JSON. */
function startRequires(request: ChatRequest | undefined): string {
  const tool = (request?.tools ?? []).find((each) => each.function?.name === "start_task");
  return JSON.stringify(tool?.function?.parameters?.required ?? null);
}

/** The tool results `requests` carried, each once, in the order they came. */
function toolResults(requests: readonly ChatRequest[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];
  for (const request of requests) {
    for (const message of request.messages ?? []) {
      const id = String(message.tool_call_id ?? "");
      if (message.role !== "tool" || seen.has(id)) continue;
      seen.add(id);
      results.push(String(message.content ?? ""));
    }
  }
  return results;
}

function textOf(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Whether process `pid` still runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid the fake MCP server last wrote to `path`; null before it started. */
function serverPid(path: string): number | null {
  try {
    const [pid] = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Answers what task `task` asks, once its pending is one `asks` takes, with its card's `answer`:
 * the approve's status, and the question answered. The card can still show the question before
 * for a poll's length, and an answer to that one is refused 409 and changes nothing, so the click
 * is made again.
 */
async function answerCard(
  walk: Walk,
  card: Locator,
  task: string,
  answer: TaskApproveRequest["answer"],
  asks: (pending: TaskPending) => boolean,
): Promise<{ readonly status: number; readonly pending: TaskPending | null }> {
  const asking = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending !== undefined && asks(snapshot.pending),
    60_000,
  );
  const pending = asking?.pending !== undefined && asks(asking.pending) ? asking.pending : null;
  if (pending === null) return { status: 0, pending };
  const url = `${walk.origin}/api/local/tasks/${task}/approve`;
  let status = 0;
  for (let attempt = 0; attempt < 5 && status !== 200; attempt++) {
    if (attempt > 0) await delay(1000);
    const answered = walk.page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url() === url,
    );
    await card.locator(`[data-answer="${answer}"]`).click();
    status = (await answered).status();
  }
  return { status, pending };
}

/**
 * Settings' Models by Kind: a model for coding tasks alone, on the assistant's account, which the
 * provider beside it follows.
 */
async function kindsWalk(walk: Walk): Promise<void> {
  const { page, checks, origin } = walk;
  await page.goto(`${origin}/settings?tab=assistant`);
  const label = t("en", "Coding Task Model");
  // As the assistant's model field: plain text until the account's list arrives.
  const picker = page.getByRole("combobox", { name: label, exact: true });
  const listed = await shows(picker, 15_000);
  const field = listed ? picker : page.getByLabel(label, { exact: true });
  if (listed) {
    await picker.click();
    await page.getByPlaceholder(t("en", "Search models")).fill(CODING_MODEL);
    await page
      .getByRole("option", { name: t("en", "Use “{model}”", { model: CODING_MODEL }), exact: true })
      .click();
  } else {
    await field.fill(CODING_MODEL);
  }
  const saved = page.waitForResponse(isPut(`${origin}/api/local/settings`));
  await page
    .locator("form", { has: field })
    .getByRole("button", { name: t("en", "Save"), exact: true })
    .click();
  const status = (await saved).status();
  const yaml = parseYaml(readFileSync(join(walk.home, "settings.yaml"), "utf8")) as {
    assistant?: { coding?: { provider?: unknown; model?: unknown } };
  };
  const coding = yaml.assistant?.coding;
  const { assistant } = (await (await walk.api("GET", "/api/local/status")).json()) as Status;
  checks.add(
    "task kinds",
    status === 200 &&
      coding?.model === CODING_MODEL &&
      coding.provider === undefined &&
      assistant.kinds.coding === null,
    `Models by Kind saved ${status}; settings.yaml runs coding tasks on ` +
      `${String(coding?.model)}, ${coding?.provider === undefined ? "on the assistant's account" : `on ${String(coding.provider)}`}; ` +
      `status says ${assistant.kinds.coding === null ? "they can" : `they fall back: ${assistant.kinds.coding}`}`,
  );
}

/**
 * A coding task she starts in the task's chat: its card names the kind, and it runs on the kind's
 * model. Its worker reads the owner's skill, then runs commands: the first asks on the card, which
 * says that more of it is below what its box shows, and Run Once runs it; the same command asks
 * again and is denied; the next is allowed for good and then runs unasked, until the worker reads
 * a page, after which it asks again, saying why; the last moves to the background, which the card
 * lists, and its end wakes the task. Then Settings' Allowed Commands lists the one allowed for
 * good, and Remove takes it back.
 */
async function toolsWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin, home } = walk;
  const { workers } = walk.embeddings.seen;
  const { commands: folder, fetch: site } = walk.embeddings.places;
  const skill = join(home, "skills", SKILL_NAME);
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n${SKILL_BODY}\n`,
  );
  const shared = join(sharedSkills(home), SHARED_SKILL);
  mkdirSync(shared, { recursive: true });
  writeFileSync(
    join(shared, "SKILL.md"),
    `---\nname: ${SHARED_SKILL}\ndescription: A skill the owner's agents share\n---\nShare it.\n`,
  );
  if (new URL(page.url()).pathname !== `/chats/${chat.id}`) {
    await page.goto(`${origin}/chats/${chat.id}`);
  }
  const worked = workers.length;
  const asked = await askHer(walk, chat, TOOLS_LINE, TOOLS_ACK);
  const line = asked.find((request) => lastContent(request) === TOOLS_LINE);
  const task = startedTask(await chatLog(walk, chat.id), START_CALL_TOOLS);
  if (task === null) throw new Error("her start_task call for the commands started no task");
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const kind = card.locator('[data-profile="coding"]');
  const kindShown = await shows(kind, 20_000);
  const kindText = kindShown ? await visibleText(kind) : "";
  const modelShown = await shows(card.getByText(CODING_MODEL), 5_000);
  const waiting = await taskOf(walk, task);
  const start = await answerCard(walk, card, task, "once", (pending) => pending.kind === "start");
  const isCommand = (command: string) => (pending: TaskPending) =>
    pending.kind === "command" && pending.command === command;
  const first = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending !== undefined && isCommand(ONCE_COMMAND)(snapshot.pending),
    30_000,
  );
  const mine = () => workers.slice(worked);
  const models = [...new Set(mine().map((request) => String(request.model)))];
  checks.add(
    "task profile",
    startRequires(line) === '["goal","folder","profile"]' &&
      waiting?.profile === "coding" &&
      waiting.model.model === CODING_MODEL &&
      kindShown &&
      kindText === t("en", "Coding", {}, "task kind") &&
      modelShown &&
      start.status === 200 &&
      JSON.stringify(models) === JSON.stringify([CODING_MODEL]),
    `her start_task required ${startRequires(line)}; the task stores kind ` +
      `${String(waiting?.profile)} on ${String(waiting?.model.model)}, the card shows ` +
      `${kindShown ? quote(kindText) : "no kind"} and ${modelShown ? "the kind's model" : "another model"}; ` +
      `Allow Once answered ${start.status}; its worker was asked on ${JSON.stringify(models)}`,
  );

  const [loading, loaded] = mine();
  const entry = `<skill name="${SKILL_NAME}" from="owner">${SKILL_DESCRIPTION}</skill>`;
  const catalog = systemOf(loading).includes(entry);
  const read = toolResults(mine())[0] ?? "";
  checks.add(
    "skill read",
    offers(loading, "skill") &&
      catalog &&
      read.includes(SKILL_BODY) &&
      lastContent(loaded).includes(SKILL_BODY),
    `the worker's first request ${offers(loading, "skill") ? "offered" : "didn't offer"} skill, ` +
      `its prompt ${catalog ? "listing" : "not listing"} the owner's ${SKILL_NAME}; the skill's ` +
      `load read it ${quote(read, 160)}, with no question on the card`,
  );

  const once = first?.pending !== undefined && isCommand(ONCE_COMMAND)(first.pending);
  const pending = first?.pending?.kind === "command" ? first.pending : null;
  const question = await shows(
    card.getByText(t("en", "Let it run this command?"), { exact: true }),
    15_000,
  );
  const boxed = await shows(card.locator("[data-command]").filter({ hasText: ONCE_RUNS }), 5_000);
  const where = await shows(card.getByText(folder, { exact: true }), 5_000);
  const stopsAt = t("en", "Stops at {time}", { time: "" });
  const stops = await shows(card.getByText(new RegExp(`^${escapeRegExp(stopsAt)}`)), 5_000);
  const bar = page.locator(`section[data-waiting="${task}"]`);
  const barLine = await shows(
    bar.getByText(t("en", "Waiting for your OK to run a command in {folder}", { folder }), {
      exact: true,
    }),
    10_000,
  );
  const answers = await card
    .locator("[data-answer]")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-answer")));
  // What it runs is below what either box shows: each says so, with its size, until read whole.
  const sizeShown = await visibleText(card.locator("[data-command-size]"));
  const sizeAsked = `${ONCE_COMMAND.length.toLocaleString("en")} characters · ${ONCE_PADDING + 1} lines`;
  const more = card.locator("[data-command-more]");
  const cardMore = await shows(more, 5_000);
  const barMore = await shows(bar.locator("[data-command-more]"), 5_000);
  await card
    .locator("[data-command]")
    .first()
    .evaluate((box) => {
      box.scrollTop = box.scrollHeight;
    });
  const readWhole = await more
    .first()
    .waitFor({ state: "hidden", timeout: 5_000 })
    .then(
      () => true,
      () => false,
    );
  const toldAt = (await askHer(walk, chat, COMMAND_LINE, COMMAND_ACK)).find(
    (request) => lastContent(request) === COMMAND_LINE,
  );
  const block = statusBlock(toldAt);
  const ran = join(folder, "ran.txt");
  const notYet = textOf(ran);
  const runOnce = await answerCard(walk, card, task, "once", isCommand(ONCE_COMMAND));
  const afterOnce = await poll(
    async () => textOf(ran),
    (text) => text === "once\n",
    15_000,
  );
  checks.add(
    "command card",
    once &&
      pending?.timeout === 120 &&
      question &&
      boxed &&
      where &&
      stops &&
      barLine &&
      JSON.stringify(answers) === '["deny","always","once"]' &&
      sizeShown === sizeAsked &&
      cardMore &&
      barMore &&
      readWhole &&
      block.includes(ASKS_TO_RUN) &&
      notYet === "" &&
      runOnce.status === 200 &&
      afterOnce === "once\n",
    `the task paused on ${pending === null ? "no command" : `${quote(pending.command)} for ${pending.timeout} s`}; ` +
      `the card ${question ? "asks" : "doesn't ask"} to run it, ${boxed ? "showing" : "not showing"} ` +
      `it, ${where ? "naming" : "not naming"} the folder, ${stops ? "with" : "without"} when it ` +
      `stops, and answers ${JSON.stringify(answers)}; the waiting bar ${barLine ? "names the folder" : "doesn't"}; ` +
      `its size reads ${quote(sizeShown)}, and that more is below ${cardMore ? "shows" : "doesn't show"} ` +
      `on the card and ${barMore ? "shows" : "doesn't show"} on the bar, ${readWhole ? "going" : "not going"} ` +
      `once the card's box is scrolled to its end; her answer came after ` +
      `${block === "" ? "no status block" : quote(block, 300)}; ran.txt held ` +
      `${quote(notYet)} before Run Once (${runOnce.status}) and ${quote(afterOnce)} after`,
  );

  const deny = await answerCard(
    walk,
    card,
    task,
    "deny",
    (asking) =>
      isCommand(ONCE_COMMAND)(asking) && asking.kind === "command" && asking.call !== pending?.call,
  );
  const next = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending !== undefined && isCommand(ALWAYS_COMMAND)(snapshot.pending),
    30_000,
  );
  const refused = toolResults(mine()).includes(
    "The owner refused to run this command in this task; don't run it again.",
  );
  checks.add(
    "command deny",
    deny.pending !== null &&
      deny.status === 200 &&
      refused &&
      JSON.stringify(next?.bash?.denied) === JSON.stringify([ONCE_COMMAND]) &&
      textOf(ran) === "once\n",
    `the same command ${deny.pending === null ? "never asked again" : "asked again under a new call"}; ` +
      `Deny answered ${deny.status}; the worker ${refused ? "read" : "never read"} the refusal; ` +
      `task.json denies ${JSON.stringify(next?.bash?.denied ?? [])}; ran.txt holds ${quote(textOf(ran))}`,
  );

  const always = await answerCard(walk, card, task, "always", isCommand(ALWAYS_COMMAND));
  const afterAlways = (asking: TaskPending) =>
    site === null ? isCommand(LATE_COMMAND)(asking) : asking.kind === "fetch";
  const beyond = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending !== undefined && afterAlways(snapshot.pending),
    30_000,
  );
  const allowed = (
    (await (
      await walk.api("GET", "/api/local/assistant/commands")
    ).json()) as AllowedCommandsResponse
  ).commands;
  const grant = allowed.find((each) => each.command === ALWAYS_COMMAND);
  checks.add(
    "command always",
    always.status === 200 &&
      grant?.folder === realpathSync(folder) &&
      grant.task === task &&
      textOf(ran) === "once\nalways\nalways\n" &&
      beyond?.pending !== undefined &&
      afterAlways(beyond.pending),
    `Always in This Folder answered ${always.status}; GET assistant/commands lists ` +
      `${grant === undefined ? "nothing for it" : `it in ${grant.folder}`}; ran.txt holds ` +
      `${quote(textOf(ran))}, the same command run again unasked; the task then asked ` +
      `${beyond?.pending?.kind ?? "nothing"}`,
  );

  if (site === null) {
    checks.add("command after a page", true, "offline: the worker fetched no page");
  } else {
    const fetched = await answerCard(walk, card, task, "once", (asking) => asking.kind === "fetch");
    const again = await poll(
      () => taskOf(walk, task),
      (snapshot) => snapshot?.pending !== undefined && isCommand(ALWAYS_COMMAND)(snapshot.pending),
      60_000,
    );
    const regranted =
      again?.pending?.kind === "command" && again.pending.command === ALWAYS_COMMAND
        ? again.pending
        : null;
    const note = await shows(card.locator("[data-granted]"), 15_000);
    const rerun = await answerCard(walk, card, task, "once", isCommand(ALWAYS_COMMAND));
    const fetchedText = toolResults(mine()).find((each) => each.includes("Example Domain")) ?? "";
    checks.add(
      "command after a page",
      fetched.status === 200 &&
        again?.external === true &&
        regranted?.granted === true &&
        note &&
        rerun.status === 200 &&
        (await poll(
          async () => textOf(ran),
          (text) => text === "once\nalways\nalways\nalways\n",
          15_000,
        )) === "once\nalways\nalways\nalways\n",
      `Allow Once on ${FETCH_URL}'s site answered ${fetched.status}, the worker reading ` +
        `${fetchedText === "" ? "no page" : quote(fetchedText, 80)}; the task ${again?.external === true ? "has" : "hasn't"} ` +
        `read outside content, and the command allowed for good ` +
        `${regranted === null ? "never asked again" : `asked again${regranted.granted === true ? ", granted" : " without granted"}`}, ` +
        `the card ${note ? "saying" : "not saying"} why; Run Once answered ${rerun.status}; ran.txt holds ` +
        `${quote(textOf(ran))}`,
    );
  }

  const late = await answerCard(walk, card, task, "once", isCommand(LATE_COMMAND));
  const listed = await shows(card.locator("[data-background]").getByText(LATE_COMMAND), 20_000);
  const background = (await taskOf(walk, task))?.background ?? [];
  const meanwhile = (await askHer(walk, chat, BACKGROUND_LINE, BACKGROUND_ACK)).find(
    (request) => lastContent(request) === BACKGROUND_LINE,
  );
  const runningBlock = statusBlock(meanwhile);
  const ended = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    60_000,
  );
  const woken = mine().find((request) => COMMAND_ENDED.test(lastContent(request)));
  const output = toolResults(mine()).at(-1) ?? "";
  checks.add(
    "command background",
    late.status === 200 &&
      listed &&
      background.length === 1 &&
      background[0]?.command === LATE_COMMAND &&
      runningBlock.includes(IN_BACKGROUND) &&
      woken !== undefined &&
      ended?.status === "succeeded" &&
      ended.background === undefined &&
      textOf(ran).endsWith("always\nlate\n"),
    `Run Once answered ${late.status}; the card ${listed ? "listed" : "never listed"} it in the ` +
      `background, task.json ${JSON.stringify(background.map((each) => each.command))}; her answer ` +
      `meanwhile came after ${runningBlock === "" ? "no status block" : quote(runningBlock, 300)}; ` +
      `the worker ${woken === undefined ? "was never told" : `was told ${quote(lastContent(woken), 120)}`}, ` +
      `then read ${quote(output, 120)}; the task ${String(ended?.status)}` +
      `${ended?.outcome?.status === "failed" ? ` (${ended.outcome.error})` : ""}; ran.txt holds ` +
      `${quote(textOf(ran))}`,
  );

  await card.locator('[data-action="steps"]').click();
  const steps = card.getByRole("log", { name: t("en", "Steps"), exact: true });
  const done = t("en", "Done", {}, "tool call");
  const step = (state: string, tool: string) =>
    steps
      .getByRole("button", { name: new RegExp(`^${escapeRegExp(state)}: ${tool}(?!_)`) })
      .count();
  const rows = await Promise.all([
    step(done, "skill"),
    step(done, "bash"),
    step(t("en", "Failed"), "bash"),
    step(done, "bash_output"),
  ]);
  const notice = await shows(steps.getByText(COMMAND_ENDED), 10_000);
  const reported = await poll(
    () => chatLog(walk, chat.id),
    (events) => said(events, "persona", TOOLS_REPORT),
    30_000,
  );
  const ranCount = site === null ? 4 : 5;
  checks.add(
    "command steps",
    JSON.stringify(rows) === JSON.stringify([1, ranCount, 1, 1]) &&
      notice &&
      said(reported, "persona", TOOLS_REPORT),
    `Show Steps lists skill, bash done, bash failed and bash_output ${JSON.stringify(rows)} ` +
      `times, ${notice ? "with" : "without"} the notice of the long command's end; her report ` +
      `${said(reported, "persona", TOOLS_REPORT) ? "is" : "isn't"} in the chat`,
  );

  await page.goto(`${origin}/settings?tab=assistant`);
  const entryRow = page.locator("[data-allowed-command]").filter({ hasText: ALWAYS_COMMAND });
  const shown = await shows(entryRow, 15_000);
  const shownFolder =
    shown && (await shows(entryRow.getByText(realpathSync(folder), { exact: true }), 5_000));
  const removing = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().startsWith(`${origin}/api/local/assistant/commands/`),
  );
  await entryRow.getByRole("button", { name: t("en", "Remove"), exact: true }).click();
  const removed = (await removing).status();
  const gone = await entryRow
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const store = join(home, "tasks", "allowed-commands.json");
  const stored = JSON.parse(textOf(store) || "{}") as { commands?: unknown[] };
  checks.add(
    "allowed commands",
    shown &&
      shownFolder &&
      removed === 200 &&
      gone &&
      stored.commands?.length === 0 &&
      modeOf(store) === "0600",
    `Settings ${shown ? "lists" : "doesn't list"} the command allowed for good, ` +
      `${shownFolder ? "with" : "without"} its folder; Remove answered ${removed} and the row ` +
      `${gone ? "went" : "stayed"}; allowed-commands.json (${modeOf(store)}) holds ` +
      `${stored.commands?.length ?? "no list of"} command(s)`,
  );

  await page.goto(`${origin}/settings?tab=skills`);
  const own = page.locator(`li[data-skill="${SKILL_NAME}"][data-source="eidolon"]`);
  const theirs = page.locator(`li[data-skill="${SHARED_SKILL}"][data-source="shared"]`);
  const both = (await shows(own, 15_000)) && (await shows(theirs, 5_000));
  const badges =
    both &&
    (await shows(own.getByText(t("en", "Eidolon"), { exact: true }), 5_000)) &&
    (await shows(theirs.getByText(t("en", "Shared"), { exact: true }), 5_000));
  const switching = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url() === `${origin}/api/local/skills/${SHARED_SKILL}`,
  );
  const off = theirs.getByRole("switch", {
    name: t("en", "Let Tasks Use {name}", { name: SHARED_SKILL }),
    exact: true,
  });
  await off.click();
  const switched = (await switching).status();
  const unchecked = await off
    .and(page.locator('[data-state="unchecked"]'))
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const switches = join(home, "skills.json");
  checks.add(
    "skills settings",
    both &&
      badges &&
      switched === 200 &&
      unchecked &&
      textOf(switches).includes(`"${SHARED_SKILL}"`) &&
      modeOf(switches) === "0600",
    `Settings' Skills ${both ? "lists" : "doesn't list"} the data home's ${SKILL_NAME} and the ` +
      `shared ${SHARED_SKILL}, ${badges ? "each with" : "without"} its source; switching ` +
      `${SHARED_SKILL} off answered ${switched}, the switch ${unchecked ? "turned" : "stayed"} ` +
      `off, and skills.json (${modeOf(switches)}) holds ${quote(textOf(switches), 80)}`,
  );
}

/**
 * Two tasks whose workers call the fake MCP server's tool, mcp.json naming the test fixture run on
 * this Node. The first's card asks for each call, every argument with its size and the server's
 * hint: Run Once, then Always Allow This Tool, which mcp.json then holds; its server is gone once
 * it ends. The second's call runs unasked. Then Settings' MCP Servers takes the Always back.
 */
async function mcpWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin, home } = walk;
  const { workers } = walk.embeddings.seen;
  const { mcp: folder } = walk.embeddings.places;
  const pids = join(dirname(folder), "mcp-pids.json");
  const config = join(home, "mcp.json");
  const entry = {
    command: process.execPath,
    args: [join(ROOT, MCP_FIXTURE), "--pidfile", pids],
    tools: [MCP_TOOL],
  };
  writeFileSync(config, `${JSON.stringify({ mcpServers: { [MCP_SERVER]: entry } }, null, 2)}\n`, {
    mode: 0o600,
  });
  if (new URL(page.url()).pathname !== `/chats/${chat.id}`) {
    await page.goto(`${origin}/chats/${chat.id}`);
  }
  const worked = workers.length;
  await askHer(walk, chat, MCP_LINE, MCP_ACK);
  const task = startedTask(await chatLog(walk, chat.id), START_CALL_MCP);
  if (task === null) throw new Error("her start_task call for the MCP server started no task");
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const start = await answerCard(walk, card, task, "once", (pending) => pending.kind === "start");
  const isMcp = (pending: TaskPending) => pending.kind === "mcp";
  const asking = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending !== undefined && isMcp(snapshot.pending),
    30_000,
  );
  const pending = asking?.pending?.kind === "mcp" ? asking.pending : null;
  const sent = pending?.args[0];
  const pid = serverPid(pids);
  const offered = workers.slice(worked).some((request) => offers(request, MCP_CALL_NAME));
  const question = await shows(
    card.getByText(
      t("en", "Let it run {tool} on {server}?", { tool: MCP_TOOL, server: MCP_SERVER }),
      { exact: true },
    ),
    15_000,
  );
  // The hint's line goes on to say it is the server's own claim.
  const claim = t("en", "The server says this tool only reads.");
  const hint = await shows(card.getByText(new RegExp(`^${escapeRegExp(claim)} `)), 5_000);
  const argument = await shows(
    card.locator('[data-argument="text"]').getByText(ECHOES[0], { exact: true }),
    5_000,
  );
  const bar = page.locator(`section[data-waiting="${task}"]`);
  const barLine = await shows(
    bar.getByText(
      t("en", "Waiting for your OK to run {tool} on {server}", {
        tool: MCP_TOOL,
        server: MCP_SERVER,
      }),
      { exact: true },
    ),
    10_000,
  );
  const once = await answerCard(walk, card, task, "once", isMcp);
  const always = await answerCard(
    walk,
    card,
    task,
    "always",
    (asked) => asked.kind === "mcp" && asked.call !== pending?.call,
  );
  const ended = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    30_000,
  );
  const echoed = toolResults(workers.slice(worked));
  const saved = JSON.parse(textOf(config)) as {
    mcpServers?: Record<string, { alwaysAllow?: unknown }>;
  };
  const kept = saved.mcpServers?.[MCP_SERVER]?.alwaysAllow;
  const stopped = pid !== null && (await waitFor(() => !alive(pid), 10_000)) !== null;
  checks.add(
    "mcp card",
    start.status === 200 &&
      offered &&
      pending?.server === MCP_SERVER &&
      pending.tool === MCP_TOOL &&
      pending.hint === "read-only" &&
      pending.args.length === 1 &&
      sent?.name === "text" &&
      sent.head === ECHOES[0] &&
      sent.chars === ECHOES[0].length &&
      sent.lines === 1 &&
      question &&
      hint &&
      argument &&
      barLine &&
      once.status === 200 &&
      echoed[0] === ECHOES[0] &&
      modeOf(join(home, "mcp")) === "0700",
    `the worker was ${offered ? "offered" : "never offered"} ${MCP_CALL_NAME}; its call paused on ` +
      `${pending === null ? "nothing" : JSON.stringify({ server: pending.server, tool: pending.tool, hint: pending.hint, args: pending.args })}; ` +
      `the card ${question ? "asks" : "doesn't ask"} to run it, ${hint ? "with" : "without"} the ` +
      `server's hint, ${argument ? "showing" : "not showing"} its argument; the waiting bar ` +
      `${barLine ? "names the tool" : "doesn't"}; Run Once answered ${once.status} and the worker ` +
      `read ${quote(echoed[0] ?? "nothing")}; the servers' folder is ${modeOf(join(home, "mcp"))}`,
  );
  checks.add(
    "mcp always",
    always.pending !== null &&
      always.status === 200 &&
      echoed[1] === ECHOES[1] &&
      JSON.stringify(kept) === JSON.stringify([MCP_TOOL]) &&
      modeOf(config) === "0600" &&
      ended?.status === "succeeded" &&
      stopped,
    `the second call ${always.pending === null ? "never asked" : "asked again"}; Always Allow This ` +
      `Tool answered ${always.status}, the worker reading ${quote(echoed[1] ?? "nothing")}, and ` +
      `mcp.json (${modeOf(config)}) always allows ${JSON.stringify(kept ?? [])}; the task ` +
      `${String(ended?.status)}; its server ${pid === null ? "never wrote its pid" : stopped ? "is gone" : `still runs as ${pid}`}`,
  );
  await poll(
    () => chatLog(walk, chat.id),
    (events) => said(events, "persona", MCP_REPORT),
    30_000,
  );

  const worked2 = workers.length;
  await askHer(walk, chat, MCP2_LINE, MCP2_ACK);
  const task2 = startedTask(await chatLog(walk, chat.id), START_CALL_MCP2);
  if (task2 === null)
    throw new Error("her second start_task call for the MCP server started no task");
  const card2 = chat.log.locator(`article[data-task="${task2}"]`);
  await shows(card2.getByText(t("en", "Start this task?"), { exact: true }), 20_000);
  const kinds = await card2.locator("[data-profile]").count();
  const start2 = await answerCard(walk, card2, task2, "once", (asked) => asked.kind === "start");
  const ended2 = await poll(
    () => taskOf(walk, task2),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    30_000,
  );
  const echoed2 = toolResults(workers.slice(worked2));
  const pid2 = serverPid(pids);
  const stopped2 =
    pid2 !== null && pid2 !== pid && (await waitFor(() => !alive(pid2), 10_000)) !== null;
  checks.add(
    "mcp unasked",
    kinds === 0 &&
      ended2?.profile === undefined &&
      start2.status === 200 &&
      ended2?.status === "succeeded" &&
      ended2.pause === undefined &&
      JSON.stringify(echoed2) === JSON.stringify([ECHOES[0]]) &&
      stopped2,
    `a task she called other has ${kinds} kind row(s) and stores ${String(ended2?.profile ?? "no kind")}; ` +
      `Allow Once answered ${start2.status}; it ${String(ended2?.status)}` +
      `${ended2?.pause === undefined ? " without a pause" : `, pausing for ${ended2.pause.reason}`}, ` +
      `its worker reading ${JSON.stringify(echoed2)}; a new server ` +
      `${pid2 === null || pid2 === pid ? "never started" : stopped2 ? "ran it and is gone" : `still runs as ${pid2}`}`,
  );
  await poll(
    () => chatLog(walk, chat.id),
    (events) => said(events, "persona", MCP2_REPORT),
    30_000,
  );

  await page.goto(`${origin}/settings?tab=assistant`);
  const server = page.locator(`[data-mcp-server="${MCP_SERVER}"]`);
  const listed = await shows(server, 15_000);
  const chip = server.getByRole("button", {
    name: t("en", "Stop Always Allowing {tool}", { tool: MCP_TOOL }),
    exact: true,
  });
  const put = page.waitForResponse(isPut(`${origin}/api/local/mcp/servers/${MCP_SERVER}`));
  await chip.click();
  const status = (await put).status();
  const chipGone = await chip
    .waitFor({ state: "detached", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  const after = JSON.parse(textOf(config)) as {
    mcpServers?: Record<string, { alwaysAllow?: unknown; tools?: unknown }>;
  };
  const left = after.mcpServers?.[MCP_SERVER];
  checks.add(
    "mcp settings",
    listed &&
      status === 200 &&
      chipGone &&
      left?.alwaysAllow === undefined &&
      JSON.stringify(left?.tools) === JSON.stringify([MCP_TOOL]) &&
      modeOf(config) === "0600",
    `MCP Servers ${listed ? "lists" : "doesn't list"} ${MCP_SERVER}; its Always chip's remove ` +
      `answered ${status} and the chip ${chipGone ? "went" : "stayed"}; mcp.json (${modeOf(config)}) ` +
      `now always allows ${JSON.stringify(left?.alwaysAllow ?? [])}, keeping its tools ` +
      `${JSON.stringify(left?.tools)}`,
  );
}

/**
 * The chat's permission level, from the picker under its message box. Under Approve for Me, a task
 * outside assistant.folders starts with no card and runs the command its review allows, and the
 * card asks about the one it won't, saying why; Deny ends it. Under Full Access, her start_task
 * description says commands run unasked, and a task starts and runs its command with no review and
 * no pause. Ask for Approval again leaves the chat as it was.
 */
async function permissionsWalk(walk: Walk, chat: TaskChatPage): Promise<void> {
  const { page, checks, origin } = walk;
  const { chats, reviews } = walk.embeddings.seen;
  const { auto, full } = walk.embeddings.places;
  if (new URL(page.url()).pathname !== `/chats/${chat.id}`) {
    await page.goto(`${origin}/chats/${chat.id}`);
  }
  const picker = page.locator("footer button[data-permissions]");
  const chatUrl = `${origin}/api/local/chats/${chat.id}`;
  const pick = async (level: string, label: string): Promise<number> => {
    await picker.click();
    const patched = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.url() === chatUrl,
    );
    await page.getByRole("menuitemradio", { name: new RegExp(`^${escapeRegExp(label)}`) }).click();
    const status = (await patched).status();
    await poll(
      () => picker.getAttribute("data-permissions"),
      (shown) => shown === level,
      10_000,
    );
    return status;
  };
  const levelOf = (events: readonly LoggedEvent[]) =>
    (events.findLast((e) => e.type === "settings" && e.permissions !== undefined)?.permissions ??
      null) as string | null;

  const pickerShown = await shows(picker, 15_000);
  const before = await picker.getAttribute("data-permissions");
  const autoStatus = await pick("auto", t("en", "Approve for Me"));
  const autoStored = levelOf(await chatLog(walk, chat.id));
  const reviewed = reviews.length;
  await askHer(walk, chat, AUTO_LINE, AUTO_ACK);
  const task = startedTask(await chatLog(walk, chat.id), START_CALL_AUTO);
  if (task === null) throw new Error("her start_task under Approve for Me started no task");
  const card = chat.log.locator(`article[data-task="${task}"]`);
  const asking = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot?.pending?.kind === "command",
    60_000,
  );
  const pending = asking?.pending?.kind === "command" ? asking.pending : null;
  const because = await shows(
    card.getByText(
      t("en", "Approve for Me asks you: this changes files outside the task's folder."),
      { exact: true },
    ),
    15_000,
  );
  const inside = textOf(join(auto, "ok.txt"));
  const denied = await answerCard(walk, card, task, "deny", (asked) => asked.kind === "command");
  const ended = await poll(
    () => taskOf(walk, task),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    30_000,
  );
  const autoReviews = reviews.length - reviewed;
  const outside = existsSync(join(dirname(auto), "outside.txt"));
  checks.add(
    "approve for me",
    pickerShown &&
      before === "ask" &&
      autoStatus === 200 &&
      autoStored === "auto" &&
      pending?.command === AUTO_OUTSIDE &&
      pending.review === "outside" &&
      because &&
      inside === "ok" &&
      denied.status === 200 &&
      ended?.status === "succeeded" &&
      autoReviews === 3 &&
      !outside,
    `the picker ${pickerShown ? "showed" : "never showed"} ${String(before)}; Approve for Me ` +
      `answered ${autoStatus}, the log storing ${String(autoStored)}; the task started with no ` +
      `card and ran its first command (ok.txt holds ${quote(inside)}), then asked about ` +
      `${quote(pending?.command ?? "nothing")} for ${String(pending?.review)}, the card ` +
      `${because ? "saying why" : "not saying why"}; Deny answered ${denied.status}; it ` +
      `${String(ended?.status)} after ${autoReviews} review(s), outside.txt ` +
      `${outside ? "written" : "never written"}`,
  );
  await poll(
    () => chatLog(walk, chat.id),
    (events) => said(events, "persona", AUTO_REPORT),
    30_000,
  );

  const fullStatus = await pick("full", t("en", "Full Access"));
  const warned = (await picker.getAttribute("class"))?.includes("text-warning") ?? false;
  const reviewed2 = reviews.length;
  const asked = chats.length;
  await askHer(walk, chat, FULL_LINE, FULL_ACK);
  const line = chats.slice(asked).find((request) => lastContent(request) === FULL_LINE);
  const described = String(
    (line?.tools ?? []).find((tool) => tool.function?.name === "start_task")?.function
      ?.description ?? "",
  );
  const task2 = startedTask(await chatLog(walk, chat.id), START_CALL_FULL);
  if (task2 === null) throw new Error("her start_task under Full Access started no task");
  const ended2 = await poll(
    () => taskOf(walk, task2),
    (snapshot) => snapshot !== null && ENDED_TASK.has(snapshot.status),
    30_000,
  );
  const events = await walk.api("GET", `/api/local/tasks/${task2}/events`);
  const paused = (await events.text()).includes('"type":"pause"');
  const ran = textOf(join(full, "full.txt"));
  const fullReviews = reviews.length - reviewed2;
  await poll(
    () => chatLog(walk, chat.id),
    (logged) => said(logged, "persona", FULL_REPORT),
    30_000,
  );
  const backStatus = await pick("ask", t("en", "Ask for Approval"));
  const backStored = levelOf(await chatLog(walk, chat.id));
  checks.add(
    "full access",
    fullStatus === 200 &&
      warned &&
      described.includes(FULL_TEXT) &&
      ended2?.status === "succeeded" &&
      !paused &&
      ran === "full" &&
      fullReviews === 0 &&
      backStatus === 200 &&
      backStored === "ask",
    `Full Access answered ${fullStatus}, the picker ${warned ? "in" : "not in"} the warning ` +
      `color; her start_task description ${described.includes(FULL_TEXT) ? "says" : "doesn't say"} ` +
      `commands run unasked; the task ${String(ended2?.status)} ${paused ? "after a pause" : "with no pause"}, ` +
      `full.txt holding ${quote(ran)}, after ${fullReviews} review(s); Ask for Approval answered ` +
      `${backStatus}, the log storing ${String(backStored)}`,
  );
}

/**
 * Settles the bodies read so far, each on its own: null for one the browser couldn't give, or one
 * still streaming after 10 s.
 */
async function settled(bodies: readonly Promise<string | null>[]): Promise<(string | null)[]> {
  const deadline = delay(10_000).then(() => null);
  return Promise.all(bodies.map((body) => Promise.race([body, deadline])));
}

async function smoke(options: Options): Promise<Checks> {
  const checks = new Checks();
  if (!(await buildWeb(checks, false))) return checks;
  const templates = treeHash(join(ROOT, "personas"));
  const run = new Run();
  const { home } = run;
  const id = randomBytes(4).toString("hex");
  const keys: Record<string, string> = {
    soniox: `not-a-real-key-soniox-${id}`,
    openrouter: `not-a-real-key-openrouter-${id}`,
    fish: `not-a-real-key-fish-${id}`,
    embed: `not-a-real-key-embed-${id}`,
  };
  // Beside the data home, which no task may touch.
  const embeddings = await fakeEmbeddings(keys.embed as string, {
    site: join(run.temp, "task-site"),
    notes: join(run.temp, "task-notes", "notes.txt"),
    second: join(run.temp, "task-second"),
    third: join(run.temp, "task-third"),
    call: join(run.temp, "task-call"),
    commands: join(run.temp, "task-commands"),
    mcp: join(run.temp, "task-mcp"),
    mcp2: join(run.temp, "task-mcp-again"),
    auto: join(run.temp, "task-auto"),
    full: join(run.temp, "task-full"),
    fetch: options.offline ? null : FETCH_URL,
  });
  run.defer(embeddings.stop);
  const env = childEnv(home);
  try {
    const problem = await isolationProblem(env, home);
    checks.add(
      "isolation",
      problem === null,
      problem ?? "both load-env.ts files skip the .env and use the temporary home",
    );
    if (problem !== null) return checks;

    const server = await run.boot(env, checks);
    if (server === null) return checks;
    const { link, origin, secret, stdout, stderr } = server;
    const bodies: Promise<string | null>[] = [];
    const api = async (
      method: string,
      path: string,
      body?: string | Uint8Array<ArrayBuffer>,
      headers: Readonly<Record<string, string>> = {},
    ): Promise<Response> => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          ...headers,
        },
        body,
      });
      const text = await response.text();
      bodies.push(Promise.resolve(text));
      // A 204's Response takes a null body: Node's constructor throws on any other, "" included.
      const kept = text === "" ? null : text;
      return new Response(kept, { status: response.status, headers: response.headers });
    };

    const mic = join(run.temp, "voice.wav");
    writeFileSync(mic, toneWav(2));
    let browser: Browser;
    try {
      // Muted, so a headful run never plays her calls' tone; headless, Playwright mutes it anyway.
      browser = await chromium.launch({
        ...chrome(),
        headless: !options.headful,
        args: [...fakeMicArgs(mic), "--mute-audio"],
      });
    } catch (error) {
      checks.add("browser", false, error instanceof Error ? error.message.split("\n")[0] : "");
      return checks;
    }
    run.browser = browser;
    const context = await browser.newContext({ locale: "en-US" });
    await context.grantPermissions(["microphone"], { origin });
    await context.addInitScript(observeMedia);
    const problems: string[] = [];
    await reportCsp(context, problems);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("dialog", (dialog) => void dialog.accept());
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("response", (response) => {
      if (response.url().startsWith(`${origin}/api/`)) {
        bodies.push(response.text().catch(() => null));
      }
    });
    const walk: Walk = {
      options,
      checks,
      page,
      context,
      origin,
      link,
      home,
      keys,
      embeddings,
      mic,
      serverLog: () => `${stdout.text}\n${stderr.text}`,
      api,
    };

    if (
      (await checks.step("sign-in", () => signIn(walk))) &&
      (await checks.step("keys", () => keysStep(walk)))
    ) {
      const embedder = await checks.step("embeddings account", () => embeddingsAccount(walk));
      await checks.step("credentials.json", () => credentialsAtRest(walk));
      await checks.step("prompt", () => savePrompt(walk, templates));
      await checks.step("voice styles", () => voiceStyles(walk, templates));
      await checks.step("appearance", () => appearanceWalk(walk, templates));
      if (embedder && (await checks.step("ingest-facts", () => indexFacts(walk)))) {
        await checks.step("jobs page", () => jobsPage(walk));
      }
      if (embedder) {
        const chatted = await checks.step("chat", () => chatWalk(walk));
        await checks.step("group chat", () => groupChatWalk(walk));
        const called =
          (await checks.step("voice chat", () => voiceChatWalk(walk))) &&
          (await checks.step("chat call", () => chatCallWalk(walk)));
        if (called) await checks.step("video call", () => videoCallWalk(walk));
        // Last: once the assistant has a model, her answers in a chat of one offer her start_task.
        const tasked: { chat?: TaskChatPage } = {};
        if (chatted) {
          await checks.step("task", async () => {
            tasked.chat = await taskWalk(walk);
          });
        }
        const { chat } = tasked;
        if (chat !== undefined && (await checks.step("task stop", () => stopWalk(walk, chat)))) {
          await checks.step("chat display", () => displayWalk(walk, chat));
          // In focus, which the display walk leaves on: the row must bring its card back.
          await checks.step("task list", () => taskList(walk, chat));
          await checks.step("display reveal", () => revealWalk(walk, chat));
          // In the task's chat, whose stored status block the call must leave out.
          if (called) await checks.step("task call", () => callTaskWalk(walk, chat));
        }
        // Last, in the task's chat: kinds, skills, commands and MCP servers' tools.
        if (chat !== undefined) {
          if (await checks.step("task kinds", () => kindsWalk(walk))) {
            await checks.step("task tools", () => toolsWalk(walk, chat));
          }
          await checks.step("task mcp", () => mcpWalk(walk, chat));
          await checks.step("task permissions", () => permissionsWalk(walk, chat));
        }
      }
    }
    checks.add(
      "page health",
      problems.length === 0,
      problems.length === 0 ? "no page errors or CSP violations" : problems.slice(0, 3).join("; "),
    );

    if (!checks.pass) {
      for (const line of serverTrouble(server)) checks.notes.push(`server   ${line}`);
    }
    const texts = await settled(bodies);
    const code = await run.stop();
    checks.add("shutdown", code === 0, `the server exited ${String(code)}`);
    if (code !== 0) {
      for (const line of server.stderr.tail(8).split("\n")) checks.notes.push(`exit     ${line}`);
    }
    const scanned = [...texts, stdout.text, stderr.text].filter((text) => text !== null);
    const echoed = Object.entries(keys)
      .filter(([, value]) => scanned.some((text) => text.includes(value)))
      .map(([name]) => name);
    const unread = texts.filter((text) => text === null).length;
    checks.add(
      "no key echoed",
      echoed.length === 0,
      echoed.length > 0
        ? `echoed: ${echoed.join(", ")}`
        : `none in ${texts.length - unread} API answers (${unread} unreadable) or the server's output`,
    );
  } finally {
    await run.end(checks, templates);
  }
  return checks;
}

/** Chrome's flags for a fake microphone that plays `wav` and asks no permission. */
function fakeMicArgs(wav: string): string[] {
  return [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${wav}`,
  ];
}

/** A silent 16-bit mono WAV: without a capture file, Chrome's fake microphone beeps. */
function silentWav(seconds: number, rate = 48_000): Uint8Array {
  return wav(new Int16Array(seconds * rate), rate);
}

/** A quiet 440 Hz tone as a 16-bit mono WAV: the voice message the walk records. */
function toneWav(seconds: number, rate = 48_000): Uint8Array {
  const samples = Int16Array.from({ length: seconds * rate }, (_, i) =>
    Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 4096),
  );
  return wav(samples, rate);
}

function wav(samples: Int16Array, rate: number): Uint8Array {
  const bytes = samples.length * 2;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const ascii = (at: number, text: string) => {
    for (const [i, char] of [...text].entries()) view.setUint8(at + i, char.charCodeAt(0));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, bytes, true);
  for (const [i, sample] of samples.entries()) view.setInt16(44 + i * 2, sample, true);
  return new Uint8Array(view.buffer);
}

/** What the page reports to the run, through functions the context exposes. */
interface CallHooks {
  smokeRtvi(type: string, data: unknown): Promise<void>;
  smokeAudio(playing: boolean, db: number): Promise<void>;
}

/**
 * Installed in the page before its own scripts: copies the RTVI messages off the transport's data
 * channel, and samples the call's `<audio data-call>`, whether it plays and how loud.
 */
function observeCall({ intervalMs, floorDb }: { intervalMs: number; floorDb: number }): void {
  const hooks = window as unknown as CallHooks;
  const create = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (
    this: RTCPeerConnection,
    label: string,
    init?: RTCDataChannelInit,
  ): RTCDataChannel {
    const channel = create.call(this, label, init);
    channel.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      try {
        const message = JSON.parse(event.data) as {
          label?: unknown;
          type?: unknown;
          data?: unknown;
        };
        if (message.label === "rtvi-ai" && typeof message.type === "string") {
          if (message.type !== "metrics") void hooks.smokeRtvi(message.type, message.data ?? null);
        }
      } catch {
        // A keepalive or a signalling line, not RTVI.
      }
    });
    return channel;
  };

  // Created once a stream plays, after the click on Call: before any gesture it starts suspended.
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let samples = new Float32Array(0);
  let trackId: string | null = null;
  let lastTime = 0;
  setInterval(() => {
    // A chat's voice messages put their own <audio> before it.
    const audio = document.querySelector<HTMLAudioElement>("audio[data-call]");
    const stream = audio?.srcObject instanceof MediaStream ? audio.srcObject : null;
    const track = stream?.getAudioTracks()[0];
    if (!audio || !stream || !track) {
      trackId = null;
      return;
    }
    if (track.id !== trackId || context === null || analyser === null) {
      trackId = track.id;
      context ??= new AudioContext();
      void context.resume().catch(() => undefined);
      analyser ??= context.createAnalyser();
      source?.disconnect();
      source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      samples = new Float32Array(analyser.fftSize);
      lastTime = audio.currentTime;
    }
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const value of samples) sum += value * value;
    const rms = Math.sqrt(sum / samples.length);
    const db = rms > 0 ? Math.max(floorDb, 20 * Math.log10(rms)) : floorDb;
    const playing = !audio.paused && audio.currentTime > lastTime;
    lastTime = audio.currentTime;
    void hooks.smokeAudio(playing, Math.round(db * 10) / 10);
  }, intervalMs);
}

interface Picture {
  /** As the browser resolved it. */
  readonly src: string;
  readonly loaded: boolean;
  readonly natural: readonly [number, number];
  /** The box it shows in, as laid out. */
  readonly box: readonly [number, number];
}

/** One entry of the call page's transcript, as it reads. */
interface Line {
  readonly kind: "you" | "bot" | "selfie";
  /** Without the screen-reader prefix that names the speaker. */
  readonly text: string;
  /** Delivery cues shown as emoji chips, and directions shown as notes. */
  readonly cues: number;
  readonly directions: number;
  readonly pictures: readonly Picture[];
  /** Pictures that failed to load and show the expired note instead. */
  readonly expired: number;
}

interface Labels {
  /** The screen-reader prefixes of the viewer's and the persona's bubbles. */
  readonly you: string;
  readonly bot: string;
  readonly expired: string;
}

/** Runs in the page: the transcript's entries, without the thinking dots and notes between. */
function readTranscript({ you, bot, expired }: Labels): Line[] {
  const content = document.querySelector('[role="log"]')?.firstElementChild;
  if (!content) return [];
  const shown = (element: Element): string => {
    const copy = element.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll(".sr-only")) hidden.remove();
    return (copy.textContent ?? "").replace(/\s+/g, " ").trim();
  };
  const lines: Line[] = [];
  for (const element of Array.from(content.children)) {
    const label = element.querySelector(".sr-only")?.textContent ?? "";
    if (label === you || label === bot) {
      lines.push({
        kind: label === you ? "you" : "bot",
        text: shown(element),
        cues: element.querySelectorAll('span[role="img"]').length,
        directions: element.querySelectorAll("span[title]:not([role])").length,
        pictures: [],
        expired: 0,
      });
      continue;
    }
    const images = Array.from(element.querySelectorAll("img"));
    const gone = (element.textContent ?? "").split(expired).length - 1;
    if (images.length === 0 && gone === 0) continue;
    lines.push({
      kind: "selfie",
      text: "",
      cues: 0,
      directions: 0,
      expired: gone,
      pictures: images.map((image) => {
        const box = (image.closest("div") ?? image).getBoundingClientRect();
        return {
          src: image.src,
          loaded: image.complete && image.naturalWidth > 0,
          natural: [image.naturalWidth, image.naturalHeight],
          box: [Math.round(box.width), Math.round(box.height)],
        };
      }),
    });
  }
  return lines;
}

/** RTVI messages that show the bot is still working on a turn. */
const BOT_ACTIVITY = new Set([
  "bot-started-speaking",
  "bot-stopped-speaking",
  "bot-llm-started",
  "bot-llm-stopped",
  "bot-tts-started",
  "bot-output",
  "bot-llm-text",
  "bot-tts-text",
  "llm-function-call-started",
  "llm-function-call-in-progress",
  "llm-function-call-stopped",
]);

function field(data: unknown, key: string): unknown {
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)[key]
    : undefined;
}

interface Sample {
  readonly at: number;
  readonly playing: boolean;
  readonly db: number;
}

/** What the page's observers reported, stamped as it arrived, and the bot's turn state. */
class CallLog {
  /** When Call was clicked. */
  calledAt = 0;
  readonly rtvi: { readonly at: number; readonly type: string; readonly data: unknown }[] = [];
  readonly audio: Sample[] = [];
  #speaking = false;
  #llm = false;
  readonly #tools = new Set<unknown>();
  #lastActivity = 0;
  #lastSpeech = 0;

  addRtvi(type: string, data: unknown): void {
    const at = Date.now();
    this.rtvi.push({ at, type, data });
    if (!BOT_ACTIVITY.has(type)) return;
    this.#lastActivity = at;
    if (type === "bot-started-speaking") {
      this.#speaking = true;
      this.#lastSpeech = at;
    } else if (type === "bot-stopped-speaking") this.#speaking = false;
    else if (type === "bot-llm-started") this.#llm = true;
    else if (type === "bot-llm-stopped") this.#llm = false;
    else if (type === "llm-function-call-in-progress") this.#tools.add(field(data, "tool_call_id"));
    else if (type === "llm-function-call-stopped") this.#tools.delete(field(data, "tool_call_id"));
  }

  addAudio(playing: boolean, db: number): void {
    this.audio.push({ at: Date.now(), playing, db });
  }

  /** The bot has spoken since `since` and been quiet for SETTLE_MS. */
  settled(since: number): boolean {
    const idle = !this.#speaking && !this.#llm && this.#tools.size === 0;
    return idle && this.#lastSpeech >= since && Date.now() - this.#lastActivity >= SETTLE_MS;
  }

  first(type: string, since: number, match: (data: unknown) => boolean = () => true) {
    return this.rtvi.find((event) => event.at >= since && event.type === type && match(event.data));
  }

  /** The bot's audio between `from` and `to`. */
  sound(from: number, to = Number.POSITIVE_INFINITY) {
    const span = this.audio.filter((sample) => sample.at >= from && sample.at < to);
    const audible = span.filter((sample) => sample.db >= AUDIBLE_DB);
    const playing = span.filter((sample) => sample.playing);
    return {
      firstAudible: audible[0]?.at ?? null,
      audibleMs: audible.length * SAMPLE_MS,
      playingMs: playing.length * SAMPLE_MS,
      peak: span.reduce((peak, sample) => Math.max(peak, sample.db), FLOOR_DB),
      heard: audible.length >= MIN_SAMPLES || playing.length >= MIN_SAMPLES,
    };
  }
}

/** The call page's transcript, read every SAMPLE_MS, with when each entry first showed. */
class TranscriptWatch {
  lines: readonly Line[] = [];
  readonly shownAt: number[] = [];
  #running = true;
  readonly #done: Promise<void>;

  constructor(page: Page, labels: Labels) {
    this.#done = (async () => {
      while (this.#running) {
        const lines = await page.evaluate(readTranscript, labels).catch(() => null);
        if (lines !== null) {
          while (this.shownAt.length < lines.length) this.shownAt.push(Date.now());
          this.lines = lines;
        }
        await delay(SAMPLE_MS);
      }
    })();
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#done;
  }
}

/** When `test` first held, checked every SAMPLE_MS; null once `ms` ran out. */
async function waitFor(test: () => boolean | Promise<boolean>, ms: number): Promise<number | null> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await test()) return Date.now();
    if (Date.now() > deadline) return null;
    await delay(SAMPLE_MS);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function quote(text: string, max = 80): string {
  return `"${text.length > max ? `${text.slice(0, max)}…` : text}"`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Markup the TTS reads and a viewer should never see as written: `[cue]`, `<tag>`, `</tag>`. */
const RAW_MARKUP = /\[[^\]\n]+\]|<\/?[A-Za-z][^<>\n]*>/;

interface CallView {
  readonly page: Page;
  readonly origin: string;
  readonly checks: Checks;
  readonly log: CallLog;
  readonly watch: TranscriptWatch;
  /** The persona's short name, as the page names her. */
  readonly short: string;
  readonly timings: [label: string, ms: number | null][];
  /** One line per turn: its stages in the order they happened. */
  readonly turns: string[];
}

/** What the page says is wrong, from its alerts. */
async function alerts(page: Page): Promise<string> {
  return (await visibleText(page.getByRole("alert"))) || "no alert shown";
}

function messageBox(view: CallView): Locator {
  const name = t("en", "Type a message to {name}", { name: view.short });
  return view.page.getByRole("textbox", { name, exact: true });
}

/** The viewer's last line reading `text`, and the first bot line after it; -1 for none. */
function answerTo(lines: readonly Line[], text: string): { asked: number; answer: number } {
  const asked = lines.findLastIndex((line) => line.kind === "you" && line.text === text);
  const answer =
    asked === -1
      ? -1
      : lines.findIndex((line, i) => i > asked && line.kind === "bot" && line.text !== "");
  return { asked, answer };
}

/** Types `text` and sends it with Enter; when it went. */
async function send(view: CallView, text: string): Promise<number> {
  const box = messageBox(view);
  await box.fill(text);
  const sent = Date.now();
  await box.press("Enter");
  return sent;
}

/** Whether the bot's audio from `from` on was heard, and how, for a check's detail. */
function audioCheck(view: CallView, from: number, to: number) {
  const sound = view.log.sound(from, to);
  const detail =
    `the audio element played ${seconds(sound.playingMs)}; peak ${sound.peak} dBFS, ` +
    `${seconds(sound.audibleMs)} audible` +
    (sound.firstAudible === null ? "" : `, the first ${seconds(sound.firstAudible - from)} in`);
  return { pass: sound.heard, detail, firstAudible: sound.firstAudible };
}

/**
 * A turn's stages between `from` and `to`, in the order they happened and timed from `base`:
 * each LLM run and tool call, the bot's first speech, and the page's own `marks`.
 */
function stages(
  view: CallView,
  label: string,
  [from, to, base, baseName]: readonly [number, number, number, string],
  marks: readonly (readonly [string, number | null])[],
): void {
  const points: [string, number][] = [];
  let spoke = false;
  for (const { at, type, data } of view.log.rtvi) {
    if (at < from || at >= to) continue;
    if (type === "bot-llm-started") points.push(["llm", at]);
    else if (type === "llm-function-call-started") {
      points.push([String(field(data, "function_name") ?? "tool call"), at]);
    } else if (type === "bot-started-speaking" && !spoke) {
      spoke = true;
      points.push(["speaking", at]);
    }
  }
  for (const [name, at] of marks) if (at !== null) points.push([name, at]);
  points.sort((a, b) => a[1] - b[1]);
  const path = points.map(([name, at]) => `${name} ${seconds(at - base)}`).join(" > ");
  view.turns.push(`  ${label.padEnd(9)} ${path || "nothing"}  (from ${baseName})`);
}

async function greeting(view: CallView, connected: number): Promise<boolean> {
  const { checks, log, watch, short } = view;
  const first = () => watch.lines.findIndex((line) => line.kind === "bot" && line.text !== "");
  await waitFor(() => first() !== -1, TURN_TIMEOUT_MS);
  const done = await waitFor(() => log.settled(log.calledAt), TURN_TIMEOUT_MS);
  const index = first();
  const shownAt = index === -1 ? null : watch.shownAt[index]!;
  checks.add(
    "greeting text",
    shownAt !== null,
    shownAt === null
      ? `no line from ${short} within ${seconds(TURN_TIMEOUT_MS)} of connecting`
      : `${quote(watch.lines[index]!.text)} ${seconds(shownAt - connected)} after connecting`,
  );
  const end = done ?? Date.now();
  const audio = audioCheck(view, connected, end);
  checks.add("greeting audio", audio.pass, `${audio.detail} (from connecting)`);
  stages(
    view,
    "greeting",
    [log.calledAt, end, connected, "connecting"],
    [
      ["text", shownAt],
      ["audible", audio.firstAudible],
    ],
  );
  return shownAt !== null;
}

async function question(view: CallView): Promise<void> {
  const { checks, log, watch } = view;
  const sent = await send(view, QUESTION);
  await waitFor(() => answerTo(watch.lines, QUESTION).answer !== -1, TURN_TIMEOUT_MS);
  const done = await waitFor(() => log.settled(sent), TURN_TIMEOUT_MS);
  const { asked, answer } = answerTo(watch.lines, QUESTION);
  const shownAt = answer === -1 ? null : watch.shownAt[answer]!;
  const end = done ?? Date.now();
  const audio = audioCheck(view, sent, end);
  stages(
    view,
    "reply",
    [sent, end, sent, "sending"],
    [
      ["text", shownAt],
      ["audible", audio.firstAudible],
    ],
  );
  checks.add(
    "reply",
    shownAt !== null && audio.pass,
    asked === -1
      ? "the question never showed as sent"
      : shownAt === null
        ? `no answer within ${seconds(TURN_TIMEOUT_MS)} of sending`
        : `${quote(watch.lines[answer]!.text)} ${seconds(shownAt - sent)} after sending; ` +
          `${audio.detail} (from sending)`,
  );
}

async function selfie(view: CallView): Promise<void> {
  const { checks, log, watch, origin } = view;
  const sent = await send(view, SELFIE_REQUEST);
  const pictures = () => {
    const { asked } = answerTo(watch.lines, SELFIE_REQUEST);
    return asked === -1
      ? undefined
      : watch.lines.find((line, i) => i > asked && line.kind === "selfie");
  };
  const landed = await waitFor(() => {
    const line = pictures();
    return line !== undefined && (line.expired > 0 || line.pictures.some((p) => p.loaded));
  }, SELFIE_TIMEOUT_MS);
  // She may say more once it lands.
  const end = (await waitFor(() => log.settled(sent), 30_000)) ?? Date.now();
  const { answer } = answerTo(watch.lines, SELFIE_REQUEST);
  const message = log.first("server-message", sent, (data) => field(data, "type") === "selfie");
  stages(
    view,
    "selfie",
    [sent, end, sent, "asking"],
    [
      ["message", message?.at ?? null],
      ["picture", landed],
      ["text", answer === -1 ? null : watch.shownAt[answer]!],
      ["audible", log.sound(sent, end).firstAudible],
    ],
  );
  // The bot may leave out function names, depending on its RTVI settings.
  const tool = log.first("llm-function-call-started", sent);
  const name = String(field(tool?.data, "function_name") ?? "a tool");
  const steps =
    (tool ? `${name} called ${seconds(tool.at - sent)}` : "no tool called") +
    (message ? `, its message ${seconds(message.at - sent)} after asking` : ", no selfie message");
  const line = pictures();
  const picture = line?.pictures.find((p) => p.loaded);
  if (landed === null || picture === undefined) {
    const why = line?.expired
      ? "the picture failed to load"
      : `no picture within ${seconds(SELFIE_TIMEOUT_MS)}`;
    checks.add("selfie", false, `${why}; ${steps}`);
    return;
  }
  const url = new URL(picture.src);
  const sameOrigin = url.origin === origin && url.pathname.startsWith("/api/selfie/");
  const [width, height] = picture.box;
  const threeByFour = height > 0 && Math.abs(width / height - 3 / 4) < 0.02;
  checks.add(
    "selfie",
    sameOrigin && threeByFour,
    `${sameOrigin ? url.pathname : `from ${url.origin}${url.pathname}`} ` +
      `${picture.natural[0]}x${picture.natural[1]} in a ${width}x${height} box, ` +
      `${seconds(landed - sent)} after asking; ${steps}`,
  );
}

/** Every bot line shows its markup as chips and notes, or drops it; none shows it as written. */
function markup(view: CallView): void {
  const bot = view.watch.lines.filter((line) => line.kind === "bot");
  if (bot.length === 0) return;
  const raw = bot.filter((line) => RAW_MARKUP.test(line.text));
  const sent = view.log.rtvi.filter(
    (event) => event.type === "bot-output" && RAW_MARKUP.test(String(field(event.data, "text"))),
  ).length;
  const cues = bot.reduce((sum, line) => sum + line.cues, 0);
  const directions = bot.reduce((sum, line) => sum + line.directions, 0);
  view.checks.add(
    "markup",
    raw.length === 0,
    raw.length > 0
      ? `shown as written: ${raw.map((line) => quote(line.text, 60)).join("; ")}`
      : `${sent} bot-output message(s) carried markup; the page shows ${cues} cue chip(s), ` +
          `${directions} direction(s), and no [..] or <tag>`,
  );
}

async function hangUp(view: CallView): Promise<void> {
  const { page, checks } = view;
  const ended = t("en", "Call ended");
  const stateLine = page.getByText(new RegExp(`^${escapeRegExp(ended)}`)).first();
  const again = page.getByRole("button", { name: t("en", "Call Again"), exact: true });
  if (await again.isVisible()) {
    checks.add("hang-up", false, `the call had already ended: ${await alerts(page)}`);
    return;
  }
  const clicked = Date.now();
  await page.getByRole("button", { name: t("en", "Hang Up"), exact: true }).click();
  const shown = await waitFor(
    async () => (await again.isVisible()) && (await stateLine.isVisible()),
    15_000,
  );
  view.timings.push(["Hang up > ended", shown === null ? null : shown - clicked]);
  checks.add(
    "hang-up",
    shown !== null,
    shown === null
      ? `no "${ended}" within 15 s: ${await alerts(page)}`
      : `"${await stateLine.innerText()}" and ${t("en", "Call Again")} ` +
          `${seconds(shown - clicked)} after ${t("en", "Hang Up")}`,
  );
}

async function converse(view: CallView, options: Options): Promise<void> {
  const { page, checks, log } = view;
  const box = messageBox(view);
  const again = page.getByRole("button", { name: t("en", "Call Again"), exact: true });
  log.calledAt = Date.now();
  await page
    .getByRole("button", { name: t("en", "Call {name}", { name: view.short }), exact: true })
    .click();
  // The box shows, disabled, from the click on; a call that fails offers Call again instead.
  const open = async () =>
    (await box.count()) === 1 && (await box.isEnabled({ timeout: 1000 }).catch(() => false));
  const settledAt = await waitFor(
    async () => (await open()) || (await again.isVisible()),
    CONNECT_TIMEOUT_MS,
  );
  const connected = settledAt !== null && (await open()) ? settledAt : null;
  view.timings.push(["Call > connected", connected === null ? null : connected - log.calledAt]);
  checks.add(
    "connected",
    connected !== null,
    connected === null
      ? `not within ${seconds(CONNECT_TIMEOUT_MS)}: ${await alerts(page)}`
      : `the message box opened ${seconds(connected - log.calledAt)} after Call`,
  );
  if (connected === null) return;
  if (await greeting(view, connected)) {
    await question(view);
    if (options.selfie) await selfie(view);
  }
  markup(view);
  const errors = log.rtvi.filter((event) => event.type === "error");
  const botError = t("en", "{name} ran into an error", { name: view.short });
  const shown = await page.getByText(botError, { exact: true }).isVisible();
  checks.add(
    "bot errors",
    errors.length === 0 && !shown,
    errors.length === 0 && !shown
      ? "none reported"
      : `${errors.length} RTVI error(s): ${errors.map((e) => JSON.stringify(e.data)).join("; ")}` +
          (shown ? `; the page shows "${botError}"` : ""),
  );
  await hangUp(view);
}

/** The active persona and what a call needs, from GET status once its probes have answered. */
async function readiness(server: Server, options: Options, checks: Checks): Promise<Status | null> {
  const read = async () =>
    (await (
      await fetch(`${server.origin}/api/local/status`, {
        headers: { authorization: `Bearer ${server.secret}` },
      })
    ).json()) as Status;
  const status = await poll(read, (s) => s.persona.voice.ok !== null, 10_000);
  const missing = status.keys.filter((key) => !key.set).map((key) => key.name);
  const { persona, memory } = status;
  const ready =
    persona.id === PERSONA &&
    missing.length === 0 &&
    persona.voice.id !== null &&
    (!options.selfie || status.selfieReferences > 0);
  const recall = status.index.tables.filter((table) => table.built).length;
  checks.add(
    "ready",
    ready,
    [
      persona.id === PERSONA
        ? `${persona.id} (${persona.name})`
        : `the active persona isn't ${PERSONA}`,
      missing.length === 0 ? "keys set" : `missing ${missing.join(", ")}`,
      persona.voice.id === null
        ? "no voice"
        : `voice from ${persona.voice.source}, ${persona.voice.ok === false ? "unknown to Fish" : "known to Fish"}`,
      !memory.configured
        ? "memory off"
        : memory.ready
          ? "memory on: Zvec stores what she remembers"
          : `memory configured, not ready (${memory.problem ?? "missing key"})`,
      recall === 0 ? "recall off (no index)" : `recall on (${recall} tables)`,
      `${status.selfieReferences} selfie reference(s)`,
    ].join("; "),
  );
  return ready ? status : null;
}

/** The server's warnings and errors, the newest last. */
function serverTrouble(server: Server, lines = 15): string[] {
  return `${server.stdout.text}\n${server.stderr.text}`
    .split("\n")
    .filter((line) => /\| (WARNING|ERROR|CRITICAL) +\|/.test(line))
    .slice(-lines);
}

async function callSmoke(options: Options): Promise<Checks> {
  const checks = new Checks();
  if (!(await buildWeb(checks, true))) return checks;
  const templates = treeHash(join(ROOT, "personas"));
  const run = new Run();
  const env = childEnv(run.home, true);
  try {
    const problem = await callIsolationProblem(env, run.home);
    checks.add(
      "isolation",
      problem === null,
      problem ?? "the server applies the .env and writes only to the temporary home",
    );
    if (problem !== null) return checks;
    const server = await run.boot(env, checks);
    if (server === null) return checks;
    const status = await readiness(server, options, checks);
    if (status === null) return checks;
    const short = status.persona.shortName.trim() || status.persona.name;

    const mic = join(run.temp, "silence.wav");
    writeFileSync(mic, silentWav(1));
    let browser: Browser;
    try {
      browser = await chromium.launch({ ...chrome(), headless: false, args: fakeMicArgs(mic) });
    } catch (error) {
      checks.add("browser", false, error instanceof Error ? error.message.split("\n")[0] : "");
      return checks;
    }
    run.browser = browser;
    const context = await browser.newContext({ locale: "en-US" });
    await context.grantPermissions(["microphone"], { origin: server.origin });
    const log = new CallLog();
    await context.exposeFunction("smokeRtvi", (type: string, data: unknown) => {
      log.addRtvi(type, data);
    });
    await context.exposeFunction("smokeAudio", (playing: boolean, db: number) => {
      log.addAudio(playing, db);
    });
    await context.addInitScript(observeCall, { intervalMs: SAMPLE_MS, floorDb: FLOOR_DB });
    const problems: string[] = [];
    await reportCsp(context, problems);
    const page = await context.newPage();
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console error: ${message.text()}`);
    });
    page.setDefaultTimeout(20_000);

    // The link code works on any path: the page trades it for the cookie and drops the fragment.
    await page.goto(`${server.origin}/call${new URL(server.link).hash}`);
    const start = page.getByRole("button", {
      name: t("en", "Call {name}", { name: short }),
      exact: true,
    });
    const opened = await shows(start);
    const url = new URL(page.url());
    checks.add(
      "call page",
      opened && url.pathname === "/call" && url.hash === "",
      `signed in on ${url.pathname}${url.hash ? " with the fragment left" : ""}; ` +
        (opened ? `${t("en", "Call {name}", { name: short })} shows` : await alerts(page)),
    );
    if (opened) {
      const labels: Labels = {
        you: `${t("en", "You", {}, "call transcript speaker")}: `,
        bot: `${short}: `,
        expired: t("en", "This photo has expired"),
      };
      const watch = new TranscriptWatch(page, labels);
      const view: CallView = {
        page,
        origin: server.origin,
        checks,
        log,
        watch,
        short,
        timings: [],
        turns: [],
      };
      try {
        await checks.step("call", () => converse(view, options));
      } finally {
        await watch.stop();
      }
      checks.notes.push("transcript");
      for (const [i, line] of watch.lines.entries()) {
        const at = `+${seconds(watch.shownAt[i]! - log.calledAt)}`.padStart(9);
        const who =
          line.kind === "you"
            ? t("en", "You", {}, "call transcript speaker")
            : line.kind === "bot"
              ? short
              : "selfie";
        const text =
          line.kind !== "selfie"
            ? line.text
            : [
                ...line.pictures.map(
                  (p) => `${new URL(p.src).pathname} ${p.natural[0]}x${p.natural[1]}`,
                ),
                ...(line.expired > 0 ? [`${line.expired} expired`] : []),
              ].join(", ");
        checks.notes.push(`  ${at}  ${who}  ${text}`);
      }
      checks.notes.push(
        `timings  ${view.timings
          .map(([label, ms]) => `${label} ${ms === null ? "n/a" : seconds(ms)}`)
          .join(" | ")}`,
        ...view.turns,
      );
    }
    checks.add(
      "page health",
      problems.length === 0,
      problems.length === 0
        ? "no page errors, console errors or CSP violations"
        : problems.slice(0, 3).join("; "),
    );
    if (!checks.pass) {
      const counts = new Map<string, number>();
      for (const event of log.rtvi) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      checks.notes.push(
        `rtvi     ${[...counts].map(([type, n]) => `${type} ${n}`).join(", ") || "none"}`,
      );
      for (const line of serverTrouble(server)) checks.notes.push(`server   ${line}`);
    }
    const code = await run.stop();
    checks.add("shutdown", code === 0, `the server exited ${String(code)}`);
  } finally {
    await run.end(checks, templates);
  }
  return checks;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === PROBE_FLAG && argv[1] !== undefined) {
    await probeEnv(argv[1]);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const checks = options.call ? await callSmoke(options) : await smoke(options);
  const how = options.call
    ? `call${options.selfie ? " + selfie" : ""}  headful`
    : `${options.headful ? "headful" : "headless"}  ${options.offline ? "offline" : "online"}`;
  console.log(`\nlocal smoke  ${how}`);
  for (const check of checks.list) {
    console.log(`  ${check.pass ? "PASS" : "FAIL"}  ${check.name.padEnd(16)} ${check.detail}`);
  }
  for (const note of checks.notes) console.log(note);
  console.log(checks.pass ? "PASS" : "FAIL");
  return checks.pass ? 0 : 1;
}

process.exit(
  await main().catch((error) => {
    console.error(error);
    return 1;
  }),
);
