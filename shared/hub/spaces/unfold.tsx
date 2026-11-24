"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useRouter } from "next/navigation";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { suspend } from "suspend-react";
import * as THREE from "three/webgpu";
import { color, float, uniform, vec4 } from "three/tsl";
import { cameraTaken, orbitControls, orbitPoint } from "@/shared/engine/controls";
import { useDispose } from "@/shared/engine/dispose";
import { focusBlur, focusDistance, postBypass, postRest, postSharp } from "@/shared/engine/Post";
import { scenePhase } from "@/shared/engine/quality";
import { sound } from "@/shared/engine/sound";
import { LookContext } from "@/shared/engine/Stage";
import type { Look } from "@/shared/engine/types";
import { promptDayFor } from "@/shared/days";
import { returnState } from "../returning";
import { flick, hubSound } from "../sounds";
import { buildPage, FLAT, loadFonts, PAGE_FOV, PX, type Item } from "../hub/Hub";
import { snap } from "../hub/text";
import { layoutPage, PLATE_ROOM, RAISE, type PageLayout } from "../hub/layout";
import { BG } from "../hub/materials";
import { loadPosters } from "../hub/pictures";
import { hubState, placeActions, resetView, setMoving } from "../hub/state";
import { SKY_LAYER, skyColour, unfold, type Palette } from "./kit";
import { hover as showHover, pageSheet, place, shown } from "./mirror";
import { cardMove, movePace, transition, type CardPose, type Transition } from "./transitions";
import { prefaceState } from "../preface";

/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */

// The calendar page, as /codevember shows it, and the move between it and the 3D calendar, either of two ways.
//
// In place, the page is the calendar's own face: it stands where the month stands, square on to the camera, which is as far
// back as makes one CSS pixel of it one on screen, with no blur of the lens. Its title and its buttons are solids pressed flat
// into it. Asked for 3D, the camera eases back and round; the title and the buttons stand out of the page; each card grows
// a tile's depth behind it, in a wave from the top left, and becomes that tile; and the plate the month stands on comes out
// behind them. The words under the title stay.
//
// As a flight, the page lies far below the 3D calendar, the camera looking straight down at it. Asked for 3D, the camera
// rises from it and swings round to the calendar while every card lifts off the page and flies to its day's tile, landing
// on its face as the tile comes up behind it; the page's dark gives way to the sky.
//
// Asked for 2D, either plays back the other way.

// How long the move takes, how the cards leave the page and the paths they and the camera take: see transitions.ts.
// As a flight: how far below the calendar the page lies.
const DROP = 30;
// The part of each card's own flight over which it lands: the tile grows in behind it and the card fades into it.
const LANDING = 0.2;
// The page's look: no glow, darkened corners or grain, which would show on flat text and pictures.
const SPIN_AXIS = new THREE.Vector3(0, 0, 1);
// In place: the calendar seen from this far round to the right and this far above, in radians; the field of view there; and
// how much further back than fits it the camera first pulls, square on, before turning; how much room is left round it on a
// phone, and elsewhere how much of the view's width and height it fills.
const VIEW = { round: 0.3, above: 0.12, fov: 40, back: 1.2, room: 1.22, fill: [0.9, 0.84] };
// How much of the move's time the way back to the page takes.
const RETURN = 0.62;
const PAGE_LOOK: Partial<Look> = { bloom: 0, vignette: 0, grain: 0, ao: 0 };
const HUB = "/";

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
// How long the page goes on being drawn after anything moves on it or is done to it, for what that set going to settle.
const AWAKE = 3;
// How long after the page starts rising into view it has settled, every card and button, and can be HTML (mirror.ts); and
// how long the HTML takes to fade in over the GPU's copy, which stays under it until then (hub.css).
const INTRO = 2.6;
// The part of the move over which the title and the buttons go over from their flat pictures to their solid selves.
const STAND = 0.06;
// What a visitor does to the page, which wakes the GPU's copy only while it is the one on show.
const INPUT = new Set(["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "touchstart", "touchmove", "scroll"]);
const approach = (from: number, to: number, time: number, delta: number) => to + (from - to) * Math.exp(-delta / time);
const stillness = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Where on the page the visitor was, kept while the site is open, for coming back to it from a day.
const kept = { scroll: 0 };

// Where a day's card lands: its tile's face, in the world, and the face's size.
export type Landing = (day: number, position: THREE.Vector3, quaternion: THREE.Quaternion, size: THREE.Vector2) => void;

// The page, laid out as the window has it; laid out again a moment after the window stops changing width, as a page reflows.
export function usePageLayout() {
  const fonts = suspend(loadFonts, ["cv-hub-fonts"]);
  const size = useThree((state) => state.size);
  const [layout, setLayout] = useState(() => layoutPage(size.width, size.height, fonts));
  useEffect(() => {
    if (layout.width === size.width) return;
    const timer = window.setTimeout(() => setLayout(layoutPage(size.width, size.height, fonts)), 150);
    return () => window.clearTimeout(timer);
  }, [size.width, size.height, fonts, layout.width]);
  return layout;
}

// The page as the face of the month, in place: metres to the CSS pixel, a card being a tile wide; and the page's point at
// the month's middle, the middle of everything from the title to the last card, in CSS pixels. `w` and `h` are that much
// of the page in metres; `right` and `top` are the cards' top right corner, in CSS pixels.
export type Sheet = { u: number; cx: number; cy: number; w: number; h: number; right: number; top: number };
export function sheetOf(layout: PageLayout, tileWidth = 1): Sheet {
  const { cards, title } = layout;
  const left = Math.min(title.x, cards[0].x);
  const right = Math.max(...cards.map((card) => card.x + card.w));
  const top = title.y;
  const bottom = Math.max(...cards.map((card) => card.y + card.h));
  const u = tileWidth / cards[0].w;
  return { u, cx: (left + right) / 2, cy: (top + bottom) / 2, w: (right - left) * u, h: (bottom - top) * u, right, top: cards[0].y };
}
// How far in front of the month's faces the page lies, in metres, so that neither shows through the other as one gives way
// to the other; and where the camera on the page is reckoned from, so that a CSS pixel there is one on screen exactly.
export const PAGE_Z = 0.006;
// A point of the page, in CSS pixels, in the month's own space.
export const onSheet = (sheet: Sheet, x: number, y: number, out: THREE.Vector3, z = 0) => out.set((x - sheet.cx) * sheet.u, (sheet.cy - y) * sheet.u, z);

// `look` is the world's own, put back over the page's on the way into it; `rest`, where the month hangs, at rest, in the world;
// `palette`, the sky's, for the page's words to be mixed over it as the browser would.
export function Unfold({ layout, month, rest, landing, look, palette, children }: { layout: PageLayout; month: THREE.Object3D; rest: THREE.Matrix4; landing: Landing; look: Partial<Look>; palette?: Palette; children: ReactNode }) {
  const fonts = suspend(loadFonts, ["cv-hub-fonts"]);
  const posters = suspend(loadPosters, ["cv-hub-posters"]);
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;
  const get = useThree((state) => state.get);
  const router = useRouter();
  const setLook = useContext(LookContext);
  const sheet = useMemo(() => sheetOf(layout), [layout]);
  const worldLook = useMemo(() => ({ bloom: look.bloom, vignette: look.vignette, grain: look.grain, ao: look.ao }), [look]);

  const geometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);
  // The page without its marks: the hub's own, over everything, stand in for them in both views.
  // In place, the page stands in front of the sky.
  const sky = useMemo(() => (palette && transition().kind === "page" ? skyColour(palette) : undefined), [palette]);
  const page = useMemo(() => {
    const built = buildPage(layout, fonts, posters, geometry, false, sky, true);
    // The title's picture over the type it gives way to, as one goes over to the other (`unfold.standing`).
    for (const item of built.items) if (item.title) (item.mesh.material as THREE.Material).depthTest = false;
    return built;
  }, [layout, fonts, posters, geometry, sky]);
  // The page's own dark, under it and far past its edges, fading as the sky comes in.
  const ground = useMemo(() => {
    const opacity = uniform(1);
    const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.colorNode = vec4(color(BG), float(1)) as any;
    // Drawn straight to the screen on the page, past the passes, so the renderer's own tone mapping must leave it be.
    material.toneMapped = false;
    material.opacityNode = opacity as any;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), material);
    mesh.quaternion.copy(FLAT);
    mesh.renderOrder = -5;
    return { mesh, opacity };
  }, []);
  useDispose(geometry, ground.mesh.geometry, ground.mesh.material as THREE.Material);
  useDispose(...page.disposables);

  // The page lies in its own frame: x across, z down the page, from its top middle, turned so that up the page is the way
  // the calendar is seen from.
  const frame = useMemo(() => new THREE.Object3D(), []);
  const world = useRef<THREE.Group>(null);
  const run = useRef({
    morph: 0,
    scroll: kept.scroll,
    target: kept.scroll,
    placed: false,
    still: false,
    // Until when the page is drawn though nothing seems to move on it (below), and what moved it last frame.
    awake: 0,
    shown: { scroll: -1, hovered: null as Item | null },
    // Whether the page is HTML now, the canvas behind it drawing the sky alone, and what the camera saw before that.
    html: false,
    layers: 1,
    introAt: -1,
    // Where the camera is in the world, to swing to and from: the calendar's starting view, or wherever it was left.
    eye: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), fov: 40, target: new THREE.Vector3() },
    // In place, on the way into the calendar: whether the camera has been taken from the move, by a drag, the wheel or the
    // keys, to be turned and flown as in the calendar while the rest of the move plays out.
    free: false,
    // How far each card had got through its turn last frame, by day, to hear it pass the point its move makes a sound at.
    turned: new Float32Array(32).fill(-1),
    // In place: the view of the month the move goes to or comes from, and the point it turns round.
    view: { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: VIEW.fov },
    // The move just finished in the world: the point to hand the rig to turn round.
    handing: false,
    hovered: null as Item | null,
    pointer: { down: null as null | { x: number; y: number }, moved: 0 },
    cursor: "",
    // A touch screen: in the calendar, one finger slides the view, as a page scrolls.
    touch: typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
    handed: false,
    unculled: false
  });
  const items = useRef(page.items);
  items.current = page.items;

  // The page scrolls as the browser scrolls anything, because the browser scrolls it: an empty scrolling box over the canvas,
  // as tall as the page, whose scroll the camera follows. The wheel, a trackpad's glide, a flick of a finger and the keys all
  // move and coast exactly as they would on any page. On the page only; elsewhere it lets everything through to the canvas.
  const scroller = useMemo(() => {
    const box = document.createElement("div");
    box.className = "cv-page-scroll";
    box.setAttribute("aria-hidden", "true");
    const tall = document.createElement("div");
    box.appendChild(tall);
    return { box, tall };
  }, []);
  useEffect(() => {
    const stage = dom.closest(".cv-stage") ?? dom.parentElement;
    stage?.appendChild(scroller.box);
    scroller.box.appendChild(pageSheet());
    return () => scroller.box.remove();
  }, [dom, scroller]);

  // The page as HTML (mirror.ts): its words and its cards' posters, shown from the very pictures the GPU draws them from,
  // and its cards made of them with the same shade and border, each where the GPU lays it. Made in an effect, not a memo: a
  // canvas can be in one place only, and React's dev mode makes a memo twice.
  const mirrored = useRef({ elements: new Map<Item, HTMLElement>(), ready: false });
  useEffect(() => {
    const made = { elements: new Map<Item, HTMLElement>(), ready: true };
    const today = promptDayFor(new Date());
    for (const item of page.items) {
      const art = item.art.image as HTMLCanvasElement;
      const card = item.card?.layout;
      if (!card) {
        const element = shown(art, item.rect);
        element.style.opacity = String(item.base);
        made.elements.set(item, element);
        continue;
      }
      const box = place(document.createElement("div"), card);
      box.className = `cv-page-html-card${card.open ? " cv-open" : ""}${card.day.day === today ? " cv-today" : ""}`;
      const picture = item.card?.picture?.image as HTMLCanvasElement | undefined;
      if (picture) {
        const shade = document.createElement("i");
        shade.className = "cv-page-html-shade";
        box.append(shown(picture, { x: 0, y: 0, w: card.w, h: card.h }, "cv-page-html-poster"), shade);
      }
      box.appendChild(shown(art, { x: 0, y: 0, w: card.w, h: card.h }));
      made.elements.set(item, box);
    }
    pageSheet().append(...made.elements.values());
    mirrored.current = made;
    return () => {
      made.ready = false;
      for (const element of made.elements.values()) element.remove();
    };
  }, [page]);
  useEffect(() => {
    scroller.tall.style.height = `${layout.page}px`;
    // Back where the visitor was, coming back from a day.
    scroller.box.scrollTop = run.current.target;
  }, [layout, scroller]);

  // Coming back from a day entered from the calendar: straight into the calendar. Otherwise the page, rising into view.
  useEffect(() => {
    const r = run.current;
    r.still = stillness();
    const back = returnState().phase === "crossing" && unfold.lastView === "3d";
    r.morph = back ? 1 : 0;
    // The page rises into view once the loader has gone, not behind it; and not at all under the plain page (HubPage.tsx),
    // which it takes over from at rest.
    r.introAt = returnState().phase === "crossing" || prefaceState().up ? -100 : Infinity;
    resetView(back ? "3d" : "2d");
    setLook(back ? worldLook : PAGE_LOOK);
    // Drawn straight to the screen at rest, the page goes through the renderer's own tone mapping, which must leave it as
    // the passes do (toneMapping "none").
    const gl = get().gl;
    const toneMapping = gl.toneMapping;
    gl.toneMapping = THREE.NoToneMapping;
    return () => {
      gl.toneMapping = toneMapping;
      unfold.amount = 0;
      unfold.inWorld = false;
      unfold.landed.fill(0);
      unfold.plate = unfold.solid = unfold.solidness.value = 0;
      focusBlur.value = 1;
      postBypass.current = postRest.current = false;
      postSharp.value = 0;
      if (run.current.html) get().camera.layers.mask = run.current.layers;
      run.current.html = false;
      pageSheet().classList.remove("cv-page-html-on");
      setMoving(false);
      dom.style.cursor = "";
    };
  }, [setLook, dom, worldLook, get]);

  // On the way into the calendar, the camera can be taken at any moment, without waiting for the move to end: the first
  // drag, turn of the wheel or flying key lets the move go of it. Caught on the way down, ahead of the rig's own listeners.
  useEffect(() => {
    const r = run.current;
    const entering = () => r.morph < 1 && hubState().view === "3d" && transition().kind === "page";
    const take = (event: Event) => {
      if (entering() && (event.type === "keydown" || event.target === dom)) r.free = true;
    };
    const onKey = (event: KeyboardEvent) => {
      if (/^(Key[WASDQE]|Arrow|Space)/.test(event.code) && !event.metaKey && !event.ctrlKey && !event.altKey) take(event);
    };
    window.addEventListener("pointerdown", take, true);
    window.addEventListener("wheel", take, { capture: true, passive: true });
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", take, true);
      window.removeEventListener("wheel", take, { capture: true });
      window.removeEventListener("keydown", onKey, true);
    };
  }, [dom]);

  // On the page: the wheel and keys scroll it, and a press on a card goes to its day, on a mark to where it points.
  useEffect(() => {
    const r = run.current;
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const onPage = () => r.morph === 0 && !hubState().moving;
    const maxScroll = () => Math.max(0, layoutRef.current.page - get().size.height);
    const pick = (event: PointerEvent) => {
      if (!onPage()) return null;
      const bounds = dom.getBoundingClientRect();
      ndc.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const live = items.current.filter((item) => item.href);
      const hit = raycaster.intersectObjects(
        live.map((item) => item.mesh),
        false
      )[0];
      return hit ? live.find((item) => item.mesh === hit.object) ?? null : null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (!onPage() || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT|BUTTON/.test(target.tagName)) return;
      const height = get().size.height;
      // As Chrome scrolls a page by its keys, smoothly.
      const moves: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: height * 0.875, PageUp: -height * 0.875, " ": (event.shiftKey ? -1 : 1) * height * 0.875 };
      let next = scroller.box.scrollTop;
      if (event.key in moves) next += moves[event.key];
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = maxScroll();
      else return;
      event.preventDefault();
      scroller.box.scrollTo({ top: next, behavior: "smooth" });
    };
    const onDown = (event: PointerEvent) => {
      r.pointer.down = { x: event.clientX, y: event.clientY };
      r.pointer.moved = 0;
    };
    const onMove = (event: PointerEvent) => {
      const down = r.pointer.down;
      if (down) {
        r.pointer.moved = Math.max(r.pointer.moved, Math.hypot(event.clientX - down.x, event.clientY - down.y));
      }
      if (event.pointerType === "mouse") r.hovered = pick(event);
    };
    const onUp = (event: PointerEvent) => {
      const down = r.pointer.down;
      r.pointer.down = null;
      if (!down || r.pointer.moved > 6) return;
      const item = pick(event);
      if (!item?.href) return;
      if (item.external || event.metaKey || event.ctrlKey || event.shiftKey) {
        window.open(item.href, "_blank", "noopener");
        return;
      }
      if (item.href === "/") {
        router.push("/");
        return;
      }
      if (item.card) {
        kept.scroll = r.target;
        unfold.lastView = "2d";
        sound.play("click", { gain: 0.3 });
        router.push(`${HUB}${item.card.layout.slug}/`);
      }
    };
    const onLeave = () => {
      r.hovered = null;
    };
    // On the page, presses land on the scrolling box over the canvas.
    // A finger that starts a scroll is the browser's from then on: no press.
    const onCancel = () => {
      r.pointer.down = null;
    };
    window.addEventListener("keydown", onKey);
    for (const target of [dom, scroller.box] as HTMLElement[]) {
      target.addEventListener("pointerdown", onDown);
      target.addEventListener("pointerleave", onLeave);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const target of [dom, scroller.box] as HTMLElement[]) {
        target.removeEventListener("pointerdown", onDown);
        target.removeEventListener("pointerleave", onLeave);
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [camera, dom, get, router, scroller]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Anything done to the page wakes it (above). A resize, or coming back to the tab, needs a fresh frame too.
  useEffect(() => {
    // While the page is HTML, scrolling and pointing are the browser's alone: nothing for the GPU to draw.
    const wake = (event: Event) => {
      if (run.current.html && INPUT.has(event.type)) return;
      run.current.awake = performance.now() / 1000 + AWAKE;
    };
    const kinds = ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "touchstart", "touchmove", "resize", "focus"];
    for (const kind of kinds) window.addEventListener(kind, wake, { passive: true });
    document.addEventListener("visibilitychange", wake);
    scroller.box.addEventListener("scroll", wake, { passive: true });
    return () => {
      for (const kind of kinds) window.removeEventListener(kind, wake);
      document.removeEventListener("visibilitychange", wake);
      scroller.box.removeEventListener("scroll", wake);
    };
  }, [scroller]);

  const scratch = useMemo(
    () => ({
      pageCamera: new THREE.Vector3(),
      pageQuaternion: new THREE.Quaternion(),
      cardQuaternion: new THREE.Quaternion(),
      forward: new THREE.Vector3(),
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      toQuaternion: new THREE.Quaternion(),
      toSize: new THREE.Vector2(),
      up: new THREE.Vector3(0, 1, 0),
      side: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      spin: new THREE.Quaternion(),
      monthQuaternion: new THREE.Quaternion(),
      look: new THREE.Vector3(),
      orbit: new THREE.Vector3(),
      spherical: new THREE.Spherical(),
      eye: new THREE.PerspectiveCamera(),
      pose: { alpha: 1, scale: 1, turnY: 0 } as CardPose
    }),
    []
  );

  // Before the calendar's own frame, so that by the time it reads how far each card has landed, this frame's is set; and
  // after the camera rig's, so that in the world it can take the camera's place as the rig leaves it.
  useFrame((_, rawDelta) => {
    const r = run.current;
    const s = scratch;
    const delta = Math.min(rawDelta, 1 / 20);
    const now = performance.now() / 1000;
    const { height } = get().size;
    const maxScroll = Math.max(0, layoutRef.current.page - height);

    // Never culled: while the scene warms up behind the loader, the world is drawn though out of view from the page, so its
    // pipelines are built then rather than on the first frame of the move.
    if (!r.unculled && world.current) {
      r.unculled = true;
      world.current.traverse((object) => (object.frustumCulled = false));
    }

    // Laid down once, under where the calendar is seen from: the page's middle under the middle of the view.
    if (!r.placed) {
      r.placed = true;
      r.eye.position.copy(camera.position);
      r.eye.quaternion.copy(camera.quaternion);
      r.eye.fov = camera.fov;
      if (orbitPoint.current) r.eye.target.copy(orbitPoint.current);
      camera.getWorldDirection(s.forward);
      const yaw = Math.atan2(-s.forward.x, -s.forward.z);
      frame.quaternion.setFromAxisAngle(s.up, yaw);
      // The point on the page in the middle of the screen, DROP below the point in the middle of the calendar's view.
      const below = camera.position.clone().addScaledVector(s.forward, 14);
      below.y -= DROP;
      frame.position.set(0, 0, -(r.scroll + height / 2) * PX).applyAxisAngle(s.up, yaw).add(below);
      frame.updateMatrixWorld();
      ground.mesh.position.set(0, -0.01, 0);
    }

    // On the page, where the browser has scrolled it to; off it, the box lets presses, drags and the wheel through.
    const scrolling = r.morph === 0 && !hubState().moving;
    if (scrolling) r.target = r.scroll = Math.min(maxScroll, Math.max(0, scroller.box.scrollTop));
    if (scroller.box.classList.contains("cv-page-scroll-off") === scrolling) scroller.box.classList.toggle("cv-page-scroll-off", !scrolling);
    r.target = Math.min(maxScroll, r.target);
    r.scroll = approach(r.scroll, r.target, 0.07, delta);
    if (Math.abs(r.scroll - r.target) < 0.05) r.scroll = r.target;

    // Between page and world, at the pace the toggle asks for.
    const style = transition();
    const want = hubState().view === "3d" ? 1 : 0;
    if (r.morph !== want) {
      if (r.morph === 1) {
        // Leaving the world: from wherever the camera was left, to come back to it.
        r.eye.position.copy(camera.position);
        r.eye.quaternion.copy(camera.quaternion);
        r.eye.fov = camera.fov;
        if (orbitPoint.current) r.eye.target.copy(orbitPoint.current);
        r.view.position.copy(camera.position);
        r.view.target.copy(orbitPoint.current ?? r.view.target);
        r.view.fov = camera.fov;
        hubSound("move", { back: true });
      }
      if (want === 0 && r.free) {
        // Turned back part way in, with the camera taken: back to the page from wherever it was left.
        r.free = false;
        r.view.position.copy(camera.position);
        r.view.target.copy(orbitPoint.current ?? r.view.target);
        r.view.fov = camera.fov;
      }
      if (r.morph === 0) {
        r.free = false;
        setLook(worldLook);
        hubSound("move");
        if (style.kind === "page") viewOf(r.view);
      }
      setMoving(true);
      // Back to the page a good deal quicker than into the calendar: the way out wants to feel like a release, not a journey.
      const pace = r.still ? 0.5 : style.kind === "page" ? movePace() * (want === 0 ? RETURN : 1) : style.seconds;
      r.morph = want > r.morph ? Math.min(1, r.morph + delta / pace) : Math.max(0, r.morph - delta / pace);
      if (r.morph === want) {
        setMoving(false);
        if (want === 0) setLook(PAGE_LOOK);
        else r.handing = true;
      }
    }
    const amount = ease(r.morph);
    unfold.amount = amount;
    const inWorld = r.morph === 1 && !hubState().moving;
    if (inWorld !== unfold.inWorld) {
      unfold.inWorld = inWorld;
      // The rig has the camera in the world, from where it is now, turning round the point the move ended looking at;
      // everywhere else, this does.
      if (inWorld && r.handing && !(style.kind === "page" && r.free)) orbitPoint.current?.copy(style.kind === "page" ? r.view.target : r.eye.target);
    }
    // In place, the rig has it from the start of the way in too, so that it can be taken at once; until it is, this steers
    // it, and the rig, given no drag, leaves it where it is put.
    cameraTaken.current = !(inWorld || (style.kind === "page" && want === 1 && r.morph > 0));
    r.handing = false;
    if (r.touch) touchCalendar(inWorld);
    // In place, the world holds the buttons, on the page too.
    if (world.current) world.current.visible = r.morph > 0 || style.kind === "page";
    // Resting on the page, or scrolling it, a flat page has nothing for the passes to do: drawn straight to the screen, which
    // on a phone is most of the cost of a frame. The same picture: the renderer draws into a buffer of its own in the same
    // linear colour, blends the page's soft edges there as the passes' first does, and puts it on screen untouched (no tone
    // mapping, as the passes have none here), and the page's look leaves the passes nothing else (no bloom, vignette or grain;
    // no lens and no edge smoothing at rest). Not while warming up, so that the passes' own pipelines are built then too.
    postBypass.current = r.morph === 0 && !hubState().moving && scenePhase.current === "live";
    // In place, resting on the page: the passes leave the frame as drawn, with no lens and no edge smoothing, so that the
    // page's words and buttons are as sharp as the browser's own. Both come back the moment the page moves.
    // Eased in over the last moments of the way back, and out over the first of the way in, so that the page sharpens into
    // its resting self rather than at a stroke.
    postSharp.value = style.kind === "page" ? 1 - smooth(clamp01(r.morph / STAND)) : 0;
    // Resting on the page with nothing moving on it, nothing is drawn: the last frame stays on screen and the GPU rests, cool
    // for the next scroll. Drawn again from the first frame anything moves or is touched, and for a while after, as long as
    // what it set going (a card rising under the pointer, the buttons popping up as the page comes) takes to settle.
    // Once it has risen into view and lies still, the page is HTML (mirror.ts), which shows what the GPU's copy at rest does,
    // pixel for pixel; and the canvas behind it draws the sky alone, once. From the first frame the page moves, the GPU's
    // copy again. Each changes over in the same frame: the browser puts the canvas and the page on screen together.
    const html = postBypass.current && style.kind === "page" && mirrored.current.ready && now - r.introAt > INTRO;
    if (html !== r.html) {
      r.html = html;
      r.awake = Math.max(r.awake, now + 0.25);
      pageSheet().classList.toggle("cv-page-html-on", html);
      if (html) {
        r.layers = camera.layers.mask;
        camera.layers.set(SKY_LAYER);
      } else camera.layers.mask = r.layers;
    }
    if (html) for (const [item, element] of mirrored.current.elements) if (item.card) showHover(element, r.hovered === item);
    if (!postBypass.current || (!html && (r.scroll !== r.shown.scroll || r.hovered !== r.shown.hovered))) r.awake = Math.max(r.awake, now + AWAKE);
    r.shown.scroll = r.scroll;
    r.shown.hovered = r.hovered;
    postRest.current = postBypass.current && now > r.awake;

    if (r.introAt === Infinity && scenePhase.current === "live") r.introAt = now;
    if (style.kind === "page") inPlace(r.morph, inWorld, delta, now);
    else flight(style, inWorld, delta, now);
  }, -0.5);

  // In place: the view the move ends on, the whole month and its title in view from a little round to the right.
  const viewOf = (view: { position: THREE.Vector3; target: THREE.Vector3; fov: number }) => {
    month.updateWorldMatrix(true, false);
    month.getWorldPosition(view.target);
    const half = Math.tan(THREE.MathUtils.degToRad(VIEW.fov / 2));
    const { width, height } = get().size;
    const across = (sheet.w / 2 / (half * (width / height))) * VIEW.room;
    let away = Math.max(sheet.h / 2 / half, sheet.w / 2 / (half * (width / height))) * VIEW.room;
    view.fov = VIEW.fov;
    // On a window taller than it is wide, as a phone's, the page is far taller than it is wide and would be a thin tower far
    // off: its top instead, close, nearly as wide as the view, to be slid down with a finger (touchCalendar).
    if (width < height && away > across * 1.6) {
      away = across * 0.92;
      month.localToWorld(view.target.set(0, sheet.h / 2 - away * half * 0.9, 0));
      view.position.setFromSphericalCoords(away, Math.PI / 2 - VIEW.above, VIEW.round).add(view.target);
      return;
    }
    // Otherwise the whole of it, from title to plate, as the month hangs at rest: seen from the side, it would sit off to one
    // side of the view, so the camera slides over until it is in the middle, and comes in until it fills the view.
    const s = scratch;
    const eye = s.eye;
    eye.fov = VIEW.fov;
    eye.aspect = width / height;
    eye.updateProjectionMatrix();
    s.spherical.set(1, Math.PI / 2 - VIEW.above, VIEW.round);
    s.orbit.setFromSpherical(s.spherical);
    // Round the cards and the title, the plate and its frame, and under them the strip saying how many days are left.
    const strip = layoutRef.current.countdown.strip ? (layoutRef.current.countdown.h + 16) * sheet.u : 0;
    const round = PLATE_ROOM + 0.2;
    const corners = [-1, 1].flatMap((x) =>
      [-1, 1].flatMap((y) => [0.1, -0.6].map((z) => new THREE.Vector3(x * (sheet.w / 2 + round), y > 0 ? sheet.h / 2 : -sheet.h / 2 - round - strip, z).applyMatrix4(rest)))
    );
    for (let i = 0; i < 6; i++) {
      eye.position.copy(view.target).addScaledVector(s.orbit, away);
      eye.lookAt(view.target);
      eye.updateMatrixWorld();
      let [left, right, bottom, top] = [Infinity, -Infinity, Infinity, -Infinity];
      for (const corner of corners) {
        s.look.copy(corner).project(eye);
        left = Math.min(left, s.look.x);
        right = Math.max(right, s.look.x);
        bottom = Math.min(bottom, s.look.y);
        top = Math.max(top, s.look.y);
      }
      const tall = away * half;
      view.target.addScaledVector(s.side.set(1, 0, 0).applyQuaternion(eye.quaternion), ((left + right) / 2) * tall * eye.aspect);
      view.target.addScaledVector(s.side.set(0, 1, 0).applyQuaternion(eye.quaternion), ((top + bottom) / 2) * tall);
      away *= Math.max((right - left) / 2 / VIEW.fill[0], (top - bottom) / 2 / VIEW.fill[1]);
    }
    view.position.copy(view.target).addScaledVector(s.orbit, away);
  };

  // On a touch screen, in the calendar: a finger slides the view up and down the month, and across it, as it scrolls a page,
  // carrying on and slowing when let go (the rig's own damping); two fingers pinch to come nearer and turn it. Turning with
  // one finger, the way a mouse does, left the later days out of reach below on a phone. The point looked at is kept on the
  // month, from its title down to its last row, so a slide never runs off into the sky.
  const touchCalendar = (inWorld: boolean) => {
    const controls = orbitControls.current;
    if (!controls) return;
    controls.touches.ONE = inWorld ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    controls.touches.TWO = inWorld ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN;
    if (!inWorld) return;
    const s = scratch;
    const point = controls.target;
    month.updateWorldMatrix(true, false);
    const top = month.localToWorld(s.from.set(0, sheet.h / 2, 0)).y;
    const bottom = month.localToWorld(s.to.set(0, -sheet.h / 2, 0)).y;
    const left = month.localToWorld(s.from.set(-sheet.w / 2, 0, 0)).x;
    const right = month.localToWorld(s.to.set(sheet.w / 2, 0, 0)).x;
    s.side.set(THREE.MathUtils.clamp(point.x, Math.min(left, right), Math.max(left, right)) - point.x, THREE.MathUtils.clamp(point.y, Math.min(top, bottom), Math.max(top, bottom)) - point.y, 0);
    if (s.side.lengthSq() === 0) return;
    point.add(s.side);
    camera.position.add(s.side);
  };

  const inPlace = (morph: number, inWorld: boolean, delta: number, now: number) => {
    const r = run.current;
    const s = scratch;
    const { width } = layoutRef.current;
    const { height } = get().size;
    month.updateWorldMatrix(true, false);
    month.getWorldQuaternion(s.monthQuaternion);

    // The camera: square on to the page, far enough back that a CSS pixel of it is one on screen, over the part scrolled to;
    // pulled straight back from it; then turned round to the view of the month, each easing into the next.
    const lift = height / 2 / Math.tan(THREE.MathUtils.degToRad(PAGE_FOV / 2));
    // On the way back the two run together the whole way, so that neither comes to rest while the other is still to start.
    const returning = hubState().view === "2d";
    const back = returning ? smoother(clamp01(morph / 0.9)) : smoother(clamp01(morph / 0.6));
    const turn = returning ? smoother(clamp01(morph)) : smoother(clamp01((morph - 0.12) / 0.88));
    if (!inWorld && r.free) {
      // Taken: turned round by the rig, the lens on the point it turns round, the view still widening to the calendar's.
      const fov = THREE.MathUtils.lerp(PAGE_FOV, r.view.fov, back);
      if (Math.abs(camera.fov - fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      if (orbitPoint.current) focusDistance.value = camera.position.distanceTo(orbitPoint.current);
    } else if (!inWorld) {
      const v = r.view;
      // Scrolled by whole pixels of the screen, as the browser scrolls, so that the page's words stay on its pixels.
      const scroll = snap(r.scroll);
      month.localToWorld(onSheet(sheet, width / 2, scroll + height / 2, s.pageCamera, lift * sheet.u + PAGE_Z));
      month.localToWorld(onSheet(sheet, width / 2, scroll + height / 2, s.look));
      // Round the point looked at: from square on and further back than the view, to the view.
      s.spherical.setFromVector3(s.orbit.subVectors(v.position, v.target));
      const square = s.spherical.radius * VIEW.back;
      s.spherical.set(THREE.MathUtils.lerp(square, s.spherical.radius, turn), THREE.MathUtils.lerp(Math.PI / 2, s.spherical.phi, turn), s.spherical.theta * turn);
      s.orbit.setFromSpherical(s.spherical).add(v.target);
      camera.position.lerpVectors(s.pageCamera, s.orbit, back);
      s.look.lerp(v.target, back);
      camera.up.set(0, 1, 0);
      camera.lookAt(s.look);
      const fov = THREE.MathUtils.lerp(PAGE_FOV, v.fov, back);
      if (Math.abs(camera.fov - fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();
      focusDistance.value = camera.position.distanceTo(s.look);
      // The point the rig turns round, should it be taken now.
      orbitPoint.current?.copy(s.look);
    }
    ground.mesh.visible = false;

    // The title and the buttons stand out of the page, and the plate comes out behind the cards, as the camera eases back;
    // and the lens, sharp all through on the page, comes to blur what it is not on.
    unfold.solid = unfold.solidness.value = smoother(clamp01(morph / 0.45));
    unfold.plate = clamp01((morph - 0.18) / 0.5);
    unfold.standing = unfold.standingness.value = smooth(clamp01(morph / STAND));
    // Only once the calendar has mostly turned to the eye, and gently; and gone again early on the way back to the page.
    focusBlur.value = smoother(clamp01((morph - 0.5) / 0.5)) * 0.7;
    const moveOf = cardMove();

    let cursor = "";
    const { cards } = layoutRef.current;
    const first = cards[0];
    const columns = cards.filter((card) => card.y === first.y).length;
    const rows = Math.ceil(cards.length / columns);
    for (const item of items.current) {
      const { mesh, rect } = item;
      // Rising into view as the page opens, on a spring that settles just past its place and back, fading in as it comes.
      const since = (now - r.introAt - item.intro) / (item.rise > 20 ? 1.1 : 0.85);
      const shown = smooth(clamp01(since * 2.2));
      const settled = since <= 0 ? 0 : since >= 1.4 ? 1 : 1 - Math.exp(-6 * since) * Math.cos(since * 6.5);
      const hovered = r.hovered === item && morph === 0;
      if (hovered) cursor = "pointer";
      item.hover.lift = approach(item.hover.lift, hovered ? 1 : 0, 0.12, delta);
      item.hover.zoom = approach(item.hover.zoom, hovered ? 1 : 0, 0.3, delta);
      // The title and the words under it go up a little as the page stands out, with the buttons.
      const pageY = rect.y + rect.h / 2 + (1 - settled) * item.rise - (item.card ? 7 * item.hover.lift : RAISE * unfold.solid);
      // Just in front of the faces they become, so that neither shows through the other as one gives way to the other.
      month.localToWorld(onSheet(sheet, rect.x + rect.w / 2, pageY, mesh.position, PAGE_Z));
      mesh.quaternion.copy(s.monthQuaternion);
      mesh.scale.set(rect.w * sheet.u, rect.h * sheet.u, 1);
      let alpha = (item.base + (1 - item.base) * (item.card ? 0 : item.hover.lift)) * shown;

      if (item.card) {
        const number = item.card.layout.day.day;
        const column = Math.round((rect.x - first.x) / (rect.w + 8));
        const row = Math.round((rect.y - first.y) / (rect.h + 8));
        // Each card's turn, in the order the chosen move takes them (transitions.ts): how the card shows through it, and
        // how far it has got, for the tile it becomes (calendar.tsx).
        const own = clamp01((morph - 0.1 - moveOf.order(column, row, columns, rows) * moveOf.spread) / moveOf.length);
        unfold.landed[number] = own;
        const before = r.turned[number];
        r.turned[number] = own;
        if (moveOf.sound !== undefined && before >= 0 && (before < moveOf.sound) !== (own < moveOf.sound)) flick(0.9 + Math.random() * 0.2 + (own > before ? 0.04 : -0.04), 0.9 + Math.random() * 0.2);
        moveOf.card(own, s.pose);
        alpha *= s.pose.alpha;
        mesh.scale.multiplyScalar(s.pose.scale).setZ(1);
        if (s.pose.turnY) mesh.quaternion.multiply(s.spin.setFromAxisAngle(s.up, s.pose.turnY));
        const u = item.card.uniforms;
        u.lift.value = item.hover.lift;
        u.zoom.value = item.hover.zoom;
        u.metres.value.set(mesh.scale.x, mesh.scale.y);
      } else if (item.title) {
        // Drawn as the page draws it while the page rests; the type, flat where it lies, comes through it as the move begins.
        alpha *= 1 - unfold.standing;
      }
      item.opacity.value = alpha;
      mesh.visible = alpha > 0.001;
    }

    if (!inWorld && cursor !== r.cursor) {
      r.cursor = cursor;
      dom.style.cursor = cursor;
      scroller.box.style.cursor = cursor;
    }
    if (inWorld) r.cursor = "-";
  };

  const flight = (style: Extract<Transition, { kind: "flight" }>, inWorld: boolean, delta: number, now: number) => {
    const r = run.current;
    unfold.standing = unfold.standingness.value = r.morph > 0 ? 1 : 0;
    const s = scratch;
    const { width } = layoutRef.current;
    const { height } = get().size;
    const travelled = ease(r.still ? r.morph : style.camera(r.morph));

    // The camera: straight down over the page, or where it was in the world, swung from one to the other on the way.
    const lift = height / 2 / Math.tan(THREE.MathUtils.degToRad(PAGE_FOV / 2));
    if (!inWorld) {
      s.pageCamera.set(0, lift * PX, (r.scroll + height / 2) * PX).applyMatrix4(frame.matrixWorld);
      s.pageQuaternion.copy(frame.quaternion).multiply(FLAT);
      camera.position.lerpVectors(s.pageCamera, r.eye.position, travelled);
      if (!r.still) {
        camera.position.y += Math.sin(travelled * Math.PI) * style.rise;
        camera.position.addScaledVector(s.side.set(1, 0, 0).applyQuaternion(frame.quaternion), Math.sin(travelled * Math.PI) * style.swing);
      }
      camera.quaternion.slerpQuaternions(s.pageQuaternion, r.eye.quaternion, travelled);
      const fov = THREE.MathUtils.lerp(PAGE_FOV, r.eye.fov, travelled);
      if (Math.abs(camera.fov - fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.updateMatrixWorld();
      // The lens on the page, then on the calendar as it comes into view.
      focusDistance.value = THREE.MathUtils.lerp(lift * PX, r.eye.position.distanceTo(camera.position) + 14, travelled);
    }
    ground.opacity.value = 1 - smooth(clamp01(r.morph / 0.55));
    ground.mesh.visible = ground.opacity.value > 0.001;
    unfold.plate = unfold.solid = unfold.solidness.value = 1;

    // Each thing on the page: rising into view as the page opens, lifting under the pointer, and on the way to the world,
    // the cards leaving the page in turn for their tiles while the rest fades.
    let cursor = "";
    const first = layoutRef.current.cards[0];
    s.centre.set(0, 0.002, (r.scroll + height / 2) * PX).applyMatrix4(frame.matrixWorld);
    for (const item of items.current) {
      const { mesh, rect } = item;
      const since = now - r.introAt - item.intro;
      const entered = 1 - Math.pow(1 - clamp01(since / (item.rise > 20 ? 0.8 : 0.55)), 3);
      const hovered = r.hovered === item && r.morph === 0;
      if (hovered) cursor = "pointer";
      item.hover.lift = approach(item.hover.lift, hovered ? 1 : 0, 0.12, delta);
      item.hover.zoom = approach(item.hover.zoom, hovered ? 1 : 0, 0.3, delta);
      const pageY = rect.y + rect.h / 2 + (1 - entered) * item.rise - (item.card ? 7 * item.hover.lift : 0);
      s.from.set((rect.x + rect.w / 2 - width / 2) * PX, 0.002, pageY * PX).applyMatrix4(frame.matrixWorld);
      s.cardQuaternion.copy(frame.quaternion).multiply(FLAT);
      const flatW = rect.w * PX;
      const flatH = rect.h * PX;
      let alpha = (item.base + (1 - item.base) * (item.card ? 0 : item.hover.lift)) * entered;

      if (item.card) {
        const number = item.card.layout.day.day;
        const column = Math.round((rect.x - first.x) / (rect.w + 8));
        const row = Math.round((rect.y - first.y) / (rect.h + 8));
        const delay = style.order(column, row, number - 1, layoutRef.current.cards.length) * style.stagger;
        const own = smooth(clamp01((r.morph - delay) / (1 - style.stagger)));
        landing(number, s.to, s.toQuaternion, s.toSize);
        const path = { from: s.from, to: s.to, centre: s.centre, own, index: number - 1 };
        if (r.still) mesh.position.lerpVectors(s.from, s.to, own);
        else style.path(mesh.position, path);
        mesh.quaternion.slerpQuaternions(s.cardQuaternion, s.toQuaternion, own);
        if (!r.still) mesh.quaternion.multiply(s.spin.setFromAxisAngle(SPIN_AXIS, style.spin(path)));
        mesh.scale.set(THREE.MathUtils.lerp(flatW, s.toSize.x, own), THREE.MathUtils.lerp(flatH, s.toSize.y, own), 1);
        const landed = smooth(clamp01((own - (1 - LANDING)) / LANDING));
        unfold.landed[number] = landed;
        alpha *= 1 - landed;
        const u = item.card.uniforms;
        u.lift.value = item.hover.lift;
        u.zoom.value = item.hover.zoom;
        u.metres.value.set(mesh.scale.x, mesh.scale.y);
      } else {
        mesh.position.copy(s.from);
        mesh.quaternion.copy(s.cardQuaternion);
        mesh.scale.set(flatW, flatH, 1);
        // The title, the marks and the words under it have no place in the world: they fade as it begins.
        alpha *= 1 - smooth(clamp01(r.morph / 0.2));
      }
      item.opacity.value = alpha;
      mesh.visible = alpha > 0.001;
    }

    if (!inWorld && cursor !== r.cursor) {
      r.cursor = cursor;
      dom.style.cursor = cursor;
      scroller.box.style.cursor = cursor;
    }
    if (inWorld) r.cursor = "-";
  };

  // As a flight, the way to the calendar, on the cards' top right corner, a little above them, held at the top of the window
  // once the cards have scrolled up past it; in the world, back where the stylesheet has it. In place, the buttons are solid,
  // on the page (buttons.tsx), and these stand in for them out of sight, for keyboards and screen readers.
  useFrame(() => {
    if (transition().kind === "flight" && hubState().view === "2d") placeActions(sheet.right, Math.max(sheet.top - run.current.scroll - 12, 64));
    else placeActions(null);
  }, 0.7);

  return (
    <>
      <primitive object={frame}>
        <primitive object={ground.mesh} />
      </primitive>
      <primitive object={page.group} />
      <group ref={world}>{children}</group>
    </>
  );
}
