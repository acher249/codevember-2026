import type { QualityTier } from "@/shared/engine/types";

// What this device made of each day on Auto before, kept for a fortnight: the best tier it kept up at, and the tier it
// was too slow at. A day it kept up with before is shown without timing it again behind the loader; a day it was too
// slow for starts a tier down, rather than building the higher tier's shaders only to step down from them. Only for a
// screen no larger than the one it was judged on, since more pixels cost more.

const KEY = "cv-judged";
const KEEP = 14 * 24 * 3600 * 1000;
const RANK: Record<QualityTier, number> = { low: 0, medium: 1, high: 2 };

type Verdict = { ok?: QualityTier; slow?: QualityTier; pixels: number; at: number };

const pixels = () => Math.round(window.innerWidth * window.innerHeight * (globalThis.devicePixelRatio || 1) ** 2);

function read(): Record<string, Verdict> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function recall(day: number) {
  const verdict = read()[day];
  if (!verdict || Date.now() - verdict.at > KEEP || pixels() > verdict.pixels * 1.1) return null;
  return verdict;
}

// Whether this device kept up with the day at this tier, or a higher one, before.
export const keptUp = (day: number, tier: QualityTier) => {
  const ok = recall(day)?.ok;
  return !!ok && RANK[ok] >= RANK[tier];
};

// The tier the day was too slow at before, if it was.
export const tooSlowAt = (day: number) => recall(day)?.slow ?? null;

export function judged(day: number, tier: QualityTier, keeps: boolean) {
  try {
    const all = read();
    const before = all[day] && Date.now() - all[day].at <= KEEP ? all[day] : { pixels: 0, at: 0 };
    const verdict: Verdict = { ...before, pixels: pixels(), at: Date.now() };
    if (keeps) {
      if (!verdict.ok || RANK[tier] > RANK[verdict.ok]) verdict.ok = tier;
      if (verdict.slow && RANK[verdict.slow] <= RANK[tier]) delete verdict.slow;
    } else {
      if (!verdict.slow || RANK[tier] < RANK[verdict.slow]) verdict.slow = tier;
      if (verdict.ok && RANK[verdict.ok] >= RANK[tier]) delete verdict.ok;
    }
    all[day] = verdict;
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // No storage (a private window, or it is full): every visit is timed, as before.
  }
}
