"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { dayHref, days, promptDayFor, type CodevemberDay } from "../days";
import type { QualityChoice } from "../engine/quality";
import type { SettingsStore } from "../engine/settings";
import type { QualityTier, Setting } from "../engine/types";
import { resetPrompt, usePromptDone } from "../engine/prompt";
import { sound, useSoundMuted } from "../engine/sound";

const pad = (day: number) => String(day).padStart(2, "0");

function DayRuler({ current }: { current: CodevemberDay }) {
  const [promptDay, setPromptDay] = useState<number | undefined>();
  const strip = useRef<HTMLDivElement>(null);
  const active = useRef<HTMLAnchorElement>(null);

  useEffect(() => setPromptDay(promptDayFor(new Date())), []);

  // On a phone the ruler scrolls; keep the current day in view.
  useEffect(() => {
    const element = active.current;
    const container = strip.current;
    if (!element || !container || container.scrollWidth <= container.clientWidth) return;
    container.scrollTo({ left: element.offsetLeft - container.clientWidth / 2, behavior: "smooth" });
  }, [current]);

  return (
    <nav className="cv-ruler" ref={strip} aria-label="Codevember days">
      {days.map((day) => {
        const isCurrent = day.day === current.day;
        const classes = [
          "cv-tick",
          isCurrent ? "cv-tick-current" : "",
          day.day === promptDay ? "cv-tick-today" : "",
          day.live ? "cv-tick-open" : "cv-tick-closed"
        ].join(" ");
        const body = (
          <>
            <span className="cv-tick-mark" />
            <span className="cv-tick-label">
              <em>{pad(day.day)}</em> {day.word}
            </span>
          </>
        );
        return day.live ? (
          <Link
            key={day.day}
            href={dayHref(day)}
            prefetch={false}
            className={classes}
            ref={isCurrent ? active : undefined}
            aria-current={isCurrent ? "page" : undefined}
            aria-label={`Day ${day.day}: ${day.word}`}
          >
            {body}
          </Link>
        ) : (
          <span key={day.day} className={classes} aria-label={`Day ${day.day}: ${day.word}, not out yet`}>
            {body}
          </span>
        );
      })}
    </nav>
  );
}

const KEY_CAPS = [
  { code: "KeyW", label: "W", area: "w" },
  { code: "KeyA", label: "A", area: "a" },
  { code: "KeyS", label: "S", area: "s" },
  { code: "KeyD", label: "D", area: "d" }
];

// The keys that fly the camera.
function FlyKeys() {
  return (
    <div className="cv-keys" role="img" aria-label="Use W, A, S and D to fly">
      {KEY_CAPS.map((key) => (
        <kbd key={key.code} style={{ gridArea: key.area }}>
          {key.label}
        </kbd>
      ))}
    </div>
  );
}

function Control({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const value = useSyncExternalStore(store.subscribe, () => store.get(name));

  if (setting.type === "action") {
    return (
      <button type="button" className="cv-action" onClick={() => store.trigger(name)}>
        {setting.label}
      </button>
    );
  }

  if (setting.type === "toggle") {
    return (
      <label className="cv-control cv-control-row">
        <span>{setting.label}</span>
        <input type="checkbox" checked={value as boolean} onChange={(event) => store.set(name, event.target.checked)} />
      </label>
    );
  }

  if (setting.type === "choice") {
    return (
      <div className="cv-control">
        <span className="cv-control-label">{setting.label}</span>
        <div className="cv-choices" role="radiogroup" aria-label={setting.label}>
          {setting.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={value === option.value}
              className={`cv-choice ${value === option.value ? "cv-choice-on" : ""}`}
              onClick={() => store.set(name, option.value)}
            >
              {option.swatch ? (
                <span className="cv-swatch" aria-hidden="true">
                  {option.swatch.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
              ) : null}
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const number = value as number;
  const fill = ((number - setting.min) / (setting.max - setting.min)) * 100;
  return (
    <label className="cv-control">
      <span className="cv-control-label">
        {setting.label}
        <output>{setting.step && setting.step >= 1 ? number : number.toFixed(2)}</output>
      </span>
      <input
        type="range"
        className="cv-range"
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        min={setting.min}
        max={setting.max}
        step={setting.step ?? 0.01}
        value={number}
        onChange={(event) => store.set(name, Number(event.target.value))}
      />
    </label>
  );
}

const CHOICES: { value: QualityChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "high", label: "High" },
  { value: "medium", label: "Med" },
  { value: "low", label: "Low" }
];

type HudProps = {
  day: CodevemberDay;
  hint?: string;
  prompt?: { title: string; detail?: string };
  notes?: string;
  settings: SettingsStore | null;
  tier: QualityTier;
  choice: QualityChoice;
  onChoice: (choice: QualityChoice) => void;
  isWebGPU: boolean;
  fpsRef: RefObject<HTMLElement | null>;
};

export function Hud({ day, hint, prompt, notes, settings, tier, choice, onChoice, isWebGPU, fpsRef }: HudProps) {
  const router = useRouter();
  const [panelOpen, setPanelOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [touched, setTouched] = useState(false);
  const [isTouch, setIsTouch] = useState(false);

  const reachable = useMemo(() => days.filter((day) => day.live), []);
  const position = reachable.findIndex((item) => item.day === day.day);
  const previous = position > 0 ? reachable[position - 1] : null;
  const next = position >= 0 && position < reachable.length - 1 ? reachable[position + 1] : null;

  useEffect(() => {
    setIsTouch(window.matchMedia("(pointer: coarse)").matches);
    // Roomy screens open with the settings showing, so people find them.
    setPanelOpen(window.innerWidth >= 1100);
    const dismiss = () => setTouched(true);
    window.addEventListener("pointerdown", dismiss, { once: true, capture: true });
    return () => window.removeEventListener("pointerdown", dismiss, { capture: true });
  }, []);

  useEffect(() => setTouched(false), [day]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      if (event.key === "h" || event.key === "H") setHidden((value) => !value);
      if (event.key === "[" && previous) router.push(dayHref(previous));
      if (event.key === "]" && next) router.push(dayHref(next));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, previous, router]);

  const muted = useSoundMuted();
  const promptDone = usePromptDone();
  useEffect(() => resetPrompt(), [day.day]);
  const hasControls = settings && Object.keys(settings.schema).length > 0;

  return (
    <div className={`cv-hud ${hidden ? "cv-hud-hidden" : ""}`}>
      <header className="cv-bar">
        <Link className="cv-pill cv-calendar-pill" href="/" prefetch={false}>
          Codevember calendar
        </Link>
        {notes ? <p className="cv-notes">{notes}</p> : null}
        <div className="cv-bar-actions">
        <button type="button" className="cv-pill" aria-pressed={!muted} onClick={() => sound.setMuted(!muted)}>
          {muted ? "Sound off" : "Sound on"}
        </button>
        <button
          type="button"
          className="cv-pill cv-panel-pill"
          aria-expanded={panelOpen}
          aria-controls="cv-panel"
          onClick={() => setPanelOpen((open) => !open)}
        >
          {panelOpen ? "Close" : "Tune"}
        </button>
        </div>
      </header>

      <div className="cv-title" key={day.day}>
        <p className="cv-title-day">Day {pad(day.day)}</p>
        <div className="cv-title-row">
          <h1>{day.word}</h1>
          {isTouch ? null : <FlyKeys />}
        </div>
        <p className={`cv-hint ${touched ? "cv-hint-gone" : ""}`}>
          {hint ? <strong>{hint} </strong> : null}
          <span className="cv-hint-controls">
            {isTouch ? "Drag to look, pinch to zoom." : "Drag to orbit, WASD to fly, scroll to zoom."}
          </span>
        </p>
      </div>

      <aside id="cv-panel" className={`cv-panel ${panelOpen ? "cv-panel-open" : ""}`}>
        <button
          type="button"
          className="cv-panel-head"
          aria-expanded={panelOpen}
          aria-controls="cv-panel-body"
          onClick={() => setPanelOpen((open) => !open)}
        >
          Controls
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div id="cv-panel-body" className="cv-panel-body" inert={!panelOpen}>
          <div className="cv-panel-inner">
            <div className="cv-panel-scroll">
              {hasControls
                ? Object.entries(settings.schema).map(([name, setting]) => (
                    <Control key={`${day.day}-${name}`} name={name} setting={setting} store={settings} />
                  ))
                : null}
              {hasControls ? (
                <button type="button" className="cv-reset" onClick={() => settings.reset()}>
                  Reset
                </button>
              ) : null}
            </div>
            <footer className="cv-panel-foot">
              <div className="cv-choices cv-quality" role="radiogroup" aria-label="Render quality">
                {CHOICES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={choice === option.value}
                    className={`cv-choice ${choice === option.value ? "cv-choice-on" : ""}`}
                    onClick={() => onChoice(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="cv-stats">
                {isWebGPU ? "WebGPU" : "WebGL fallback"} · {isWebGPU ? tier : "low"} · <span ref={fpsRef as RefObject<HTMLSpanElement>}>…</span>
              </p>
            </footer>
          </div>
        </div>
      </aside>

      {prompt ? (
        <div className={`cv-prompt ${promptDone ? "cv-prompt-gone" : ""}`} aria-hidden={promptDone}>
          <i aria-hidden="true" />
          <p>{prompt.title}</p>
          {prompt.detail ? <small>{prompt.detail}</small> : null}
        </div>
      ) : null}

      <p className="cv-credit">
        Built with{" "}
        <a href="https://r3f.docs.pmnd.rs/" target="_blank" rel="noreferrer">
          React Three Fiber
        </a>{" "}
        +{" "}
        <a href="https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide#webgpu" target="_blank" rel="noreferrer">
          WebGPU
        </a>
      </p>

      <footer className="cv-foot">
        {previous ? (
          <Link className="cv-step" href={dayHref(previous)} prefetch={false} aria-label={`Previous: ${previous.word}`}>
            ←
          </Link>
        ) : (
          <span className="cv-step cv-step-off" aria-hidden="true">
            ←
          </span>
        )}
        <DayRuler current={day} />
        {next ? (
          <Link className="cv-step" href={dayHref(next)} prefetch={false} aria-label={`Next: ${next.word}`}>
            →
          </Link>
        ) : (
          <span className="cv-step cv-step-off" aria-hidden="true">
            →
          </span>
        )}
      </footer>
    </div>
  );
}
