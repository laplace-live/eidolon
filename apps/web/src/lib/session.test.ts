import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { proofHeaders } from "./proof";
import { exchangeLinkCode, linkCodeIn, takeLinkCode } from "./session";

afterEach(() => {
  mock.restore();
});

const CODE = "1762300000.Qm9vdHN0cmFwLWxpbmstY29kZS1ITUFDLXNoYTI1Ng_-";

describe("linkCodeIn", () => {
  test("finds the code in a printed link, a fragment or on its own", () => {
    expect(linkCodeIn(`http://localhost:7860/#${CODE}`)).toBe(CODE);
    expect(linkCodeIn(`  http://127.0.0.1:5173/setup?x=1#${CODE}\n`)).toBe(CODE);
    expect(linkCodeIn(`#${CODE}`)).toBe(CODE);
    expect(linkCodeIn(CODE)).toBe(CODE);
  });

  test("refuses anything else", () => {
    for (const text of ["", "#", "http://localhost:7860/", "#section", "abc.def", "123", "1.a b"]) {
      expect(linkCodeIn(text)).toBeNull();
    }
  });
});

describe("takeLinkCode", () => {
  function fakeHistory() {
    const calls: unknown[][] = [];
    return {
      calls,
      state: { idx: 0 },
      replaceState: (...args: unknown[]) => {
        calls.push(args);
      },
    };
  }

  test("takes the code and drops the fragment, keeping the path, query and history state", () => {
    const history = fakeHistory();
    const code = takeLinkCode({ hash: `#${CODE}`, pathname: "/call", search: "?a=1" }, history);
    expect(code).toBe(CODE);
    expect(history.calls).toEqual([[{ idx: 0 }, "", "/call?a=1"]]);
  });

  test("leaves the address bar alone without a code", () => {
    const history = fakeHistory();
    expect(takeLinkCode({ hash: "", pathname: "/", search: "" }, history)).toBeNull();
    expect(takeLinkCode({ hash: "#faq", pathname: "/", search: "" }, history)).toBeNull();
    expect(history.calls).toEqual([]);
  });
});

describe("exchangeLinkCode", () => {
  test("keeps the proof the server answers with, for every later request", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, proof: "p-1" }));
    expect(await exchangeLinkCode(CODE)).toBeNull();
    expect(proofHeaders()).toEqual({ "X-Eidolon-Proof": "p-1" });
  });

  test("a refused code keeps no proof", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, proof: "p-2" }));
    await exchangeLinkCode(CODE);
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: { code: "link-expired", message: "old" } }, { status: 401 }),
    );
    expect((await exchangeLinkCode(CODE))?.code).toBe("link-expired");
    expect(proofHeaders()).toEqual({ "X-Eidolon-Proof": "p-2" });
  });
});
