import { mulberry32 } from "../shared/engine/random";

// A perfect maze on a small torus, laid over the ground again and again, so that it reaches past the fog in every
// direction. Each cell has a wall on its east side and one on its south side; a wall's index is the cell's twice, plus
// one for the south. Being a torus, it has no edge to run into, and the copy the camera stands in is the only one seen.
//
// It rewrites itself one loop at a time. Taking a wall away from a perfect maze always makes exactly one loop, and
// putting back any other wall on that loop leaves a perfect maze again: every cell still reachable, by one way only.
// So the maze is never broken, only ever different.

export type Change = { opened: number; closed: number };

export class Maze {
  readonly size: number;
  // Whether each wall stands, or will once it has finished moving.
  readonly up: Uint8Array;
  // Each wall moves from one height to another, as 0 for sunk and 1 for standing, over a stretch of time.
  readonly from: Float32Array;
  readonly to: Float32Array;
  readonly start: Float32Array;
  readonly length: Float32Array;
  private random: () => number;
  // Scratch for the search along the maze's passages.
  private seen: Int32Array;
  private via: Int32Array;
  private queue: Int32Array;
  private stamp = 0;

  constructor(size: number, seed: number) {
    this.size = size;
    const walls = size * size * 2;
    this.up = new Uint8Array(walls).fill(1);
    this.from = new Float32Array(walls);
    this.to = new Float32Array(walls);
    this.start = new Float32Array(walls);
    this.length = new Float32Array(walls).fill(1);
    this.seen = new Int32Array(size * size);
    this.via = new Int32Array(size * size);
    this.queue = new Int32Array(size * size);
    this.random = mulberry32(seed);
    this.carve();
  }

  // A depth-first walk, which makes the long, doubling-back corridors a hedge maze is known for.
  private carve() {
    const { size } = this;
    const visited = new Uint8Array(size * size);
    const stack = [Math.floor(this.random() * size * size)];
    visited[stack[0]] = 1;
    const options: number[] = [];
    while (stack.length) {
      const cell = stack[stack.length - 1];
      options.length = 0;
      for (let way = 0; way < 4; way++) if (!visited[this.neighbour(cell, way)]) options.push(way);
      if (!options.length) {
        stack.pop();
        continue;
      }
      const way = options[Math.floor(this.random() * options.length)];
      const next = this.neighbour(cell, way);
      this.up[this.wall(cell, way)] = 0;
      visited[next] = 1;
      stack.push(next);
    }
    for (let i = 0; i < this.up.length; i++) this.to[i] = this.from[i] = this.up[i];
  }

  // Ways are east, south, west and north.
  neighbour(cell: number, way: number) {
    const { size } = this;
    const i = cell % size;
    const j = (cell - i) / size;
    if (way === 0) return j * size + ((i + 1) % size);
    if (way === 1) return ((j + 1) % size) * size + i;
    if (way === 2) return j * size + ((i + size - 1) % size);
    return ((j + size - 1) % size) * size + i;
  }

  wall(cell: number, way: number) {
    if (way === 0) return cell * 2;
    if (way === 1) return cell * 2 + 1;
    return this.neighbour(cell, way) * 2 + (way === 2 ? 0 : 1);
  }

  // How far up a wall stands at a moment, from 0 to 1, eased in and out.
  height(wall: number, now: number) {
    const t = Math.min(1, Math.max(0, (now - this.start[wall]) / this.length[wall]));
    const eased = t * t * t * (t * (t * 6 - 15) + 10);
    return this.from[wall] + (this.to[wall] - this.from[wall]) * eased;
  }

  moving(wall: number, now: number) {
    return now < this.start[wall] + this.length[wall];
  }

  // Every wall rises out of the ground at the start, those nearest the given cell first.
  rise(fromCell: number, now: number) {
    const { size } = this;
    const ci = fromCell % size;
    const cj = Math.floor(fromCell / size);
    for (let wall = 0; wall < this.up.length; wall++) {
      const cell = wall >> 1;
      let di = Math.abs((cell % size) - ci);
      let dj = Math.abs(Math.floor(cell / size) - cj);
      di = Math.min(di, size - di);
      dj = Math.min(dj, size - dj);
      this.from[wall] = 0;
      this.to[wall] = this.up[wall];
      this.start[wall] = now + Math.hypot(di, dj) * 0.05 + this.random() * 0.3;
      this.length[wall] = 1.4 + this.random() * 0.6;
    }
  }

  // When the last wall still moving will have stopped.
  settled() {
    let last = 0;
    for (let wall = 0; wall < this.up.length; wall++) last = Math.max(last, this.start[wall] + this.length[wall]);
    return last;
  }

  private move(wall: number, up: number, at: number, seconds: number) {
    this.up[wall] = up;
    this.from[wall] = this.height(wall, at);
    this.to[wall] = up;
    this.start[wall] = at;
    this.length[wall] = seconds;
  }

  // Opens one standing wall within reach of a cell and closes another on the loop that makes, keeping the loop short so
  // the change can be seen. Gives up and returns null if no wall nearby will do.
  change(centre: number, reach: number, now: number): Change | null {
    const { size } = this;
    const ci = centre % size;
    const cj = Math.floor(centre / size);
    for (let attempt = 0; attempt < 24; attempt++) {
      const i = (ci + Math.round((this.random() * 2 - 1) * reach) + size) % size;
      const j = (cj + Math.round((this.random() * 2 - 1) * reach) + size) % size;
      const a = j * size + i;
      const way = Math.floor(this.random() * 4);
      const opened = this.wall(a, way);
      if (!this.up[opened] || this.moving(opened, now)) continue;
      const b = this.neighbour(a, way);
      const path = this.path(a, b, 70);
      if (!path || path.length < 3) continue;
      // Not the first or last stretch of the loop, which would only swing the opening round a corner.
      const choices = path.filter((wall, index) => index > 0 && index < path.length - 1 && !this.moving(wall, now));
      if (!choices.length) continue;
      const closed = choices[Math.floor(this.random() * choices.length)];
      this.move(opened, 0, now, 3.4 + this.random() * 1.4);
      this.move(closed, 1, now + 0.8 + this.random() * 1.2, 3.8 + this.random() * 1.6);
      return { opened, closed };
    }
    return null;
  }

  // The walls crossed going from one cell to another through open passages, by breadth-first search, or null if the
  // way is longer than the limit.
  private path(a: number, b: number, limit: number) {
    const { seen, via, queue } = this;
    const mark = ++this.stamp;
    let head = 0;
    let tail = 0;
    queue[tail++] = a;
    seen[a] = mark;
    via[a] = -1;
    while (head < tail && tail < limit * 8) {
      const cell = queue[head++];
      if (cell === b) break;
      for (let way = 0; way < 4; way++) {
        const next = this.neighbour(cell, way);
        if (seen[next] === mark || this.up[this.wall(cell, way)]) continue;
        seen[next] = mark;
        via[next] = cell * 4 + way;
        queue[tail++] = next;
      }
    }
    if (seen[b] !== mark) return null;
    const walls: number[] = [];
    for (let cell = b; via[cell] >= 0; ) {
      const from = via[cell] >> 2;
      walls.push(this.wall(from, via[cell] & 3));
      cell = from;
      if (walls.length > limit) return null;
    }
    return walls;
  }
}
