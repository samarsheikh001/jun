import { useEffect, useState } from "react";

// "Working on it" indicator: a 3×3 pixel grid with a chevron wavefront driving right. The 650ms
// cycle is shorter than the sweep, so two fronts are always in flight. With a `label`, a shimmering
// label and the time since it appeared follow the grid. Plain markup (the widget doesn't load the
// desk's CSS): `.pixel-*` in styles.css and desk.css; everything takes currentColor. Reduced motion
// leaves the grid dim and the label still; the timer still ticks.

const DELAYS = Array.from({ length: 9 }, (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90);

function Grid() {
  return (
    <span className="pixel-loader" aria-hidden="true">
      {DELAYS.map((delay, i) => (
        <span key={i} style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  );
}

/** A duration as "4.2s", then "1m 3.0s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 100)) / 10;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s`;
}

/** Time since `since` (else since mount). */
function useElapsed(since?: number): string {
  const [tenths, setTenths] = useState(() => (since ? Math.floor((Date.now() - since) / 100) : 0));
  useEffect(() => {
    const start = since ?? Date.now();
    const timer = setInterval(() => setTenths(Math.floor((Date.now() - start) / 100)), 100);
    return () => clearInterval(timer);
  }, [since]);
  return formatElapsed(tenths * 100);
}

function Status({ label, since }: { label: string; since?: number }) {
  const elapsed = useElapsed(since);
  return (
    <span className="pixel-status">
      <Grid />
      <span className="pixel-label">{label}</span>
      <span className="pixel-time">{elapsed}</span>
    </span>
  );
}

/** `since` (epoch ms): count from then, so a remount doesn't restart the timer. */
export function PixelLoader({ label, since }: { label?: string; since?: number }) {
  return label ? <Status label={label} since={since} /> : <Grid />;
}
