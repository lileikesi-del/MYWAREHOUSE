"use client";

import { useCallback, useRef, type Dispatch, type RefObject } from "react";
import { ChristmasCard3D, type CardHandle, type CardPick } from "@/components/ChristmasCard3D";
import { displayElements, slotFont, slotText, toLetterDraft, type EditorAction, type EditorElement, type EditorState } from "@/lib/editor/editorState";
import { slotAt, TEXT_SLOTS } from "@/lib/card/slots";
import { pinchTransform, type Point } from "@/lib/editor/gestures";
import { scaleAcross, shiftAcross } from "@/lib/card/elementBounds";
import type { PageId } from "@/lib/editor/pages";
import type { Face, PaperStock, TextSlot } from "@/lib/letter/model";
import { SelectionOverlay } from "./SelectionOverlay";
import { SlotEditor } from "./SlotEditor";
import { useSettleGlide } from "./useSettleGlide";

interface Props {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  paper?: PaperStock;
  page: PageId;
  zoom: number;
  /** Preview: the card exactly as the recipient sees it, no editing. */
  preview: boolean;
  /** The style picker shows the cover only: a tap must not open the card. */
  locked?: boolean;
  onPage(page: PageId): void;
  card: RefObject<CardHandle | null>;
  /** The text slot being written in, if any (spec §6.2). */
  editingSlot?: TextSlot | null;
  onEditSlot?(slot: TextSlot | null): void;
}

/** The slot a tap lands on: its drawn text, its grey hint, or its empty box. */
function slotOfPick(elements: EditorElement[], pick: CardPick): TextSlot | null {
  if (pick.uid) {
    const el = elements.find((e) => e.uid === pick.uid);
    if (el?.kind === "sticker") return null;
    if (el?.kind === "text" && el.slot) return el.slot;
    const hint = /^hint-(greeting|body|signature)$/.exec(pick.uid);
    if (hint) return hint[1] as TextSlot;
  }
  return slotAt(pick.face, pick.x, pick.y);
}

/**
 * The editor's 100%: the gallery framing leaves room for a floating dock;
 * here the canvas has its own space, so the card can fill more of it.
 */
const EDITOR_FIT = 1.3;

/** Only on desktop: a phone's open card is already width-limited. */
function editorFit(): number {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches ? EDITOR_FIT : 1;
}

type Gesture =
  | {
      kind: "drag";
      uid: string;
      /** The page it is on now: a drag can carry it across the fold. */
      face: Face;
      /** Element centre minus the grab point, in that page's fractions. */
      grab: Point;
      scale: number;
      recorded: boolean;
    }
  | {
      kind: "pinch";
      uid: string;
      face: Face;
      start: { a: Point; b: Point };
      startMid: CardPick | null;
      from: { x: number; y: number; scale: number; rotation: number };
      recorded: boolean;
    };

/**
 * The card is the canvas (spec §4.3, §13): pick, drag, pinch and handles act
 * on the 3D pages directly. Tapping an element on either page edits it.
 */
export function CardEditor({ state, dispatch, paper, page, zoom, preview, locked = false, onPage, card, editingSlot = null, onEditSlot }: Props) {
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const editing = page === "inside" && !preview;
  const selected = editing ? (state.draft.elements.find((e) => e.uid === state.selected) ?? null) : null;
  const byUid = (uid: string): EditorElement | undefined => state.draft.elements.find((e) => e.uid === uid);
  const move = (uid: string, patch: Partial<Pick<EditorElement, "face" | "x" | "y" | "scale" | "rotation">>, record: boolean) =>
    dispatch({ type: "transform", uid, patch, record });
  // Gestures move freely, over the fold too, drawn over the paper so the other
  // page cannot hide them; on release it glides onto its page and is put back.
  const lift = (uid: string | null) => card.current?.lift(uid);
  const putDown = useCallback(() => card.current?.lift(null), [card]);
  const { glide, stop: stopGlide } = useSettleGlide(card, dispatch, putDown);
  const release = (uid: string, moved: boolean) => (moved ? glide(uid) : putDown());

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-slot-editor]")) return;
    if (!editing) {
      // On the cover a tap opens the card to the inside pages — unless the
      // style picker is up, where the cover must stay closed.
      if (page === "cover" && !preview && !locked) onPage("inside");
      return;
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);
    stopGlide();
    putDown();

    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()];
      const el = byUid(gesture.current.uid);
      if (!el) return;
      gesture.current = {
        kind: "pinch",
        uid: el.uid,
        face: el.face,
        start: { a, b },
        startMid: card.current?.pick((a.x + b.x) / 2, (a.y + b.y) / 2) ?? null,
        from: { x: el.x, y: el.y, scale: el.scale, rotation: el.rotation },
        recorded: false,
      };
      lift(el.uid);
      return;
    }
    if (pointers.current.size > 1) return;

    const pick = card.current?.pick(e.clientX, e.clientY) ?? null;
    const slot = pick && onEditSlot ? slotOfPick(state.draft.elements, pick) : null;
    if (slot) {
      dispatch({ type: "select", uid: null });
      onEditSlot?.(slot);
      gesture.current = null;
      return;
    }
    if (editingSlot) onEditSlot?.(null);
    if (pick?.uid) {
      const el = byUid(pick.uid);
      dispatch({ type: "select", uid: pick.uid });
      if (el) {
        gesture.current = {
          kind: "drag",
          uid: el.uid,
          face: el.face,
          grab: { x: el.x - pick.x, y: el.y - pick.y },
          scale: el.scale,
          recorded: false,
        };
        lift(el.uid);
      }
    } else {
      dispatch({ type: "select", uid: null });
      if (pick) dispatch({ type: "focus-face", face: pick.face });
      gesture.current = null;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "drag") {
      const at = card.current?.pick(e.clientX, e.clientY);
      const el = byUid(g.uid);
      if (!at || !el) return;
      const across = at.face !== g.face;
      if (across) {
        // Over the other page: carry it there at the same size on the paper.
        g.grab = shiftAcross(g.grab, g.face, at.face);
        g.scale = scaleAcross(g.scale, g.face, at.face);
        g.face = at.face;
      }
      const pos = { x: at.x + g.grab.x, y: at.y + g.grab.y };
      move(g.uid, { ...pos, ...(g.face === el.face ? {} : { face: g.face, scale: g.scale }) }, !g.recorded);
      g.recorded = true;
      return;
    }
    const [a, b] = [...pointers.current.values()];
    if (!a || !b) return;
    const t = pinchTransform(g.start, { a, b });
    const mid = card.current?.pick((a.x + b.x) / 2, (a.y + b.y) / 2);
    const shift = mid && g.startMid && mid.face === g.face ? { x: mid.x - g.startMid.x, y: mid.y - g.startMid.y } : { x: 0, y: 0 };
    move(g.uid, { scale: g.from.scale * t.scale, rotation: g.from.rotation + t.rotation, x: g.from.x + shift.x, y: g.from.y + shift.y }, !g.recorded);
    g.recorded = true;
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0 || g?.kind === "pinch") {
      if (g) release(g.uid, g.recorded);
      gesture.current = null;
    }
  };

  return (
    <div
      className="relative h-full w-full touch-none select-none"
      // Keep focus where it is (e.g. a text field in the side panel).
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest("[data-slot-editor]")) e.preventDefault();
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ cursor: page === "cover" && !preview ? (locked ? "grab" : "pointer") : "default" }}
    >
      <ChristmasCard3D
        templateId={state.draft.templateId}
        message=""
        signature=""
        isOpen={page === "inside"}
        isPaused={false}
        // A working surface: the card is simply there, no fly-in each time the editor opens.
        flyIn={false}
        // While editing, the slots are written by the page itself (SlotEditor) so
        // clicking into one changes nothing on screen; the card draws them only
        // in preview and for the recipient.
        elements={
          preview
            ? toLetterDraft(state.draft).elements
            : editing
              ? state.draft.elements.filter((el) => !(el.kind === "text" && el.slot))
              : displayElements(state.draft)
        }
        customStickers={state.draft.customStickers}
        paper={paper}
        zoom={zoom * editorFit()}
        // The style picker shows the cover only: drag to turn it, but with no
        // onToggleOpen a tap cannot open it (the cover's own sparkles still play).
        interactive={locked && page === "cover" && !preview}
        handleRef={card}
      />
      {/* Writing on the card: just the page and the caret. */}
      {editing &&
        onEditSlot &&
        TEXT_SLOTS.map((slot) => (
          <SlotEditor
            key={slot}
            card={card}
            slot={slot}
            active={editingSlot === slot}
            text={slotText(state.draft, slot)}
            font={slotFont(state.draft, slot)}
            onChange={(text) => dispatch({ type: "set-slot-text", slot, text })}
            onDone={() => onEditSlot(null)}
          />
        ))}
      {selected && (
        <SelectionOverlay
          card={card}
          uid={selected.uid}
          current={{ scale: selected.scale, rotation: selected.rotation }}
          onTransform={(patch, record) => move(selected.uid, patch, record)}
          onGrab={() => {
            stopGlide();
            lift(selected.uid);
          }}
          onRelease={(moved) => release(selected.uid, moved)}
          onDelete={() => dispatch({ type: "remove", uid: selected.uid })}
        />
      )}
    </div>
  );
}
