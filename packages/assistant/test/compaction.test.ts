import { describe, expect, test } from "bun:test";
import { COMPACTION_INSTRUCTIONS, COMPACTION_SYSTEM } from "../src/compaction.ts";

describe("compaction", () => {
  test("the system prompt asks for the summary alone", () => {
    expect(COMPACTION_SYSTEM).toStartWith("You are a context summarization assistant.");
    expect(COMPACTION_SYSTEM).toEndWith("ONLY output the structured summary.");
  });

  test("the instructions ask for pi's sections, in order, and fold a previous summary in", () => {
    const headings = COMPACTION_INSTRUCTIONS.split("\n").filter((line) => line.startsWith("#"));
    expect(headings).toEqual([
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "### Done",
      "### In Progress",
      "### Blocked",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ]);
    expect(COMPACTION_INSTRUCTIONS).toContain("<previous-summary>");
    expect(COMPACTION_INSTRUCTIONS).toContain(
      "- PRESERVE all existing information from the previous summary",
    );
  });
});
