// AI-31: the page the MCP's previews are screenshotted from (preview_widget, preview_chat; the Worker's
// Browser Run binding loads it, worker/mcp/shot.ts). Built with the widget frame (Preact), public,
// and it shows only what its URL fragment carries: gzipped, base64url JSON (shared/shot.ts). A card is
// drawn by the widget's own WidgetCard; the chat is the real frame (/widget?preview=1&persist=0) fed
// the look the way the Appearance page feeds its draft. Sets <html data-ready> once it's drawn.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { BUTTON_TEXT, logoFor, textOn } from "../../shared/appearance.ts";
import { readShot, type Shot } from "../../shared/shot.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import "../styles.css";
import "./shot.css";

const ready = () => {
  // Fonts and the card's lazy icon sets settle first; the screenshot waits on this attribute.
  void document.fonts.ready.then(() => setTimeout(() => (document.documentElement.dataset.ready = ""), 300));
};

function CardShot({ shot }: { shot: Extract<Shot, { kind: "card" }> }) {
  useEffect(ready, []);
  return (
    <div className="shot shot-card">
      {/* Live, as customers see it (read-only greys the buttons); nothing clicks a screenshot. */}
      <WidgetCard widget={{ id: "preview", name: shot.name, root: shot.root }} interactive onAction={() => {}} theme={shot.theme} />
    </div>
  );
}

function ChatShot({ shot }: { shot: Extract<Shot, { kind: "chat" }> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [sized, setSized] = useState(false);
  const button = shot.look.launcher === "button";
  useEffect(() => {
    const post = (message: unknown) => frame.current?.contentWindow?.postMessage(message, window.location.origin);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; id?: string; css?: unknown } | null;
      if (data?.type === "jun:ready") {
        post({ type: "jun:preview", look: shot.look });
        // As widget-island.js on a website: an auto island turns light over a dark page (D-99).
        post({ type: "jun:backdrop", dark: shot.page === "dark" });
        post({ type: shot.open ? "jun:open" : "jun:close" });
        // The plain button's chat sizes itself only by CSS here; give the frame a moment to draw.
        if (button) setTimeout(() => (setSized(true), ready()), 1200);
      }
      if (data?.type === "jun:css" && frame.current) {
        frame.current.style.cssText = String(data.css ?? "");
        // The island centres itself, as on a website; the card is placed on a side there, centred here.
        if (shot.look.launcher !== "island") Object.assign(frame.current.style, { left: "50%", right: "auto", translate: "-50% 0" });        setSized(true);
        // The island and the card spring into place: wait for them to settle.
        setTimeout(ready, 1200);
      }
      if (data?.type === "jun:context-request") post({ type: "jun:context", id: data.id, context: undefined });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [shot, button]);
  // Chrome paints a transparent frame opaque when its colour scheme differs from the page's: match the
  // frame's (its theme; "auto" is light in the headless browser).
  useEffect(() => {
    document.documentElement.style.colorScheme = shot.look.theme === "dark" ? "dark" : "light";
  }, [shot]);
  const brand = { "--c": shot.look.color, "--t": textOn(shot.look.color) } as CSSProperties;
  // As the loader: on a dark button colour, the logo for dark backgrounds (W-21).
  const logo = logoFor(shot.look, textOn(shot.look.color) === "#ffffff");
  return (
    <div className={`shot shot-chat page-${shot.page} launcher-${shot.look.launcher}`} style={brand}>
      <iframe
        ref={frame}
        className={`shot-frame${sized ? " sized" : ""}${button && !shot.open ? " hidden" : ""}`}
        title="Chat"
        src={`/widget?key=${encodeURIComponent(shot.key)}&preview=1&persist=0`}
      />
      {button && !shot.open && (
        <span className={`shot-launcher${shot.look.buttonStyle === "text" ? " txt" : ""}`} aria-hidden="true">
          {shot.look.buttonStyle === "text" ? BUTTON_TEXT : logo ? <img src={logo} alt="" /> : null}
        </span>
      )}
    </div>
  );
}

function App() {
  const [shot, setShot] = useState<Shot | null | undefined>(undefined);
  useEffect(() => {
    readShot(window.location.hash.slice(1)).then(setShot, () => setShot(null));
  }, []);
  useEffect(() => {
    if (shot === null) ready();
    if (shot?.kind === "card") document.documentElement.dataset.theme = shot.theme;
  }, [shot]);
  if (shot === undefined) return null;
  if (shot === null) return <p className="shot-error">Nothing to show.</p>;
  return shot.kind === "card" ? <CardShot shot={shot} /> : <ChatShot shot={shot} />;
}

createRoot(document.getElementById("root")!).render(<App />);
