import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { Vector3 } from "three/webgpu";
import { createOutletPaints, type StreamPaint } from "./brush-colors";
import { Pendulum, ROPE, VESSELS } from "./pendulum";

const near = (actual: number, expected: number, tolerance = 1e-10) =>
  ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

test("each pendulum owns its pivot and keeps its rope constraint while swinging", () => {
  const pivot = new Vector3(-0.16, 2.75, 0);
  const a = new Pendulum(100, pivot);
  const b = new Pendulum(100, new Vector3(0.16, 3.05, 0.2));
  pivot.set(10, 10, 10);
  deepEqual(a.pivot.toArray(), [-0.16, 2.75, 0]);
  a.launch(0.3, 0, 0, 0.7);
  b.launch(0.3, 0, 0, 0.7);
  for (let frame = 0; frame < 120; frame++) {
    a.update(1 / 60);
    b.update(1 / 60);
    near(a.end.distanceTo(a.pivot), ROPE);
    near(b.end.distanceTo(b.pivot), ROPE);
    near(a.end.x - a.pivot.x, b.end.x - b.pivot.x);
    near(a.end.y - a.pivot.y, b.end.y - b.pivot.y);
    near(a.end.z - a.pivot.z, b.end.z - b.pivot.z);
    near(a.velocity.dot(a.end.clone().sub(a.pivot)), 0);
    near(b.velocity.dot(b.end.clone().sub(b.pivot)), 0);
  }
  a.rest();
  near(a.end.distanceTo(a.pivot), ROPE);
  near(a.nozzle(new Vector3()).distanceTo(a.pivot), ROPE + a.drop);
});

test("launch makes a repeatable tangent throw and discards an earlier pour", () => {
  const p = new Pendulum();
  p.launch(0.3, 0.1, 0.2, 0.7);
  for (let i = 0; i < 15; i++) p.update(1 / 60);
  const end = p.end.toArray();
  const velocity = p.velocity.toArray();
  ok(p.parcels.some(parcel => parcel.alive));
  p.grab();
  p.hold(new Vector3(0.6, 1, 0.5));
  p.update(1 / 60);
  p.paused = p.finished = true;
  p.launch(0.3, 0.1, 0.2, 0.7);
  equal(p.level, 1);
  equal(p.held || p.waiting || p.finished || p.paused, false);
  equal(p.parcels.some(parcel => parcel.alive), false);
  equal(p.landings.length, 0);
  for (let i = 0; i < 15; i++) p.update(1 / 60);
  deepEqual(p.end.toArray(), end);
  deepEqual(p.velocity.toArray(), velocity);
  p.launch(10, -10, 1, 1);
  near(p.end.distanceTo(p.pivot), ROPE);
  near(p.velocity.dot(p.end.clone().sub(p.pivot)), 0);
  ok(p.end.y < p.pivot.y);
});

test("paint in flight lands with its emitted colour after the bucket changes", () => {
  const p = new Pendulum();
  p.colour = "#0000ff";
  p.launch(0.3, 0, 0, 0.7);
  p.update(0.05);
  const emitted = p.parcels.filter(parcel => parcel.alive).length;
  ok(emitted > 0);
  p.colour = "#ffff00";
  p.paused = true;
  const colours: string[] = [];
  for (let i = 0; i < 60; i++) {
    p.update(1 / 60);
    colours.push(...p.landings.map(landing => landing.colour));
  }
  equal(colours.length, emitted);
  ok(colours.every(colour => colour === "#0000ff"));
  p.paused = false;
  for (let i = 0; i < 60; i++) {
    p.update(1 / 60);
    ok(p.landings.every(landing => landing.colour === "#ffff00"));
  }
});

test("the divided bucket has two physical outlets with three close filaments apiece", () => {
  const p = new Pendulum();
  p.vessel = VESSELS.divided;
  p.colour = "#2450b8";
  p.secondaryColour = "#f1ca35";
  p.outletPaints = [createOutletPaints(p.colour, 0.2), createOutletPaints(p.secondaryColour, 0.2)];
  p.launch(0.3, 0, 0, 0.7);
  equal(p.vessel.holes, 2);
  equal(p.vessel.partition, true);
  near(p.holeAt(0, new Vector3()).distanceTo(p.holeAt(1, new Vector3())), 0.02);
  ok(p.vessel.ring - 0.0055 >= 0.004, "each opening must clear the 8 mm divider");
  p.update(1 / 240);
  const parcels = p.parcels.filter(parcel => parcel.alive);
  deepEqual(parcels.map(parcel => parcel.stream), [0, 1, 2, 3, 4, 5]);
  for (const parcel of parcels) {
    const outlet = Math.floor(parcel.stream / 3);
    const filament = parcel.stream % 3;
    const start = p.streamAt(parcel.stream, new Vector3());
    const physical = p.holeAt(outlet, new Vector3());
    near(start.distanceTo(physical), filament === 1 ? 0 : 0.003);
    near(parcel.p.clone().addScaledVector(parcel.v, -1 / 240).distanceTo(start), 0);
    equal(parcel.colour, outlet === 0 ? p.colour : p.secondaryColour);
    equal(parcel.paint, p.outletPaints[outlet][filament]);
    ok(p.streamMatches(parcel));
  }
});

test("splitting divided outlets into filaments preserves flow and reservoir volume", () => {
  const split = new Pendulum();
  const unsplit = new Pendulum();
  for (const p of [split, unsplit]) {
    p.vessel = VESSELS.divided;
    p.launch(0.3, 0, 0, 0.7);
  }
  split.outletPaints = [createOutletPaints("#2450b8", 0.2), createOutletPaints("#f1ca35", 0.2)];
  for (let step = 0; step < 12; step++) {
    split.update(1 / 240);
    unsplit.update(1 / 240);
  }
  const splitParcels = split.parcels.filter(parcel => parcel.alive);
  const unsplitParcels = unsplit.parcels.filter(parcel => parcel.alive);
  equal(splitParcels.length, 3 * unsplitParcels.length);
  near(splitParcels.reduce((sum, parcel) => sum + parcel.volume, 0), unsplitParcels.reduce((sum, parcel) => sum + parcel.volume, 0), 1e-15);
  near(split.level, unsplit.level, 1e-13);
  for (const outlet of [0, 1]) {
    near(
      splitParcels.filter(parcel => Math.floor(parcel.stream / 3) === outlet).reduce((sum, parcel) => sum + parcel.volume, 0),
      unsplitParcels.filter(parcel => parcel.stream === outlet * 3).reduce((sum, parcel) => sum + parcel.volume, 0),
      1e-15
    );
  }
  const normal = new Pendulum();
  normal.outletPaints = split.outletPaints;
  normal.launch(0.3, 0, 0, 0.7);
  normal.update(1 / 240);
  const normalParcels = normal.parcels.filter(parcel => parcel.alive);
  equal(normalParcels.length, 1, "ordinary vessels should not acquire extra filaments");
  equal(normalParcels[0].paint, undefined);
});

test("both divided colours and all Z variants retain their identities through refill and landing", () => {
  const p = new Pendulum();
  p.vessel = VESSELS.divided;
  p.colour = "#2450b8";
  p.secondaryColour = "#f1ca35";
  const originals = [createOutletPaints(p.colour, 0.2), createOutletPaints(p.secondaryColour, 0.2)];
  p.outletPaints = originals;
  p.launch(0.3, 0, 0, 0.7);
  p.update(0.05);
  const expected = new Map<StreamPaint, { colour: string; count: number; volume: number }>();
  for (const parcel of p.parcels) {
    if (!parcel.alive) continue;
    ok(parcel.paint);
    const entry = expected.get(parcel.paint) ?? { colour: parcel.colour, count: 0, volume: 0 };
    entry.count++;
    entry.volume += parcel.volume;
    expected.set(parcel.paint, entry);
  }
  equal(expected.size, 6, "each physical source should emit its base and two distinct variants");
  p.colour = "#f05245";
  p.secondaryColour = "#31543b";
  p.outletPaints = [createOutletPaints(p.colour, 0.1), createOutletPaints(p.secondaryColour, 0.1)];
  p.paused = true;
  for (let frame = 0; frame < 60; frame++) {
    p.update(1 / 60);
    for (const landing of p.landings) {
      ok(landing.paint);
      const entry = expected.get(landing.paint);
      ok(entry, "a landing must carry the exact immutable paint it was emitted with");
      equal(landing.colour, entry.colour);
      entry.count--;
      entry.volume -= landing.volume;
    }
  }
  for (const entry of expected.values()) {
    equal(entry.count, 0);
    near(entry.volume, 0, 1e-15);
  }
});

test("falling parcels stop attaching to the nozzle when the outlet layout changes", () => {
  const p = new Pendulum();
  p.vessel = VESSELS.divided;
  p.outletPaints = [createOutletPaints("#2450b8", 0.2), createOutletPaints("#f1ca35", 0.2)];
  p.launch(0.3, 0, 0, 0.7);
  p.update(1 / 240);
  const parcel = p.parcels.find(parcel => parcel.alive)!;
  ok(p.streamMatches(parcel));
  p.outletPaints = [createOutletPaints("#f05245", 0), createOutletPaints("#31543b", 0)];
  ok(p.streamMatches(parcel), "changing colour should preserve the three-filament layout");
  p.outletPaints = null;
  equal(p.streamMatches(parcel), false);
  p.outletPaints = [createOutletPaints("#2450b8", 0.2), createOutletPaints("#f1ca35", 0.2)];
  equal(p.streamMatches(parcel), false, "returning to an old layout must not reconnect an earlier pour");
  p.update(1 / 240);
  const current = p.parcels.filter(parcel => parcel.alive).at(-1)!;
  ok(p.streamMatches(current));
  p.vessel = VESSELS.three;
  equal(p.streamMatches(current), false);
});

for (const [name, x, vz] of [["slow", 0.18, 0.35], ["ordinary", 0.3, 0.7], ["fast", 0.55, 1.1]] as const) {
  test(`the divided bucket keeps both paints in sustained wet contact during ${name} throws`, () => {
    const p = new Pendulum();
    p.vessel = VESSELS.divided;
    p.hole = 8.8e-6;
    p.outletPaints = [createOutletPaints(p.colour, 0.2), createOutletPaints(p.secondaryColour, 0.2)];
    p.launch(x, 0, 0, vz);
    const deposits: { x: number; z: number; time: number }[][] = [[], []];
    // Record exact physics-step arrival times rather than giving a whole frame's paint the same timestamp.
    for (let step = 0; step < 960; step++) {
      p.update(1 / 240);
      for (const landing of p.landings) {
        equal(landing.floor, false, "ordinary pours should stay on the canvas");
        deposits[landing.colour === p.colour ? 0 : 1].push({ x: landing.x, z: landing.z, time: step / 240 });
      }
    }
    let first = 0;
    let nearby = 0;
    let tight = 0;
    const intervals = Array.from({ length: 8 }, () => ({ total: 0, touching: 0 }));
    for (const landing of deposits[1]) {
      while (first < deposits[0].length && deposits[0][first].time < landing.time - 0.05) first++;
      let closest = Infinity;
      for (let k = first; k < deposits[0].length && deposits[0][k].time <= landing.time + 0.05; k++) {
        const other = deposits[0][k];
        closest = Math.min(closest, Math.hypot(landing.x - other.x, landing.z - other.z));
      }
      const interval = intervals[Math.floor(landing.time * 2)];
      interval.total++;
      if (closest < 0.003) {
        nearby++;
        interval.touching++;
      }
      if (closest < 0.001) tight++;
    }
    ok(deposits[0].length + deposits[1].length > 5000, "both outlets must pour continuously");
    ok(nearby / deposits[1].length > 0.98, "at least 98% should meet the other colour within 3 mm and 0.05 s");
    intervals.forEach((interval, index) => {
      ok(interval.total > 100, `interval ${index} needs a substantial paint sample`);
      ok(interval.touching / interval.total > 0.95, `contact must continue throughout half-second interval ${index}`);
    });
    if (name === "ordinary") ok(tight / deposits[1].length < 0.5, "the streams should retain offset coloured edges instead of becoming entirely coincident");
  });
}
