// Meshes chunks of the rock off the page. Each worker keeps its own copy of every dig (they are sent to all of them in
// order), so any of them can mesh any chunk; the page asks for chunks nearest the visitor first.
import { chunkIsUniform, meshChunk, Rock, type ChunkMesh, type Edit } from "./field";

const rock = new Rock();

type Message = { type: "edit"; edit: Edit } | { type: "mesh"; key: number; cx: number; cy: number; cz: number; version: number };

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (message.type === "edit") {
    rock.add(message.edit);
    return;
  }
  const { key, cx, cy, cz, version } = message;
  const mesh: ChunkMesh | null = chunkIsUniform(rock, cx, cy, cz) ? null : meshChunk(rock, cx, cy, cz);
  const transfer = mesh ? [mesh.position.buffer, mesh.normal.buffer, mesh.info.buffer, mesh.index.buffer] : [];
  self.postMessage({ type: "mesh", key, version, mesh }, { transfer: transfer as ArrayBuffer[] });
};
