"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type RefObject } from "react";
import { dayHref, days, promptDayFor, type CodevemberDay } from "../days";
import type { QualityChoice } from "../engine/quality";
import type { SettingsStore } from "../engine/settings";
import type { OverviewSection, QualityTier, Setting } from "../engine/types";
import { resetPrompt, usePromptDone } from "../engine/prompt";
import { GithubIcon, REPO } from "./github";
import { sound, useSoundOn } from "../engine/sound";
import { SETTLE, TextMotion, fade, inTurn, rise, riseBig } from "./motion";
import { Overview } from "./Overview";

const pad = (day: number) => String(day).padStart(2, "0");

// A word on a button that changes: the new one comes up as the old one goes.
function Swap({ text }: { text: string }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span key={text} style={{ display: "inline-block" }} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5 }} transition={{ duration: 0.14 }}>
        {text}
      </motion.span>
    </AnimatePresence>
  );
}

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
        <input className="cv-switch" type="checkbox" role="switch" checked={value as boolean} onChange={(event) => store.set(name, event.target.checked)} />
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
              onClick={() => store.set(name, value === option.value && setting.pressAgain ? setting.pressAgain : option.value)}
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

function PhonePill({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const value = useSyncExternalStore(store.subscribe, () => store.get(name));
  if (setting.type === "action") {
    return (
      <button type="button" className="cv-pill" onClick={() => store.trigger(name)}>
        {setting.label}
      </button>
    );
  }
  if (setting.type !== "choice") return null;
  return (
    <>
      {setting.options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`cv-pill ${value === option.value ? "cv-pill-on" : ""}`}
          aria-pressed={value === option.value}
          onClick={() => store.set(name, option.value)}
        >
          {option.label}
        </button>
      ))}
    </>
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
  overview?: OverviewSection[];
  Overlay?: ComponentType;
  settings: SettingsStore | null;
  phonePills?: string[];
  tier: QualityTier;
  choice: QualityChoice;
  onChoice: (choice: QualityChoice) => void;
  isWebGPU: boolean;
  fpsRef: RefObject<HTMLElement | null>;
};

function ControlRow({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const chosen = useSyncExternalStore(store.subscribe, () => (setting.when ? store.get(setting.when.setting) : null), () => null);
  if (setting.when && chosen !== setting.when.is) return null;
  return (
    <motion.div className="cv-panel-row" variants={rise}>
      <Control name={name} setting={setting} store={store} />
    </motion.div>
  );
}

export function Hud({ day, hint, prompt, notes, overview, Overlay, settings, phonePills, tier, choice, onChoice, isWebGPU, fpsRef }: HudProps) {
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

  const soundOn = useSoundOn();
  const promptDone = usePromptDone();
  useEffect(() => resetPrompt(), [day.day]);
  const hasControls = settings && Object.keys(settings.schema).length > 0;

  return (
    <TextMotion>
    <div className={`cv-hud ${hidden ? "cv-hud-hidden" : ""}`}>
      <header className="cv-bar">
        <Link className="cv-pill cv-calendar-pill" href="/" prefetch={false}>
          Codevember Calendar
        </Link>
        {notes || overview ? (
          <div className="cv-about" key={`about-${day.day}`}>
            {notes ? (
              <motion.p className="cv-notes" variants={rise} initial="hidden" animate="show" transition={{ delay: 0.5 }}>
                {notes}
              </motion.p>
            ) : null}
            {overview ? <Overview sections={overview} /> : null}
          </div>
        ) : null}
        <div className="cv-bar-actions">
        <a className="cv-pill cv-round" href={REPO} target="_blank" rel="noreferrer" aria-label="The code on GitHub">
          <GithubIcon />
        </a>
        <a className="cv-pill cv-round" href="https://x.com/ajc_builds" target="_blank" rel="noreferrer" aria-label="Adam on X">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
        </a>
        <a className="cv-pill cv-round" href="https://www.linkedin.com/in/adamchernick/" target="_blank" rel="noreferrer" aria-label="Adam on LinkedIn">
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path fill="currentColor" d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.36V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45z" />
          </svg>
        </a>
        <button type="button" className="cv-pill" aria-pressed={soundOn} onClick={() => sound.toggle()}>
          <Swap text={soundOn ? "Sound on" : "Sound off"} />
        </button>
        <button
          type="button"
          className="cv-pill cv-panel-pill"
          aria-expanded={panelOpen}
          aria-controls="cv-panel"
          onClick={() => setPanelOpen((open) => !open)}
        >
          <Swap text={panelOpen ? "Close" : "Tune"} />
        </button>
        </div>
      </header>

      {Overlay ? <Overlay key={`overlay-${day.day}`} /> : null}

      <div className="cv-title" key={day.day}>
        <motion.div variants={inTurn(0.09, 0.12)} initial="hidden" animate="show">
          <motion.p className="cv-title-day" variants={rise}>
            Day {pad(day.day)}
          </motion.p>
          <div className="cv-title-row">
            <motion.h1 variants={riseBig}>{day.word}</motion.h1>
            {isTouch ? null : (
              <motion.div variants={fade}>
                <FlyKeys />
              </motion.div>
            )}
          </div>
          <motion.div variants={rise}>
            {/* The title stands on this, so as it closes the title comes down to the bottom corner. */}
            <motion.div className="cv-hint-room" initial={false} animate={{ height: touched ? 0 : "auto", opacity: touched ? 0 : 1 }} transition={SETTLE}>
              <p className="cv-hint">
                {hint ? <strong>{hint} </strong> : null}
                <span className="cv-hint-controls">{isTouch ? "Drag to look, pinch to zoom." : "Drag to orbit, WASD to fly, scroll to zoom."}</span>
              </p>
            </motion.div>
          </motion.div>
        </motion.div>
      </div>

      {settings && phonePills ? (
        <div className={`cv-phone-pills ${panelOpen ? "cv-phone-pills-hidden" : ""}`} key={`pills-${day.day}`}>
          {phonePills.map((name) => (settings.schema[name] ? <PhonePill key={name} name={name} setting={settings.schema[name]} store={settings} /> : null))}
        </div>
      ) : null}

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
            <motion.div className="cv-panel-scroll" key={`controls-${day.day}`} variants={inTurn(0.035, 0.1)} initial="hidden" animate={panelOpen ? "show" : "hidden"}>
              {hasControls
                ? Object.entries(settings.schema).map(([name, setting]) => <ControlRow key={name} name={name} setting={setting} store={settings} />)
                : null}
              {hasControls ? (
                <motion.div className="cv-panel-row" variants={rise}>
                  <button type="button" className="cv-reset" onClick={() => settings.reset()}>
                    Reset
                  </button>
                </motion.div>
              ) : null}
            </motion.div>
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

      <AnimatePresence>
        {prompt && !promptDone ? (
          <motion.div className="cv-prompt" key={`prompt-${day.day}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10, scale: 0.97 }} transition={SETTLE}>
            <i aria-hidden="true" />
            <p>{prompt.title}</p>
            {prompt.detail ? <small>{prompt.detail}</small> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <motion.p className="cv-credit" variants={fade} initial="hidden" animate="show">
        Built with{" "}
        <a href="https://r3f.docs.pmnd.rs/" target="_blank" rel="noreferrer">
          React Three Fiber
        </a>{" "}
        +{" "}
        <a href="https://r3f.docs.pmnd.rs/tutorials/v9-migration-guide#webgpu" target="_blank" rel="noreferrer">
          WebGPU
        </a>
      </motion.p>

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
    </TextMotion>
  );
}
