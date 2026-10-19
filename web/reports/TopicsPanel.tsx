import { useCallback, useEffect, useState } from "react";
import { cachedGet, fetchSetting } from "../settings/settingsData.ts";
import { api } from "../api.ts";
import { MAX_TOPIC_LENGTH } from "../../shared/topics.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { SelectField, SelectOption } from "@/components/ui/select-field.tsx";
import { SkelText } from "@/components/ui/skeleton.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";

interface TopicRow { id: string; name: string; conversations: number }

/**
 * A-02: the AI's topic labels, managed from Reports' "Manage topics" sheet (D-120; was Settings →
 * Inbox). Owners and admins rename, merge (move the conversations, delete the source) and delete
 * them (those conversations get labelled again later), or label now; agents read. `onChange` runs
 * after a change, so the report behind refreshes.
 */
export function TopicsPanel({ workspaceId, canEdit, onChange }: { workspaceId: string; canEdit: boolean; onChange?: () => void }) {
  const base = `/workspaces/${workspaceId}/topics`;
  const [topics, setTopics] = useState<TopicRow[] | null>(() => cachedGet<{ topics: TopicRow[] }>(base)?.topics ?? null);
  const [max, setMax] = useState(() => cachedGet<{ max: number }>(base)?.max ?? 40);
  const [merging, setMerging] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<TopicRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => {
    const r = await fetchSetting<{ topics: TopicRow[]; max: number }>(base);
    setTopics(r.topics);
    setMax(r.max);
  }, [base]);
  useEffect(() => {
    load().catch(() => setTopics([]));
  }, [load]);
  const change = (fn: () => Promise<unknown>) =>
    run(async () => {
      await fn();
      await load();
      onChange?.();
    });

  const saveRename = (t: TopicRow) => {
    const name = renaming?.name.trim() ?? "";
    if (!name) return;
    if (name === t.name) return setRenaming(null);
    change(async () => { await api(`${base}/${t.id}`, { method: "PATCH", body: { name } }); setRenaming(null); });
  };

  const labelNow = () =>
    change(async () => {
      setNotice(null);
      const r = await api<{ labeled: number; unlabeled: number; skipped?: "ai_off" | "cap_reached" }>(`${base}/label`, { body: {} });
      setNotice(
        r.skipped === "ai_off"
          ? "AI replies are off, so nothing was labelled."
          : r.skipped === "cap_reached"
            ? "The monthly AI cap is reached, so nothing was labelled."
            : r.labeled === 0 && r.unlabeled === 0
              ? "Nothing to label: every quiet chat has a topic."
              : `Labelled ${r.labeled} conversation${r.labeled === 1 ? "" : "s"}.`,
      );
    });

  return (
    <div className="topics-manage">
      <div className="topics-manage-bar">
        <p className="muted small">
          The AI gives each chat a short topic once it's resolved or quiet for 10 minutes, reusing these when one fits (up to {max}). Filter the inbox by them. Visitors never see topics.
        </p>
        {canEdit && <Button variant="outline" size="sm" disabled={busy} onClick={labelNow}>{busy ? "Working…" : "Label now"}</Button>}
      </div>
      {notice && <p className="ok-text small">{notice}</p>}
      {error && <p className="error small">{error}</p>}
      {topics === null ? (
        <ul className="list" aria-busy="true">
          {[0, 1, 2].map((i) => <li key={i}><span><SkelText width={160} /></span></li>)}
        </ul>
      ) : topics.length === 0 ? (
        <p className="muted">No topics yet.</p>
      ) : (
        <ul className="list">
          {topics.map((t) => canEdit && renaming?.id === t.id ? (
            <li key={t.id}>
              <form
                className="topic-rename"
                onSubmit={(e) => { e.preventDefault(); saveRename(t); }}
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRenaming(null); } }}
              >
                <Input
                  aria-label={`New name for ${t.name}`}
                  value={renaming.name}
                  maxLength={MAX_TOPIC_LENGTH}
                  autoFocus
                  disabled={busy}
                  onChange={(e) => setRenaming({ id: t.id, name: e.target.value })}
                />
                <span className="topic-actions">
                  <Button type="submit" size="sm" disabled={busy || !renaming.name.trim()}>{busy ? "Saving…" : "Save"}</Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRenaming(null)}>Cancel</Button>
                </span>
              </form>
            </li>
          ) : (
            <li key={t.id}>
              <span>
                <span className="strong">{t.name}</span> <span className="muted small nums">· {t.conversations} conversation{t.conversations === 1 ? "" : "s"}</span>
              </span>
              {canEdit && merging === t.id ? (
                <span className="topic-actions">
                  <SelectField
                    aria-label={`Merge ${t.name} into`}
                    defaultValue=""
                    disabled={busy}
                    onValueChange={(value) => {
                      const into = value;
                      if (into) change(async () => { await api(`${base}/${t.id}/merge`, { body: { into } }); setMerging(null); });
                    }}
                  >
                    <SelectOption value="" disabled>Merge into…</SelectOption>
                    {topics.filter((o) => o.id !== t.id).map((o) => <SelectOption key={o.id} value={o.id}>{o.name}</SelectOption>)}
                  </SelectField>
                  <Button variant="outline" size="sm" onClick={() => setMerging(null)}>Cancel</Button>
                </span>
              ) : canEdit && (
                <span className="topic-actions">
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { setMerging(null); setRenaming({ id: t.id, name: t.name }); }}>
                    Rename
                  </Button>
                  {topics.length > 1 && <Button variant="outline" size="sm" disabled={busy} onClick={() => { setRenaming(null); setMerging(t.id); }}>Merge</Button>}
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setDeleting(t)}>
                    Delete
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this topic?</DialogTitle>
            <DialogDescription>
              "{deleting?.name}" goes.{" "}
              {deleting?.conversations
                ? `Its ${deleting.conversations} conversation${deleting.conversations === 1 ? "" : "s"} will be labelled again later.`
                : "No conversations have it."}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="error small">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const t = deleting;
                if (t) change(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); setDeleting(null); });
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
