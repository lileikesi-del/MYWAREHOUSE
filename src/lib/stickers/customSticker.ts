import type { CustomSticker } from "@/lib/letter/model";

/** A phone photo is plenty at 8 MB; the card only needs a small cutout. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Baked stickers are 512 px on the long side, so the upload matches that. */
const MAX_SIDE = 512;
/** Keep the whole letter comfortably below D1's row limit. */
const MAX_DATA_URL = 90_000;
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("这张图片打不开，换一张试试"));
    img.src = src;
  });
}

/** Bounding box of the visible pixels, in the scanned canvas's coordinates. */
function visibleBounds(data: ImageData): { x: number; y: number; w: number; h: number } {
  const { width, height } = data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data.data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, w: width, h: height };
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function encode(canvas: HTMLCanvasElement): string {
  const webp = canvas.toDataURL("image/webp", 0.86);
  // Safari falls back to PNG for some canvases; either is fine.
  return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
}

async function fingerprint(src: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(src));
    return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // A tiny fallback for contexts without SubtleCrypto.
  let hash = 2166136261;
  for (let i = 0; i < src.length; i += 1) {
    hash ^= src.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Turn a picked image into a sticker asset small enough to travel inside the
 * letter: transparent margins trimmed, resized to 512 px, encoded as WebP.
 */
export async function prepareCustomSticker(file: File): Promise<CustomSticker> {
  if (!ACCEPTED.has(file.type)) throw new Error("请上传 PNG、JPG 或 WebP 图片");
  if (file.size > MAX_FILE_BYTES) throw new Error("图片不能超过 8MB");

  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  // Scan at a manageable size, then map the visible box back to the original.
  const scanScale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  const scan = document.createElement("canvas");
  scan.width = Math.max(1, Math.round(img.naturalWidth * scanScale));
  scan.height = Math.max(1, Math.round(img.naturalHeight * scanScale));
  const scanCtx = scan.getContext("2d", { willReadFrequently: true });
  if (!scanCtx) throw new Error("浏览器不支持图片处理");
  scanCtx.drawImage(img, 0, 0, scan.width, scan.height);
  const box = visibleBounds(scanCtx.getImageData(0, 0, scan.width, scan.height));
  const sx = Math.floor(box.x / scanScale);
  const sy = Math.floor(box.y / scanScale);
  const sw = Math.min(img.naturalWidth - sx, Math.ceil(box.w / scanScale));
  const sh = Math.min(img.naturalHeight - sy, Math.ceil(box.h / scanScale));

  const draw = (scale: number): HTMLCanvasElement => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片处理");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
  let canvas = draw(scale);
  let src = encode(canvas);
  if (src.length > MAX_DATA_URL) {
    canvas = draw(scale * 0.7);
    src = encode(canvas);
  }
  if (src.length > MAX_DATA_URL) throw new Error("图片细节太多，换一张更简单的图试试");

  const id = `custom-${await fingerprint(src)}`;
  const label = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 40) || "我的贴纸";
  return { id, label, material: "paint", src };
}
