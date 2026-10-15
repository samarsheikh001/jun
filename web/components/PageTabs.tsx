import type { ReactNode } from "react";
import { navigate } from "../lib/router.ts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";

// A page with tabs in its header (Chat widget: Install / Look / Behaviour, Agent: Files / Settings). Each tab has its
// own URL, so links, reloads and the back button land on it; switching tabs replaces the entry, like
// the settings dialog's sections. Every panel stays mounted, so unsaved edits survive a switch.

export interface PageTab {
  value: string;
  label: string;
  path: string;
  content: ReactNode;
}

export function PageTabs({ title, tabs, value, className, actions, aside, tabsHidden }: {
  title: string;
  tabs: PageTab[];
  value: string;
  className?: string;
  actions?: ReactNode;
  /** Shown on every tab, just after the tab list (the Chat widget page's install status). */
  aside?: ReactNode;
  /** The sidebar lists the parts (the Agent page): only the title shows, and the panels keep their URLs. */
  tabsHidden?: boolean;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => { const tab = tabs.find((t) => t.value === v); if (tab) navigate(tab.path, { replace: true }); }} className={`page-tabs${className ? ` ${className}` : ""}`}>
      <div className="page-tabs-head">
        <h1>{title}</h1>
        {!tabsHidden && (
          <TabsList className="kb-tabs page-tabs-list">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
            ))}
          </TabsList>
        )}
        {aside}
        {actions && <div className="page-tabs-actions">{actions}</div>}
      </div>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} keepMounted className="page-tabs-panel">{t.content}</TabsContent>
      ))}
    </Tabs>
  );
}
