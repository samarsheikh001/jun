import { rankActions, sanitizeActions, type MessageAction, type PageAction, type SeenPageAction } from "../../shared/actions.ts";
import type { Message } from "../../shared/protocol.ts";
import type { TestChatEvent, TestReply, TestTurn } from "../../shared/test-chat.ts";
import { asksForHuman, resolveCitations } from "./agent.ts";
import type { AgentConfig, ToolUser } from "./config.ts";
import type { AgentModel } from "./providers.ts";
import { runAgent } from "./run.ts";

// AI-29: one reply in a task page's test chat (shared/test-chat.ts). The draft's config, the chat so
// far, and the same runAgent as live chats; what the customer would see streams back. Nothing is
// stored. Safe mode (the default): look-ups run for real, changes (POST) are answered without being
// made (tools.ts `pretend`). Website actions the desk has seen are offered as on a page; one the AI
// asks for is shown, and the next turn sees it as done, as a test case does.

/** How much of a call's output the page shows. */
const MAX_CALL_OUTPUT = 600;

function message(seq: number, body: string, authorType: Message["authorType"], meta: Message["meta"] = {}): Message {
  return { id: `test_${seq}`, seq, authorType, authorId: null, authorName: null, body, attachments: [], clientMsgId: `test:${seq}`, createdAt: Date.now(), internal: false, meta };
}

/** The website actions the desk has seen, as a page would send them (inputs as text; their real types aren't known). */
export function seenAsPageActions(seen: SeenPageAction[]): PageAction[] {
  return sanitizeActions(
    seen.map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: { type: "object", properties: Object.fromEntries(a.params.map((p) => [p, { type: "string" }])) },
      ...(a.widget ? { widget: a.widget } : {}),
    })),
  );
}

/** The chat so far as conversation history: earlier replies with their cards, website actions as done. */
export function testHistory(turns: TestTurn[], pageActions: PageAction[]): Message[] {
  return turns.map((t, i) => {
    if (t.role === "customer") return message(i + 1, t.text, "visitor");
    const r = t.reply;
    const meta: Message["meta"] = r.widgets.length ? { widgets: r.widgets } : {};
    const asked = r.pageAction ? pageActions.find((a) => a.name === r.pageAction!.name) : undefined;
    if (asked && r.pageAction) {
      // As if the customer confirmed and the page ran it: the next turn sees it as done.
      const card: MessageAction = {
        runId: `run_test_${i}`,
        id: asked.id,
        name: asked.name,
        tool: asked.tool,
        description: asked.description,
        risk: asked.risk === "auto" ? "auto" : "confirm",
        params: asked.params,
        required: asked.required,
        input: r.pageAction.input,
        missing: [],
        status: "ok",
        result: "done",
        canUndo: false,
      };
      meta.action = card;
    }
    return message(i + 1, r.text, "ai", meta);
  });
}

export async function runTestChat(
  input: { env: Env; workspaceId: string; workspaceName: string; model: AgentModel; config: AgentConfig; turns: TestTurn[]; real: boolean; user: ToolUser | null; page: string | null; seen: SeenPageAction[] },
  emit: (event: TestChatEvent) => void,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const allActions = seenAsPageActions(input.seen);
  const history = testHistory(input.turns, allActions);
  const question = history.at(-1)?.body ?? "";
  // The live desk's shortcut: asking for a person hands off without asking the AI.
  if (asksForHuman(question)) {
    emit({ type: "done", reply: { text: "", handoff: "The customer asked for a person.", widgets: [], calls: [] } });
    return { inputTokens: 0, outputTokens: 0 };
  }
  const result = await runAgent({
    env: input.env,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    model: input.model,
    config: input.config,
    history,
    user: input.user,
    pagePath: input.page,
    pageActions: rankActions(allActions, question),
    ...(input.real ? {} : { pretend: (spec) => spec.method === "POST" }),
    onVisible: (text) => emit({ type: "text", text }),
    onStep: (step) => emit({ type: "step", step }),
  });
  const { text, sources } = resolveCitations(result.outcome.text, result.hits);
  const reply: TestReply = {
    text,
    ...(result.outcome.kind === "handoff" ? { handoff: result.outcome.reason } : {}),
    ...(result.outcome.kind === "answer" && result.outcome.escalate ? { escalate: result.outcome.escalate } : {}),
    widgets: result.widgets,
    calls: result.actions.map((a) => ({
      tool: a.tool,
      status: a.status,
      httpStatus: a.httpStatus,
      output: a.output.length > MAX_CALL_OUTPUT ? `${a.output.slice(0, MAX_CALL_OUTPUT)}…` : a.output,
      ...(a.pretended ? { pretended: true as const } : {}),
    })),
    ...(result.pageAction ? { pageAction: { name: result.pageAction.action.name, input: result.pageAction.input } } : {}),
    ...(sources.length ? { sources } : {}),
  };
  emit({ type: "done", reply });
  return result.usage;
}
