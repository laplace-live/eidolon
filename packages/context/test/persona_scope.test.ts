import "../../config/test/isolated-guard.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataHome, type LogRecord, resetSettings, withPersona } from "@eidolon/config";
import {
  buildSystemInstruction,
  GATE_QUESTIONS,
  gateQuestions,
  gateStreamer,
  getRecentStreamDates,
} from "../src/index.ts";
import { captureLogs, deferred, resetEnv, setEnv } from "./helpers.ts";

let logs: { records: LogRecord[]; restore: () => void };
beforeEach(() => {
  logs = captureLogs();
  setEnv("LANCEDB_PATH", undefined);
  setEnv("PERSONA_FILE", undefined);
});
afterEach(() => {
  logs.restore();
  resetEnv();
  resetSettings();
  rmSync(dataHome(), { recursive: true, force: true });
});

function write(rel: string, text: string): void {
  const path = join(dataHome(), rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("two personas in one process", () => {
  test("each reads her own index's recent stream dates, cached apart", async () => {
    write("personas/alice/persona.yaml", "identity:\n  name: Alice\n");
    write("personas/bob/persona.yaml", "identity:\n  name: Bob\nknowledge:\n  index: bob-index\n");
    const aliceIndex = join(dataHome(), "personas", "alice", "index");
    const bobIndex = join(dataHome(), "personas", "bob", "bob-index");
    const aliceScan = deferred<string[]>();
    const scanned: string[] = [];
    const scan = (path: string): Promise<string[]> => {
      scanned.push(path);
      return path === aliceIndex
        ? aliceScan.promise
        : Promise.resolve(["2026-09-01", "2026-09-03"]);
    };
    const read = (id: string) => withPersona(id, () => getRecentStreamDates({ scan }));

    const alice = read("alice");
    const bob = read("bob");
    // A shared entry would park Bob behind Alice's open scan instead.
    expect(scanned).toEqual([aliceIndex, bobIndex]);
    expect(await bob).toEqual(["2026-09-03", "2026-09-01"]);
    aliceScan.resolve(["2026-09-08", "2026-09-02"]);
    expect(await alice).toEqual(["2026-09-08", "2026-09-02"]);

    expect(await read("bob")).toEqual(["2026-09-03", "2026-09-01"]);
    expect(await read("alice")).toEqual(["2026-09-08", "2026-09-02"]);
    expect(scanned).toHaveLength(2);
  });

  test("each gets her own system instruction and gate texts", async () => {
    write(
      "personas/carol/persona.yaml",
      "identity:\n  name: Carol\n  fans: 小鱼干\n  summary: Carol, who keeps an aquarium\n" +
        "  viewerLine: 来喂鱼的{fans}叫「{viewer}」（UID:{uid}）。\n  timezone: UTC\n" +
        "knowledge:\n  gate:\n    questions:\n      about_her: Is the viewer asking about Carol?\n",
    );
    write("personas/carol/prompt.md", "Carol 的人设\n");
    write(
      "personas/dave/persona.yaml",
      "identity:\n  name: Dave\n  fans: 豆子\n  summary: Dave, who bakes\n" +
        "  timezone: Asia/Shanghai\n",
    );
    write("personas/dave/prompt.md", "Dave 的人设\n");
    const instruction = (id: string) =>
      withPersona(id, () =>
        buildSystemInstruction({
          viewer: { isLoggedIn: true, uname: "小明", mid: 123 },
          voiceHint: "",
          selfieHint: "",
          now: new Date("2026-09-08T23:05:00Z"),
        }),
      );
    const viewerTail = "聊天里可以自然地叫她/他的名字，但不要每句都重复，也不要主动念UID。";

    const [carol, dave] = await Promise.all([instruction("carol"), instruction("dave")]);
    expect(carol).toBe(
      "现在是 2026年9月8日 周二 23:05。如果用户问到时间或日期，根据这里的事实回答；不要主动念时间，除非话题相关。\n" +
        `来喂鱼的小鱼干叫「小明」（UID:123）。${viewerTail}\n\nCarol 的人设`,
    );
    expect(dave).toBe(
      "现在是 2026年9月9日 周三 07:05。如果用户问到时间或日期，根据这里的事实回答；不要主动念时间，除非话题相关。\n" +
        `正在和你聊天的豆子叫「小明」（UID:123）。${viewerTail}\n\nDave 的人设`,
    );

    expect(withPersona("carol", gateStreamer)).toBe("Carol, who keeps an aquarium");
    expect(withPersona("dave", gateStreamer)).toBe("Dave, who bakes");
    expect(withPersona("carol", () => gateQuestions().about_her.instructions)).toBe(
      "Is the viewer asking about Carol?",
    );
    expect(withPersona("dave", () => gateQuestions().about_her.instructions)).toBe(
      GATE_QUESTIONS.about_her.instructions,
    );
    expect(gateStreamer()).toContain("明前奶绿");
  });
});
