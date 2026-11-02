import { base64UrlDecode, base64UrlEncode } from "../lib/crypto.ts";

/**
 * D-157: email + password sign-in, beside passkeys. PBKDF2-SHA256 on WebCrypto (no dependency);
 * 100,000 iterations is the most Workers allow. The format names its iterations, so they can grow.
 */
const ALGO = "pbkdf2-sha256";
export const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${ALGO}$${iterations}$${base64UrlEncode(salt)}$${base64UrlEncode(await derive(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, rounds, salt, hash] = stored.split("$");
  const iterations = Number(rounds);
  if (algo !== ALGO || !salt || !hash || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const actual = await derive(password, base64UrlDecode(salt), iterations);
  const expected = base64UrlDecode(hash);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/** A hash to check against when the email has no account, so both take the same time. */
let dummyHash: Promise<string> | null = null;
export const timingDummy = () => (dummyHash ??= hashPassword("jun-no-such-account"));

/** What's wrong with a new password, or null. Length is the rule (NIST 800-63B), plus the obvious. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (!password.trim()) return "A password can't be only spaces.";
  if (/^(.)\1+$/.test(password)) return "Use more than one character, repeated.";
  const local = email?.toLowerCase().split("@")[0] ?? "";
  const lower = password.toLowerCase();
  if (email && (lower.includes(email.toLowerCase()) || (local.length >= 4 && lower.replace(/[^a-z]/g, "") === local.replace(/[^a-z]/g, "")))) {
    return "Don't build the password from your email.";
  }
  return null;
}

// Guessing limits: 10 wrong passwords per email and 50 per IP in 15 minutes.
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LIMITS = { email: 10, ip: 50 } as const;

/** Whether a count started at `windowStart` still blocks at `now`. Pure, for tests. */
export function isLocked(row: { count: number; window_start: number } | null, limit: number, now: number): boolean {
  return !!row && now - row.window_start < FAILURE_WINDOW_MS && row.count >= limit;
}

