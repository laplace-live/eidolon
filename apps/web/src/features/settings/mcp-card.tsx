// Settings' MCP Servers: what mcp.json in the data home declares, each server with a switch, the
// tools a task calls without asking (each taken back with a click), the secrets it lacks and why it
// can't start. Only a task's card adds to Always; the file itself is edited by hand.

import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon, XIcon } from "lucide-react";
import { useId } from "react";
import { ErrorAlert } from "@/components/error-alert";
import { FieldSkeletons, SectionCard } from "@/components/section-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { call, type McpServerChange, type McpServerView } from "@/lib/api";
import { toastError } from "@/lib/feedback";

/** A secret's reference as mcp.json writes one. */
const REFERENCE = `\${NAME}`;

/** Two entries in the shape other MCP clients share: a package, and a container with a secret. */
const EXAMPLE = `{
  "mcpServers": {
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    },
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--init", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "\${GITHUB_TOKEN}" }
    }
  }
}`;

export const mcpServersQuery = queryOptions({
  queryKey: ["assistant", "mcp"],
  queryFn: ({ signal }) => call("GET /api/local/mcp", { signal }),
  // mcp.json is edited by hand, outside the app.
  refetchOnWindowFocus: true,
});

/** The command a server starts with, as mcp.json writes it, its references unresolved. */
export function commandLine(server: Pick<McpServerView, "command" | "args">): string {
  return [server.command ?? "", ...(server.args ?? [])].filter((part) => part !== "").join(" ");
}

function ServerRow({
  server,
  busy,
  onChange,
}: {
  readonly server: McpServerView;
  readonly busy: boolean;
  readonly onChange: (change: McpServerChange) => void;
}) {
  const { t } = useLingui();
  const switchId = useId();
  const command = commandLine(server);
  const missing = server.needs.filter((need) => !need.set);
  return (
    <li className="flex flex-col gap-2 py-4 first:pt-0 last:pb-0" data-mcp-server={server.name}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <span className="wrap-anywhere font-medium">{server.name}</span>
          {server.description && (
            <p className="wrap-anywhere text-muted-foreground text-xs">{server.description}</p>
          )}
          {command !== "" && (
            <p className="wrap-anywhere font-mono text-muted-foreground text-xs">{command}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={server.enabled}
            // The server refuses to change an entry that doesn't parse: the file needs fixing.
            disabled={busy || Boolean(server.problem)}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
          <Label htmlFor={switchId}>{t`Enabled`}</Label>
        </div>
      </div>
      {server.alwaysAllow.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">{t`Always Allowed`}</span>
          {server.alwaysAllow.map((tool) => (
            <Badge key={tool} variant="outline" className="gap-0.5 pr-0.5 font-mono font-normal">
              {tool}
              <button
                type="button"
                aria-label={t`Stop Always Allowing ${ph({ tool })}`}
                disabled={busy}
                onClick={() => onChange({ revoke: tool })}
                className="rounded-full p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      {missing.map((need) => (
        <p key={need.name} className="wrap-anywhere text-warning text-xs">
          {t`Needs ${ph({ name: need.name })}: set it in credentials.json's mcpSecrets or the environment`}
        </p>
      ))}
      {server.problem && <p className="wrap-anywhere text-destructive text-xs">{server.problem}</p>}
    </li>
  );
}

export function McpServersCard() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const servers = useQuery(mcpServersQuery);
  const change = useMutation({
    mutationFn: ({ name, body }: { readonly name: string; readonly body: McpServerChange }) =>
      call("PUT /api/local/mcp/servers/:name", { params: { name }, body }),
    onSuccess: (data) => queryClient.setQueryData(mcpServersQuery.queryKey, data),
    onError: (error) => {
      toastError(error);
      void queryClient.invalidateQueries({ queryKey: mcpServersQuery.queryKey });
    },
  });
  const path = servers.data?.path ?? "mcp.json";
  return (
    <SectionCard
      title={t`MCP Servers`}
      description={t`Programs that give tasks more tools, from ${ph({ path })}. A task asks you before each call it makes to one, unless you chose Always for that tool.`}
    >
      <Alert>
        <TriangleAlertIcon />
        <AlertTitle>{t`Only Add Programs You Trust`}</AlertTitle>
        <AlertDescription>{t`An MCP server is a program on this computer. Eidolon starts it with the command in mcp.json whenever a task begins, with your permissions and outside the task's folders. Each call asks you first, unless you chose Always for that tool. Every task reads how it describes its tools, and unlike a web page, that doesn't make what you allowed for good ask again.`}</AlertDescription>
      </Alert>
      {servers.isPending ? (
        <FieldSkeletons rows={2} />
      ) : servers.isError ? (
        <ErrorAlert error={servers.error} />
      ) : (
        <>
          {servers.data.errors.map((error) => (
            <Alert key={error} variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>{t`No MCP server starts until mcp.json is fixed`}</AlertTitle>
              <AlertDescription className="wrap-anywhere">{error}</AlertDescription>
            </Alert>
          ))}
          {servers.data.servers.length === 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground text-sm">{t`No servers yet. Add them to ${ph({ path })}, in the mcpServers shape other MCP clients use.`}</p>
              <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed">
                {EXAMPLE}
              </pre>
            </div>
          ) : (
            <ul className="flex flex-col divide-y">
              {servers.data.servers.map((server) => (
                <ServerRow
                  key={server.name}
                  server={server}
                  busy={change.isPending && change.variables?.name === server.name}
                  onChange={(body) => change.mutate({ name: server.name, body })}
                />
              ))}
            </ul>
          )}
          <p className="text-muted-foreground text-xs">{t`Keep keys out of mcp.json: write ${ph({ reference: REFERENCE })} where one goes, and set NAME in credentials.json's mcpSecrets or in the environment.`}</p>
        </>
      )}
    </SectionCard>
  );
}
