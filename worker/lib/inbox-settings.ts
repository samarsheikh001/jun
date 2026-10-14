import { applyAppearance } from "../../shared/appearance.ts";
import { parseHours } from "../../shared/hours.ts";
import { parseAssignment } from "../../shared/inbox.ts";
import { parseOpeners } from "../../shared/openers.ts";
import { normalizeDomains } from "./origins.ts";

// The widget inbox's settings (`inboxes.settings`) as an admin changes them: the one set of checks
// behind `PATCH /workspaces/:id/inbox` (the Chat widget page, Settings) and desk.yaml (D-84). Pure.

/**
 * Applies the fields present in `body` to `settings` (in place). Throws an Error with a message for
 * the admin on the first bad field; `settings` may be partly changed then, so callers pass a copy.
 */
export function applyInboxPatch(settings: Record<string, unknown>, body: Record<string, unknown>, newId: () => string): void {
  // P-02: offer help when something breaks on the page.
  if (body.proactive !== undefined) {
    if (typeof body.proactive !== "boolean") throw new Error("Offering help must be true or false.");
    settings.proactive = body.proactive;
  }
  // W-12: ask visitors to rate resolved conversations (on unless turned off).
  if (body.csat !== undefined) {
    if (typeof body.csat !== "boolean") throw new Error("Asking for a rating must be true or false.");
    settings.csat = body.csat;
  }
  // W-04 appearance.
  applyAppearance(settings, body);
  // I-10 business hours.
  if (body.hours !== undefined) settings.hours = parseHours(body.hours);
  // I-02: who new chats that need a person go to.
  if (body.assignment !== undefined) settings.assignment = parseAssignment(body.assignment);
  // P-01 page openers: the whole list at once.
  if (body.openers !== undefined) settings.openers = parseOpeners(body.openers, newId);
  if (body.allowedDomains !== undefined) {
    const { domains, invalid } = normalizeDomains(body.allowedDomains);
    if (invalid.length) throw new Error(`Not a domain: ${invalid.join(", ")}. Use e.g. acme.com or *.acme.com.`);
    settings.allowedDomains = domains;
  }
}
