import assert from "node:assert/strict";
import { test } from "node:test";
import { boxesMeet, chatScale, fieldHue, LABEL_GAP, labelBox, labelWidth, mapTopics, placeLabels, shortLabel, spreadDots } from "./topic-map.ts";

test("mapTopics: only topics with AI chats, with their rate", () => {
  const t = (id: string, rate: number | null) => ({ id, name: id, count: 4, share: 0.5, aiResolutionRate: rate, aiResolved: 1, ai: 2, handedOff: 1 });
  assert.deepEqual(mapTopics([t("a", 0.5), t("b", null)]).map((m) => [m.id, m.rate]), [["a", 0.5]]);
});

test("chatScale: linear from 0 for close counts, log with 1-2-5 ticks for spread ones", () => {
  const lin = chatScale([3, 7, 12], 6);
  assert.equal(lin.log, false);
  assert.deepEqual(lin.ticks, [0, 5, 10, 15]);
  assert.equal(lin.at(15), 1);
  assert.equal(lin.at(0), 0);

  const log = chatScale([2, 40, 300], 6);
  assert.equal(log.log, true);
  assert.ok(log.ticks.every((t) => [1, 2, 5].includes(t / 10 ** Math.floor(Math.log10(t)))));
  assert.ok(log.ticks.length <= 6);
  assert.ok(log.at(2) > 0 && log.at(300) < 1 && log.at(40) > log.at(2));
  // Fewer ticks on a narrow chart: powers of ten only.
  assert.ok(chatScale([2, 40, 3000], 3).ticks.length <= 3);
  assert.equal(chatScale([], 6).log, false);
});

test("fieldHue: warm where many chats rarely end with the AI, green/yellow where it resolves", () => {
  const warm = fieldHue(0.9, 0.1);
  assert.ok(warm < 45 || warm > 330, `got ${warm}`);
  const good = fieldHue(0.5, 0.92);
  assert.ok(good > 80 && good < 170, `got ${good}`);
});

test("placeLabels: right first, then other sides, hidden when nothing fits", () => {
  const sides = placeLabels(
    [
      { id: "a", x: 50, y: 50, w: 60 },
      { id: "b", x: 50, y: 62, w: 60 }, // right and left of b clash with a's label / dot: above or below
      { id: "c", x: 395, y: 50, w: 60 }, // no room on the right
    ],
    400,
    200,
  );
  assert.deepEqual(sides.get("a"), { side: "right", x: 58 });
  assert.deepEqual(sides.get("b"), { side: "below", x: 50 });
  assert.deepEqual(sides.get("c"), { side: "left", x: 387 });
  const crowded = placeLabels([{ id: "a", x: 30, y: 10, w: 300 }, { id: "b", x: 30, y: 10, w: 300 }], 340, 20);
  assert.equal(crowded.get("b"), null);
  // Near a side, a label above slides inwards to fit.
  const edge = placeLabels([{ id: "a", x: 395, y: 100, w: 60 }, { id: "b", x: 360, y: 100, w: 4 }], 400, 200);
  assert.deepEqual(edge.get("a"), { side: "above", x: 370 });
});

test("placeLabels: two dots on one line, close together, long names: the labels never overlap", () => {
  // The 7-day map had Onboarding and Account Settings on one line, ~100px apart, running into each other.
  const width = 600;
  const points = [
    { id: "a", x: 180, y: 200, w: labelWidth("Account Settings") },
    { id: "b", x: 80, y: 200, w: labelWidth("Onboarding and setup") },
    { id: "c", x: 240, y: 200, w: labelWidth("Workspace settings") },
  ];
  const sides = placeLabels(points, width, 400);
  const boxes = points.flatMap((p) => {
    const s = sides.get(p.id);
    return s ? [labelBox(p, s.side, width)] : [];
  });
  assert.ok(boxes.length >= 2, "at least two labels fit");
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) assert.ok(!boxesMeet(boxes[i]!, boxes[j]!, LABEL_GAP - 0.01), `labels ${i} and ${j} overlap`);
});

test("spreadDots and shortLabel", () => {
  const out = spreadDots([{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 40, y: 10 }]);
  assert.equal(out[0]!.x, 10);
  assert.notEqual(out[1]!.x, 10);
  assert.equal(out[2]!.x, 40);
  assert.equal(shortLabel("Short"), "Short");
  assert.equal(shortLabel("A very long topic name that goes on").length, 24);
});
