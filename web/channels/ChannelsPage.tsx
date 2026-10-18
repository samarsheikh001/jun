import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import type { InstallState } from "../appearance/InstallPanels.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { ChatIcon, CheckIcon, ExternalLinkIcon, MailIcon, PaletteIcon, SlackIcon, XIcon } from "@/components/icons";
import type { EmailSettings } from "../../shared/email.ts";
import { CLOUDFLARE_TOKEN_PERMISSIONS, type SetupResult, type SetupStep } from "../../shared/email-setup.ts";

// The Channels group (sidebar): the ways customers reach the desk. The chat widget's pages keep their
// /appearance* URLs; email (C-02) is /channels/email; /channels lists them all.

export type ChannelSection = "overview" | "widget" | "appearance" | "email";

export const CHANNEL_SECTIONS: { id: Exclude<ChannelSection, "overview">; label: string; path: string }[] = [
  { id: "widget", label: "Chat widget", path: "/appearance/install" },
  { id: "appearance", label: "Appearance", path: "/appearance" },
  { id: "email", label: "Email", path: "/channels/email" },
];

/** Which Channels page a path shows. */
export function channelSection(path: string): ChannelSection {
  if (path.startsWith("/appearance/install") || path.startsWith("/appearance/behaviour")) return "widget";
  if (path.startsWith("/appearance")) return "appearance";
  if (path.startsWith("/channels/email")) return "email";
  return "overview";
}

/** GET /workspaces/:id/email. */
export interface EmailStatus {
  settings: EmailSettings;
  canSend: boolean;
  on: boolean;
  problems: string[];
  replyExample: string | null;
}

/** /channels: one card per channel, saying whether it's live, each opening its own page. */
export function ChannelsOverview({ workspaceId, install }: { workspaceId: string; install: InstallState | null }) {
  const [email, setEmail] = useState<EmailStatus | null>(null);
  useEffect(() => {
    api<EmailStatus>(`/workspaces/${workspaceId}/email`).then(setEmail, () => {});
  }, [workspaceId]);
  return (
    <div className="page-tabs">
      <div className="page-tabs-head"><h1>Channels</h1></div>
      <div className="p-6 max-md:p-4">
      <p className="muted mb-6 max-w-2xl">Where your customers reach you. Every channel lands in the same inbox, and the AI and your team answer them all.</p>
      <div className="grid gap-4 max-w-4xl sm:grid-cols-2">
        <ChannelCard
          Icon={ChatIcon}
          title="Chat widget"
          text="The chat on your website: the AI answers first, your team takes over."
          status={install === null ? null : install.installed ? { label: install.host ? `Live on ${install.host}` : "Installed", on: true } : { label: "Not installed", on: false }}
          href="/appearance/install"
          links={[{ label: "Appearance", href: "/appearance", Icon: PaletteIcon }]}
        />
        <ChannelCard
          Icon={MailIcon}
          title="Email"
          text="Replies reach customers who left the chat by email, and their answers come back to the same conversation."
          status={email === null ? null : email.on ? { label: "On", on: true } : { label: email.settings.from ? "Off" : "Not set up", on: false }}
          href="/channels/email"
        />
        <ChannelCard Icon={SlackIcon} title="Slack" text="Answer customers in shared Slack channels, and reply to handed-off chats from Slack." status={{ label: "Coming soon", on: false }} />
      </div>
      </div>
    </div>
  );
}

function ChannelCard({ Icon, title, text, status, href, links = [] }: {
  Icon: (props: { className?: string }) => ReactNode;
  title: string;
  text: string;
  /** Null while it loads. */
  status: { label: string; on: boolean } | null;
  href?: string;
  links?: { label: string; href: string; Icon: (props: { className?: string }) => ReactNode }[];
}) {
  const body = (
    <>
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-muted text-foreground"><Icon className="size-5" /></span>
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="flex-1" />
        {status === null ? <Skeleton className="h-5 w-20 rounded-full" /> : <Badge variant={status.on ? "default" : "secondary"}>{status.label}</Badge>}
      </div>
      <p className="muted small mt-3">{text}</p>
    </>
  );
  return (
    <section className={`rounded-xl border bg-card p-5 ${href ? "" : "opacity-70"}`}>
      {href ? (
        <a href={deskHref(href)} className="block no-underline text-inherit" onClick={(e) => { e.preventDefault(); navigate(href); }}>{body}</a>
      ) : body}
      {links.length > 0 && (
        <div className="mt-3 flex gap-2">
          {links.map((l) => (
            <a key={l.href} className={buttonVariants({ variant: "ghost", size: "sm" })} href={deskHref(l.href)} onClick={(e) => { e.preventDefault(); navigate(l.href); }}>
              <l.Icon /> {l.label}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

/** GET /workspaces/:id/email/cloudflare (owners and admins, D-111). */
interface CloudflareStatus {
  connected: boolean;
  last4: string | null;
  domains: string[];
  workerName: string | null;
  tokenUrl: string;
  error: string | null;
}

/**
 * /channels/email (C-02): where replies come from, where answers go, on/off and a test. D-111: an
 * admin connects Cloudflare once (a pasted API token) and one button does the Cloudflare setup; the
 * wrangler commands stay under "Do it by hand".
 */
export function EmailChannelPage({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/email`;
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [cloudflare, setCloudflare] = useState<CloudflareStatus | null>(null);
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const save = useAction();
  const test = useAction();
  useEffect(() => {
    api<EmailStatus>(base).then(setStatus, () => {});
    if (canEdit) api<CloudflareStatus>(`${base}/cloudflare`).then(setCloudflare, () => {});
  }, [base, canEdit]);

  const fields = (form: HTMLFormElement) => {
    const data = new FormData(form);
    return { from: data.get("from"), fromName: data.get("fromName"), replyDomain: data.get("replyDomain"), workerName: data.get("workerName") ?? undefined };
  };
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body = fields(e.currentTarget);
    const setUp = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "setup";
    save.run(async () => {
      setSteps(null);
      if (setUp) {
        const r = await api<SetupResult & { status: EmailStatus }>(`${base}/cloudflare/setup`, { body });
        setSteps(r.steps);
        setStatus(r.status);
      } else {
        setStatus(await api<EmailStatus>(base, { method: "PUT", body: { from: body.from, fromName: body.fromName, replyDomain: body.replyDomain } }));
      }
    });
  };
  const toggle = (enabled: boolean) => save.run(async () => setStatus(await api<EmailStatus>(base, { method: "PUT", body: { enabled } })));
  const sendTest = () => test.run(async () => {
    setTested(null);
    setTested((await api<{ to: string }>(`${base}/test`, { body: {} })).to);
  });

  const s = status?.settings;
  const domain = s?.from ? s.from.slice(s.from.indexOf("@") + 1) : "acme.com";
  const replyDomain = s?.replyDomain || `reply.${domain}`;
  const off = !canEdit || !status;
  const connected = Boolean(cloudflare?.connected && !cloudflare.error);

  return (
    <div className="page-tabs">
      <div className="page-tabs-head"><h1>Email</h1></div>
      <div className="page-settings settings-sections">
        {canEdit && <CloudflareCard base={base} status={cloudflare} onChange={setCloudflare} />}

        <SettingsCard
          title="Replies by email"
          description={<>
            When a customer has left the chat, the desk emails them the replies they haven't seen (the team's and the AI's) a couple of minutes later, a few at once.
            Their answer to that email comes back into the same conversation, so nobody leaves the inbox. Customers give their email in the chat while they wait, or your site
            sends it with their identity. Off until it's set up: without it, the widget only collects the address for your team.
            {!canEdit && " An owner or admin can change this."}
          </>}
          action={status ? <Badge variant={status.on ? "default" : "secondary"}>{status.on ? "On" : s?.from ? "Off" : "Not set up"}</Badge> : <Skeleton className="h-5 w-16 rounded-full" />}
        >
          <form onSubmit={submit} key={status ? "loaded" : "loading"}>
            <SettingRow label="Replies come from" description={<>An address on a domain in your Cloudflare account, e.g. support@{domain}.</>} htmlFor="email-from">
              {status ? <Input id="email-from" name="from" type="email" placeholder="support@acme.com" defaultValue={s?.from} disabled={off} maxLength={320} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            <SettingRow label="Sender name" description={<>Empty: {workspaceName}.</>} htmlFor="email-name">
              {status ? <Input id="email-name" name="fromName" placeholder={workspaceName} defaultValue={s?.fromName} disabled={off} maxLength={80} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            <SettingRow
              label="Answers go to"
              description={<>A domain (or subdomain) in the same account whose mail comes to this desk. Each conversation gets its own address there{status?.replyExample ? <>, like <code>{status.replyExample}</code></> : null}. Use a subdomain such as <code>reply.{domain}</code> if your mail is elsewhere (Google, Microsoft): nothing about it changes.</>}
              htmlFor="email-reply"
            >
              {status ? <Input id="email-reply" name="replyDomain" placeholder={`reply.${domain}`} defaultValue={s?.replyDomain} disabled={off} maxLength={253} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            {connected && !cloudflare?.workerName && (
              <SettingRow label="This desk's Worker" description="Couldn't tell from this address. Its name in Cloudflare → Workers & Pages (jun-desk unless you renamed it)." htmlFor="email-worker">
                <Input id="email-worker" name="workerName" placeholder="jun-desk" defaultValue="jun-desk" maxLength={63} />
              </SettingRow>
            )}
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                {connected && <Button name="action" value="setup" disabled={off || save.busy}>{save.busy ? "Setting up…" : "Set up and turn on"}</Button>}
                <Button variant={connected ? "outline" : "default"} name="action" value="save" disabled={off || save.busy}>Save</Button>
                <Button type="button" variant="outline" disabled={off || test.busy || !s?.from} onClick={sendTest}>Send me a test</Button>
                {tested && <span className="muted small">Sent to {tested}. Check that it arrived (and not in spam).</span>}
              </div>
            )}
            {save.error && <p className="error small">{save.error}</p>}
            {test.error && <p className="error small">{test.error}</p>}
          </form>
          {steps && <SetupSteps steps={steps} />}
          <SettingRow label="Email replies to customers who've left" description={connected ? "Set up and turn on does this for you." : "Needs the addresses above, set up in Cloudflare."}>
            {status ? <Switch checked={s?.enabled === true} disabled={off || save.busy} onCheckedChange={toggle} aria-label="Email replies" /> : <Skeleton className="h-5 w-9 rounded-full" />}
          </SettingRow>
          {status && s?.enabled && status.problems.length > 0 && <p className="error small">{status.problems.join(" ")}</p>}
        </SettingsCard>

        <SettingsCard title="Do it by hand" description="Instead of connecting Cloudflare: once per domain, in the Cloudflare account this desk runs on.">
          <details>
            <summary className="small cursor-pointer">Show the steps</summary>
            <ol className="mt-3 list-decimal space-y-3 pl-5 small">
              <li>
                <strong>Sending.</strong> Onboard <code>{domain}</code> to Email Sending (Cloudflare adds the SPF and DKIM records):
                <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2"><code>npx wrangler email sending enable {domain}</code></pre>
              </li>
              <li>
                <strong>Receiving.</strong> Turn on Email Routing for <code>{replyDomain}</code>, turn on subaddressing (Email Routing → Settings), and add a rule sending <code>reply@{replyDomain}</code> to this desk's Worker:
                <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2"><code>npx wrangler email routing enable {replyDomain}</code></pre>
              </li>
              <li><strong>Check.</strong> Save the addresses above, send yourself a test, then turn email replies on.</li>
            </ol>
          </details>
          {status && !status.canSend && <p className="error small mt-3">This desk was deployed without the <code>send_email</code> binding, so it can't send. Update Jun and deploy again.</p>}
          <p className="muted small mt-3">Sending to any address needs the Workers Paid plan; receiving is free.</p>
        </SettingsCard>
      </div>
    </div>
  );
}

/** D-111: connect Cloudflare with an API token made from a link that ticks the permissions. */
function CloudflareCard({ base, status, onChange }: { base: string; status: CloudflareStatus | null; onChange: (s: CloudflareStatus) => void }) {
  const connect = useAction();
  const [token, setToken] = useState("");
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    connect.run(async () => {
      onChange(await api<CloudflareStatus>(`${base}/cloudflare`, { method: "PUT", body: { token } }));
      setToken("");
    });
  };
  const disconnect = () => connect.run(async () => onChange(await api<CloudflareStatus>(`${base}/cloudflare`, { method: "DELETE" })));
  return (
    <SettingsCard
      title="Connect Cloudflare"
      description="So the desk can set email up for you: it turns on sending for your domain, receiving for the reply domain, and the rule that brings answers here. Once, with an API token."
      action={status ? <Badge variant={status.connected && !status.error ? "default" : "secondary"}>{status.connected ? (status.error ? "Needs attention" : "Connected") : "Not connected"}</Badge> : <Skeleton className="h-5 w-24 rounded-full" />}
    >
      {!status ? (
        <p className="small"><SkelText width={260} /></p>
      ) : status.connected ? (
        <div className="space-y-2">
          <p className="small">
            Token <code>•••• {status.last4}</code>
            {status.domains.length > 0 && <> · sees {status.domains.slice(0, 6).join(", ")}{status.domains.length > 6 ? ` and ${status.domains.length - 6} more` : ""}</>}
            {status.workerName && <> · this desk is the Worker <code>{status.workerName}</code></>}
          </p>
          {status.error && <p className="error small">{status.error}</p>}
          <Button type="button" variant="outline" size="sm" disabled={connect.busy} onClick={disconnect}>Disconnect</Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <ol className="list-decimal space-y-2 pl-5 small">
            <li>
              <a href={status.tokenUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>Create a token in Cloudflare <ExternalLinkIcon /></a>
              <p className="muted mt-1">It opens with these ticked: {CLOUDFLARE_TOKEN_PERMISSIONS.map((p) => p.label).join(", ")}. Leave "All zones", then Continue → Create.</p>
            </li>
            <li>
              Paste it here:
              <div className="mt-1 flex flex-wrap gap-2">
                <Input type="password" autoComplete="off" spellCheck={false} placeholder="Cloudflare API token" value={token} onChange={(e) => setToken(e.target.value)} className="max-w-sm" aria-label="Cloudflare API token" />
                <Button disabled={connect.busy || token.trim().length < 20}>{connect.busy ? "Checking…" : "Connect"}</Button>
              </div>
            </li>
          </ol>
          <p className="muted small">The token stays on this desk (never shown again, not in the database) and is used only when you press Set up.</p>
        </form>
      )}
      {connect.error && <p className="error small">{connect.error}</p>}
    </SettingsCard>
  );
}

/** What the setup did, step by step: ✓ with what changed, ✗ with what to do. */
function SetupSteps({ steps }: { steps: SetupStep[] }) {
  return (
    <ul className="my-3 space-y-2 rounded-lg border p-3 small" aria-label="Setup steps">
      {steps.map((step) => (
        <li key={step.id} className="flex gap-2">
          <span className={step.ok ? "text-primary" : "text-destructive"} aria-label={step.ok ? "Done" : "Failed"}>{step.ok ? <CheckIcon /> : <XIcon />}</span>
          <span><strong>{step.label}.</strong> {step.detail}</span>
        </li>
      ))}
    </ul>
  );
}
