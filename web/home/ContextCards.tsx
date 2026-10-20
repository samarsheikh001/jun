import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { useState } from "react";
import type { StepPassages } from "../../shared/desk-assistant.ts";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { BookOpenIcon, ExternalLinkIcon, FileIcon, TextIcon } from "@/components/icons.tsx";
import { domainOf, excerpt } from "../lib/context-cards.ts";
import { DeskLink } from "./DeskLink.tsx";

// D-134, after beautifului.dev's Context Cards (patterns only): the knowledge passages a search found,
// one card each: where it's from (the site's favicon and domain, or the document's name), the page and
// heading, a few lines around the words that matched (marked), its size, and links to Knowledge and
// the page itself. Under the turn's steps, folding.

function SourceIcon({ kind, url }: { kind: string; url: string | null }) {
  const [failed, setFailed] = useState(false);
  const domain = domainOf(url);
  if (kind === "website" && domain && !failed) return <img src={`${new URL(url!).origin}/favicon.ico`} alt="" className="ctx-favicon" onError={() => setFailed(true)} />;
  return <span className="ctx-kind" aria-hidden="true">{kind === "snippet" ? <TextIcon /> : kind === "file" ? <FileIcon /> : <BookOpenIcon />}</span>;
}

export function ContextCards({ passages }: { passages: StepPassages }) {
  const [open, setOpen] = useState(true);
  const n = passages.hits.length;
  return (
    <div className="ctx">
      <button type="button" data-plain className="rec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rec-head-icon" aria-hidden="true"><BookOpenIcon /></span>
        <span>
          <span className="rec-num">{n}</span> knowledge passage{n === 1 ? "" : "s"}
        </span>
        <Chevron open={open} />
      </button>
      <Fold open={open}>
        <ScrollArea orientation="horizontal" className="ctx-scroll" viewportProps={{ tabIndex: -1, style: { scrollSnapType: "x mandatory", scrollPaddingInline: 2 } }}>
        <ul className="ctx-list">
          {passages.hits.map((h, i) => {
            const domain = domainOf(h.url);
            return (
              <li key={i} className="ctx-card" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="ctx-top">
                  <SourceIcon kind={h.kind} url={h.url} />
                  <span className="ctx-source">{h.kind === "website" && domain ? domain : h.source}</span>
                  <span className="ctx-size rec-num" title="Characters in this passage">{h.text.length.toLocaleString()} chars</span>
                </div>
                <p className="ctx-title">
                  {h.title}
                  {h.heading && h.heading !== h.title && <span className="ctx-heading"> · {h.heading}</span>}
                </p>
                <p className="ctx-text">
                  {excerpt(h.text, passages.query).map((part, j) => (part.match ? <mark key={j}>{part.text}</mark> : <span key={j}>{part.text}</span>))}
                </p>
                <div className="ctx-links">
                  <DeskLink href="/knowledge" className="ctx-link">Knowledge</DeskLink>
                  {h.url && /^https?:\/\//.test(h.url) && (
                    <a className="ctx-link" href={h.url} target="_blank" rel="noreferrer noopener">
                      Open page <ExternalLinkIcon />
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        </ScrollArea>
      </Fold>
    </div>
  );
}
