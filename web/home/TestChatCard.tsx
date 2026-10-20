import { useState } from "react";
import type { StepChat } from "../../shared/desk-assistant.ts";
import { parseMarkdown } from "../../shared/markdown.ts";
import { Chevron, Fold } from "@/components/agent-steps.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { ChatIcon, ToolIcon, ColumnsIcon } from "@/components/icons.tsx";
import { cn } from "cn";

// D-144: what the assistant's test_chat found, under the turn: the customer's messages and the support
// agent's replies as small bubbles, each reply's actions and cards as compact chips above it ("pretended"
// on a POST that wasn't made), a handoff as a note, and the whole card folds. Nothing here was stored.

export function TestChatCard({ chat }: { chat: StepChat }) {
  const [open, setOpen] = useState(true);
  const n = chat.exchanges.length;
  const pretended = chat.exchanges.some((e) => e.actions.some((a) => a.pretended));
  return (
    <div className="rec">
      <button type="button" data-plain className="rec-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="rec-head-icon" aria-hidden="true"><ChatIcon /></span>
        <span>
          Test chat · <span className="rec-num">{n}</span> {n === 1 ? "reply" : "replies"}
          {chat.draft && <> · with your draft of <code className="ask-tc-file">{chat.draft}</code></>}
        </span>
        <Chevron open={open} />
      </button>
      <Fold open={open}>
        <div className="ask-tc">
          {chat.exchanges.map((e, i) => (
            <div key={i} className="ask-tc-pair">
              <p className="ask-tc-msg customer" aria-label="Customer">{e.customer}</p>
              <div className="ask-tc-msg agent" aria-label="Support agent">
                {(e.actions.length > 0 || e.cards.length > 0 || e.websiteAction) && (
                  <div className="ask-tc-chips">
                    {e.actions.map((a, j) => (
                      <span key={`a${j}`} className={cn("ask-tc-chip", a.status === "error" && "error")} title={a.pretended ? "A POST action: answered without being made" : a.status === "error" ? "The call failed" : "Ran for real (a look-up)"}>
                        <ToolIcon aria-hidden="true" />
                        {a.tool}
                        {a.pretended && <em>pretended</em>}
                      </span>
                    ))}
                    {e.cards.map((c, j) => (
                      <span key={`c${j}`} className="ask-tc-chip" title="A card shown to the customer">
                        <ColumnsIcon aria-hidden="true" />
                        {c}
                      </span>
                    ))}
                    {e.websiteAction && (
                      <span className="ask-tc-chip" title="A website action the customer would confirm">
                        <ToolIcon aria-hidden="true" />
                        {e.websiteAction}
                        <em>on the page</em>
                      </span>
                    )}
                  </div>
                )}
                {e.reply && <div className="tchat-text"><Markdown blocks={parseMarkdown(e.reply)} cite={(k) => `[${k}]`} /></div>}
                {e.escalate && <p className="tchat-note">Flags a problem for the engineers: {e.escalate}</p>}
                {e.handoff !== undefined && <p className="tchat-note tchat-handoff">Hands the chat to a person: {e.handoff}</p>}
                {e.sources?.length ? <p className="tchat-sources">From {e.sources.join(", ")}</p> : null}
              </div>
            </div>
          ))}
          <p className="ask-tc-foot">{pretended ? "Changes made by POST actions were only pretended: nothing was changed." : "A test: nothing was stored or sent to anyone."}</p>
        </div>
      </Fold>
    </div>
  );
}
