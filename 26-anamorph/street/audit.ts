import * as THREE from "three/webgpu";

// Development only (?audit): runs the day through each of its phases by itself — the chalk drawn on, chalk at rest,
// the sweep through the spot into 3D, 3D, a switch to another painting — timing every frame, then times the scene at
// rest with its parts taken out one at a time. The results go to the console, to the page, and to a collector on
// localhost:3999 if one is listening.
type Hook = {
  state: { phase: string; real: boolean; sweep: unknown; pictureFrames: number; warm: number };
  sweep: (toReal: boolean) => void;
  settings: { get: (key: string) => unknown; set: (key: string, value: string) => void };
  light: { sun: THREE.DirectionalLight };
  street: { group: THREE.Group };
  ground: { mesh: THREE.Mesh };
  hold: (on: boolean) => void;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test: () => boolean, ms: number) => {
  const end = performance.now() + ms;
  while (!test() && performance.now() < end) await wait(100);
  return test();
};

export async function audit(hook: () => Hook) {
  const out: string[] = [];
  const say = (line: string) => {
    out.push(line);
    console.log("[audit]", line);
    show.textContent = out.join("\n");
  };
  const show = document.createElement("pre");
  Object.assign(show.style, { position: "fixed", left: "8px", top: "8px", zIndex: "99999", font: "11px/1.35 monospace", color: "#0f0", background: "rgba(0,0,0,0.8)", padding: "8px", maxHeight: "90vh", overflow: "auto", pointerEvents: "none" });
  document.body.appendChild(show);
  say(`audit: ${innerWidth}x${innerHeight} @${devicePixelRatio} ${navigator.userAgent.match(/Chrome\/[\d.]+|Safari\/[\d.]+|Firefox\/[\d.]+/)?.[0] ?? ""}`);

  // Every frame: its time, the phase it was in, and the main-thread long tasks (over 50 ms of script).
  let mark = "start";
  const frames: { t: number; dt: number; mark: string }[] = [];
  const long: { t: number; d: number; mark: string }[] = [];
  try {
    new PerformanceObserver((list) => list.getEntries().forEach((e) => long.push({ t: Math.round(e.startTime), d: Math.round(e.duration), mark }))).observe({ type: "longtask" });
  } catch {
    // No long tasks here.
  }
  let last = performance.now();
  let on = true;
  const tick = (t: number) => {
    frames.push({ t: Math.round(t), dt: t - last, mark });
    last = t;
    if (on) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  await until(() => !/Compiling|Loading|Ready/.test(document.body.innerText.replace(show.textContent ?? "", "")), 300000);
  const a = hook();
  const step = async (name: string, ms: number, start?: () => void, done?: () => boolean) => {
    mark = name;
    say(`… ${name}`);
    start?.();
    if (done) await until(done, ms);
    else await wait(ms);
  };
  await step("chalk drawn on", 30000, undefined, () => a.state.phase === "drawn");
  await step("chalk at rest", 20000);
  await step("sweep to 3D", 30000, () => a.sweep(true), () => !a.state.sweep);
  await step("3D", 8000);
  const other = a.settings.get("painting") === "lava" ? "pit" : "lava";
  await step("switch: back to chalk", 30000, () => a.settings.set("painting", other), () => !a.state.sweep && !a.state.real);
  await step("switch: erase", 30000, undefined, () => a.state.phase === "painting");
  await step("switch: draw on", 30000, undefined, () => a.state.phase === "drawn");
  await step("new chalk at rest", 6000);
  on = false;

  say("");
  say("phase                   frames  fps   p50ms  p95ms  maxms  >100ms  long tasks (ms)");
  const names = [...new Set(frames.map((f) => f.mark))];
  names.forEach((name) => {
    const list = frames.filter((f) => f.mark === name).map((f) => f.dt);
    if (!list.length) return;
    const sorted = [...list].sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(0);
    const fps = (1000 / (list.reduce((x, y) => x + y, 0) / list.length)).toFixed(1);
    const tasks = long.filter((l) => l.mark === name);
    say(`${name.padEnd(24)}${String(list.length).padStart(6)} ${fps.padStart(5)} ${q(0.5).padStart(6)} ${q(0.95).padStart(6)} ${sorted.at(-1)!.toFixed(0).padStart(6)} ${String(list.filter((d) => d > 100).length).padStart(7)}  ${tasks.length} (${tasks.reduce((x, l) => x + l.d, 0)})`);
  });
  say("");
  say("slowest frames (time since start, ms, phase):");
  [...frames].sort((x, y) => y.dt - x.dt).slice(0, 15).forEach((f) => say(`  ${f.t}  ${f.dt.toFixed(0)}  ${f.mark}`));
  say("longest tasks:");
  [...long].sort((x, y) => y.d - x.d).slice(0, 15).forEach((l) => say(`  ${l.t}  ${l.d}  ${l.mark}`));

  // At rest, part by part: each line has the parts above it taken out too.
  const rate = () =>
    new Promise<number>((resolve) => {
      let n = 0;
      const start = performance.now();
      const f = () => {
        n++;
        if (performance.now() - start < 3000) requestAnimationFrame(f);
        else resolve(n / ((performance.now() - start) / 1000));
      };
      requestAnimationFrame(f);
    });
  const part = async (name: string, change?: () => void) => {
    change?.();
    await wait(1500);
    say(`${name.padEnd(30)} ${(await rate()).toFixed(1)} fps`);
  };
  say("");
  say("at rest, taking parts out:");
  await part("chalk, everything");
  await step("", 30000, () => a.sweep(true), () => !a.state.sweep);
  await part("3D, everything");
  const crowns: THREE.Object3D[] = [];
  a.street.group.traverse((o) => (o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count > 2000 && crowns.push(o));
  await part("- tree crowns", () => crowns.forEach((o) => (o.visible = false)));
  await part("- whole street", () => (a.street.group.visible = false));
  await part("- sidewalk", () => (a.ground.mesh.visible = false));
  say("done. Reload to put everything back.");
  fetch("http://localhost:3999/audit", { method: "POST", body: out.join("\n") }).catch(() => undefined);
}
