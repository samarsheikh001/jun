import type { MouseEvent, ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { deskHref, navigate } from "../lib/router.ts";

// D-124 / D-126: the right-hand sheet of chats a struggle card or a handoff reason opens. Each row
// links to the chat in the inbox; `aside` is the row's own details (icons, pills).

export interface SheetChat {
  id: string;
  createdAt: number | null;
  aside?: ReactNode;
}

const goTo = (path: string) => (e: MouseEvent) => {
  e.preventDefault();
  navigate(path);
};

/** `total`: how many chats the list covers (the lists are capped); `action`: a next step under the header. */
export function ChatsSheet({ open, onClose, title, titleClassName, description, action, chats, total }: {
  open: boolean;
  onClose: () => void;
  title: string;
  titleClassName?: string;
  description: string;
  action?: ReactNode;
  chats: SheetChat[];
  total: number;
}) {
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="st-sheet">
        <SheetHeader>
          <SheetTitle className={titleClassName}>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
          {action && <div className="st-sheet-action">{action}</div>}
        </SheetHeader>
        <ScrollArea className="topics-sheet-body">
          <ul className="st-chats">
            {chats.map((c) => (
              <li key={c.id}>
                <a href={deskHref(`/inbox/${c.id}`)} onClick={goTo(`/inbox/${c.id}`)}>
                  <span className="st-chat-when">
                    {c.createdAt === null ? "Chat" : new Date(c.createdAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </span>
                  {c.aside}
                </a>
              </li>
            ))}
          </ul>
          {total > chats.length && <p className="dash-foot st-chats-foot">Showing the newest {chats.length} of {total}.</p>}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
