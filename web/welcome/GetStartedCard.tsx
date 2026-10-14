import { navigate } from "../lib/router.ts";
import { XIcon } from "@/components/icons";
import { STEP_ORDER, STEPS, type Onboarding } from "./WelcomePage.tsx";

// T-11: the sidebar's "Getting started" card, shown until every step is done or Get started is
// hidden, so leaving it half-way keeps it a click away. Each step opens its page (`/welcome/<step>`);
// the next one open shows a tile on the same sky as Get started's header. The × hides it for good.

function Pending() {
  // A ring of dots, fading round, for a step not done yet.
  return (
    <svg className="gs-dots" viewBox="0 0 20 20" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        return <circle key={i} cx={10 + Math.cos(a) * 7} cy={10 + Math.sin(a) * 7} r={1.7} opacity={0.9 - i * 0.09} />;
      })}
    </svg>
  );
}

function Tick() {
  return (
    <svg className="gs-tick" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" />
      <path d="M6 10.4l2.6 2.6L14 7.6" />
    </svg>
  );
}

export function GetStartedCard({ onboarding, onHide }: { onboarding: Onboarding; onHide: () => void }) {
  const done = STEP_ORDER.filter((k) => onboarding.steps[k]).length;
  const percent = Math.round((done / STEP_ORDER.length) * 100);
  const next = STEP_ORDER.find((k) => !onboarding.steps[k]);
  const open = (href: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(href);
  };

  return (
    <div className="gs-card">
      <div className="gs-head">
        <a href="/welcome" onClick={open("/welcome")}>Getting started</a>
        <span className="gs-percent">{percent}%</span>
        <button type="button" data-plain className="gs-hide" aria-label="Hide Getting started" title="Hide Getting started" onClick={onHide}><XIcon /></button>
      </div>
      <div className="gs-list">
        {STEP_ORDER.map((key) => {
          const { title, cta, icon: Icon, tint, pan } = STEPS[key];
          const ok = onboarding.steps[key];
          const href = `/welcome/${key}`;
          return (
            <div key={key} className="gs-item">
              <a href={href} className={`gs-step ${ok ? "ok" : ""}`} onClick={open(href)}>
                {ok ? <Tick /> : <Pending />}
                <span>{title}</span>
              </a>
              {key === next && (
                <a href={href} className="gs-tile" style={{ backgroundPosition: `center ${pan}%` }} onClick={open(href)} aria-label={cta}>
                  <span className="gs-cta">{cta}</span>
                  <span className="gs-icon" style={{ color: tint }}><Icon /></span>
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
