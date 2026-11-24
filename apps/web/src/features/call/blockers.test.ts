import { expect, test } from "vitest";
import type { Status } from "@/lib/api";
import { callBlocker } from "./blockers";

type Ready = Pick<Status, "keys" | "call" | "persona">;

const READY = {
  keys: [
    { account: "soniox", name: "Soniox", provider: "soniox", roles: ["hearing"], set: true },
    {
      account: "openrouter",
      name: "OpenRouter",
      provider: "openrouter",
      roles: ["mind"],
      set: true,
    },
  ],
  call: {
    realtime: false,
    roles: [{ role: "mind", provider: "openrouter", model: "a-model", problem: null }],
  },
  persona: { voice: { id: "a-voice" } },
} as unknown as Ready;

const NO_KEY = { ...READY, keys: [READY.keys[0], { ...READY.keys[1], set: false }] } as Ready;
const BAD_ROLE = {
  ...READY,
  call: { ...READY.call, roles: [{ ...READY.call.roles[0], problem: "No model is chosen." }] },
} as Ready;
const NO_VOICE = { ...READY, persona: { voice: { id: null } } } as unknown as Ready;

test("a ready status calls", () => {
  expect(callBlocker(READY)).toBeNull();
});

test("each blocker alone", () => {
  expect(callBlocker(NO_KEY)).toBe("keys");
  expect(callBlocker(BAD_ROLE)).toBe("roles");
  expect(callBlocker(NO_VOICE)).toBe("voice");
});

test("keys come before roles, and roles before her voice", () => {
  expect(callBlocker({ ...BAD_ROLE, keys: NO_KEY.keys, persona: NO_VOICE.persona })).toBe("keys");
  expect(callBlocker({ ...BAD_ROLE, persona: NO_VOICE.persona })).toBe("roles");
});

test("a realtime call needs no voice of hers", () => {
  expect(callBlocker({ ...NO_VOICE, call: { ...READY.call, realtime: true } })).toBeNull();
});
