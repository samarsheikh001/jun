import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { ExternalLinkIcon } from "@/components/icons";
import type { SlackChannel, SlackMode, SlackView } from "../../shared/slack.ts";

// /channels/slack (C-09 / T-13, D-152): the workspace's own Slack app, made from a link that fills in
// Slack's "create app" page; the bot token and signing secret pasted once; then the channel and when
// a chat opens a thread. How it works in Slack is spelled out at the bottom.

/** The overview card's badge. */
export function slackLabel(s: SlackView): { label: string; on: boolean } {
  if (!s.connected) return { label: "Not set up", on: false };
  if (s.status === "broken") return { label: "Needs attention", on: false };
  return s.channel ? { label: "On", on: true } : { label: "Pick a channel", on: false };
}

export function SlackChannelPage({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/slack`;
  const [status, setStatus] = useState<SlackView | null>(null);
  useEffect(() => {
    api<SlackView>(base).then(setStatus, () => {});
  }, [base]);
  const badge = status ? slackLabel(status) : null;

  return (
    <div className="page-tabs">
      <div className="page-tabs-head"><h1>Slack</h1></div>
      <div className="page-settings settings-sections">
        <SettingsCard
          title="Connect your Slack"
          description={<>Your team answers chats from a Slack channel: a chat that needs a person opens a thread there, and a reply in the thread goes to the customer. The app is your own, in your Slack workspace.{!canEdit && " An owner or admin sets it up."}</>}
          action={badge ? <Badge variant={badge.on ? "default" : "secondary"}>{badge.label}</Badge> : <Skeleton className="h-5 w-24 rounded-full" />}
        >
          {!status ? (
            <p className="small"><SkelText width={280} /></p>
          ) : status.connected ? (
            <Connected status={status} base={base} canEdit={canEdit} onChange={setStatus} />
          ) : canEdit ? (
            <ConnectSteps status={status} base={base} onChange={setStatus} />
          ) : (
            <p className="muted small">Not set up yet.</p>
          )}
        </SettingsCard>

        {status?.connected && <ChannelCard status={status} base={base} canEdit={canEdit} onChange={setStatus} />}

        <SettingsCard title="How it works in Slack" description="What your team sees and does in the channel.">
          <ul className="list-disc space-y-2 pl-5 small">
            <li>A chat opens a thread when the AI hands it to the team (or when nobody's answering with the AI off). Choose <em>Every new chat</em> below to get them all.</li>
            <li>The thread starts with a card: who it is, why it needs a person, the AI's summary, the page and browser errors, and <strong>Assign to me</strong>, <strong>Close</strong> and <strong>Open in desk</strong>. The card updates as the chat changes.</li>
            <li>The customer's messages, the AI's and your team's replies from the desk follow in the thread. Notes from the desk show with 🔒.</li>
            <li><strong>A reply in the thread goes to the customer</strong>, under your name. Slack people are matched to desk teammates by email, so use the same address in both.</li>
            <li>To write something only the team sees, hover a message in the thread → ⋯ → <strong>Add internal note</strong>.</li>
            <li>Edits and files in Slack aren't sent to the customer (Slack tells you when that happens); attach files in the desk.</li>
          </ul>
        </SettingsCard>
      </div>
    </div>
  );
}

function ConnectSteps({ status, base, onChange }: { status: SlackView; base: string; onChange: (s: SlackView) => void }) {
  const connect = useAction();
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    connect.run(async () => {
      onChange(await api<SlackView>(`${base}/keys`, { method: "PUT", body: { token, signingSecret: secret } }));
      setToken("");
      setSecret("");
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      {status.local && (
        <p className="error small">This desk runs on your computer, which Slack can't reach. Set Slack up from your deployed desk.</p>
      )}
      <ol className="list-decimal space-y-3 pl-5 small">
        <li>
          <a href={status.manifestUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>Create the app in Slack <ExternalLinkIcon /></a>
          <p className="muted mt-1">Slack opens with everything filled in. Pick your Slack workspace, then Next → Create.</p>
        </li>
        <li>In the app's settings, <strong>Install App</strong> → Install to your workspace → Allow.</li>
        <li>
          Paste two values from the app's settings:
          <div className="mt-2 grid max-w-md gap-2">
            <Input type="password" autoComplete="off" spellCheck={false} placeholder="Bot User OAuth Token (xoxb-…)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Bot User OAuth Token" />
            <p className="muted -mt-1">Under OAuth &amp; Permissions.</p>
            <Input type="password" autoComplete="off" spellCheck={false} placeholder="Signing Secret" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Signing Secret" />
            <p className="muted -mt-1">Under Basic Information → App Credentials.</p>
            <div><Button disabled={connect.busy || !token.trim() || !secret.trim()}>{connect.busy ? "Checking…" : "Connect"}</Button></div>
          </div>
        </li>
      </ol>
      <p className="muted small">Both stay on this desk (never shown again, not in the database).</p>
      {connect.error && <p className="error small">{connect.error}</p>}
    </form>
  );
}

function Connected({ status, base, canEdit, onChange }: { status: SlackView; base: string; canEdit: boolean; onChange: (s: SlackView) => void }) {
  const act = useAction();
  const [replacing, setReplacing] = useState(false);
  const disconnect = () => act.run(async () => onChange(await api<SlackView>(base, { method: "DELETE" })));
  return (
    <div className="space-y-2">
      <p className="small">
        Connected to <strong>{status.teamName}</strong>
        {status.teamUrl && <> (<a href={status.teamUrl} target="_blank" rel="noreferrer">{status.teamUrl.replace(/^https:\/\/|\/$/g, "")}</a>)</>}
        {status.tokenLast4 && <> · token <code>•••• {status.tokenLast4}</code></>}
      </p>
      {status.status === "broken" && status.lastError && <p className="error small">{status.lastError}</p>}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing((r) => !r)}>{replacing ? "Cancel" : "Paste new keys"}</Button>
          <Button type="button" variant="outline" size="sm" disabled={act.busy} onClick={disconnect}>Disconnect</Button>
        </div>
      )}
      {replacing && <ConnectSteps status={status} base={base} onChange={(s) => { onChange(s); setReplacing(false); }} />}
      {act.error && <p className="error small">{act.error}</p>}
    </div>
  );
}

function ChannelCard({ status, base, canEdit, onChange }: { status: SlackView; base: string; canEdit: boolean; onChange: (s: SlackView) => void }) {
  const [channels, setChannels] = useState<SlackChannel[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const save = useAction();
  const load = () => {
    setListError(null);
    api<{ channels: SlackChannel[] }>(`${base}/channels`).then((r) => setChannels(r.channels), (e: Error) => setListError(e.message));
  };
  useEffect(() => {
    if (canEdit) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, canEdit]);
  const put = (body: { channelId?: string; mode?: SlackMode }) => save.run(async () => onChange(await api<SlackView>(base, { method: "PUT", body })));

  return (
    <SettingsCard title="Chats in Slack" description="Where chats go, and which ones.">
      <SettingRow label="Channel" description={<>A public channel is joined for you. For a private one, type <code>/invite @Jun</code> in it first, then pick it here.</>} htmlFor="slack-channel">
        {!canEdit ? (
          <span className="small">{status.channel ? `#${status.channel.name}` : "None yet"}</span>
        ) : channels ? (
          <div className="flex flex-wrap items-center gap-2">
            <SelectField id="slack-channel" value={status.channel?.id ?? ""} onValueChange={(id) => id && id !== status.channel?.id && put({ channelId: id })} disabled={save.busy} aria-label="Slack channel">
              {!status.channel && <SelectOption value="" disabled>Pick a channel</SelectOption>}
              {status.channel && !channels.some((c) => c.id === status.channel!.id) && <SelectOption value={status.channel.id}>#{status.channel.name}</SelectOption>}
              {channels.map((c) => (
                <SelectOption key={c.id} value={c.id}>{`${c.private ? "🔒 " : "#"}${c.name}`}</SelectOption>
              ))}
            </SelectField>
            <Button type="button" variant="ghost" size="sm" onClick={load}>Refresh</Button>
          </div>
        ) : listError ? (
          <span className="error small">{listError}</span>
        ) : (
          <Skeleton className="h-9 w-56" />
        )}
      </SettingRow>
      <SettingRow label="Open a thread for" description="Chats the AI answers on its own stay out of Slack unless you pick every chat." htmlFor="slack-mode">
        {canEdit ? (
          <SelectField id="slack-mode" value={status.mode} onValueChange={(mode) => mode !== status.mode && put({ mode: mode as SlackMode })} disabled={save.busy} aria-label="Which chats">
            <SelectOption value="handoff">Chats that need a person</SelectOption>
            <SelectOption value="all">Every new chat</SelectOption>
          </SelectField>
        ) : (
          <span className="small">{status.mode === "all" ? "Every new chat" : "Chats that need a person"}</span>
        )}
      </SettingRow>
      {save.error && <p className="error small">{save.error}</p>}
    </SettingsCard>
  );
}
