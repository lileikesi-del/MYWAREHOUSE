import * as THREE from "three";
import { applyBow, captureBendBuffers, type BendBuffers } from "@/lib/cardBend";
import type { CanvasLike } from "@/lib/canvasFactory";
import type { CardElement, Face } from "@/lib/letter/model";
import { MATERIAL_PRESETS } from "@/lib/reliefCore";
import { loadStickerManifest, loadStickerSurface } from "@/lib/stickers/stickerSurface";
import type { StickerEntry } from "@/lib/stickers/stickerManifest";
import { FACE_FRAMES, quadCorners } from "./elementLayout";
import type { ElementShape } from "./elementBounds";
import { slotPlacement, SLOTS } from "./slots";
import { INK_COLORS, renderSlotImage, renderTextImage, TEXT_LINE_FRACTION } from "./textCanvas";

/**
 * How strongly foil stickers reflect the studio. The scene's own environment is
 * kept dim (0.25) for the cover; metal barely takes the ambient light that
 * brightens the paper, so at 0.25 foil read as dark bronze between glints.
 */
export const FOIL_ENV_INTENSITY = 1.0;

/** A sticker at scale 1 is this fraction of its face's width. */
export const STICKER_WIDTH_FRACTION = 0.3;
/** Columns of the element quad: enough to follow the panel's bow smoothly. */
const SEGMENTS = 8;

/** `hint`: an editor-only grey placeholder for an empty slot, never sent. */
export type LayerElement = CardElement & { uid?: string; hint?: boolean };

/** A slot's text sits where its slot is, whatever placement it carries. */
function placed(e: LayerElement): LayerElement {
  return e.kind === "text" && e.slot ? { ...e, ...slotPlacement(e.slot) } : e;
}

export interface FaceMount {
  /** Panel mesh the face belongs to; element meshes become its children. */
  parent: THREE.Object3D;
  /** Width the panel's bow is computed over (same value the card passes to applyBow). */
  bendWidth: number;
}

interface Entry {
  key: string;
  contentSig: string;
  placementSig: string;
  mesh: THREE.Mesh | null;
  buffers: BendBuffers | null;
  aspect: number;
  widthFraction: number;
  /** aspect and widthFraction are measured, not defaults (kept through a reload). */
  shaped: boolean;
  element: LayerElement;
  version: number;
}

export interface ElementLayer {
  sync(elements: LayerElement[]): void;
  applyBend(bends: Record<Face, number>): void;
  /** Meshes currently on the card, each with `userData.uid`. */
  meshes(): THREE.Mesh[];
  /** Size at scale 1 of a loaded element, or null until it has loaded. */
  shapeOf(uid: string): ElementShape | null;
  /**
   * While a gesture holds it, draw this element over the paper so the other
   * page cannot hide it at the fold. Its order among stickers and text keeps.
   */
  lift(uid: string | null): void;
  dispose(): void;
}

function contentSig(e: LayerElement): string {
  return e.kind === "sticker" ? `s:${e.stickerId}` : `t:${e.slot ?? ""}:${e.hint ? "h" : ""}:${e.font}:${e.ink}:${e.text}`;
}

function placementSig(e: LayerElement): string {
  return [e.face, e.x, e.y, e.scale, e.rotation, e.z].join(":");
}

/** A SEGMENTS×1 quad whose vertices sit in the panel's local frame. */
function buildGeometry(e: LayerElement, widthFraction: number, aspect: number): THREE.BufferGeometry {
  const [tl, tr, br, bl] = quadCorners(e, widthFraction, aspect);
  const geo = new THREE.PlaneGeometry(1, 1, SEGMENTS, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  const outward = FACE_FRAMES[e.face].outward;
  for (let i = 0; i < pos.count; i += 1) {
    const u = uv.getX(i);
    const v = 1 - uv.getY(i); // 0 at the top as read
    const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u, z: tl.z };
    const bottom = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
    pos.setXYZ(i, top.x + (bottom.x - top.x) * v, top.y + (bottom.y - top.y) * v, top.z);
    nor.setXYZ(i, 0, 0, outward);
  }
  // On the mirrored face the corner mapping itself flips the winding, so the
  // front face already points along -z, toward the reader of the open card.
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

function canvasTexture(canvas: CanvasLike, color: boolean, anisotropy: number): THREE.CanvasTexture {
  // CanvasLike is always a real canvas at runtime on this path (the sticker
  // and text bakes run on the main thread).
  const tex = new THREE.CanvasTexture(canvas as HTMLCanvasElement);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const m of Array.isArray(material) ? material : [material]) {
    for (const value of Object.values(m)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    m.dispose();
  }
}

const SHARED_MATERIAL = {
  transparent: true,
  alphaTest: 0.04,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
} as const;

async function buildMaterial(e: LayerElement, anisotropy: number, customStickers: StickerEntry[]): Promise<{ material: THREE.Material; aspect: number; widthFraction: number } | null> {
  if (e.kind === "sticker") {
    const manifest = await loadStickerManifest();
    // Uploaded stickers travel with the letter, so they are looked up here
    // rather than in the built-in manifest.
    const entry = manifest.stickers.find((s) => s.id === e.stickerId) ?? customStickers.find((s) => s.id === e.stickerId);
    if (!entry) return null; // asset not delivered yet
    const sticker = await loadStickerSurface(entry);
    const surface = canvasTexture(sticker.surface, false, anisotropy);
    const params = {
      ...SHARED_MATERIAL,
      map: canvasTexture(sticker.image, true, anisotropy),
      normalMap: canvasTexture(sticker.normal, false, anisotropy),
      roughnessMap: surface,
      metalnessMap: surface,
      roughness: 1,
      metalness: 1,
    };
    const iridescence = MATERIAL_PRESETS[entry.material].iridescence;
    const material = iridescence > 0
      ? new THREE.MeshPhysicalMaterial({ ...params, iridescence, iridescenceIOR: 1.6 })
      : new THREE.MeshStandardMaterial(params);
    if (entry.material === "foil") {
      material.envMapIntensity = FOIL_ENV_INTENSITY;
      material.userData.foil = true;
    }
    return { material, aspect: sticker.aspect, widthFraction: STICKER_WIDTH_FRACTION };
  }
  if (e.slot) {
    const frame = FACE_FRAMES[e.face];
    const img = await renderSlotImage(e.text, e.slot, e.font, INK_COLORS[e.ink], frame.width / frame.height, Boolean(e.hint));
    const material = new THREE.MeshStandardMaterial({
      ...SHARED_MATERIAL,
      map: canvasTexture(img.canvas, true, anisotropy),
      roughness: 0.78,
      metalness: 0,
    });
    const box = SLOTS[e.slot].box;
    return { material, aspect: img.aspect, widthFraction: box.x1 - box.x0 };
  }
  const text = await renderTextImage(e.text, e.font, e.ink);
  const gold = e.ink === "gold";
  const material = new THREE.MeshStandardMaterial({
    ...SHARED_MATERIAL,
    map: canvasTexture(text.canvas, true, anisotropy),
    roughness: gold ? 0.3 : 0.78,
    metalness: gold ? 0.85 : 0,
  });
  const frame = FACE_FRAMES[e.face];
  const height = frame.height * TEXT_LINE_FRACTION * text.lineCount * 1.35;
  return { material, aspect: text.aspect, widthFraction: (height * text.aspect) / frame.width };
}

/**
 * Stickers and text as their own meshes on the inside faces (spec §9):
 * moving one never re-bakes a page, and each follows its panel's bow.
 */
export function createElementLayer(
  mounts: Record<Face, FaceMount>,
  anisotropy: number,
  /**
   * Applied to each sticker's material: the card passes its pointer-lamp gate,
   * so stickers glint like the cover's motifs instead of taking the lamp's full
   * light (which, on bright foil, overshot the bloom threshold into a haze).
   */
  decorateSticker?: (material: THREE.Material) => void,
  /** A getter: the editor can add an upload without rebuilding the layer. */
  customStickers?: () => StickerEntry[],
): ElementLayer {
  const entries = new Map<string, Entry>();
  const bends: Record<Face, number> = { "inside-left": 0, "inside-right": 0 };
  let disposed = false;
  let lifted: string | null = null;
  const applyLift = (entry: Entry) => {
    if (!entry.mesh) return;
    for (const m of Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material]) {
      m.depthTest = entry.key !== lifted;
    }
  };

  const place = (entry: Entry) => {
    if (!entry.mesh) return;
    const old = entry.mesh.geometry;
    const geo = buildGeometry(entry.element, entry.widthFraction, entry.aspect);
    entry.mesh.geometry = geo;
    entry.buffers = captureBendBuffers(geo);
    applyBow(geo, mounts[entry.element.face].bendWidth, bends[entry.element.face], entry.buffers);
    old.dispose();
    mounts[entry.element.face].parent.add(entry.mesh);
  };

  const remove = (entry: Entry) => {
    if (!entry.mesh) return;
    entry.mesh.removeFromParent();
    entry.mesh.geometry.dispose();
    disposeMaterial(entry.mesh.material);
    entry.mesh = null;
  };

  const load = async (entry: Entry) => {
    const version = ++entry.version;
    try {
      const built = await buildMaterial(entry.element, anisotropy, customStickers?.() ?? []);
      if (built && entry.element.kind === "sticker") decorateSticker?.(built.material);
      if (disposed || version !== entry.version || entries.get(entry.key) !== entry) {
        if (built) disposeMaterial(built.material);
        return;
      }
      remove(entry);
      if (!built) return;
      entry.aspect = built.aspect;
      entry.widthFraction = built.widthFraction;
      entry.shaped = true;
      entry.mesh = new THREE.Mesh(new THREE.BufferGeometry(), built.material);
      entry.mesh.userData.uid = entry.key;
      entry.mesh.renderOrder = 2 + entry.element.z;
      if (built.material.userData.foil) {
        // three honours a material's envMapIntensity only when the material
        // holds the environment itself, so foil borrows the scene's on first draw.
        entry.mesh.onBeforeRender = (_renderer, scene, _camera, _geometry, material) => {
          const m = material as THREE.MeshStandardMaterial;
          if (m.envMap || !scene.environment) return;
          m.envMap = scene.environment;
          m.needsUpdate = true;
        };
      }
      place(entry);
      applyLift(entry);
    } catch (error) {
      console.error("[card] element failed to load", error);
    }
  };

  return {
    sync(elements) {
      const seen = new Set<string>();
      elements.map(placed).forEach((element, index) => {
        const key = element.uid ?? `i${index}`;
        seen.add(key);
        const existing = entries.get(key);
        const cSig = contentSig(element);
        const pSig = placementSig(element);
        if (!existing || existing.contentSig !== cSig || existing.element.face !== element.face) {
          const entry: Entry = existing ?? {
            key,
            contentSig: cSig,
            placementSig: pSig,
            mesh: null,
            buffers: null,
            aspect: 1,
            widthFraction: STICKER_WIDTH_FRACTION,
            shaped: false,
            element,
            version: 0,
          };
          entry.contentSig = cSig;
          entry.placementSig = pSig;
          entry.element = element;
          entries.set(key, entry);
          void load(entry);
        } else if (existing.placementSig !== pSig) {
          existing.placementSig = pSig;
          existing.element = element;
          if (existing.mesh) existing.mesh.renderOrder = 2 + element.z;
          place(existing);
        }
      });
      for (const [key, entry] of entries) {
        if (!seen.has(key)) {
          entry.version += 1;
          remove(entry);
          entries.delete(key);
        }
      }
    },

    applyBend(next) {
      for (const face of ["inside-left", "inside-right"] as const) bends[face] = next[face];
      for (const entry of entries.values()) {
        if (entry.mesh && entry.buffers) {
          applyBow(entry.mesh.geometry, mounts[entry.element.face].bendWidth, bends[entry.element.face], entry.buffers);
        }
      }
    },

    meshes() {
      return [...entries.values()].flatMap((e) => (e.mesh ? [e.mesh] : []));
    },

    lift(uid) {
      lifted = uid;
      for (const entry of entries.values()) applyLift(entry);
    },

    shapeOf(uid) {
      const entry = entries.get(uid);
      return entry?.shaped ? { widthFraction: entry.widthFraction, aspect: entry.aspect } : null;
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) remove(entry);
      entries.clear();
    },
  };
}
