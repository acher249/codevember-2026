"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useMemo, useSyncExternalStore } from "react";
import { lehmer } from "../shared/engine/random";
import { paint, RARITY } from "./backpack";
import { ITEMS, pack, type ItemKind } from "./collectibles";
import { stow } from "./sound";

// "You found …!": a big card that springs up over the view for each find, with its picture, its name and how rare it
// is, a spray of confetti and a shine across it, then flies down into the backpack button, which bumps and counts it
// (the find only goes into the pack when its card lands). Finds in quick succession wait their turn, each shown a
// little shorter; the same kind again while its card is up adds to it (×2, ×3) instead. Never takes a press: the
// digging goes on underneath.

export const TIER: Record<string, number> = { Common: 0, Uncommon: 1, Rare: 2, Epic: 3, Legendary: 4 };
const HOLD = [1.8, 1.8, 2.0, 2.4, 2.8];
// How long the card takes to fly into the pack.
const FLY = 0.55;
// Where the card sits: its centre, as a share of the window's height.
// The card's centre, in px up from the bottom of the screen: bottom centre, clear of the calendar strip, so it never
// meets the "you broke into …" line, which sits up at 22% (owner, 27 Nov). Higher on phones, over the HUD buttons.
const LIFT = 205;
// On a phone held upright, high enough to clear the touch buttons in the corner below it; on one held sideways (or any
// short screen), in the middle, between the stick and the buttons.
const LIFT_PHONE = 360;
const SHORT = 520;
const lift = () => (typeof window === "undefined" ? LIFT : window.innerHeight <= SHORT ? window.innerHeight / 2 : window.innerWidth <= 560 ? LIFT_PHONE : LIFT);
const SEEN = "codevember-burrow-seen";

export type Card = { id: number; kind: ItemKind; count: number; first: boolean; bump: number; to: { x: number; y: number } | null };

let seen: Set<string> | null = null;
function firstOf(kind: ItemKind) {
  if (!seen) {
    seen = new Set();
    try {
      for (const k of JSON.parse(window.localStorage.getItem(SEEN) ?? "[]") as string[]) seen.add(k);
    } catch {
      // A private window: everything is new this visit.
    }
  }
  if (seen.has(kind)) return false;
  seen.add(kind);
  try {
    window.localStorage.setItem(SEEN, JSON.stringify([...seen]));
  } catch {
    // Not kept beyond this visit, then.
  }
  return true;
}

let ids = 0;
let timer = 0;
let until = 0;

export const finds = {
  showing: null as Card | null,
  // Cards on their way down into the pack.
  leaving: [] as Card[],
  queue: [] as Card[],
  version: 0,
  listeners: new Set<() => void>(),
  emit() {
    this.version++;
    for (const listener of this.listeners) listener();
  },
  // A find taken out of the rock.
  found(kind: ItemKind) {
    const first = firstOf(kind);
    const showing = this.showing;
    const last = this.queue[this.queue.length - 1];
    if (showing && showing.kind === kind) {
      showing.count++;
      showing.bump++;
      hold(Math.max(1.2, (until - performance.now()) / 1000));
    } else if (last && last.kind === kind) {
      last.count++;
    } else {
      this.queue.push({ id: ++ids, kind, count: 1, first, bump: 0, to: null });
      // Hurry the one showing along.
      if (showing) hold(Math.max(0, Math.min(0.7, (until - performance.now()) / 1000)));
    }
    if (!this.showing) next();
    this.emit();
  }
};

function hold(seconds: number) {
  window.clearTimeout(timer);
  until = performance.now() + seconds * 1000;
  timer = window.setTimeout(leave, seconds * 1000);
}

function next() {
  const card = finds.queue.shift() ?? null;
  finds.showing = card;
  if (card) hold(finds.queue.length ? 0.9 : HOLD[TIER[ITEMS[card.kind].rarity] ?? 0]);
}

// Down to the backpack button (or the corner, if it is not there).
function leave() {
  const card = finds.showing;
  if (!card) return;
  // The one showing: a desktop's pill or a touch screen's round button.
  const button = [...document.querySelectorAll("[data-burrow-pack]")].map((el) => el.getBoundingClientRect()).find((r) => r.width > 0);
  const x = button ? button.left + button.width / 2 : window.innerWidth - 60;
  const y = button ? button.top + button.height / 2 : window.innerHeight - 90;
  card.to = { x: x - window.innerWidth / 2, y: y - (window.innerHeight - lift()) };
  finds.leaving.push(card);
  next();
  finds.emit();
  window.setTimeout(() => {
    finds.leaving = finds.leaving.filter((c) => c !== card);
    pack.add(card.kind, card.count);
    stow(TIER[ITEMS[card.kind].rarity] ?? 0);
    finds.emit();
  }, FLY * 1000);
}

const fallback = new Map<ItemKind, string>();
function icon(kind: ItemKind) {
  const drawn = pack.icons[kind];
  if (drawn) return drawn;
  let painted = fallback.get(kind);
  if (!painted) {
    painted = paint(kind);
    fallback.set(kind, painted);
  }
  return painted;
}

export function Found() {
  useSyncExternalStore(
    (listener) => {
      finds.listeners.add(listener);
      return () => finds.listeners.delete(listener);
    },
    () => finds.version,
    () => 0
  );
  const calm = useReducedMotion() ?? false;
  const cards = finds.showing ? [...finds.leaving, finds.showing] : finds.leaving;
  return (
    <div className="burrow-finds" role="status" aria-live="polite">
      <style>{CSS}</style>
      {cards.map((card) => (
        <FindCard key={card.id} card={card} calm={calm} waiting={card === finds.showing ? finds.queue.length : 0} />
      ))}
    </div>
  );
}

function FindCard({ card, calm, waiting }: { card: Card; calm: boolean; waiting: number }) {
  const item = ITEMS[card.kind];
  const tier = TIER[item.rarity] ?? 0;
  const colour = RARITY[item.rarity];
  const to = card.to;
  const enter = calm ? { duration: 0.2 } : { type: "spring" as const, stiffness: 420, damping: 15, mass: 0.9 };
  const away = calm ? { opacity: 0 } : to ? { x: to.x, y: to.y, scale: 0.12, rotate: 14, opacity: 0.2 } : {};
  return (
    <motion.div
      className={`burrow-find tier-${tier}`}
      style={{ ["--rarity" as string]: colour }}
      initial={calm ? { opacity: 0 } : { opacity: 0, scale: 0.3, y: 40, rotate: -8 }}
      animate={to ? away : { opacity: 1, scale: 1, y: 0, x: 0, rotate: 0 }}
      transition={to ? { duration: FLY, ease: [0.55, 0, 0.8, 0.4] } : enter}
    >
      {!calm && tier >= 2 ? <span className="burrow-find-rays" /> : null}
      {!calm ? <Confetti seed={card.id} tier={tier} colour={colour} /> : null}
      <span className="burrow-find-glass">
        {!calm ? <span className="burrow-find-shine" /> : null}
      </span>
      {card.first ? (
        <motion.span
          className="burrow-find-new"
          initial={calm ? { opacity: 0 } : { scale: 0, rotate: -40 }}
          animate={calm ? { opacity: 1 } : { scale: [0, 1.3, 1], rotate: [-40, 18, 12] }}
          transition={{ duration: 0.45, delay: 0.25, ease: "easeOut" }}
        >
          New!
        </motion.span>
      ) : null}
      <motion.span
        key={card.bump}
        className="burrow-find-icon"
        initial={calm ? false : { scale: card.bump ? 1.35 : 0.2, rotate: card.bump ? 0 : -30 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 380, damping: 10, delay: card.bump ? 0 : 0.08 }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- painted at runtime, not a static asset. */}
        <img src={icon(card.kind)} alt="" />
      </motion.span>
      <small className="burrow-find-label">{tier === 4 ? "Legendary find!" : tier === 3 ? "Epic find!" : "You found"}</small>
      <motion.strong
        className="burrow-find-name"
        initial={calm ? false : { scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 400, damping: 12, delay: 0.14 }}
      >
        {item.name}
      </motion.strong>
      <span className="burrow-find-rarity">{item.rarity}</span>
      {card.count > 1 ? (
        <motion.b
          key={card.count}
          className="burrow-find-count"
          initial={calm ? false : { scale: 1.8 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 12 }}
        >
          ×{card.count}
        </motion.b>
      ) : null}
      {waiting > 0 && !to ? <span className="burrow-find-more">+{waiting} more</span> : null}
    </motion.div>
  );
}

// A burst of confetti and four-pointed stars from behind the card, more and further the rarer the find.
const PIECES = [12, 16, 22, 30, 42];
function Confetti({ seed, tier, colour }: { seed: number; tier: number; colour: string }) {
  const pieces = useMemo(() => {
    const random = lehmer(seed * 7919 + 1);
    const tints = [colour, "#fff4d6", "#ffd25a", colour];
    return Array.from({ length: PIECES[tier] ?? 12 }, () => {
      const angle = random() * Math.PI * 2;
      const reach = (110 + random() * 150) * (1 + tier * 0.12);
      return {
        x: Math.cos(angle) * reach,
        y: Math.sin(angle) * reach * 0.75 - 30,
        fall: 40 + random() * 70,
        spin: (random() - 0.5) * 720,
        delay: 0.05 + random() * 0.15,
        size: 6 + random() * 8,
        star: random() < 0.45,
        tint: tints[Math.floor(random() * tints.length)]
      };
    });
  }, [seed, tier, colour]);
  return (
    <span className="burrow-find-confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <motion.i
          key={i}
          className={p.star ? "star" : undefined}
          style={{ width: p.size, height: p.star ? p.size : p.size * 0.55, background: p.tint }}
          initial={{ x: 0, y: 0, opacity: 0, rotate: 0, scale: 0.4 }}
          animate={{ x: p.x, y: [0, p.y, p.y + p.fall], opacity: [0, 1, 1, 0], rotate: p.spin, scale: 1 }}
          transition={{ duration: 1.25, delay: p.delay, ease: "easeOut", y: { duration: 1.25, delay: p.delay, times: [0, 0.4, 1], ease: ["easeOut", "easeIn"] } }}
        />
      ))}
    </span>
  );
}

const CSS = `
.burrow-finds { position: fixed; left: 50%; top: calc(100% - ${LIFT}px); width: 0; height: 0; z-index: 32; pointer-events: none; }
.burrow-find {
  position: absolute; left: 0; top: 0; translate: -50% -50%;
  width: 300px; padding: 22px 20px 18px; box-sizing: border-box;
  display: flex; flex-direction: column; align-items: center; text-align: center;
  color: #f6ead8; pointer-events: none;
}
.burrow-find-glass {
  position: absolute; inset: 0; border-radius: 26px; overflow: hidden;
  border: 2px solid color-mix(in srgb, var(--rarity) 70%, transparent);
  background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--rarity) 30%, rgba(40,30,20,0.85)), rgba(16,12,9,0.9) 72%);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  box-shadow: 0 22px 60px rgba(0,0,0,0.55), 0 0 46px color-mix(in srgb, var(--rarity) 40%, transparent), inset 0 1px 0 rgba(255,255,255,0.25);
}
.burrow-find-shine { position: absolute; inset: 0; }
.burrow-find-shine::after {
  content: ""; position: absolute; top: -20%; bottom: -20%; width: 40%; left: -60%;
  background: linear-gradient(100deg, transparent, rgba(255,255,255,0.38), transparent);
  transform: skewX(-18deg); animation: burrow-find-shine 0.9s 0.35s ease-in-out both;
}
.tier-4 .burrow-find-shine::after { animation: burrow-find-shine 0.9s 0.35s ease-in-out 3 both; }
@keyframes burrow-find-shine { from { left: -60%; } to { left: 130%; } }
.burrow-find-rays {
  position: absolute; left: 50%; top: 40%; width: 560px; height: 560px; margin: -280px 0 0 -280px; border-radius: 50%;
  background: repeating-conic-gradient(color-mix(in srgb, var(--rarity) 30%, transparent) 0 8deg, transparent 8deg 22deg);
  -webkit-mask: radial-gradient(circle, #000 14%, transparent 62%); mask: radial-gradient(circle, #000 14%, transparent 62%);
  animation: burrow-find-turn 7s linear infinite, burrow-find-fade 0.5s ease-out both;
}
@keyframes burrow-find-turn { to { transform: rotate(360deg); } }
@keyframes burrow-find-fade { from { opacity: 0; } }
.burrow-find-confetti { position: absolute; left: 50%; top: 40%; width: 0; height: 0; }
.burrow-find-confetti i { position: absolute; left: -6px; top: -4px; border-radius: 2px; box-shadow: 0 0 8px rgba(255,230,170,0.5); }
.burrow-find-confetti i.star { border-radius: 0; clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%); box-shadow: none; }
.burrow-find-icon { position: relative; display: block; width: 112px; height: 112px; margin: -4px 0 6px; }
.burrow-find-icon::before {
  content: ""; position: absolute; inset: -14px; border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--rarity) 55%, transparent), transparent 68%);
}
.burrow-find-icon img { position: relative; width: 100%; height: 100%; filter: drop-shadow(0 6px 12px rgba(0,0,0,0.55)); animation: burrow-find-bob 2.4s 0.6s ease-in-out infinite; }
@keyframes burrow-find-bob { 50% { transform: translateY(-4px) rotate(3deg); } }
.burrow-find-label { position: relative; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255,240,215,0.78); }
.burrow-find-name {
  position: relative; display: block; margin: 4px 0 8px; font-size: 30px; line-height: 1.05; font-weight: 900; letter-spacing: -0.01em;
  background: linear-gradient(180deg, #ffffff, color-mix(in srgb, var(--rarity) 70%, #fff) 55%, var(--rarity));
  -webkit-background-clip: text; background-clip: text; color: transparent;
  filter: drop-shadow(0 2px 10px color-mix(in srgb, var(--rarity) 50%, transparent));
}
.burrow-find-rarity {
  position: relative; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--rarity); background: color-mix(in srgb, var(--rarity) 18%, rgba(0,0,0,0.3)); border: 1px solid color-mix(in srgb, var(--rarity) 50%, transparent);
}
.burrow-find-new {
  position: absolute; top: -12px; right: -10px; padding: 6px 12px; border-radius: 12px;
  font-size: 16px; font-weight: 900; letter-spacing: 0.02em; color: #fff;
  background: linear-gradient(180deg, #ff7a59, #e6365a); box-shadow: 0 6px 18px rgba(230,54,90,0.5), inset 0 1px 0 rgba(255,255,255,0.4);
}
.burrow-find-count {
  position: absolute; top: 14px; left: 16px; font-size: 22px; font-weight: 900; color: #fff;
  text-shadow: 0 0 12px var(--rarity), 0 2px 4px rgba(0,0,0,0.6);
}
.burrow-find-more {
  position: absolute; bottom: -30px; left: 50%; translate: -50% 0; padding: 3px 10px; border-radius: 999px; white-space: nowrap;
  font-size: 12px; font-weight: 700; color: #f6ead8; background: rgba(20,16,12,0.7); border: 1px solid rgba(255,255,255,0.15);
}
@media (max-width: 560px) {
  .burrow-finds { top: calc(100% - ${LIFT_PHONE}px); }
  .burrow-find { width: min(260px, calc(100vw - 48px)); padding: 18px 16px 14px; }
  .burrow-find-icon { width: 84px; height: 84px; }
  .burrow-find-name { font-size: 24px; }
  .burrow-find-rays { width: 400px; height: 400px; margin: -200px 0 0 -200px; }
}
@media (max-height: ${SHORT}px) {
  .burrow-finds { top: 50%; }
  .burrow-find { width: 230px; padding: 14px 14px 12px; }
  .burrow-find-icon { width: 64px; height: 64px; margin: -2px 0 4px; }
  .burrow-find-name { font-size: 21px; margin: 2px 0 6px; }
  .burrow-find-rays { width: 340px; height: 340px; margin: -170px 0 0 -170px; }
}
@media (prefers-reduced-motion: reduce) {
  .burrow-find-icon img, .burrow-find-rays, .burrow-find-shine::after { animation: none; }
}
`;
