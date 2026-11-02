// The assistant panel (I-19, D-158): what's on screen, as the reference the next question carries
// (`@chat:cv_1`, `@contact:ct_1`, `@file:tasks/refunds.md`). Pure: the panel adds names it loads.

import type { MentionOption } from "./ask-mentions.ts";

/** The page's subject for a desk path (without the /w/<slug> prefix), or null when it has none. */
export function pageContext(path: string): MentionOption | null {
  const parts = path.split("?")[0]!.replace(/\/+$/, "").split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  const [section, a, b] = parts;
  if (section === "inbox" && a && !b) return { kind: "chat", id: a, label: "" };
  if (section === "contacts" && a && a !== "companies" && !b) return { kind: "contact", id: a, label: "" };
  if (section === "agent") {
    if (!a) return file("instructions.md");
    if (a === "desk.yaml" && !b) return file("desk.yaml");
    if (!b || !/^[\w.-]+$/.test(b)) return null;
    if (a === "tasks") return file(`tasks/${b}.md`);
    if (a === "actions") return file(`actions/${b}.yaml`);
    if (a === "widgets") return file(`widgets/${b}.widget`);
  }
  return null;
}

const file = (id: string): MentionOption => ({ kind: "file", id, label: id });

/** The chip's words: the name once known, else what the page is. */
export function contextLabel(o: MentionOption): string {
  if (o.label) return o.label;
  return o.kind === "chat" ? "This chat" : o.kind === "contact" ? "This person" : o.id;
}
