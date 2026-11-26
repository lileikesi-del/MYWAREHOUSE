import { describe, expect, it } from "vitest";
import { LIMITS } from "@/lib/letter/model";
import { createEditorState, createInitialDraft, editorReducer, type EditorAction, type EditorState } from "./editorState";
import { clampZoom, pageLabel, PAGES, stepZoom, ZOOM_MAX, ZOOM_MIN } from "./pages";

const run = (s: EditorState, ...a: EditorAction[]) => a.reduce(editorReducer, s);
const fresh = () => createEditorState(createInitialDraft("winter-moonlight"));
const add = (uid: string, face: "inside-left" | "inside-right" = "inside-left"): EditorAction => ({ type: "add-sticker", stickerId: "holly", face, uid });
const z = (s: EditorState, uid: string) => s.draft.elements.find((e) => e.uid === uid)?.z;

describe("redo", () => {
  it("restores what undo took back", () => {
    const s = run(fresh(), add("a"), { type: "transform", uid: "a", patch: { x: 0.1 }, record: true }, { type: "undo" }, { type: "redo" });
    expect(s.draft.elements.find((e) => e.uid === "a")?.x).toBe(0.1);
  });

  it("is cleared by a new edit after undo", () => {
    const s = run(fresh(), add("a"), { type: "undo" }, add("b"));
    expect(s.future).toHaveLength(0);
    expect(run(s, { type: "redo" }).draft.elements.some((e) => e.uid === "a")).toBe(false);
  });
});

describe("layer", () => {
  it("moves an element above the next one on its face", () => {
    const s = run(fresh(), add("a"), add("b"), { type: "layer", uid: "a", dir: 1 });
    expect(z(s, "a")).toBeGreaterThan(z(s, "b") ?? 0);
  });

  it("does nothing at the top", () => {
    const before = run(fresh(), add("a"), add("b"));
    expect(run(before, { type: "layer", uid: "b", dir: 1 }).draft.elements).toEqual(before.draft.elements);
  });
});

describe("focusFace", () => {
  it("starts on the right page", () => {
    expect(fresh().focusFace).toBe("inside-right");
  });

  it("follows the page last added to or selected on", () => {
    const s = run(fresh(), { type: "set-slot-text", slot: "body", text: "hi" }, add("a", "inside-left"));
    expect(s.focusFace).toBe("inside-left");
    const msg = s.draft.elements.find((e) => e.kind === "text")!.uid;
    const t = run(s, { type: "select", uid: msg });
    expect(t.focusFace).toBe("inside-right");
  });

  it("can be set by touching a blank page", () => {
    expect(run(fresh(), { type: "focus-face", face: "inside-left" }).focusFace).toBe("inside-left");
  });
});

describe("pages and zoom", () => {
  it("has the cover then the inside spread", () => {
    expect(PAGES).toEqual(["cover", "inside"]);
    expect(pageLabel("inside")).toBe("内页 · 2/2");
  });

  it("clamps zoom to its range", () => {
    expect(clampZoom(3)).toBe(ZOOM_MAX);
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
  });

  it("steps zoom by 20%", () => {
    expect(stepZoom(1, 1)).toBeCloseTo(1.2);
    expect(stepZoom(1, -1)).toBeCloseTo(0.8);
  });
});

describe("transform across pages", () => {
  const at = (s: EditorState, uid: string) => s.draft.elements.find((e) => e.uid === uid);

  it("moves a sticker to the other page, on top there", () => {
    const s = run(fresh(), add("r", "inside-right"), add("a", "inside-left"), {
      type: "transform",
      uid: "a",
      patch: { face: "inside-right", x: 0.2 },
      record: true,
    });
    expect(at(s, "a")?.face).toBe("inside-right");
    expect(at(s, "a")?.x).toBe(0.2);
    expect(at(s, "a")?.z).toBeGreaterThan(at(s, "r")?.z ?? 0);
    expect(s.focusFace).toBe("inside-right");
  });

  it("stays put when the other page is full", () => {
    const full = Array.from({ length: LIMITS.stickersPerFace }, (_, i) => add(`r${i}`, "inside-right"));
    const s = run(fresh(), ...full, add("a", "inside-left"), { type: "transform", uid: "a", patch: { face: "inside-right", x: 0.2 }, record: true });
    expect(at(s, "a")?.face).toBe("inside-left");
    expect(at(s, "a")?.x).toBe(0.5);
  });
});

describe("repeated taps", () => {
  const spot = (s: EditorState, uid: string) => s.draft.elements.find((e) => e.uid === uid);

  it("fans the copies of one sticker out instead of stacking them at one point", () => {
    const s = run(fresh(), add("a"), add("b"), add("c"), add("d"));
    const spots = s.draft.elements.map((e) => `${e.x.toFixed(3)},${e.y.toFixed(3)}`);
    expect(new Set(spots).size).toBe(4);
    // The first copy keeps the middle; the rest stay close to it.
    expect(spot(s, "a")?.x).toBe(0.5);
    for (const e of s.draft.elements) {
      expect(e.x).toBeGreaterThan(0);
      expect(e.x).toBeLessThan(1);
      expect(e.y).toBeGreaterThan(0);
      expect(e.y).toBeLessThan(1);
    }
  });

  it("replays the same pile through undo and redo", () => {
    const s = run(fresh(), add("a"), add("b"), add("c"));
    const x = spot(s, "c")?.x;
    const back = run(s, { type: "undo" }, { type: "redo" });
    expect(spot(back, "c")?.x).toBe(x);
  });
});

describe("transform bounds", () => {
  it("lets a centre into the right panel's margin but not off the card", () => {
    const s = run(fresh(), add("a", "inside-right"), { type: "transform", uid: "a", patch: { x: 1.05 }, record: true });
    expect(s.draft.elements.find((e) => e.uid === "a")?.x).toBe(1.05);
    const t = run(s, { type: "transform", uid: "a", patch: { x: 3 }, record: true });
    expect(t.draft.elements.find((e) => e.uid === "a")?.x).toBeLessThan(1.2);
  });
});

describe("settle", () => {
  const shape = { widthFraction: 0.3, aspect: 1 };
  const xOf = (s: EditorState) => s.draft.elements.find((e) => e.uid === "a")?.x ?? NaN;
  const overFold = () => run(fresh(), add("a", "inside-left"), { type: "transform", uid: "a", patch: { x: 1 }, record: true });

  it("moves part of the way onto the page, from where it is now", () => {
    const s = run(overFold(), { type: "settle", uid: "a", shape, amount: 0.5 });
    expect(xOf(s)).toBeCloseTo(0.925);
  });

  it("lands fully on the page at amount 1, without an undo step", () => {
    const before = overFold();
    const s = run(before, { type: "settle", uid: "a", shape, amount: 1 });
    expect(xOf(s)).toBeCloseTo(0.85);
    expect(s.past).toHaveLength(before.past.length);
  });
});
