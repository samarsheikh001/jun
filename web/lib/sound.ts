// W-20 / I-14: interaction sounds and the new-reply cue, synthesized live by cuelume (MIT, Web
// Audio, no audio files). Shared by the widget frame and the dashboard.
//
// Two kinds: controls carry `data-cuelume-*` attributes (`bindSounds`, delegated), and outcomes
// play by name (`cue`: a reply arrived, a card waits on the visitor, something failed). Pick a cue
// by its job (https://cuelume.dev/agents.md): never one per streamed token, per step of a run or
// on hover.
//
// Browsers only let a page make sound after the person has interacted with it, so cuelume (about
// 9 KB gzipped, a lazy chunk: the widget frame loads on every customer page) is fetched and its
// audio started on the first pointerdown/keydown in this document (`unlockSoundOnInteraction`).
// A cue before that is silently nothing, as the browser would make it anyway.

import type { PlayOptions, SoundName } from "cuelume";

export type { SoundName };

type Cuelume = typeof import("cuelume");
let lib: Cuelume | null = null;
let loading: Promise<Cuelume | null> | null = null;
let enabled = true;
let wantBind = false;

function load(): Promise<Cuelume | null> {
  loading ??= import("cuelume").then(
    (m) => {
      lib = m;
      m.setEnabled(enabled);
      if (wantBind) m.bind();
      return m;
    },
    () => null,
  );
  return loading;
}

let lastChime = 0;

/** At most one new-reply chime per this many milliseconds. */
export const CHIME_GAP_MS = 4_000;

/** The widget's sound switch (the desk's `sound` setting); off silences everything at once. */
export function setSoundOn(on: boolean): void {
  enabled = on;
  lib?.setEnabled(on);
}

/** Plays a cue now. Not loaded yet, blocked audio or no Web Audio: nothing. */
export function cue(name: SoundName, options?: PlayOptions): void {
  try {
    lib?.play(name, options);
  } catch {
    // no sound here
  }
}

/** Sounds for every `data-cuelume-*` control in this document, added now or later (once cuelume is loaded). */
export function bindSounds(): void {
  wantBind = true;
  lib?.bind();
}

let listening = false;
/** One listener for the first interaction with this document: loads cuelume and starts its audio. */
export function unlockSoundOnInteraction(): void {
  if (listening) return;
  listening = true;
  const start = () => {
    void load().then((m) => m?.unlock()).then((ok) => {
      if (!ok) return;
      document.removeEventListener("pointerdown", start, true);
      document.removeEventListener("keydown", start, true);
    });
  };
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("keydown", start, true);
}

/**
 * A new reply came in while the person may not be looking: cuelume's `ready` (a result is there).
 * Returns whether it played: not within CHIME_GAP_MS of the last one.
 */
export function playChime(options: PlayOptions = {}, now = Date.now()): boolean {
  if (!lib || now - lastChime < CHIME_GAP_MS) return false;
  lastChime = now;
  cue("ready", options);
  return true;
}

/** "Test sound" buttons: call from the click itself (it unlocks), so it plays. */
export function previewChime(): void {
  void load().then(async (m) => {
    if (m && (await m.unlock())) m.play("ready", { emphasis: "strong" });
  });
}
