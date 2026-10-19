import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons.tsx";
import { PixelLoader } from "@/components/PixelLoader.tsx";
import { cn } from "cn";

// D-129: the desk's one way of showing an AI's tool calls (the inbox's AI steps and Home's desk
// assistant). After beautifului.dev's Thinking and Tool Chips primitives (patterns and measures,
// our own code and tokens): a header that is a live working line (pixel grid, shimmering label,
// elapsed time) while it runs and "N steps" once it's done, folding a trace of rows on a thin guide
// line; each row is its kind's icon (a spinner while it runs; a chevron on hover when it opens), a
// short title, a compact mono chip and a status, and opens to its inputs and result. The same model
// as the widget's step rows (`web/widget/answer.tsx`: state icon, title, chip, open for details),
// which keep their own CSS for the widget's size budget.

export interface TraceDetail {
  label: string;
  text: string;
  /** Monospace block (JSON, inputs) rather than a sentence. */
  mono?: boolean;
  error?: boolean;
}

export interface TraceStep {
  id: string;
  title: string;
  /** The kind's icon (search, read, report…); a spinner replaces it while the step runs. */
  icon?: ReactNode;
  /** One short line in a mono chip: the query, the inputs, or what came back. */
  chip?: string;
  status: "running" | "done" | "error";
  /** Trailing text ("ok", "failed 500"); errors default to "failed". */
  statusText?: string;
  /** What opening the row shows. A row with none doesn't open. */
  details?: TraceDetail[];
  /** A last mono line in the open row (HTTP status · time · version). */
  meta?: string;
}

/** Grid-rows 0fr → 1fr: animates to the content's own height; hidden content can't take focus. */
export function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      inert={!open}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return <ChevronDownIcon size={12} className={cn("transition-transform duration-200 motion-reduce:transition-none", !open && "-rotate-90", className)} />;
}

const pre = "m-0 max-h-40 overflow-auto rounded-sm bg-muted px-2 py-1.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-words text-foreground shadow-xs";

export function StepRow({ step }: { step: TraceStep }) {
  const more = Boolean(step.details?.length || step.meta);
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  const failed = step.status === "error";
  const status = step.statusText ?? (failed ? "failed" : null);
  return (
    <li className="step-row-in">
      <button
        type="button"
        data-plain
        aria-expanded={more ? open : undefined}
        disabled={!more}
        onClick={() => setOpen((o) => !o)}
        className="group/row -mx-[3px] flex min-h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-md px-[3px] text-left transition-colors duration-100 enabled:hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
      >
        <span className={cn("relative flex size-4 shrink-0 items-center justify-center", failed ? "text-destructive" : "text-muted-foreground")}>
          {running ? (
            <span className="step-spin" role="img" aria-label="In progress" />
          ) : (
            <>
              <span className={cn("flex [&>svg]:size-[13px]", more && "transition-opacity duration-100 group-hover/row:opacity-0 group-focus-visible/row:opacity-0", more && open && "opacity-0")} role="img" aria-label={failed ? "Failed" : "Done"}>
                {step.icon}
              </span>
              {more && <Chevron open={open} className={cn("absolute transition-[opacity,transform] group-hover/row:opacity-100 group-focus-visible/row:opacity-100", open ? "opacity-100" : "opacity-0")} />}
            </>
          )}
        </span>
        <span className={cn("min-w-0 shrink truncate text-[12.5px] font-medium", running ? "step-shimmer" : "text-foreground")}>{step.title}</span>
        {step.chip && (
          <span className="inline-flex h-5.5 min-w-0 flex-1 items-center rounded-md bg-muted px-1.5 shadow-xs">
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">{step.chip}</span>
          </span>
        )}
        {!step.chip && <span className="flex-1" />}
        {status && <span className={cn("shrink-0 text-[11.5px] tabular-nums", failed ? "text-destructive" : "text-muted-foreground")}>{status}</span>}
      </button>
      {more && (
        <Fold open={open}>
          <div className="mt-0.5 mb-1 ml-2 grid gap-2 border-l border-border py-1 pl-3.5">
            {step.details?.map((d) => (
              <div key={d.label} className="grid gap-0.5">
                <span className="text-[11px] text-muted-foreground">{d.label}</span>
                {d.mono ? (
                  // Scrolls with the keyboard too, so it's a tab stop only while open.
                  <pre className={cn(pre, d.error && "text-destructive")} tabIndex={0}>{d.text}</pre>
                ) : (
                  <span className={cn("text-[12.5px] leading-[1.5]", d.error ? "text-destructive" : "text-foreground")}>{d.text}</span>
                )}
              </div>
            ))}
            {step.meta && <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{step.meta}</span>}
          </div>
        </Fold>
      )}
    </li>
  );
}

/**
 * Tool calls folded under one header. While `working`, the header is the live line (`working`'s
 * label, timed from `since`) and the trace is open; once done it folds to `header` unless the
 * reader opened or closed it themselves.
 */
export function StepTrace({
  steps,
  header,
  working,
  since,
  defaultOpen = false,
  className,
}: {
  steps: TraceStep[];
  header: ReactNode;
  /** The live line's label while the work goes on ("Searching conversations…"). */
  working?: string | null;
  since?: number;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const live = Boolean(working);
  const open = chosen ?? (live || defaultOpen);
  // A new run starts from the automatic state again.
  useEffect(() => {
    if (live) setChosen(null);
  }, [live]);
  if (!steps.length && !live) return null;
  return (
    <div className={cn("step-trace w-full min-w-0", className)}>
      <button
        type="button"
        data-plain
        aria-expanded={steps.length ? open : undefined}
        disabled={!steps.length}
        onClick={() => setChosen(!open)}
        className="-mx-1.5 flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground transition-colors duration-100 enabled:hover:bg-accent enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-default"
      >
        {live ? (
          <span role="status" className="min-w-0 text-foreground">
            <PixelLoader label={working!} since={since} />
          </span>
        ) : (
          <span className="min-w-0 truncate tabular-nums">{header}</span>
        )}
        {steps.length > 0 && <Chevron open={open} className="shrink-0" />}
      </button>
      {steps.length > 0 && (
        <Fold open={open}>
          <ul className="relative m-0 mt-0.5 ml-[7px] flex list-none flex-col gap-0.5 border-l border-border py-0.5 pr-1 pl-3">
            {steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </ul>
        </Fold>
      )}
    </div>
  );
}
