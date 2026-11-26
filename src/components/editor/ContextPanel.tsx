"use client";

import { type Dispatch, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import { CARD_ASSETS } from "@/lib/cardAssets";
import { PAPER_STOCKS } from "@/lib/card/paperStocks";
import { settle, type ElementShape } from "@/lib/card/elementBounds";
import { slotFont, type EditorAction, type EditorElement, type EditorState } from "@/lib/editor/editorState";
import { LIMITS, PAPER_STOCK_IDS, type FontId, type TextSlot } from "@/lib/letter/model";
import { CARD_TEMPLATES } from "@/lib/templates";
import type { CardTemplateId } from "@/lib/types";
import { nanoid } from "nanoid";
import { StickerTray } from "./StickerTray";
import { MusicUpload } from "./MusicUpload";

export type Tool = "style" | "stickers" | "text" | "paper" | "music";

export const TOOL_LABELS: Record<Tool, string> = { style: "封面", stickers: "贴纸", text: "文字", paper: "纸张", music: "音乐" };

interface Props {
  tool: Tool;
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  /** The slot being written in; the font buttons act on it (body when none). */
  editingSlot: TextSlot | null;
  onAddSticker(id: string, at?: { clientX: number; clientY: number }): void;
  onTemplate(id: CardTemplateId): void;
  /** A loaded element's size at scale 1, so the sliders keep it on its page. */
  shapeOf(uid: string): ElementShape | null;
}

/** Ready-made blessings: one tap writes it into the body (spec §6.5). */
const BLESSINGS = ["圣诞快乐，愿你被温柔以待。", "Merry Christmas!", "愿所有美好如期而至。"];

/** Font only, no ink (spec §6.3). */
export const SLOT_FONTS: { id: FontId; label: string; style: React.CSSProperties }[] = [
  { id: "hand-zh", label: "手写", style: { fontFamily: "var(--font-hand-zh), Kaiti SC, serif" } },
  { id: "hand-en", label: "English", style: { fontFamily: "var(--font-caveat), cursive", fontStyle: "italic" } },
  { id: "serif", label: "宋体", style: { fontFamily: "Songti SC, STSong, serif" } },
];

const SLOT_LABELS: Record<TextSlot, string> = { greeting: "称呼", body: "正文", signature: "落款" };

/** Font buttons for the slot being written in. They keep the field focused. */
export function FontChips({ slot, current, onPick }: { slot: TextSlot; current: FontId; onPick(font: FontId): void }) {
  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-medium text-stone-500">字体 · {SLOT_LABELS[slot]}</span>
      <div className="flex gap-1.5">
        {SLOT_FONTS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={current === f.id}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(f.id)}
            style={f.style}
            className={`h-9 flex-1 rounded-full text-sm transition ${current === f.id ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-700 hover:bg-stone-200"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="px-4 pb-2 pt-4">
        <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
        {hint && <p className="mt-0.5 text-[11px] text-stone-400">{hint}</p>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

function StickerProps({ el, dispatch, shapeOf }: { el: EditorElement; dispatch: Dispatch<EditorAction>; shapeOf(uid: string): ElementShape | null }) {
  const deg = Math.round((el.rotation * 180) / Math.PI);
  // Growing or turning near the fold nudges it back onto its page.
  const set = (patch: { scale?: number; rotation?: number }) =>
    dispatch({ type: "transform", uid: el.uid, patch: settle(el, shapeOf(el.uid), patch), record: true });
  return (
    <Section title="贴纸" hint="也可以直接在卡片上拖动、拉角上的手柄">
      <div className="space-y-4 px-4 pb-4">
        <label className="block text-xs text-stone-600">
          大小 · {Math.round(el.scale * 100)}%
          <input
            type="range"
            min={LIMITS.minScale}
            max={LIMITS.maxScale}
            step={0.05}
            value={el.scale}
            onChange={(e) => set({ scale: Number(e.target.value) })}
            className="mt-1 w-full accent-stone-900"
          />
        </label>
        <label className="block text-xs text-stone-600">
          旋转 · {deg}°
          <input
            type="range"
            min={-180}
            max={180}
            step={1}
            value={deg}
            onChange={(e) => set({ rotation: (Number(e.target.value) * Math.PI) / 180 })}
            className="mt-1 w-full accent-stone-900"
          />
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={() => dispatch({ type: "layer", uid: el.uid, dir: 1 })} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-stone-100 py-2 text-xs text-stone-700 hover:bg-stone-200">
            <ArrowUp className="h-3.5 w-3.5" /> 上移一层
          </button>
          <button type="button" onClick={() => dispatch({ type: "layer", uid: el.uid, dir: -1 })} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-stone-100 py-2 text-xs text-stone-700 hover:bg-stone-200">
            <ArrowDown className="h-3.5 w-3.5" /> 下移一层
          </button>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => dispatch({ type: "duplicate", uid: el.uid, newUid: nanoid(8) })} className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-stone-100 py-2 text-xs text-stone-700 hover:bg-stone-200">
            <Copy className="h-3.5 w-3.5" /> 复制
          </button>
          <button type="button" onClick={() => dispatch({ type: "remove", uid: el.uid })} className="flex flex-1 items-center justify-center gap-1 rounded-lg py-2 text-xs text-stone-500 hover:bg-red-50 hover:text-red-600">
            <Trash2 className="h-3.5 w-3.5" /> 删除
          </button>
        </div>
      </div>
    </Section>
  );
}

/** Right-hand panel: follows what the sender is doing (spec §13.2). */
export function ContextPanel({ tool, state, dispatch, editingSlot, onAddSticker, onTemplate, shapeOf }: Props) {
  const selected = state.draft.elements.find((e) => e.uid === state.selected) ?? null;
  if (selected?.kind === "sticker") return <StickerProps el={selected} dispatch={dispatch} shapeOf={shapeOf} />;

  const page = state.focusFace === "inside-left" ? "左页" : "右页";
  switch (tool) {
    case "style":
      return (
        <Section title="封面" hint="换封面插画，你写的内容和贴纸会保留">
          <ul className="grid grid-cols-2 gap-2 px-3 pb-4">
            {CARD_TEMPLATES.map((t) => {
              const active = state.draft.templateId === t.id;
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    aria-label={t.name || t.id}
                    onClick={() => onTemplate(t.id)}
                    className="group relative block w-full p-1.5"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={CARD_ASSETS[t.id].coverSrc}
                      alt=""
                      className={`aspect-[5/7] w-full rounded-lg object-cover transition ${
                        active
                          ? "ring-2 ring-stone-800 ring-offset-2 ring-offset-white"
                          : "ring-1 ring-stone-200 group-hover:-translate-y-0.5 group-hover:shadow-md"
                      }`}
                    />
                    {active && (
                      <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-stone-800 text-white shadow">
                        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" />
                        </svg>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Section>
      );
    case "stickers":
      return (
        <Section title="贴纸" hint={`点一下放到${page}，连点会叠成一叠；也可以拖到卡片上`}>
          <StickerTray
            onTap={(id) => onAddSticker(id)}
            onDrop={(id, clientX, clientY) => onAddSticker(id, { clientX, clientY })}
            customStickers={state.draft.customStickers}
            onUpload={(sticker) => dispatch({ type: "add-custom-sticker", sticker })}
            onRemoveCustom={(id) => dispatch({ type: "remove-custom-sticker", id })}
          />
        </Section>
      );
    case "text": {
      const slot = editingSlot ?? "body";
      return (
        <Section title="文字" hint="点卡片上的称呼、正文或落款，直接在纸上写">
          <div className="space-y-4 px-4 pb-4">
            <FontChips slot={slot} current={slotFont(state.draft, slot)} onPick={(font) => dispatch({ type: "set-slot-font", slot, font })} />
            <div className="space-y-1.5">
              <span className="block text-[11px] font-medium text-stone-500">常用祝福 · 点一下写进正文</span>
              {BLESSINGS.map((text) => (
                <button
                  key={text}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => dispatch({ type: "set-slot-text", slot: "body", text })}
                  className="block w-full rounded-lg bg-stone-50 px-3 py-1.5 text-left text-xs text-stone-700 hover:bg-stone-100"
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        </Section>
      );
    }
    case "paper":
      return (
        <Section title="纸张" hint="改变内页和纸边的质感">
          <ul className="space-y-2 px-4 pb-4">
            {PAPER_STOCK_IDS.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  aria-pressed={state.draft.paper === p}
                  onClick={() => dispatch({ type: "set", patch: { paper: p } })}
                  className={`flex w-full items-center gap-3 rounded-xl p-2 text-left text-sm ${state.draft.paper === p ? "bg-stone-900 text-white" : "hover:bg-stone-100"}`}
                >
                  <span
                    aria-hidden
                    className="h-9 w-9 shrink-0 rounded-lg ring-1 ring-stone-200"
                    style={{
                      backgroundColor: PAPER_STOCKS[p].swatch,
                      backgroundImage: PAPER_STOCKS[p].grain,
                    }}
                  />
                  {PAPER_STOCKS[p].label}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      );
    case "music":
      return (
        <Section title="音乐">
          <div className="px-4 pb-4">
            <MusicUpload
              audioName={state.draft.audioName}
              audioUrl={state.draft.audioUrl}
              onChange={(audio) => dispatch({ type: "set", patch: { audioUrl: audio?.url ?? null, audioName: audio?.name ?? null } })}
            />
          </div>
        </Section>
      );
  }
}
