import { useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";

export interface DevChatgpt {
  available: boolean;
  connected: boolean;
  email: string | null;
}

/**
 * ChatGPT sign-in (D-27): Settings → AI and Get started. `base` is `/workspaces/<id>/ai`; `returnTo` is
 * where a local sign-in lands afterwards (`/welcome/<step>`; default Settings).
 */
export function ChatgptConnect({ base, devChatgpt, canEdit, onChange, returnTo }: { base: string; devChatgpt: DevChatgpt; canEdit: boolean; onChange: () => Promise<unknown>; returnTo?: string }) {
  // Deployed desks: the sign-in returns to a 127.0.0.1 page that doesn't load; its address is pasted here.
  const [pasting, setPasting] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div className="small chatgpt-box">
      {devChatgpt.connected ? (
        <span>Connected as <strong>{devChatgpt.email ?? "your ChatGPT account"}</strong>. Replies use your ChatGPT plan.</span>
      ) : (
        <span>Not connected.</span>
      )}
      {canEdit && (devChatgpt.available || devChatgpt.connected) && (
        <div className="row chatgpt-actions">
          {devChatgpt.available && (
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => run(async () => { const { url, paste } = await api<{ url: string; paste: boolean }>(`${base}/chatgpt/start`, { body: { returnTo } }); if (!paste) { window.location.href = url; return; } window.open(url, "_blank", "noopener"); setPasting(true); })}>
              {devChatgpt.connected ? "Reconnect" : "Sign in with ChatGPT"}
            </Button>
          )}
          {devChatgpt.connected && (
            <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => run(async () => { await api(`${base}/chatgpt`, { method: "DELETE" }); await onChange(); })}>Disconnect</Button>
          )}
        </div>
      )}
      {pasting && (
        <div className="stack chatgpt-paste">
          <span>After you approve in the new tab, it ends on a page that doesn't load (<code>http://127.0.0.1:1455/auth/callback?…</code>). Copy that page's address and paste it here.</span>
          <div className="row">
            <Input name="callbackUrl" placeholder="http://127.0.0.1:1455/auth/callback?code=…" aria-label="Sign-in return address" autoComplete="off" />
            <Button size="sm" type="button" disabled={busy} onClick={(e) => { const input = e.currentTarget.parentElement?.querySelector("input"); run(async () => { await api(`${base}/chatgpt/finish`, { body: { callbackUrl: input?.value ?? "" } }); setPasting(false); await onChange(); }); }}>Finish</Button>
          </div>
        </div>
      )}
      {error && <span className="error">{error}</span>}
      <div className="muted">Replies spend the signed-in ChatGPT plan. Only for a private desk: OpenAI's terms cover plan usage for your own use, not for serving the public.</div>
    </div>
  );
}
