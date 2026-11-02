import { sha256 } from "../lib/crypto.ts";
import { FAILURE_WINDOW_MS, hashPassword, isLocked, LIMITS, MAX_PASSWORD_LENGTH, passwordProblem, timingDummy, verifyPassword } from "./password-hash.ts";
import { HttpError, type AppContext } from "../types.ts";

export { hashPassword, verifyPassword } from "./password-hash.ts";

/** Reads a password field as typed (never trimmed). */
export function readPassword(body: Record<string, unknown>, field = "password"): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") throw new HttpError(400, "invalid_field", "Enter a password.");
  if (value.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, "invalid_field", `Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  return value;
}

export function newPassword(body: Record<string, unknown>, email?: string | null): string {
  const password = readPassword(body);
  const problem = passwordProblem(password, email);
  if (problem) throw new HttpError(400, "weak_password", problem);
  return password;
}

async function failureKeys(c: AppContext, email: string): Promise<{ key: string; limit: number }[]> {
  const ip = c.req.header("cf-connecting-ip") ?? "local";
  return [
    { key: `email:${await sha256(email)}`, limit: LIMITS.email },
    { key: `ip:${await sha256(ip)}`, limit: LIMITS.ip },
  ];
}

export async function checkNotLocked(c: AppContext, email: string): Promise<void> {
  const now = Date.now();
  for (const { key, limit } of await failureKeys(c, email)) {
    const row = await c.env.DB.prepare("SELECT count, window_start FROM login_failures WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();
    if (isLocked(row, limit, now)) {
      const minutes = Math.max(1, Math.ceil((row!.window_start + FAILURE_WINDOW_MS - now) / 60_000));
      throw new HttpError(429, "too_many_attempts", `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or sign in with a passkey.`);
    }
  }
}

export async function recordFailure(c: AppContext, email: string): Promise<void> {
  const now = Date.now();
  const keys = await failureKeys(c, email);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM login_failures WHERE window_start < ?").bind(now - FAILURE_WINDOW_MS),
    ...keys.map(({ key }) =>
      c.env.DB.prepare(
        `INSERT INTO login_failures (key, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = count + 1`,
      ).bind(key, now),
    ),
  ]);
}

export async function clearFailures(c: AppContext, email: string): Promise<void> {
  const [byEmail] = await failureKeys(c, email);
  await c.env.DB.prepare("DELETE FROM login_failures WHERE key = ?").bind(byEmail!.key).run();
}

/** Checks an email + password and returns the user id; one answer for every kind of miss. */
export async function passwordLogin(c: AppContext, email: string, password: string): Promise<string> {
  await checkNotLocked(c, email);
  const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?").bind(email).first<{ id: string; password_hash: string | null }>();
  const ok = await verifyPassword(password, user?.password_hash ?? (await timingDummy()));
  if (!user?.password_hash || !ok) {
    await recordFailure(c, email);
    throw new HttpError(401, "wrong_password", "That email and password don't match an account here.");
  }
  await clearFailures(c, email);
  return user.id;
}
