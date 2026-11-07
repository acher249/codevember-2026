"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { OverviewSection } from "../engine/types";
import { SETTLE, inTurn, rise } from "./motion";

// How a day is built, folded away under its notes until asked for.
export function Overview({ sections }: { sections: OverviewSection[] }) {
  const [open, setOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);

  // Stops above the day's title, however long the notes above it run, and scrolls within itself.
  useEffect(() => {
    if (!open) return;
    const fit = () => {
      const body = scroll.current;
      const title = document.querySelector(".cv-title-day");
      if (!body || !title) return;
      body.style.maxHeight = `${Math.max(140, title.getBoundingClientRect().top - body.getBoundingClientRect().top - 20)}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  return (
    <motion.div className="cv-overview" variants={rise} initial="hidden" animate="show" transition={{ delay: 0.65 }}>
      <button type="button" className="cv-overview-head" aria-expanded={open} aria-controls="cv-overview-body" onClick={() => setOpen((was) => !was)}>
        Technical overview
        <motion.svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" initial={false} animate={{ rotate: open ? 0 : -90 }} transition={SETTLE}>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </motion.svg>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            id="cv-overview-body"
            className="cv-overview-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SETTLE}
          >
            <motion.div ref={scroll} className="cv-overview-scroll" variants={inTurn(0.05, 0.06)} initial="hidden" animate="show">
              {sections.map((section) => (
                <motion.section key={section.title} variants={rise}>
                  <h3>{section.title}</h3>
                  <ul>
                    {section.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </motion.section>
              ))}
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}
