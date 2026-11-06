// The local token and the session it grants: the secret stays on disk, mode 0600; the printed link
// code lasts ten minutes; the cookie and the proof are two more values; and none reaches a log.
import "../../../../packages/config/test/isolated-guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dataHome } from "@eidolon/config";
import { cookieValues } from "../../src/local/session.ts";
import {
  LINK_TTL_SECONDS,
  LocalToken,
  loadLocalToken,
  sessionCookieName,
  TokenError,
  tokenPath,
} from "../../src/local/token.ts";
import { type CapturedLogs, captureLogs } from "../fakes.ts";
import { type Booted, bootFixture, cleanUpBoot } from "./harness.ts";

let booted: Booted | null = null;
let logs: CapturedLogs | null = null;

afterEach(async () => {
  await booted?.stop();
  booted = null;
  logs?.restore();
  logs = null;
  cleanUpBoot();
});

const NOW = 1_793_000_000;
const SECRET = "s".repeat(43);

describe("the token file", () => {
  test("is made on first use, mode 0600, in a data home only this user can enter", () => {
    const token = loadLocalToken();
    expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(statSync(dataHome()).mode & 0o777).toBe(0o700);
    expect(loadLocalToken().secret).toBe(token.secret);
    expect(token.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("is refused when others can read it, when another user owns it, or when it is malformed", () => {
    loadLocalToken();
    chmodSync(tokenPath(), 0o640);
    expect(() => loadLocalToken()).toThrow(
      `${tokenPath()} is readable by other users; run \`chmod 600 ${tokenPath()}\``,
    );
    chmodSync(tokenPath(), 0o600);
    expect(() => loadLocalToken({ uid: (process.getuid?.() ?? 0) + 1 })).toThrow(
      "belongs to another user",
    );
    writeFileSync(tokenPath(), "short\n");
    expect(() => loadLocalToken()).toThrow(TokenError);
    expect(() => loadLocalToken()).toThrow("holds no valid token; delete it to make a new one");
  });

  test("a folder in its place is refused, not followed", () => {
    mkdirSync(tokenPath(), { recursive: true });
    expect(() => loadLocalToken()).toThrow("is not a regular file");
  });
});

describe("link codes", () => {
  const token = new LocalToken(SECRET);

  test("last ten minutes", () => {
    const code = token.linkCode(NOW);
    expect(token.checkLinkCode(code, NOW)).toBe("ok");
    expect(token.checkLinkCode(code, NOW + 9 * 60)).toBe("ok");
    expect(token.checkLinkCode(code, NOW + LINK_TTL_SECONDS + 1)).toBe("expired");
    expect(token.checkLinkCode(code, NOW + 11 * 60)).toBe("expired");
    expect(token.checkLinkCode(code, NOW - 3600)).toBe("expired");
  });

  test("are bound to the secret and to their own time", () => {
    const code = token.linkCode(NOW);
    expect(new LocalToken("t".repeat(43)).checkLinkCode(code, NOW)).toBe("invalid");
    const [, signature] = code.split(".");
    expect(token.checkLinkCode(`${NOW + 60}.${signature}`, NOW + 60)).toBe("invalid");
    for (const junk of [undefined, 42, "", "123", `${NOW}.short`, `x.${signature}`, `${code}x`]) {
      expect([junk, token.checkLinkCode(junk, NOW)]).toEqual([junk, "invalid"]);
    }
  });

  test("the cookie, the proof, the code and the secret all differ", () => {
    const cookie = token.sessionCookie(7860).split(";")[0]?.split("=")[1] as string;
    const proof = token.proof();
    const code = token.linkCode(NOW);
    expect(new Set([SECRET, cookie, proof, code, code.split(".")[1]]).size).toBe(5);
    expect(proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.isSession(cookie)).toBe(true);
    expect(token.isSession(SECRET)).toBe(false);
    expect(token.isSession(proof)).toBe(false);
    expect(token.isProof(proof)).toBe(true);
    expect(token.isProof(cookie)).toBe(false);
    expect(token.isProof("")).toBe(false);
    expect(new LocalToken("t".repeat(43)).isProof(proof)).toBe(false);
    expect(token.isSecret(cookie)).toBe(false);
    expect(token.isSecret("")).toBe(false);
    expect(token.isSession("x".repeat(500))).toBe(false);
  });

  test("the cookie's attributes", () => {
    expect(token.sessionCookie(7860)).toMatch(
      /^eidolon_session_7860=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/,
    );
  });

  test("a probe proves the secret without carrying it", () => {
    const proof = token.probeProof("n".repeat(16)) as string;
    expect(proof).not.toContain(SECRET);
    expect(new LocalToken("t".repeat(43)).probeProof("n".repeat(16))).not.toBe(proof);
    expect(token.probeProof("short")).toBeNull();
  });

  test("cookieValues finds every copy of the cookie", () => {
    const name = sessionCookieName(7860);
    expect(cookieValues(`a=1; ${name}=bad; b=2;${name}=good`, name)).toEqual(["bad", "good"]);
    expect(cookieValues(null, name)).toEqual([]);
    expect(cookieValues(`${name}_x=1; x${name}=2`, name)).toEqual([]);
  });
});

async function exchange(code: unknown, headers: Record<string, string> = {}) {
  const live = booted as Booted;
  return fetch(`${live.base}/api/local/session`, {
    method: "POST",
    body: typeof code === "string" && code.startsWith("{") ? code : JSON.stringify({ code }),
    headers: { "Content-Type": "application/json", Origin: live.origin, ...headers },
  });
}

describe("the session exchange", () => {
  test("a fresh code sets the cookie and answers the proof; the two then open the API", async () => {
    booted = await bootFixture();
    booted.io.now = NOW;
    const response = await exchange(booted.token.linkCode(NOW));
    expect(response.status).toBe(200);
    const { proof } = (await response.json()) as { proof: string };
    expect(proof).toBe(booted.proof);
    const cookie = response.headers.get("set-cookie") as string;
    expect(cookie).toBe(booted.token.sessionCookie(booted.port));
    expect(cookie).not.toContain(proof);
    const check = await fetch(`${booted.base}/api/local/session`, {
      headers: { Cookie: cookie.split(";")[0] as string, "X-Eidolon-Proof": proof },
    });
    expect([check.status, await check.json()]).toEqual([200, { ok: true }]);
    const cookieOnly = await fetch(`${booted.base}/api/local/session`, {
      headers: { Cookie: cookie.split(";")[0] as string },
    });
    expect([cookieOnly.status, (await cookieOnly.json()).error.code]).toEqual([
      401,
      "proof-missing",
    ]);
  });

  test("an 11-minute-old code is 401 link-expired, and sets no cookie", async () => {
    booted = await bootFixture();
    const old = booted.token.linkCode(booted.io.now - 11 * 60);
    const response = await exchange(old);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("link-expired");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("a wrong code is 401 and leaves a working session alone", async () => {
    booted = await bootFixture();
    const response = await exchange("1793000000.wrongwrongwrongwrongwrongwrongwrongwrongwro", {
      Cookie: booted.cookie,
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain(booted.proof);
    const still = await fetch(`${booted.base}/api/local/session`, { headers: booted.session });
    expect(still.status).toBe(200);
  });

  test("malformed JSON is bad-json, and the answer echoes none of it", async () => {
    booted = await bootFixture();
    const response = await exchange('{"code": "sk-or-v1-LEAKED"');
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("bad-json");
    expect(text).not.toContain("LEAKED");
  });

  test("a bad first and a good second copy of the cookie sign in; a wrong-length one is a 401", async () => {
    booted = await bootFixture();
    const name = sessionCookieName(booted.port);
    const good = booted.cookie.split("=")[1] as string;
    const both = await fetch(`${booted.base}/api/local/session`, {
      headers: {
        Cookie: `${name}=decoy; other=1; ${name}=${good}`,
        "X-Eidolon-Proof": booted.proof,
      },
    });
    expect(both.status).toBe(200);
    for (const value of ["", "x", "y".repeat(4096)]) {
      const response = await fetch(`${booted.base}/api/local/session`, {
        headers: { Cookie: `${name}=${value}`, "X-Eidolon-Proof": booted.proof },
      });
      expect([value.length, response.status]).toEqual([value.length, 401]);
    }
  });

  test("the cookie for another port opens nothing here", async () => {
    booted = await bootFixture();
    const value = booted.cookie.split("=")[1] as string;
    const response = await fetch(`${booted.base}/api/local/session`, {
      headers: {
        Cookie: `${sessionCookieName(booted.port + 1)}=${value}`,
        "X-Eidolon-Proof": booted.proof,
      },
    });
    expect(response.status).toBe(401);
  });

  test("the secret works as a Bearer token; never from the query string", async () => {
    booted = await bootFixture();
    const bearer = await fetch(`${booted.base}/api/local/session`, {
      headers: { Authorization: `Bearer ${booted.token.secret}` },
    });
    expect(bearer.status).toBe(200);
    const query = await fetch(`${booted.base}/api/local/session?token=${booted.token.secret}`);
    expect(query.status).toBe(401);
    const wrong = await fetch(`${booted.base}/api/local/session`, {
      headers: { Authorization: `Bearer ${"x".repeat(43)}` },
    });
    expect(wrong.status).toBe(401);
  });
});

test("no log line holds the secret, the link code, the cookie or the proof, through a session", async () => {
  logs = captureLogs();
  booted = await bootFixture();
  const printed = booted.io.out.join("");
  const code = /#(\S+)/.exec(printed)?.[1] as string;
  expect(booted.token.checkLinkCode(code, booted.io.now)).toBe("ok");
  const response = await exchange(code);
  expect(response.status).toBe(200);
  await fetch(`${booted.base}/api/offer`, {
    method: "POST",
    body: '{"sdp":"v=0","type":"offer","requestData":{"audioQuality":"low"}}',
    headers: booted.session,
  });
  const cookieValue = booted.cookie.split("=")[1] as string;
  const everything = [...logs.lines(), ...logs.access].join("\n");
  expect(everything).toContain("[local] Offer from the local viewer");
  const secrets = [booted.token.secret, code, code.split(".")[1] as string, cookieValue];
  for (const value of [...secrets, booted.proof]) {
    expect(everything.includes(value)).toBe(false);
  }
});
