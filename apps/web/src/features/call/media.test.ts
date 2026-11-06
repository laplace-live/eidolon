import { describe, expect, test } from "bun:test";
import { deviceProblemOf, micProblemOf, probeMic } from "./media";

const named = (name: string) => Object.assign(new Error(name), { name });

describe("micProblemOf", () => {
  test("names the problem from the browser's error", () => {
    expect(micProblemOf(named("NotAllowedError"))).toBe("denied");
    expect(micProblemOf(named("SecurityError"))).toBe("denied");
    expect(micProblemOf(named("NotReadableError"))).toBe("busy");
    expect(micProblemOf(named("NotFoundError"))).toBe("missing");
    expect(micProblemOf(named("OverconstrainedError"))).toBe("missing");
  });

  test("anything else is unknown", () => {
    expect(micProblemOf(named("AbortError"))).toBe("unknown");
    expect(micProblemOf("NotAllowedError")).toBe("unknown");
    expect(micProblemOf(null)).toBe("unknown");
  });
});

describe("deviceProblemOf", () => {
  test("prefers the browser's error the media manager attached", () => {
    const blocked = { type: "unknown", details: { sourceError: named("NotAllowedError") } };
    expect(deviceProblemOf(blocked)).toBe("denied");
    const busy = { type: "permissions", details: { sourceError: named("NotReadableError") } };
    expect(deviceProblemOf(busy)).toBe("busy");
  });

  test("falls back to the error's own type", () => {
    expect(deviceProblemOf({ type: "in-use" })).toBe("busy");
    expect(deviceProblemOf({ type: "undefined-mediadevices" })).toBe("insecure");
    expect(deviceProblemOf({ type: "constraints", details: { sourceError: named("X") } })).toBe(
      "missing",
    );
    expect(deviceProblemOf({ type: "unknown" })).toBe("unknown");
  });
});

describe("probeMic", () => {
  test("a working mic is opened once and released", async () => {
    const stopped: string[] = [];
    const track = { stop: () => stopped.push("audio") };
    const requests: unknown[] = [];
    const media = {
      getUserMedia: async (constraints?: MediaStreamConstraints) => {
        requests.push(constraints);
        return { getTracks: () => [track] } as unknown as MediaStream;
      },
    };
    expect(await probeMic(media)).toBeNull();
    expect(requests).toEqual([{ audio: true }]);
    expect(stopped).toEqual(["audio"]);
  });

  test("a refusal says why", async () => {
    const media = {
      getUserMedia: async (): Promise<MediaStream> => {
        throw named("NotReadableError");
      },
    };
    expect(await probeMic(media)).toBe("busy");
  });

  test("no mediaDevices means an insecure page", async () => {
    expect(await probeMic(undefined)).toBe("insecure");
  });
});
