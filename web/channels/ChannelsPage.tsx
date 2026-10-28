import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { CheckIcon, CopyIcon, ExternalLinkIcon, MailIcon, SlackIcon, XIcon } from "@/components/icons";
import { formatTime } from "../lib/thread.ts";
import type { EmailSettings } from "../../shared/email.ts";
import type { SlackView } from "../../shared/slack.ts";
import { SlackChannelPage, slackLabel } from "./SlackChannel.tsx";

export { SlackChannelPage };
import { CLOUDFLARE_TOKEN_PERMISSIONS, type SetupResult, type SetupStep } from "../../shared/email-setup.ts";

// The Channels group (sidebar): ways customers reach the desk besides the chat widget, which keeps its
// own Chat widget and Appearance entries (D-112). Email (C-02) is /channels/email; /channels lists them.

export type ChannelSection = "overview" | "email" | "slack";

export const CHANNEL_SECTIONS: { id: Exclude<ChannelSection, "overview">; label: string; path: string }[] = [
  { id: "email", label: "Email", path: "/channels/email" },
  { id: "slack", label: "Slack", path: "/channels/slack" },
];

/** Which Channels page a path shows. */
export function channelSection(path: string): ChannelSection {
  return path.startsWith("/channels/email") ? "email" : path.startsWith("/channels/slack") ? "slack" : "overview";
}

/** GET /workspaces/:id/email. */
export interface EmailStatus {
  settings: EmailSettings;
  canSend: boolean;
  on: boolean;
  problems: string[];
  replyExample: string | null;
  /** C-13: forwarding a support inbox (on only while email is on). */
  forwarding: { enabled: boolean; address: string | null; lastAt: number | null; confirmation: { code: string; link: string | null; at: number } | null };
}

/** /channels: one card per channel (the chat widget has its own entries), saying whether it's live, each opening its own page. */
export function ChannelsOverview({ workspaceId }: { workspaceId: string }) {
  const [email, setEmail] = useState<EmailStatus | null>(null);
  const [slack, setSlack] = useState<SlackView | null>(null);
  useEffect(() => {
    api<EmailStatus>(`/workspaces/${workspaceId}/email`).then(setEmail, () => {});
    api<SlackView>(`/workspaces/${workspaceId}/slack`).then(setSlack, () => {});
  }, [workspaceId]);
  return (
    <div className="page-tabs">
      <div className="page-tabs-head"><h1>Channels</h1></div>
      <div className="p-6 max-md:p-4">
      <p className="muted mb-6 max-w-2xl">More ways your customers reach you, besides the chat widget on your site. Everything lands in the same inbox, and the AI and your team answer it all.</p>
      <div className="grid gap-4 max-w-4xl sm:grid-cols-2">
        <ChannelCard
          Icon={MailIcon}
          title="Email"
          text="Forward your support inbox here, and email customers who left the chat. Answers by email come back to the same conversation."
          status={email === null ? null : email.on ? { label: "On", on: true } : { label: email.settings.from ? "Off" : "Not set up", on: false }}
          href="/channels/email"
        />
        <ChannelCard
          Icon={SlackIcon}
          title="Slack"
          text="Chats that need a person open a thread in your team's Slack channel. Reply in the thread to answer the customer."
          status={slack === null ? null : slackLabel(slack)}
          href="/channels/slack"
        />
      </div>
      </div>
    </div>
  );
}

function ChannelCard({ Icon, title, text, status, href }: {
  Icon: (props: { className?: string }) => ReactNode;
  title: string;
  text: string;
  /** Null while it loads. */
  status: { label: string; on: boolean } | null;
  href?: string;
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
  const [tested, setTested] = useState<{ to: string; local: boolean } | null>(null);
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
    setTested(await api<{ to: string; local: boolean }>(`${base}/test`, { body: {} }));
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
                {tested && <span className="muted small">{tested.local ? <>This is a local dev server: Cloudflare writes the email to a file here instead of sending it. Send the test from your deployed desk.</> : <>Sent to {tested.to}. Check that it arrived (and not in spam).</>}</span>}
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

        {status && <ForwardingCard base={base} status={status} canEdit={canEdit} onChange={setStatus} />}

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

/** Which mail service the forwarding steps are for. */
const FORWARD_STEPS: { id: string; label: string; steps: ReactNode[] }[] = [
  {
    id: "gmail",
    label: "Gmail",
    steps: [
      <>In Gmail, open Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding address, and paste the address above.</>,
      <>Gmail emails a confirmation code to that address. It shows up here, on this page, within a minute: type it into Gmail (or open its link).</>,
      <>Choose "Forward a copy of incoming mail to" the address, and save.</>,
    ],
  },
  {
    id: "workspace",
    label: "Google Workspace",
    steps: [
      <>An admin opens admin.google.com → Apps → Google Workspace → Gmail → Routing, and adds a rule for the support mailbox.</>,
      <>Under "Also deliver to", add the address above. No confirmation code is needed this way.</>,
    ],
  },
  {
    id: "microsoft",
    label: "Microsoft 365",
    steps: [
      <>Microsoft 365 blocks forwarding to outside addresses until an admin allows it (the sender gets error 5.7.520). In Microsoft Defender, open Email &amp; collaboration → Policies → Anti-spam → the outbound policy, and set Automatic forwarding to On, for everyone or in a policy for just the support mailbox.</>,
      <>Then in Outlook, for the support mailbox: Settings → Mail → Forwarding, turn it on and paste the address above. Keep a copy if people still read that mailbox.</>,
    ],
  },
  {
    id: "other",
    label: "Other",
    steps: [<>Add a rule in your mail service that forwards (or redirects) every email for the support address to the address above. Services call it forwarding, an alias or a routing rule.</>],
  },
];

/**
 * C-13: forward a support inbox. The address to forward to, how to set it up per mail service, whether
 * mail is arriving, Gmail's confirmation code when it comes, and the senders marked as spam.
 */
function ForwardingCard({ base, status, canEdit, onChange }: { base: string; status: EmailStatus; canEdit: boolean; onChange: (s: EmailStatus) => void }) {
  const save = useAction();
  const [provider, setProvider] = useState("gmail");
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState<{ pattern: string; createdAt: number }[] | null>(null);
  const f = status.forwarding;
  useEffect(() => {
    if (f.enabled) api<{ blocked: { pattern: string; createdAt: number }[] }>(`${base}/blocked`).then((r) => setBlocked(r.blocked), () => {});
  }, [base, f.enabled]);
  // Waiting on the first email (or Gmail's code): look again every 10 s.
  useEffect(() => {
    if (!f.enabled || f.lastAt) return;
    const timer = setInterval(() => api<EmailStatus>(base).then(onChange, () => {}), 10_000);
    return () => clearInterval(timer);
  }, [base, f.enabled, f.lastAt, onChange]);
  const put = (body: Record<string, unknown>) => save.run(async () => onChange(await api<EmailStatus>(`${base}/forwarding`, { method: "PUT", body })));
  const copy = async () => {
    if (!f.address) return;
    await navigator.clipboard.writeText(f.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const unblock = (pattern: string) => save.run(async () => {
    await api(`${base}/blocked?pattern=${encodeURIComponent(pattern)}`, { method: "DELETE" });
    setBlocked((list) => list?.filter((b) => b.pattern !== pattern) ?? null);
  });
  const steps = FORWARD_STEPS.find((p) => p.id === provider)!;
  return (
    <SettingsCard
      title="Forward your support inbox"
      description={<>
        Mail to your support address (like support@) becomes a conversation here. The AI and your team answer it, and the answer goes back by email from the address above,
        so customers keep writing to the address they know.{!status.on && " Turn on email replies first."}
      </>}
      action={<Badge variant={f.enabled ? "default" : "secondary"}>{f.enabled ? (f.lastAt ? "Receiving" : "Waiting for mail") : "Off"}</Badge>}
    >
      <SettingRow label="Forward support mail here" description="Off: the address stops taking mail.">
        <Switch checked={f.enabled} disabled={!canEdit || !status.on || save.busy} onCheckedChange={(enabled) => put({ enabled })} aria-label="Forward a support inbox" />
      </SettingRow>
      {f.enabled && f.address && (
        <div className="space-y-4 pt-2">
          <div>
            <p className="small mb-1">Forward to this address:</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md bg-muted px-2 py-1.5 small break-all">{f.address}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy()}><CopyIcon />{copied ? "Copied" : "Copy"}</Button>
            </div>
            <p className="muted small mt-1">
              {f.lastAt ? <>Last email {formatTime(f.lastAt)}.</> : <>Nothing has arrived yet; this page checks every few seconds.</>} Keep the address private: anyone who has it can open tickets.
            </p>
          </div>
          {f.confirmation && (
            <div className="rounded-lg border p-3 small" role="status">
              <p><strong>Gmail's confirmation code: <code>{f.confirmation.code}</code></strong> (arrived {formatTime(f.confirmation.at)})</p>
              <p className="muted mt-1">Type it into Gmail's forwarding settings{f.confirmation.link ? <>, or <a href={f.confirmation.link} target="_blank" rel="noreferrer">open Gmail's link</a></> : null}, then choose to forward a copy of incoming mail.</p>
              {canEdit && <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => put({ clearConfirmation: true })}>Done</Button>}
            </div>
          )}
          <div>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Your mail service">
              {FORWARD_STEPS.map((p) => (
                <Button key={p.id} type="button" size="sm" variant={p.id === provider ? "default" : "ghost"} role="tab" aria-selected={p.id === provider} onClick={() => setProvider(p.id)}>{p.label}</Button>
              ))}
            </div>
            <ol className="mt-2 list-decimal space-y-2 pl-5 small">
              {steps.steps.map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          </div>
          {blocked && blocked.length > 0 && (
            <div>
              <p className="small mb-1">Marked as spam (their mail is dropped):</p>
              <ul className="space-y-1 small">
                {blocked.map((b) => (
                  <li key={b.pattern} className="flex items-center gap-2">
                    <code>{b.pattern}</code>
                    {canEdit && <Button type="button" variant="ghost" size="sm" disabled={save.busy} onClick={() => unblock(b.pattern)}>Unblock</Button>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canEdit && (
            <Button type="button" variant="outline" size="sm" disabled={save.busy} onClick={() => { if (confirm("Make a new address? The old one stops working, so update your forwarding rule too.")) put({ rotate: true }); }}>
              New address
            </Button>
          )}
        </div>
      )}
      {save.error && <p className="error small">{save.error}</p>}
    </SettingsCard>
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
