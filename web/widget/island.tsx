import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { playNow } from "../lib/sound.ts";

// W-04 "island" mode (D-39, D-89): one small control at the bottom centre of the page that changes
// shape to fit each moment and always returns to a resting pill. The frame is transparent and always shown; it tells the loader its size and the part of it that's drawn
// (`jun:css`), which the loader applies as the frame's inline style. Everything happens inside
// the frame: the page itself is never touched. Styles: `widget.css` (`html.island`; on the
// near-black surface, the default, also `html.island-dark`).
//
// It is one object, never a box swapped for another: in the open, answer and panel states the
// bottom row is the pill itself (the mark and the input, 44px like the resting pill) and the
// content grows above it. There's no header bar: the visitor's question is the answer's title,
// Minimize and End sit in the top-right corner on hover (IslandControls), and a short top row
// carries what must stay visible (an intent's exit, who's talking, Earlier/Latest).

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How many times the hint types through the suggested questions before it stays still. */
const TYPE_ROUNDS = 2;

/**
 * The resting pill's hint: types each suggested question out (about 42ms a letter), then the next
 * one every 5.7s, TYPE_ROUNDS times through, then rests on the first (D-105: each letter is a
 * render, which kept a slow device busy for as long as the page stayed open). Without suggestions
 * it shows the placeholder.
 */
function Typewriter({ phrases, fallback }: { phrases: string[]; fallback: string }) {
  const [index, setIndex] = useState(0);
  const [length, setLength] = useState(0);
  const done = index >= phrases.length * TYPE_ROUNDS;
  const phrase = phrases.length ? phrases[done ? 0 : index % phrases.length]! : fallback;
  const animate = phrases.length > 0 && !done && !reducedMotion();

  useEffect(() => {
    if (!animate) return;
    setLength(0);
    let typed = 0;
    const typer = setInterval(() => {
      typed += 1;
      setLength(typed);
      if (typed >= phrase.length) clearInterval(typer);
    }, 42);
    const next = setTimeout(() => setIndex((i) => i + 1), 5670);
    return () => {
      clearInterval(typer);
      clearTimeout(next);
    };
  }, [animate, phrase]);

  return (
    <div className="i-hint" aria-hidden="true">
      <span key={index} className="i-hint-text">{animate ? phrase.slice(0, length) : phrase}</span>
    </div>
  );
}

/**
 * rest: the pill (or, with a chat, a one-line summary of its last answer). intro (D-99): a first
 * visit's suggested questions over the resting pill, for a few seconds. nudge: a one-line offer
 * of help (P-01, V-07). open: the suggested questions over the pill's row. thinking: one status
 * line while the assistant works (before the first reply, and while a card's button is being
 * handled). answer: the latest exchange, its question as the title, over the pill's row; it folds
 * itself back to rest a few seconds after it's done (`autoFold`). panel: the whole conversation
 * (a teammate's chat, or "Earlier").
 */
export type IslandState = "rest" | "intro" | "nudge" | "open" | "thinking" | "answer" | "panel";

/** Each state's width; phones cap every width at the frame minus 24px. */
const WIDTHS: Record<IslandState, number> = { rest: 360, intro: 460, nudge: 440, open: 660, thinking: 420, answer: 560, panel: 660 };
/** D-79: a one-line pill that hugs its text stays within these. */
const HUG_MIN = 240;
const HUG_MAX = 480;
/** Room around the island kept visible for its shadow (which `.i-shell` keeps well inside it). */
const GLOW = 32;
/** The island's distance from the bottom of the viewport (matches `.i-root`'s padding). */
const edge = (width: number) => (width < 640 ? 12 : 24);
/** The frame's spring: a slight overshoot, about 0.65s (the proposal's stiffness 380 / damping 30). */
export const SPRING = "cubic-bezier(.34, 1.25, .5, 1)";
/** W-34: one JunDesk.highlight() call: `n` counts the calls (each plays it again), `sound` if it asked for one. */
export interface Highlight {
  n: number;
  sound: boolean;
}
/** W-34: how long JunDesk.highlight()'s lift and glow last (widget.css `i-flash`). */
const FLASH_MS = 1_400;
/** How long the resting pill waits, untouched, before it shrinks to its mark and "Ask". */
export const IDLE_MS = 10_000;
/** The shrunk pill's width: the mark, "Ask" and the "/" key. */
const COMPACT_W = 136;
/**
 * Where the island sits along the bottom edge. The visitor can hold the resting pill and throw it to a
 * side (Island's drag); phones keep it in the centre.
 */
export type IslandSpot = "left" | "center" | "right";
/** How far the pill moves before a press becomes a drag (a smaller move is still a click). */
const DRAG_START_PX = 6;
/** A throw carries on for this long at the speed it was let go, then snaps to the nearest spot. */
const THROW_MS = 180;
/** Narrower frames (phones) keep the island in the centre. */
const SPOTS_MIN_W = 640;

/**
 * Sizes the frame: a fixed transparent box at the bottom centre (up to 720×680), clipped to the
 * island's box plus its shadow so the rest of the frame doesn't take the page's clicks. The clip
 * animates with the same curve as the island, so the two stay together.
 */
function useIslandFrame(box: { x: number; w: number; h: number }, live: boolean, away = false, dragging = false): void {
  useLayoutEffect(() => {
    const motion = reducedMotion() || dragging ? "" : `transition:clip-path ${live ? ".25s ease-out" : `.65s ${SPRING}`};`;
    const bottom = edge(window.innerWidth);
    postToHost({
      type: "jun:css",
      css:
        // The page's width, so the island can sit at either side (IslandSpot), and room for the tallest
        // answer (720px) plus its edge and glow; the clip-path leaves the rest of the page clickable.
        // Inside, innerWidth is the page's and innerHeight its height up to 840px.
        "display:block;top:auto;bottom:0;left:0;right:0;margin:0;width:100%;height:min(840px,100%);" +
        `border:0;border-radius:0;background:none;box-shadow:none;color-scheme:normal;${motion}` +
        // Away: nothing of the frame is left to take the page's clicks.
        `clip-path:inset(${away ? "100%" : `calc(100% - ${box.h + bottom + GLOW}px)`} calc(100% - ${Math.round(box.x + box.w + GLOW)}px) ${Math.max(0, bottom - GLOW)}px ${Math.max(0, Math.round(box.x - GLOW))}px)`,
    });
  }, [box.x, box.w, box.h, live, away, dragging]);
  // widget-island.js reads the page's colour under the island's middle (D-99).
  useEffect(() => {
    postToHost({ type: "jun:spot", cx: Math.round(box.x + box.w / 2) });
  }, [box.x, box.w]);
}

/** The island's left edge in the frame for a spot (the centre on narrow frames). */
function spotX(spot: IslandSpot, w: number, frameW: number): number {
  const m = edge(frameW);
  if (frameW < SPOTS_MIN_W || spot === "center") return (frameW - w) / 2;
  return spot === "left" ? m : frameW - w - m;
}

/**
 * How long a finished answer stays open, untouched, before the island folds itself: AUTO_FOLD_MS
 * plus the time to read what's on screen (READ_WORDS_PER_S), at most AUTO_FOLD_MAX_MS.
 */
export const AUTO_FOLD_MS = 8_000;
export const AUTO_FOLD_MAX_MS = 30_000;
const READ_WORDS_PER_S = 4;

/** The wait for the answer on screen: the reply's words and its card's text (not the question). */
function foldDelay(el: HTMLElement): number {
  let words = 0;
  for (const msg of el.querySelectorAll(".i-body .msg:not(.own)")) words += (msg.textContent ?? "").split(/\s+/).filter(Boolean).length;
  return Math.min(AUTO_FOLD_MAX_MS, AUTO_FOLD_MS + (words / READ_WORDS_PER_S) * 1000);
}

/**
 * Folds the island foldDelay() after `fold` becomes set (the caller sets it only once an answer
 * is finished and nothing waits on the visitor), unless it's in use: the pointer over it, focus
 * on something in it other than the empty question box (which keeps the focus after sending),
 * text in the box, the "+" menu or a screenshot open, or the answer scrolled away from its top
 * (the visitor is reading further down). Any pointer, key, scroll or focus inside starts the wait
 * again. Reduced motion still folds (the shapes just don't animate).
 */
function useAutoFold(box: RefObject<HTMLDivElement | null>, fold: (() => void) | null): void {
  const latest = useRef(fold);
  latest.current = fold;
  const enabled = Boolean(fold);
  useEffect(() => {
    const el = box.current;
    if (!enabled || !el) return;
    let over = el.matches(":hover");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => {
      if (over) return true;
      const active = document.hasFocus() ? document.activeElement : null;
      const field = el.querySelector<HTMLTextAreaElement>(".i-row textarea");
      if (field?.value.trim()) return true;
      if (el.querySelector(".composer-menu, .composer-shot, .composer-files")) return true;
      if ((el.querySelector<HTMLElement>(".i-body")?.scrollTop ?? 0) > 4) return true;
      return Boolean(active && active !== document.body && el.contains(active) && active !== field);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (inUse() ? arm() : latest.current?.()), foldDelay(el));
    };
    const enter = () => {
      over = true;
    };
    const leave = () => {
      over = false;
      arm();
    };
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    const pokes = ["pointerdown", "keydown", "input", "focusin", "wheel"] as const;
    for (const type of pokes) document.addEventListener(type, arm, true);
    document.addEventListener("scroll", arm, true);
    arm();
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      for (const type of pokes) document.removeEventListener(type, arm, true);
      document.removeEventListener("scroll", arm, true);
    };
  }, [enabled, box]);
}

/**
 * The morphing container. New content is drawn off to the side at the state's width and measured;
 * the shell then springs to that exact size (measure, then move). A key per state swaps the content,
 * rising into place from the pill's row with a short fade and un-blur. `autoFold`: set while a
 * finished answer may fold itself (see useAutoFold). `hug` (D-79): a one-line pill (the working line,
 * the folded reply) is as wide as its line, within HUG_MIN..HUG_MAX, and springs as the line changes.
 * `highlight` (W-34): bumped by the host page's JunDesk.highlight(); the folded island lifts a little
 * and glows once (just the glow under reduced motion), with cuelume's `attention` when the call asked
 * for `sound` (and the desk's sound switch is on). Open, it's already in view: nothing happens.
 * `quiet`: the resting pill has nothing to say (no unread reply, no card waiting), so it may step
 * back: after IDLE_MS untouched it shrinks to its mark and "Ask" (pointing at it or focusing it
 * brings the whole pill back), and while the page scrolls down (`away`, from the loader's
 * `jun:away`) it slides below the edge, back once the scrolling pauses or turns up. Never under
 * reduced motion.
 * `spot`: where along the bottom it sits. The resting pill can be held and thrown: it follows the
 * pointer, and on release carries on a little at the speed it was let go (THROW_MS), then springs to
 * the nearest spot, which `onSpot` keeps. Every shape grows from there, inward from a side.
 */
export function Island({ state, live, onOpen, autoFold = null, hug = false, highlight = null, quiet = false, away = false, spot = "center", onSpot, children }: { state: IslandState; live: boolean; onOpen: () => void; autoFold?: (() => void) | null; hug?: boolean; highlight?: Highlight | null; quiet?: boolean; away?: boolean; spot?: IslandSpot; onSpot?: (spot: IslandSpot) => void; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  const folded = state === "rest" || state === "intro" || state === "nudge";
  const resting = state === "rest" && quiet;
  const [idle, setIdle] = useState(false);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    if (!highlight || !folded) return;
    setFlash(highlight.n);
    if (highlight.sound) playNow("attention");
    const timer = setTimeout(() => setFlash(0), FLASH_MS);
    return () => clearTimeout(timer);
    // Only a new call plays it, not the island folding later.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);
  const boxRef = useRef<HTMLDivElement>(null);
  useAutoFold(boxRef, autoFold);
  // The idle shrink: IDLE_MS after the pill was last pointed at or focused.
  useEffect(() => {
    const el = boxRef.current;
    setIdle(false);
    if (!resting || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const inUse = () => el.matches(":hover") || el.contains(document.activeElement);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (inUse() ? arm() : setIdle(true)), IDLE_MS);
    };
    const wake = () => {
      setIdle(false);
      arm();
    };
    arm();
    el.addEventListener("pointerenter", wake);
    el.addEventListener("pointerleave", arm);
    el.addEventListener("focusin", wake);
    return () => {
      clearTimeout(timer);
      el.removeEventListener("pointerenter", wake);
      el.removeEventListener("pointerleave", arm);
      el.removeEventListener("focusin", wake);
    };
  }, [resting]);
  const [dragX, setDragX] = useState<number | null>(null);
  const dragging = dragX !== null;
  const compact = resting && idle && !dragging;
  const hidden = resting && away && !dragging && !reducedMotion();
  // "/" opens the resting island from inside the frame too (after Escape the focus is still here;
  // the loader handles the key on the host page).
  useEffect(() => {
    if (state !== "rest" && state !== "intro" && state !== "nudge") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onOpen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state, onOpen]);
  const [measured, setMeasured] = useState(56);
  const [measuredW, setMeasuredW] = useState(HUG_MAX);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    // The first render read the loader's default frame (380px wide); the frame may have taken our
    // jun:css size before this listener existed, so read it again now.
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const hugMax = Math.min(HUG_MAX, viewport.w - 24);
  const w = compact ? COMPACT_W : hug ? Math.min(Math.max(measuredW, HUG_MIN), hugMax) : Math.min(WIDTHS[state], viewport.w - 24);
  // The panel fills what it's given; everything else is as tall as its content.
  const panelHeight = Math.max(240, Math.min(560, viewport.h - edge(viewport.w) - GLOW));
  useEffect(() => {
    const el = content.current;
    if (!el || state === "panel") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setMeasured(Math.ceil(r.height));
      if (hug) setMeasuredW(Math.ceil(r.width));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [state, hug]);
  // An answer grows to fit (a card and its sentence) up to 720px, leaving the top of the page in
  // view; the panel's height when the screen is short. Only taller answers scroll.
  const answerMax = Math.max(panelHeight, Math.min(720, viewport.h - edge(viewport.w) - GLOW - 48));
  const h = state === "panel" ? panelHeight : state === "answer" ? Math.min(measured, answerMax) : measured;
  const x = dragX ?? spotX(spot, w, viewport.w);
  useIslandFrame({ x, w, h }, live, hidden, dragging);
  // Hold and throw (the resting pill, on frames wide enough for the sides). A press that moves less
  // than DRAG_START_PX stays a click; after a drag the click that follows the release is swallowed.
  const drag = useRef<{ id: number; startX: number; baseX: number; moved: boolean; samples: [number, number][] } | null>(null);
  const draggable = state === "rest" && viewport.w >= SPOTS_MIN_W && Boolean(onSpot);
  const pointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggable || e.button !== 0) return;
    drag.current = { id: e.pointerId, startX: e.clientX, baseX: x, moved: false, samples: [[e.timeStamp, e.clientX]] };
  };
  const pointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_START_PX) return;
      d.moved = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId); // keeps the drag when the pointer leaves the clipped frame
      } catch {
        // a pointer that's already gone: the drag ends on its pointerup/cancel
      }
    }
    d.samples = [...d.samples.filter(([t]) => e.timeStamp - t < 100), [e.timeStamp, e.clientX]];
    const m = edge(viewport.w);
    setDragX(Math.min(Math.max(d.baseX + dx, m), viewport.w - w - m));
  };
  const pointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return;
    const [t0, x0] = d.samples[0]!;
    const speed = e.timeStamp > t0 ? (e.clientX - x0) / (e.timeStamp - t0) : 0;
    const landing = d.baseX + (e.clientX - d.startX) + speed * THROW_MS + w / 2;
    const spots: IslandSpot[] = ["left", "center", "right"];
    const gap = (s: IslandSpot) => Math.abs(spotX(s, w, viewport.w) + w / 2 - landing);
    const next = spots.reduce((best, s) => (gap(s) < gap(best) ? s : best));
    setDragX(null);
    onSpot?.(next);
    const box = e.currentTarget;
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    box.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => box.removeEventListener("click", swallow, { capture: true }), 0);
  };
  // An answer taller than the panel scrolls inside: fade its bottom edge while there's more below.
  useEffect(() => {
    if (state !== "answer") return;
    const body = content.current?.querySelector<HTMLElement>(".i-body");
    if (!body) return;
    const check = () => body.classList.toggle("i-more", body.scrollHeight - body.scrollTop - body.clientHeight > 4);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(body);
    if (body.firstElementChild) observer.observe(body.firstElementChild);
    body.addEventListener("scroll", check, { passive: true });
    return () => {
      observer.disconnect();
      body.removeEventListener("scroll", check);
    };
  }, [state]);
  return (
    <div className="i-root">
      {/* The box carries the size and its spring; the highlight's glow sits on it, outside the clipped shell. */}
      <div
        ref={boxRef}
        className={`i-box i-s-${state}${live ? " i-live" : ""}${hug ? " i-hug" : ""}${flash ? " i-flash" : ""}${compact ? " i-compact" : ""}${hidden ? " i-away" : ""}${dragging ? " i-drag" : ""}`}
        style={{ width: w, height: h, left: x }}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        {flash > 0 && <div key={flash} className="i-flash-glow" aria-hidden="true" />}
        <div className="i-shell" role="region" aria-label="Chat">
          <div key={state} className="i-view" ref={content} style={{ ...(hug && !compact ? { width: "max-content", minWidth: HUG_MIN, maxWidth: hugMax } : { width: w }), ...(state === "panel" ? { height: panelHeight } : state === "answer" ? { maxHeight: answerMax } : {}) }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The mark: the workspace logo, or the Jun agent mark (as the chat header), pulsing while the assistant works. */
export function Mark({ logoUrl, pulse = false }: { logoUrl: string | null; pulse?: boolean }) {
  return <img className={`i-mark${pulse ? " pulse" : ""}`} src={logoUrl ?? "/jun-agent.svg"} alt="" />;
}

/**
 * Resting: the mark, a hint that types out the suggested questions (or a new reply), and the "/" key;
 * an up arrow instead while a minimized chat is waiting to be opened again ("/" still opens it).
 * Folded with a chat, `summary` (its last answer in a few words) stands in for the typewriter; an
 * unread teammate reply still wins.
 */
export function RestPill({ logoUrl, suggestions, placeholder, unread, summary = null, chat = false, waiting = null, onOpen }: { logoUrl: string | null; suggestions: string[]; placeholder: string; unread: string | null; summary?: string | null; chat?: boolean; waiting?: string | null; onOpen: () => void }) {
  // D-80: a card still waiting on the visitor wins over the reply's summary: what it is, and a nudge.
  const line = unread ?? waiting ?? (chat ? summary : null);
  return (
    <button type="button" className={`i-rest${waiting && !unread ? " i-rest-wait" : ""}`} aria-label={unread ?? (waiting ? `Open: ${waiting}` : chat ? (summary ? `Open the chat: ${summary}` : "Open the chat") : "Ask this page anything")} onClick={onOpen}>
      <Mark logoUrl={logoUrl} pulse={Boolean(unread)} />
      {waiting && !unread && <span className="i-wait-dot" aria-hidden="true" />}
      {line ? <span className={`i-rest-text${unread || waiting ? "" : " i-rest-sum"}`}>{line}</span> : <Typewriter phrases={suggestions} fallback={placeholder} />}
      {/* Shown instead of the line while the idle pill is shrunk (.i-compact). */}
      <span className="i-rest-ask" aria-hidden="true">Ask</span>
      {chat ? <span className="i-up" aria-hidden="true">{chevron(CHEVRON_UP)}</span> : <kbd className="i-kbd" aria-hidden="true">/</kbd>}
    </button>
  );
}

/** Nudge: a one-line offer with an Ask button; ignored, it goes away on its own. */
export function NudgeLine({ logoUrl, text, from, onAsk, onDismiss }: { logoUrl: string | null; text: string; from: string | null; onAsk: () => void; onDismiss: () => void }) {
  return (
    <div className="i-nudge" role="dialog" aria-label="Need help?">
      <Mark logoUrl={logoUrl} />
      <span className="i-nudge-text">
        {from && <span className="i-nudge-from">{from} · </span>}
        {text}
      </span>
      <button type="button" className="i-ask" onClick={onAsk}>Ask</button>
      <button type="button" className="i-ghost i-x" data-cuelume-close data-cuelume-emphasis="subtle" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </div>
  );
}

/** Thinking: one specific line, the running tool step's label when there is one. */
export function StatusLine({ logoUrl, label, onOpen }: { logoUrl: string | null; label: string; onOpen?: () => void }) {
  // D-78: a run's line opens to its steps and the chat.
  if (onOpen) {
    return (
      <button type="button" className="i-status i-status-btn" data-cuelume-open data-cuelume-emphasis="subtle" aria-label={`${label} Show the steps`} onClick={onOpen}>
        <Mark logoUrl={logoUrl} pulse />
        <span className="i-status-text" role="status">{label}</span>
        <span className="i-up" aria-hidden="true">{chevron(CHEVRON_UP)}</span>
      </button>
    );
  }
  return (
    <div className="i-status" role="status">
      <Mark logoUrl={logoUrl} pulse />
      <span className="i-status-text">{label}</span>
    </div>
  );
}

const chevron = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
export const CHEVRON_DOWN = "M6 9l6 6 6-6";
export const CHEVRON_UP = "M6 15l6-6 6 6";

/**
 * The open island's corner: small, over the content (not a row of their own), shown on hover or
 * when tabbed to (always, but quiet, on touch screens). The down arrow folds it back to the pill
 * and keeps the chat (the pill's up arrow brings it back); × ends this chat: the next question
 * starts a new one (the old one stays in the visitor's list). An intent's chat ends through its
 * exit button (IslandTop), so there × only folds it.
 */
export function IslandControls({ onEnd, onMinimize }: {
  /** Ends this conversation (it stays in the visitor's list) and folds the island; null when × only folds it. */
  onEnd: (() => void) | null;
  onMinimize: () => void;
}) {
  return (
    <div className="i-ctl">
      <button type="button" className="i-ghost i-icon" aria-label="Minimize" title="Minimize" onClick={onMinimize}>
        {chevron(CHEVRON_DOWN)}
      </button>
      <button type="button" className="i-ghost i-icon" aria-label={onEnd ? "End chat" : "Close"} title={onEnd ? "End chat (start a new one next time)" : "Close"} onClick={onEnd ?? onMinimize}>
        {chevron("M7 7l10 10M17 7L7 17")}
      </button>
    </div>
  );
}

/**
 * The short row over the content, only when there's something for it: who's talking in a
 * teammate's chat ("Sam · Acme"), the Earlier / Latest switch, and an intent's exit button
 * (AI-20, D-37: always on screen, one click; never hover-only, never folded away by itself).
 */
export function IslandTop({ who, view, exit }: {
  who: string | null;
  view: { label: string; run: () => void } | null;
  exit: { label: string; run: () => void } | null;
}) {
  if (!who && !view && !exit) return null;
  return (
    <div className="i-top">
      {who && <span className="i-who">{who}</span>}
      {view && <button type="button" className="i-pill-chip" data-cuelume-open data-cuelume-emphasis="subtle" onClick={view.run}>{view.label}</button>}
      <span className="i-spacer" />
      {exit && <button type="button" className="i-exit" onClick={exit.run}>{exit.label}</button>}
    </div>
  );
}

/** The pill's row at the bottom of the open shapes: the mark and the question box, 44px like the resting pill. */
export function IslandRow({ logoUrl, pulse = false, children }: { logoUrl: string | null; pulse?: boolean; children: ReactNode }) {
  return (
    <div className="i-row">
      <Mark logoUrl={logoUrl} pulse={pulse} />
      {children}
    </div>
  );
}

/** Open: the suggested questions as chips over the question box. */
export function IslandChips({ questions, onPick }: { questions: string[]; onPick: (q: string) => void }) {
  if (questions.length === 0) return null;
  return (
    <div className="i-chips" role="group" aria-label="Suggested questions">
      {questions.map((q, i) => (
        <button key={q} type="button" className="i-chip" style={{ animationDelay: `${120 + i * 60}ms` }} onClick={() => onPick(q)}>{q}</button>
      ))}
    </div>
  );
}
