// web_fetch against local servers: a resolver stands in for DNS and a dialer reaches the servers
// in place of the public addresses they stand for, so nothing here touches the network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { isIP } from "node:net";
import type { TaskToolResult } from "@eidolon/engine";
import type { Server } from "bun";
import {
  createTaskTools,
  createWebFetchTool,
  type PathGuard,
  WEB_FETCH,
  type WebAccess,
  type WebFetchDetails,
  type WebFetchOptions,
  webFetchHost,
} from "../src/index.ts";
import {
  htmlToText,
  type WebFetcher,
  type WebInterfaces,
  type WebLookup,
} from "../src/tools/web-fetch.ts";
import { toolContext } from "./tool-folder.ts";

const realFetch = globalThis.fetch;

// TEST-NET-3: never routed, and not among the ranges web_fetch refuses.
const SITE_IP = "203.0.113.7";
const DOWN_IP = "203.0.113.9";

const LOCAL = "an address on this computer or its network, which web_fetch never reaches.";
const FAKE =
  "an address a fake-IP proxy hands out for names, so it can lead to this computer or its " +
  "network, which web_fetch never reaches.";

/**
 * A computer whose network has public addresses, IPv6 ones as most do and IPv4 ones as few do,
 * behind a TUN proxy in fake-IP mode, as os.networkInterfaces gives them.
 */
const INTERFACES: WebInterfaces = () => ({
  lo0: [
    { address: "127.0.0.1", cidr: "127.0.0.1/8" },
    { address: "::1", cidr: "::1/128" },
  ],
  en0: [
    { address: "fe80::c85:497f:78d:8e87", cidr: "fe80::c85:497f:78d:8e87/64" },
    { address: "192.0.2.10", cidr: "192.0.2.10/24" },
    { address: "2001:db8:5400:1::a", cidr: "2001:db8:5400:1::a/64" },
  ],
  utun5: [{ address: "198.18.0.1", cidr: "198.18.0.1/15" }],
});

const encoder = new TextEncoder();

/** A self-signed certificate for `host`, as Bun.serve and fetch's `ca` take it. */
function selfSigned(host: string): { cert: string; key: string } {
  const der = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
    const body = Buffer.concat(parts);
    const n = body.length;
    const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
    return Buffer.concat([Buffer.from([tag, ...length]), body]);
  };
  const seq = (...parts: Uint8Array[]) => der(0x30, ...parts);
  const oid = (text: string) => {
    const [first = 0, second = 0, ...rest] = text.split(".").map(Number);
    const bytes = [first * 40 + second];
    for (const n of rest) {
      const chunk = [n & 0x7f];
      for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
      bytes.push(...chunk);
    }
    return der(0x06, Buffer.from(bytes));
  };
  const time = (at: number) =>
    der(0x17, Buffer.from(`${new Date(at).toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(der(0x31, seq(oid("2.5.4.3"), der(0x0c, Buffer.from(host)))));
  const now = Date.now();
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    ecdsaWithSha256,
    name,
    seq(time(now - 60_000), time(now + 3_600_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    // subjectAltName: dNSName host.
    der(0xa3, seq(seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, Buffer.from(host))))))),
  );
  const cert = seq(
    tbs,
    ecdsaWithSha256,
    der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)),
  );
  const base64 = Buffer.from(cert)
    .toString("base64")
    .match(/.{1,64}/g)
    ?.join("\n");
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

const site = selfSigned("site.test");
const other = selfSigned("other.test");

const PAGE = `<!doctype html><html><head><title>Tea &amp; Milk</title></head>
<body><nav><a href="/">Home</a></nav><h1>Milk tea</h1>
<p>See <a href="/leaves">the leaves</a>.</p><script>document.write("no")</script></body></html>`;

/** GBK's bytes for 中文. */
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];

/** A body Bun.serve sends with no Content-Type, as it does a stream's. */
function untyped(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

let http!: Server<undefined>;
/** Shows site.test's certificate only to a client that names site.test (SNI), else other.test's. */
let sniHttps!: Server<undefined>;
/** Shows site.test's certificate to every client. */
let siteHttps!: Server<undefined>;
const seen: { host: string | null; path: string }[] = [];
let endlessCancelled = false;

beforeAll(() => {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`unexpected network call in a test: ${String(input)}`);
  }) as unknown as typeof fetch;
  http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({ host: request.headers.get("host"), path: url.pathname + url.search });
      const type = (contentType: string) => ({ headers: { "content-type": contentType } });
      switch (url.pathname) {
        case "/hello":
          return new Response("hello", type("text/plain; charset=utf-8"));
        case "/redirect":
          return new Response(null, {
            status: Number(url.searchParams.get("status") ?? 302),
            headers: { location: url.searchParams.get("to") ?? "/" },
          });
        case "/page":
          return new Response(PAGE, type("text/html; charset=utf-8"));
        case "/json":
          return new Response('{"tea":"milk",\n "cups":2}', type("application/json"));
        case "/rss":
          return new Response(
            "<rss><channel><title>Tea</title></channel></rss>",
            type("application/rss+xml"),
          );
        case "/png":
          return new Response(new Uint8Array(1536).fill(0x89), type("image/png"));
        case "/untyped-text":
          return new Response(untyped(encoder.encode("plain words")));
        case "/untyped-binary":
          return new Response(untyped(new Uint8Array([0, 1, 2, 0xff, 0xfe])));
        // Bun.serve sends a byte array as application/octet-stream.
        case "/octet-text":
          return new Response(encoder.encode("# Notes\n\nkept as text"));
        case "/octet-binary":
          return new Response(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]));
        case "/gbk":
          return new Response(
            new Uint8Array([...encoder.encode("<p>"), ...GBK_ZHONGWEN, ...encoder.encode("</p>")]),
            type("text/html; charset=gbk"),
          );
        case "/meta-gbk":
          return new Response(
            new Uint8Array([
              ...encoder.encode('<html><head><meta charset="gbk"></head><body><p>'),
              ...GBK_ZHONGWEN,
              ...encoder.encode("</p></body></html>"),
            ]),
            type("text/html"),
          );
        case "/missing":
          return new Response(
            `<html><body><h1>Not here</h1><p>${"Nothing at this address. ".repeat(200)}</p></body></html>`,
            { status: 404, headers: { "content-type": "text/html" } },
          );
        case "/endless": {
          const line = encoder.encode(`${"x".repeat(99)}\n`);
          const chunk = new Uint8Array(line.length * 640);
          for (let at = 0; at < chunk.length; at += line.length) chunk.set(line, at);
          const body = new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              endlessCancelled = true;
            },
          });
          return new Response(body, type("text/plain"));
        }
        case "/stall":
          return new Promise<Response>(() => {});
        case "/stall-body": {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("first words"));
            },
          });
          return new Response(body, type("text/plain"));
        }
        default:
          return new Response(`${request.headers.get("host")} ${url.pathname}`, type("text/plain"));
      }
    },
  });
  const secure = (request: Request) => new Response(`secure, for ${request.headers.get("host")}`);
  sniHttps = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: [other, { ...site, serverName: "site.test" }],
    fetch: secure,
  });
  siteHttps = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: site, fetch: secure });
});

afterAll(() => {
  globalThis.fetch = realFetch;
  http.stop(true);
  sniHttps.stop(true);
  siteHttps.stop(true);
});

interface Dialed {
  readonly url: string;
  readonly init: BunFetchRequestInit;
}

/**
 * A fetch that reaches the test servers in place of SITE_IP, its https on `secure`, trusting
 * site.test's certificate alone; that can't connect to DOWN_IP; and that answers any other address
 * itself, so nothing leaves this computer.
 */
function dialer(secure: () => Server<undefined> = () => sniHttps) {
  const dialed: Dialed[] = [];
  const fetch: WebFetcher = async (url, init) => {
    dialed.push({ url, init });
    const target = new URL(url);
    const address = target.hostname.replace(/^\[|\]$/g, "");
    if (address === DOWN_IP) throw new TypeError(`ECONNREFUSED: can't connect to ${address}`);
    if (address !== SITE_IP) return new Response(`reached ${address}`);
    const server = target.protocol === "https:" ? secure() : http;
    target.hostname = "127.0.0.1";
    target.port = String(server.port);
    const tls = target.protocol === "https:" ? { tls: { ...init.tls, ca: [site.cert] } } : {};
    return realFetch(target.href, { ...init, ...tls });
  };
  return { fetch, dialed };
}

/** A lookup answering from `table`, each name's answer a function of how often it was asked. */
function resolver(
  table: Readonly<Record<string, readonly string[] | ((asked: number) => string[])>>,
) {
  const asked: string[] = [];
  const lookup: WebLookup = async (host) => {
    asked.push(host);
    const entry = table[host];
    if (entry === undefined) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    }
    const addresses =
      typeof entry === "function" ? entry(asked.filter((h) => h === host).length) : entry;
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return { lookup, asked };
}

const NAMES = { "site.test": [SITE_IP] };

const ANY: WebAccess = { allows: () => true };

/**
 * The details of a call stopped at `url`'s redirect: that server answered, so what the call says
 * of its Location came from outside.
 */
function redirectedAt(url: string): WebFetchDetails {
  return { url, finalUrl: url, status: 302, contentType: null, bytes: 0 };
}

function webFetch(options: Partial<WebFetchOptions> = {}) {
  const dial = dialer();
  const names = resolver(NAMES);
  const tool = createWebFetchTool({
    web: ANY,
    lookup: names.lookup,
    fetch: dial.fetch,
    ...options,
  });
  const run = (args: Record<string, unknown>, signal?: AbortSignal): Promise<TaskToolResult> =>
    tool.execute(args, toolContext(signal));
  return { tool, run, dialed: dial.dialed, asked: names.asked };
}

/**
 * A TUN proxy in fake-IP mode: its lookup answers every name, real or not, from 198.18.0.0/15, and
 * it carries a connection to one of those to where it resolves that name itself, from `real`.
 * Loopback is the test server; any other address goes to dialer.
 */
function fakeIpTun(real: Readonly<Record<string, string>>) {
  const names = Object.keys(real);
  const fakeOf = (name: string) => `198.19.37.${74 + names.indexOf(name)}`;
  const asked: string[] = [];
  const lookup: WebLookup = async (host) => {
    asked.push(host);
    return [{ address: fakeOf(host), family: 4 }];
  };
  const elsewhere = dialer();
  const dialed: Dialed[] = [];
  const fetch: WebFetcher = async (url, init) => {
    dialed.push({ url, init });
    const target = new URL(url);
    const name = names.find((candidate) => fakeOf(candidate) === target.hostname);
    if (name === undefined) return elsewhere.fetch(url, init);
    const address = real[name] ?? "";
    target.hostname = isIP(address) === 6 ? `[${address}]` : address;
    if (address === "127.0.0.1") return realFetch(target.href, init);
    return elsewhere.fetch(target.href, init);
  };
  return { lookup, fetch, asked, dialed };
}

/**
 * Cloudflare's DNS over HTTPS as its JSON API answers: a name's addresses of the type asked,
 * after the CNAME that led there; a name not in `table` is NXDOMAIN.
 */
function cloudflare(table: Readonly<Record<string, readonly string[]>>) {
  const asked: Dialed[] = [];
  const doh: WebFetcher = async (url, init) => {
    asked.push({ url, init });
    const query = new URL(url).searchParams;
    const name = query.get("name") ?? "";
    const addresses = table[name];
    if (addresses === undefined) return Response.json({ Status: 3 });
    const type = query.get("type") === "AAAA" ? 28 : 1;
    const answers = addresses.filter((address) => isIP(address) === (type === 1 ? 4 : 6));
    return Response.json({
      Status: 0,
      Answer: [
        { name, type: 5, TTL: 300, data: `edge.${name}.` },
        ...answers.map((data) => ({ name: `edge.${name}`, type, TTL: 300, data })),
      ],
    });
  };
  return { doh, asked };
}

describe("web_fetch", () => {
  test("connects to the address it checked, naming the site in Host, by GET with no proxy", async () => {
    // A name that answers a public address once and a loopback one after (DNS rebinding).
    const names = resolver({ "rebind.test": (asked) => [asked === 1 ? SITE_IP : "127.0.0.1"] });
    const dial = dialer();
    const tool = createWebFetchTool({ web: ANY, lookup: names.lookup, fetch: dial.fetch });
    const result = await tool.execute({ url: "http://rebind.test/hello?cup=1" }, toolContext());

    expect(result).toEqual({
      content: "hello",
      details: {
        url: "http://rebind.test/hello?cup=1",
        finalUrl: "http://rebind.test/hello?cup=1",
        status: 200,
        contentType: "text/plain",
        bytes: 5,
      } satisfies WebFetchDetails,
    });
    expect(names.asked).toEqual(["rebind.test"]);
    expect(dial.dialed).toHaveLength(1);
    const [{ url, init }] = dial.dialed as [Dialed];
    expect(url).toBe(`http://${SITE_IP}/hello?cup=1`);
    expect(init).toMatchObject({ method: "GET", redirect: "manual", proxy: false });
    expect(new Headers(init.headers).get("host")).toBe("rebind.test");
    expect(init.tls).toBeUndefined();
    // Bun sent the Host it was given to the address it dialed.
    expect(seen.at(-1)).toEqual({ host: "rebind.test", path: "/hello?cup=1" });
  });

  test("over https, Bun sends the site's name for SNI and checks the certificate against it", async () => {
    // sniHttps shows site.test's certificate only to a client that names site.test, and the dialer
    // trusts that certificate alone: the fetch succeeds only if the name went out as SNI.
    const { run, dialed } = webFetch();
    const result = await run({ url: "https://site.test/tea" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("secure, for site.test");
    expect(dialed[0]?.url).toBe(`https://${SITE_IP}/tea`);
    expect(dialed[0]?.init.tls).toEqual({ serverName: "site.test" });
    // A port of its own goes to Host too.
    expect((await run({ url: "https://site.test:8443/" })).content).toBe(
      "secure, for site.test:8443",
    );

    // siteHttps shows site.test's certificate to anyone. Checked against the server name, it
    // passes; the same request checked against its address, or against another name, fails.
    const pinnedTo = (tls?: BunFetchRequestInit["tls"]) => {
      const dial = dialer(() => siteHttps);
      return createWebFetchTool({
        web: ANY,
        lookup: resolver(NAMES).lookup,
        fetch: (url, init) => dial.fetch(url, tls === undefined ? init : { ...init, tls }),
      });
    };
    const pinned = await pinnedTo().execute({ url: "https://site.test/" }, toolContext());
    expect(pinned.content).toBe("secure, for site.test");
    for (const tls of [{}, { serverName: "elsewhere.test" }]) {
      const refused = await pinnedTo(tls).execute({ url: "https://site.test/" }, toolContext());
      expect([tls, refused.isError]).toEqual([tls, true]);
      expect(refused.content).toStartWith(
        "Couldn't connect to site.test: ERR_TLS_CERT_ALTNAME_INVALID",
      );
    }
  });

  test("an address literal is fetched as it is, with no name to send", async () => {
    const { run, dialed, asked } = webFetch();
    expect((await run({ url: "http://203.0.113.50/x" })).content).toBe("reached 203.0.113.50");
    expect(asked).toEqual([]);
    expect(new Headers(dialed[0]?.init.headers).get("host")).toBeNull();
  });

  test("refuses the names and addresses of this computer and its network, before connecting", async () => {
    const refusedLiterals = [
      "http://127.0.0.1/",
      "http://127.255.255.254/",
      "http://0x7f.1/",
      "http://2130706433/",
      "http://0.0.0.0/",
      "http://0.1.2.3/",
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/",
      "http://100.127.255.255/",
      "http://224.0.0.1/",
      "http://239.255.255.250:1900/",
      "http://255.255.255.255/",
      "http://[::]/",
      "http://[::1]/",
      "http://[0:0:0:0:0:0:0:1]/",
      "http://[fc00::1]/",
      "http://[fd12:3456:789a::1]/",
      "http://[fe80::1]/",
      "http://[febf::1]/",
      "http://[ff02::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.1.2.3]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://[::ffff:100.64.0.1]/",
      "http://[::ffff:0.0.0.0]/",
    ];
    const refusedNames = [
      "http://localhost:7860/api",
      "http://LOCALHOST./",
      "http://localhost../",
      "http://app.localhost/",
      "http://printer.local/",
      "https://db.corp.internal/",
    ];
    const names = resolver({
      "lan.test": ["192.168.0.20"],
      "mixed.test": [SITE_IP, "10.0.0.5"],
      "mapped.test": ["::ffff:172.20.0.1"],
      "v6.test": ["2606:4700::1111", "fd00::5"],
      "scoped.test": ["fe80::1%en0"],
    });
    const dial = dialer();
    const tool = createWebFetchTool({ web: ANY, lookup: names.lookup, fetch: dial.fetch });
    for (const url of [...refusedLiterals, ...refusedNames]) {
      const result = await tool.execute({ url }, toolContext());
      expect([url, result.isError]).toEqual([url, true]);
      expect(result.content).toEndWith(
        "this computer or its network, which web_fetch never reaches.",
      );
    }
    for (const [host, address] of [
      ["lan.test", "192.168.0.20"],
      ["mixed.test", "10.0.0.5"],
      ["mapped.test", "::ffff:172.20.0.1"],
      ["v6.test", "fd00::5"],
      ["scoped.test", "fe80::1%en0"],
    ]) {
      const result = await tool.execute({ url: `https://${host}/` }, toolContext());
      expect(result).toEqual({
        content: `${host} resolves to ${address}, an address on this computer or its network, which web_fetch never reaches.`,
        isError: true,
      });
    }
    expect(dial.dialed).toEqual([]);
    expect(names.asked).toEqual([
      "lan.test",
      "mixed.test",
      "mapped.test",
      "v6.test",
      "scoped.test",
    ]);

    // Their neighbours are the internet's, and so are those of 198.18.0.0/15, a fake-IP proxy's.
    for (const address of [
      "172.32.0.1",
      "100.128.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "198.17.255.255",
      "198.20.0.0",
      "[2606:4700::1111]",
      "[::ffff:8.8.8.8]",
    ]) {
      const result = await tool.execute({ url: `http://${address}/` }, toolContext());
      expect(result.content).toStartWith("reached ");
    }
  });

  test("refuses this computer's own addresses and the networks they're on, as they are at each check", async () => {
    let interfaces = INTERFACES;
    const names = resolver({
      "own.test": ["2001:db8:5400:1::a"],
      "lan6.test": ["2606:4700::1111", "2001:db8:5400:1::1"],
      "lan4.test": ["192.0.2.99"],
    });
    const dial = dialer();
    const tool = createWebFetchTool({
      web: ANY,
      lookup: names.lookup,
      fetch: dial.fetch,
      interfaces: () => interfaces(),
    });
    const run = (url: string) => tool.execute({ url }, toolContext());
    for (const url of [
      "http://[2001:db8:5400:1::a]:8080/",
      "http://[2001:db8:5400:1::1]/",
      "http://192.0.2.10/",
      "http://192.0.2.99/",
      "http://[::ffff:192.0.2.99]/",
    ]) {
      expect(await run(url)).toEqual({
        content: `${new URL(url).hostname} is ${LOCAL}`,
        isError: true,
      });
      expect([url, webFetchHost({ url }, INTERFACES)]).toEqual([url, null]);
    }
    for (const [host, address] of [
      ["own.test", "2001:db8:5400:1::a"],
      ["lan6.test", "2001:db8:5400:1::1"],
      ["lan4.test", "192.0.2.99"],
    ]) {
      expect(await run(`http://${host}/`)).toEqual({
        content: `${host} resolves to ${address}, ${LOCAL}`,
        isError: true,
      });
    }
    expect(dial.dialed).toEqual([]);

    // The networks next to them are the internet's.
    for (const url of ["http://[2001:db8:5400:2::1]/", "http://192.0.3.1/"]) {
      expect((await run(url)).content).toStartWith("reached ");
      expect(webFetchHost({ url }, INTERFACES)).toBe(new URL(url).hostname);
    }
    // An address it takes later, as a temporary IPv6 address comes, is refused from then on.
    interfaces = () => ({ en0: [{ address: "2001:db8:77::5", cidr: "2001:db8:77::5/64" }] });
    expect(await run("http://[2001:db8:77::9]/")).toEqual({
      content: `[2001:db8:77::9] is ${LOCAL}`,
      isError: true,
    });
  });

  test("follows a redirect by name, checking the target as it checked the first", async () => {
    const { run, dialed, asked } = webFetch();
    const result = await run({ url: "http://site.test/redirect?to=/hello" });
    expect(result.content).toBe("[Redirected to http://site.test/hello]\n\nhello");
    expect(result.details).toMatchObject({
      url: "http://site.test/redirect?to=/hello",
      finalUrl: "http://site.test/hello",
      status: 200,
    });
    expect(dialed.map(({ url }) => url)).toEqual([
      `http://${SITE_IP}/redirect?to=/hello`,
      `http://${SITE_IP}/hello`,
    ]);
    expect(seen.slice(-2).map(({ host }) => host)).toEqual(["site.test", "site.test"]);
    expect(asked).toEqual(["site.test", "site.test"]);

    // 301, 303, 307 and 308 too; another status keeps its body, Location and all.
    for (const status of [301, 303, 307, 308]) {
      const followed = await run({ url: `http://site.test/redirect?status=${status}&to=/hello` });
      expect(followed.content).toEndWith("hello");
    }
    const kept = await run({ url: "http://site.test/redirect?status=300&to=/hello" });
    expect(kept.details).toMatchObject({ status: 300, bytes: 0 });

    // Nothing but http and https is followed, nor a Location that isn't a URL.
    expect(await run({ url: "http://site.test/redirect?to=ftp://files.test/a" })).toEqual({
      content:
        "http://site.test/redirect?to=ftp://files.test/a redirected to ftp://files.test/a, which " +
        "web_fetch can't follow: it fetches http and https only.",
      isError: true,
      details: redirectedAt("http://site.test/redirect?to=ftp://files.test/a"),
    });
    expect(await run({ url: "http://site.test/redirect?to=http://%5B::1" })).toEqual({
      content:
        "http://site.test/redirect?to=http://%5B::1 redirected to http://[::1, which isn't a URL.",
      isError: true,
      details: redirectedAt("http://site.test/redirect?to=http://%5B::1"),
    });
  });

  test("a redirect into this computer or its network is refused before it is followed", async () => {
    const names = resolver({ ...NAMES, "inside.test": ["192.168.1.20"] });
    const dial = dialer();
    const tool = createWebFetchTool({ web: ANY, lookup: names.lookup, fetch: dial.fetch });
    const run = (url: string) => tool.execute({ url }, toolContext());

    expect(
      await run("http://site.test/redirect?to=http://127.0.0.1:7860/api/local/settings"),
    ).toEqual({
      content:
        "http://site.test/redirect?to=http://127.0.0.1:7860/api/local/settings redirected to " +
        "http://127.0.0.1:7860/api/local/settings: 127.0.0.1 is an address on this computer or its " +
        "network, which web_fetch never reaches.",
      isError: true,
      details: redirectedAt(
        "http://site.test/redirect?to=http://127.0.0.1:7860/api/local/settings",
      ),
    });
    expect(await run("http://site.test/redirect?to=http://inside.test/admin")).toEqual({
      content:
        "http://site.test/redirect?to=http://inside.test/admin redirected to http://inside.test/admin: " +
        "inside.test resolves to 192.168.1.20, an address on this computer or its network, which " +
        "web_fetch never reaches.",
      isError: true,
      details: redirectedAt("http://site.test/redirect?to=http://inside.test/admin"),
    });
    const local = await run("http://site.test/redirect?to=http://localhost/");
    expect(local.content).toEndWith(
      "redirected to http://localhost/: localhost names this computer or its network, which web_fetch never reaches.",
    );
    expect(dial.dialed.map(({ url }) => new URL(url).hostname)).toEqual([
      SITE_IP,
      SITE_IP,
      SITE_IP,
    ]);
  });

  test("a redirect to a site not allowed ends the call, naming the target to fetch directly", async () => {
    const asks: string[] = [];
    const onlySite: WebAccess = {
      allows(host) {
        asks.push(host);
        return host === "site.test";
      },
    };
    const { run, dialed, asked } = webFetch({ web: onlySite });
    const result = await run({
      url: "http://site.test/redirect?to=https://Elsewhere.TEST./doc%201",
    });
    expect(result).toEqual({
      content:
        "http://site.test/redirect?to=https://Elsewhere.TEST./doc%201 redirected to " +
        "https://elsewhere.test./doc%201, on elsewhere.test, a site this task may not fetch from yet. " +
        "To follow it, call web_fetch on https://elsewhere.test./doc%201 itself, which asks the " +
        "owner for that site.",
      isError: true,
      details: redirectedAt("http://site.test/redirect?to=https://Elsewhere.TEST./doc%201"),
    });
    expect(asks).toEqual(["site.test", "elsewhere.test"]);
    expect(asked).toEqual(["site.test"]);
    expect(dialed).toHaveLength(1);

    // The first site is the tool's to check too.
    const first = await run({ url: "https://other.test/" });
    expect(first).toEqual({
      content: "other.test isn't among the sites this task may fetch from.",
      isError: true,
    });
    expect(asked).toEqual(["site.test"]);
  });

  test("stops after 5 redirects", async () => {
    const { run, dialed } = webFetch();
    // Each hop's Location names the next; the sixth redirect isn't followed.
    let url = "/hello";
    for (let n = 6; n >= 1; n--) url = `/redirect?to=${encodeURIComponent(url)}`;
    const result = await run({ url: `http://site.test${url}` });
    expect(result.isError).toBe(true);
    expect(dialed).toHaveLength(6);
    expect(result.content).toBe(
      "Stopped after 5 redirects: http://site.test/redirect?to=%2Fhello redirected again, to http://site.test/hello.",
    );
    expect(result.details).toMatchObject({
      finalUrl: "http://site.test/redirect?to=%2Fhello",
      status: 302,
    });

    // Five are followed.
    url = "/hello";
    for (let n = 5; n >= 1; n--) url = `/redirect?to=${encodeURIComponent(url)}`;
    expect((await run({ url: `http://site.test${url}` })).content).toEndWith("\n\nhello");
  });

  test("tries the next address when one can't be reached, IPv4 first", async () => {
    const names = resolver({ "multi.test": ["2606:4700::1111", DOWN_IP, SITE_IP] });
    const dial = dialer();
    const tool = createWebFetchTool({ web: ANY, lookup: names.lookup, fetch: dial.fetch });
    const result = await tool.execute({ url: "http://multi.test/hello" }, toolContext());
    expect(result.content).toBe("hello");
    expect(dial.dialed.map(({ url }) => new URL(url).hostname)).toEqual([DOWN_IP, SITE_IP]);

    const down = resolver({ "down.test": [DOWN_IP] });
    const failed = await createWebFetchTool({
      web: ANY,
      lookup: down.lookup,
      fetch: dial.fetch,
    }).execute({ url: "http://down.test/" }, toolContext());
    expect(failed).toEqual({
      content: `Couldn't connect to down.test: ECONNREFUSED: can't connect to ${DOWN_IP}`,
      isError: true,
    });

    const unknown = await tool.execute({ url: "http://nowhere.test/" }, toolContext());
    expect(unknown).toEqual({ content: "Can't find nowhere.test (ENOTFOUND).", isError: true });
  });

  test("reads at most 2 MB of the body and shows at most 50 KB, saying so", async () => {
    const { run } = webFetch();
    const result = await run({ url: "http://site.test/endless" });
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({
      status: 200,
      contentType: "text/plain",
      bytes: 2 * 1024 * 1024,
    });
    const lines = result.content.split("\n");
    expect(lines.slice(0, 512)).toEqual(Array(512).fill("x".repeat(99)));
    expect(lines.slice(512)).toEqual([
      "",
      "[The response was cut at 2.0MB. 50.0KB limit reached: showing 50.0KB of 2.0MB]",
    ]);
    // Reading stopped there: the server saw its stream cancelled.
    for (let wait = 0; wait < 100 && !endlessCancelled; wait++) await Bun.sleep(10);
    expect(endlessCancelled).toBe(true);
  });

  test("a long line in the way is cut within itself, not dropped whole", async () => {
    // An XML declaration, then a document on one line: whole lines would show its first 21 bytes.
    const big = `<feed>${Array.from({ length: 20_000 }, (_, i) => `<item>${i}</item>`).join("")}</feed>`;
    const body = `<?xml version="1.0"?>\n${big}`;
    const tool = createWebFetchTool({
      web: ANY,
      lookup: resolver(NAMES).lookup,
      fetch: async () =>
        new Response(body, { headers: { "content-type": "application/atom+xml" } }),
    });
    const result = await tool.execute({ url: "http://site.test/feed" }, toolContext());
    const [shown = "", note] = result.content.split("\n\n[");
    expect(shown).toBe(body.slice(0, 50 * 1024));
    expect(note).toBe(
      `50.0KB limit reached: showing 50.0KB of ${(body.length / 1024).toFixed(1)}KB]`,
    );

    // Never half a character: 中 is three bytes, and 50 KB isn't a multiple of three.
    const wide = "中".repeat(30_000);
    const cjk = await createWebFetchTool({
      web: ANY,
      lookup: resolver(NAMES).lookup,
      fetch: async () => new Response(wide, { headers: { "content-type": "text/plain" } }),
    }).execute({ url: "http://site.test/wide" }, toolContext());
    expect(cjk.content.split("\n\n[")[0]).toBe("中".repeat(Math.floor((50 * 1024) / 3)));
  });

  test("an HTML page becomes its readable text, its links resolved", async () => {
    const { run } = webFetch();
    const result = await run({ url: "http://site.test/page" });
    expect(result.content).toBe(
      "Tea & Milk\n\n# Milk tea\n\nSee the leaves (http://site.test/leaves).",
    );
    expect(result.details).toMatchObject({ contentType: "text/html" });
  });

  test("text, JSON and XML come as they are; another type gets a line with its size", async () => {
    const { run } = webFetch();
    expect((await run({ url: "http://site.test/json" })).content).toBe(
      '{"tea":"milk",\n "cups":2}',
    );
    expect((await run({ url: "http://site.test/rss" })).content).toBe(
      "<rss><channel><title>Tea</title></channel></rss>",
    );
    const png = await run({ url: "http://site.test/png" });
    expect(png).toEqual({
      content:
        "http://site.test/png is image/png, 1.5KB. web_fetch shows only text, HTML, JSON and XML, so its contents aren't shown.",
      details: {
        url: "http://site.test/png",
        finalUrl: "http://site.test/png",
        status: 200,
        contentType: "image/png",
        bytes: 1536,
      },
    });

    // A body of no type, or of the type a server gives what it can't name, is shown when it reads
    // as text.
    const untypedText = await run({ url: "http://site.test/untyped-text" });
    expect(untypedText.content).toBe("plain words");
    expect(untypedText.details).toMatchObject({ contentType: null });
    const octetText = await run({ url: "http://site.test/octet-text" });
    expect(octetText.content).toBe("# Notes\n\nkept as text");
    expect(octetText.details).toMatchObject({ contentType: "application/octet-stream" });
    expect((await run({ url: "http://site.test/untyped-binary" })).content).toBe(
      "http://site.test/untyped-binary is binary data of no stated type, 5B. web_fetch shows only text, HTML, JSON and XML, so its contents aren't shown.",
    );
    expect((await run({ url: "http://site.test/octet-binary" })).content).toBe(
      "http://site.test/octet-binary is application/octet-stream, 5B. web_fetch shows only text, HTML, JSON and XML, so its contents aren't shown.",
    );
  });

  test("decodes text in the charset its header or its page names", async () => {
    const { run } = webFetch();
    expect((await run({ url: "http://site.test/gbk" })).content).toBe("中文");
    expect((await run({ url: "http://site.test/meta-gbk" })).content).toBe("中文");
  });

  test("a status of 400 or more is an error with its status line and the start of its body", async () => {
    const { run } = webFetch();
    const result = await run({ url: "http://site.test/missing" });
    expect(result.isError).toBe(true);
    expect(result.content).toStartWith(
      "HTTP 404 Not Found from http://site.test/missing\n\n# Not here\n\nNothing at this address. Nothing",
    );
    expect(result.content).toEndWith("... [truncated]");
    expect(result.content.length).toBeLessThan(2200);
    expect(result.details).toMatchObject({ status: 404, contentType: "text/html" });
  });

  test("gives up when its whole time runs out, waiting for the answer or for the body", async () => {
    const { run } = webFetch({ timeoutMs: 200 });
    for (const path of ["/stall", "/stall-body"]) {
      const url = `http://site.test${path}`;
      const started = Date.now();
      const result = await run({ url });
      expect(result).toEqual({
        content: `Timed out after 0.2 s fetching ${url}`,
        isError: true,
        // The body's server answered, its status and type before it stalled.
        ...(path === "/stall-body"
          ? { details: { url, finalUrl: url, status: 200, contentType: "text/plain", bytes: 0 } }
          : {}),
      });
      expect(Date.now() - started).toBeLessThan(2000);
    }
    // A lookup that never answers counts too.
    const stuck = createWebFetchTool({
      web: ANY,
      lookup: () => new Promise(() => {}),
      fetch: dialer().fetch,
      timeoutMs: 200,
    });
    expect(await stuck.execute({ url: "http://site.test/" }, toolContext())).toEqual({
      content: "Timed out after 0.2 s fetching http://site.test/",
      isError: true,
    });
    // And the default is 30 s, which the model is told.
    expect(webFetch().tool.schema.description).toContain("gives up after 30 seconds");
  });

  test("a cancel stops it", async () => {
    const { run } = webFetch();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await run({ url: "http://site.test/stall" }, controller.signal)).toEqual({
      content: "Operation aborted",
      isError: true,
    });
  });

  test("takes an http or https URL and nothing else", async () => {
    const { run, dialed, asked } = webFetch();
    expect((await run({})).content).toBe(
      'Validation failed for tool "web_fetch":\n  - url: missing\n\nReceived arguments:\n{}',
    );
    for (const url of [
      "example.com/page",
      "file:///etc/passwd",
      "ftp://example.com/",
      "javascript:alert(1)",
      3,
    ]) {
      const result = await run({ url });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        typeof url === "string"
          ? "url: expected an http or https URL, as in https://example.com/page"
          : "url: expected string, got integer",
      );
    }
    expect(dialed).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe("web_fetch behind a fake-IP proxy", () => {
  // INTERFACES has the TUN's own, 198.18.0.1/15: its stand-ins still go to DNS over HTTPS.

  test("a name whose real address is this computer or its network is refused before connecting", async () => {
    const tun = fakeIpTun({
      "localtest.me": "127.0.0.1",
      "127.0.0.1.nip.io": "127.0.0.1",
      "192-168-1-1.nip.io": "192.168.1.1",
      "dual.test": SITE_IP,
      "own.test": "2001:db8:5400:1::a",
      "lan.test": "2001:db8:5400:1::1",
    });
    const dns = cloudflare({
      "localtest.me": ["127.0.0.1"],
      "127.0.0.1.nip.io": ["127.0.0.1"],
      "192-168-1-1.nip.io": ["192.168.1.1"],
      "dual.test": [SITE_IP, "::1"],
      "own.test": ["2001:db8:5400:1::a"],
      "lan.test": [SITE_IP, "2001:db8:5400:1::1"],
    });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: tun.fetch,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    const served = seen.length;
    for (const [host, address] of [
      ["localtest.me", "127.0.0.1"],
      ["127.0.0.1.nip.io", "127.0.0.1"],
      ["192-168-1-1.nip.io", "192.168.1.1"],
      ["dual.test", "::1"],
      // This computer's own global IPv6 address, and a neighbour's on its /64: off the TUN, on-link.
      ["own.test", "2001:db8:5400:1::a"],
      ["lan.test", "2001:db8:5400:1::1"],
    ]) {
      const result = await tool.execute(
        { url: `http://${host}:${http.port}/hello` },
        toolContext(),
      );
      expect(result).toEqual({
        content: `${host} resolves to ${address}, ${LOCAL}`,
        isError: true,
      });
    }
    // Nothing reached the server on this computer's loopback, nor went anywhere else.
    expect(seen.length).toBe(served);
    expect(tun.dialed).toEqual([]);
  });

  test("dials the real address Cloudflare's DNS over HTTPS gives, as it dials any other", async () => {
    const tun = fakeIpTun({ "site.test": SITE_IP });
    const dns = cloudflare({ "site.test": ["2606:4700::1111", SITE_IP] });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: tun.fetch,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    const result = await tool.execute({ url: "http://site.test/hello" }, toolContext());
    expect(tun.dialed.map(({ url }) => url)).toEqual([`http://${SITE_IP}/hello`]);
    expect(result.content).toBe("hello");
    const [{ init }] = tun.dialed as [Dialed];
    expect(init).toMatchObject({ method: "GET", redirect: "manual", proxy: false });
    expect(new Headers(init.headers).get("host")).toBe("site.test");
    expect(tun.asked).toEqual(["site.test"]);
    // Cloudflare, reached by its address, by GET, with no proxy, in the call's time.
    expect(dns.asked.map(({ url }) => url)).toEqual([
      "https://1.1.1.1/dns-query?name=site.test&type=A",
      "https://1.1.1.1/dns-query?name=site.test&type=AAAA",
    ]);
    for (const asked of dns.asked) {
      expect(asked.init).toMatchObject({ proxy: false });
      expect(asked.init.method ?? "GET").toBe("GET");
      expect(new Headers(asked.init.headers).get("accept")).toBe("application/dns-json");
      expect(asked.init.signal).toBeInstanceOf(AbortSignal);
    }

    // Over https, its name goes out for SNI and the certificate check, as anywhere.
    const secure = await tool.execute({ url: "https://site.test/tea" }, toolContext());
    expect(secure.content).toBe("secure, for site.test");
    expect(tun.dialed.at(-1)?.url).toBe(`https://${SITE_IP}/tea`);
    expect(tun.dialed.at(-1)?.init.tls).toEqual({ serverName: "site.test" });
  });

  test("one stand-in among the system's addresses sets its whole answer aside", async () => {
    // A proxy that fakes A records and passes AAAA through answers with both.
    const names = resolver({ "mixed.test": ["2001:db8:7::1", "198.19.37.74"] });
    const dial = dialer();
    const dns = cloudflare({ "mixed.test": [SITE_IP] });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: names.lookup,
      fetch: dial.fetch,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    expect((await tool.execute({ url: "http://mixed.test/hello" }, toolContext())).content).toBe(
      "hello",
    );
    expect(dns.asked.map(({ url }) => new URL(url).searchParams.get("type"))).toEqual([
      "A",
      "AAAA",
    ]);
    expect(dial.dialed.map(({ url }) => url)).toEqual([`http://${SITE_IP}/hello`]);
  });

  test("when none of the real addresses can be reached, says they were dialed in the proxy's place", async () => {
    const tun = fakeIpTun({ "v6only.test": "2001:db8:6::1" });
    const dns = cloudflare({ "v6only.test": ["2001:db8:6::1"] });
    // As Bun fails where the proxy carries IPv4 alone, leaving IPv6 no route.
    const unroutable: WebFetcher = async (url, init) => {
      tun.dialed.push({ url, init });
      throw Object.assign(new TypeError("EHOSTUNREACH: Was there a typo in the url or port?"), {
        code: "EHOSTUNREACH",
      });
    };
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: unroutable,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    expect(await tool.execute({ url: "https://v6only.test/" }, toolContext())).toEqual({
      content:
        "Couldn't connect to v6only.test at the addresses Cloudflare's DNS over HTTPS (1.1.1.1) " +
        "gave, which web_fetch dials in place of the ones this computer's fake-IP proxy hands " +
        "out: EHOSTUNREACH: Was there a typo in the url or port?",
      isError: true,
    });
    expect(tun.dialed.map(({ url }) => url)).toEqual(["https://[2001:db8:6::1]/"]);
  });

  test("each redirect's target is looked up the same way", async () => {
    const tun = fakeIpTun({ "site.test": SITE_IP, "localtest.me": "127.0.0.1" });
    const dns = cloudflare({ "site.test": [SITE_IP], "localtest.me": ["127.0.0.1"] });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: tun.fetch,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    const target = `http://localtest.me:${http.port}/hello`;
    const served = seen.length;
    const result = await tool.execute(
      { url: `http://site.test/redirect?to=${target}` },
      toolContext(),
    );
    expect(result).toEqual({
      content: `http://site.test/redirect?to=${target} redirected to ${target}: localtest.me resolves to 127.0.0.1, ${LOCAL}`,
      isError: true,
      details: redirectedAt(`http://site.test/redirect?to=${target}`),
    });
    expect(seen.slice(served).map(({ path }) => path)).toEqual([`/redirect?to=${target}`]);
    expect(tun.dialed.map(({ url }) => url)).toEqual([`http://${SITE_IP}/redirect?to=${target}`]);
  });

  test("refuses the proxy's own addresses, in a URL or in the real answer", async () => {
    const { run, dialed, asked } = webFetch();
    for (const url of [
      "http://198.18.0.1/",
      "http://198.19.37.90:8080/",
      "http://198.19.255.255/",
      "http://[::ffff:198.18.0.1]/",
    ]) {
      const result = await run({ url });
      expect(result).toEqual({ content: `${new URL(url).hostname} is ${FAKE}`, isError: true });
    }
    expect(dialed).toEqual([]);
    expect(asked).toEqual([]);

    const tun = fakeIpTun({ "fake.test": "198.18.0.5" });
    const dns = cloudflare({ "fake.test": ["198.18.0.5"] });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: tun.fetch,
      doh: dns.doh,
      interfaces: INTERFACES,
    });
    expect(await tool.execute({ url: "http://fake.test/" }, toolContext())).toEqual({
      content: `fake.test resolves to 198.18.0.5, ${FAKE}`,
      isError: true,
    });
    expect(tun.dialed).toEqual([]);
  });

  test("fails, never dialing the proxy's address, when the real one can't be had", async () => {
    const tun = fakeIpTun({ "site.test": SITE_IP });
    const fetchWith = (doh: WebFetcher) =>
      createWebFetchTool({
        web: ANY,
        lookup: tun.lookup,
        fetch: tun.fetch,
        doh,
        interfaces: INTERFACES,
      }).execute({ url: "http://site.test/hello" }, toolContext());
    const behind =
      "Can't find site.test: this computer's DNS answers through a fake-IP proxy, and " +
      "Cloudflare's DNS over HTTPS (1.1.1.1), asked for the real address,";
    const answers = cloudflare({ "site.test": [SITE_IP] }).doh;
    const failures: [WebFetcher, string][] = [
      [
        async () => {
          throw new TypeError("Unable to connect. Is the computer able to access the url?");
        },
        "failed: Unable to connect. Is the computer able to access the url?",
      ],
      [async () => new Response("busy", { status: 503 }), "answered HTTP 503."],
      [async () => Response.json({ Status: 2 }), "answered with DNS status 2."],
      // A CNAME alone is no address.
      [
        async () =>
          Response.json({
            Status: 0,
            Answer: [{ name: "site.test", type: 5, TTL: 300, data: "edge.site.test." }],
          }),
        "has none.",
      ],
      // Either question failing fails the call.
      [
        async (url, init) =>
          url.endsWith("type=AAAA") ? new Response(null, { status: 502 }) : answers(url, init),
        "answered HTTP 502.",
      ],
    ];
    for (const [doh, why] of failures) {
      expect(await fetchWith(doh)).toEqual({ content: `${behind} ${why}`, isError: true });
    }
    // A name that doesn't exist reads as it does without the proxy.
    expect(await fetchWith(cloudflare({}).doh)).toEqual({
      content: "Can't find site.test (ENOTFOUND).",
      isError: true,
    });
    expect(tun.dialed).toEqual([]);
  });

  test("its time and its cancel reach the DNS over HTTPS request", async () => {
    const tun = fakeIpTun({ "site.test": SITE_IP });
    const signals: AbortSignal[] = [];
    // Settles only when its request is aborted, as fetch does.
    const silent: WebFetcher = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    const tool = createWebFetchTool({
      web: ANY,
      lookup: tun.lookup,
      fetch: tun.fetch,
      doh: silent,
      interfaces: INTERFACES,
      timeoutMs: 200,
    });
    expect(await tool.execute({ url: "http://site.test/" }, toolContext())).toEqual({
      content:
        "Timed out after 0.2 s fetching http://site.test/: this computer's DNS answers through a " +
        "fake-IP proxy, and Cloudflare's DNS over HTTPS (1.1.1.1), asked for site.test's real " +
        "address, hadn't answered.",
      isError: true,
    });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(
      await tool.execute({ url: "http://site.test/" }, toolContext(controller.signal)),
    ).toEqual({ content: "Operation aborted", isError: true });
    expect(tun.dialed).toEqual([]);
  });
});

describe("webFetchHost", () => {
  test("names the site a call would reach first, as WebAccess.allows hears it", () => {
    expect(webFetchHost({ url: "https://Example.COM./a?b" })).toBe("example.com");
    expect(webFetchHost({ url: " http://tea.test:8080/ " })).toBe("tea.test");
    expect(webFetchHost({ url: "https://中文.com/" })).toBe("xn--fiq228c.com");
    expect(webFetchHost({ url: "http://93.184.216.34/" })).toBe("93.184.216.34");
    expect(webFetchHost({ url: "http://[2606:4700::1111]/" })).toBe("[2606:4700::1111]");
  });

  test("is null for a call there is nothing to ask about: its tool refuses it whatever the answer", () => {
    for (const url of [
      undefined,
      3,
      "example.com",
      "ftp://example.com/",
      "http://localhost:3000/",
      "http://localhost../",
      "http://printer.local/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://198.18.0.1/",
      "http://198.19.37.90/",
    ]) {
      expect([url, webFetchHost({ url })]).toEqual([url, null]);
    }
  });
});

describe("htmlToText", () => {
  test("keeps headings, paragraphs, list items, links, tables and code; drops what isn't read", () => {
    const html = `<!doctype html>
<html><head><title>Tea &amp; Milk</title>
<style>body { color: red }</style><script>alert("<p>no</p>")</script></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<h1>Milk  tea</h1>
<p>Brewed   with <a href="/leaves?kind=green&amp;size=2">green leaves</a> and
<code>milk</code>.</p>
<p>Second<br>line &lt;b&gt; &#x4E2D;&#25991; &nbsp;done&hellip; &unknown; &#0;</p>
<ul><li>One<li>Two <a href="https://example.org/two">https://example.org/two</a></ul>
<ol><li><p>First</p></li><li>Second</li></ol>
<pre><code>const x = 1;
  if (x &lt; 2) {}
</code></pre>
<table>
<tr><th>Name</th> <th>Price</th></tr>
<tr><td>Tea<td>3</tr>
</table>
<div><a href="/card"><h2>A card</h2><span>more</span></a></div>
<noscript>Enable JavaScript</noscript>
<svg><text>logo</text></svg>
<template><p>hidden</p></template>
<a href="#top">Back to top</a>
<a href="javascript:void(0)">Click</a> <a href="mailto:tea@example.org">Mail</a>
<footer>© 2026</footer>
</body></html>`;
    expect(htmlToText(html, "https://site.test/menu/")).toBe(
      [
        "Tea & Milk",
        "# Milk tea",
        "Brewed with green leaves (https://site.test/leaves?kind=green&size=2) and `milk`.",
        "Second\nline <b> 中文 done… &unknown; �",
        "- One\n- Two https://example.org/two",
        "- First\n- Second",
        "```\nconst x = 1;\n  if (x < 2) {}\n```",
        "Name | Price\nTea | 3",
        "## A card",
        "more (https://site.test/card)",
        "Back to top Click Mail (mailto:tea@example.org)",
      ].join("\n\n"),
    );
  });

  test("an unclosed pre or a page with no text ends cleanly", () => {
    expect(htmlToText("<p>a</p><pre>\n  b\n", "https://site.test/")).toBe("a\n\n```\n  b\n```");
    expect(htmlToText("<script>render()</script>", "https://site.test/")).toBe("");
  });

  test("a page with no text says why", async () => {
    const tool = createWebFetchTool({
      web: ANY,
      lookup: resolver(NAMES).lookup,
      fetch: async () =>
        new Response('<div id="root"></div><script src="/app.js"></script>', {
          headers: { "content-type": "text/html" },
        }),
    });
    expect((await tool.execute({ url: "http://site.test/" }, toolContext())).content).toBe(
      "[The page has no text without its scripts, which web_fetch doesn't run]",
    );
  });
});

describe("createTaskTools", () => {
  const guard: PathGuard = { folder: "/tmp/task", resolve: async (path) => path };

  test("offers web_fetch, before todo, only with sites to reach", () => {
    expect(createTaskTools(guard).map((tool) => tool.schema.name)).not.toContain(WEB_FETCH);
    const tools = createTaskTools(guard, { web: ANY });
    expect(tools.map((tool) => tool.schema.name)).toEqual([
      "read",
      "write",
      "edit",
      "ls",
      "find",
      "grep",
      "web_fetch",
      "todo",
    ]);
    const tool = tools.find((candidate) => candidate.schema.name === WEB_FETCH);
    // Fetching changes nothing, so a restart runs it again.
    expect(tool?.replay).toBe("safe");
    expect(tool?.executionMode).toBeUndefined();
    expect(tool?.snippet).not.toBe("");
    expect(tool?.guidelines.length).toBeGreaterThan(0);
    expect(tool?.schema.required).toEqual(["url"]);
  });
});
