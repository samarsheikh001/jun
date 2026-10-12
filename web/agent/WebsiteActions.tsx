import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SeenPageAction } from "../../shared/actions.ts";
import { cardFromShape } from "../../shared/widgets.ts";
import { widgetPageButtons } from "../../shared/agent-links.ts";
import { Button } from "@/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { PlusIcon, XIcon } from "../components/icons.tsx";
import { go, humanize, slug, WIDGET } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// W-31: website actions are WebMCP tools the customer's own site registers; the AI runs them in the
// customer's browser. The desk never has their code, only what the loader reported when a customer
// chatted (`…/agent/page-actions`: names, descriptions, the card the page names, and the shape of the
// last result, never its values). Here the admin picks the card a result is shown as (the widget
// file's `pageActions`), or makes one from that shape.

let cache: { base: string; actions: SeenPageAction[] } | null = null;

/** The website actions the desk has seen, most recent first (null while loading). */
export function useSeenPageActions(cfg: AgentConfig): SeenPageAction[] | null {
  const [actions, setActions] = useState<SeenPageAction[] | null>(cache?.base === cfg.base ? cache.actions : null);
  useEffect(() => {
    let live = true;
    api<{ actions: SeenPageAction[] }>(`${cfg.base}/page-actions`)
      .then(({ actions }) => {
        cache = { base: cfg.base, actions };
        if (live) setActions(actions);
      })
      .catch(() => live && setActions([]));
    return () => {
      live = false;
    };
  }, [cfg.base]);
  return actions;
}

type Data = Record<string, unknown>;
const readJson = (text: string): Data | null => {
  try {
    const file = JSON.parse(text) as unknown;
    return typeof file === "object" && file !== null && !Array.isArray(file) ? (file as Data) : null;
  } catch {
    return null;
  }
};
const listOf = (file: Data | null): string[] => (Array.isArray(file?.pageActions) ? file.pageActions.filter((n): n is string => typeof n === "string") : []);

/** Widget names in the draft. */
const widgetNames = (draft: Record<string, string>) =>
  Object.keys(draft)
    .map((p) => WIDGET.exec(p)?.[1])
    .filter((n): n is string => Boolean(n))
    .sort();

/** The website actions a widget shows (its file's `pageActions`). */
export function widgetPageActions(draft: Record<string, string>, widget: string): string[] {
  return listOf(readJson(draft[`widgets/${widget}.widget`] ?? ""));
}

/** The card a website action's result is shown as: the desk's choice, else the one its page names. */
export function cardOf(draft: Record<string, string>, action: SeenPageAction | string): { widget: string; by: "desk" | "page" } | null {
  const name = typeof action === "string" ? action : action.name;
  const desk = widgetNames(draft).find((w) => widgetPageActions(draft, w).includes(name));
  if (desk) return { widget: desk, by: "desk" };
  const declared = typeof action === "string" ? undefined : action.widget;
  return declared && `widgets/${declared}.widget` in draft ? { widget: declared, by: "page" } : null;
}

/** W-32: the widgets with a button that runs `action` (`page:<name>`). */
export function pageButtonWidgets(draft: Record<string, string>, action: string): string[] {
  return widgetNames(draft).filter((w) => widgetPageButtons(draft[`widgets/${w}.widget`] ?? "").includes(action));
}

/** The file with `pageActions` set to `names` (removed when empty); other keys keep their order. */
function withPageActions(text: string, names: string[]): string {
  const file = readJson(text) ?? {};
  if (names.length) file.pageActions = names;
  else delete file.pageActions;
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Shows `action`'s result as `widget` (null: as text): one widget per action, edited in the draft. */
export function setCard(cfg: AgentConfig, action: string, widget: string | null): void {
  for (const w of widgetNames(cfg.draft)) {
    const path = `widgets/${w}.widget`;
    const names = widgetPageActions(cfg.draft, w);
    const next = w === widget ? (names.includes(action) ? names : [...names, action]) : names.filter((n) => n !== action);
    if (next.length !== names.length && readJson(cfg.draft[path]!)) cfg.setFile(path, withPageActions(cfg.draft[path]!, next));
  }
}

/** Makes a first card for the action from its result's shape, linked to it, and opens it. */
function makeCard(cfg: AgentConfig, action: SeenPageAction): void {
  const base = slug(action.name, "_") || "website_card";
  let name = base;
  for (let n = 2; `widgets/${name}.widget` in cfg.draft; n++) name = `${base}_${n}`;
  setCard(cfg, action.name, null);
  cfg.setFile(`widgets/${name}.widget`, cardFromShape(humanize(action.name), action.name, action.shape!));
  go(`/agent/widgets/${name}`);
}

const TEXT = "";

/** /agent/actions: the actions on the customer's website, each with the card its result shows as. */
export function WebsiteActions({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const seen = useSeenPageActions(cfg);
  const widgets = widgetNames(cfg.draft);
  return (
    <section className="agent-site-actions" aria-labelledby="site-actions-h">
      <div className="agent-site-actions-head">
        <h2 id="site-actions-h">On your website</h2>
        <p>
          Actions your site's code registers (WebMCP or <code>JunDesk.registerAction</code>). The AI runs them in the customer's browser. Pick a widget to show
          what one returns, or make one from what it returned last time.
        </p>
      </div>
      {seen === null ? null : seen.length === 0 ? (
        <p className="muted small">None seen yet. They show up here once a customer chats on a page that registers them.</p>
      ) : (
        <ul className="agent-index-grid">
          {seen.map((a) => {
            const card = cardOf(cfg.draft, a);
            const buttons = pageButtonWidgets(cfg.draft, a.name);
            return (
              <li key={a.name} className="agent-index-card">
                <span className="agent-index-title">{humanize(a.name)}</span>
                <p className="agent-index-sub">{a.description}</p>
                <label className="agent-site-card">
                  <span>Shows its result as</span>
                  <NativeSelect
                    aria-label={`Widget for ${humanize(a.name)}`}
                    size="sm"
                    value={card?.widget ?? TEXT}
                    disabled={!canEdit}
                    onChange={(e) => setCard(cfg, a.name, e.target.value || null)}
                  >
                    <NativeSelectOption value={TEXT}>Text (no widget)</NativeSelectOption>
                    {widgets.map((w) => (
                      <NativeSelectOption key={w} value={w}>
                        {humanize(w)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
                {card?.by === "page" && <p className="agent-index-sub">Set in your site's code. Picking another widget here wins.</p>}
                {buttons.length > 0 && (
                  <div className="agent-site-card">
                    <span>Run by buttons in</span>
                    <span className="agent-links-chips">
                      {buttons.map((w) => (
                        <a key={w} className="agent-link-chip" data-kind="widget" href={`/agent/widgets/${w}`} onClick={(e) => { e.preventDefault(); go(`/agent/widgets/${w}`); }}>
                          {humanize(w)}
                        </a>
                      ))}
                    </span>
                  </div>
                )}
                {canEdit && !card && (
                  a.shape ? (
                    <Button variant="outline" size="sm" className="agent-site-make" onClick={() => makeCard(cfg, a)}>
                      <PlusIcon /> Make a widget
                    </Button>
                  ) : (
                    <p className="agent-index-sub">Run it once on your site and you can make a widget from what it returns.</p>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** A widget's Details: the website actions whose result it shows. */
export function WidgetPageActions({ cfg, name, canEdit }: { cfg: AgentConfig; name: string; canEdit: boolean }) {
  const seen = useSeenPageActions(cfg);
  const mine = widgetPageActions(cfg.draft, name);
  const fromCode = (seen ?? []).filter((a) => a.widget === name && !mine.includes(a.name) && !cardOf(cfg.draft, a.name)).map((a) => a.name);
  const others = (seen ?? []).filter((a) => !mine.includes(a.name));
  return (
    <div className="agent-wed-group">
      <h3>Website actions</h3>
      <p>Actions on your website whose result shows as this widget.</p>
      {(mine.length > 0 || fromCode.length > 0) && (
        <ul className="agent-site-chips">
          {mine.map((a) => (
            <li key={a} className="agent-link-chip" data-kind="action">
              {humanize(a)}
              {canEdit && (
                <button type="button" data-plain aria-label={`Stop showing ${humanize(a)} as this card`} onClick={() => setCard(cfg, a, null)}>
                  <XIcon />
                </button>
              )}
            </li>
          ))}
          {fromCode.map((a) => (
            <li key={a} className="agent-link-chip" data-kind="action" title="Set in your site's code">
              {humanize(a)} · in your code
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <NativeSelect aria-label="Add a website action" size="sm" value="" onChange={(e) => e.target.value && setCard(cfg, e.target.value, name)}>
          <NativeSelectOption value="">{others.length ? "Add a website action…" : seen === null ? "Loading…" : "No other website actions seen yet"}</NativeSelectOption>
          {others.map((a) => (
            <NativeSelectOption key={a.name} value={a.name}>
              {humanize(a.name)}
              {cardOf(cfg.draft, a)?.by === "desk" ? ` (now ${humanize(cardOf(cfg.draft, a)!.widget)})` : ""}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}
