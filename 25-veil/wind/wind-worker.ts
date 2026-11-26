// The breeze fetched, unpacked and bound to the statue's meshes off the page (field.ts): rebuilding some six million moved
// points and finding each of nearly a million statue points its nearest points of the field would hold the page for
// seconds. Handed back moved, not copied.
import { bind, inflate, parse } from "./field";

// A phone's own lighter export: the field a point every 1.5 cm rather than 1 cm, 5 keys a second (1.7 MB, not 8.2).
// Named, never probed for: a missing file can come back as a page, not a 404.
const PHONE: string | null = "/assets/25-veil/wind-phone.bin.gz";

// `light` (a phone): its own file if there is one, else the full one; either way at most 5 keys a second.
// `buffer`: the file, already fetched on the page (with the figure's); else fetched here.
self.onmessage = async (event: MessageEvent<{ meshes: { position: Float32Array; normal: Float32Array }[]; light?: boolean; buffer?: ArrayBuffer; file?: string }>) => {
  try {
    const light = !!event.data.light;
    const file = event.data.file ?? (light && PHONE ? PHONE : "/assets/25-veil/wind-hd.bin.gz");
    let raw = event.data.buffer;
    if (!raw) {
      const response = await fetch(file);
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      raw = await response.arrayBuffer();
    }
    const buffer = await inflate(raw);
    const rate = new Uint32Array(buffer, 0, 4)[3];
    const field = parse(buffer, light ? Math.max(1, Math.round(rate / 1000 / 5)) : 1);
    // Its points further apart, each statue point follows them over a little more (else the nearest one rules it).
    const spread = file === PHONE ? 0.012 : undefined;
    const binds = event.data.meshes.map(({ position, normal }) => bind(field, position, normal, spread));
    const moved = [field.keys, field.rest, field.around, field.normal, field.points, ...binds.flatMap((b) => [b.at, b.by])].map((a) => a.buffer as ArrayBuffer);
    self.postMessage({ field, binds }, { transfer: moved });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
