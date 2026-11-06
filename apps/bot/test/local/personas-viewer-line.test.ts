// The local viewer's line in the persona prefix: identity.localViewerLine, which names no UID,
// while a Bilibili viewer's line stays byte for byte what production sends.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, installSettings, resetSettings } from "@eidolon/config";
import { buildPersonaPrefix, type Viewer } from "@eidolon/context";
import { localViewer } from "../../src/local/identity.ts";

const NOW = new Date("2026-09-08T23:05:00Z");
const CLOCK =
  "现在是 2026年9月9日 周三 07:05。如果用户问到时间或日期，根据这里的事实回答；" +
  "不要主动念时间，除非话题相关。";
const NAMING = "聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。";
const BILIBILI: Viewer = { isLoggedIn: true, uname: "小明", mid: 123 };

function prefix(viewer: Viewer): string {
  return buildPersonaPrefix({ viewer, timeZone: "Asia/Shanghai", now: NOW, recentStreamDates: [] });
}

function persona(yaml: string): void {
  const dir = join(dataHome(), "personas", "milky-green");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.yaml"), yaml);
  resetSettings();
  installSettings();
}

beforeEach(() => {
  process.env.EIDOLON_LOCAL_VIEWER_NAME = "小明";
  installSettings();
});

afterEach(() => {
  delete process.env.EIDOLON_LOCAL_VIEWER_NAME;
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

describe("the viewer line", () => {
  test("the local viewer gets the persona's local line, which names no UID", () => {
    expect(prefix(localViewer())).toBe(`${CLOCK}\n今天来花店的奶糖花叫「小明」。${NAMING}\n\n`);
  });

  test("a Bilibili viewer's line is production's, UID and all", () => {
    expect(prefix(BILIBILI)).toBe(
      `${CLOCK}\n今天来花店的奶糖花叫「小明」（B站UID:123）。${NAMING}\n\n`,
    );
  });

  test("without a localViewerLine the default applies; an empty one leaves the line out", () => {
    persona("identity:\n  name: 小绿\n  fans: 星星\n");
    expect(prefix(localViewer())).toBe(`${CLOCK}\n正在和你聊天的星星叫「小明」。${NAMING}\n\n`);
    expect(prefix(BILIBILI)).toBe(
      `${CLOCK}\n正在和你聊天的星星叫「小明」（UID:123）。${NAMING}\n\n`,
    );
    persona('identity:\n  fans: 星星\n  localViewerLine: ""\n');
    expect(prefix(localViewer())).toBe(`${CLOCK}\n\n`);
    expect(prefix(BILIBILI)).toContain("（UID:123）");
  });

  test("a local viewer without a name gets no line", () => {
    delete process.env.EIDOLON_LOCAL_VIEWER_NAME;
    expect(prefix(localViewer())).toBe(`${CLOCK}\n\n`);
  });
});
