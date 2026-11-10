import { afterEach, expect, test } from "bun:test";
import { openStt, spokenLanguage, sttLanguage } from "../../src/stt/index.ts";
import { defaultSelection, live } from "./fake.ts";

const NAMES = [
  "STT_PROVIDER",
  "STT_LANGUAGE",
  "TRANSCRIBE_LANGUAGE",
  "SONIOX_API_KEY",
  "DEEPGRAM_API_KEY",
];
const saved = new Map(NAMES.map((name) => [name, process.env[name]]));

function setEnv(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => setEnv(Object.fromEntries(saved)));

test("throws the missing key before connecting anywhere", async () => {
  setEnv({ STT_PROVIDER: "soniox", SONIOX_API_KEY: "" });
  await expect(openStt(live())).rejects.toThrow(
    "Soniox needs an API key: set SONIOX_API_KEY in credentials.json or the environment",
  );
});

test("hears her language, her videos' when she names none, and detects it for none", () => {
  setEnv({ STT_LANGUAGE: undefined, TRANSCRIBE_LANGUAGE: undefined });
  const deepgram = defaultSelection("deepgram", "DEEPGRAM_API_KEY");
  expect(spokenLanguage()).toBe("zh");
  expect(sttLanguage(deepgram)).toBe("zh");
  setEnv({ TRANSCRIBE_LANGUAGE: "ja" });
  expect(sttLanguage(deepgram)).toBe("ja");
  setEnv({ STT_LANGUAGE: " en " });
  expect(sttLanguage(deepgram)).toBe("en");
  setEnv({ STT_LANGUAGE: "None" });
  expect(sttLanguage(deepgram)).toBeNull();
  setEnv({ STT_LANGUAGE: "" });
  expect(sttLanguage(deepgram)).toBe("ja");
});

test("Soniox detects the language unless STT_LANGUAGE names one", () => {
  const soniox = defaultSelection("soniox", "SONIOX_API_KEY");
  setEnv({ STT_LANGUAGE: undefined, TRANSCRIBE_LANGUAGE: "ja" });
  expect(sttLanguage(soniox)).toBeNull();
  setEnv({ STT_LANGUAGE: "en" });
  expect(sttLanguage(soniox)).toBe("en");
  setEnv({ STT_LANGUAGE: "none" });
  expect(sttLanguage(soniox)).toBeNull();
});
