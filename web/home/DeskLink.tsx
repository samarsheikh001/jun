import type { AnchorHTMLAttributes } from "react";
import { deskHref, navigate } from "../lib/router.ts";

/** A desk link in the assistant's pane: a real href (new tabs keep the workspace), in-app on a plain click. */
export function DeskLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      {...rest}
      href={deskHref(href)}
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
