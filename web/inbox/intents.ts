// I-19 (D-127): what Home's assistant hands the inbox when the person confirms "draft a reply" or
// "file an issue": the conversation opens with the reply in its composer (never sent) or with the
// issue dialog open. Kept in memory for this tab only and taken once when that conversation opens.

export type InboxIntent = { draft: string } | { issue: true };

const pending = new Map<string, InboxIntent>();

export function queueInboxIntent(conversationId: string, intent: InboxIntent): void {
  pending.set(conversationId, intent);
}

/** The intent waiting for this conversation, removed as it's taken. */
export function takeInboxIntent(conversationId: string): InboxIntent | null {
  const intent = pending.get(conversationId) ?? null;
  pending.delete(conversationId);
  return intent;
}
