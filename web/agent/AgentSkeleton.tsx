import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Skeleton, SkelText } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { PlusIcon, SearchIcon, UploadIcon } from "@/components/icons";
import { ModelFactsSkeleton } from "./InstructionsView.tsx";

// While the agent's files load, each Agent view draws its own layout with placeholders (the same
// classes as the real view), so nothing moves when the files arrive.

type Tab = "try" | "instructions" | "tasks" | "tests" | "actions" | "widgets";

const CARD_WIDTHS = [[132, 260, 180], [108, 240, 120], [150, 270, 200], [96, 230, 150], [124, 250, 90], [140, 220, 170]] as const;

/** The search box and buttons of a list page, disabled until it loads. */
function GalleryBar({ noun, add, canEdit, upload }: { noun: string; add: string; canEdit: boolean; upload?: boolean }) {
  return (
    <div className="agent-gallery-bar">
      <div className="agent-gallery-search">
        <SearchIcon />
        <Input type="search" placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} disabled />
      </div>
      <span className="spacer" />
      {canEdit && (
        <>
          {upload && (
            <Button variant="outline" size="icon" aria-label="Upload a .widget file" disabled>
              <UploadIcon />
            </Button>
          )}
          <Button disabled>
            <PlusIcon /> {add}
          </Button>
        </>
      )}
    </div>
  );
}

export function AgentSkeleton({ tab, item, code, canEdit }: { tab: Tab; item: string | null; code: boolean; canEdit: boolean }) {
  const busy = { "aria-busy": true, "aria-label": "Loading the agent" } as const;
  // An item's page (the Studio) and every Code view: the editor's area.
  if (item && tab !== "instructions" && tab !== "tests") {
    return (
      <div className="agent-skel-studio" {...busy}>
        <Skeleton />
        <Skeleton />
      </div>
    );
  }
  // D-113: Try it has no file, so no Code view: the test chat's box.
  if (tab === "try") {
    return (
      <div className="agent-try-chat" {...busy}>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (code) {
    return (
      <div className="agent-skel-code" {...busy}>
        <Skeleton />
      </div>
    );
  }
  if (tab === "actions" || tab === "tasks") {
    const [noun, add] = tab === "actions" ? ["actions", "New action"] : ["tasks", "New task"];
    return (
      <div className="agent-gallery" {...busy}>
        <GalleryBar noun={noun} add={add} canEdit={canEdit} />
        <ul className="agent-index-grid" aria-hidden="true">
          {CARD_WIDTHS.map(([title, line1, line2], i) => (
            <li key={i} className="agent-index-card">
              <span className="agent-index-link"><SkelText width={title} /></span>
              <p className="agent-index-sub">
                <SkelText width={`min(100%, ${line1}px)`} />
                <br />
                <SkelText width={line2} />
              </p>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (tab === "widgets") {
    return (
      <div className="agent-gallery" {...busy}>
        <Tabs value="mine">
          <TabsList className="kb-tabs agent-gallery-tabs" aria-label="Widgets">
            <TabsTrigger value="mine" disabled>My widgets</TabsTrigger>
            <TabsTrigger value="templates" disabled>Templates</TabsTrigger>
          </TabsList>
        </Tabs>
        <GalleryBar noun="widgets" add="New widget" canEdit={canEdit} upload />
        <ul className="agent-gallery-grid" aria-hidden="true">
          {CARD_WIDTHS.slice(0, 3).map(([title, , sub], i) => (
            <li key={i} className="agent-tile">
              <Skeleton className="agent-skel-stage" />
              <div className="agent-tile-text">
                <span className="agent-tile-link"><SkelText width={title} /></span>
                <span className="agent-tile-sub"><SkelText width={sub} /></span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (tab === "tests") {
    return (
      <div className="agent-form agent-tests" {...busy}>
        <div className="agent-item-head">
          <p className="muted small agent-tests-intro">
            Write what a customer might say and what a good reply does. Run them after a change, before you save, to check the AI still gets these right. Your unsaved changes are what's tested.
          </p>
          {canEdit && (
            <Button variant="outline" size="sm" disabled>
              <PlusIcon /> New test
            </Button>
          )}
          <Button size="sm" disabled>Run tests</Button>
        </div>
        <Skeleton className="agent-skel-test" />
        <Skeleton className="agent-skel-test" />
      </div>
    );
  }
  // Instructions: the page to write on and the hand-over panel.
  return (
    <div className="agent-doc" {...busy}>
      <section className="agent-doc-main">
        <div className="agent-doc-head">
          <h2>How the AI talks</h2>
          <p>Its tone, and anything it should always or never do. Write it like you'd brief a new teammate. Steps for one job (like refunds) go in Tasks.</p>
        </div>
        <div className="agent-doc-editor" aria-hidden="true">
          <div className="agent-skel-doc">
            {[92, 84, 96, 60, 0, 88, 72].map((w, i) => (
              <div key={i}>{w ? <SkelText width={`${w}%`} /> : " "}</div>
            ))}
          </div>
        </div>
      </section>
      <aside className="agent-panel" aria-hidden="true">
        <h3 className="agent-panel-title">Hand over to your team</h3>
        <Skeleton className="agent-skel-panel" />
        <p className="agent-panel-note">The AI also hands over whenever a customer asks for a person, or when it can't help.</p>
        <div className="agent-panel-model">
          <h3 className="agent-panel-title">Model</h3>
          <ModelFactsSkeleton />
          <p className="agent-panel-note">Change the model in Settings → AI. Answers come from your Knowledge.</p>
        </div>
      </aside>
    </div>
  );
}
