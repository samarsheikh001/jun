import { useEffect, useRef, type ReactNode } from "react";
import { CheckIcon, XIcon } from "@/components/icons.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "cn";

// D-129: a change an AI proposes, waiting on a person's yes. After beautifului.dev's Approval Card
// and Recommendation Card (patterns and measures, our own code and tokens): the question as the
// heading, what changes and where as entity chips, then a footer with Cancel / Confirm pills. Enter
// confirms and Escape cancels while focus is in the card; it takes focus when it arrives (`autoFocus`).
// Once settled it shrinks to one pill: done (a green tick), cancelled or failed. D-133: a `tone` card
// (destructive: can't be undone; external: reaches someone outside the team) is red with its `warning`
// line, focuses Cancel and never confirms on Enter: only a click, or Tab to the button and Enter.

export function ApprovalCard({
  icon,
  title,
  children,
  confirmLabel = "Confirm",
  running = false,
  disabled = false,
  autoFocus = false,
  tone,
  warning,
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
  tone?: "destructive" | "external";
  warning?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) (tone ? cancel : confirm).current?.focus({ preventScroll: true });
  }, [autoFocus, tone]);
  const off = running || disabled;
  return (
    <div
      className={cn("approval-card", tone && `risky ${tone}`)}
      role="group"
      aria-label={title}
      onKeyDown={(e) => {
        if (off || e.nativeEvent.isComposing) return;
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (!tone && e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
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
        {warning && <p className="approval-warning">{warning}</p>}
      </div>
      <div className="approval-foot">
        <span className="approval-keys" aria-hidden="true">
          {tone ? <><kbd>Esc</kbd> cancel</> : <><kbd>↵</kbd> confirm <kbd>Esc</kbd> cancel</>}
        </span>
        <div className="approval-actions">
          <Button ref={cancel} size="sm" variant="ghost" disabled={off} onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirm} size="sm" variant={tone ? "destructive" : "default"} disabled={off} onClick={onConfirm}>
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
