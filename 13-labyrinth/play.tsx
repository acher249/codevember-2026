"use client";

import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { mulberry32 } from "../shared/engine/random";
import { BUNNY, useGame, type Catch, type Milestone } from "./game";

// Game mode's overlay: the coins you have, at the top, which jump with every one taken, and a card that rises from the
// foot of the screen on every tenth coin, a bigger one with a burst of coins on every hundredth, and one that bounds in
// from the side for every rabbit caught.
export function Play() {
  const { on, coins, milestone, bunny } = useGame();
  if (!on) return null;
  return (
    <>
      <style>{CSS}</style>
      <Counter coins={coins} />
      <AnimatePresence>{milestone ? <Card key={milestone.at} milestone={milestone} /> : null}</AnimatePresence>
      <AnimatePresence>{bunny ? <Caught key={bunny.at} bunny={bunny} /> : null}</AnimatePresence>
    </>
  );
}

function Counter({ coins }: { coins: number }) {
  const number = useAnimationControls();
  const coin = useAnimationControls();
  const seen = useRef(coins);
  useEffect(() => {
    if (coins === seen.current) return;
    seen.current = coins;
    void number.start({ scale: [1.45, 1], transition: { type: "spring", stiffness: 520, damping: 14 } });
    void coin.start({ rotateY: [0, 360], scale: [1.3, 1], transition: { duration: 0.45, ease: "easeOut" } });
  }, [coins, number, coin]);
  return (
    <motion.div className="cv-lab-counter" initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} aria-live="polite" aria-label={`${coins} coins`}>
      <motion.span className="cv-lab-coin" animate={coin} />
      <motion.span className="cv-lab-count" animate={number}>
        {coins}
      </motion.span>
      <AnimatePresence>
        <motion.span key={coins} className="cv-lab-plus" initial={{ opacity: 1, y: 0 }} animate={{ opacity: 0, y: -26 }} exit={{ opacity: 0 }} transition={{ duration: 0.7, ease: "easeOut" }}>
          +1
        </motion.span>
      </AnimatePresence>
    </motion.div>
  );
}

const CHEERS = ["Nice!", "Shiny!", "Keep going", "On a roll", "Ka-ching", "Lovely", "Rich!", "Golden"];
const BIG = ["Jackpot!", "Treasure hoard", "Legendary", "Coin royalty", "Unstoppable"];

function Card({ milestone }: { milestone: Milestone }) {
  const big = milestone.size === 100;
  // Picked from when it happened, so it stays the same however often the card is drawn.
  const list = big ? BIG : CHEERS;
  const cheer = list[Math.floor(mulberry32(Math.floor(milestone.at))() * list.length)];
  // Springs up from below the screen, holds a moment and drops away again.
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(false), big ? 3000 : 1900);
    return () => window.clearTimeout(timer);
  }, [big]);
  return (
    <motion.div
      className={`cv-lab-card ${big ? "cv-lab-card-big" : ""}`}
      initial={{ y: 240, scale: 0.8, opacity: 0 }}
      animate={shown ? { y: 0, scale: 1, opacity: 1 } : { y: 240, scale: 0.9, opacity: 0 }}
      exit={{ y: 240, opacity: 0, transition: { duration: 0.3 } }}
      transition={shown ? { type: "spring", stiffness: 260, damping: 15 } : { duration: 0.45, ease: [0.5, 0, 0.75, 0] }}
      role="status"
    >
      {big ? <Burst seed={Math.floor(milestone.at)} /> : null}
      {big ? <span className="cv-lab-rays" /> : null}
      <span className="cv-lab-shine" />
      <span className="cv-lab-stack" aria-hidden="true">
        <span className="cv-lab-coin" />
        <span className="cv-lab-coin" />
        <span className="cv-lab-coin" />
      </span>
      <span className="cv-lab-words">
        <motion.strong initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 11, delay: 0.25 }}>
          {milestone.coins} coins
        </motion.strong>
        <small>{cheer}</small>
      </span>
    </motion.div>
  );
}

const BUNNY_CHEERS = ["Gotcha!", "Speedy paws", "Hop to it", "Bunny bonus", "So fluffy", "Quick hands"];

function Caught({ bunny }: { bunny: Catch }) {
  const cheer = BUNNY_CHEERS[Math.floor(mulberry32(Math.floor(bunny.at))() * BUNNY_CHEERS.length)];
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(false), 2400);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <motion.div
      className="cv-lab-card cv-lab-bunny"
      initial={{ x: 420, rotate: 8, opacity: 0 }}
      animate={shown ? { x: 0, rotate: 0, opacity: 1 } : { x: 420, rotate: 6, opacity: 0 }}
      exit={{ x: 420, opacity: 0, transition: { duration: 0.3 } }}
      transition={shown ? { type: "spring", stiffness: 300, damping: 16 } : { duration: 0.45, ease: [0.5, 0, 0.75, 0] }}
      role="status"
    >
      <span className="cv-lab-shine" />
      <motion.span className="cv-lab-rabbit" aria-hidden="true" initial={{ y: 0 }} animate={{ y: [0, -16, 0, -9, 0] }} transition={{ duration: 0.9, delay: 0.2, times: [0, 0.3, 0.55, 0.78, 1], ease: "easeOut" }}>
        <svg viewBox="0 0 48 48" width="48" height="48">
          <ellipse cx="17" cy="12" rx="4.5" ry="11" fill="#fff" transform="rotate(-12 17 12)" />
          <ellipse cx="17" cy="12" rx="2" ry="8" fill="#f6b8c8" transform="rotate(-12 17 12)" />
          <ellipse cx="30" cy="12" rx="4.5" ry="11" fill="#fff" transform="rotate(12 30 12)" />
          <ellipse cx="30" cy="12" rx="2" ry="8" fill="#f6b8c8" transform="rotate(12 30 12)" />
          <circle cx="24" cy="31" r="13" fill="#fff" />
          <circle cx="19" cy="29" r="1.8" fill="#2a1d14" />
          <circle cx="29" cy="29" r="1.8" fill="#2a1d14" />
          <ellipse cx="24" cy="34" rx="2" ry="1.4" fill="#f08aa4" />
          <circle cx="15" cy="35" r="2.6" fill="#ffd0dc" opacity="0.8" />
          <circle cx="33" cy="35" r="2.6" fill="#ffd0dc" opacity="0.8" />
        </svg>
      </motion.span>
      <span className="cv-lab-words">
        <motion.strong initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 380, damping: 11, delay: 0.2 }}>
          +{BUNNY} bunny!
        </motion.strong>
        <small>
          {cheer} · {bunny.caught} caught
        </small>
      </span>
    </motion.div>
  );
}

// A fountain of coins thrown up from the card.
function Burst({ seed }: { seed: number }) {
  const throws = useMemo(() => {
    const random = mulberry32(seed);
    return Array.from({ length: 22 }, () => ({
      x: (random() - 0.5) * 520,
      up: 160 + random() * 260,
      spin: (random() - 0.5) * 900,
      delay: 0.25 + random() * 0.3,
      size: 14 + random() * 14
    }));
  }, [seed]);
  return (
    <span className="cv-lab-burst" aria-hidden="true">
      {throws.map((t, i) => (
        <motion.span
          key={i}
          className="cv-lab-coin"
          style={{ width: t.size, height: t.size }}
          initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
          animate={{ x: t.x, y: [0, -t.up, 120], opacity: [0, 1, 1, 0], rotate: t.spin }}
          transition={{ duration: 1.6, delay: t.delay, ease: "easeOut", y: { duration: 1.6, delay: t.delay, times: [0, 0.45, 1], ease: ["easeOut", "easeIn"] } }}
        />
      ))}
    </span>
  );
}

const CSS = `
/* Centred in the top bar on a desktop, clear of the notes under the calendar; just under the calendar on a phone. */
.cv-lab-counter {
  position: absolute;
  top: max(12px, env(safe-area-inset-top));
  left: 50%;
  margin-left: -60px;
  min-width: 120px;
  justify-content: center;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 44px;
  padding: 0 18px 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 214, 120, 0.35);
  background: linear-gradient(180deg, rgba(40, 30, 10, 0.72), rgba(20, 16, 8, 0.72));
  -webkit-backdrop-filter: blur(16px);
  backdrop-filter: blur(16px);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 236, 180, 0.15);
  color: #fff3d0;
  font-weight: 800;
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  z-index: 5;
  perspective: 200px;
}
.cv-lab-count { display: inline-block; text-shadow: 0 0 14px rgba(255, 200, 80, 0.55); }
.cv-lab-plus {
  position: absolute;
  right: -18px;
  top: 4px;
  font-size: 14px;
  color: #ffd56a;
  text-shadow: 0 0 10px rgba(255, 200, 80, 0.8);
}
.cv-lab-coin {
  display: inline-block;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  flex: none;
  background: radial-gradient(circle at 34% 28%, #fff8d6 0 12%, #ffd75e 32%, #e8a724 64%, #a86a10 100%);
  box-shadow: inset 0 0 0 2px rgba(255, 240, 190, 0.55), inset 0 -3px 4px rgba(110, 60, 0, 0.45), 0 0 14px rgba(255, 190, 60, 0.55);
}
.cv-lab-card {
  position: absolute;
  left: 50%;
  /* Clear of the row of days along the foot of the screen. */
  bottom: calc(max(10px, env(safe-area-inset-bottom)) + 76px);
  margin-left: -150px;
  width: 300px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 22px 16px 18px;
  border-radius: 22px;
  border: 1px solid rgba(255, 220, 130, 0.5);
  background: linear-gradient(160deg, rgba(70, 48, 8, 0.86), rgba(24, 16, 4, 0.9));
  -webkit-backdrop-filter: blur(18px);
  backdrop-filter: blur(18px);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45), 0 0 40px rgba(255, 190, 60, 0.25), inset 0 1px 0 rgba(255, 240, 190, 0.3);
  color: #fff3d0;
  pointer-events: none;
  z-index: 6;
  overflow: visible;
}
.cv-lab-card-big {
  width: 380px;
  margin-left: -190px;
  padding: 22px 26px 22px 22px;
  border-color: rgba(255, 230, 150, 0.85);
  background: linear-gradient(160deg, rgba(120, 78, 6, 0.92), rgba(40, 24, 2, 0.94));
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.5), 0 0 90px rgba(255, 200, 70, 0.55), inset 0 1px 0 rgba(255, 245, 200, 0.45);
}
.cv-lab-shine {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}
.cv-lab-shine::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 40%;
  left: -60%;
  background: linear-gradient(100deg, transparent, rgba(255, 245, 210, 0.35), transparent);
  animation: cv-lab-sweep 1.1s 0.35s ease-in-out;
}
@keyframes cv-lab-sweep { to { left: 130%; } }
.cv-lab-stack { position: relative; width: 44px; height: 44px; flex: none; }
.cv-lab-stack .cv-lab-coin { position: absolute; width: 34px; height: 34px; }
.cv-lab-stack .cv-lab-coin:nth-child(1) { left: 0; top: 10px; }
.cv-lab-stack .cv-lab-coin:nth-child(2) { left: 10px; top: 5px; }
.cv-lab-stack .cv-lab-coin:nth-child(3) { left: 5px; top: 0; animation: cv-lab-flip 0.8s 0.3s ease-out; }
@keyframes cv-lab-flip { from { transform: rotateY(0); } to { transform: rotateY(720deg); } }
.cv-lab-card-big .cv-lab-stack { width: 60px; height: 60px; }
.cv-lab-card-big .cv-lab-stack .cv-lab-coin { width: 46px; height: 46px; }
.cv-lab-words { display: flex; flex-direction: column; line-height: 1.1; }
.cv-lab-words strong {
  display: inline-block;
  white-space: nowrap;
  font-size: 30px;
  font-weight: 900;
  letter-spacing: -0.01em;
  transform-origin: left center;
  background: linear-gradient(180deg, #fffbe8, #ffd25a 60%, #f0a320);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  filter: drop-shadow(0 2px 8px rgba(255, 180, 40, 0.5));
}
.cv-lab-card-big .cv-lab-words strong { font-size: 40px; }
.cv-lab-words small { white-space: nowrap; margin-top: 4px; font-size: 13px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255, 236, 190, 0.8); }
.cv-lab-rays {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 640px;
  height: 640px;
  margin: -320px 0 0 -320px;
  border-radius: 50%;
  background: repeating-conic-gradient(rgba(255, 220, 120, 0.22) 0 8deg, transparent 8deg 24deg);
  -webkit-mask: radial-gradient(circle, #000 18%, transparent 62%);
  mask: radial-gradient(circle, #000 18%, transparent 62%);
  animation: cv-lab-turn 6s linear infinite;
  z-index: -1;
  pointer-events: none;
}
@keyframes cv-lab-turn { to { transform: rotate(360deg); } }
.cv-lab-burst { position: absolute; left: 50%; top: 30%; width: 0; height: 0; }
.cv-lab-burst .cv-lab-coin { position: absolute; left: -12px; top: -12px; }
/* Just over the coin cards, so that both can show at once. */
.cv-lab-bunny {
  width: 320px;
  margin-left: -160px;
  bottom: calc(max(10px, env(safe-area-inset-bottom)) + 200px);
  border-color: rgba(255, 210, 225, 0.6);
  background: linear-gradient(160deg, rgba(92, 40, 60, 0.88), rgba(30, 14, 22, 0.92));
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45), 0 0 40px rgba(255, 150, 190, 0.3), inset 0 1px 0 rgba(255, 230, 240, 0.3);
}
.cv-lab-bunny .cv-lab-words strong { background: linear-gradient(180deg, #ffffff, #ffd4e2 55%, #ff9cbc); -webkit-background-clip: text; background-clip: text; filter: drop-shadow(0 2px 8px rgba(255, 140, 180, 0.5)); }
.cv-lab-bunny .cv-lab-words small { color: rgba(255, 225, 235, 0.85); }
.cv-lab-rabbit { display: inline-block; flex: none; filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.35)); }
@media (max-width: 560px) {
  /* Over the Jump button on a phone. */
  .cv-lab-card { bottom: calc(max(10px, env(safe-area-inset-bottom)) + 150px); }
  .cv-lab-bunny { width: 290px; margin-left: -145px; bottom: calc(max(10px, env(safe-area-inset-bottom)) + 270px); }
  .cv-lab-bunny .cv-lab-words strong { font-size: 26px; }
  .cv-lab-counter { top: calc(max(16px, env(safe-area-inset-top)) + 46px); left: max(20px, env(safe-area-inset-left)); margin-left: 0; min-width: 0; height: 40px; font-size: 18px; }
  .cv-lab-card { width: 260px; margin-left: -130px; }
  .cv-lab-card-big { width: calc(100vw - 32px); margin-left: calc(-50vw + 16px); }
  .cv-lab-card-big .cv-lab-words strong { font-size: 32px; }
  .cv-lab-rays { width: 460px; height: 460px; margin: -230px 0 0 -230px; }
}
@media (prefers-reduced-motion: reduce) {
  .cv-lab-rays, .cv-lab-shine::after, .cv-lab-stack .cv-lab-coin { animation: none; }
}
`;
