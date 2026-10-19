import { useEffect, useRef, type ReactNode } from "react";
import { CheckIcon, XIcon } from "@/components/icons.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "cn";

// D-129: a change an AI proposes, waiting on a person's yes. After beautifului.dev's Approval Card
// and Recommendation Card (patterns and measures, our own code and tokens): the question as the
// heading, what changes and where as entity chips, then a footer with Cancel / Confirm pills. Enter
// confirms and Escape cancels while focus is in the card; it takes focus when it arrives (`autoFocus`).
// Once settled it shrinks to one pill: done (a green tick), cancelled or failed.

export function ApprovalCard({
  icon,
  title,
  children,
  confirmLabel = "Confirm",
  running = false,
  disabled = false,
  autoFocus = false,
  onConfirm,
  onCancel,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  running?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) confirm.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const off = running || disabled;
  return (
    <div
      className="approval-card"
      role="group"
      aria-label={title}
      onKeyDown={(e) => {
        if (off || e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      <div className="approval-body">
        <p className="approval-title">
          {icon && <span className="approval-icon" aria-hidden="true">{icon}</span>}
          <span>{title}</span>
        </p>
        {children}
      </div>
      <div className="approval-foot">
        <span className="approval-keys" aria-hidden="true">
          <kbd>↵</kbd> confirm <kbd>Esc</kbd> cancel
        </span>
        <div className="approval-actions">
          <Button size="sm" variant="ghost" disabled={off} onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirm} size="sm" disabled={off} onClick={onConfirm}>
            {running ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A settled card: one pill. */
export function ApprovalOutcome({ status, children, className }: { status: "done" | "cancelled" | "failed"; children: ReactNode; className?: string }) {
  return (
    <p className={cn("approval-outcome", status, className)} role="status">
      <span className="approval-outcome-mark" aria-hidden="true">
        {status === "done" ? <CheckIcon size={11} strokeWidth={3} /> : <XIcon size={11} strokeWidth={3} />}
      </span>
      <span className="approval-outcome-text">{children}</span>
    </p>
  );
}
