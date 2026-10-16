import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { APPEARANCE_DEFAULTS, BUTTON_TEXT, RADIUS_MAX, SUGGESTION_LIMIT, SUGGESTIONS_MAX, TEXT_LIMITS, logoFor, modeOf, textOn, widgetLook, type ButtonStyle, type IslandSurface, type WidgetMode, type WidgetTheme } from "../../shared/appearance.ts";
import { api, ApiError } from "../api.ts";
import { useAction } from "../useAction.ts";
import { PageTabs } from "../components/PageTabs.tsx";
import { BehaviourPanel, hostOf, IdentityPanel, InstallTab, type InstallState } from "./InstallPanels.tsx";
import { deskHref, navigate } from "../lib/router.ts";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { previewChime } from "../lib/sound.ts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { DeskCode } from "./DeskCode.tsx";
import { UploadIcon } from "../components/icons.tsx";

// Two sidebar pages share /appearance* (/widget itself is the chat iframe the Worker serves):
// Chat widget (D-91): Install (/appearance/install) and Behaviour (/appearance/behaviour), with
// whether the widget is on a site yet in the header; and Appearance (/appearance): the look.
export type WidgetTab = "install" | "behaviour";

/** The Appearance page: the widget's look, as a form or as desk.yaml (Form / Code). */
export function AppearancePage({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  // D-84: Form / Code; Code is desk.yaml. Its own switch, always opening on Form (the look is
  // picked by eye; the Agent pages' remembered Code view doesn't carry over).
  const [code, setCode] = useState(false);
  return (
    <PageTabs
      title="Appearance"
      value="look"
      className="widget-page"
      tabsHidden
      actions={
        <Tabs value={code ? "code" : "form"} onValueChange={(v) => setCode(v === "code")}>
          <TabsList className="kb-tabs agent-view-switch" aria-label="View">
            <TabsTrigger value="form">Form</TabsTrigger>
            <TabsTrigger value="code" title="The same settings as a file (desk.yaml), as in git">Code</TabsTrigger>
          </TabsList>
        </Tabs>
      }
      tabs={[
        {
          value: "look",
          label: "Look",
          path: "/appearance",
          content: code ? <DeskCode workspaceId={workspaceId} canEdit={canEdit} /> : <LookTab workspaceId={workspaceId} workspaceName={workspaceName} canEdit={canEdit} />,
        },
      ]}
    />
  );
}

export function WidgetPage({ workspaceId, canEdit, tab, install, reloadInstall }: {
  workspaceId: string;
  canEdit: boolean;
  tab: WidgetTab;
  /** Null until the onboarding state has loaded. */
  install: InstallState | null;
  reloadInstall: () => Promise<void>;
}) {
  // While the Install tab is open and the widget hasn't been seen yet, look again every 5 s (only
  // while the tab is visible), so "Waiting for your site…" turns into "Seen on …" by itself.
  const waiting = tab === "install" && install !== null && !install.installed;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reloadInstall().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [waiting, reloadInstall]);
  return (
    <PageTabs
      title="Chat widget"
      value={tab}
      className="widget-page"
      aside={<InstallChip install={install} />}
      tabs={[
        {
          value: "install",
          label: "Install",
          path: "/appearance/install",
          content: (
            <div className="page-settings settings-sections">
              <InstallTab workspaceId={workspaceId} canEdit={canEdit} install={install} reload={reloadInstall} />
            </div>
          ),
        },
        {
          value: "behaviour",
          label: "Behaviour",
          path: "/appearance/behaviour",
          content: (
            <div className="page-settings settings-sections">
              <BehaviourPanel workspaceId={workspaceId} canEdit={canEdit} />
              {canEdit && <IdentityPanel workspaceId={workspaceId} />}
            </div>
          ),
        },
      ]}
    />
  );
}

/** D-91: is the widget on a site yet? In the header after the tabs, so its width never moves them. */
function InstallChip({ install }: { install: InstallState | null }) {
  if (!install) return <span className="install-chip" aria-hidden="true"><SkelText width={110} /></span>;
  if (install.installed) {
    return (
      <span className="install-chip live" title={install.host ? `The widget has loaded on ${install.host}` : "Marked as added to your site"}>
        <span className="install-dot ok" aria-hidden="true" />
        {install.host ? <>Live on {hostOf(install.host)}</> : "Added to your site"}
      </span>
    );
  }
  return (
    <span className="install-chip pending">
      <span className="install-dot warn" aria-hidden="true" />
      Not on your site yet
      <a href={deskHref("/appearance/install")} onClick={(e) => { e.preventDefault(); navigate("/appearance/install", { replace: true }); }}>Install</a>
    </span>
  );
}

// W-04 Look: settings on the left, and on the right the real widget (/widget in an
// iframe, preview mode) showing the unsaved draft, so the preview can't drift from what
// visitors get. Only the chat window's round button is drawn here: it lives in the loader on
// customers' pages (public/widget.js), and this copies its styles. The frame draws the greeting
// card and the island itself.

/** The appearance fields of the widget inbox's settings (what this page edits). */
interface Draft {
  displayName?: string;
  greeting?: string;
  replyTime?: string;
  placeholder?: string;
  suggestions?: string[];
  color?: string;
  position?: "left" | "right";
  theme?: WidgetTheme;
  radius?: number;
  /** D-89: island or chat window, and the window's greeting card. */
  mode?: WidgetMode;
  greetingCard?: boolean;
  buttonStyle?: ButtonStyle;
  neon?: boolean;
  islandSurface?: IslandSurface;
  sound?: boolean;
  csat?: boolean;
  logoKey?: string;
  logoDarkKey?: string;
}

const FIELDS = ["displayName", "greeting", "replyTime", "placeholder", "suggestions", "color", "position", "theme", "radius", "mode", "greetingCard", "buttonStyle", "neon", "islandSurface", "sound", "csat"] as const;
const pick = (s: Draft): Draft => Object.fromEntries(FIELDS.filter((f) => s[f] !== undefined).map((f) => [f, s[f]])) as Draft;
/** Stored settings with the mode and greeting card spelled out (a desk saved before D-89 has `launcher`). */
const withMode = (s: Draft): Draft => ({ ...s, ...modeOf(s as Record<string, unknown>) });
const same = (a: Draft, b: Draft) => FIELDS.every((f) => JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null));

function LookTab({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const [widgetKey, setWidgetKey] = useState<string | null>(null);
  const [saved, setSaved] = useState<Draft>({});
  const [draft, setDraft] = useState<Draft>({});
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: Draft } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => {
      if (!r.inbox) return;
      setWidgetKey(r.inbox.widgetKey);
      setSaved(withMode(r.inbox.settings));
      setDraft(pick(withMode(r.inbox.settings)));
    }, () => {});
  }, [workspaceId]);

  const edit = (patch: Draft) => {
    setDraft((d) => ({ ...d, ...patch }));
    setStatus(null);
  };
  const dirty = !same(draft, saved);
  const logoUrl = widgetKey && saved.logoKey ? `/api/widget/${widgetKey}/logo?v=${saved.logoKey}` : null;
  const logoDarkUrl = widgetKey && saved.logoDarkKey ? `/api/widget/${widgetKey}/logo-dark?v=${saved.logoDarkKey}` : null;
  const look = useMemo(() => widgetLook(draft as Record<string, unknown>, workspaceName, logoUrl, logoDarkUrl), [draft, workspaceName, logoUrl, logoDarkUrl]);

  const save = () =>
    run(async () => {
      // Empty text and no suggestions clear those fields back to their defaults.
      const body = {
        ...draft,
        displayName: draft.displayName ?? "",
        greeting: draft.greeting ?? "",
        replyTime: draft.replyTime ?? "",
        placeholder: draft.placeholder ?? "",
        suggestions: draft.suggestions ?? [],
        csat: draft.csat !== false,
        neon: draft.neon !== false,
        sound: draft.sound !== false,
      };
      const r = await api<{ settings: Draft }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body });
      setSaved(withMode(r.settings));
      setDraft(pick(withMode(r.settings)));
      setStatus("Saved. Visitors see it within a minute; no need to change the snippet.");
    });

  // W-21: `logo-dark` is the same control for the logo used on dark surfaces.
  const uploadLogo = (file: File, dark = false) =>
    run(async () => {
      const response = await fetch(`/api/workspaces/${workspaceId}/inbox/${dark ? "logo-dark" : "logo"}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Jun-Upload": "1" },
        body: file,
        credentials: "same-origin",
      });
      const json = (await response.json().catch(() => ({}))) as { settings?: Draft; error?: { code: string; message: string } };
      if (!response.ok) throw new ApiError(json.error?.code ?? "http_error", json.error?.message ?? "Upload failed.");
      setSaved((s) => ({ ...s, logoKey: json.settings!.logoKey, logoDarkKey: json.settings!.logoDarkKey }));
    });
  const removeLogo = (dark = false) =>
    run(async () => {
      const r = await api<{ settings: Draft }>(`/workspaces/${workspaceId}/inbox/${dark ? "logo-dark" : "logo"}`, { method: "DELETE" });
      setSaved((s) => ({ ...s, logoKey: r.settings.logoKey, logoDarkKey: r.settings.logoDarkKey }));
    });

  // W-15: the AI drafts questions from the knowledge base into the draft; nothing is saved until Save.
  const draftSuggestions = () =>
    run(async () => {
      const r = await api<{ suggestions: string[] }>(`/workspaces/${workspaceId}/inbox/suggestions/draft`, { method: "POST", body: {} });
      edit({ suggestions: r.suggestions });
      setStatus("Drafted from your knowledge. Edit them, then Save.");
    });

  const off = !canEdit || busy;
  const suggestions = draft.suggestions ?? [];

  return (
    <div className="appear-page">
      <aside className="appear-controls" aria-label="Widget look">
        <ScrollArea className="appear-scroll" contentClassName="appear-body">
          {!canEdit && <p className="muted small">Only owners and admins can change the widget's look.</p>}

          <section className="appear-group">
            <h2>Mode</h2>
            <div className="appear-modes" role="radiogroup" aria-label="Mode" style={{ "--c": look.color } as CSSProperties}>
              {MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  role="radio"
                  aria-checked={look.mode === m.value}
                  className="appear-mode"
                  disabled={off}
                  onClick={() => { if (look.mode !== m.value) { edit({ mode: m.value }); setOpen(false); } }}
                >
                  <span className={`appear-mode-art ${m.value}`} aria-hidden="true"><i /></span>
                  <span className="appear-mode-name">{m.label}</span>
                  <span className="appear-mode-desc">{m.hint}</span>
                </button>
              ))}
            </div>
            {look.mode === "window" ? (
              <>
                <SwitchRow
                  title="Greeting card"
                  hint={`Your logo, greeting and reply time in place of the button. Once dismissed, a "${BUTTON_TEXT}" pill.`}
                  checked={look.greetingCard}
                  disabled={off}
                  onChange={(checked) => { edit({ greetingCard: checked }); setOpen(false); }}
                />
                {!look.greetingCard && (
                  <Row label="Button shows" hint={look.logoUrl ? undefined : "A chat bubble until you upload a logo."}>
                    <Segmented value={look.buttonStyle} disabled={off} label="Button shows" options={[["logo", "Logo"], ["text", `"${BUTTON_TEXT}"`]]} onChange={(value) => edit({ buttonStyle: value as ButtonStyle })} />
                  </Row>
                )}
                <Row label="Side of the page">
                  <Segmented value={look.position} disabled={off} label="Side of the page" options={[["left", "Left"], ["right", "Right"]]} onChange={(value) => edit({ position: value as "left" | "right" })} />
                </Row>
              </>
            ) : (
              <>
                <Row label="Island colour" hint={look.islandSurface === "dark" ? "Near-black on every page, whatever the theme." : "Follows the theme below."}>
                  <Segmented value={look.islandSurface} disabled={off} label="Island colour" options={[["dark", "Dark"], ["page", "Match theme"]]} onChange={(value) => edit({ islandSurface: value as IslandSurface })} />
                </Row>
                <SwitchRow title="Neon border" hint="A slowly turning multi-colour glow around the island." checked={draft.neon !== false} disabled={off} onChange={(checked) => edit({ neon: checked })} />
              </>
            )}
          </section>

          <section className="appear-group">
            <h2>Brand</h2>
            <Field label="Name shown in the chat" htmlFor="appear-name">
              <Input id="appear-name" value={draft.displayName ?? ""} placeholder={workspaceName} maxLength={TEXT_LIMITS.displayName} disabled={off} onChange={(e) => edit({ displayName: e.target.value })} />
            </Field>
            <div className="appear-field">
              <span className="appear-label">Logo</span>
              <p>PNG, JPEG, WebP or GIF, up to 512 KB. Saved as soon as you pick it.</p>
              <div className="appear-logos">
                <LogoTile label="On light" url={logoUrl} canEdit={canEdit} busy={busy} onPick={(f) => uploadLogo(f)} onRemove={() => removeLogo()} />
                <LogoTile label="On dark" url={logoDarkUrl} fallback={logoUrl} dark canEdit={canEdit} busy={busy} onPick={(f) => uploadLogo(f, true)} onRemove={() => removeLogo(true)} />
              </div>
            </div>
            <Field label="Brand colour" hint="Buttons and the send button. Text on it turns dark or white to stay readable." htmlFor="appear-color">
              <div className="appear-color">
                <div className="appear-swatches" role="group" aria-label="Suggested colours">
                  {SWATCHES.map((c) => (
                    <button key={c} type="button" className="appear-swatch" style={{ background: c }} aria-label={c} aria-pressed={look.color === c} disabled={off} onClick={() => edit({ color: c })} />
                  ))}
                </div>
                <div className="appear-custom">
                  <input type="color" value={look.color} disabled={off} onChange={(e) => edit({ color: e.target.value })} aria-label="Pick any colour" />
                  <Input id="appear-color" value={draft.color ?? APPEARANCE_DEFAULTS.color} maxLength={7} spellCheck={false} disabled={off} onChange={(e) => edit({ color: e.target.value.trim() })} aria-invalid={!/^#[0-9a-f]{6}$/i.test(draft.color ?? APPEARANCE_DEFAULTS.color)} />
                </div>
              </div>
            </Field>
            <Row label="Theme" hint="Auto follows each visitor's light or dark setting.">
              <Segmented value={look.theme} disabled={off} label="Theme" options={[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]]} onChange={(value) => edit({ theme: value as WidgetTheme })} />
            </Row>
            <Field label="Corner rounding" hint={look.mode === "island" ? "The island's open shapes, bubbles and buttons." : "The chat window, bubbles and buttons."} htmlFor="appear-radius">
              <div className="appear-range">
                <input id="appear-radius" type="range" min={0} max={RADIUS_MAX} step={1} value={look.radius} disabled={off} onChange={(e) => edit({ radius: Number(e.target.value) })} />
                <output htmlFor="appear-radius">{look.radius}px</output>
              </div>
            </Field>
          </section>

          <section className="appear-group">
            <h2>Wording</h2>
            <p className="muted small">Leave a field empty to use the text shown in it.</p>
            <Field label="Greeting" htmlFor="appear-greeting">
              <Input id="appear-greeting" value={draft.greeting ?? ""} placeholder={APPEARANCE_DEFAULTS.greeting} maxLength={TEXT_LIMITS.greeting} disabled={off} onChange={(e) => edit({ greeting: e.target.value })} />
            </Field>
            <Field label="Reply time" hint="Under the name. Outside business hours it says when you're back." htmlFor="appear-reply">
              <Input id="appear-reply" value={draft.replyTime ?? ""} placeholder={APPEARANCE_DEFAULTS.replyTime} maxLength={TEXT_LIMITS.replyTime} disabled={off} onChange={(e) => edit({ replyTime: e.target.value })} />
            </Field>
            <Field label="Message box placeholder" htmlFor="appear-placeholder">
              <Input id="appear-placeholder" value={draft.placeholder ?? ""} placeholder={APPEARANCE_DEFAULTS.placeholder} maxLength={TEXT_LIMITS.placeholder} disabled={off} onChange={(e) => edit({ placeholder: e.target.value })} />
            </Field>
            <Field label="Suggested questions" hint={`One per line, up to ${SUGGESTIONS_MAX}. Tapping one sends it.`} htmlFor="appear-suggestions">
              <Textarea
                id="appear-suggestions"
                rows={4}
                value={suggestions.join("\n")}
                placeholder={"How much does it cost?\nHow do I invite my team?"}
                disabled={off}
                onChange={(e) => edit({ suggestions: e.target.value.split("\n").slice(0, SUGGESTIONS_MAX).map((q) => q.slice(0, SUGGESTION_LIMIT)) })}
              />
              {canEdit && (
                <div className="appear-draft">
                  <Button variant="outline" size="sm" disabled={busy} onClick={draftSuggestions}>Draft from your knowledge</Button>
                  <span className="muted small">Replaces the list; nothing changes for visitors until you Save.</span>
                </div>
              )}
            </Field>
          </section>

          <section className="appear-group">
            <h2>Extras</h2>
            <SwitchRow
              title="Sound for new replies"
              hint="A soft chime for a teammate's reply, and for the AI's while the chat is closed or in another tab."
              checked={draft.sound !== false}
              disabled={off}
              onChange={(checked) => edit({ sound: checked })}
              extra={<Button type="button" variant="outline" size="sm" onClick={previewChime}>Test sound</Button>}
            />
            <SwitchRow title="Ask for a rating" hint={'"How did we do?" when a conversation is resolved.'} checked={draft.csat !== false} disabled={off} onChange={(checked) => edit({ csat: checked })} />
          </section>
        </ScrollArea>
        {canEdit && (
          <div className="appear-actions">
            <Button disabled={busy || !dirty} onClick={save}>Save</Button>
            {dirty && <Button variant="ghost" disabled={busy} onClick={() => { setDraft(pick(saved)); setStatus(null); }}>Discard</Button>}
            <Button variant="ghost" className="appear-reset" disabled={busy} onClick={() => edit({ displayName: "", greeting: "", replyTime: "", placeholder: "", suggestions: [], color: APPEARANCE_DEFAULTS.color, position: "right", theme: "auto", radius: APPEARANCE_DEFAULTS.radius, mode: APPEARANCE_DEFAULTS.mode, greetingCard: APPEARANCE_DEFAULTS.greetingCard, buttonStyle: "logo", neon: true, islandSurface: APPEARANCE_DEFAULTS.islandSurface, sound: APPEARANCE_DEFAULTS.sound, csat: true })}>Reset to defaults</Button>
            <span className={error ? "error small appear-status" : "muted small appear-status"} role="status">{error ?? status ?? (dirty ? "Unsaved changes" : "")}</span>
          </div>
        )}
      </aside>
      {widgetKey && <Preview widgetKey={widgetKey} look={look} open={open} onOpen={setOpen} />}
    </div>
  );
}

const MODES: { value: WidgetMode; label: string; hint: string }[] = [
  { value: "island", label: "Island", hint: "A pill at the bottom centre that grows into the answer." },
  { value: "window", label: "Chat window", hint: "A button or greeting card in the corner that opens a chat." },
];

/** Quick picks for the brand colour; any colour still goes in the picker or as hex. */
const SWATCHES = [APPEARANCE_DEFAULTS.color, "#111111", "#7c3aed", "#db2777", "#dc2626", "#ea580c", "#16a34a", "#0d9488"];

/** A setting with its control on the right (segmented buttons). */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="appear-row">
      <div className="appear-row-text">
        <span className="appear-label">{label}</span>
        {hint && <p>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/** A few choices side by side (not a dropdown: every option stays visible). */
function Segmented({ value, options, label, disabled, onChange }: { value: string; options: [string, string][]; label: string; disabled?: boolean; onChange: (value: string) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <Button key={v} type="button" variant="ghost" size="sm" className={value === v ? "active" : ""} aria-pressed={value === v} disabled={disabled} onClick={() => onChange(v)}>{text}</Button>
      ))}
    </div>
  );
}

/** A switch with a title and a short line under it; `extra` (a Test button) goes under them, outside the label. */
function SwitchRow({ title, hint, checked, disabled, onChange, extra }: { title: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void; extra?: ReactNode }) {
  return (
    <div className="appear-switch-row">
      <label className="appear-row-text appear-switch">
        <span className="appear-label">{title}</span>
        {hint && <p>{hint}</p>}
        <Switch className="appear-switch-control" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </label>
      {extra && <div className="appear-switch-extra">{extra}</div>}
    </div>
  );
}

/** One logo (W-21: a second one for dark surfaces): the image on its background, Upload / Replace and Remove. */
function LogoTile({ label, url, fallback, dark, canEdit, busy, onPick, onRemove }: { label: string; url: string | null; fallback?: string | null; dark?: boolean; canEdit: boolean; busy: boolean; onPick: (file: File) => void; onRemove: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  // No dark logo: show the light one on dark, which is what visitors get.
  const shown = url ?? fallback ?? null;
  return (
    <div className={`appear-logo-tile${dark ? " dark" : ""}`}>
      <div className="appear-logo-box">
        {shown ? <img src={shown} alt={`${label} logo`} className={url ? "" : "fallback"} /> : <UploadIcon size={18} aria-hidden="true" />}
      </div>
      <div className="appear-logo-meta">
        <span className="appear-label">{label}</span>
        <span className="muted small">{url ? "Uploaded" : dark ? (fallback ? "Uses the light logo" : "Optional") : "None yet"}</span>
        {canEdit && (
          <div className="appear-logo-btns">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => input.current?.click()}>{url ? "Replace" : "Upload"}</Button>
            {url && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onRemove}>Remove</Button>}
          </div>
        )}
      </div>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); e.target.value = ""; }} />
    </div>
  );
}

function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="appear-field">
      <label htmlFor={htmlFor}>{label}</label>
      {hint && <p>{hint}</p>}
      {children}
    </div>
  );
}

/** The real widget frame with the draft look (it draws the island and the greeting card itself), plus a copy of the loader's button. */
function Preview({ widgetKey, look, open, onOpen }: { widgetKey: string; look: ReturnType<typeof widgetLook>; open: boolean; onOpen: (open: boolean) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // The frame asks for the look when it's ready (also after reloading itself).
  const lookRef = useRef(look);
  lookRef.current = look;
  const openRef = useRef(open);
  openRef.current = open;
  const post = useCallback((message: unknown) => frame.current?.contentWindow?.postMessage(message, window.location.origin), []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; id?: string } | null;
      if (data?.type === "jun:ready") {
        post({ type: "jun:preview", look: lookRef.current });
        post({ type: openRef.current ? "jun:open" : "jun:close" });
      }
      if (data?.type === "jun:close") onOpen(false);
      // The island and the card open themselves, and size and place their frame like the loader does
      // (the card morphs into the chat inside a frame that keeps its size, D-90: no grow-in here).
      if (data?.type === "jun:open") onOpen(true);
      if (data?.type === "jun:css" && frame.current) {
        frame.current.style.cssText = String((data as { css?: unknown }).css ?? "");
        // The card places itself on a side; the preview keeps it centred (the island already is).
        if (launcher.current !== "island") Object.assign(frame.current.style, { left: "50%", right: "auto", translate: "-50% 0" });
        else frame.current.style.translate = "none";
        frame.current.dataset.sized = "";
      }
      // No host page here, so no debug context: answer at once instead of letting it time out.
      if (data?.type === "jun:context-request") post({ type: "jun:context", id: data.id, context: undefined });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [post, onOpen]);

  useEffect(() => post({ type: "jun:preview", look }), [look, post]);
  useEffect(() => post({ type: open ? "jun:open" : "jun:close" }), [open, post]);
  const button = look.launcher === "button";
  // Changing the mode or the greeting card, or closing a chat opened from the button: drop the size
  // the frame gave itself (the frame sends its own again). The island and the card keep theirs when they close: they
  // send their closed size and clip with the close, and wiping it would leave a full, white frame.
  const launcher = useRef(look.launcher);
  useEffect(() => {
    const changed = launcher.current !== look.launcher;
    launcher.current = look.launcher;
    if (frame.current && (changed || (button && !open))) {
      frame.current.style.cssText = "";
      delete frame.current.dataset.sized;
    }
  }, [look.launcher, open, button]);
  const brand = { "--c": look.color, "--t": textOn(look.color), "--r": `${look.radius}px` } as CSSProperties;
  // As the loader: on a dark button colour, the logo for dark backgrounds (W-21).
  const buttonLogo = logoFor(look, textOn(look.color) === "#ffffff");
  return (
    <div className="appear-preview" aria-label="Preview">
      <div className="appear-preview-bar">
        <div className="segmented" role="group" aria-label="Preview">
          <Button variant="ghost" size="sm" className={open ? "active" : ""} aria-pressed={open} onClick={() => onOpen(true)}>Open</Button>
          <Button variant="ghost" size="sm" className={open ? "" : "active"} aria-pressed={!open} onClick={() => onOpen(false)}>Closed</Button>
        </div>
      </div>
      {/* Always centred: the preview shows the look; the side only applies on the website. */}
      <div className={`appear-stage ${look.theme} ${look.launcher}`} style={brand}>
        <iframe
          ref={frame}
          className={`appear-frame${open && button ? " opening" : ""}`}
          title="Widget preview"
          src={`/widget?key=${encodeURIComponent(widgetKey)}&preview=1&persist=0`}
          hidden={!open && button}
        />
        {/* The open chat takes the button's corner, as on a website. */}
        {button && !open && (
          <button className={`appear-launcher${look.buttonStyle === "text" ? " txt" : ""}`} aria-label="Open chat" aria-expanded={false} onClick={() => onOpen(true)}>
            {look.buttonStyle === "text" ? (
              <span>{BUTTON_TEXT}</span>
            ) : buttonLogo ? (
              <img src={buttonLogo} alt="" />
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z" />
              </svg>
            )}
          </button>
        )}
      </div>
      <p className="appear-note muted small">This is the real widget with your unsaved changes. Messages you send here start real chats in your inbox.</p>
    </div>
  );
}
