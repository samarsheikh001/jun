import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";

// W-04 the chat window's greeting card (D-34, D-89: mode `window` with `greetingCard` on, the
// `card` launcher internally): the closed state of the earlier Jun widget, a welcome card (its
// `.mini`) or, once dismissed, a "Chat with us" pill, drawn by the frame itself. Styles: `.w-mini*`
// in widget.css.
//
// D-90: the frame never resizes between the card and the chat. Like the island's (island.tsx), it
// is always the open chat's box (plus room for the shadow) and transparent; closed, `jun:css` clips
// it to the card or the pill, so the page around stays clickable. Inside, the card and the chat
// are one surface (`.w-edge`: the same background, hairline and shadow in both) that morphs from
// one to the other with a view transition (`morph`): what both show (the composer, "Built with
// Jun") stays put, what differs (header, welcome, the two buttons) moves and restyles.

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Room around the surface for its shadow, inside the frame (none on phones, where the chat fills the screen). */
export const SHADOW_ROOM = 40;

// The loader's panel rules, as one inline style the host page evaluates (its viewport, not ours):
// on phones (≤ 768px) the chat fills the screen; otherwise it's 22px from the corner,
// min(380, max(300, viewport × .32)) wide and 540px tall (740px expanded), and the frame adds
// SHADOW_ROOM on every side. `phone` is a large positive length on phones and a large negative one
// otherwise, which min() and max() turn into the choice; `desktop(n)` is n off phones, else 0.
const phone = "(769px - 100vw) * 1000";
const desktop = (px: number) => `max(0px, min(${px}px, (100vw - 768px) * 1000))`;
const room = desktop(SHADOW_ROOM);
const corner = desktop(22);
const panelWidth = "min(380px, max(300px, 32vw))";
const panelHeight = (grown: boolean) => `min(${grown ? 740 : 540}px, 100dvh - 44px)`;
/** The plain button's open panel when expanded (phones stay full screen). */
const grownHeight = `max(min(740px, 100dvh - 44px), min(100dvh, ${phone}))`;

/**
 * Whether the host laid the frame out for a phone (full screen), from inside it: the top window's
 * width (an iframe's outerWidth is the browser window's), or a frame wider than a desktop panel can be.
 */
const isPhone = () => window.outerWidth <= 768 || window.innerWidth > 380 + 2 * SHADOW_ROOM;
export function usePhoneFrame(): boolean {
  const [phoneNow, setPhone] = useState(isPhone);
  useEffect(() => {
    const check = () => setPhone(isPhone());
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return phoneNow;
}

/**
 * Sizes the frame. The plain button's chat: the loader's own panel rules (380×540 at the corner,
 * full screen on phones), 740px tall when expanded. The greeting card's (D-90): always the panel
 * plus SHADOW_ROOM, clipped while closed to the card or the pill (`.w-mini`, `.w-launcher`) and its
 * shadow; open, or while a morph between the two runs (`hold`), unclipped.
 */
export function useCardFrame({ card, side, open, grown, closed, pill, scheme, hold }: {
  card: boolean;
  side: "left" | "right";
  open: boolean;
  grown: boolean;
  closed: RefObject<HTMLElement | null>;
  pill: boolean;
  /** The page's color-scheme: the frame's must match, or the browser paints the frame's canvas opaque. */
  scheme: string;
  hold: boolean;
}): void {
  // Before paint: the frame must be right before the chat or the card is drawn in it.
  useLayoutEffect(() => {
    if (!card) {
      if (open) postToHost({ type: "jun:css", css: `display:block${grown ? `;height:${grownHeight}` : ""}` });
      return;
    }
    const other = side === "left" ? "right" : "left";
    const frame =
      `display:block;top:auto;bottom:calc(${corner} - ${room});${side}:calc(${corner} - ${room});${other}:auto;` +
      `width:max(${panelWidth} + 2 * ${room}, min(100%, ${phone}));height:max(${panelHeight(grown)} + 2 * ${room}, min(100dvh, ${phone}));` +
      `border:0;border-radius:0;background:none;box-shadow:none;color-scheme:${scheme};animation:none;`;
    if (open || hold) {
      postToHost({ type: "jun:css", css: `${frame}clip-path:inset(0)` });
      return;
    }
    const el = closed.current?.querySelector<HTMLElement>(".w-mini, .w-launcher");
    if (!el) return;
    let last = "";
    const measure = () => {
      const r = el.getBoundingClientRect();
      const w = window.innerWidth;
      const h = window.innerHeight;
      const g = SHADOW_ROOM;
      const [right, bottom, left] = [w - r.right - g, h - r.bottom - g, r.left - g].map((n) => Math.max(0, Math.floor(n)));
      // Rounded like the card where the clip is inside the frame; square where it meets the frame's edge.
      const round = Math.round((parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0) + g);
      const corners = [left, right, bottom && right, bottom && left].map((n) => (n ? `${round}px` : "0")).join(" ");
      // The top from the bottom, so the card stays covered while the frame's height changes.
      const css = `${frame}clip-path:inset(calc(100% - ${Math.ceil(h - r.top + g)}px) ${right}px ${bottom}px ${left}px round ${corners})`;
      if (css !== last) postToHost({ type: "jun:css", css: (last = css) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [card, side, open, grown, closed, pill, scheme, hold]);
}

/** D-90: the morph's length and curve (the view transition's, in widget.css). */
export const MORPH_MS = 400;

/**
 * Switches between the card and the chat (`update` sets the state) as a view transition inside
 * the frame: the shared parts carry the same `view-transition-name` (widget.css, `html.mini`).
 * Without view transitions, or with reduced motion, it switches at once. Resolves when it's done.
 */
export function morph(update: () => void, opts: { opening: boolean; phone: boolean }): Promise<void> {
  if (typeof document.startViewTransition !== "function" || reducedMotion()) {
    update();
    return Promise.resolve();
  }
  const transition = document.startViewTransition(async () => {
    flushSync(update);
    // Preact (the built widget) commits on a microtask: wait for it, so the new state is captured.
    await new Promise((resolve) => setTimeout(resolve));
  });
  // On phones the chat fills the screen square: the surface's corners straighten as it grows.
  if (opts.phone) {
    transition.ready
      .then(() => {
        const ends = ["var(--radius)", "0px"];
        document.documentElement.animate(
          { borderRadius: opts.opening ? ends : ends.reverse() },
          { duration: MORPH_MS, easing: "cubic-bezier(.2, .8, .2, 1)", fill: "forwards", pseudoElement: "::view-transition-group(jun-surface)" },
        );
      })
      .catch(() => {});
  }
  return transition.finished.catch(() => {});
}

/** The closed welcome card: name and reply time, the welcome, two actions and a message box that opens the chat. */
export function MiniCard({
  name,
  sub,
  logoUrl,
  welcome,
  placeholder,
  onOpen,
  onContact,
  onNewChat,
  onHide,
  icon,
}: {
  name: string;
  sub: string;
  logoUrl: string | null;
  welcome: string;
  placeholder: string;
  onOpen: () => void;
  onContact: () => void;
  onNewChat: () => void;
  onHide: () => void;
  icon: (d: string) => ReactNode;
}) {
  return (
    <div
      className="w-mini"
      role="button"
      tabIndex={0}
      aria-label="Open chat"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, a")) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={`w-mini-head ${logoUrl ? "has-logo" : ""}`}>
        {logoUrl && <img className="w-mini-logo" src={logoUrl} alt={name} />}
        <span className="w-mini-name">{name}</span>
        <span className="w-mini-sub">{sub}</span>
        <button className="w-mini-x" aria-label="Hide until the next page" title="Hide" onClick={onHide}>{icon("M6 6l12 12M18 6L6 18")}</button>
      </div>
      <p className="w-mini-welcome">{welcome}</p>
      <div className="w-mini-actions">
        <button className="w-mini-act" onClick={onContact}>Contact the team</button>
        <button className="w-mini-act" onClick={onNewChat}>Start a new chat</button>
      </div>
      {/* The open chat's composer as a picture (same "+", placeholder and empty Send): one look closed and open. */}
      <button className="w-mini-composer" onClick={onOpen}>
        <span className="w-mini-plus">{icon("M12 5v14M5 12h14")}</span>
        <span className="w-mini-ph">{placeholder}</span>
        <span className="w-mini-send">{icon("M12 19V5M5 12l7-7 7 7")}</span>
      </button>
      <Badge mini />
    </div>
  );
}

/** "Built with Jun", under the card and the chat (the reference's footer badge, not a link here). */
export function Badge({ mini = false }: { mini?: boolean }) {
  return (
    <span className={`w-badge ${mini ? "mini" : ""}`}>
      <img className="w-badge-logo" src="/jun-agent.svg" alt="" />
      <span>Built with Jun</span>
    </span>
  );
}
