import type { ConversationSummary } from "../../shared/protocol.ts";

/**
 * D-128: a refetched list over the one on screen: per conversation the newer copy (higher lastSeq;
 * a tie takes the fetched one with the higher of the two read seqs), so a slow fetch never rolls back
 * what a thread's own socket already showed.
 */
export function mergeConversations(prev: ConversationSummary[], next: ConversationSummary[]): ConversationSummary[] {
  const byId = new Map(next.map((c) => [c.id, c]));
  for (const c of prev) {
    const fetched = byId.get(c.id);
    if (!fetched || c.lastSeq > fetched.lastSeq) byId.set(c.id, c);
    else if (c.lastSeq === fetched.lastSeq && c.visitorReadSeq > fetched.visitorReadSeq) byId.set(c.id, { ...fetched, visitorReadSeq: c.visitorReadSeq });
  }
  return [...byId.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}
