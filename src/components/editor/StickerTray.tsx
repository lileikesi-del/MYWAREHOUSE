"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Plus, X } from "lucide-react";
import { LIMITS, type CustomSticker } from "@/lib/letter/model";
import { prepareCustomSticker } from "@/lib/stickers/customSticker";
import { loadStickerManifest } from "@/lib/stickers/stickerSurface";
import type { StickerEntry } from "@/lib/stickers/stickerManifest";

interface Props {
  /** Tap: drop the sticker in the middle of the current page. */
  onTap(id: string): void;
  /** Drag released at a screen point (desktop). */
  onDrop(id: string, clientX: number, clientY: number): void;
  /** Stickers uploaded for this letter. */
  customStickers?: CustomSticker[];
  onUpload?(sticker: CustomSticker): void;
  onRemoveCustom?(id: string): void;
}

const DRAG_THRESHOLD = 6;

interface Ghost {
  src: string;
  x: number;
  y: number;
}

function StickerThumb({ entry, onTap, onDrop, onGhost }: { entry: StickerEntry; onTap(id: string): void; onDrop(id: string, x: number, y: number): void; onGhost(ghost: Ghost | null): void }) {
  const press = useRef<{ id: string; src: string; x: number; y: number; dragging: boolean } | null>(null);
  return (
    <button
      type="button"
      title={entry.label}
      aria-label={`添加贴纸：${entry.label}`}
      className="aspect-square w-full touch-none rounded-xl bg-stone-50 p-1.5 ring-1 ring-stone-200 transition hover:bg-stone-100"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { id: entry.id, src: entry.src, x: e.clientX, y: e.clientY, dragging: false };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (!p) return;
        if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD) p.dragging = true;
        if (p.dragging) onGhost({ src: p.src, x: e.clientX, y: e.clientY });
      }}
      onPointerUp={(e) => {
        const p = press.current;
        press.current = null;
        onGhost(null);
        if (!p) return;
        if (p.dragging) onDrop(p.id, e.clientX, e.clientY);
        else onTap(p.id);
      }}
      onPointerCancel={() => {
        press.current = null;
        onGhost(null);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={entry.src} alt="" className="h-full w-full object-contain" draggable={false} />
    </button>
  );
}

export function StickerTray({ onTap, onDrop, customStickers = [], onUpload, onRemoveCustom }: Props) {
  const [stickers, setStickers] = useState<StickerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  useEffect(() => {
    loadStickerManifest()
      .then((m) => setStickers(m.stickers))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "贴纸加载失败"));
  }, []);

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // picking the same file again still fires
    if (!file || !onUpload) return;
    setUploading(true);
    setUploadError(null);
    try {
      onUpload(await prepareCustomSticker(file));
    } catch (e: unknown) {
      setUploadError(e instanceof Error ? e.message : "贴纸处理失败");
    } finally {
      setUploading(false);
    }
  };

  if (error) return <p className="px-4 py-3 text-xs text-red-600">{error}</p>;

  return (
    <div className="space-y-4 px-3 pb-4">
      <section>
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-[11px] font-medium text-stone-500">我的贴纸</span>
          {onUpload && (
            <label className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${customStickers.length >= LIMITS.customStickers ? "cursor-not-allowed bg-stone-100 text-stone-400" : "bg-stone-900 text-white hover:bg-stone-800"}`}>
              <Plus className="h-3.5 w-3.5" />
              上传
              <input
                type="file"
                accept="image/png,image/webp,image/jpeg"
                className="sr-only"
                disabled={uploading || customStickers.length >= LIMITS.customStickers}
                onChange={(e) => void pickFile(e)}
              />
            </label>
          )}
        </div>
        {customStickers.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-300 px-3 py-4 text-center text-[11px] leading-relaxed text-stone-400">
            上传自己的图片做贴纸
            <br />
            建议用透明背景的 PNG / WebP，最多 {LIMITS.customStickers} 张
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {customStickers.map((s) => (
              <div key={s.id} className="relative">
                <StickerThumb entry={s} onTap={onTap} onDrop={onDrop} onGhost={setGhost} />
                {onRemoveCustom && (
                  <button
                    type="button"
                    aria-label={`删除贴纸：${s.label}`}
                    title="从我的贴纸里删除"
                    onClick={() => onRemoveCustom(s.id)}
                    className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-stone-900 text-white shadow ring-2 ring-white hover:bg-red-600"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {uploading && <p className="mt-2 px-1 text-[11px] text-stone-500">正在处理图片…</p>}
        {uploadError && (
          <p role="alert" className="mt-2 px-1 text-[11px] text-red-600">
            {uploadError}
          </p>
        )}
      </section>

      <section>
        <span className="block px-1 pb-2 text-[11px] font-medium text-stone-500">冬日贴纸</span>
        <div className="grid grid-cols-3 gap-2" role="listbox" aria-label="冬日贴纸">
          {stickers.map((s) => (
            <StickerThumb key={s.id} entry={s} onTap={onTap} onDrop={onDrop} onGhost={setGhost} />
          ))}
        </div>
      </section>

      {ghost && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={ghost.src}
          alt=""
          className="pointer-events-none fixed z-50 h-24 w-24 -translate-x-1/2 -translate-y-1/2 object-contain opacity-90 drop-shadow-lg"
          style={{ left: ghost.x, top: ghost.y }}
        />
      )}
    </div>
  );
}
