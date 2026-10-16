import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { navigate } from "../lib/router.ts";
import { PageTabs } from "../components/PageTabs.tsx";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { McpIcon } from "../components/icons.tsx";
import { ClaudeLogo, CursorLogo, OpenAiLogo } from "./logos.tsx";

// D-86: the MCP page (sidebar "MCP", /connect; /mcp itself is the server). After Mintlify's MCP page:
// Connect (pick your AI app, one button) and API tokens (the credentials it and the jun CLI use).
// Was Settings → Developer; /settings/developer links forward here (movedFromSettings).

export type ConnectTab = "connect" | "tokens";

export function ConnectPage({ workspaceId, tab }: { workspaceId: string; tab: ConnectTab }) {
  return (
    <PageTabs
      title="MCP"
      value={tab}
      tabs={[
        {
          value: "connect",
          label: "Connect",
          path: "/connect",
          content: (
            <div className="page-settings settings-sections">
              <McpCard workspaceId={workspaceId} />
            </div>
          ),
        },
        {
          value: "tokens",
          label: "API tokens",
          path: "/connect/tokens",
          content: (
            <div className="page-settings settings-sections">
              <TokensPanel workspaceId={workspaceId} />
            </div>
          ),
        },
      ]}
    />
  );
}

interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Personal API tokens for the `jun` CLI (pull, push, eval) and the MCP connection. */
export function TokensPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/tokens`;
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setTokens((await api<{ tokens: TokenRow[] }>(base)).tokens), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name"));
    run(async () => {
      setCreated((await api<{ token: string }>(base, { body: { name } })).token);
      form.reset();
      await load();
    });
  };

  return (
    <>
      <SettingsCard
        title="API tokens"
        id="api-tokens"
        description={<>For the <code>jun</code> CLI (keep the agent in git, run evals and push changes: <code>npm run jun -- login {window.location.origin}</code> in your Jun checkout) and for your AI's MCP connection (the Connect tab makes one for you). A token acts as you, for this workspace's agent config only.</>}
      >
        {created && (
          <div className="invite">
            <span className="small strong">Copy it now: it won't be shown again.</span>
            <code className="small">{created}</code>
            <Button variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(created); }}>Copy</Button>
          </div>
        )}
        <form className="settings-inline-form" onSubmit={create}>
          <Input name="name" placeholder="Token name, e.g. laptop or GitHub Actions" aria-label="Token name" required maxLength={80} />
          <Button disabled={busy}>Create token</Button>
        </form>
        {error && <p className="error small">{error}</p>}
        {tokens === null ? (
          <ul className="list" aria-hidden="true">
            {[0, 1].map((i) => <li key={i} className="row"><Skeleton className="h-4 w-28" /><Skeleton className="h-3 w-48" /></li>)}
          </ul>
        ) : tokens.length > 0 && (
          <ul className="list">
            {tokens.map((t) => (
              <li key={t.id} className="row">
                <span className="strong">{t.name}</span>
                <span className="muted small">created {new Date(t.createdAt).toLocaleDateString()} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
                <span className="spacer" />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); })}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsCard>
    </>
  );
}

type McpClient = "claude-code" | "cursor" | "codex" | "other";

/**
 * D-86: connect a person's own AI to this desk's MCP server, after Mintlify's MCP page: pick the app,
 * one button. The button makes an API token named after the app (kept for the session, so a second
 * press reuses it), then copies the command or opens Cursor's install link with it filled in. The
 * text stays on screen afterwards: the token is shown only this once.
 */
export function McpCard({ workspaceId }: { workspaceId: string }) {
  const url = `${window.location.origin}/mcp`;
  const [client, setClient] = useState<McpClient>("claude-code");
  const [tokens, setTokens] = useState<Partial<Record<McpClient, string>>>({});
  const [done, setDone] = useState<{ client: McpClient; copied: boolean } | null>(null);
  const { busy, error, run } = useAction();
  const key = tokens[client] ?? "jun_…";
  const config = (token: string) => ({ url, headers: { Authorization: `Bearer ${token}` } });
  const clients: Record<McpClient, { tab: string; Logo: (props: { className?: string }) => ReactNode; title: string; line: string; button: string; name: string; text: (token: string) => string }> = {
    "claude-code": {
      tab: "Claude Code",
      Logo: ClaudeLogo,
      title: "Add Jun to Claude Code",
      line: "Copies a terminal command with a new token in it. Run it once.",
      button: "Copy command",
      name: "Claude Code",
      text: (token) => `claude mcp add --transport http jun ${url} --header "Authorization: Bearer ${token}"`,
    },
    cursor: {
      tab: "Cursor",
      Logo: CursorLogo,
      title: "Add Jun to Cursor",
      line: "Opens Cursor with Jun filled in, using a new token.",
      button: "Add to Cursor",
      name: "Cursor",
      text: (token) => JSON.stringify({ mcpServers: { jun: config(token) } }, null, 2),
    },
    codex: {
      tab: "Codex",
      Logo: OpenAiLogo,
      title: "Add Jun to Codex",
      line: "Copies the lines for ~/.codex/config.toml, with a new token for your shell.",
      button: "Copy config",
      name: "Codex",
      text: (token) => `[mcp_servers.jun]\nurl = "${url}"\nbearer_token_env_var = "JUN_DESK_TOKEN"\n\n# and in your shell: export JUN_DESK_TOKEN=${token}`,
    },
    other: {
      tab: "Others",
      Logo: McpIcon,
      title: "Connect over MCP",
      line: "Any AI app that supports MCP servers over HTTP: add this configuration.",
      button: "Copy configuration",
      name: "MCP",
      text: (token) => JSON.stringify({ mcpServers: { jun: config(token) } }, null, 2),
    },
  };
  const c = clients[client];

  const connect = () =>
    run(async () => {
      let token = tokens[client];
      if (!token) {
        token = (await api<{ token: string }>(`/workspaces/${workspaceId}/tokens`, { body: { name: c.name } })).token;
        const made = token;
        setTokens((t) => ({ ...t, [client]: made }));
      }
      if (client === "cursor") {
        window.location.href = `cursor://anysphere.cursor-deeplink/mcp/install?name=jun&config=${encodeURIComponent(btoa(JSON.stringify(config(token))))}`;
        setDone({ client, copied: false });
        return;
      }
      const copied = await navigator.clipboard?.writeText(c.text(token)).then(() => true, () => false);
      setDone({ client, copied: Boolean(copied) });
    });

  const justDone = done?.client === client ? done : null;
  return (
    <SettingsCard
      title="Connect your AI"
      id="mcp"
      description="Let your own AI change the support agent: tasks, actions, widgets, tests and desk settings, tested and saved as versions you can restore."
    >
      <div className="segmented mcp-tabs" role="group" aria-label="Your AI app">
        {(Object.keys(clients) as McpClient[]).map((id) => (
          <Button key={id} type="button" variant="ghost" size="sm" className={client === id ? "active" : ""} aria-pressed={client === id} onClick={() => setClient(id)}>{(() => { const { Logo } = clients[id]; return <Logo className="mcp-tab-logo" />; })()}{clients[id].tab}</Button>
        ))}
      </div>
      <SettingRow label={c.title} description={c.line}>
        <Button type="button" disabled={busy} onClick={connect}>{c.button}{client === "cursor" && <span aria-hidden="true"> ↗</span>}</Button>
      </SettingRow>
      {error && <p className="error small">{error}</p>}
      {(justDone || client === "other") && (
        <div className="mcp-snippet">
          {justDone && (
            <p className="small muted">
              {client === "cursor" ? "Cursor should open and ask to install Jun. Didn't open? Add this to .cursor/mcp.json." : justDone.copied ? "Copied." : "Copy this:"}{" "}
              The token "{c.name}" is listed under <a href="/connect/tokens" onClick={(e) => { e.preventDefault(); navigate("/connect/tokens"); }}>API tokens</a>; its value is shown only here, once.
            </p>
          )}
          <div className="mcp-snippet-code">
            <pre className="agent-git-commands">{c.text(key)}</pre>
            {tokens[client] && <Button variant="outline" size="sm" type="button" onClick={() => { void navigator.clipboard?.writeText(c.text(key)); }}>Copy</Button>}
          </div>
        </div>
      )}
      <p className="small muted">
        Server: <code>{url}</code>. Then ask your AI things like "add a refund task that looks up the order with our API, test it, and make it live". <a href="https://jun-6ced7499.mintlify.app/code/mcp" target="_blank" rel="noreferrer">How it works</a>
      </p>
    </SettingsCard>
  );
}
