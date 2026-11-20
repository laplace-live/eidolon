// Settings' Assistant Mode section beyond its rows: what keeps a kind or web search from running,
// the commands allowed for good, and the MCP servers. Rendered to markup, with the macros stubbed.
import { SETTINGS } from "@eidolon/config";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import type { AssistantStatus, SettingRow } from "@/lib/api";
import { statusQuery } from "@/lib/query";
import { linguiMacro, linguiReactMacro } from "@/test/lingui-macro";

vi.doMock("@lingui/core/macro", linguiMacro);
vi.doMock("@lingui/react/macro", linguiReactMacro);
const { AssistantCard, KindsCard } = await import("./assistant");
const { AllowedCommandsCard, allowedCommandsQuery } = await import("./commands-card");
const { McpServersCard, mcpServersQuery, commandLine } = await import("./mcp-card");
const { settingsQuery } = await import("@/components/settings-form/queries");
const { PROVIDER_OFF_LABELS } = await import("@/components/settings-form/labels");
const { CARDS } = await import("./sections");

const READY: AssistantStatus = {
  enabled: true,
  ready: true,
  problem: null,
  running: 0,
  search: { on: false, problem: null },
  kinds: { quick: null, coding: null, research: null },
};

const rows: SettingRow[] = SETTINGS.map((setting) => ({
  ...setting,
  value: null,
  source: "default",
  envValue: null,
  envName: null,
  envOverride: false,
  productionOnly: setting.path.startsWith("mcp."),
  readOnly: false,
}));

function render(node: ReactNode, data: ReadonlyArray<readonly [readonly unknown[], unknown]>) {
  const client = new QueryClient();
  for (const [key, value] of data) client.setQueryData(key, value);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(I18nProvider, { i18n }, createElement(QueryClientProvider, { client }, node)),
    ),
  );
}

/** `markup`'s text, its tags dropped and its entities read. */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ");

const card = (id: "assistant" | "kinds") => {
  const spec = CARDS.assistant.find((each) => each.id === id);
  if (spec === undefined) throw new Error(`no card ${id}`);
  return { paths: spec.paths, title: id, description: "" };
};

const settings = [
  settingsQuery().queryKey,
  { persona: "milky-green", settings: rows, voiceStyles: {}, warnings: [], restartRequired: false },
] as const;

describe("Models by Kind", () => {
  test("shows each kind's account beside its model, and why a kind runs on Assistant Mode's for now", () => {
    const status = {
      assistant: {
        ...READY,
        kinds: {
          quick: null,
          coding: "Anthropic needs a model: set ASSISTANT_CODING_MODEL",
          research: null,
        },
      },
    };
    const said = text(
      render(createElement(KindsCard, card("kinds")), [settings, [statusQuery.queryKey, status]]),
    );
    for (const title of ["Quick Task Provider", "Coding Task Model", "Research Task Provider"]) {
      expect(said).toContain(title);
    }
    expect(said).toContain(
      "Coding tasks run on Assistant Mode's model for now Anthropic needs a model: set ASSISTANT_CODING_MODEL",
    );
    expect(said).not.toContain("Quick tasks run on");
  });

  test("a kind with no account of its own says it follows Assistant Tasks, and search says it is off", () => {
    const off = Object.fromEntries(
      Object.entries(PROVIDER_OFF_LABELS).map(([role, label]) => [role, label?.message]),
    );
    expect(off).toMatchObject({
      "assistant-quick": "Same as Assistant Tasks",
      "assistant-coding": "Same as Assistant Tasks",
      "assistant-research": "Same as Assistant Tasks",
      search: "Off: No Web Search",
    });
  });
});

describe("the Assistant Mode card", () => {
  test("says why web search is off once an account is chosen for it, and nothing while none is", () => {
    const off = {
      assistant: { ...READY, search: { on: false, problem: "No key for OpenRouter" } },
    };
    const said = text(
      render(createElement(AssistantCard, card("assistant")), [
        settings,
        [statusQuery.queryKey, off],
      ]),
    );
    expect(said).toContain("Web search is off: No key for OpenRouter");
    for (const title of ["Web Search Provider", "Web Search Engine", "Assistant Commands"]) {
      expect(said).toContain(title);
    }
    const unset = text(
      render(createElement(AssistantCard, card("assistant")), [
        settings,
        [statusQuery.queryKey, { assistant: READY }],
      ]),
    );
    expect(unset).not.toContain("Web search is off");
  });
});

describe("Allowed Commands", () => {
  test("lists each command whole and escaped, with its folder and Remove", () => {
    const commands = [
      {
        id: "0190f5c8-0000-7000-8000-00000000c001",
        folder: "/Users/me/site",
        command: "npm test\u202E",
        addedAt: 2,
        task: "0190f5c8-0000-7000-8000-00000000a001",
      },
    ];
    const markup = render(createElement(AllowedCommandsCard), [
      [allowedCommandsQuery.queryKey, { commands }],
    ]);
    expect(markup).toContain('data-allowed-command="0190f5c8-0000-7000-8000-00000000c001"');
    expect(markup).toContain("npm test");
    expect(markup).toContain("\\u{202E}</mark>");
    expect(markup).not.toContain("\u202E");
    expect(text(markup)).toContain("/Users/me/site Remove");
  });

  test("says when there are none, and how one is added", () => {
    const said = text(
      render(createElement(AllowedCommandsCard), [
        [allowedCommandsQuery.queryKey, { commands: [] }],
      ]),
    );
    expect(said).toContain("None yet.");
    expect(said).toContain("Always in This Folder on a task's card adds one.");
  });
});

describe("MCP Servers", () => {
  const github = {
    name: "github",
    command: "docker",
    args: ["run", "-i", "--rm", "--init", "ghcr.io/github/github-mcp-server"],
    enabled: true,
    description: "Issues and pull requests",
    alwaysAllow: ["get_issue", "search_issues"],
    needs: [
      { name: "GITHUB_TOKEN", set: false },
      { name: "OTHER", set: true },
    ],
    problem: null,
  };

  test("warns that a server is a program, and lists each with its switch, its Always and the secrets it lacks", () => {
    const markup = render(createElement(McpServersCard), [
      [
        mcpServersQuery.queryKey,
        { path: "/home/.laplace/eidolon/mcp.json", servers: [github], errors: [] },
      ],
    ]);
    const said = text(markup);
    expect(said).toContain("Only Add Programs You Trust");
    expect(said).toContain("from /home/.laplace/eidolon/mcp.json");
    expect(said).toContain("docker run -i --rm --init ghcr.io/github/github-mcp-server");
    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Stop Always Allowing get_issue"');
    expect(markup).toContain('aria-label="Stop Always Allowing search_issues"');
    expect(said).toContain(
      "Needs GITHUB_TOKEN: set it in credentials.json's mcpSecrets or the environment",
    );
    expect(said).not.toContain("Needs OTHER");
  });

  test("with none, shows where they go and an example; a file that doesn't parse says nothing starts", () => {
    const empty = text(
      render(createElement(McpServersCard), [
        [mcpServersQuery.queryKey, { path: "/h/mcp.json", servers: [], errors: [] }],
      ]),
    );
    expect(empty).toContain("No servers yet. Add them to /h/mcp.json");
    expect(empty).toContain('"mcpServers"');
    expect(empty).toContain(`"GITHUB_PERSONAL_ACCESS_TOKEN": "\${GITHUB_TOKEN}"`);
    expect(empty).toContain(`write \${NAME} where one goes`);
    const broken = text(
      render(createElement(McpServersCard), [
        [
          mcpServersQuery.queryKey,
          { path: "/h/mcp.json", servers: [], errors: ["/h/mcp.json isn't valid JSON"] },
        ],
      ]),
    );
    expect(broken).toContain(
      "No MCP server starts until mcp.json is fixed /h/mcp.json isn't valid JSON",
    );
  });

  test("a broken entry keeps its switch, unless it isn't an object, which only the file changes", () => {
    const broken = { enabled: true, alwaysAllow: [], needs: [] };
    const markup = render(createElement(McpServersCard), [
      [
        mcpServersQuery.queryKey,
        {
          path: "/h/mcp.json",
          servers: [
            { ...broken, name: "odd", problem: 'server "odd": tools must be an array of strings' },
            {
              ...broken,
              name: "listed",
              problem: 'server "listed" must be an object',
              unchangeable: true,
            },
          ],
          errors: [],
        },
      ],
    ]);
    const row = (name: string) =>
      markup.split(`data-mcp-server="${name}"`)[1]?.split("</li>")[0] ?? "";
    expect(row("odd")).toContain('role="switch"');
    expect(row("odd")).not.toContain('disabled=""');
    expect(row("listed")).toContain('role="switch"');
    expect(row("listed")).toContain('disabled=""');
  });

  test("a server's command reads as mcp.json writes it, its references unresolved", () => {
    expect(commandLine({ command: "npx", args: ["-y", `\${PKG}`] })).toBe(`npx -y \${PKG}`);
    expect(commandLine({ command: undefined, args: undefined })).toBe("");
    expect(commandLine({ command: "npx", args: ["my server", "", 'say "hi"'] })).toBe(
      'npx "my server" "" "say \\"hi\\""',
    );
  });
});
