import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { FieldError } from "@/components/ui/field.tsx";
import { openDeskFile } from "../components/DeskFileNote.tsx";
import { DESK_FILE } from "../agent/parts.tsx";
import type { AgentState, Issue } from "../agent/useAgentConfig.ts";
import { deskHref } from "../lib/router.ts";

// D-84: the Chat widget page in Code: desk.yaml, the desk's settings as a file (the widget's look
// and the rest: AI switches, hours, assignment). Saved like the Agent page saves, as a new version of
// the agent's files, which applies what changed; the Form then shows the applied settings.

export function DeskCode({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/agent`;
  const [state, setState] = useState<AgentState | null>(null);
  const [text, setText] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await api<AgentState>(base);
    setState(next);
    setText(next.files[DESK_FILE] ?? "");
    setIssues(next.issues.filter((i) => i.path === DESK_FILE));
    setConflict(null);
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const saved = state?.files[DESK_FILE] ?? "";
  const dirty = state !== null && text !== saved;

  // Checked as you type, like the Agent page's Code view.
  useEffect(() => {
    if (!state || !dirty) {
      if (state) setIssues(state.issues.filter((i) => i.path === DESK_FILE));
      return;
    }
    const timer = setTimeout(() => {
      api<{ issues: Issue[] }>(`${base}/validate`, { body: { files: { ...state.files, [DESK_FILE]: text } } })
        .then((r) => setIssues(r.issues.filter((i) => i.path === DESK_FILE)))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [text, dirty, state, base]);

  const save = () =>
    run(async () => {
      if (!state) return;
      // Only desk.yaml changes: a save from an older version merges with other files' changes.
      const files = { ...state.files, [DESK_FILE]: text };
      try {
        const result = await api<{ version: number }>(base, { method: "PUT", body: { files, base: state.version, message: "Chat widget page (desk.yaml)" } });
        await load();
        setStatus(`Saved as version ${result.version}. Visitors see it within a minute.`);
      } catch (e) {
        if (e instanceof ApiError && e.code === "invalid_config") {
          setIssues(((e.detail.issues as Issue[]) ?? []).filter((i) => i.path === DESK_FILE));
          throw new Error("Not saved: fix the problems first.");
        }
        if (e instanceof ApiError && e.code === "conflict") {
          setConflict("desk.yaml changed since you opened it (someone saved settings). Reload to see theirs; your edits here are dropped.");
          return;
        }
        throw e;
      }
    });

  return (
    <div className="desk-code">
      <section className="agent-form agent-code">
        <p className="muted small">
          Your desk's settings as a file, the same <code>{DESK_FILE}</code> the Agent page and <code>jun pull</code> show. A key you remove is left as it is.{" "}
          <a href={deskHref("/agent/desk.yaml")} onClick={(e) => { e.preventDefault(); openDeskFile(); }}>Open with the agent's files</a>
        </p>
        <div className="agent-code-path muted small">
          <code>{DESK_FILE}</code>
        </div>
        {state ? (
          <Textarea
            className="agent-text"
            aria-label={DESK_FILE}
            spellCheck={false}
            value={text}
            readOnly={!canEdit}
            onChange={(e) => {
              setText(e.target.value);
              setStatus(null);
            }}
          />
        ) : (
          <Skeleton className="desk-code-skeleton" />
        )}
        <FieldError errors={issues.map((i) => ({ message: i.message }))} />
        {canEdit && (
          <div className="desk-code-actions">
            {conflict ? (
              <>
                <span className="error small">{conflict}</span>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => run(load)}>Reload</Button>
              </>
            ) : (
              <>
                <Button disabled={busy || !dirty || issues.length > 0} onClick={save}>Save</Button>
                <Button variant="outline" disabled={busy || !dirty} onClick={() => setText(saved)}>Discard</Button>
                <span className={error ? "error small" : "muted small"} role="status">{error ?? status ?? (dirty ? "Unsaved changes" : "")}</span>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
