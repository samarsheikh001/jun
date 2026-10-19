import type { ReactNode } from "react";
import { deskHref, navigate } from "../lib/router.ts";

/** A desk link in the assistant's pane: a real href (new tabs keep the workspace), in-app on a plain click. */
export function DeskLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  return (
    <a
      className={className}
      href={deskHref(href)}
      title={title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(href);
      }}
    >
      {children}
    </a>
  );
}
