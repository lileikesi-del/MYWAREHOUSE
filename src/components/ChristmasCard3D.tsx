"use client";

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import * as THREE from "three";
import { CARD_ASSETS } from "@/lib/cardAssets";
import { CARD_H, CARD_THICKNESS, CARD_W } from "@/lib/cardConstants";
import { createElementLayer, type ElementLayer, type LayerElement } from "@/lib/card/elementMeshes";
import type { StickerEntry } from "@/lib/stickers/stickerManifest";
import { localToPlacement, placementToLocal } from "@/lib/card/elementLayout";
import type { ElementShape } from "@/lib/card/elementBounds";
import { applyPaperStock } from "@/lib/card/paperStocks";
import type { FaceBox } from "@/lib/card/slots";
import type { Face, PaperStock } from "@/lib/letter/model";
import { OPEN_MAX } from "@/lib/cardBend";
import {
  coastOrbit,
  createPointerState,
  isTapGesture,
  orbitFromDrag,
  pointerToCardLocal,
  resolveTap,
  type PointerState,
} from "@/lib/cardInteract";
import { createPostfxStack, type PostfxStack } from "@/lib/cardPostfx";
import { LAYOUT_SPRING, stepSpring, type Spring } from "@/lib/cardMotion";
import { hingeCue } from "@/lib/hingeCue";
import { playSfx, preloadSfx } from "@/lib/sfx";
import { createHandRig, type HandRig } from "@/lib/hand/handRig";
import { createHandBodies } from "@/lib/hand/handBodies";
import { createGlowSpriteTexture } from "@/lib/cardGlow";
import { createLampGate } from "@/lib/lampGate";
import { loadCoverImage, loadLayers } from "@/lib/cardBakes";
import { ensureSurfaces, prebakeAllCards } from "@/lib/ensureSurfaces";
import { createLruCache, type LruCache } from "@/lib/lruCache";
import { createCardBody, COVER_PX_H, COVER_PX_W, type CardBody } from "@/lib/card/cardBody";
import {
  buildFace,
  buildInside,
  disposeFace,
  disposeInside,
  faceUploads,
  insideUploads,
  makeTexture,
  redrawSheet,
  warmPieceMaterials,
  type CardFace,
  type CardInside,
  type KitContext,
} from "@/lib/card/cardKit";
import { coverLocalToPx, coverPxToLocal, kickMovers, resolveLiveTap } from "@/lib/live/movers";
import { buildPaperNormalTile } from "@/lib/cardRelief";
import {
  addStudioEnvironment,
  addStudioLights,
  createCardShadowTexture,
  createStudioRenderer,
  SOFTBOX_POS,
} from "@/lib/studio";
import { fitStage, studioBackgroundColor, zoomedDistance, type StageFit } from "@/lib/cardStage";
import { createSnowfallCanvas } from "@/lib/cardTextures";
import type { CardTemplateId } from "@/lib/types";

export interface ChristmasCard3DProps {
  templateId: CardTemplateId;
  message: string;
  signature: string;
  isOpen: boolean;
  isPaused: boolean;
  flyInKey?: number;
  /** false: start at rest, no fly-in (taking over from the envelope, which already showed it arriving). */
  flyIn?: boolean;
  onToggleOpen?: () => void;
  onOpenProgress?: (progress: number) => void;
  onReady?: () => void;
  /** The first frame with the cover on has been drawn: safe to remove whatever stood in for it. */
  onFirstFrame?: () => void;
  /**
   * Stickers and text placed by the sender. When given, the inside pages are
   * bare paper and these are drawn as their own meshes instead of the
   * template's motifs and `message`.
   */
  elements?: LayerElement[];
  /** Uploaded sticker images referenced by `elements` (data URLs). */
  customStickers?: StickerEntry[];
  /**
   * false: the card ignores its own drag-open / tap gestures (the editor
   * drives it); the pointer lamp still follows the pointer.
   */
  interactive?: boolean;
  /** Editor zoom, 0.6–2 (camera moves closer); 1 is the fitted view. */
  zoom?: number;
  /** Card stock for the inside pages and edges; omitted keeps the template's paper. */
  paper?: PaperStock;
  /** Editor access to picking and on-screen element corners. */
  handleRef?: Ref<CardHandle>;
  /**
   * Gallery: the other cards fanned out around this one as a dealt hand.
   * Three levels: browsing, a drag deals through the hand and a tap on the
   * front card focuses it; focused (`handFocus`), the rest step aside, the
   * card comes closer and a drag turns it to look at the cover, a tap opens
   * it; a tap on empty space or a side card goes back to browsing.
   * `onIndex` reports the card the hand heads for. Read once at mount.
   */
  hand?: {
    templateIds: readonly CardTemplateId[];
    onIndex: (index: number) => void;
    onFocus: (focus: boolean) => void;
  };
  /** With `hand`: the front card is focused (see `hand`). */
  handFocus?: boolean;
}

/** The hand frames the closed card smaller than a lone card, to leave room for the fan. */
const HAND_BACKOFF = 1.3;
/** One card step on screen, in card widths (handLayout STEP_NEAR), for drag tracking. */
const HAND_STEP = 0.84;

/** What lies under a screen point on the open card. */
export interface CardPick {
  face: Face;
  /** 0..1 placement on that face. */
  x: number;
  y: number;
  /** uid of the element under the point, if any. */
  uid: string | null;
}

export interface CardHandle {
  /** clientX/clientY → face position and element, or null off the inside pages. */
  pick(clientX: number, clientY: number): CardPick | null;
  /** An element's corners (tl, tr, br, bl) in px relative to the card's container. */
  project(uid: string): { x: number; y: number }[] | null;
  /** An inside page's corners (tl, tr, br, bl), or of a box on it; same frame as `project`. */
  projectFace(face: Face, box?: FaceBox): { x: number; y: number }[] | null;
  /** An element's size at scale 1, once it has loaded. */
  shapeOf(uid: string): ElementShape | null;
  /** Draw this element over the paper while a gesture holds it; null to put it back. */
  lift(uid: string | null): void;
}


/** How far the pointer slides the studio softbox (SOFTBOX_POS in lib/studio). */
const SOFTBOX_SWAY = 1.4;
/** Pointer lamp peak intensity: the glint on wet paint. */
const LAMP_INTENSITY = 0.9;
/**
 * How high the pointer lamp hangs over the card. Low, so its glint is a small
 * spot right under the pointer (high, it was a wide sheen landing off to one side).
 */
const LAMP_HEIGHT = 0.5;

/** Motion budget scaling for prefers-reduced-motion (#10). */
function motionScale(): number {
  if (typeof window === "undefined") return 1;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0.35 : 1;
}

/** Shadow plane is the card footprint padded by this much on each axis. */
/** Pointer speed (px/s) that blows a full breeze through the card. */
const WIND_FULL_PX_S = 1400;
/**
 * The pointer's sweep velocity that blows the snow (the reference's K): it
 * builds fast while the pointer speeds up and lets go slowly, so a quick
 * sweep leaves the flakes drifting on. Clamped, in screen px/s.
 */
const SWEEP_MAX_PX_S = 2400;
const SWEEP_RISE = 10;
const SWEEP_FALL = 2.2;
/** A sample fades this fast once the pointer stops moving. */
const SWEEP_SAMPLE_FADE = 8;
/** Seconds after landing before the card says hello. */
const GREET_DELAY = 0.25;
function createParticleSprite(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    grad.addColorStop(0, "rgba(255, 255, 255, 1)");
    grad.addColorStop(0.42, "rgba(255, 255, 255, 0.9)");
    grad.addColorStop(0.8, "rgba(255, 255, 255, 0.25)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Faces kept on the GPU: the real cards in the hand plus a couple more. */
const FACE_CACHE_SIZE = 6;
/** Insides kept: the card in front and the one before. */
const INSIDE_CACHE_SIZE = 2;
/** Real cards in the hand: the front card and its two neighbours. */
const HAND_BODIES = 3;

/** 1x1 textures for a template card's inside map slots until its inside arrives. */
function createPlaceholders() {
  const px = (r: number, g: number, b: number, srgb: boolean) => {
    const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  // Paper white; a flat normal; roughness ~0.86 (G), no metal (B).
  return { map: px(242, 236, 228, true), normal: px(128, 128, 255, false), surface: px(0, 220, 0, false) };
}

/** What the scene effect hands the card-switch effect. */
interface SceneHandles {
  /** Compile the scene's shaders off the main thread where the GPU driver allows. */
  prewarm: () => Promise<void>;
  /**
   * Upload textures to the GPU now, one per frame. A body is culled until it
   * shows, so otherwise every new texture uploads on the frame it appears.
   */
  upload: (textures: readonly THREE.Texture[], isCancelled: () => boolean) => Promise<void>;
  kitCtx: KitContext;
  /** The real card in front now (the hand's focus, or the lone card). */
  focus: () => CardBody;
  /** The editor's / letter view's only card (also the hand's first body). */
  lone: CardBody;
  /** A card's face, cached or built and uploaded. */
  ensureFace: (card: CardTemplateId) => Promise<CardFace | null>;
  /** Resolves once the hand's front card is real and has landed (or on cancel). */
  untilLanded: (isCancelled: () => boolean) => Promise<void>;
  /** Built faces and insides by card (see lib/card/cardKit). */
  faces: LruCache<string, CardFace>;
  insides: LruCache<string, CardInside>;
}

function insideKey(templateId: CardTemplateId, bare: boolean): string {
  return `${templateId}|${bare ? "bare" : "template"}`;
}


/** A cache hit, or build it and cache it (a racing build of the same key wins; ours is freed). */
async function cachedBuild<T>(
  cache: LruCache<string, T>,
  key: string,
  build: () => Promise<T | null>,
  dispose: (value: T) => void,
): Promise<T | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const built = await build();
  if (!built) return null;
  const raced = cache.get(key);
  if (raced) {
    dispose(built);
    return raced;
  }
  cache.set(key, built);
  return built;
}

/** Redraw an inside's insert sheet when the message differs from what it shows. */
function refreshSheetOn(
  body: CardBody,
  inside: CardInside,
  message: string,
  signature: string,
  anisotropy: number,
): void {
  const old = redrawSheet(inside, message, signature, anisotropy);
  if (!old) return;
  if (body.inside === inside) {
    body.mats.insideRightSheet.map = inside.sheet.map;
    body.mats.insideRightSheet.needsUpdate = true;
  }
  old.dispose();
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** No pointer sweep (cards away from the front). */
const STILL = { x: 0, y: 0 } as const;
/** The hand deals in without its neighbours' real cards after this long. */
const DEAL_WAIT_MS = 4000;

export function ChristmasCard3D({
  templateId,
  message,
  signature,
  isOpen,
  isPaused,
  flyInKey = 0,
  flyIn = true,
  onToggleOpen,
  onOpenProgress,
  onReady,
  onFirstFrame,
  elements,
  customStickers,
  interactive = true,
  paper,
  zoom = 1,
  handleRef,
  hand,
  handFocus = false,
}: ChristmasCard3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const coverImageRef = useRef<HTMLImageElement | null>(null);

  const stateRef = useRef({
    isOpen,
    prevOpen: isOpen,
    isPaused,
    dragRotX: 0,
    dragRotY: 0,
    targetDragRotX: 0,
    targetDragRotY: 0,
    // Fling velocity (px/s) the view orbit coasts on after a drag is released.
    orbitVX: 0,
    orbitVY: 0,
    hoverX: 0,
    hoverY: 0,
    flyProgress: flyIn ? 0 : 1,
    // The fly-in waits for the card's artwork to be baked and applied, so no
    // bake ever lands mid-flight (it used to: that was the stutter).
    assetsReady: false,
    // A card without a fly-in stays hidden until its artwork first lands, so it
    // never shows as a blank grey board; later template switches keep it shown.
    everReady: false,
    burstTimer: 0,
    // #7 continuous open progress 0..1 (drag-controllable)
    openProgress: isOpen ? 1 : 0,
    targetOpenProgress: isOpen ? 1 : 0,
    // Hand focus (0 browsing .. 1 the rest stepped aside, the card brought closer).
    focus: { x: handFocus || isOpen ? 1 : 0, v: 0 } as Spring,
    releasedImpulse: 0,
    // Living card: the pointer's breeze (-1..1), a light's flare (0..1), and
    // whether the card still has to say hello once it lands.
    wind: 0,
    // Pointer sweep across the card, px/s: last sample, and the smoothed wind it feeds.
    sweepSample: { x: 0, y: 0 },
    sweep: { x: 0, y: 0 },
    glowFlare: 0,
    // Without a fly-in the card is already there: say hello straight away.
    greetIn: flyIn ? -1 : GREET_DELAY,
  });

  const callbacksRef = useRef({ onToggleOpen, onOpenProgress, onReady, onFirstFrame });
  const coverOnRef = useRef(false);
  const elementLayerRef = useRef<ElementLayer | null>(null);
  // Decided once per mount: a card is either an editor/letter card or a template card.
  const bareRef = useRef(elements !== undefined);
  const customStickersRef = useRef(customStickers);
  customStickersRef.current = customStickers;
  const handRef = useRef(hand);
  handRef.current = hand;
  const rigRef = useRef<HandRig | null>(null);
  const templateIdRef = useRef(templateId);
  templateIdRef.current = templateId;
  const textRef = useRef({ message, signature });
  textRef.current = { message, signature };

  // The dock (or anything outside) picked a card: deal the hand round to it.
  useEffect(() => {
    const ids = handRef.current?.templateIds;
    if (rigRef.current && ids) rigRef.current.goTo(Math.max(0, ids.indexOf(templateId)));
  }, [templateId]);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;
  const viewRef = useRef({ zoom });
  viewRef.current = { zoom };
  const pickApiRef = useRef<CardHandle | null>(null);
  const paperMatsRef = useRef<THREE.MeshPhysicalMaterial[]>([]);
  useImperativeHandle(handleRef, () => ({
    pick: (cx, cy) => pickApiRef.current?.pick(cx, cy) ?? null,
    project: (uid) => pickApiRef.current?.project(uid) ?? null,
    projectFace: (face, box) => pickApiRef.current?.projectFace(face, box) ?? null,
    shapeOf: (uid) => pickApiRef.current?.shapeOf(uid) ?? null,
    lift: (uid) => pickApiRef.current?.lift(uid),
  }), []);
  callbacksRef.current = { onToggleOpen, onOpenProgress, onReady, onFirstFrame };

  /** Turn the view back square to the lens (after open/close or a new card). */
  const resetOrbit = () => {
    stateRef.current.targetDragRotX = 0;
    stateRef.current.targetDragRotY = 0;
    stateRef.current.orbitVX = 0;
    stateRef.current.orbitVY = 0;
  };

  useEffect(() => {
    stateRef.current.targetOpenProgress = isOpen ? 1 : 0;
    resetOrbit();
  }, [isOpen]);

  const focusRef = useRef(handFocus);
  focusRef.current = handFocus;
  // Back to browsing: the card stands square in the hand again.
  useEffect(() => {
    if (!handFocus) resetOrbit();
  }, [handFocus]);

  useEffect(() => {
    stateRef.current.isPaused = isPaused;
  }, [isPaused]);

  // The initial state already says whether to fly in; only a new key replays it.
  // (Keyed on the value, not on "first run": React runs mount effects twice in
  // development, which used to replay the fly-in on cards that had none.)
  const lastFlyInKey = useRef(flyInKey);
  useEffect(() => {
    if (flyInKey === lastFlyInKey.current) return;
    lastFlyInKey.current = flyInKey;
    stateRef.current.flyProgress = 0;
    stateRef.current.greetIn = -1;
    resetOrbit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyInKey]);

  const sceneHandlesRef = useRef<SceneHandles | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const motion = motionScale();

    const scene = new THREE.Scene();
    // Opaque studio sweep: the bloom chain drops canvas alpha, so the
    // backdrop is rendered, tuned to land exactly on the page colour.
    scene.background = studioBackgroundColor();

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    const CAMERA_FOV = 30;
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, width / height, 0.1, 100);
    camera.position.set(0, 0.12, 8.2);

    const renderer = createStudioRenderer();
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);
    const studioEnv = addStudioEnvironment(renderer, scene);
    /**
     * Precompile shaders off the critical frame. The frame itself renders
     * into the postfx chain's offscreen target, where three.js builds shaders
     * without tone mapping; compiling against the screen would build the
     * wrong variants, so compile against an offscreen target too.
     */
    const warmTarget = new THREE.WebGLRenderTarget(1, 1);
    const prewarm = (): Promise<void> => {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(warmTarget);
      const done = renderer.compileAsync(scene, camera);
      renderer.setRenderTarget(previous);
      return done.then(() => undefined);
    };

    const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

    // The shared studio: the key light's target and the softbox ride the pointer.
    const handOpts = handRef.current;
    const { key: keyLight, keyTarget, softbox } = addStudioLights(scene, { shadowMapSize: handOpts ? 2048 : 1024 });
    if (handOpts) {
      // The fan is wider than one card: widen the key light's shadow frustum.
      Object.assign(keyLight.shadow.camera, { left: -9, right: 9, top: 6, bottom: -6 });
      keyLight.shadow.camera.updateProjectionMatrix();
    }

    // Cold-press tooth at the same pitch as the cover (~85 bumps across).
    const paperNormalTex = makeTexture(
      buildPaperNormalTile(512, 24),
      maxAnisotropy,
      false,
    );
    paperNormalTex.wrapS = THREE.RepeatWrapping;
    paperNormalTex.wrapT = THREE.RepeatWrapping;
    paperNormalTex.repeat.set(3.5, 3.5 * (CARD_H / CARD_W));

    // The pointer lamp lights the things on the card, not the bare paper.
    const lampGate = createLampGate();

    // #5 Snowfall parallax layer above the cover artwork; the hand's stand-ins
    // share this texture (the card drives its scroll), so create it before the rig.
    const snowfallTex = makeTexture(createSnowfallCanvas(), maxAnisotropy);
    snowfallTex.wrapS = THREE.RepeatWrapping;
    snowfallTex.wrapT = THREE.RepeatWrapping;
    // Shared candle-glow sprite, for the real card and every stand-in.
    const glowTex = createGlowSpriteTexture();

    const rig = handOpts
      ? createHandRig({
          templateIds: handOpts.templateIds,
          initialIndex: Math.max(0, handOpts.templateIds.indexOf(templateIdRef.current)),
          renderer,
          paperNormal: paperNormalTex,
          snowfall: snowfallTex,
          glowTexture: glowTex,
          motion,
          onIndex: (i) => handRef.current?.onIndex(i),
          decorate: (m) => lampGate.install(m),
          onMaterials: () => {
            prewarm().catch(() => undefined);
          },
        })
      : null;
    if (rig) scene.add(rig.group);
    rigRef.current = rig;

    const shadowTex = createCardShadowTexture();
    const placeholders = bareRef.current ? null : createPlaceholders();
    // The hand flies real cards for the front card and its neighbours; a lone card has one.
    const bodies = Array.from({ length: rig ? HAND_BODIES : 1 }, () => {
      const b = createCardBody(
        { paperNormalTex, snowfallTex, glowTex, shadowTex, lampGate, placeholders },
        !rig && stateRef.current.isOpen,
      );
      scene.add(b.outer);
      return b;
    });
    /** The card the pointer, the hinge and the camera work on: the one in front. */
    let fb: CardBody = bodies[0];

    // Pointer lamp: the light that follows the pointer across the card,
    // so the impasto relief & paper grain catch a moving sheen (bubbbly uLamp).
    // Physically decayed and held off the face; lights stickers inside too.
    // It rides the card in front (re-parented, never re-added: the light count stays put).
    const hoverLamp = new THREE.PointLight(0xfffaf4, 0, 4.2, 2);
    hoverLamp.position.set(CARD_W / 2, 0, LAMP_HEIGHT);
    fb.center.add(hoverLamp);

    const particleTex = createParticleSprite();

    // The editor and the letter view have one card: its paper and its stickers.
    const lone = bodies[0];
    paperMatsRef.current = [lone.mats.edge, lone.mats.insideLeft, lone.mats.insideRightBase, lone.mats.insideRightSheet];
    elementLayerRef.current = createElementLayer(
      {
        "inside-left": { parent: lone.coverMesh, bendWidth: CARD_W },
        "inside-right": { parent: lone.sheetMesh, bendWidth: CARD_W },
      },
      maxAnisotropy,
      (m) => lampGate.install(m),
      () => customStickersRef.current ?? [],
    );

    const liftedMatPool: THREE.MeshStandardMaterial[] = [];
    const kitCtx: KitContext = { maxAnisotropy, lampGate, paperNormalTex, liftedMatPool };
    const unwarmPieces = warmPieceMaterials(scene, lampGate, paperNormalTex);
    const uploaded = new WeakSet<THREE.Texture>();
    const faces = createLruCache<string, CardFace>(FACE_CACHE_SIZE, (_key, face) => disposeFace(face, liftedMatPool));
    const insides = createLruCache<string, CardInside>(INSIDE_CACHE_SIZE, (_key, inside) => disposeInside(inside));
    /** One texture per frame: each costs a few ms (storage, copy, mipmaps). */
    const upload = async (textures: readonly THREE.Texture[], isCancelled: () => boolean) => {
      for (const tex of new Set(textures)) {
        if (uploaded.has(tex)) continue;
        await new Promise((r) => requestAnimationFrame(r));
        // The rest upload when this card is next built or shown.
        if (isCancelled()) return;
        renderer.initTexture(tex);
        uploaded.add(tex);
      }
    };
    let unmounted = false;
    const faceBuilds = new Map<CardTemplateId, Promise<CardFace | null>>();
    /** A card's face: cached, or built, decoded and uploaded (one build per card at a time). */
    const ensureFace = (card: CardTemplateId): Promise<CardFace | null> => {
      const running = faceBuilds.get(card);
      if (running) return running;
      const isGone = () => unmounted;
      const p = (async () => {
        const spec = CARD_ASSETS[card];
        const [coverImg, layered] = await Promise.all([loadCoverImage(spec.coverSrc), loadLayers(card), ensureSurfaces(card)]);
        if (unmounted) return null;
        const face = await cachedBuild(faces, card, () => buildFace(kitCtx, { templateId: card, coverImg, layered }, isGone), (f) =>
          disposeFace(f, liftedMatPool),
        );
        if (face) await upload(faceUploads(face), isGone);
        return face;
      })()
        .catch(() => null)
        .finally(() => faceBuilds.delete(card));
      faceBuilds.set(card, p);
      return p;
    };
    const hand = rig
      ? createHandBodies({
          rig,
          bodies,
          faceFor: (card) => {
            // Only a face that is fully uploaded goes on: no upload on the frame it shows.
            const face = faces.get(card);
            return face && !faceBuilds.has(card) ? face : null;
          },
          requestFace: (card) => {
            if (!faces.get(card)) void ensureFace(card);
          },
        })
      : null;

    sceneHandlesRef.current = {
      prewarm,
      upload,
      kitCtx,
      focus: () => fb,
      lone,
      untilLanded: async (isCancelled) => {
        while (!frontLanded && !isCancelled() && !unmounted) await nextFrame();
      },
      ensureFace,
      faces,
      insides,
    };

    // Card-open golden sparkle burst
    const burstCount = Math.max(24, Math.round(140 * motion));
    const burstPositions = new Float32Array(burstCount * 3);
    const burstVelocities = new Float32Array(burstCount * 3);
    const burstGeo = new THREE.BufferGeometry();
    burstGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(burstPositions, 3),
    );

    const burstMat = new THREE.PointsMaterial({
      size: 0.18,
      color: 0xd99b26,
      map: particleTex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });

    const burstParticles = new THREE.Points(burstGeo, burstMat);
    scene.add(burstParticles);

    /** Sparkles: the big opening burst, or a small one from a tapped spot. */
    const triggerBurst = (origin?: THREE.Vector3) => {
      stateRef.current.burstTimer = origin ? 1.1 : 1.6;
      const posAttr = burstGeo.getAttribute("position") as THREE.BufferAttribute;
      const spread = origin ? 0.06 : 1;
      for (let i = 0; i < burstCount; i += 1) {
        posAttr.setXYZ(
          i,
          (origin?.x ?? 0) + (Math.random() - 0.5) * 0.5 * spread,
          (origin?.y ?? 0) + (Math.random() - 0.5) * 2.5 * spread,
          (origin?.z ?? 0.35) + Math.random() * 0.3 * spread,
        );
        const angle = Math.random() * Math.PI * 2;
        const speed = (0.8 + Math.random() * 2.2) * (origin ? 0.4 : 1);
        burstVelocities[i * 3] = Math.cos(angle) * speed;
        burstVelocities[i * 3 + 1] = Math.sin(angle) * speed * 0.75 + 0.4;
        burstVelocities[i * 3 + 2] = (Math.random() - 0.15) * 1.6;
      }
      posAttr.needsUpdate = true;
    };

    // Pointer: a click opens the card; press-and-drag anywhere turns the view.
    const ptr: PointerState = createPointerState();
    let orbitBase = { x: 0, y: 0 };
    let ptrVy = 0;
    let ptrLastY = 0;
    let windLastX = 0;
    let windLastY = 0;
    let windLastT = 0;

    /** A tap on the closed cover: a light flares, a part reacts, or the card opens. */
    const handleCoverTap = (local: { x: number; y: number } | null): boolean => {
      const live = fb.live;
      if (!local || !live || stateRef.current.openProgress > 0.1) return false;
      const px = coverLocalToPx(local, COVER_PX_W, COVER_PX_H);
      const hit = resolveLiveTap(live.spec, px.x, px.y);
      if (hit.kind === "open") return false;
      const burstAt = (at: readonly [number, number]) => {
        const l = coverPxToLocal(at, COVER_PX_W, COVER_PX_H);
        triggerBurst(fb.coverMesh.localToWorld(new THREE.Vector3(l.x, l.y, CARD_THICKNESS + 0.05)));
      };
      if (hit.kind === "glow" && live.spec.glowTap) {
        stateRef.current.glowFlare = 1;
        kickMovers(live.rt, live.spec.glowKick ?? []);
        burstAt([live.spec.glowTap[0], live.spec.glowTap[1]]);
        return true;
      }
      if (hit.kind === "tap") {
        kickMovers(live.rt, hit.tap.kick ?? []);
        if (hit.tap.sparkle) burstAt(hit.tap.sparkle);
        if (hit.tap.lift) {
          for (const lm of fb.liftedMeshes) lm.impulse = 1;
        }
      }
      return true;
    };
    // Where the pointer touches the card, in fb.center space; the
    // pointer lamp hovers right above it (bubbbly uLamp).
    const lampRay = new THREE.Raycaster();
    const lampNdc = new THREE.Vector2();
    const lampTarget = new THREE.Vector3(CARD_W / 2, 0, 0);
    const lampSurfaces = (): THREE.Object3D[] => [fb.coverMesh, fb.sheetMesh, fb.rightMesh];

    const pickRay = new THREE.Raycaster();
    const pickNdc = new THREE.Vector2();
    const toNdc = (cx: number, cy: number) => {
      const rect = container.getBoundingClientRect();
      pickNdc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
      return pickNdc;
    };
    const faceOf = (panel: THREE.Object3D, normalZ: number): Face | null => {
      // The right page is the sheet and the panel's margin around it.
      if ((panel === fb.sheetMesh || panel === fb.rightMesh) && normalZ > 0) return "inside-right";
      if (panel === fb.coverMesh && normalZ < 0) return "inside-left";
      return null;
    };
    pickApiRef.current = {
      pick(cx, cy) {
        pickRay.setFromCamera(toNdc(cx, cy), camera);
        const layer = elementLayerRef.current?.meshes() ?? [];
        const hits = pickRay.intersectObjects([...layer, fb.coverMesh, fb.sheetMesh, fb.rightMesh], false);
        for (const hit of hits) {
          const isElement = typeof hit.object.userData.uid === "string";
          const panel = isElement ? hit.object.parent : hit.object;
          if (!panel) continue;
          const normalZ = isElement ? (panel === fb.coverMesh ? -1 : 1) : (hit.face?.normal.z ?? 0);
          const face = faceOf(panel, normalZ);
          if (!face) continue;
          // Placement on the right page is in the sheet's frame, also past its edges.
          const frame = face === "inside-right" ? fb.sheetMesh : panel;
          const local = frame.worldToLocal(hit.point.clone());
          const at = localToPlacement(face, local.x, local.y);
          return { face, x: at.x, y: at.y, uid: isElement ? (hit.object.userData.uid as string) : null };
        }
        return null;
      },
      projectFace(face, box = { x0: 0, y0: 0, x1: 1, y1: 1 }) {
        const panel = face === "inside-left" ? fb.coverMesh : fb.sheetMesh;
        const rect = container.getBoundingClientRect();
        return [
          [box.x0, box.y0],
          [box.x1, box.y0],
          [box.x1, box.y1],
          [box.x0, box.y1],
        ].map(([u, v]) => {
          const p = placementToLocal(face, u, v);
          const w = panel.localToWorld(new THREE.Vector3(p.x, p.y, p.z)).project(camera);
          return { x: ((w.x + 1) / 2) * rect.width, y: ((1 - w.y) / 2) * rect.height };
        });
      },
      shapeOf(uid) {
        return elementLayerRef.current?.shapeOf(uid) ?? null;
      },
      lift(uid) {
        elementLayerRef.current?.lift(uid);
      },
      project(uid) {
        const mesh = elementLayerRef.current?.meshes().find((m) => m.userData.uid === uid);
        if (!mesh) return null;
        const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
        // PlaneGeometry(…, SEGMENTS, 1): top row 0..S, bottom row S+1..2S+1.
        const last = pos.count / 2 - 1;
        const rect = container.getBoundingClientRect();
        return [0, last, pos.count - 1, last + 1].map((i) => {
          const v = new THREE.Vector3().fromBufferAttribute(pos, i);
          mesh.localToWorld(v).project(camera);
          return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
        });
      },
    };

    // Browsing the hand, a drag deals through it instead of turning the card.
    let handDeal = false;
    const stepPx = () => {
      const h = container.clientHeight || window.innerHeight;
      const tan = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2));
      return (CARD_W * HAND_STEP * h) / (2 * tan * camera.position.z);
    };
    /** Rounded offset from the front of the hand stand-in under the pointer, or null. */
    const pickHand = (e: PointerEvent): number | null => {
      if (!rig) return null;
      pickRay.setFromCamera(toNdc(e.clientX, e.clientY), camera);
      return rig.pick(pickRay);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!interactiveRef.current) return;
      handDeal = Boolean(rig) && !focusRef.current && stateRef.current.targetOpenProgress < 0.5;
      ptr.down = true;
      ptr.over = true;
      ptr.mode = "tilt";
      ptr.x0 = e.clientX;
      ptr.y0 = e.clientY;
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      ptr.t0 = performance.now();
      ptr.vx = 0;
      ptr.lastX = e.clientX;
      ptr.lastT = ptr.t0;
      ptr.totalMoved = 0;
      ptrVy = 0;
      ptrLastY = e.clientY;
      // Catch the card where it is, even mid-coast.
      const s0 = stateRef.current;
      s0.orbitVX = 0;
      s0.orbitVY = 0;
      orbitBase = { x: s0.targetDragRotX, y: s0.targetDragRotY };
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      renderer.domElement.dataset.grabbing = "";
    };

    const onPointerMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      stateRef.current.hoverX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
      stateRef.current.hoverY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;

      if (!ptr.down) {
        lampNdc.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        lampRay.setFromCamera(lampNdc, camera);
        // Cover (front or inside-left face), insert sheet, right panel.
        const hit = lampRay.intersectObjects(lampSurfaces(), false)[0];
        ptr.over = Boolean(hit);
        if (hit) lampTarget.copy(fb.center.worldToLocal(hit.point.clone()));
        // The pointer blows a breeze through the card as it sweeps across it.
        const now = performance.now();
        if (hit && interactiveRef.current && windLastT > 0) {
          const dts = Math.max(8, now - windLastT) / 1000;
          const pxPerS = (e.clientX - windLastX) / dts;
          const gust = THREE.MathUtils.clamp(pxPerS / WIND_FULL_PX_S, -1, 1);
          if (Math.abs(gust) > Math.abs(stateRef.current.wind)) stateRef.current.wind = gust;
          stateRef.current.sweepSample = {
            x: THREE.MathUtils.clamp(pxPerS, -SWEEP_MAX_PX_S, SWEEP_MAX_PX_S),
            y: THREE.MathUtils.clamp((e.clientY - windLastY) / dts, -SWEEP_MAX_PX_S, SWEEP_MAX_PX_S),
          };
        }
        windLastX = e.clientX;
        windLastY = e.clientY;
        windLastT = now;
        return;
      }

      const now = performance.now();
      const dms = Math.max(1, now - ptr.lastT);
      ptr.vx = THREE.MathUtils.lerp(
        ptr.vx,
        ((e.clientX - ptr.lastX) / dms) * 1000,
        0.4,
      );
      ptrVy = THREE.MathUtils.lerp(ptrVy, ((e.clientY - ptrLastY) / dms) * 1000, 0.4);
      ptr.lastX = e.clientX;
      ptrLastY = e.clientY;
      ptr.lastT = now;
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      ptr.totalMoved += Math.abs(e.movementX) + Math.abs(e.movementY);

      if (handDeal) {
        if (rig && Math.hypot(e.clientX - ptr.x0, e.clientY - ptr.y0) > 6) {
          rig.drag(e.clientX - ptr.x0, ptr.vx, stepPx());
        }
        return;
      }
      const rot = orbitFromDrag(orbitBase, e.clientX - ptr.x0, e.clientY - ptr.y0);
      stateRef.current.targetDragRotX = rot.x;
      stateRef.current.targetDragRotY = rot.y;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!ptr.down) return;
      ptr.down = false;
      delete renderer.domElement.dataset.grabbing;

      const moved = Math.hypot(e.clientX - ptr.x0, e.clientY - ptr.y0);
      const isTap = isTapGesture(moved, performance.now() - ptr.t0);

      if (rig && !isTap && handDeal) {
        const idle = performance.now() - ptr.lastT > 120;
        rig.release(idle ? 0 : ptr.vx, stepPx());
        ptr.mode = "none";
        return;
      }
      if (rig && isTap) {
        const side = pickHand(e);
        const focused = focusRef.current || stateRef.current.targetOpenProgress > 0.5;
        const onFocus = handRef.current?.onFocus;
        ptr.mode = "none";
        if (side !== null && side !== 0) {
          // A side card (or, focused, one peeking at the edge): bring it forward.
          if (focused) onFocus?.(false);
          rig.goBy(side);
          return;
        }
        if (!frontLanded) {
          // The front card is still landing (its stand-in is in front): a tap
          // focuses it all the same; the real card takes over as it lands.
          if (side === 0 && !focused) onFocus?.(true);
          return;
        }
        pickRay.setFromCamera(toNdc(e.clientX, e.clientY), camera);
        const onCard = pickRay.intersectObjects(lampSurfaces(), false).length > 0;
        if (!focused) {
          // Browsing: a tap on the front card focuses it (the cover, not yet the inside).
          if (onCard) onFocus?.(true);
          return;
        }
        if (!onCard) {
          // Focused, a tap on empty space goes back to the hand.
          onFocus?.(false);
          return;
        }
        // Focused, on the card: fall through to the card's own tap (react, open, close).
      }

      if (isTap) {
        // A click undoes the few pixels of turn it may have made, then acts.
        stateRef.current.targetDragRotX = orbitBase.x;
        stateRef.current.targetDragRotY = orbitBase.y;
        const local = pointerToCardLocal(e, container, camera, fb.coverMesh);
        if (stateRef.current.targetOpenProgress > 0.5) {
          // Open card: a click anywhere on it (either page) closes it.
          pickRay.setFromCamera(toNdc(e.clientX, e.clientY), camera);
          if (pickRay.intersectObjects(lampSurfaces(), false).length > 0) {
            callbacksRef.current.onToggleOpen?.();
          }
        } else if (handleCoverTap(local)) {
          // A part of the picture reacted instead of the card opening.
        } else if (resolveTap(local, CARD_W) === "toggle") {
          callbacksRef.current.onToggleOpen?.();
        }
      } else {
        // The view stays where it was turned to, coasting a little on the fling.
        const idle = performance.now() - ptr.lastT > 80;
        stateRef.current.orbitVX = idle ? 0 : ptr.vx;
        stateRef.current.orbitVY = idle ? 0 : ptrVy;
        // #8 inertia: pointer velocity feeds the lifted parts' bob.
        stateRef.current.releasedImpulse = Math.min(1, Math.abs(ptr.vx) / 2400);
      }
      ptr.mode = "none";
    };

    const onPointerLeave = () => {
      if (!ptr.down) ptr.over = false;
    };

    // Browsing the hand, ← / → deal one card; Esc steps back a level.
    const onKey = (e: KeyboardEvent) => {
      if (!rig) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const opened = stateRef.current.targetOpenProgress > 0.5;
      if (e.key === "Escape") {
        if (opened) callbacksRef.current.onToggleOpen?.();
        else if (focusRef.current) handRef.current?.onFocus(false);
        return;
      }
      if (opened || focusRef.current) return;
      if (e.key === "ArrowRight") rig.goBy(1);
      else if (e.key === "ArrowLeft") rig.goBy(-1);
    };

    const domEl = renderer.domElement;
    window.addEventListener("keydown", onKey);
    domEl.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    domEl.addEventListener("pointerleave", onPointerLeave);

    // The gallery has a floating dock to clear; the editor's canvas does not, so centre it.
    const dockReserve = bareRef.current ? 0 : undefined;
    let stage: StageFit = fitStage(CARD_W, CARD_H, CAMERA_FOV, width / height, dockReserve);

    const handleResize = () => {
      if (!container) return;
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      stage = fitStage(CARD_W, CARD_H, CAMERA_FOV, w / h, dockReserve);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      postfx?.setSize(w, h);
    };

    // #6 Postfx stack: bloom + film grain, after renderer exists.
    const postfx: PostfxStack = createPostfxStack(renderer, scene, camera);
    handleResize();
    // Browsing frames the closed card back to leave room for the fan; focus brings it in.
    const closedZ = () =>
      stage.closedZ * (rig ? THREE.MathUtils.lerp(HAND_BACKOFF, 1, stateRef.current.focus.x) : 1);
    // Start at the distance the frame loop settles on (the editor's zoom
    // included), so the card does not grow into place on mount.
    camera.position.z = zoomedDistance(stateRef.current.isOpen ? stage.openZ : closedZ(), viewRef.current.zoom);
    // The container, not the window: editor panels change its size without a window resize.
    const resizeObserver = new ResizeObserver(() => handleResize());
    resizeObserver.observe(container);

    let animId = 0;
    let elapsed = 0;
    const mountedAt = performance.now();
    /** The hand's front card is a real body (not its stand-in). */
    let focusLive = !rig;
    /** ...and has landed: taps go to it. */
    let frontLanded = !rig;
    /** The card in front wears its inside; the others give theirs back (placeholders). */
    const syncInsides = (focus: CardBody | null) => {
      for (const b of bodies) {
        const card = b.templateId;
        const wanted = b === focus && card ? (insides.get(insideKey(card, bareRef.current)) ?? null) : null;
        if (b.inside === wanted) continue;
        b.applyInside(wanted);
        if (wanted && !bareRef.current) refreshSheetOn(b, wanted, textRef.current.message, textRef.current.signature, maxAnisotropy);
      }
    };
    /** The pointer's sweep in card units/s: it blows the flakes and the far snow. */
    let sweepWind = { x: 0, y: 0 };
    let lastTime = performance.now();

    const animate = (now: number) => {
      animId = requestAnimationFrame(animate);
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const s = stateRef.current;

      if (s.isOpen && !s.prevOpen && s.targetOpenProgress < 0.5) {
        s.targetOpenProgress = 1;
      }
      s.prevOpen = s.isOpen;

      // Fire the sparkle burst once the swing actually opens past half-way.
      if (s.openProgress < 0.5 && s.targetOpenProgress > 0.5) {
        triggerBurst();
      }

      if (s.flyProgress < 1 && s.assetsReady) {
        s.flyProgress = Math.min(1, s.flyProgress + dt * 0.78 * (motion < 1 ? 1.6 : 1));
        if (s.flyProgress >= 1) s.greetIn = GREET_DELAY;
      }

      // Living card: the breeze dies away; parts sway, react and settle.
      s.wind *= Math.exp(-dt * 2.4);
      s.glowFlare = Math.max(0, s.glowFlare - dt * 1.4);

      // The hand: which real cards stand in for which slots, and which one is in front.
      if (hand) {
        hand.assign();
        const focus = hand.focusBody();
        if (focus && focus !== fb) {
          fb = focus;
          fb.center.add(hoverLamp);
        }
        focusLive = focus !== null;
        syncInsides(focus);
      }
      const live = fb.live;
      if (live && !s.isPaused && s.openProgress < 0.95 && s.greetIn > 0) {
        s.greetIn -= dt;
        if (s.greetIn <= 0) kickMovers(live.rt, live.spec.greet, 0.8);
      }
      const ease = 1 - Math.pow(1 - s.flyProgress, 3);

      if (!s.isPaused) {
        elapsed += dt;

        // Pointer sweep -> wind, as the reference: quick to build, slow to let go.
        const sample = s.sweepSample;
        const fade = Math.exp(-dt * SWEEP_SAMPLE_FADE);
        s.sweepSample = { x: sample.x * fade, y: sample.y * fade };
        const follow = (k: number, v: number) =>
          k + (v - k) * (1 - Math.exp(-dt * (Math.abs(v) > Math.abs(k) ? SWEEP_RISE : SWEEP_FALL)));
        s.sweep = { x: follow(s.sweep.x, sample.x), y: follow(s.sweep.y, sample.y) };
        // Screen px -> card units at the card's distance (screen y runs down, card y up).
        const viewH = container.clientHeight || window.innerHeight;
        const pxPerUnit = viewH / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV / 2)) * camera.position.z);
        const wind = { x: s.sweep.x / pxPerUnit, y: -s.sweep.y / pxPerUnit };
        sweepWind = wind;

        // #5 snowfall parallax scroll
        snowfallTex.offset.y -= dt * 0.012 * motion;
        // The far snow drifts with the pointer's sweep too, more gently.
        snowfallTex.offset.x -= ((wind.x * 0.12) / CARD_W) * dt;
      }

      // Hinge + slide springs (see lib/cardMotion): the card in front opens
      // (once its inside is on); every other real card closes.
      const insideOn = !hand || (focusLive && fb.inside !== null && fb.inside.templateId === fb.templateId);
      const hingeTarget = insideOn ? s.targetOpenProgress : 0;
      // The open/close sound starts on the frame the hinge does (lib/hingeCue).
      if (fb === hingeBody) {
        const cue = hingeCue({ prevTarget: hingeTargetWas, target: hingeTarget, progress: s.openProgress });
        if (cue) playSfx(cue);
      }
      hingeBody = fb;
      hingeTargetWas = hingeTarget;
      const fo = fb.stepOpen(dt, hingeTarget, motion);
      for (const b of bodies) if (b !== fb) b.stepOpen(dt, 0, motion);
      s.openProgress = fo.open;
      callbacksRef.current.onOpenProgress?.(s.openProgress);
      elementLayerRef.current?.applyBend({ "inside-left": fo.bend, "inside-right": fo.bend * 0.35 });

      {
        // #2 Key light follows pointer a little (studio softbox nudge).
        keyTarget.position.x = THREE.MathUtils.lerp(
          keyTarget.position.x,
          s.hoverX * 0.9,
          1 - Math.exp(-dt * 4),
        );
        keyTarget.position.y = THREE.MathUtils.lerp(
          keyTarget.position.y,
          -s.hoverY * 0.6,
          1 - Math.exp(-dt * 4),
        );

        // #2b Pointer lamp rides the hover position in card space, and
        // eases off once the pointer leaves the card.
        hoverLamp.position.x = THREE.MathUtils.lerp(
          hoverLamp.position.x,
          lampTarget.x,
          1 - Math.exp(-dt * 10),
        );
        hoverLamp.position.y = THREE.MathUtils.lerp(
          hoverLamp.position.y,
          lampTarget.y,
          1 - Math.exp(-dt * 10),
        );
        const lampWanted =
          ptr.over ? LAMP_INTENSITY : 0;

        // Softbox drifts with the pointer so the sheen flows across the relief.
        softbox.position.x = THREE.MathUtils.lerp(
          softbox.position.x,
          SOFTBOX_POS.x + s.hoverX * SOFTBOX_SWAY,
          1 - Math.exp(-dt * 4),
        );
        softbox.position.y = THREE.MathUtils.lerp(
          softbox.position.y,
          SOFTBOX_POS.y - s.hoverY * SOFTBOX_SWAY,
          1 - Math.exp(-dt * 4),
        );
        softbox.lookAt(0, 0, 0);
        hoverLamp.intensity = THREE.MathUtils.lerp(
          hoverLamp.intensity,
          lampWanted,
          1 - Math.exp(-dt * 8),
        );

        // Lifted relief meshes bob & twinkle, with the release impulse (#8).
        const impulse = s.releasedImpulse;
        s.releasedImpulse = Math.max(0, s.releasedImpulse - dt * 1.8);
        for (const b of hand ? hand.shown() : bodies) {
          // Only the card in front feels the pointer.
          const front = b === fb && (focusLive || !hand);
          b.ambient({
            dt,
            elapsed,
            motion,
            paused: s.isPaused,
            openProgress: front ? s.openProgress : THREE.MathUtils.clamp(b.hinge.x / OPEN_MAX, 0, 1),
            glowFlare: front ? s.glowFlare : 0,
            wind: front ? s.wind : 0,
            sweep: front ? sweepWind : STILL,
            impulse: front ? impulse : 0,
          });
        }
      }

      if (s.burstTimer > 0) {
        s.burstTimer = Math.max(0, s.burstTimer - dt);
        const bAttr = burstGeo.getAttribute("position") as THREE.BufferAttribute;
        for (let i = 0; i < burstCount; i += 1) {
          const bx = bAttr.getX(i) + burstVelocities[i * 3] * dt;
          const by = bAttr.getY(i) + burstVelocities[i * 3 + 1] * dt;
          const bz = bAttr.getZ(i) + burstVelocities[i * 3 + 2] * dt;
          burstVelocities[i * 3 + 1] -= 0.75 * dt;
          bAttr.setXYZ(i, bx, by, bz);
        }
        bAttr.needsUpdate = true;
        burstMat.opacity = Math.min(0.95, s.burstTimer / 1.1);
      } else {
        burstMat.opacity = 0;
      }


      // Resting pose: almost square to the lens, like a card on a copy stand.
      const floatY = Math.sin(elapsed * 1.1 * motion) * 0.018 * motion;
      const floatRotZ = Math.sin(elapsed * 0.8) * 0.004 * motion;
      const baseRotX = 0.015;
      const baseRotY = s.openProgress > 0.5 ? 0 : -0.04;
      const baseRotZ = -0.006;

      if (!ptr.down && (s.orbitVX !== 0 || s.orbitVY !== 0)) {
        const c = coastOrbit({ x: s.targetDragRotX, y: s.targetDragRotY }, { vx: s.orbitVX, vy: s.orbitVY }, dt);
        s.targetDragRotX = c.rot.x;
        s.targetDragRotY = c.rot.y;
        const done = Math.hypot(c.vel.vx, c.vel.vy) < 5;
        s.orbitVX = done ? 0 : c.vel.vx;
        s.orbitVY = done ? 0 : c.vel.vy;
      }

      s.dragRotX = THREE.MathUtils.lerp(
        s.dragRotX,
        s.targetDragRotX + (interactiveRef.current ? s.hoverY * 0.06 : 0),
        1 - Math.exp(-dt * 8),
      );
      s.dragRotY = THREE.MathUtils.lerp(
        s.dragRotY,
        s.targetDragRotY + (interactiveRef.current ? s.hoverX * 0.08 : 0),
        1 - Math.exp(-dt * 8),
      );

      const targetCamZ = zoomedDistance(
        closedZ() + (stage.openZ - closedZ()) * s.openProgress,
        viewRef.current.zoom,
      );
      camera.position.z = THREE.MathUtils.lerp(
        camera.position.z,
        targetCamZ,
        1 - Math.exp(-dt * 5.5),
      );
      camera.position.y = stage.camYPerZ * camera.position.z;

      if (rig) {
        // The rest of the hand steps aside as the card slides open.
        s.focus = stepSpring(s.focus, focusRef.current || s.targetOpenProgress > 0.5 ? 1 : 0, LAYOUT_SPRING, dt);
        const room = Math.max(s.focus.x, fb.layout.x);
        rig.update(dt, room);
        // Deal in once the front card and its neighbours are real (or after a wait).
        if (s.assetsReady && (hand?.settledIn() || now - mountedAt > DEAL_WAIT_MS)) rig.dealIn();
        // The hand shares the card's pointer tilt, so the slots line up with it.
        rig.group.rotation.set(s.dragRotX * (1 - room), s.dragRotY * (1 - room), 0);
      }

      // The card in front: its own pose (fly-in, float, drag).
      const outer = fb.outer;
      if (s.assetsReady) s.everReady = true;
      if (!rig) {
        outer.visible = s.everReady;
        fb.shadowPlane.visible = s.everReady;
      }
      outer.position.set(0, THREE.MathUtils.lerp(2.2, floatY, ease), THREE.MathUtils.lerp(-14, 0, ease));
      outer.scale.setScalar(THREE.MathUtils.lerp(0.24, 1.0, ease));
      outer.rotation.set(
        THREE.MathUtils.lerp(-0.32, baseRotX, ease) + s.dragRotX,
        THREE.MathUtils.lerp(0.75, baseRotY, ease) + s.dragRotY,
        THREE.MathUtils.lerp(0.24, baseRotZ + floatRotZ, ease),
      );
      fb.shadowPlane.material.opacity = ease;
      if (hand && rig) {
        // Every real card rides its slot; the one in front blends into its own pose.
        const frame = hand.pose(focusLive ? fb : null);
        const landed = focusLive && frame.weight > 0.999 && rig.settled();
        if (landed && !frontLanded) s.greetIn = 0.15; // the card comes alive as it lands
        frontLanded = landed;
        rig.showFront(!focusLive);
      }

      lampGate.update(hoverLamp, camera);
      postfx.render(dt);
      // Only once the card itself was in this frame: the cover arrives before the
      // pages are on, and until then the card is hidden (a page that lifts its
      // cover — the envelope, the veil — on an empty frame would flash).
      if (coverOnRef.current && s.everReady && !firstFrameFired) {
        firstFrameFired = true;
        callbacksRef.current.onFirstFrame?.();
      }
    };

    let firstFrameFired = false;
    let hingeBody: CardBody | null = null;
    let hingeTargetWas = stateRef.current.targetOpenProgress;
    preloadSfx();
    animId = requestAnimationFrame(animate);
    callbacksRef.current.onReady?.();

    return () => {
      unmounted = true;
      cancelAnimationFrame(animId);
      window.removeEventListener("keydown", onKey);
      domEl.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      domEl.removeEventListener("pointerleave", onPointerLeave);
      resizeObserver.disconnect();
      postfx.dispose();
      rig?.dispose();
      rigRef.current = null;
      warmTarget.dispose();
      if (sceneHandlesRef.current) {
        // Every card's textures and pieces live in its face/inside (cutouts return to the pool).
        sceneHandlesRef.current.faces.clear();
        sceneHandlesRef.current.insides.clear();
      }
      unwarmPieces();
      for (const mat of liftedMatPool) mat.dispose();
      for (const b of bodies) b.dispose();
      if (placeholders) for (const t of Object.values(placeholders)) t.dispose();
      burstGeo.dispose();
      shadowTex.dispose();
      particleTex.dispose();
      glowTex.dispose();
      paperNormalTex.dispose();
      burstMat.dispose();
      renderer.dispose();
      if (domEl.parentNode === container) {
        container.removeChild(domEl);
      }
      elementLayerRef.current?.dispose();
      elementLayerRef.current = null;
      pickApiRef.current = null;
      sceneHandlesRef.current = null;
      studioEnv.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A new card: its face and inside (from the caches, or built, decoded and
  // uploaded now), then on the real card, which flies in once they are on.
  useEffect(() => {
    const h = sceneHandlesRef.current;
    if (!h) return;

    let cancelled = false;
    const isCancelled = () => cancelled;
    const bare = bareRef.current;
    stateRef.current.assetsReady = false;

    const inHand = Boolean(rigRef.current);
    const insideFor = (face: CardFace) =>
      cachedBuild(
        h.insides,
        insideKey(templateId, bare),
        () =>
          buildInside(
            h.kitCtx,
            { templateId, coverImg: face.coverImg, bare, ...textRef.current },
            isCancelled,
            // In the hand, one page per frame (the card is already on show).
            inHand ? nextFrame : undefined,
          ),
        disposeInside,
      );

    const prepare = async () => {
      const face = await h.ensureFace(templateId);
      if (cancelled || !face) return;
      coverImageRef.current = face.coverImg;
      coverOnRef.current = true;
      if (inHand) {
        // The hand deals in on the face alone; the frame loop puts it on a real
        // card. No prewarm per switch: the real cards' programs are compiled once
        // they first show, and walking every material in the hand costs a frame.
        stateRef.current.assetsReady = true;
        prebakeAllCards(templateId);
        // The pages are only needed to open the card: draw them once it has
        // landed, never during the deal.
        await h.untilLanded(isCancelled);
        if (cancelled) return;
        const inside = await insideFor(face);
        if (inside) await h.upload(insideUploads(inside), isCancelled);
        return;
      }
      // A lone card flies in with everything on.
      const inside = await insideFor(face);
      if (!inside || cancelled) return;
      await h.upload(insideUploads(inside), isCancelled);
      if (cancelled) return;
      const lone = h.lone;
      lone.setCard(templateId);
      lone.applyFace(face);
      lone.applyInside(inside);
      if (!bare) refreshSheetOn(lone, inside, textRef.current.message, textRef.current.signature, h.kitCtx.maxAnisotropy);
      // Compile the new material setup before the card flies, not on its first frame.
      await h.prewarm().catch(() => undefined);
      if (cancelled) return;
      stateRef.current.assetsReady = true;
      prebakeAllCards(templateId);
    };

    prepare().catch(() => {
      // The cover failed to load: let the card in with what it has rather than hang.
      stateRef.current.assetsReady = true;
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // Redraw the insert sheet when the message or signature changes. On a card
  // switch the switch itself does this, once the new card's inside is on.
  useEffect(() => {
    const h = sceneHandlesRef.current;
    const body = h?.focus();
    const inside = body?.inside;
    if (!h || !body || !inside || bareRef.current || inside.templateId !== templateId) return;
    refreshSheetOn(body, inside, message, signature, h.kitCtx.maxAnisotropy);
  }, [templateId, message, signature]);

  useEffect(() => {
    elementLayerRef.current?.sync(elements ?? []);
  }, [elements]);

  useEffect(() => {
    if (paper) applyPaperStock(paperMatsRef.current, paper);
  }, [paper]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full cursor-grab active:cursor-grabbing select-none touch-none"
      aria-label="3D Christmas Card Canvas"
    />
  );
}
