"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { Physics, useRapier } from "@react-three/rapier";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three/webgpu";
import {
  color as tslColor,
  float,
  pow,
  uniform,
  uv
} from "three/tsl";
import { orbitPoint, useGrabbable } from "../shared/engine/controls";
import { scenePhase, useQuality } from "../shared/engine/quality";
import { airTint, focusBlur, focusDistance } from "../shared/engine/Post";
import { pointHash } from "../shared/engine/random";
import { useSetting, useSettingRef, useSettingsStore } from "../shared/engine/settings";
import { sound, useBed, useMusic } from "../shared/engine/sound";
import { KeyLight, StudioEnvironment } from "../shared/engine/studio";
import type { DayDefinition } from "../shared/engine/types";
import { ZODIAC, signAngle } from "./bands";
import { buildParts, makeMaterials, SUN_HEIGHT, SUN_RADIUS, type Part } from "./parts";
import { shaftAngle, type ShaftId } from "./train";
import { SIGNS } from "./signs";
import { BODIES, PlanetCard, SKY_BODIES, addMachineCards, anchor, setHovered } from "./planetCard";
import { Readout, clock } from "./readout";
import { Space, type SkyLights } from "./sky";

type Mode = "mechanism" | "loose" | "form";

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD_X = new THREE.Vector3(1, 0, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const BLEND = 1.5;
// How long after letting go of the Sun the machine starts to come back together.
const RETURN_AFTER = 5;
const SPREAD = 0.55;
const FORM_CENTRE = new THREE.Vector3(0, 3.1, 0);
const FORM_SIZE = 4.4;
const FASTEST = 9;
const GROUP_SOLID = (1 << 16) | 0xffff;
const GROUP_GHOST = (4 << 16) | 2;

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const easeInOut = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

type Pose = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
const newPose = (): Pose => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), scale: new THREE.Vector3(1, 1, 1) });

// Where everything goes for a sign: the planets on the stars, a wheel behind each, bars along the lines between them, and
// the remaining small gears threaded along those lines as beads.
function arrangeSign(parts: Part[], signName: string, viewer: THREE.Vector3) {
  const sign = SIGNS.find((candidate) => candidate.name === signName) ?? SIGNS[0];
  const normal = viewer.clone().sub(FORM_CENTRE).normalize();
  const right = new THREE.Vector3().crossVectors(UP, normal).normalize();
  const above = new THREE.Vector3().crossVectors(normal, right);
  const place = ([x, y]: [number, number]) => FORM_CENTRE.clone().addScaledVector(right, x * FORM_SIZE).addScaledVector(above, y * FORM_SIZE);
  const stars = sign.stars.map(place);
  // Real stars can sit close together, so nothing placed on one may be bigger than the gap to its nearest neighbour allows.
  const room = stars.map((star) => stars.reduce((nearest, other) => (other === star ? nearest : Math.min(nearest, star.distanceTo(other))), Infinity));
  // Facing: a wheel's axle, its local y, along the normal.
  const facing = new THREE.Quaternion().setFromUnitVectors(UP, normal);
  const targets = new Map<Part, Pose & { faced: boolean }>();
  const set = (part: Part, position: THREE.Vector3, quaternion: THREE.Quaternion, scale: THREE.Vector3 | number, faced = false) => {
    const pose = { ...newPose(), faced };
    pose.position.copy(position);
    pose.quaternion.copy(quaternion);
    if (typeof scale === "number") pose.scale.setScalar(scale);
    else pose.scale.copy(scale);
    targets.set(part, pose);
  };

  const balls = parts.filter((part) => part.kind === "ball" && part.id !== "crankKnob").sort((a, b) => b.size - a.size);
  const wheels = parts.filter((part) => part.kind === "gear" || part.kind === "plate").sort((a, b) => b.size - a.size);
  const bars = parts.filter((part) => part.kind === "bar").sort((a, b) => (b.long?.length ?? 0) - (a.long?.length ?? 0));
  const knob = parts.find((part) => part.id === "crankKnob");

  // One planet per star, biggest first, with the Sun on the brightest. Any left over wait halfway along a line.
  const lineMiddle = (index: number) => {
    const [a, b] = sign.lines[index % sign.lines.length];
    return stars[a].clone().lerp(stars[b], 0.5);
  };
  balls.forEach((part, index) => {
    const at = index < stars.length ? stars[index] : lineMiddle(index - stars.length);
    const nearby = index < stars.length ? room[index] : 1;
    const scale = part.id === "sun" ? Math.min(0.9, (0.72 * nearby) / part.size) : Math.min(Math.max(0.24, 0.3 * nearby), 0.28) / part.size;
    set(part, at.clone().addScaledVector(normal, 0.26), facing, Math.min(scale, 3.2), part.id !== "sun");
  });

  // Behind each star, the biggest wheels in turn. Each is sized so that it is a star, not a whole gear train.
  let wheel = 0;
  stars.forEach((star, index) => {
    const part = wheels[wheel++];
    if (!part) return;
    const wanted = Math.min(index === 0 ? 0.74 : 0.34 + pointHash(index, 3) * 0.14, Math.max(0.16, 0.46 * room[index])) / part.size;
    set(part, star, facing, Math.min(1.1, wanted), true);
  });

  // Walk each line, laying bars end to end, then scatter the rest of the wheels along them.
  const lengths = sign.lines.map(([a, b]) => stars[a].distanceTo(stars[b]));
  // Every line gets a bar, and any left over strengthen the longest.
  const share = lengths.map(() => 1);
  for (let spare = bars.length - lengths.length; spare > 0; spare--) {
    let longest = 0;
    lengths.forEach((value, line) => {
      if (value / share[line] > lengths[longest] / share[longest]) longest = line;
    });
    share[longest] += 1;
  }
  let bar = 0;
  const quaternion = new THREE.Quaternion();
  const direction = new THREE.Vector3();
  const point = new THREE.Vector3();
  sign.lines.forEach(([a, b], line) => {
    direction.subVectors(stars[b], stars[a]);
    const each = direction.length() / share[line];
    direction.normalize();
    for (let i = 0; i < share[line] && bar < bars.length; i++) {
      const part = bars[bar++];
      const long = part.long as { axis: "x" | "y"; length: number };
      const girth = 0.62;
      if (long.axis === "y") {
        quaternion.setFromUnitVectors(UP, direction);
        point.copy(stars[a]).addScaledVector(direction, each * (i + 0.5));
        set(part, point, quaternion, new THREE.Vector3(girth, (each / long.length) * 1.01, girth));
      } else {
        quaternion.setFromUnitVectors(FORWARD_X, direction);
        point.copy(stars[a]).addScaledVector(direction, each * i);
        set(part, point, quaternion, new THREE.Vector3((each / long.length) * 1.01, girth, girth));
      }
    }
  });

  const beads = wheels.slice(wheel);
  beads.forEach((part, index) => {
    const line = index % sign.lines.length;
    const pass = Math.floor(index / sign.lines.length);
    const [a, b] = sign.lines[line];
    const t = 0.2 + ((pass * 0.618 + 0.13 * line) % 0.6);
    point.copy(stars[a]).lerp(stars[b], t).addScaledVector(normal, 0.06);
    set(part, point, facing, Math.min(1, 0.13 / part.size), true);
  });
  if (knob) {
    const [a, b] = sign.lines[sign.lines.length - 1];
    set(knob, point.copy(stars[a]).lerp(stars[b], 0.5).addScaledVector(normal, 0.1), facing, 1);
  }
  return targets;
}

function Clockwork({ tier, picked, hovered, lights }: { tier: string; picked: { value: number }; hovered: { value: number }; lights: SkyLights }) {
  const { gl, camera } = useThree() as any;
  const { world, rapier } = useRapier();
  const store = useSettingsStore();
  const speed = useSettingRef<number>("speed");
  const pull = useSettingRef<number>("pull");
  const formValue = useSetting<string>("form");

  const { group, parts, train, materials, sun, glow } = useMemo(() => {
    const materials = makeMaterials();
    const { parts, train } = buildParts(materials, tier === "low" ? 3 : 5);
    addMachineCards(train);
    const group = new THREE.Group();
    for (const part of parts) group.add(part.mesh);
    const sun = parts.find((part) => part.id === "sun") as Part;

    // The Sun's light is a real one on everything around it.
    const sunLight = new THREE.PointLight("#ffd5a8", 2.6, 0, 1.15);
    const glowMaterial = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const centred = (uv() as any).sub(0.5).mul(2).length() as any;
    glowMaterial.colorNode = tslColor("#ffb871").mul(pow(float(1).sub(centred).max(0), float(3)).mul(0.28));
    const glow = new THREE.Sprite(glowMaterial);
    glow.scale.setScalar(SUN_RADIUS * 5);
    sun.mesh.add(sunLight, glow);

    return { group, parts, train, materials, sun, glow };
  }, [tier]);

  useEffect(() => {
    airTint.value.set("#0a1226");
    focusBlur.value = 1.4;
    // These are shared with the other days, which do not move them.
    return () => {
      focusDistance.value = 12;
    };
  }, []);

  useEffect(
    () => () => {
      for (const part of parts) part.mesh.geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
      (glow.material as THREE.Material).dispose();
    },
    [parts, materials, glow]
  );

  const state = useMemo(() => {
    const raycaster = new THREE.Raycaster();
    return {
      mode: "mechanism" as Mode,
      drive: 0,
      velocity: speed.current,
      lastTooth: 0,
      clock: BLEND + SPREAD,
      from: parts.map(newPose),
      current: parts.map(newPose),
      delay: parts.map((_, index) => pointHash(index, 7) * SPREAD),
      form: new Map<Part, Pose & { faced: boolean }>(),
      bodies: new Map<Part, any>(),
      born: 0,
      lastWorld: null as unknown,
      sunBody: null as any,
      held: null as Part | null,
      heldTarget: new THREE.Vector3(),
      heldOffset: new THREE.Vector3(),
      heldAngle: 0,
      heldPlane: 0,
      heldSun: false,
      returnIn: 0,
      sunTarget: new THREE.Vector3(0, SUN_HEIGHT, 0),
      drift: 0,
      clinks: 0,
      raycaster,
      hits: [] as THREE.Intersection[],
      pressed: false,
      lastVelocity: new Map<Part, THREE.Vector3>(),
      framing: { left: 0, target: new THREE.Vector3(), distance: 0, saved: null as { target: THREE.Vector3; distance: number } | null }
    };
  }, [parts, speed]);

  // Place everything once, before the first frame is drawn.
  useMemo(() => {
    parts.forEach((part, index) => {
      part.pose(0, state.current[index].position, state.current[index].quaternion);
      part.mesh.position.copy(state.current[index].position);
      part.mesh.quaternion.copy(state.current[index].quaternion);
      part.mesh.updateMatrixWorld();
    });
  }, [parts, state]);

  const toSun = useMemo(() => new THREE.Vector3(), []);
  const removeBodies = () => {
    for (const body of state.bodies.values()) world.removeRigidBody(body);
    state.bodies.clear();
    state.lastVelocity.clear();
    if (state.sunBody) world.removeRigidBody(state.sunBody);
    state.sunBody = null;
  };

  // The tall modes need more of the view, so the camera backs off for them, and returns when they end.
  const frameFor = (mode: Mode) => {
    const orbit = orbitPoint.current;
    if (!orbit) return;
    const framing = state.framing;
    if (mode === "form") {
      if (!framing.saved) framing.saved = { target: orbit.clone(), distance: camera.position.distanceTo(orbit) };
      framing.target.set(0, 3.1, 0);
      // A narrow screen sets the distance by the width of the sign, wheels included.
      const wide = 5.6 / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      framing.distance = Math.max(framing.saved.distance, 22, wide);
      framing.left = 1.8;
    } else if (mode === "mechanism" && framing.saved) {
      framing.target.copy(framing.saved.target);
      framing.distance = framing.saved.distance;
      framing.saved = null;
      framing.left = 1.8;
    }
  };

  const go = (mode: Mode) => {
    if (state.mode === mode && mode !== "form") return;
    if (state.mode === "loose") removeBodies();
    state.mode = mode;
    state.returnIn = 0;
    if (mode !== "loose") lights.lit = false;
    frameFor(mode);
    parts.forEach((part, index) => {
      state.from[index].position.copy(state.current[index].position);
      state.from[index].quaternion.copy(state.current[index].quaternion);
      state.from[index].scale.copy(part.mesh.scale);
    });
    state.clock = 0;
    state.sunTarget.copy(sun.mesh.position);
    sound.play("whoosh", { gain: 0.12, pitch: mode === "loose" ? 0.6 : 0.85 });
    if (mode === "loose") sound.play("creak", { gain: 0.2, pitch: 0.7 });
  };

  const backToOrrery = () => {
    if (store.get("form") !== "orrery") store.set("form", "orrery");
  };

  // Esc lets go of a sign, or brings the pieces back early.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      backToOrrery();
      if (state.mode === "loose") go("mechanism");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const index = SIGNS.findIndex((sign) => sign.name === formValue);
    picked.value = index < 0 ? -100 : signAngle(index) + Math.PI / 12;
    if (index < 0) {
      if (state.mode === "form") go("mechanism");
      return;
    }
    state.form = arrangeSign(parts, formValue, camera.position);
    go("form");
    sound.play("rustle", { gain: 0.14, pitch: 1.4 });
  }, [formValue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Every part can be picked by its real triangles, so what is under the pointer is what it gets.
  const pickPart = (ray: THREE.Ray) => {
    state.raycaster.ray.copy(ray);
    state.hits.length = 0;
    for (const part of parts) part.mesh.raycast(state.raycaster, state.hits);
    let best: THREE.Intersection | null = null;
    for (const hit of state.hits) if (hit.object.visible && (!best || hit.distance < best.distance)) best = hit;
    if (!best) return null;
    const part = parts.find((candidate) => candidate.mesh === best!.object) as Part;
    return { part, distance: best.distance, point: best.point.clone() };
  };

  // Which body is under the pointer, for the card. Small ones get a little extra room, as long as nothing is in front of them.
  const bodyUnder = (ray: THREE.Ray) => {
    const hit = pickPart(ray);
    if (hit && SKY_BODIES.has(hit.part.id)) return hit.part.id;
    let best: string | null = null;
    let closest = Infinity;
    for (const part of bodies) {
      const along = scratchCentre.copy(part.mesh.position).sub(ray.origin).dot(ray.direction);
      const off = Math.sqrt(ray.distanceSqToPoint(part.mesh.position));
      if (along < 0 || off > part.size * part.mesh.scale.x + 0.1 || off >= closest) continue;
      if (hit && hit.distance < along - part.size) continue;
      best = part.id;
      closest = off;
    }
    return best;
  };

  // The card for whatever is in the hand, which stays up for as long as it is held.
  const cardFor = (part: Part) => {
    if (BODIES[part.id]) return part.id;
    if (part.id.startsWith("crank")) return "crank";
    const owner = part.id.match(/^(mercury|venus|earth|mars|jupiter|saturn|moon)(Arm|Rod|Tube)$/);
    return owner ? owner[1] : null;
  };

  const canGrab = (part: Part) => {
    // Showing a sign, only the Sun can be taken: it breaks the figure up, and the rest just hang there.
    if (state.mode === "form") return part === sun;
    if (state.mode === "loose") return true;
    return part === sun || Boolean(part.turn);
  };

  const planAngle = (point: THREE.Vector3, part: Part, height: number) => {
    // Where the pointer's ray crosses the part's own level, seen from above, gives an angle that does not depend on the view.
    const rise = point.y - camera.position.y;
    const t = Math.abs(rise) > 0.02 ? (height - camera.position.y) / rise : 1;
    const clamped = t > 0 && t < 6 ? t : 1;
    const x = camera.position.x + (point.x - camera.position.x) * clamped;
    const z = camera.position.z + (point.z - camera.position.z) * clamped;
    const turn = part.turn!;
    return Math.atan2(-z - turn.y, x - turn.x);
  };

  useGrabbable({
    pick(ray) {
      const hit = pickPart(ray);
      if (!hit || !canGrab(hit.part)) return null;
      return { distance: hit.distance, point: hit.point };
    },
    grab(point) {
      const ray = new THREE.Ray(camera.position.clone(), point.clone().sub(camera.position).normalize());
      const hit = pickPart(ray);
      if (!hit) return;
      state.pressed = true;
      state.returnIn = 0;
      state.held = hit.part;
      state.heldTarget.copy(point);
      if (hit.part === sun) {
        state.heldSun = true;
        lights.lit = true;
        camera.getWorldDirection(lights.view);
        if (state.mode !== "loose") {
          backToOrrery();
          go("loose");
        }
        state.heldOffset.copy(sun.mesh.position).sub(point);
        state.sunTarget.copy(sun.mesh.position);
      } else if (state.mode === "loose") {
        state.heldOffset.copy(hit.part.mesh.position).sub(point);
        state.bodies.get(hit.part)?.wakeUp();
      } else {
        state.heldPlane = hit.part.mesh.position.y;
        state.heldAngle = planAngle(point, hit.part, state.heldPlane);
      }
      sound.play("click", { gain: 0.3, pitch: 0.9 });
    },
    drag(point) {
      state.heldTarget.copy(point);
    },
    release() {
      // Anything let go of while the Sun's sky is lit starts the wait again, so it never comes back out of someone's hand.
      if (state.held && state.mode === "loose" && lights.lit) state.returnIn = RETURN_AFTER;
      state.held = null;
      state.heldSun = false;
    }
  });

  const bodies = useMemo(() => parts.filter((part) => SKY_BODIES.has(part.id)), [parts]);
  const scratchCentre = useMemo(() => new THREE.Vector3(), []);
  const hoverRay = useMemo(() => ({ ray: new THREE.Ray(), ndc: new THREE.Vector2(), inside: false, last: null as string | null }), []);

  // Pressing the zodiac band without dragging picks that sign. Pressing anything in front of it does not.
  useEffect(() => {
    const canvas = gl.domElement as HTMLCanvasElement;
    const pointer = new THREE.Vector2();
    const ray = new THREE.Ray();
    const signUnder = (event: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
      ray.origin.setFromMatrixPosition(camera.matrixWorld);
      ray.direction.set(pointer.x, pointer.y, 0.5).unproject(camera).sub(ray.origin).normalize();
      // The bands are on the sky, so only the direction of the ray matters.
      const elevation = (Math.asin(ray.direction.y) * 180) / Math.PI;
      if (Math.abs(elevation - ZODIAC.elevation) > ZODIAC.span / 2) return -1;
      if (pickPart(ray)) return -1;
      const angle = Math.atan2(-ray.direction.z, ray.direction.x);
      return Math.floor((((angle - Math.PI + Math.PI * 4) % (Math.PI * 2)) / (Math.PI * 2)) * 12) % 12;
    };
    let down: { x: number; y: number; at: number } | null = null;
    let wasOverSign = false;
    const onDown = (event: PointerEvent) => {
      hoverRay.inside = false;
      down = { x: event.clientX, y: event.clientY, at: performance.now() };
      state.pressed = false;
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerType === "mouse") hoverRay.inside = true;
      const press = down;
      down = null;
      if (!press || state.pressed) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8 || performance.now() - press.at > 600) return;
      const sign = signUnder(event);
      if (sign < 0) return;
      const name = SIGNS[sign].name;
      sound.play("click", { gain: 0.45, pitch: 1.2 });
      // Pressing the sign that is showing lets it go again.
      store.set("form", store.get("form") === name ? "orrery" : name);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "mouse") {
        const box = canvas.getBoundingClientRect();
        hoverRay.ndc.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
        hoverRay.inside = !event.buttons;
      }
      if (event.buttons) return;
      const sign = signUnder(event);
      hovered.value = sign < 0 ? -100 : signAngle(sign) + Math.PI / 12;
      if (sign >= 0) canvas.style.cursor = "pointer";
      else if (wasOverSign) canvas.style.cursor = "";
      wasOverSign = sign >= 0;
    };
    const onLeave = () => {
      hoverRay.inside = false;
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }, [gl, camera, hovered, store]); // eslint-disable-line react-hooks/exhaustive-deps

  const createBodies = () => {
    state.lastWorld = world.bodies;
    state.born = performance.now();
    parts.forEach((part, index) => {
      if (part === sun) return;
      const mesh = part.mesh;
      const description = rapier.RigidBodyDesc.dynamic()
        .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
        .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w })
        .setLinearDamping(part.orbit ? 0.22 : 1.5)
        .setAngularDamping(0.42)
        .setCcdEnabled(part.kind === "bar");
      const body = world.createRigidBody(description);
      const shape = part.collider;
      const collider =
        shape.type === "ball"
          ? rapier.ColliderDesc.ball(shape.radius)
          : shape.type === "cylinder"
            ? rapier.ColliderDesc.cylinder(shape.half, shape.radius).setTranslation(...(shape.at ?? [0, 0, 0]))
            : rapier.ColliderDesc.cuboid(...shape.size).setTranslation(...shape.at);
      collider.setDensity(part.kind === "gear" ? 2.4 : 1.2).setFriction(0.45).setRestitution(0.28).setCollisionGroups(GROUP_GHOST);
      world.createCollider(collider, body);
      // It leaves at the speed it was going, turning as it was.
      const spin = (part.spin(state.drive + 0.01) - part.spin(state.drive)) / 0.01;
      body.setAngvel({ x: 0, y: THREE.MathUtils.clamp(spin * state.velocity, -6, 6), z: 0 }, true);
      state.bodies.set(part, body);
      state.lastVelocity.set(part, new THREE.Vector3());
    });
    const sunBody = world.createRigidBody(rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(sun.mesh.position.x, sun.mesh.position.y, sun.mesh.position.z));
    world.createCollider(rapier.ColliderDesc.ball(SUN_RADIUS).setRestitution(0.3), sunBody);
    state.sunBody = sunBody;
  };

  const push = useMemo(() => new THREE.Vector3(), []);
  const tangent = useMemo(() => new THREE.Vector3(), []);
  const pose = useMemo(newPose, []);
  const scratchQuaternion = useMemo(() => new THREE.Quaternion(), []);
  const spinQuaternion = useMemo(() => new THREE.Quaternion(), []);

  // A tall screen needs to be further back to get the arms in.
  const earthSpeed = train.shafts.get("earth")!.speed;
  const fitted = useRef(false);
  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 20);
    if (state.returnIn > 0) {
      state.returnIn -= rawDelta;
      if (state.returnIn <= 0) {
        backToOrrery();
        go("mechanism");
      }
    }
    const mode = state.mode;
    // Asked every frame, because the planets move under a mouse that stays still.
    clock.longitude = (id) => shaftAngle(train, id as ShaftId, state.drive);
    let under: string | null = null;
    let shown: Part | undefined;
    if (state.held) {
      under = cardFor(state.held);
      shown = under === "crank" ? parts.find((part) => part.id === "crankKnob") : parts.find((part) => part.id === under);
    } else if (hoverRay.inside) {
      hoverRay.ray.origin.setFromMatrixPosition(camera.matrixWorld);
      hoverRay.ray.direction.set(hoverRay.ndc.x, hoverRay.ndc.y, 0.5).unproject(camera).sub(hoverRay.ray.origin).normalize();
      under = bodyUnder(hoverRay.ray);
    }
    if (under) {
      const body = shown ?? (bodies.find((part) => part.id === under) as Part);
      const box = (gl.domElement as HTMLCanvasElement).getBoundingClientRect();
      scratchCentre.copy(body.mesh.position);
      const depth = camera.position.distanceTo(scratchCentre);
      scratchCentre.project(camera);
      anchor.x = box.left + ((scratchCentre.x + 1) / 2) * box.width;
      anchor.y = box.top + ((1 - scratchCentre.y) / 2) * box.height;
      // Saturn reaches out as far as its rings.
      const radius = body.size * body.mesh.scale.x * (under === "saturn" ? 2.15 : 1);
      anchor.reach = (radius / (2 * depth * Math.tan((camera.fov * Math.PI) / 360))) * box.height;
    }
    if (under !== hoverRay.last) {
      hoverRay.last = under;
      setHovered(under);
      if (under) sound.play("click", { gain: 0.05, pitch: 1.7 });
    }
    if (!fitted.current && orbitPoint.current) {
      fitted.current = true;
      const fit = 4.9 / (Math.tan((camera.fov * Math.PI) / 360) * camera.aspect);
      const away = camera.position.distanceTo(orbitPoint.current);
      if (fit > away) camera.position.sub(orbitPoint.current).multiplyScalar(fit / away).add(orbitPoint.current);
    }
    state.clock += delta;
    const orbit = orbitPoint.current;
    // Sharpest at what the camera turns around, with the air closing in behind it.
    focusDistance.value = orbit ? camera.position.distanceTo(orbit) : 14;
    if (state.framing.left > 0 && orbit) {
      state.framing.left -= delta;
      const k = 1 - Math.exp(-delta * 3.2);
      toSun.subVectors(camera.position, orbit);
      const distance = toSun.length();
      orbit.lerp(state.framing.target, k);
      camera.position.copy(orbit).addScaledVector(toSun.normalize(), distance + (state.framing.distance - distance) * k);
    }

    // The train: the crank is either held or running to the speed that is asked for.
    // It waits to be seen, so that the date on show when the page opens is today's.
    if (mode !== "loose" && scenePhase.current === "live") {
      const held = state.held;
      if (held && held.turn) {
        const angle = planAngle(state.heldTarget, held, state.heldPlane);
        const change = wrap(angle - state.heldAngle);
        state.heldAngle = angle;
        const wanted = change / held.turn.speed;
        const moved = THREE.MathUtils.clamp(wanted, -0.5, 0.5);
        state.drive += moved;
        state.velocity += (moved / Math.max(delta, 1 / 240) - state.velocity) * 0.3;
        state.velocity = THREE.MathUtils.clamp(state.velocity, -2.2, 2.2);
      } else {
        state.velocity += (speed.current - state.velocity) * Math.min(1, delta * 1.4);
        state.drive += state.velocity * delta;
      }
      clock.years = (state.drive * earthSpeed) / (Math.PI * 2);
      // One tick for each tooth of the wheel the Earth is on.
      const tooth = Math.floor((state.drive * 3 * 48) / (Math.PI * 2));
      if (tooth !== state.lastTooth) {
        const rate = Math.abs(state.velocity);
        state.lastTooth = tooth;
        if (rate > 0.005) sound.play("tick", { gain: Math.min(0.12, 0.03 + rate * 0.1), pitch: 0.9 + (tooth % 4) * 0.05 });
      }
    }

    if (mode === "loose") {
      if (state.bodies.size === 0 || state.lastWorld !== world.bodies) {
        state.bodies.clear();
        createBodies();
      }
      const strength = pull.current;
      const sunPosition = sun.mesh.position;

      // The Sun goes where it is carried, and hangs there breathing a little when it is let go.
      if (state.heldSun) {
        state.sunTarget.copy(state.heldTarget).add(state.heldOffset);
                state.sunTarget.clampLength(0, 15);
      }
      state.drift += delta;
      const breathe = state.heldSun ? 0 : Math.sin(state.drift * 0.5) * 0.12;
      state.sunBody?.setNextKinematicTranslation({ x: state.sunTarget.x, y: state.sunTarget.y + breathe, z: state.sunTarget.z });
      const placed = state.sunBody?.translation();
      if (placed) sun.mesh.position.set(placed.x, placed.y, placed.z);
      sun.mesh.scale.lerp(ONE, Math.min(1, delta * 4));

      const age = (performance.now() - state.born) / 1000;
      const earth = parts.find((part) => part.id === "earth");
      const earthBody = earth && state.bodies.get(earth);
      parts.forEach((part, index) => {
        const body = state.bodies.get(part);
        if (!body) return;
        const position = body.translation();
        const rotation = body.rotation();
        part.mesh.position.set(position.x, position.y, position.z);
        part.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        // A form's scaling comes back gently: colliders are always full size.
        part.mesh.scale.lerp(ONE, Math.min(1, delta * 4));
        state.current[index].position.copy(part.mesh.position);
        state.current[index].quaternion.copy(part.mesh.quaternion);

        // Each stays a ghost until it has come clear of whatever it was threaded on.
        const clear = part.mesh.position.distanceTo(state.from[index].position) > 0.45 || age > 2.6;
        if (clear && body.userData !== "solid") {
          body.userData = "solid";
          body.collider(0).setCollisionGroups(GROUP_SOLID);
        }

        const velocity = body.linvel();
        if (state.held === part) {
          toSun.copy(state.heldTarget).add(state.heldOffset).sub(part.mesh.position).multiplyScalar(13).clampLength(0, 24);
          body.setLinvel({ x: velocity.x + (toSun.x - velocity.x) * 0.5, y: velocity.y + (toSun.y - velocity.y) * 0.5, z: velocity.z + (toSun.z - velocity.z) * 0.5 }, true);
          return;
        }
        // Anything hitting anything shows up as a sudden change in speed.
        const last = state.lastVelocity.get(part) as THREE.Vector3;
        const jolt = Math.hypot(velocity.x - last.x, velocity.y - last.y, velocity.z - last.z);
        last.set(velocity.x, velocity.y, velocity.z);
        state.clinks = Math.max(0, state.clinks - delta * 14);
        if (jolt > 1.5 && state.clinks < 1 && age > 0.3) {
          state.clinks += 1;
          const rel = THREE.MathUtils.clamp((part.mesh.position.x - camera.position.x) / 12, -1, 1);
          sound.play("click", { gain: Math.min(0.5, jolt * 0.09), pitch: 1.4 / (0.5 + part.size), pan: rel });
          if (part.size > 0.4) sound.play("thud", { gain: Math.min(0.3, jolt * 0.05), size: Math.min(1, part.size), pan: rel });
        }

        // The Moon stays with the Earth while it can. Everything else answers to the Sun.
        const isMoon = part.id === "moon" && earthBody;
        if (isMoon) {
          const e = earthBody.translation();
          toSun.set(e.x - position.x, e.y - position.y, e.z - position.z);
        } else {
          toSun.copy(sunPosition).sub(part.mesh.position);
        }
        const distance = toSun.length();
        toSun.divideScalar(Math.max(distance, 0.001));
        const orbit = isMoon ? 0.62 : part.orbit;
        push.set(0, 0, 0);
        if (orbit) {
          // A planet is pulled to its own distance, and carried round it.
          push.addScaledVector(toSun, (distance - orbit) * 2.6 * strength);
          tangent.crossVectors(UP, toSun);
          const wanted = (isMoon ? 1.4 : 2.1 / Math.sqrt(orbit)) * Math.sqrt(Math.max(0, strength));
          const along = velocity.x * tangent.x + velocity.y * tangent.y + velocity.z * tangent.z;
          push.addScaledVector(tangent, (along - wanted) * -1.4);
          push.y += (toSun.y * distance) * 1.2 * strength;
        } else {
          // The rest fall in slowly, each to its own distance, so they crowd and collide but leave the Sun showing.
          const shell = SUN_RADIUS + 0.7 + part.size * 0.4 + pointHash(index, 19) * 2.4;
          push.addScaledVector(toSun, strength * THREE.MathUtils.clamp((distance - shell) * 1.5, -4, 3.6));
          // A slight swirl keeps the cloud from locking solid.
          tangent.crossVectors(UP, toSun);
          push.addScaledVector(tangent, strength * (distance < shell + 1 ? 0.9 : 0.3));
        }
        const speedNow = Math.hypot(velocity.x, velocity.y, velocity.z);
        const scale = speedNow > FASTEST ? FASTEST / speedNow : 1;
        body.setLinvel({ x: (velocity.x + push.x * delta) * scale, y: (velocity.y + push.y * delta) * scale, z: (velocity.z + push.z * delta) * scale }, true);
      });
      state.current[parts.indexOf(sun)].position.copy(sun.mesh.position);
    } else {
      parts.forEach((part, index) => {
        part.pose(state.drive, pose.position, pose.quaternion);
        pose.scale.set(1, 1, 1);
        if (mode === "form") {
          const target = state.form.get(part);
          if (target) {
            pose.position.copy(target.position);
            pose.scale.copy(target.scale);
            if (target.faced) {
              spinQuaternion.setFromAxisAngle(UP, part.spin(state.drive));
              pose.quaternion.copy(target.quaternion).multiply(spinQuaternion);
            } else pose.quaternion.copy(target.quaternion);
          }
        }
        const t = easeInOut(THREE.MathUtils.clamp((state.clock - state.delay[index]) / BLEND, 0, 1));
        const current = state.current[index];
        const from = state.from[index];
        if (t >= 1) {
          current.position.copy(pose.position);
          current.quaternion.copy(pose.quaternion);
          part.mesh.scale.copy(pose.scale);
        } else {
          current.position.lerpVectors(from.position, pose.position, t);
          // The way there curves up and round a little instead of cutting straight through the machine.
          const arc = Math.sin(Math.PI * t) * Math.min(1.2, from.position.distanceTo(pose.position) * 0.12);
          current.position.y += arc;
          scratchQuaternion.copy(from.quaternion).slerp(pose.quaternion, t);
          current.quaternion.copy(scratchQuaternion);
          part.mesh.scale.lerpVectors(from.scale, pose.scale, t);
        }
        part.mesh.position.copy(current.position);
        part.mesh.quaternion.copy(current.quaternion);
      });
    }
    
  });

  return (
    <>
      <primitive object={group} />
    </>
  );
}

function Scene() {
  const { tier } = useQuality();
  // What is built is fixed by the tier the scene opened on, so that a drop in quality never has to rebuild the machine.
  const [firstTier] = useState(tier);
  const picked = useMemo(() => uniform(-100), []);
  const hovered = useMemo(() => uniform(-100), []);
  const lights = useMemo<SkyLights>(() => ({ lit: false, view: new THREE.Vector3(0, 0, -1) }), []);
  useMusic("/codevember/music/icy-shimmering.mp3", 0.34);
  useBed("hum", 0.06);
  return (
    <>
      <Space lights={lights} picked={picked} hovered={hovered} textureWidth={firstTier === "low" ? 4096 : 8192} detail={firstTier === "low" ? 3 : 5} />
      <StudioEnvironment
        ambient="#060810"
        intensity={1.25}
        boxes={[
          { position: [0, 16, 0], scale: [20, 0.2, 20], color: "#dfe6f5", intensity: 1.15 },
          { position: [-3, 4, -20], scale: [26, 7, 0.2], color: "#ffe2bd", intensity: 1.5 },
          { position: [-18, 0, 12], scale: [0.2, 7, 18], color: "#cfdcff", intensity: 1.2 },
          { position: [-13, 7, 6], scale: [0.2, 10, 15], color: "#fff4e4", intensity: 5 },
          { position: [13, 4, -5], scale: [0.2, 6, 14], color: "#ffd6a6", intensity: 2.2 },
          { position: [3, 3, 15], scale: [12, 3, 0.2], color: "#b7caff", intensity: 2 },
          { position: [0, -11, 0], scale: [18, 0.2, 18], color: "#6d5a48", intensity: 1.3 }
        ]}
      />
      <KeyLight position={[-11, 15, 8]} target={[0, 2.4, 0]} color="#fff3e2" intensity={520} angle={0.46} penumbra={0.7} shadowFar={40} />
      <Physics gravity={[0, 0, 0]}>
        <Clockwork tier={firstTier} picked={picked} hovered={hovered} lights={lights} />
      </Physics>
    </>
  );
}

const orrery: DayDefinition = {
  camera: { position: [13.4, 5.67, 2.5], target: [0, 2.5, 0], fov: 38 },
  extents: { centre: [0, 2.5, 0], radius: 36, color: "#e8c98f" },
  passes: { bounce: false, haze: false, overlay: false, depthOfField: { range: 12, air: 0.62, airRate: 0.13, airBehindFocus: 2.5, sharpSky: true }, chromatic: 0.11 },
  look: { background: "#02030a", exposure: 1, bloom: 0.12, bloomThreshold: 1.7, ao: 0.9, aoRadius: 0.22, aoReach: 8, vignette: 0.34, grain: 0.012 },
  settings: {
    speed: { type: "range", label: "Crank speed", min: -0.6, max: 0.6, step: 0.005, value: 0.1 },
    pull: { type: "range", label: "Sun's pull", min: 0, max: 2, step: 0.01, value: 1 },
    meteors: { type: "range", label: "Shooting stars", min: 0, max: 4, step: 0.01, value: 1 },
    form: {
      type: "choice",
      label: "Form",
      value: "orrery",
      pressAgain: "orrery",
      options: [{ value: "orrery", label: "Orrery" }, ...SIGNS.map((sign) => ({ value: sign.name, label: sign.label }))]
    }
  },
  notes: "A working clockwork solar system in brass, set to today's date. Turn the crank to run the years, or pull the Sun and the machine comes apart.",
  Overlay: () => (
    <>
      <Readout />
      <PlanetCard />
    </>
  ),
  hint: "Turn the crank, or any wheel or planet, and the whole train answers. Pull the Sun to tear it apart and light the constellations. Let go and it comes back together. Tap a sign on the zodiac below.",
  overview: [
    {
      title: "Simulation",
      points: [
        "A 26-gear train in 13 meshed pairs sets every planet's speed from its real tooth counts.",
        "Planets open at today's positions, from J2000 mean longitudes, and a sun gear drives the Moon's train on Earth's arm."
      ]
    },
    {
      title: "Physics",
      points: [
        "Pulling the Sun turns every part into a Rapier rigid body with zero gravity, keeping the spin it had.",
        "Parts start as ghost collision groups and turn solid once clear, so threaded gears never explode apart."
      ]
    },
    {
      title: "Shaders",
      points: [
        "Gears use true involute tooth profiles, extruded with spoke windows and merged with lathe-turned collars.",
        "Planets are procedural: Worley craters for Mercury, Mars and the Moon, fractal-noise land on clearcoated Earth."
      ]
    },
    {
      title: "Rendering",
      points: [
        "The Milky Way and six galaxies are painted once into a half-float cube map, 1536 or 768 per face.",
        "Up to five procedural star grid layers plus two flickering layers are hashed per pixel on the dome."
      ]
    }
  ],
  Scene
};

export default orrery;
