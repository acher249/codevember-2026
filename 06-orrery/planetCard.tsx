"use client";

import { AnimatePresence, motion, useMotionValue, useSpring } from "framer-motion";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clock } from "./readout";
import type { Gear, Shaft, Train } from "./train";

// Figures from NASA's Planetary Fact Sheet. Orbits are in astronomical units, for working out the distance from Earth.
type Body = { name: string; kind: string; colour: string; orbit?: number; machine?: boolean; facts: [string, string][] };

const AU_KM = 149_597_871;

export const BODIES: Record<string, Body> = {
  sun: { name: "The Sun", kind: "G-type star", colour: "#ffb45e", facts: [["Diameter", "1,392,700 km"], ["Surface", "5,500 °C"], ["Turns once in", "25 days"], ["Age", "4.6 billion years"]] },
  mercury: { name: "Mercury", kind: "Rocky planet", colour: "#c8cbcd", orbit: 0.387, facts: [["Diameter", "4,879 km"], ["Year", "88 days"], ["Turns once in", "59 days"], ["Average temperature", "167 °C"], ["Moons", "0"]] },
  venus: { name: "Venus", kind: "Rocky planet", colour: "#e6c37e", orbit: 0.723, facts: [["Diameter", "12,104 km"], ["Year", "225 days"], ["Turns once in", "243 days, backwards"], ["Average temperature", "464 °C"], ["Moons", "0"]] },
  earth: { name: "Earth", kind: "Rocky planet", colour: "#4f9de8", orbit: 1, facts: [["Diameter", "12,756 km"], ["Year", "365.25 days"], ["Turns once in", "23.9 hours"], ["Average temperature", "15 °C"], ["Moons", "1"]] },
  moon: { name: "The Moon", kind: "Earth's moon", colour: "#d7d7d2", facts: [["Diameter", "3,475 km"], ["Orbits Earth in", "27.3 days"], ["Average temperature", "−20 °C"], ["Gravity", "⅙ of Earth's"]] },
  mars: { name: "Mars", kind: "Rocky planet", colour: "#d06f42", orbit: 1.524, facts: [["Diameter", "6,792 km"], ["Year", "687 days"], ["Turns once in", "24.6 hours"], ["Average temperature", "−65 °C"], ["Moons", "2"]] },
  jupiter: { name: "Jupiter", kind: "Gas giant", colour: "#d3a56e", orbit: 5.203, facts: [["Diameter", "142,984 km"], ["Year", "11.9 years"], ["Turns once in", "9.9 hours"], ["Average temperature", "−110 °C"], ["Moons", "95+"]] },
  saturn: { name: "Saturn", kind: "Gas giant", colour: "#e4c88c", orbit: 9.537, facts: [["Diameter", "120,536 km"], ["Year", "29.4 years"], ["Turns once in", "10.7 hours"], ["Average temperature", "−140 °C"], ["Moons", "270+"]] }
};

// The things that show a card just by being pointed at. Parts of the machine are added to BODIES, but only show one when held.
export const SKY_BODIES = new Set(Object.keys(BODIES));

const BRASS = "#d9b470";
const PLANET_NAMES: Record<string, string> = { mercury: "Mercury", venus: "Venus", earth: "Earth", mars: "Mars", jupiter: "Jupiter", saturn: "Saturn" };
const turns = (speed: number) => (Math.abs(speed) >= 0.995 ? Math.abs(speed).toFixed(2).replace(/\.00$/, "") : Math.abs(speed).toFixed(3));

// Cards for the crank and every gear, from the train itself.
export function addMachineCards(train: Train) {
  const earth = train.shafts.get("earth") as Shaft;
  const speedOf = (shaft: Shaft) => shaft.speed + (shaft.carried ? earth.speed : 0);
  for (const gear of train.gears.values()) {
    const shaft = train.shafts.get(gear.shaft) as Shaft;
    const mesh = train.meshes.find((pair) => pair.driver === gear.id || pair.driven === gear.id);
    const other = mesh && (train.gears.get(mesh.driver === gear.id ? mesh.driven : mesh.driver) as Gear);
    const facts: [string, string][] = [["Teeth", String(gear.teeth)]];
    if (other) facts.push(["Meshes with", `${other.teeth} teeth`]);
    if (gear.shaft === "sun") facts.push(["Turns", "Never: it is fixed"]);
    else facts.push(["Turns per crank turn", turns(speedOf(shaft))]);
    if (PLANET_NAMES[gear.shaft]) facts.push(["Carries", PLANET_NAMES[gear.shaft]]);
    BODIES[gear.id] = { name: "Gear", kind: "Involute spur gear", colour: BRASS, machine: true, facts };
  }
  const wheel = train.gears.get("crankWheel") as Gear;
  BODIES.crank = {
    name: "The crank",
    kind: "Drives the whole machine",
    colour: "#b98a56",
    machine: true,
    facts: [
      ["Wheel", `${wheel.teeth} teeth`],
      ["One turn is", `${turns(earth.speed)} Earth years`],
      ["Gears in the train", String(train.gears.size)]
    ]
  };
}

// What the pointer is over. The clockwork writes it and the card reads it.
const listeners = new Set<() => void>();
let hovered: string | null = null;
// Where that body is on screen, and how far out it reaches from its centre there.
export const anchor = { x: 0, y: 0, reach: 0 };

export function setHovered(id: string | null) {
  if (id === hovered) return;
  hovered = id;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const fromSun = (orbit: number) => (orbit < 1 ? `${(orbit * AU_KM / 1e6).toFixed(1)} million km` : `${(orbit * AU_KM / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })} million km`);

// How far from Earth, on the date the machine has reached, taking the orbits as circles.
function fromEarth(id: string) {
  if (id === "earth") return "You are here";
  if (id === "moon") return "384,400 km";
  if (id === "sun") return "149.6 million km";
  const body = BODIES[id];
  const difference = clock.longitude(id) - clock.longitude("earth");
  const astronomical = Math.sqrt(body.orbit! * body.orbit! + 1 - 2 * body.orbit! * Math.cos(difference));
  return `${((astronomical * AU_KM) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 })} million km`;
}

const WIDTH = 204;
const GAP = 14;
const EDGE = 12;
// How far past the middle of the screen a body can travel before its card crosses back to the outside.
const CROSSED = 90;
type Place = "left" | "right" | "above" | "below";

const rows = { hidden: {}, show: { transition: { staggerChildren: 0.035, delayChildren: 0.06 } } };
const row = { hidden: { opacity: 0, x: -8 }, show: { opacity: 1, x: 0, transition: { type: "spring" as const, stiffness: 420, damping: 30 } } };

export function PlanetCard() {
  const id = useSyncExternalStore(subscribe, () => hovered, () => null);
  const [canHover, setCanHover] = useState(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const smoothX = useSpring(x, { stiffness: 420, damping: 36, mass: 0.6 });
  const smoothY = useSpring(y, { stiffness: 420, damping: 36, mass: 0.6 });
  const distance = useRef<HTMLElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const place = useRef<Place | null>(null);

  useEffect(() => setCanHover(window.matchMedia("(hover: hover) and (pointer: fine)").matches), []);
  useEffect(() => () => setHovered(null), []);

  useEffect(() => {
    if (!id) return;
    place.current = null;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const height = card.current?.offsetHeight ?? 170;
      const clear = anchor.reach + GAP;
      const screenWidth = window.innerWidth;
      // The open controls panel counts as the edge of the page.
      const panel = document.getElementById("cv-panel")?.getBoundingClientRect();
      const rightEdge = panel && panel.height > 120 ? Math.min(screenWidth, panel.left) : screenWidth;
      const screenHeight = window.innerHeight;
      const fits = (where: Place) => {
        if (where === "left") return anchor.x - clear - WIDTH >= EDGE;
        if (where === "right") return anchor.x + clear + WIDTH <= rightEdge - EDGE;
        if (where === "above") return anchor.y - clear - height >= EDGE;
        return anchor.y + clear + height <= screenHeight - EDGE;
      };
      // Clear of the machine where possible: the outside for a planet, above for the Sun. It stays put until it runs out of room.
      const outside: Place = anchor.x > screenWidth / 2 ? "right" : "left";
      const inside: Place = outside === "right" ? "left" : "right";
      const crossed = place.current === inside && Math.abs(anchor.x - screenWidth / 2) > CROSSED;
      if (!place.current || !fits(place.current) || crossed) {
        const order: Place[] = id === "sun" ? ["above", "below", outside, inside] : [outside, "below", "above", inside];
        place.current = order.find(fits) ?? inside;
      }
      const left = place.current === "left" ? anchor.x - clear - WIDTH : place.current === "right" ? anchor.x + clear : anchor.x - WIDTH / 2;
      const top = place.current === "above" ? anchor.y - clear - height : place.current === "below" ? anchor.y + clear : anchor.y - height / 2;
      const cardX = Math.max(EDGE, Math.min(rightEdge - WIDTH - EDGE, left));
      const cardY = Math.max(EDGE, Math.min(screenHeight - height - EDGE, top));
      // Step aside rather than cover the date.
      const date = document.querySelector(".cv-date")?.getBoundingClientRect();
      const onDate = date && cardX < date.right && cardX + WIDTH > date.left && cardY < date.bottom && cardY + height > date.top;
      const aside = date && (anchor.x < (date.left + date.right) / 2 ? date.left - WIDTH - EDGE : date.right + EDGE);
      x.set(onDate ? Math.max(EDGE, Math.min(rightEdge - WIDTH - EDGE, aside as number)) : cardX);
      y.set(cardY);
      if (distance.current && !BODIES[id].machine) distance.current.textContent = fromEarth(id);
    };
    tick();
    if (!smoothX.isAnimating()) {
      smoothX.jump(x.get());
      smoothY.jump(y.get());
    }
    return () => cancelAnimationFrame(frame);
  }, [id, x, y, smoothX, smoothY]);

  if (!canHover) return null;
  const body = id ? BODIES[id] : null;

  return (
    <AnimatePresence>
      {body && id ? (
        <motion.div
          ref={card}
          className="cv-planet"
          style={{ x: smoothX, y: smoothY, width: WIDTH, "--planet": body.colour } as never}
          initial={{ opacity: 0, scale: 0.9, filter: "blur(6px)" }}
          animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, scale: 0.94, filter: "blur(4px)" }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          role="status"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={id} variants={rows} initial="hidden" animate="show" exit={{ opacity: 0, transition: { duration: 0.08 } }}>
              <motion.header variants={row}>
                <i aria-hidden="true" />
                <div>
                  <strong>{body.name}</strong>
                  <span>{body.kind}</span>
                </div>
              </motion.header>
              <dl>
                {body.machine ? null : (
                  <motion.div variants={row} className="cv-planet-live">
                    <dt>From Earth now</dt>
                    <dd ref={distance}>{fromEarth(id)}</dd>
                  </motion.div>
                )}
                {body.orbit ? (
                  <motion.div variants={row}>
                    <dt>From the Sun</dt>
                    <dd>{fromSun(body.orbit)}</dd>
                  </motion.div>
                ) : null}
                {body.facts.map(([label, value]) => (
                  <motion.div key={label} variants={row}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </motion.div>
                ))}
              </dl>
            </motion.div>
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
