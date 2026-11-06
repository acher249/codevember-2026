"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

// Anything that can be picked up. The controller owns the pointer, the drag plane and the carry;
// a grabbable only answers "did this ray hit you" and follows the point it is given.
// The point the camera orbits. Anything that pushes the camera has to carry this with it, or the two drift apart.
export const orbitPoint: { current: THREE.Vector3 | null } = { current: null };

type Grabbable = {
  pick: (ray: THREE.Ray) => { distance: number; point: THREE.Vector3 } | null;
  grab: (point: THREE.Vector3) => void;
  drag: (point: THREE.Vector3) => void;
  release: (velocity: THREE.Vector3) => void;
  hover?: (hovering: boolean) => void;
  // For things that lie all over the view. A press that moves is the orbit: only one held still this long is a grab.
  holdToGrab?: number;
};

class GrabRegistry {
  items = new Set<Grabbable>();
}

const GrabContext = createContext(new GrabRegistry());

export function useGrabRegistry() {
  return useMemo(() => new GrabRegistry(), []);
}

export const GrabProvider = GrabContext.Provider;

export function useGrabbable(grabbable: Grabbable) {
  const registry = useContext(GrabContext);
  const latest = useRef(grabbable);
  latest.current = grabbable;

  useEffect(() => {
    const proxy: Grabbable = {
      pick: (ray) => latest.current.pick(ray),
      grab: (point) => latest.current.grab(point),
      drag: (point) => latest.current.drag(point),
      release: (velocity) => latest.current.release(velocity),
      hover: (hovering) => latest.current.hover?.(hovering),
      holdToGrab: latest.current.holdToGrab
    };
    registry.items.add(proxy);
    return () => {
      registry.items.delete(proxy);
    };
  }, [registry]);
}

type RigProps = {
  position: [number, number, number];
  target: [number, number, number];
  fov?: number;
  registry: GrabRegistry;
};

const FLY_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "ShiftLeft", "ShiftRight"]);

// One rig for every day: drag empty space to orbit, drag an object to carry it, WASD to fly,
// wheel for a smooth zoom (or to push a held object away). Pinch and two-finger pan on touch.
export function CameraRig({ position, target, fov = 36, registry }: RigProps) {
  const camera = useThree((state) => state.camera) as THREE.PerspectiveCamera;
  const dom = useThree((state) => state.gl.domElement) as HTMLCanvasElement;

  const controls = useMemo(() => {
    // Not given the canvas here: React's dev mode runs this memo twice, and a discarded controls
    // left listening would keep moving the camera. The effect below connects the one that is kept.
    const orbit = new OrbitControls(camera);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.07;
    orbit.rotateSpeed = 0.55;
    orbit.panSpeed = 0.7;
    orbit.minDistance = 0.4;
    orbit.maxDistance = 60;
    orbit.touches.ONE = THREE.TOUCH.ROTATE;
    orbit.touches.TWO = THREE.TOUCH.DOLLY_PAN;
    return orbit;
  }, [camera]);

  useEffect(() => {
    orbitPoint.current = controls.target;
    return () => {
      orbitPoint.current = null;
    };
  }, [controls]);

  useEffect(() => {
    camera.position.set(...position);
    camera.fov = fov;
    camera.updateProjectionMatrix();
    controls.target.set(...target);
    controls.update();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, position[0], position[1], position[2], target[0], target[1], target[2], fov]);

  const state = useRef({
    keys: new Set<string>(),
    velocity: new THREE.Vector3(),
    zoom: 0,
    pointer: new THREE.Vector2(),
    pointerFresh: false,
    held: null as Grabbable | null,
    heldPointer: -1,
    plane: new THREE.Plane(),
    offset: new THREE.Vector3(),
    lastPoint: new THREE.Vector3(),
    carry: new THREE.Vector3(),
    hovered: null as Grabbable | null,
    pushed: 0
  });

  useEffect(() => {
    const rig = state.current;
    const raycaster = new THREE.Raycaster();
    controls.connect(dom);

    const setRay = (event: { clientX: number; clientY: number }) => {
      const rect = dom.getBoundingClientRect();
      rig.pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(rig.pointer, camera);
      return raycaster.ray;
    };

    const nearest = (ray: THREE.Ray) => {
      let best: { item: Grabbable; distance: number; point: THREE.Vector3 } | null = null;
      for (const item of registry.items) {
        const hit = item.pick(ray);
        if (hit && (!best || hit.distance < best.distance)) best = { item, ...hit };
      }
      return best;
    };

    const hold = { timer: 0, pointer: -1, x: 0, y: 0 };
    const cancelHold = () => {
      window.clearTimeout(hold.timer);
      hold.pointer = -1;
    };

    const startGrab = (hit: { item: Grabbable; point: THREE.Vector3 }, pointerId: number) => {
      // Runs in the capture phase, so OrbitControls sees itself disabled and ignores this press.
      controls.enabled = false;
      rig.held = hit.item;
      rig.heldPointer = pointerId;
      rig.pushed = 0;
      rig.pointerFresh = true;
      camera.getWorldDirection(rig.carry);
      rig.plane.setFromNormalAndCoplanarPoint(rig.carry, hit.point);
      rig.lastPoint.copy(hit.point);
      rig.carry.set(0, 0, 0);
      hit.item.grab(hit.point);
      dom.setPointerCapture(pointerId);
      dom.style.cursor = "grabbing";
    };

    const onDown = (event: PointerEvent) => {
      if (rig.held || (event.pointerType === "mouse" && event.button !== 0)) return;
      const hit = nearest(setRay(event));
      if (!hit) return;
      if (hit.item.holdToGrab) {
        cancelHold();
        hold.pointer = event.pointerId;
        hold.x = event.clientX;
        hold.y = event.clientY;
        const { pointerId } = event;
        hold.timer = window.setTimeout(() => {
          hold.pointer = -1;
          // Asked again, because it may have moved away during the wait.
          const still = nearest(setRay(event));
          if (still) startGrab(still, pointerId);
        }, hit.item.holdToGrab);
        return;
      }
      startGrab(hit, event.pointerId);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId === hold.pointer && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 5) cancelHold();
      if (rig.held) {
        if (event.pointerId === rig.heldPointer) {
          setRay(event);
          rig.pointerFresh = true;
        }
        return;
      }
      // Hover is a mouse affordance. On touch a press goes straight to grab.
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      const hit = nearest(setRay(event));
      const item = hit?.item ?? null;
      if (item !== rig.hovered) {
        rig.hovered?.hover?.(false);
        item?.hover?.(true);
        rig.hovered = item;
      }
      dom.style.cursor = item ? "grab" : "";
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId === hold.pointer) cancelHold();
      if (!rig.held || event.pointerId !== rig.heldPointer) return;
      rig.held.release(rig.carry.clone());
      rig.held = null;
      rig.heldPointer = -1;
      controls.enabled = true;
      dom.style.cursor = "";
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const amount = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      if (rig.held) {
        rig.pushed += -amount * 0.002;
        rig.pointerFresh = true;
      } else {
        rig.zoom += amount;
      }
    };

    const onKey = (event: KeyboardEvent) => {
      if (!FLY_KEYS.has(event.code)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const element = event.target as HTMLElement | null;
      if (element?.tagName === "INPUT" && (element as HTMLInputElement).type !== "range") return;
      if (element?.tagName === "BUTTON" && event.code === "Space") return;
      if (event.type === "keydown") {
        rig.keys.add(event.code);
          if (event.code.startsWith("Arrow") || event.code === "Space") event.preventDefault();
      } else {
        rig.keys.delete(event.code);
      }
    };

    const onBlur = () => rig.keys.clear();

    dom.addEventListener("pointerdown", onDown, true);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointercancel", onUp);
    dom.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);

    return () => {
      cancelHold();
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
      controls.dispose();
      dom.style.cursor = "";
    };
  }, [camera, controls, dom, registry]);

  const scratch = useMemo(
    () => ({
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      wish: new THREE.Vector3(),
      raycaster: new THREE.Raycaster(),
      point: new THREE.Vector3(),
      plane: new THREE.Plane()
    }),
    []
  );

  useFrame((_, rawDelta) => {
    const rig = state.current;
    const delta = Math.min(rawDelta, 1 / 20);
    const { forward, right, wish } = scratch;

    camera.getWorldDirection(forward);
    right.crossVectors(forward, camera.up).normalize();

    // Speed scales with distance to the target, so close inspection stays controllable.
    const reach = camera.position.distanceTo(controls.target);
    const held = (...codes: string[]) => (codes.some((code) => rig.keys.has(code)) ? 1 : 0);
    const boost = held("ShiftLeft", "ShiftRight") ? 2.6 : 1;
    const speed = Math.max(0.6, reach) * 0.32 * boost;
    wish.set(0, 0, 0);
    wish.addScaledVector(forward, held("KeyW", "ArrowUp") - held("KeyS", "ArrowDown"));
    wish.addScaledVector(right, held("KeyD", "ArrowRight") - held("KeyA", "ArrowLeft"));
    wish.y += held("KeyE", "Space") - held("KeyQ");
    if (wish.lengthSq() > 1) wish.normalize();
    rig.velocity.lerp(wish.multiplyScalar(speed), 1 - Math.exp(-delta * 10));

    if (rig.velocity.lengthSq() > 1e-6) {
      const move = scratch.point.copy(rig.velocity).multiplyScalar(delta);
      camera.position.add(move);
      controls.target.add(move);
    }

    // Wheel: eased dolly, slowing as it nears the target rather than stopping dead.
    if (Math.abs(rig.zoom) > 0.01) {
      const step = rig.zoom * (1 - Math.exp(-delta * 12));
      rig.zoom -= step;
      const distance = Math.min(
        controls.maxDistance,
        Math.max(controls.minDistance, reach * Math.exp(step * 0.0012))
      );
      camera.position.copy(controls.target).addScaledVector(forward, -distance);
    }

    controls.update();

    if (rig.held) {
      // The plane faces the camera at grab time, so flying while holding carries the object along.
      const { raycaster, point, plane } = scratch;
      raycaster.setFromCamera(rig.pointer, camera);
      camera.getWorldDirection(forward);
      plane.setFromNormalAndCoplanarPoint(forward, rig.lastPoint);
      plane.constant -= rig.pushed;
      rig.pushed = 0;
      if (raycaster.ray.intersectPlane(plane, point)) {
        rig.carry.subVectors(point, rig.lastPoint).divideScalar(Math.max(delta, 1 / 240));
        rig.lastPoint.copy(point);
        rig.held.drag(point);
      }
    }
  });

  return null;
}
