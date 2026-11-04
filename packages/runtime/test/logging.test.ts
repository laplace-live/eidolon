import { afterEach, describe, expect, test } from "bun:test";
import { consoleSink, type LogRecord, logger } from "@eidolon/config";
import { logger as pipedogLogger } from "@pipedog/core/utils/logger";
import { configureLogging } from "../src/logging.ts";

afterEach(() => {
  logger.setSink(consoleSink);
  configureLogging({ level: "DEBUG" });
});

function capture(): LogRecord[] {
  const records: LogRecord[] = [];
  logger.setSink((record) => records.push(record));
  return records;
}

describe("configureLogging", () => {
  test("pipedog's records reach @eidolon/config's sinks with their level and error", () => {
    configureLogging({ level: "TRACE" });
    const records = capture();
    const error = new Error("boom");
    pipedogLogger.trace("deep");
    pipedogLogger.warning("careful");
    pipedogLogger.error("failed", error);
    expect(records.map((r) => [r.level, r.message])).toEqual([
      ["TRACE", "deep"],
      ["WARNING", "careful"],
      ["ERROR", "failed"],
    ]);
    expect((records[2]?.error as Error | undefined)?.message).toBe("boom");
    expect(records[0]?.error).toBeUndefined();
  });

  test("sets both loggers' level", () => {
    configureLogging({ level: "INFO" });
    const records = capture();
    pipedogLogger.debug("pipedog debug");
    logger.debug("config debug");
    pipedogLogger.info("pipedog info");
    logger.info("config info");
    expect(records.map((r) => r.message)).toEqual(["pipedog info", "config info"]);
    expect(pipedogLogger.isEnabledFor("DEBUG")).toBe(false);
    expect(logger.isEnabledFor("DEBUG")).toBe(false);
  });

  test("calling it again keeps one route, not two", () => {
    configureLogging({ level: "DEBUG" });
    configureLogging({ level: "DEBUG" });
    const records = capture();
    pipedogLogger.info("once");
    expect(records.map((r) => r.message)).toEqual(["once"]);
  });
});
