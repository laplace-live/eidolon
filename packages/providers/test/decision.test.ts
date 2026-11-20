import { describe, expect, test } from "vitest";
import {
  decisionModel,
  missingKey,
  OPENROUTER_DECISIONS_URL,
  select,
  setUsageSink,
  type UsageRecord,
} from "../src/index.ts";

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name] || undefined;

interface Sent {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

function answering(answers: unknown, sent: Sent[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return Response.json({
      model: "typesafe/jev-1.14",
      answers,
      usage: { input_tokens: 90, output_tokens: 3, cost: 0.00001 },
    });
  }) as unknown as typeof fetch;
}

describe("decision models", () => {
  test("the gate role's OpenRouter account asks its Decisions route beside its v1 API", async () => {
    const read = reader({
      OPENROUTER_API_KEY: "or",
      OPENROUTER_API_BASE: "https://proxy.example.com/api/v1/",
      RETRIEVAL_GATE_MODEL: "typesafe/jev-1.13",
    });
    const selection = select("gate", read);
    if (selection === null) throw new Error("the gate role is on by default");
    const sent: Sent[] = [];
    const records: UsageRecord[] = [];
    setUsageSink((record) => records.push(record));
    try {
      const model = decisionModel(selection, {
        timeoutSec: 5,
        fetch: answering({ about_her: { type: "noul", noul: 0.75 } }, sent),
      });
      const questions = { about_her: { type: "noul" as const, instructions: "About her?" } };
      const answers = await model.decide({ viewer_latest_message: "你几岁" }, questions);
      expect(answers.probability("about_her")).toBe(0.75);
      expect(() => answers.probability("her_past")).toThrow(/^her_past$/);
      expect([model.provider, model.model]).toEqual(["openrouter", "typesafe/jev-1.13"]);
    } finally {
      setUsageSink(null);
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://proxy.example.com/api/alpha/decisions");
    expect(sent[0]?.headers.Authorization).toBe("Bearer or");
    expect(sent[0]?.body).toEqual({
      model: "typesafe/jev-1.13",
      state: { viewer_latest_message: "你几岁" },
      questions: { about_her: { type: "noul", instructions: "About her?" } },
    });
    expect(records.map(({ role, provider, model }) => ({ role, provider, model }))).toEqual([
      { role: "gate", provider: "openrouter", model: "typesafe/jev-1.14" },
    ]);
  });

  test("the default route is OpenRouter's own, and a role without its key asks nothing", () => {
    const keyed = select("gate", reader({ OPENROUTER_API_KEY: "or" }));
    expect(keyed?.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(OPENROUTER_DECISIONS_URL).toBe("https://openrouter.ai/api/alpha/decisions");
    const keyless = select("gate", reader({}));
    if (keyless === null) throw new Error("the gate role is on by default");
    expect(() => decisionModel(keyless, { timeoutSec: 5 })).toThrow(missingKey(keyless).message);
  });
});
