"use client";

import { MotionConfig, type Transition, type Variants } from "framer-motion";
import type { ReactNode } from "react";

// The one way text moves in Codevember, so that it all feels the same. Anyone who asks for less motion gets fades.
export const SETTLE: Transition = { type: "spring", stiffness: 300, damping: 32, mass: 0.9 };

export const rise: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: SETTLE }
};

export const riseBig: Variants = {
  hidden: { opacity: 0, y: 34 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 170, damping: 22 } }
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.7, ease: "easeOut" } }
};

export const inTurn = (gap: number, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } }
});

export function TextMotion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
