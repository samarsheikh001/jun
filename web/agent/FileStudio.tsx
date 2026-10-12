import type { ReactNode } from "react";
import { api } from "../api.ts";
import { agentFileKind, type AgentFileKind } from "../../shared/agent-file-ai.ts";
import { EDIT_ATTEMPTS, liveReply, readAgentFileEdit, readTaskEdit, withMissingNote, type EditResult } from "../../shared/edit-finish.ts";
import { taskFilesText } from "../../shared/task-ai.ts";
import { AiChat } from "./AiChat.tsx";
import { streamAnswer } from "./editStream.ts";
import { CodeEditor, go } from "./parts.tsx";
import { Connections } from "./Connections.tsx";
import { Studio } from "./Studio.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// An action's or a procedure's page (W-24), laid out like a widget's (Studio.tsx): AI and Code on the
// left, the form on the right. The AI chat sends the whole draft, so its change is checked like a save
// (D-62: here, with the server's config checker, once the streamed answer is in).

const IDEAS: Record<AgentFileKind, string[]> = {
  action: ["Make the description clearer for the AI", "Also ask for the customer's email", "Only offer it on the billing pages", "Show the result as a widget"],
  procedure: ["Add a step to confirm before anything changes", "Hand over to a person if they're upset", "Make the steps shorter", "Add the action this needs"],
};
const INTRO: Record<AgentFileKind, string> = {
  action: "Describe the change in your words. The AI edits this action and the form updates; it never invents API addresses or keys, and nothing goes live until you save.",
  procedure: "Describe the change in your words. The AI edits this task's steps and the actions they use (it can create one it needs) and the page updates; it never invents API addresses or keys, and nothing goes live until you save.",
};

export function FileStudio({ cfg, canEdit, path, title, kind, back, form }: {
  cfg: AgentConfig;
  canEdit: boolean;
  path: string;
  title: string;
  kind: AgentFileKind;
  back: { path: string; label: string };
  /** The item's form, shown on the right. */
  form: ReactNode;
}) {
  return (
    <Studio
      cfg={cfg}
      canEdit={canEdit}
      path={path}
      title={title}
      back={back}
      onRemove={() => {
        cfg.setFile(path, undefined);
        go(back.path);
      }}
      panes={[
        ...(canEdit
          ? [{
              id: "ai" as const,
              label: "AI",
              content: (
                <AiChat
                  key={path}
                  cfg={cfg}
                  path={path}
                  noun={kind === "procedure" ? "task" : kind}
                  intro={INTRO[kind]}
                  ideas={IDEAS[kind]}
                  request={kind === "procedure" ? (message, history, _file, onReply) => taskRequest(cfg, path, message, history, onReply) : async (message, history, file, onReply) => {
                    let error: { file: string; problems: string[] } | undefined;
                    for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
                      const { text } = await streamAnswer(cfg.base, "/file-edit", { path, files: cfg.draft, message, history, ...(error ? { error } : {}) }, (t) => onReply(liveReply(t)));
                      const done = readAgentFileEdit(file, text);
                      if ("result" in done) return done.result;
                      if ("failed" in done) {
                        error = done.failed;
                        continue;
                      }
                      // Checked like a save: the whole draft with this file, problems for this file only.
                      const next = { ...cfg.draft, [path]: done.check.file };
                      const { issues } = await api<{ issues: { path: string; message: string }[] }>(`${cfg.base}/validate`, { body: { files: next } });
                      const problems = issues.filter((i) => i.path === path).map((i) => i.message);
                      if (!problems.length) return { reply: done.check.reply, file: done.check.file, changed: true };
                      error = { file: done.check.file, problems };
                    }
                    throw new Error(`The AI's change didn't pass the checks (${error?.problems.join(" ") ?? "no answer"}). Try asking another way.`);
                  }}
                />
              ),
            }]
          : []),
        {
          id: "code" as const,
          label: "Code",
          content: (
            <div className="agent-wed-raw agent-wed-code-pane">
              <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
            </div>
          ),
        },
      ]}
      right={
        <section className="agent-wed-form" aria-label="Form">
          {/* W-25: what this is connected to, as links. */}
          {/* AI-27: a task's page lists what it uses in its form instead. */}
          {kind !== "procedure" && (
            <div className="agent-links-wrap">
              <Connections cfg={cfg} kind={kind} name={agentFileKind(path)?.name ?? ""} canEdit={canEdit} />
            </div>
          )}
          {form}
        </section>
      }
    />
  );
}

/**
 * AI-27: one change to a task (its procedure, the actions it uses, new actions), streamed like the
 * other editors and checked together like a save: the whole draft with every file the answer wrote,
 * problems in any of them go back to the model once.
 */
async function taskRequest(cfg: AgentConfig, path: string, message: string, history: { role: "user" | "assistant"; text: string }[], onReply: (reply: string) => void): Promise<EditResult> {
  let error: { file: string; problems: string[] } | undefined;
  for (let attempt = 0; attempt < EDIT_ATTEMPTS; attempt++) {
    const { text } = await streamAnswer(cfg.base, "/file-edit", { path, files: cfg.draft, message, history, task: true, ...(error ? { error } : {}) }, (t) => onReply(liveReply(t)));
    const done = readTaskEdit(path, cfg.draft, text);
    if ("result" in done) return done.result;
    if ("failed" in done) {
      error = done.failed;
      continue;
    }
    const next = { ...cfg.draft, ...done.check.files };
    const { issues } = await api<{ issues: { path: string; message: string }[] }>(`${cfg.base}/validate`, { body: { files: next } });
    const problems = issues.filter((i) => i.path in done.check.files).map((i) => `${i.path}: ${i.message}`);
    if (!problems.length) {
      const { [path]: own, ...others } = done.check.files;
      const reply = withMissingNote(next, agentFileKind(path)?.name ?? "", done.check.reply);
      return { reply, file: own ?? cfg.draft[path] ?? "", changed: true, ...(Object.keys(others).length ? { others } : {}) };
    }
    error = { file: taskFilesText(done.check.files), problems };
  }
  throw new Error(`The AI's change didn't pass the checks (${error?.problems.join(" ") ?? "no answer"}). Try asking another way.`);
}
