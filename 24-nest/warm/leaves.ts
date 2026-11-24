/* eslint-disable @typescript-eslint/no-explicit-any -- TSL's node types do not model every operator. */
import * as THREE from "three/webgpu";
import { Fn, attribute, cameraPosition, color, dot, float, fract, max, mix, mx_noise_float, normalize, positionGeometry, positionWorld, pow, sin, smoothstep, uv, vec3 } from "three/tsl";
import { lehmer } from "../../shared/engine/random";
import type { Lighting } from "./light";

// Leaves that follow the dial. As it warms, buds swell along the twigs, unfurl and open into fresh green leaves, each at
// its own temperature and pace; as it cools again they yellow and brown, curl, let go and flutter down, tumbling, some
// catching on the nest's limb or in the nest a moment before slipping off and away below. Each leaf's growth, colour
// and curl are in a per-leaf attribute the shader shapes it from; only the falling ones are moved on the processor. One
// draw for them all.

// A leaf's life: waiting as a bare node, growing or grown on its twig, falling, or caught a moment on its way down.
const BARE = 0;
const ON = 1;
const FALLING = 2;
const CAUGHT = 3;

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// A leaf blade: a plane along +x from the stalk at the origin, its halves either side of the midrib, finely divided so
// it can be folded, unfurled and curled in the vertex stage.
function blade() {
  const g = new THREE.PlaneGeometry(1, 1, 8, 4);
  g.translate(0.5, 0, 0);
  return g;
}

export type LeafSite = { at: THREE.Vector3; pose: THREE.Quaternion; size: number };

// Leaves come in groups, each a set of twigs, how many leaves to spread over them, and their sizes.
export type LeafGroup = { twigs: THREE.CatmullRomCurve3[]; count: number; size: [number, number] };

export function buildLeaves(l: Lighting, groups: LeafGroup[], perch: THREE.CatmullRomCurve3, perchRadius: [number, number], seed: number, keepOut?: (p: THREE.Vector3) => boolean) {
  const random = lehmer(seed);
  // Sites along the outer two thirds of every twig, alternating sides, the blade held out and up from it; none whose
  // stalk or tip would lie in `keepOut` (the inside of the nest).
  const sites: LeafSite[] = [];
  for (const { twigs, count, size } of groups) {
  const start = sites.length;
  const per = Math.max(1, Math.round(count / Math.max(1, twigs.length)));
  for (const twig of twigs) {
    for (let k = 0; k < per && sites.length - start < count; k++) {
      const t = 0.3 + (k / per) * 0.68 + random() * 0.05;
      const at = twig.getPointAt(Math.min(1, t));
      const along = twig.getTangentAt(Math.min(1, t));
      // Out to one side, alternately, and a little up and forward along the twig.
      const side = new THREE.Vector3().crossVectors(along, v(0, 1, 0));
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize().multiplyScalar(k % 2 === 0 ? 1 : -1);
      const out = side.addScaledVector(along, 0.6 + random() * 0.4).add(v(0, 0.3 + random() * 0.5, 0)).normalize();
      // The blade faces up toward the light, turned a little about its stalk.
      const pose = new THREE.Quaternion().setFromUnitVectors(v(1, 0, 0), out);
      const up = v(0, 0, 1).applyQuaternion(pose);
      const twist = Math.atan2(up.x, up.y) * 0.4 + (random() - 0.5) * 0.9;
      pose.multiply(new THREE.Quaternion().setFromAxisAngle(v(1, 0, 0), twist - Math.PI / 2));
      const leafSize = size[0] + random() * random() * (size[1] - size[0]);
      if (keepOut && (keepOut(at) || keepOut(at.clone().addScaledVector(out, leafSize)))) continue;
      sites.push({ at, pose, size: leafSize });
    }
  }
  }
  const n = sites.length;

  // [grow, brown, curl, seed] per leaf: what the shader builds the blade from.
  const looks = new Float32Array(n * 4);
  const geometry = blade();
  const lookAttr = new THREE.InstancedBufferAttribute(looks, 4);
  lookAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("aLeaf", lookAttr);

  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.6 });
  m.alphaTest = 0.5;
  const a = attribute("aLeaf", "vec4") as any;
  const grow = a.x as any;
  const brown = a.y as any;
  const curl = a.z as any;
  const s = a.w as any;
  // The blade's shape, by its seed: broad or slim, pointed or round.
  // The first eighth is the stalk; the blade runs from there to the tip.
  const shape = () => {
    const x = uv().x.sub(0.12).div(0.88).max(0) as any;
    const y = uv().y.sub(0.5).mul(2) as any;
    const wide = s.mul(0.45).add(0.65) as any;
    const tip = fract(s.mul(7.3)).mul(0.5).add(0.6) as any;
    const half = pow(x.mul(Math.PI).sin().max(0), tip).mul(float(1).sub(x.mul(0.25))).mul(wide).mul(0.5) as any;
    return { x, y, half };
  };
  {
    // Folded shut along the midrib as a bud, opening as it grows; curling at the tip and edges as it dies.
    const p = positionGeometry as any;
    const x = p.x as any;
    const y = p.y as any;
    const open = smoothstep(0.25, 0.85, grow) as any;
    const fold = float(1).sub(open).mul(1.35).add(curl.mul(0.7)) as any;
    const across = y.abs() as any;
    const lifted = vec3(x, y.mul(fold.cos()), across.mul(fold.sin())) as any;
    // A soft arch along the blade, deeper as it curls; a little sway in the air.
    const sway = sin((l.clock as any).mul(1.3).add(s.mul(40))).mul(0.06).add(sin((l.clock as any).mul(2.1).add(s.mul(17))).mul(0.03)) as any;
    const bend = x.mul(x).mul(curl.mul(0.9).add(0.12).add(sway)) as any;
    const bent = lifted.add(vec3(0, 0, bend)) as any;
    // From a bud a fifth the size to the whole leaf; nothing before it starts.
    const size = mix(float(0.18), float(1), smoothstep(0.05, 0.9, grow)).mul(smoothstep(0, 0.04, grow)) as any;
    m.positionNode = bent.mul(size) as any;
  }
  {
    const { x, y, half } = shape();
    const teeth = fract(x.mul(26)).sub(0.5).abs().mul(0.03) as any;
    const stalk = smoothstep(0.13, 0.1, uv().x).mul(smoothstep(0.05, 0.03, y.abs())) as any;
    m.opacityNode = smoothstep(0.015, -0.015, y.abs().sub(half.sub(teeth).mul(2))).max(stalk) as any;
    const midrib = smoothstep(0.05, 0, y.abs()) as any;
    const veins = smoothstep(0.08, 0, fract(x.mul(8).sub(y.abs().mul(2.2))).sub(0.5).abs()).mul(smoothstep(0.06, 0.25, y.abs())) as any;
    // Fresh, slightly yellow spring green, each leaf its own; a bud is redder. Dying: yellow, then orange-brown, then
    // dull brown, from the edges in.
    const vary = fract(s.mul(91.7)) as any;
    const fresh = mix(color("#4e7e22"), color("#7aa232"), vary).mul(mx_noise_float(vec3(x.mul(6), y.mul(6), s.mul(10))).mul(0.12).add(0.95)) as any;
    const bud = mix(color("#7a6a2a"), fresh, smoothstep(0.2, 0.7, grow)) as any;
    const edge = y.abs().div(half.mul(2).max(0.01)) as any;
    const dying = brown.mul(1.3).add(edge.mul(0.3)).sub(0.15).clamp(0, 1) as any;
    const autumn = mix(mix(color("#c8a630"), color("#b8622a"), smoothstep(0.2, 0.6, dying)), color("#6a4a2c"), smoothstep(0.6, 1, dying)) as any;
    let c: any = mix(bud, autumn, smoothstep(0.02, 0.4, dying));
    c = mix(c, c.mul(1.25).add(0.02), midrib.max(veins.mul(0.4)));
    m.colorNode = c as any;
    // Sunlight through the blade from behind.
    // ...and above all the low light from behind, glowing through the blade, its veins showing dark against it.
    m.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld)) as any;
      const through = pow(max(dot(V, (l.toSun as any).negate()), 0), 2) as any;
      const behind = pow(max(dot(V, (l.toBack as any).negate()), 0), 1.5) as any;
      const lit = c.mul(l.sun as any).mul(through.mul(0.3).add(0.03)) as any;
      const glow = c.mul(vec3(1.1, 1.25, 0.7)).mul(l.back as any).mul(behind.mul(0.9).add(0.12)).mul(float(1).sub(midrib.max(veins).mul(0.55))) as any;
      return lit.add(glow);
    })() as any;
  }

  const mesh = new THREE.InstancedMesh(geometry, m, n);
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  const scaleVec = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  sites.forEach((site, i) => {
    mesh.setMatrixAt(i, matrix.compose(site.at, site.pose, scaleVec.setScalar(site.size)));
    looks[i * 4 + 3] = random();
  });
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // Each leaf's own temperature to bud at, pace, and its state while falling.
  const leaf = sites.map(() => ({
    state: BARE,
    at: random() * 0.2 + 0.42,
    pace: 0.35 + random() * 0.5,
    fade: 0.4 + random() * 0.7,
    delay: random() * 1.5,
    wait: 0,
    // How long after slipping off before anything can catch it again.
    free: 0,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    rotation: new THREE.Quaternion(),
    phase: random() * Math.PI * 2,
    sway: new THREE.Vector3(random() - 0.5, 0, random() - 0.5).normalize()
  }));
  // The nest's limb as points along it, for leaves to catch on.
  const rest = Array.from({ length: 60 }, (_, i) => {
    const t = i / 59;
    const r = perchRadius[0] + (perchRadius[1] - perchRadius[0]) * t;
    return { at: perch.getPointAt(t), r };
  });
  const scratch = { q: new THREE.Quaternion(), e: new THREE.Euler(), s: new THREE.Vector3() };

  let instancesChanged = false;
  const update = (dt: number, heat: number) => {
    let looksChanged = false;
    let moving = 0;
    for (let i = 0; i < n; i++) {
      const f = leaf[i];
      const o = i * 4;
      const warm = heat > f.at;
      const cold = heat < f.at - 0.12;
      if (f.state === BARE) {
        if (warm) {
          f.delay -= dt;
          if (f.delay <= 0) f.state = ON;
        } else f.delay = Math.random() * 1.5;
      }
      if (f.state === ON) {
        const g = looks[o];
        const b = looks[o + 1];
        if (cold) {
          // A bud not yet open shrinks back; an open leaf dies and falls.
          if (g < 0.35 && b === 0) {
            looks[o] = Math.max(0, g - dt * f.pace);
            if (looks[o] === 0) f.state = BARE;
          } else {
            looks[o + 1] = Math.min(1, b + dt * f.fade * 0.5);
            looks[o + 2] = Math.min(1, looks[o + 2] + dt * f.fade * 0.4);
            if (looks[o + 1] >= 1) {
              // Let go: from where it hangs, with a little push and a spin.
              f.state = FALLING;
              mesh.getMatrixAt(i, matrix);
              matrix.decompose(f.position, f.rotation, scratch.s);
              f.velocity.set((Math.random() - 0.5) * 6, -4, (Math.random() - 0.5) * 6);
              f.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
            }
          }
          looksChanged = true;
        } else if (warm && b === 0 && g < 1) {
          looks[o] = Math.min(1, g + dt * f.pace * 0.5);
          looksChanged = true;
        }
        // (Warmed again while browning, it stays as it is, half turned.)
      }
      if (f.state === FALLING || f.state === CAUGHT) {
        if (f.state === FALLING) {
          // Falling: drag holds it near its slow terminal speed; it flutters side to side and tumbles.
          f.phase += dt * 5;
          f.velocity.y += (-24 - f.velocity.y) * (1 - Math.exp(-dt * 2.5));
          const flutter = Math.sin(f.phase) * 22;
          f.velocity.x += (f.sway.x * flutter - f.velocity.x) * (1 - Math.exp(-dt * 3));
          f.velocity.z += (f.sway.z * flutter - f.velocity.z) * (1 - Math.exp(-dt * 3));
          f.position.addScaledVector(f.velocity, dt);
          scratch.q.setFromEuler(scratch.e.set(f.spin.x * dt, f.spin.y * dt + Math.cos(f.phase) * dt * 2, f.spin.z * dt));
          f.rotation.multiply(scratch.q);
          f.free -= dt;
          // Caught in the nest, or on top of its limb, for a moment; never again straight after slipping off.
          const across = Math.hypot(f.position.x, f.position.z);
          // Only on the rim: the cup is full of chicks, and a leaf among them stands up out of their down.
          if (f.free > 0) {
            // Slipping away, clear of everything.
          } else if (across < 8.2 && across > 6 && f.position.y < 0.9 && f.position.y > -0.5 && Math.random() < 0.6) {
            f.state = CAUGHT;
            f.position.y = 0.55;
            f.wait = 1.5 + Math.random() * 3;
          } else if (f.position.y < 3 && f.position.y > -26 && f.position.x < 24 && f.position.x > -86 && Math.abs(f.position.z) < 30) {
            // (Only near the limb is it worth testing each point along it.)
            for (const p of rest) {
              const dx = f.position.x - p.at.x;
              const dz = f.position.z - p.at.z;
              const dy = f.position.y - p.at.y;
              if (dx * dx + dz * dz < p.r * p.r * 0.6 && dy > 0 && dy < p.r + 0.3) {
                f.state = CAUGHT;
                f.position.y = p.at.y + p.r + 0.15;
                f.wait = 0.8 + Math.random() * 2.2;
                break;
              }
            }
          }
          if (f.state === CAUGHT) {
            // Lying flat-ish where it landed.
            f.rotation.setFromEuler(scratch.e.set(-Math.PI / 2 + (Math.random() - 0.5) * 0.15, Math.random() * Math.PI * 2, 0, "YXZ"));
          }
          // Gone, far below: a bare node again on its twig.
          if (f.position.y < -90) {
            f.state = BARE;
            looks.fill(0, o, o + 3);
            looksChanged = true;
            const site = sites[i];
            mesh.setMatrixAt(i, matrix.compose(site.at, site.pose, scaleVec.setScalar(site.size)));
          }
        } else {
          f.wait -= dt;
          if (f.wait <= 0) {
            // Slips off.
            f.state = FALLING;
            f.velocity.set((Math.random() - 0.5) * 10, -2, 6 + Math.random() * 4);
            f.free = 3;
          }
        }
        if (f.state !== BARE) {
          mesh.setMatrixAt(i, matrix.compose(f.position, f.rotation, scaleVec.setScalar(sites[i].size)));
          moving++;
        }
        instancesChanged = true;
      }
    }
    if (looksChanged) lookAttr.needsUpdate = true;
    // The matrices go up only while something is falling, and once more after the last has gone.
    if (instancesChanged) {
      mesh.instanceMatrix.needsUpdate = true;
      instancesChanged = moving > 0;
    }
  };

  return { mesh, geometry, material: m as THREE.Material, update, count: n };
}
