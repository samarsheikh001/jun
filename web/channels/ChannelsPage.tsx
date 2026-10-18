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
import { ChatIcon, MailIcon, PaletteIcon, SlackIcon } from "@/components/icons";
import type { EmailSettings } from "../../shared/email.ts";

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

/** /channels/email (C-02): where replies come from, where answers go, on/off, a test, and the Cloudflare setup. */
export function EmailChannelPage({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/email`;
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const save = useAction();
  const test = useAction();
  useEffect(() => {
    api<EmailStatus>(base).then(setStatus, () => {});
  }, [base]);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save.run(async () => {
      setStatus(await api<EmailStatus>(base, { method: "PUT", body: { from: form.get("from"), fromName: form.get("fromName"), replyDomain: form.get("replyDomain") } }));
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

  return (
    <div className="page-tabs">
      <div className="page-tabs-head"><h1>Email</h1></div>
      <div className="page-settings settings-sections">
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
            <SettingRow label="Replies come from" description={<>An address on a domain onboarded to Cloudflare Email Sending.</>} htmlFor="email-from">
              {status ? <Input id="email-from" name="from" type="email" placeholder="support@acme.com" defaultValue={s?.from} disabled={off} maxLength={320} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            <SettingRow label="Sender name" description={<>Empty: {workspaceName}.</>} htmlFor="email-name">
              {status ? <Input id="email-name" name="fromName" placeholder={workspaceName} defaultValue={s?.fromName} disabled={off} maxLength={80} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            <SettingRow
              label="Answers go to"
              description={<>A domain whose mail Cloudflare Email Routing sends to this desk. Each conversation gets its own address there{status?.replyExample ? <>, like <code>{status.replyExample}</code></> : null}. Use a subdomain if your main domain's mail is elsewhere (Google, Microsoft).</>}
              htmlFor="email-reply"
            >
              {status ? <Input id="email-reply" name="replyDomain" placeholder="reply.acme.com" defaultValue={s?.replyDomain} disabled={off} maxLength={253} /> : <Skeleton className="h-9 w-64" />}
            </SettingRow>
            {canEdit && (
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button disabled={off || save.busy}>Save</Button>
                <Button type="button" variant="outline" disabled={off || test.busy || !s?.from} onClick={sendTest}>Send me a test</Button>
                {tested && <span className="muted small">Sent to {tested}. Check that it arrived (and not in spam).</span>}
              </div>
            )}
            {save.error && <p className="error small">{save.error}</p>}
            {test.error && <p className="error small">{test.error}</p>}
          </form>
          <SettingRow label="Email replies to customers who've left" description="Needs the address and domain above, and the Cloudflare setup below.">
            {status ? <Switch checked={s?.enabled === true} disabled={off || save.busy} onCheckedChange={toggle} aria-label="Email replies" /> : <Skeleton className="h-5 w-9 rounded-full" />}
          </SettingRow>
          {status && s?.enabled && status.problems.length > 0 && <p className="error small">{status.problems.join(" ")}</p>}
        </SettingsCard>

        <SettingsCard
          title="Set it up in Cloudflare"
          description={<>Once per domain, in the Cloudflare account this desk runs on. Sending to any address needs the Workers Paid plan; receiving is free.</>}
        >
          <ol className="list-decimal space-y-3 pl-5 small">
            <li>
              <strong>Sending.</strong> Onboard <code>{domain}</code> to Email Sending (Cloudflare adds the SPF and DKIM records):
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2"><code>npx wrangler email sending enable {domain}</code></pre>
            </li>
            <li>
              <strong>Receiving.</strong> Turn on Email Routing for <code>{replyDomain}</code>, then add a catch-all rule that sends its mail to this desk's Worker
              (dashboard: Email Service → Email Routing → {replyDomain} → Routing rules → Catch-all → Send to a Worker):
              <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2"><code>npx wrangler email routing enable {replyDomain}</code></pre>
            </li>
            <li><strong>Check.</strong> Save the addresses above, send yourself a test, then turn email replies on.</li>
          </ol>
          {status && !status.canSend && <p className="error small mt-3">This desk was deployed without the <code>send_email</code> binding, so it can't send. Update Jun and deploy again.</p>}
          {!status && <p className="small mt-3"><SkelText width={180} /></p>}
        </SettingsCard>
      </div>
    </div>
  );
}
