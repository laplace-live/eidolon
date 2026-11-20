// A fake MCP server over stdio for the MCP client's tests. It prints its pid to stderr, then:
// --child starts a child in its process group; --pidfile PATH writes both pids there; --hang never
// answers initialize; --print NAME prints $NAME to stderr and exits; --trail N prints N more
// characters of stderr after a token it prints; --tools N lists N more tools, each with --pad
// characters of description; --name a,b lists tools named a and b first; --description JSON is
// echo's description; --deep N lists a tool whose schema nests N deep.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

console.error(`pid ${process.pid}`);
const child = flag("--child")
  ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  : undefined;
const pidfile = option("--pidfile");
if (pidfile !== undefined) writeFileSync(pidfile, JSON.stringify([process.pid, child?.pid]));
const trail = () => {
  const count = Number(option("--trail") ?? 0);
  if (count > 0) console.error("y".repeat(count));
};
const printed = option("--print");
if (printed !== undefined) {
  console.error(`starting with token ${process.env[printed]}`);
  trail();
  process.exit(1);
}
// Keeps the process alive once stdin closes, as a server busy at startup is.
if (flag("--hang")) setInterval(() => {}, 1000);

const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const named = (option("--name") ?? "").split(",").filter(Boolean);
const extra = Number(option("--tools") ?? 0);
const pad = "x".repeat(Number(option("--pad") ?? 0));
const description = option("--description");
const deep = Number(option("--deep") ?? 0);

const TOOLS = [
  ...named.map((name) => ({ name, inputSchema: object() })),
  {
    name: "echo",
    description: description === undefined ? "Says the text back." : JSON.parse(description),
    inputSchema: object({ text: { type: "string" } }, ["text"]),
    annotations: { readOnlyHint: true },
  },
  { name: "image", description: "An image.", inputSchema: object() },
  { name: "media", description: "Every other kind of content.", inputSchema: object() },
  { name: "fail", description: "Fails, saying why.", inputSchema: object() },
  { name: "fail_silent", description: "Fails, saying nothing.", inputSchema: {} },
  { name: "big", description: "40 KB of lines.", inputSchema: object() },
  { name: "structured", description: "Structured content only.", inputSchema: object() },
  { name: "slow", description: "Waits for its cancel.", inputSchema: object() },
  { name: "cancelled", description: "The requests cancelled so far.", inputSchema: object() },
  {
    name: "env",
    description: "Its environment's names, its folder and the values asked for.",
    inputSchema: object({ values: { type: "array", items: { type: "string" } } }),
    annotations: { readOnlyHint: true },
  },
  { name: "roots", description: "The client's roots.", inputSchema: object() },
  { name: "crash", description: "Exits.", inputSchema: object() },
  {
    name: "nested",
    description: "Takes a tree.",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { tree: { $ref: "#/$defs/Node", description: "The root" } },
      required: ["tree"],
      $defs: {
        Node: {
          type: "object",
          properties: {
            label: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
          required: ["label"],
        },
      },
    },
    annotations: { destructiveHint: true },
  },
  ...Array.from({ length: extra }, (_, index) => ({
    name: `t${index}`,
    description: `Tool ${index}. ${pad}`,
    inputSchema: object(),
  })),
  ...(deep > 0
    ? [
        {
          name: "deep",
          description: "Takes a schema nested past any stack.",
          inputSchema: object({ x: "DEEP" }),
        },
      ]
    : []),
];
// V8's JSON.stringify overflows its stack on a value nested that deep, so its text goes in whole.
const DEEP = `${'{"a":'.repeat(deep)}{}${"}".repeat(deep)}`;

const cancelled = [];
const waiting = new Map();
const asked = new Map();
let nextAsk = 1;

const send = (message) =>
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", ...message }).replace('"x":"DEEP"', `"x":${DEEP}`)}\n`,
  );
const text = (value) => ({ content: [{ type: "text", text: value }] });
const PIXEL = Buffer.from("not really a png").toString("base64");

function ask(method, params) {
  const id = `ask-${nextAsk++}`;
  send({ id, method, params });
  return new Promise((resolve) => asked.set(id, resolve));
}

async function call(id, name, args) {
  switch (name) {
    case "echo":
      return text(String(args.text));
    case "image":
      return { content: [{ type: "image", data: PIXEL, mimeType: "image/png" }] };
    case "media":
      return {
        content: [
          { type: "text", text: "first" },
          { type: "audio", data: PIXEL, mimeType: "audio/wav" },
          {
            type: "resource_link",
            uri: "file:///a.txt",
            name: "a.txt",
            title: "A",
            mimeType: "text/plain",
            size: 2048,
            description: "the first file",
          },
          { type: "resource", resource: { uri: "file:///b.txt", text: "inline text" } },
          {
            type: "resource",
            resource: {
              uri: "file:///c.json",
              mimeType: "application/json",
              blob: Buffer.from('{"ok":true}').toString("base64"),
            },
          },
          {
            type: "resource",
            resource: { uri: "file:///d.png", mimeType: "image/png", blob: PIXEL },
          },
          {
            type: "resource",
            resource: { uri: "file:///e.bin", blob: Buffer.from([1, 2, 3]).toString("base64") },
          },
        ],
      };
    case "fail":
      return { content: [{ type: "text", text: "it broke" }], isError: true };
    case "fail_silent":
      return { content: [], isError: true };
    case "big":
      return text(
        Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(4, "0")}`).join("\n"),
      );
    case "structured":
      return { structuredContent: { count: 2, items: ["a", "b"] } };
    case "slow":
      return new Promise((resolve) => waiting.set(id, resolve));
    case "cancelled":
      return text(JSON.stringify(cancelled));
    case "env":
      return text(
        JSON.stringify({
          names: Object.keys(process.env).sort(),
          cwd: process.cwd(),
          values: Object.fromEntries(
            (args.values ?? []).map((key) => [key, process.env[key] ?? null]),
          ),
        }),
      );
    case "roots":
      return text(JSON.stringify(await ask("roots/list")));
    case "crash":
      console.error(`crashing now${process.env.TOKEN ? ` with ${process.env.TOKEN}` : ""}`);
      trail();
      process.exit(3);
      break;
    default:
      return text(`ran ${name}`);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "notifications/cancelled") {
    cancelled.push(message.params.requestId);
    waiting.get(message.params.requestId)?.(null);
    return;
  }
  if (!("method" in message)) {
    asked.get(message.id)?.(message.result ?? message.error);
    return;
  }
  if (!("id" in message)) return;
  if (message.method === "initialize") {
    if (flag("--hang")) return;
    send({
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      },
    });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: TOOLS } });
  } else if (message.method === "tools/call") {
    const result = await call(message.id, message.params.name, message.params.arguments ?? {});
    // A cancelled call gets no answer, as the spec asks.
    if (result !== null) send({ id: message.id, result });
  } else if (message.method === "ping") {
    send({ id: message.id, result: {} });
  } else {
    send({ id: message.id, error: { code: -32601, message: "not found" } });
  }
});
