"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { dayOfYear } from "./bands";

// How many years the Earth's arm has gone round since the page opened. The clockwork writes it and this reads it.
export const clock = { years: 0, longitude: ((() => 0) as (id: string) => number) };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const YEAR = 365.25;

const era = (year: number) => (year > 0 ? String(year) : `${1 - year} BC`);

function dateOf(years: number) {
  const whole = Math.floor(years);
  let day = Math.min(364, Math.floor((years - whole) * 365));
  let month = 0;
  while (day >= MONTH_DAYS[month]) day -= MONTH_DAYS[month++];
  return `${MONTHS[month]} ${day + 1}`;
}

// The date the machine has reached. It starts today, stops when the machine comes apart, and runs backwards if it is turned backwards.
export function Readout() {
  const [start] = useState(() => {
    const today = new Date();
    return today.getFullYear() + (dayOfYear(today) + 0.5) / 365;
  });
  const [year, setYear] = useState(Math.floor(start));
  const date = useRef<HTMLSpanElement>(null);
  const days = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    clock.years = 0;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      setYear(Math.floor(start + clock.years));
      if (date.current) date.current.textContent = dateOf(start + clock.years);
      if (days.current) days.current.textContent = `${Math.floor(Math.abs(clock.years) * YEAR).toLocaleString("en-US")} days`;
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [start]);

  return (
    <motion.div className="cv-date" aria-hidden="true" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7, type: "spring", stiffness: 170, damping: 22 }}>
      <div className="cv-date-year">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={year} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -14 }} transition={{ type: "spring", stiffness: 300, damping: 30 }}>
            {era(year)}
          </motion.span>
        </AnimatePresence>
      </div>
      <p>
        <span ref={date}>{dateOf(start)}</span> · <span ref={days}>0 days</span>
      </p>
    </motion.div>
  );
}
