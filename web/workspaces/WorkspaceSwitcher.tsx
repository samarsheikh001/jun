import { useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { navigate } from "../lib/router.ts";
import { CheckIcon, ChevronDownIcon, ColumnsIcon, PlusIcon, SettingsIcon } from "@/components/icons";
import { DeskIcon } from "../components/DeskIcon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field.tsx";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { goHome, switchWorkspace, type Membership } from "./workspace.ts";

/** D-95: the sidebar's top: the workspace you're in, a menu to switch, and New workspace (owners). */
export function WorkspaceSwitcher({ current, all }: { current: Membership; all: Membership[] }) {
  const [creating, setCreating] = useState(false);
  const canCreate = all.some((m) => m.role === "owner");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" className="brand ws-switcher" aria-label={`Workspace: ${current.workspaceName}. Switch workspace`} />}>
          <DeskIcon />
          <span>{current.workspaceName}</span>
          <ChevronDownIcon className="ws-switcher-chevron" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="ws-menu">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {all.map((m) => (
              <DropdownMenuItem key={m.workspaceId} onClick={() => m.workspaceId !== current.workspaceId && switchWorkspace(m)}>
                <span className="ws-initial" aria-hidden="true">{m.workspaceName.slice(0, 1).toUpperCase()}</span>
                <span className="ws-menu-name">{m.workspaceName}</span>
                {m.workspaceId === current.workspaceId && <CheckIcon className="ws-menu-check" aria-label="Current" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          {/* D-97: the desk's home lists them all; with one workspace there's no home (/ is its inbox). */}
          {all.length > 1 && (
            <DropdownMenuItem onClick={goHome}>
              <ColumnsIcon />
              All workspaces
            </DropdownMenuItem>
          )}
          {canCreate && (
            <DropdownMenuItem onClick={() => setCreating(true)}>
              <PlusIcon />
              New workspace
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => navigate("/settings/general")}>
            <SettingsIcon />
            Workspace settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/** The same sidebar top before /me answers (ShellSkeleton), so nothing moves when it does. */
export function WorkspaceSwitcherSkeleton({ name }: { name: string }) {
  return (
    <div className="brand ws-switcher">
      <DeskIcon />
      <span>{name}</span>
      <ChevronDownIcon className="ws-switcher-chevron" />
    </div>
  );
}

/** D-95: New workspace (owners): a name, then its Get started. Also on the desk's home and in Settings → Desk (D-97). */
export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  const create = () =>
    run(async () => {
      const made = await api<{ workspaceId: string; workspaceSlug: string }>("/workspaces", { body: { name } });
      // A fresh workspace starts at Get started: install its widget, teach its AI.
      switchWorkspace(made, "/welcome");
    });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form className="agent-dialog-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create(); }}>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              One for each website or product. It gets its own chat widget, inbox, AI agent, knowledge and team; you're its owner.
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="ws-name">Name</FieldLabel>
            <Input id="ws-name" autoFocus required maxLength={100} placeholder="Acme Support" value={name} onChange={(e) => setName(e.target.value)} />
            {error ? <FieldError>{error}</FieldError> : <FieldDescription>Your customers see it until you set the widget's own name.</FieldDescription>}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
