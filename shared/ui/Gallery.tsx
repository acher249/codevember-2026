"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";
import { dayHref, days, daySlug, promptDayFor } from "../days";
import { SETTLE, TextMotion, inTurn, rise, riseBig } from "./motion";

const pad = (day: number) => String(day).padStart(2, "0");

export function Gallery() {
  const [promptDay, setPromptDay] = useState<number | undefined>();
  useEffect(() => setPromptDay(promptDayFor(new Date())), []);

  return (
    <TextMotion>
    <main className="cv-gallery">
      <motion.header className="cv-gallery-head" variants={inTurn(0.1, 0.05)} initial="hidden" animate="show">
        <motion.h1 variants={riseBig}>Codevember</motion.h1>
        <motion.p variants={rise}>
          One word, one real-time 3D experience, every day of November 2026. WebGPU, shaders, light you can
          grab.
        </motion.p>
      </motion.header>

      <motion.ol className="cv-grid" variants={inTurn(0.028, 0.3)} initial="hidden" animate="show">
        {days.map((day) => {
          const open = day.live;
          const classes = `cv-card ${open ? "cv-card-open" : ""} ${day.day === promptDay ? "cv-card-today" : ""}`;
          const body = (
            <>
              {day.live ? (
                <span
                  className="cv-card-image"
                  style={{ backgroundImage: `url(/posters/${daySlug(day)}.jpg)` }}
                  aria-hidden="true"
                />
              ) : null}
              <span className="cv-card-number">{pad(day.day)}</span>
              <span className="cv-card-word">{day.word}</span>
              {day.day === promptDay ? <span className="cv-card-flag">Today</span> : null}
            </>
          );
          return (
            <motion.li key={day.day} variants={rise} whileHover={open ? { y: -4 } : undefined} transition={SETTLE}>
              {open ? (
                <Link className={classes} href={dayHref(day)} prefetch={false}>
                  {body}
                </Link>
              ) : (
                <div className={classes}>{body}</div>
              )}
            </motion.li>
          );
        })}
      </motion.ol>
    </main>
    </TextMotion>
  );
}
