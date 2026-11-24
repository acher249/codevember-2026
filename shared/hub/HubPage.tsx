"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { days, daySlug, promptDayFor } from "@/shared/days";
import { GithubIcon, REPO } from "@/shared/ui/github";
import { LINKEDIN_URL, LinkedInIcon, X_URL, XIcon } from "@/shared/ui/social";
import { requestView } from "./hub/state";
import { setPrefaceUp, usePreface } from "./preface";
import { returnState } from "./returning";

// How far along the bar is at each step of the stage's load, and what it says, as the day loader has it (ui/Loader.tsx).
const STEPS = {
  swap: { to: 0, seconds: 0, label: "Loading" },
  engine: { to: 0.3, seconds: 6, label: "Starting the renderer" },
  scene: { to: 0.55, seconds: 5, label: "Loading the scene" },
  shaders: { to: 0.94, seconds: 14, label: "Compiling shaders" },
  done: { to: 1, seconds: 0.3, label: "Ready" }
} as const;

// The widest the page goes (hub/layout.ts).
const GALLERY = 1100;

// How long the page takes to fade once the stage takes over (hub.css, .cv-pre-gone).
const FADE = 260;

// The calendar page as plain HTML, there from the first paint, served with the page itself, while the stage builds the 3D
// calendar behind it: the same page, laid out by the rules the stage lays its own out by (hub/layout.ts), so that when the
// 3D is ready and asked for, the stage's copy, waiting underneath at the same scroll, takes over and the move into the
// calendar starts from it. Until then the way into 3D waits, with the stage's progress over it; the days open at once.
// `hubPosters`: the days with a poster of the hub's own (hub/pictures.ts), the same picture the stage draws, and so one
// download for both; the rest have the calendar's.
export function HubPage({ hubPosters }: { hubPosters: string[] }) {
  const preface = usePreface();
  // Coming back from a day by the calendar button, the day's last frame covers the hub coming up: no page then.
  const [gone, setGone] = useState(() => typeof window !== "undefined" && returnState().phase === "crossing");
  const [leaving, setLeaving] = useState(false);
  const [armed, setArmed] = useState(false);
  const [today, setToday] = useState<number | undefined>();
  const [left, setLeft] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const blurb = useRef<HTMLParagraphElement>(null);
  const [fit, setFit] = useState<{ wide: boolean; scale: number; room: number; columns: number; column: number; row: number } | null>(null);

  useEffect(() => {
    if (gone) return;
    setPrefaceUp(true);
    return () => setPrefaceUp(false);
  }, [gone]);

  // The date is the visitor's, not the build's.
  useEffect(() => {
    const now = new Date();
    const day = promptDayFor(now);
    setToday(day);
    const reached = day ?? (now < new Date(2026, 10, 1) ? 0 : days.length);
    setLeft(Math.max(0, days.length - reached));
    // One frame at zero first, for the bar's first step to have something to move from.
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // The cards on whole pixels, and where the buttons go, as hub/layout.ts decides them: the buttons beside the words under
  // the title where there is room for both, and otherwise on a row of their own, made smaller to fit. Measured once the
  // page's fonts are in; the stylesheet's guess stands until then.
  useEffect(() => {
    const measure = () => {
      const row = actions.current;
      const words = blurb.current;
      const natural = (row?.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0;
      if (!words || !natural) return;
      const width = window.innerWidth;
      const content = Math.min(width, GALLERY) - 40;
      const least = Math.min(width >= GALLERY ? 124 : 150, width * 0.44);
      const columns = Math.max(1, Math.floor((content + 8) / (least + 8)));
      const column = Math.round((content - (columns - 1) * 8) / columns);
      setFit({
        wide: words.offsetWidth + 32 + natural <= content,
        scale: Math.min(1, content / natural),
        // Clear of the plate the cards stand on once they are tiles: a fifth of a card and a little more.
        room: 0.22 * column + 12,
        columns,
        column,
        row: Math.round(column * 1.25)
      });
    };
    measure();
    void document.fonts?.ready.then(measure);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const ready = preface.step === "done" && !preface.failed;
  const step = STEPS[preface.step];

  const explore = () => {
    if (!ready || leaving) return;
    // The stage's page, under this one, to the same place on the page, then the move.
    const box = document.querySelector<HTMLElement>(".cv-page-scroll");
    if (box && scroller.current) box.scrollTop = scroller.current.scrollTop;
    setLeaving(true);
    setPrefaceUp(false);
    requestAnimationFrame(() => requestAnimationFrame(() => requestView("3d")));
    window.setTimeout(() => setGone(true), FADE + 40);
  };

  if (gone) return null;

  const layout = fit ? ` cv-pre-fitted ${fit.wide ? "cv-pre-wide" : "cv-pre-narrow"}` : "";
  return (
    <div className={`cv-pre${layout}${leaving ? " cv-pre-gone" : ""}`} style={fit ? ({ "--fit": fit.scale, "--room": `${fit.room}px`, "--columns": fit.columns, "--column": `${fit.column}px`, "--row": `${fit.row}px` } as CSSProperties) : undefined}>
      <div className="cv-pre-scroll" ref={scroller}>
        <main className="cv-pre-page">
          <header className="cv-pre-head">
            <h1>Codevember</h1>
            <p ref={blurb}>One word, one real-time 3D experience, every day of November 2026. WebGPU, shaders, light you can grab.</p>
          </header>
          <div className="cv-pre-actions" ref={actions}>
            <div className="cv-pre-buttons">
              <a className="cv-pre-round" href={X_URL} target="_blank" rel="noreferrer" aria-label="X">
                <XIcon size={18} />
              </a>
              <a className="cv-pre-round" href={REPO} target="_blank" rel="noreferrer" aria-label="Github">
                <GithubIcon size={20} />
              </a>
              <a className="cv-pre-round" href={LINKEDIN_URL} target="_blank" rel="noreferrer" aria-label="LinkedIn">
                <LinkedInIcon size={18} />
              </a>
              <div className="cv-pre-go-wrap">
                <div className={`cv-pre-progress${ready || preface.failed ? " cv-pre-progress-done" : ""}`} aria-hidden={ready}>
                  <p>
                    <i className="cv-spinner" aria-hidden="true" />
                    <span key={step.label}>{step.label}</span>
                  </p>
                  <div className="cv-pre-track" role="progressbar" aria-label={step.label}>
                    <span style={{ transform: `scaleX(${armed ? step.to : 0})`, transitionDuration: `${step.seconds}s` }} />
                  </div>
                </div>
                <button type="button" className="cv-space-go cv-pre-go" disabled={!ready} onClick={explore} title={preface.failed ? "3D could not start on this device" : undefined}>
                  <span className="cv-pre-go-label">
                    Explore projects in <b>3D</b>
                  </span>
                  <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          </div>
          <ol className="cv-pre-grid">
            {days.map((day) => {
              const open = day.live;
              const body = (
                <>
                  {day.live ? (
                    <>
                      {/* A plain img: this page must not wait on the image optimiser. */}
                      <img className="cv-page-html-poster" src={hubPosters.includes(daySlug(day)) ? `/hub/${daySlug(day)}.jpg` : `/${daySlug(day)}.jpg`} alt="" loading={day.day <= 16 ? "eager" : "lazy"} decoding="async" />
                      <i className="cv-page-html-shade" />
                    </>
                  ) : null}
                  <span className="cv-pre-number">{String(day.day).padStart(2, "0")}</span>
                  <span className="cv-pre-word">{day.word}</span>
                  {day.day === today ? <span className="cv-pre-today">Today</span> : null}
                </>
              );
              const classes = `cv-page-html-card cv-pre-card${open ? " cv-open" : ""}${day.day === today ? " cv-today" : ""}`;
              return (
                <li key={day.day}>
                  {open ? (
                    <Link className={classes} href={`/${daySlug(day)}/`} prefetch={false}>
                      {body}
                    </Link>
                  ) : (
                    <div className={classes}>{body}</div>
                  )}
                </li>
              );
            })}
            {left !== null ? (
              <li className="cv-pre-left" aria-label={left > 0 ? `${left} days left` : "That's a wrap"}>
                {left > 0 ? <b>{left}</b> : null}
                <span>{left > 1 ? "Days left" : left === 1 ? "Day left" : "That's a wrap"}</span>
              </li>
            ) : null}
          </ol>
        </main>
      </div>
    </div>
  );
}
