import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRightIcon, DeadClickIcon, RageClickIcon, StuckIcon } from "@/components/icons";
import { Button } from "@/components/ui/button.tsx";
import { MAX_START_PAGES, type ChatOutcome, type MetricsReport, type PageRow, type StruggleKind, type StrugglePage } from "../../shared/metrics.ts";
import { ChatsSheet } from "./ChatsSheet.tsx";

// D-124: "Pages where chats start" (rows with a per-day sparkline, grouped under shared parent paths)
// and "Where visitors struggle" (one card per page, chips per element, what happened to those chats).
// Both in Top topics' look: a soft panel, mono numbers, pills.

const percent = (r: number) => `${Math.round(r * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const decodedPath = (page: string) => {
  const path = new URL(page).pathname;
  try {
    return decodeURI(path);
  } catch {
    // Not valid percent-encoding: show it as stored.
    return path;
  }
};

/** A path that wraps after its slashes; `muted` is a leading part drawn quietly (the group's own path). */
function Path({ page, host, muted }: { page: string; host: boolean; muted?: string }) {
  const path = decodedPath(page);
  const quiet = muted && path.startsWith(`${muted}/`) && muted !== "/" ? muted : "";
  const parts = path.slice(quiet.length).split(/(?<=\/)/);
  return (
    <>
      {host && <span className="page-host">{new URL(page).host}</span>}
      {quiet && <span className="page-host">{quiet}</span>}
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          <wbr />
        </span>
      ))}
    </>
  );
}

/** Chats per day as a small line in the desk's blue, on the row's own scale (the count says how many). */
function Sparkline({ days }: { days: number[] }) {
  const w = 72;
  const h = 24;
  const max = Math.max(1, ...days);
  const x = (i: number) => (days.length === 1 ? w / 2 : (i / (days.length - 1)) * w);
  const y = (n: number) => h - 2 - (n / max) * (h - 4);
  const line = days.map((n, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(n).toFixed(1)}`).join("");
  return (
    <svg className="pg-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden="true">
      <path className="pg-spark-area" d={`${line}L${x(days.length - 1).toFixed(1)} ${h}L${x(0).toFixed(1)} ${h}Z`} />
      <path className="pg-spark-line" d={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function PageLine({ row, host, depth, parent, open, onToggle, groupId }: {
  row: PageRow; host: boolean; depth: number; parent?: PageRow; open?: boolean; onToggle?: () => void; groupId?: string;
}) {
  const self = parent?.page === row.page;
  const body: ReactNode = (
    <>
      <span className="pg-chevron" aria-hidden="true">{row.children && <ChevronRightIcon />}</span>
      <span className="pg-path">
        <Path page={row.page} host={host && !parent} muted={parent ? decodedPath(parent.page) : undefined} />
        {self && <span className="pg-self"> this page</span>}
        {row.children && <span className="pg-sub">{plural(row.children.length, "page")}</span>}
      </span>
      <Sparkline days={row.perDay} />
      <span className="pg-ai" title={row.aiResolutionRate === null ? undefined : `The AI resolved ${row.aiResolved} of the ${row.ai} AI chats that started here alone`}>
        {row.aiResolutionRate !== null && <span className="tt-pill">AI {percent(row.aiResolutionRate)}</span>}
      </span>
      <span className="pg-count">{row.count.toLocaleString()}</span>
    </>
  );
  const style = { "--depth": depth } as CSSProperties;
  return row.children ? (
    <button type="button" className="pg-line group" style={style} aria-expanded={open} aria-controls={groupId} onClick={onToggle} title={row.page}>
      {body}
    </button>
  ) : (
    <div className="pg-line" style={style} title={row.page}>{body}</div>
  );
}

/** A row and, for an open group, its pages under it (groups can hold groups). */
function PageItem({ row, host, depth = 0, parent }: { row: PageRow; host: boolean; depth?: number; parent?: PageRow }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li>
      <PageLine row={row} host={host} depth={depth} parent={parent} open={open} onToggle={() => setOpen((o) => !o)} groupId={id} />
      {row.children && open && (
        <ul className="pg-children" id={id}>
          {row.children.map((c) => <PageItem key={c.page} row={c} host={host} depth={depth + 1} parent={row} />)}
        </ul>
      )}
    </li>
  );
}

const leaves = (rows: PageRow[]): PageRow[] => rows.flatMap((r) => (r.children ? leaves(r.children) : [r]));

/**
 * A-06: where visitors were when they opened a chat, after D-124: one row per page (or group of pages
 * under one parent path) with its chats per day and the AI's rate. Rows don't open the inbox: it has
 * no page filter. Paths only when every page is on one site.
 */
export function StartPages({ pages }: { pages: MetricsReport["pages"] }) {
  const [all, setAll] = useState(false);
  const origins = new Set(leaves(pages.rows).map((p) => new URL(p.page).origin));
  const site = origins.size === 1 && pages.rows[0] ? new URL(pages.rows[0].page).host : null;
  const shown = all ? pages.rows : pages.rows.slice(0, MAX_START_PAGES);
  const rest = pages.withPage - pages.rows.reduce((s, p) => s + p.count, 0);
  const anyAi = leaves(pages.rows).some((p) => p.aiResolutionRate !== null);
  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <h2>Pages where chats start</h2>
        {site && <span className="muted small nums">{site}</span>}
      </div>
      {pages.rows.length === 0 ? (
        <p className="muted small">
          No chats from your site in this period. The widget notes the page a visitor is on when they send their first message.
        </p>
      ) : (
        <>
          <ul className="pg-list">
            {shown.map((p) => <PageItem key={p.page} row={p} host={!site} />)}
          </ul>
          {pages.rows.length > MAX_START_PAGES && (
            <Button variant="ghost" size="sm" className="pg-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${pages.rows.length}`}
            </Button>
          )}
          <p className="dash-foot">
            Of the {pages.withPage.toLocaleString()} chats that started on a known page{rest > 0 ? ` (${rest} on pages not listed)` : ""}; the line is chats per day.
            {anyAi && " AI % is how many of the page's AI chats the AI resolved alone."}
            {pages.withoutPage > 0 && ` ${pages.withoutPage} had no page (opened outside your site).`} Numbers and ids in paths are grouped as :id, and pages under one path are grouped under it.
          </p>
        </>
      )}
    </section>
  );
}

const KIND = {
  rage_click: { Icon: RageClickIcon, word: "Rage clicks", short: "Rage click" },
  dead_click: { Icon: DeadClickIcon, word: "Clicks that did nothing", short: "Dead click" },
  stuck: { Icon: StuckIcon, word: "Stuck after a problem", short: "Stuck" },
} as const satisfies Record<StruggleKind, unknown>;
const OUTCOME: Record<ChatOutcome, string> = { person: "Went to a person", ai: "AI only", none: "No reply" };

/** Cards shown before "Show all" (the report keeps up to MAX_STRUGGLE_PAGES). */
const STRUGGLE_CARDS_SHOWN = 4;

/** 0 for one troubled chat, 1 from ten: the card's strip goes amber → red (log scale, so a few chats already warm it). */
const severity = (n: number) => Math.min(1, Math.log(Math.max(1, n)) / Math.log(10));

/** What the chats sheet lists: a page's troubled chats, or one chip's. */
interface ChatList {
  card: StrugglePage;
  title: string;
  ids: string[] | null;
  /** How many chats it covers (the lists are capped). */
  total: number;
}

/** A-08 after D-124: one card per page, worst first, chips per element, and how many went to a person. */
export function Struggles({ struggles }: { struggles: MetricsReport["struggles"] }) {
  const [active, setActive] = useState<string | null>(null);
  const [list, setList] = useState<ChatList | null>(null);
  const [all, setAll] = useState(false);
  const cards = all ? struggles.pages : struggles.pages.slice(0, STRUGGLE_CARDS_SHOWN);
  const hover = (page: string) => ({
    onPointerEnter: () => setActive(page),
    onPointerLeave: () => setActive((a) => (a === page ? null : a)),
    onFocus: () => setActive(page),
    onBlur: () => setActive((a) => (a === page ? null : a)),
  });
  // A chip's chats can be ones the page's (capped) list left out: those show without their details.
  const chats = !list ? [] : !list.ids ? list.card.chats
    : list.ids.map((id) => list.card.chats.find((c) => c.id === id) ?? { id, createdAt: null, outcome: null, kinds: [] });
  const listed = list?.total ?? 0;
  return (
    <section className="dash-card">
      <div className="dash-card-head"><h2>Where visitors struggle</h2></div>
      {struggles.pages.length === 0 ? (
        <p className="muted small">No rage clicks, dead clicks or stuck pages in this period's chats. The widget records them on your site and shares them when a visitor writes in.</p>
      ) : (
        <>
          <ul className="st-cards">
            {cards.map((card) => {
              const path = decodedPath(card.page);
              const openAll = () => setList({ card, title: "Every chat with trouble on this page", ids: null, total: card.conversations });
              return (
                <li
                  key={card.page}
                  className={`st-card ${active === null ? "" : active === card.page ? "on" : "off"}`}
                  style={{ "--sev": severity(card.conversations) } as CSSProperties}
                  onClick={openAll}
                  {...hover(card.page)}
                >
                  <button type="button" className="st-head" onClick={(e) => { e.stopPropagation(); openAll(); }} title={card.page} aria-label={`${path}: ${plural(card.conversations, "chat")} with trouble. Show them`}>
                    <span className="st-path"><Path page={card.page} host={false} /></span>
                    <span className="st-n">{card.conversations.toLocaleString()}<span>{card.conversations === 1 ? "chat" : "chats"}</span></span>
                  </button>
                  <div className="st-chips">
                    {card.spots.map((s) => {
                      const { Icon, word, short } = KIND[s.kind];
                      const name = s.label ?? short;
                      return (
                        <button
                          key={`${s.kind}|${s.target}`}
                          type="button"
                          className={`st-chip ${s.kind}`}
                          title={`${word}${s.target ? ` on ${s.target}` : ""}: ${plural(s.conversations, "chat")}`}
                          onClick={(e) => { e.stopPropagation(); setList({ card, title: `${word}${s.label ? ` on “${s.label}”` : ""}`, ids: s.chats, total: s.conversations }); }}
                        >
                          <Icon aria-hidden="true" />
                          <span className="st-chip-name">{s.label ? `“${name}”` : name}</span>
                          <span className="st-chip-n">· {s.conversations.toLocaleString()}</span>
                        </button>
                      );
                    })}
                    {card.moreSpots > 0 && <span className="st-more">+{card.moreSpots} more</span>}
                  </div>
                  {card.known > 0 && (
                    <p className="st-outcome">
                      <span className="st-num">{card.toPerson.toLocaleString()}</span> of <span className="st-num">{card.known.toLocaleString()}</span> went to a person
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {struggles.pages.length > STRUGGLE_CARDS_SHOWN && (
            <Button variant="ghost" size="sm" className="pg-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
              {all ? "Show fewer" : `Show all ${struggles.pages.length} pages`}
            </Button>
          )}
          <p className="dash-foot">
            Counts are chats whose visitor hit it before or while writing in ({struggles.conversations.toLocaleString()} chats had at least one); the strip warms with more. Click a card or a chip for its chats. Only visitors who chatted are counted: the widget sends what happened with their messages.
          </p>
        </>
      )}
      <ChatsSheet
        open={list !== null}
        onClose={() => setList(null)}
        title={list ? decodedPath(list.card.page) : ""}
        titleClassName="st-sheet-title"
        description={list ? `${list.title} · ${plural(listed, "chat")}` : ""}
        total={listed}
        chats={chats.map((c) => ({
          id: c.id,
          createdAt: c.createdAt,
          aside: (
            <>
              <span className="st-chat-kinds" aria-label={c.kinds.map((k) => KIND[k].short).join(", ")}>
                {c.kinds.map((k) => { const { Icon } = KIND[k]; return <Icon key={k} />; })}
              </span>
              {c.outcome && <span className={`tt-pill st-chat-outcome ${c.outcome}`}>{OUTCOME[c.outcome]}</span>}
            </>
          ),
        }))}
      />
    </section>
  );
}
