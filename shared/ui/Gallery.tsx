"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { dayHref, days, daySlug, promptDayFor } from "../days";

const pad = (day: number) => String(day).padStart(2, "0");

export function Gallery() {
  const [promptDay, setPromptDay] = useState<number | undefined>();
  useEffect(() => setPromptDay(promptDayFor(new Date())), []);

  return (
    <main className="cv-gallery">
      <header className="cv-gallery-head">
        <h1>Codevember</h1>
        <p>
          One word, one real-time 3D experience, every day of November 2026. WebGPU, shaders, light you can
          grab.
        </p>
      </header>

      <ol className="cv-grid">
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
            <li key={day.day}>
              {open ? (
                <Link className={classes} href={dayHref(day)} prefetch={false}>
                  {body}
                </Link>
              ) : (
                <div className={classes}>{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
