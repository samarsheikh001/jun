/**
 * AI-32: what page control is about to do, shown on the customer's page itself. While a step waits for
 * the visitor's Confirm, a ring in the brand colour sits around the element with a chip saying what
 * will happen ("Click", "Type “Acme”"); when it runs, a pointer glides there and clicks (a ripple),
 * then it all fades. One fixed, click-through layer in its own shadow root, marked private so a
 * read never sees it; nothing on the page itself is changed. Reduced motion: no glide or ripple.
 */

const Z = 2147482999; // just under the widget's frame
const CSS = `
:host{all:initial}
.l{position:fixed;inset:0;pointer-events:none;z-index:${Z}}
.r{position:fixed;box-sizing:border-box;border:2px solid var(--c);border-radius:10px;box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 22%,transparent),0 6px 24px rgba(0,0,0,.12);opacity:0;transition:opacity .2s,top .25s cubic-bezier(.2,.8,.2,1),left .25s cubic-bezier(.2,.8,.2,1),width .25s cubic-bezier(.2,.8,.2,1),height .25s cubic-bezier(.2,.8,.2,1)}
.r.on{opacity:1}
.r.wait{animation:p 1.6s ease-in-out infinite}
@keyframes p{50%{box-shadow:0 0 0 7px color-mix(in srgb,var(--c) 14%,transparent),0 6px 24px rgba(0,0,0,.12)}}
.t{position:absolute;left:-2px;bottom:calc(100% + 8px);max-width:min(320px,80vw);padding:4px 10px;border-radius:999px;background:var(--c);color:var(--t);font:600 12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.r.below .t{bottom:auto;top:calc(100% + 8px)}
.m{position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;transition:opacity .2s;filter:drop-shadow(0 2px 3px rgba(0,0,0,.3))}
.m.on{opacity:1}
.m.go{transition:opacity .2s,transform .55s cubic-bezier(.2,.8,.2,1)}
.k{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid var(--c);opacity:0}
.k.on{animation:k .45s ease-out}
@keyframes k{from{opacity:.9;transform:scale(.3)}to{opacity:0;transform:scale(1.6)}}
@media (prefers-reduced-motion:reduce){.r,.m.go{transition:opacity .2s}.r.wait,.k.on{animation:none}}
`;
const ARROW = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2.5 19.5 12l-7 1.6-3.6 6.6z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

export interface Pointer {
  /** Ring the element with a chip saying what will happen; null hides it (unless a step is running). */
  show(el: Element | null, chip?: string): void;
  /** The step runs now: ring, pointer glides there and clicks, `act` runs, then it all fades. */
  act<T>(el: Element, chip: string, act: () => Promise<T>): Promise<T>;
}

export function createPointer(): Pointer {
  let host: HTMLElement | null = null;
  let ring: HTMLElement, tag: HTMLElement, mouse: HTMLElement, ripple: HTMLElement;
  let target: Element | null = null;
  let frame = 0;
  let acting = false;
  let hideTimer = 0;
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function mount(): void {
    if (host?.isConnected) return;
    host = document.createElement("div");
    // Private: a read never sees it (PRIVATE_SELECTOR), so the AI can't be shown its own highlight.
    host.setAttribute("data-jun-private", "");
    host.setAttribute("aria-hidden", "true");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style><div class="l"><div class="r"><div class="t"></div></div><div class="m">${ARROW}</div><div class="k"></div></div>`;
    ring = root.querySelector(".r")!;
    tag = root.querySelector(".t")!;
    mouse = root.querySelector(".m")!;
    ripple = root.querySelector(".k")!;
    document.documentElement.appendChild(host);
  }

  /** The widget's colours (its loader keeps them on its own element), so the ring matches the brand. */
  function colours(): void {
    const w = document.querySelector("[data-jun-desk]")?.shadowRoot?.querySelector(".w");
    const s = w ? getComputedStyle(w) : null;
    host!.style.setProperty("--c", s?.getPropertyValue("--c").trim() || "#2f5bea");
    host!.style.setProperty("--t", s?.getPropertyValue("--t").trim() || "#fff");
  }

  /** Follows the element while the page scrolls or moves; stops when it's gone. */
  function track(): void {
    cancelAnimationFrame(frame);
    const step = () => {
      if (!target?.isConnected) return hide(true);
      const r = target.getBoundingClientRect();
      const pad = 4;
      const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`, borderRadius: `${Math.min(radius + pad, 24)}px` });
      ring.classList.toggle("below", r.top < 40);
      frame = requestAnimationFrame(step);
    };
    step();
  }

  function ringOn(el: Element, chip: string, waiting: boolean): void {
    mount();
    colours();
    clearTimeout(hideTimer);
    target = el;
    tag.textContent = chip;
    ring.classList.toggle("wait", waiting);
    const r = el.getBoundingClientRect();
    const behavior = still() ? "auto" : "smooth";
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) el.scrollIntoView({ block: "center", behavior });
    else {
      // Under the open chat (the island's card, the window): scroll it up to the top part of the screen.
      // What's on top at its centre says so (the frame's clip-path leaves the rest of its box click-through).
      const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1));
      if (hit?.closest("[data-jun-desk]")) window.scrollBy({ top: r.top - innerHeight * 0.25, behavior });
    }
    track();
    requestAnimationFrame(() => ring.classList.add("on"));
  }

  function hide(now = false): void {
    if (!host) return;
    const go = () => {
      cancelAnimationFrame(frame);
      target = null;
      ring.classList.remove("on", "wait");
      mouse.classList.remove("on");
    };
    clearTimeout(hideTimer);
    if (now) go();
    else hideTimer = window.setTimeout(go, 700);
  }

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    show(el, chip = "") {
      if (acting) return;
      if (el) ringOn(el, chip, true);
      else hide(true);
    },
    async act(el, chip, run) {
      acting = true;
      try {
        ringOn(el, chip, false);
        const r = el.getBoundingClientRect();
        const x = Math.min(r.left + Math.min(r.width / 2, 40), innerWidth - 24);
        const y = Math.min(r.top + r.height / 2, innerHeight - 24);
        if (!still()) {
          // From where the chat is (the island's centre, the window's corner) to the element.
          const chat = document.querySelector("[data-jun-desk]")?.shadowRoot?.querySelector("iframe")?.getBoundingClientRect();
          const from = chat && chat.width > 0 ? { x: chat.left + chat.width / 2, y: Math.max(chat.top + 24, 24) } : { x: innerWidth - 60, y: innerHeight - 60 };
          mouse.classList.remove("go");
          mouse.style.transform = `translate(${from.x}px, ${from.y}px)`;
          mouse.classList.add("on");
          await wait(20);
          mouse.classList.add("go");
          mouse.style.transform = `translate(${x}px, ${y}px)`;
          await wait(560);
          Object.assign(ripple.style, { left: `${x}px`, top: `${y}px` });
          ripple.classList.remove("on");
          void ripple.offsetWidth;
          ripple.classList.add("on");
          await wait(120);
        }
        return await run();
      } finally {
        acting = false;
        hide();
      }
    },
  };
}
