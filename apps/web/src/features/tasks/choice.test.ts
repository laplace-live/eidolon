import { describe, expect, test } from "vitest";
import type { TaskPending } from "@/lib/api";
import { approveBody, chosenModel, WEB_MODES } from "./choice";

const base = { account: "openrouter", model: "anthropic/claude-sonnet-5.5" };

describe("chosenModel", () => {
  test("the task's own model unless another is picked", () => {
    expect(chosenModel({ account: "", model: "" }, base)).toBeNull();
    expect(chosenModel({ account: "openrouter", model: "" }, base)).toBeNull();
    expect(chosenModel({ account: "", model: base.model }, base)).toBeNull();
  });

  test("another model on its account, or another account with a model of its own", () => {
    expect(chosenModel({ account: "", model: " deepseek/v4 " }, base)).toEqual({
      account: "openrouter",
      model: "deepseek/v4",
    });
    expect(chosenModel({ account: "openai", model: "gpt-6" }, base)).toEqual({
      account: "openai",
      model: "gpt-6",
    });
  });

  test("another account needs a model named: the task's is another provider's", () => {
    expect(chosenModel({ account: "openai", model: "" }, base)).toBe("missing");
    expect(chosenModel({ account: "openai", model: "  " }, base)).toBe("missing");
  });
});

test("the web access choices, asking for each site first", () => {
  expect(WEB_MODES).toEqual(["ask", "any", "off"]);
});

describe("approveBody", () => {
  const start = { pending: { kind: "start" } as TaskPending, model: base, web: undefined };
  const unchanged = { account: "", model: "" };

  test("a start's answer carries a model or web access only where they changed", () => {
    expect(approveBody("once", start, unchanged, "ask")).toEqual({
      answer: "once",
      pending: { kind: "start" },
    });
    expect(approveBody("always", start, { account: "openai", model: "gpt-6" }, "off")).toEqual({
      answer: "always",
      pending: { kind: "start" },
      model: { account: "openai", model: "gpt-6" },
      web: "off",
    });
    expect(
      approveBody(
        "once",
        { ...start, web: { mode: "any", hosts: [], denied: [] } },
        unchanged,
        "any",
      ),
    ).toEqual({ answer: "once", pending: { kind: "start" } });
  });

  test("Deny, and a path's or a site's answer, carry the answer and the question alone", () => {
    expect(approveBody("deny", start, { account: "openai", model: "gpt-6" }, "off")).toEqual({
      answer: "deny",
      pending: { kind: "start" },
    });
    const path = { ...start, pending: { kind: "path", path: "/x", access: "read" } as const };
    expect(approveBody("once", path, { account: "openai", model: "gpt-6" }, "off")).toEqual({
      answer: "once",
      pending: { kind: "path", path: "/x", access: "read" },
    });
  });

  test("a command's or a tool call's answer names its call, so it can't allow a later one", () => {
    const command = {
      ...start,
      pending: { kind: "command", call: "c7", command: "npm test", timeout: 120 } as const,
    };
    for (const answer of ["once", "always", "deny"] as const) {
      expect(approveBody(answer, command, { account: "openai", model: "gpt-6" }, "off")).toEqual({
        answer,
        pending: { kind: "command", call: "c7", command: "npm test", timeout: 120 },
      });
    }
    const mcp: TaskPending = {
      kind: "mcp",
      server: "github",
      tool: "create_issue",
      call: "c8",
      key: "0123456789abcdef0123456789abcdef",
      args: [{ name: "title", head: "Bug", chars: 3, lines: 1 }],
    };
    expect(approveBody("always", { ...start, pending: mcp }, unchanged, "ask")).toEqual({
      answer: "always",
      pending: mcp,
    });
  });

  test("no answer allows a start on an account with no model named", () => {
    expect(approveBody("once", start, { account: "openai", model: "" }, "ask")).toBeNull();
    expect(approveBody("deny", start, { account: "openai", model: "" }, "ask")).toEqual({
      answer: "deny",
      pending: { kind: "start" },
    });
  });
});
