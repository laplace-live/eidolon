import { describe, expect, test } from "bun:test";
import { readRtvi, rtviMessage } from "../../src/rtvi/codec.ts";

const msg = (type: string, data?: unknown, id: unknown = "m1") => ({
  label: "rtvi-ai",
  type,
  id,
  ...(data === undefined ? {} : { data }),
});

describe("rtviMessage", () => {
  test("orders the envelope label, type, id, data and leaves out what isn't set", () => {
    expect(JSON.stringify(rtviMessage("bot-llm-started"))).toBe(
      '{"label":"rtvi-ai","type":"bot-llm-started"}',
    );
    expect(JSON.stringify(rtviMessage("error-response", { error: "x" }, "7"))).toBe(
      '{"label":"rtvi-ai","type":"error-response","id":"7","data":{"error":"x"}}',
    );
  });
});

describe("readRtvi", () => {
  test("anything that isn't an rtvi-ai object is foreign", () => {
    for (const message of [null, "ping", 3, [], { type: "client-ready", id: "1" }]) {
      expect(readRtvi(message)).toEqual({ type: "foreign" });
    }
    expect(readRtvi({ ...msg("client-ready"), label: "other" })).toEqual({ type: "foreign" });
  });

  test("a broken envelope is malformed, in pydantic's words", () => {
    expect(readRtvi({ label: "rtvi-ai", type: "send-text" })).toEqual({
      type: "malformed",
      error: "Invalid RTVI transport message: 1 validation error for Message\nid\n  Field required",
    });
    expect(readRtvi({ label: "rtvi-ai", type: 5, data: "x" })).toEqual({
      type: "malformed",
      error:
        "Invalid RTVI transport message: 3 validation errors for Message\n" +
        "type\n  Input should be a valid string\n" +
        "id\n  Field required\n" +
        "data\n  Input should be a valid dictionary",
    });
  });

  test("client-ready from a 2.x client carries no version error", () => {
    expect(readRtvi(msg("client-ready", { version: "2.3.0", about: {} }))).toEqual({
      type: "client-ready",
      id: "m1",
      versionError: null,
    });
    expect(readRtvi(msg("client-ready", { version: " 2. 0 .+1" }))).toMatchObject({
      versionError: null,
    });
  });

  test("client-ready with another major or a bad version gets pipedog's warnings", () => {
    const errorOf = (data: unknown) => {
      const read = readRtvi(msg("client-ready", data));
      return read.type === "client-ready" ? read.versionError : read;
    };
    expect(errorOf({ version: "3.0.0" })).toBe(
      "RTVI version 3.0.0 is not compatible with server protocol 2.2.0. Compatibility issues may occur.",
    );
    // pipedog served 1.x clients a legacy bot-output; this server speaks 2.x only.
    expect(errorOf({ version: "1.4.0" })).toBe(
      "RTVI version 1.4.0 is not compatible with server protocol 2.2.0. Compatibility issues may occur.",
    );
    for (const version of ["2.0", "2.x.0", "2.0.0.0", "v2.0.0"]) {
      expect(errorOf({ version })).toBe(
        `Invalid client version format (${version}). Compatibility issues may occur.`,
      );
    }
    for (const data of [undefined, null, {}, { version: "" }, { version: 2 }]) {
      expect(errorOf(data)).toBe("Client version unknown. Compatibility issues may occur.");
    }
  });

  test("send-text runs at once and speaks unless its options say otherwise", () => {
    expect(readRtvi(msg("send-text", { content: "hi" }))).toEqual({
      type: "send-text",
      id: "m1",
      content: "hi",
      runImmediately: true,
      audioResponse: true,
    });
    expect(
      readRtvi(
        msg("send-text", {
          content: "hi",
          options: { run_immediately: false, audio_response: false },
        }),
      ),
    ).toMatchObject({ runImmediately: false, audioResponse: false });
    expect(readRtvi(msg("send-text", { content: "hi", options: null }))).toMatchObject({
      runImmediately: true,
      audioResponse: true,
    });
  });

  test("invalid send-text is rejected with its validation errors", () => {
    expect(readRtvi(msg("send-text"))).toEqual({
      type: "rejected",
      id: "m1",
      error:
        "Invalid message: 1 validation error for SendTextData\n\n" +
        "  Input should be a valid dictionary or instance of SendTextData",
    });
    expect(readRtvi(msg("send-text", { options: { run_immediately: null } }))).toEqual({
      type: "rejected",
      id: "m1",
      error:
        "Invalid message: 2 validation errors for SendTextData\n" +
        "content\n  Field required\n" +
        "options.run_immediately\n  Input should be a valid boolean",
    });
    expect(readRtvi(msg("send-text", { content: "hi", options: [] }))).toMatchObject({
      type: "rejected",
      error:
        "Invalid message: 1 validation error for SendTextData\n" +
        "options\n  Input should be a valid dictionary or instance of SendTextOptions",
    });
  });

  test("disconnect-bot and client-message pass through", () => {
    expect(readRtvi(msg("disconnect-bot"))).toEqual({ type: "disconnect-bot", id: "m1" });
    expect(readRtvi(msg("client-message", { t: "ping" }))).toEqual({
      type: "client-message",
      id: "m1",
      t: "ping",
      d: null,
    });
    expect(readRtvi(msg("client-message", { d: 1 }))).toEqual({
      type: "rejected",
      id: "m1",
      error: "Invalid message: 1 validation error for RawClientMessageData\nt\n  Field required",
    });
  });

  test("every other type is unsupported, those pipedog took included", () => {
    for (const type of [
      "send-file",
      "raw-audio",
      "raw-audio-batch",
      "dtmf",
      "llm-function-call-result",
      "ui-event",
      "ui-snapshot",
      "ui-cancel-job-group",
      "describe-config",
    ]) {
      expect(readRtvi(msg(type, {}))).toEqual({
        type: "rejected",
        id: "m1",
        error: `Unsupported type ${type}`,
      });
    }
  });
});
