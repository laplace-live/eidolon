import { expect, mock, test } from "bun:test";
import { linguiMacro } from "@/test/lingui-macro";

mock.module("@lingui/core/macro", linguiMacro);
const { describeEvent, reasonText, stageName } = await import("./describe");

test("a code becomes its sentence, naming the provider it is about", () => {
  expect(reasonText(null)).toBeNull();
  expect(reasonText("disk-full")).toBe("The disk is full.");
  expect(reasonText("auth-failed", "soniox")).toBe("Soniox: The provider refused the API key.");
});

test("a stage the CLI may add later shows as its code", () => {
  expect(stageName("refine")).toBe("Refine");
  expect(stageName("translate")).toBe("translate");
});

test("a stage line says how many it goes through, and why it failed", () => {
  const start = describeEvent("en", {
    type: "stage",
    stage: "download",
    status: "start",
    total: 3,
  });
  expect(start).toEqual({ text: "Download started: 3 to go", detail: null, tone: "info" });
  const failed = describeEvent("en", {
    type: "stage",
    stage: "refine",
    status: "failed",
    code: "insufficient-credits",
    message: "HTTP 402",
  });
  expect(failed.text).toBe("Refine failed · The provider account is out of credit.");
  expect([failed.detail, failed.tone]).toEqual(["HTTP 402", "error"]);
});

test("an item line carries its place, its reason, and the CLI's English only as detail", () => {
  const line = describeEvent("en", {
    type: "item",
    stage: "transcribe",
    item: "a.m4a",
    status: "done",
    index: 2,
    total: 5,
    code: "no-speech",
    message: "no speech",
    costUsd: 0.5,
  });
  expect(line).toEqual({
    text: "[2/5] a.m4a: done · No speech was heard in this audio.",
    detail: "no speech · $0.50",
    tone: "ok",
  });
});

test("a summary says how the run ended and lists its failures", () => {
  const line = describeEvent("en", {
    type: "summary",
    stage: "pipeline",
    ok: false,
    counts: {},
    durationSec: 65,
    failures: [{ item: "transcribe", error: "2 files failed" }],
  });
  expect(line).toEqual({
    text: "Pipeline ended with failures after 1:05",
    detail: "transcribe: 2 files failed",
    tone: "error",
  });
});
