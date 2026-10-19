import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { deskHref, navigate } from "../lib/router.ts";
import { OpenersPanel } from "../settings/OpenersPanel.tsx";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { useAction } from "../useAction.ts";
import type { OpenerRule } from "../../shared/openers.ts";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";
import { SkelText } from "@/components/ui/skeleton.tsx";

// The Chat widget page's Install tab (D-91): only putting the snippet on the site, with whether it's
// there yet. What the widget does once it's there (allowed websites, proactive help, identity, V-03)
// is on the Behaviour tab; the look on the Appearance page.

/** The desk's install state, from the onboarding route (T-11): the loader's first non-desk origin, or "I've added it". */
export interface InstallState {
  installed: boolean;
  /** The origin the loader was first seen on (null when only marked as added). */
  host: string | null;
  widgetKey: string | null;
}

/** "https://limoni.io" → "limoni.io". */
export const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const snippetFor = (widgetKey: string) => `<script src="${window.location.origin}/widget.js" data-key="${widgetKey}" defer></script>`;

/** "Send to a developer": the snippet with plain instructions, ready to paste into a message. */
const developerNote = (snippet: string) => `Could you add our support chat (Jun) to the website?

1. Paste this line into the <head> of every page (the shared layout or template), above the site's own scripts:

${snippet}

2. It's deferred, so it never blocks the page; the chat itself only loads when a visitor opens it.
3. To check it works: open the site and the chat appears; our desk shows the site as live within a few seconds.`;

/** Where a <script> in <head> goes on common platforms: general, version-independent steps. */
const PLATFORMS: { id: string; label: string; text: ReactNode }[] = [
  { id: "html", label: "Plain HTML", text: <>Paste it inside <code>&lt;head&gt;</code> on every page, or once in the shared layout or template, above your other <code>&lt;script&gt;</code> tags.</> },
  { id: "webflow", label: "Webflow", text: <>Site settings → Custom code → <strong>Head code</strong>: paste it, save, then publish the site. Custom code needs a paid site plan.</> },
  { id: "wordpress", label: "WordPress", text: <>Use a header-code plugin (such as WPCode) and paste it into the <strong>Header</strong> box. In a classic theme you can instead put it in <code>header.php</code>, just above <code>&lt;?php wp_head(); ?&gt;</code>.</> },
  { id: "shopify", label: "Shopify", text: <>Online Store → Themes → ⋯ → Edit code → <code>layout/theme.liquid</code>: paste it right after <code>&lt;head&gt;</code>, before <code>{"{{ content_for_header }}"}</code>, and save.</> },
  { id: "nextjs", label: "Next.js", text: <>App Router: put it inside <code>&lt;head&gt;</code> in <code>app/layout.tsx</code>. Pages Router: inside <code>&lt;Head&gt;</code> in <code>pages/_document.tsx</code>. The tag works as JSX unchanged.</> },
];

export function InstallTab({ workspaceId, canEdit, install, reload }: { workspaceId: string; canEdit: boolean; install: InstallState | null; reload: () => Promise<void> }) {
  const [copied, setCopied] = useState<"snippet" | "note" | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const widgetKey = install?.widgetKey ?? null;
  const snippet = widgetKey ? snippetFor(widgetKey) : "";
  const copy = async (what: "snippet" | "note") => {
    await navigator.clipboard?.writeText(what === "snippet" ? snippet : developerNote(snippet));
    setCopied(what);
  };
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const markInstalled = () =>
    run(async () => {
      await api(`/workspaces/${workspaceId}/onboarding/installed`, { body: {} });
      await reload();
    });
  const guide = PLATFORMS.find((p) => p.id === platform);

  return (
    <>
      <SettingsCard
        title="Install the chat widget"
        description={<>Paste this into your site's <code>&lt;head&gt;</code>, before your own scripts (so page actions your code registers find it ready). The loader is tiny; the chat itself loads only when a visitor opens it. Colours, wording and the rest of its look are on the{" "}
          <a href={deskHref("/playground")} onClick={(e) => { e.preventDefault(); navigate("/playground"); }}>Appearance</a> tab of the Playground.</>}
        action={<a data-slot="button" className={buttonVariants({ variant: "outline", size: "sm" })} href={widgetKey ? `/demo.html?key=${widgetKey}` : undefined} target="_blank" rel="noreferrer">Open demo page</a>}
      >
        <div className="invite">
          <div className="row">
            <code>{widgetKey ? snippet : <SkelText width="80%" />}</code>
            <Button size="sm" disabled={!widgetKey} onClick={() => void copy("snippet")}>{copied === "snippet" ? "Copied ✓" : "Copy"}</Button>
          </div>
        </div>
        <div className="install-share">
          <Button variant="outline" size="sm" disabled={!widgetKey} onClick={() => void copy("note")}>{copied === "note" ? "Copied ✓" : "Send to a developer"}</Button>
          <span className="muted small">Copies the snippet with a few lines on where it goes, for an email or chat.</span>
        </div>
        <div className="install-live small" role="status" aria-live="polite">
          {!install ? (
            <span><SkelText width={220} /></span>
          ) : install.installed ? (
            <span>
              <span className="install-dot ok" aria-hidden="true" />
              {install.host ? <>✓ Seen on <code>{hostOf(install.host)}</code></> : "Marked as added. The site shows here once a page with the snippet loads."}
            </span>
          ) : (
            <>
              <span className="muted"><span className="install-dot waiting" aria-hidden="true" />Waiting for your site… This updates by itself the first time a page with the snippet loads.</span>
              {canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={markInstalled}>I've added it</Button>}
            </>
          )}
        </div>
        {error && <p className="error small">{error}</p>}
        <p className="muted">
          Cookie banner? Add <code>data-consent="required"</code>: the widget then stores nothing and doesn't show the visitor on your live list until you call <code>JunDesk.consent(true)</code>.
        </p>
        <p className="muted">
          Your own "Ask our AI" button? Call <code>JunDesk.open()</code> to open the chat, or <code>JunDesk.highlight()</code> to make the island glow once so people see where it is (<code>{"JunDesk.highlight({ sound: true })"}</code> from a click adds a short sound).
        </p>
      </SettingsCard>

      <SettingsCard title="Where to paste it" description="On a site builder or framework, it goes wherever the platform lets you add code to every page's head.">
        <div className="install-platforms" role="group" aria-label="Platforms">
          {PLATFORMS.map((p) => (
            <Button key={p.id} variant={platform === p.id ? "secondary" : "outline"} size="sm" aria-expanded={platform === p.id} aria-controls="install-platform-guide" onClick={() => setPlatform(platform === p.id ? null : p.id)}>{p.label}</Button>
          ))}
        </div>
        {guide && <p id="install-platform-guide" className="install-platform-guide small">{guide.text}</p>}
      </SettingsCard>
    </>
  );
}

/** The Behaviour tab: where the widget may run and when it reaches out first. */
export function BehaviourPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const [proactive, setProactive] = useState(true);
  const [pageControl, setPageControl] = useState(true);
  const [pageConfirm, setPageConfirm] = useState("allow-always");
  const [openers, setOpeners] = useState<OpenerRule[]>([]);
  const [domains, setDomains] = useState("");
  const [savedDomains, setSavedDomains] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: { proactive?: boolean; pageControl?: boolean; pageControlConfirm?: string; allowedDomains?: string[]; openers?: OpenerRule[] } } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => {
      setLoaded(Boolean(r.inbox));
      setProactive(r.inbox?.settings.proactive !== false);
      setPageControl(r.inbox?.settings.pageControl !== false);
      setPageConfirm(r.inbox?.settings.pageControlConfirm ?? "allow-always");
      setOpeners(r.inbox?.settings.openers ?? []);
      const list = (r.inbox?.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  }, [workspaceId]);
  const saveDomains = () =>
    run(async () => {
      const r = await api<{ settings: { allowedDomains?: string[] } }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: domains } });
      const list = (r.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  // AI-32 (D-93): page control, on by default; every site with the snippet follows within a minute.
  const togglePageControl = (value: boolean) =>
    run(async () => {
      setPageControl(value);
      try {
        await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { pageControl: value } });
      } catch (e) {
        setPageControl(!value);
        throw e;
      }
    });
  const changePageConfirm = (value: string) =>
    run(async () => {
      const before = pageConfirm;
      setPageConfirm(value);
      try {
        await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { pageControlConfirm: value } });
      } catch (e) {
        setPageConfirm(before);
        throw e;
      }
    });
  const toggleProactive = async (value: boolean) => {
    setProactive(value);
    await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { proactive: value } });
  };
  if (!loaded) return null;

  return (
    <>
      <SettingsCard title="Allowed websites" description="Your widget key is public, so anyone could copy the snippet. List your sites and the widget won't open, track visitors or use AI anywhere else.">
        <SettingRow label="Websites" description={<>Use <code>*.acme.com</code> for subdomains. This desk ({window.location.host}) always works for testing.</>} wide>
          <div className="row">
            <Input value={domains} onChange={(e) => setDomains(e.target.value)} disabled={!canEdit} placeholder="Any website (e.g. acme.com, *.acme.com)" aria-label="Allowed websites" style={{ flex: 1 }} />
            {canEdit && <Button size="sm" disabled={busy || domains === savedDomains} onClick={saveDomains}>Save</Button>}
          </div>
        </SettingRow>
        {error && <p className="error">{error}</p>}
      </SettingsCard>

      <SettingsCard title="Proactive help" description="When the widget reaches out first: after something breaks, or after time on a page.">
        <SettingRow label="Offer help when something breaks" description={`On the page, e.g. "Looks like your payment didn't go through. Want a hand?"`}>
          <Switch checked={proactive} disabled={!canEdit} onCheckedChange={(value) => void toggleProactive(value)} aria-label="Offer help when something breaks on the page" />
        </SettingRow>
        {canEdit && <OpenersPanel workspaceId={workspaceId} proactive={proactive} initial={openers} />}
      </SettingsCard>

      <SettingsCard
        title="Let the AI use your website"
        description={<>The AI can read the page the customer is on and click, type and choose for them, like "set my time zone to Tokyo". You choose below whether it asks first. It never sees password or card fields or anything marked <code>data-jun-private</code>.</>}
      >
        <SettingRow label="Read and use the page" description={<>On every site with your snippet. To leave one site out, add <code>data-page-control="off"</code> to its snippet.</>}>
          <Switch checked={pageControl} disabled={!canEdit || busy} onCheckedChange={(value) => void togglePageControl(value)} aria-label="Let the AI read and use your website" />
        </SettingRow>
        <SettingRow
          label="Before it clicks, types or chooses"
          description={
            pageConfirm === "never"
              ? "It acts straight away. Each step still shows in the chat and on the page."
              : pageConfirm === "every-time"
                ? "The customer confirms each step."
                : "The customer confirms each step, or taps Always allow to stop being asked on your site."
          }
        >
          <SelectField value={pageConfirm} disabled={!canEdit || busy || !pageControl} onValueChange={(value) => void changePageConfirm(String(value))} aria-label="Before the AI clicks, types or chooses">
            <SelectOption value="allow-always">Ask, with Always allow</SelectOption>
            <SelectOption value="every-time">Ask every time</SelectOption>
            <SelectOption value="never">Don't ask</SelectOption>
          </SelectField>
        </SettingRow>
      </SettingsCard>
    </>
  );
}

/** V-03: the secret the customer's backend signs identity tokens with. */
export function IdentityPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/identity`;
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ secret: string | null }>(base).then((r) => setSecret(r.secret), () => setSecret(null));
  }, [base]);
  if (secret === undefined) return null;
  const example = `// On your server, for the signed-in user (any JWT library; HS256):
const userToken = jwt.sign(
  { sub: user.id, email: user.email, name: user.name, attributes: { plan: user.plan },
    // Optional (B2B): their company, so agents and the AI see the account and its other people.
    company: { id: user.org.id, name: user.org.name, attributes: { plan: user.org.plan, seats: user.org.seats } },
    // Optional: the user's own key for your API, for actions that act as them ({user.secrets.API_TOKEN}).
    secrets: { API_TOKEN: user.apiToken } },
  process.env.JUN_IDENTITY_SECRET,
  { algorithm: "HS256", expiresIn: "1h" },
);
// In the page: data-user-token="<userToken>" on the script tag, or
JunDesk.identify(userToken);   // and JunDesk.logout() when they sign out`;
  return (
    <SettingsCard
      title="Identify signed-in customers"
      description={<>Your backend signs a short-lived token saying who the user is. Agents then see a verified name, email and attributes, the AI can greet them and look up <em>their</em> account
        ({"{user.id}"} in tools), and their chats follow them across devices. Without a valid token, visitors stay anonymous.</>}
      action={!secret && <Button size="sm" disabled={busy} onClick={() => run(async () => { setSecret((await api<{ secret: string }>(base, { body: {} })).secret); setShown(true); })}>Create identity secret</Button>}
    >
      {secret && (
        <>
          <div className="invite">
            <div className="row">
              <code className="small">{shown ? secret : `${secret.slice(0, 8)}${"•".repeat(24)}`}</code>
              <Button variant="outline" size="sm" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</Button>
              <Button variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
            </div>
          </div>
          <pre className="code small">{example}</pre>
          <div className="row">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (confirm("Rotate the secret? Tokens signed with the old one stop working right away.")) run(async () => setSecret((await api<{ secret: string }>(base, { body: {} })).secret)); }}>Rotate secret</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (confirm("Turn off identity verification? Everyone becomes anonymous.")) run(async () => { await api(base, { method: "DELETE" }); setSecret(null); }); }}>Turn off</Button>
          </div>
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </SettingsCard>
  );
}
