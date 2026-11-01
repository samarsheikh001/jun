// Sign in with ChatGPT for Jun for Chrome (E-01): OpenAI's documented flow for open-source, locally
// hosted apps (https://developers.openai.com/siwc/token-sharing-open-source/sign-in), the same code as
// the desk and the `jun` CLI (packages/llm/src/chatgpt/). The redirect must be a 127.0.0.1 loopback,
// which an extension can't listen on: the sign-in tab is watched instead, and its address is read when
// it reaches the callback (host permission for http://127.0.0.1:1455/*), then the tab is closed.
// Tokens live in chrome.storage.local (`jun.chatgpt`) and go only to OpenAI. Never Codex's client id.
import { ChatGPTAuth, tokensFromResponse, type ChatGPTCredentials, type CredentialStore } from "../../../packages/llm/src/chatgpt/auth.ts";
import * as oauth from "../../../packages/llm/src/chatgpt/oauth.ts";

export const CHATGPT_KEY = "jun.chatgpt";
export const CALLBACK_PORT = 1455;
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${oauth.CALLBACK_PATH}`;
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

export const store: CredentialStore = {
  async load() {
    const s = await browser.storage.local.get(CHATGPT_KEY);
    return (s[CHATGPT_KEY] as ChatGPTCredentials | undefined) ?? undefined;
  },
  async save(credentials) {
    await browser.storage.local.set({ [CHATGPT_KEY]: credentials });
  },
};

/** The signed-in account's email, or null when not signed in. */
export async function signedIn(): Promise<{ email: string } | null> {
  const c = await store.load();
  return c?.clientId && c.tokens ? { email: c.tokens.email ?? "your ChatGPT account" } : null;
}

/** The callback's query when the address is the loopback callback, else null. Pure. */
export function callbackParams(url: string | undefined): URLSearchParams | null {
  if (!url || !url.startsWith(REDIRECT_URI)) return null;
  try {
    return new URL(url).searchParams;
  } catch {
    return null;
  }
}

/** Opens OpenAI's sign-in in a tab and finishes when it reaches the callback. */
export async function signIn(): Promise<{ email: string }> {
  const existing = await store.load();
  // The host id is stable for this browser and saved before the first sign-in (the docs ask for it).
  const hostId = existing ? oauth.normalizeHostId(existing.hostId) : oauth.newHostId();
  if (!existing || hostId !== existing.hostId) await store.save({ ...existing, hostId });

  const state = oauth.randomToken();
  const nonce = oauth.randomToken();
  const codeVerifier = oauth.randomToken(48);
  const authorizeUrl = oauth.buildAuthorizeUrl({
    clientId: existing?.clientId,
    hostId,
    redirectUri: REDIRECT_URI,
    state,
    nonce,
    codeChallenge: await oauth.pkceChallenge(codeVerifier),
    idTokenHint: existing?.tokens?.idToken,
  });

  const tab = await browser.tabs.create({ url: authorizeUrl });
  const params = await new Promise<URLSearchParams>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    const onUpdated = (tabId: number, change: { url?: string }) => {
      if (tabId !== tab.id) return;
      const p = callbackParams(change.url);
      if (!p) return;
      done();
      void browser.tabs.remove(tabId).catch(() => undefined);
      resolve(p);
    };
    const onRemoved = (tabId: number) => {
      if (tabId !== tab.id) return;
      done();
      reject(new Error("Sign-in was closed before it finished."));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("Sign-in timed out. Try again."));
    }, SIGN_IN_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
  });

  if (params.get("state") !== state) throw new Error("That sign-in was from another attempt. Try again.");
  const error = params.get("error");
  if (error) throw new Error(params.get("error_description") || error);
  const code = params.get("code");
  if (!code) throw new Error("OpenAI didn't send a sign-in code. Try again.");
  // The first sign-in registers this browser and returns its own client id; keep it for later sign-ins.
  const clientId = params.get("client_id") ?? existing?.clientId;
  if (!clientId || clientId === oauth.REGISTRATION_CLIENT_ID) throw new Error("OpenAI didn't return a client id. Try again.");
  if (clientId !== existing?.clientId) await store.save({ ...(await store.load()), hostId, clientId });

  const response = await oauth.exchangeCode({ clientId, code, codeVerifier, redirectUri: REDIRECT_URI });
  if (!response.id_token) throw new Error("OpenAI's answer had no ID token. Try again.");
  await oauth.verifyIdToken(response.id_token, { clientId, nonce });
  const tokens = tokensFromResponse(response);
  await store.save({ hostId, clientId, tokens });
  return { email: tokens.email ?? "your ChatGPT account" };
}

const auth = new ChatGPTAuth(store);

export function signOut(): Promise<void> {
  return auth.logout();
}

/** fetch for the OpenAI provider on the ChatGPT plan: a fresh access token, one refresh and retry on 401. */
export const chatgptFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const token = await auth.getAccessToken({ forceRefresh: attempt > 0 });
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(input, { ...init, headers });
    if (response.status !== 401 || attempt > 0) return response;
  }
};

/** As packages/llm/src/responses.ts (not imported: it brings the Node-typed SSE reader). */
export const OPENAI_API_BASE = "https://api.openai.com/v1";
