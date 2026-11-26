"use client";

import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type RefObject } from "react";
import { dayHref, days, promptDayFor, type CodevemberDay } from "../days";
import { narrowScreen, type QualityChoice } from "../engine/quality";
import type { SettingsStore } from "../engine/settings";
import type { ColourSetting, OverviewSection, QualityTier, Setting } from "../engine/types";
import { resetPrompt, usePromptDone } from "../engine/prompt";
import { GithubIcon, REPO } from "./github";
import { FollowCard } from "./Follow";
import { ShareButton } from "./Share";
import { LINKEDIN_URL, LinkedInIcon, X_URL, XIcon } from "./social";
import { track } from "../engine/track";
import { sound, useSoundOn } from "../engine/sound";
import { SETTLE, TextMotion, fade, inTurn, rise, riseBig } from "./motion";
import { FrameGraph } from "./FrameGraph";
import { Overview } from "./Overview";

const pad = (day: number) => String(day).padStart(2, "0");

// The colour pad: hue across, and down from white through the pure hue to black. That is HSL at full saturation, which
// is exactly what the two CSS gradients over a rainbow draw, so the colour under the pointer is the one picked.
const PALE = 0.97;
const DARK = 0.06;
const hslHex = (h: number, l: number) => {
  const a = Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
};
const hexHsl = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  const l = (hi + lo) / 2;
  const d = hi - lo;
  let h = 0;
  if (d > 0) h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, l };
};

function ColourControl({ name, setting, store, value }: { name: string; setting: ColourSetting; store: SettingsStore; value: string }) {
  const area = useRef<HTMLDivElement>(null);
  const ticked = useRef(0);
  const { h, l } = hexHsl(value);
  const set = (hue: number, light: number) => {
    store.set(name, hslHex(((hue % 360) + 360) % 360, Math.min(PALE, Math.max(DARK, light))));
    const now = performance.now();
    if (now - ticked.current > 70) {
      sound.play("click", { gain: 0.22, pitch: 1.1 + Math.random() * 0.3 });
      ticked.current = now;
    }
  };
  const pick = (event: React.PointerEvent) => {
    const box = area.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
    set(x * 359.9, PALE - y * (PALE - DARK));
  };
  return (
    <div className="cv-control">
      <span className="cv-control-label">
        {setting.label}
        <output>{value.toUpperCase()}</output>
      </span>
      <div
        ref={area}
        className="cv-colour-pad"
        role="slider"
        tabIndex={0}
        aria-label={setting.label}
        aria-valuetext={value}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pick(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
        }}
        onKeyDown={(event) => {
          const move: Record<string, [number, number]> = { ArrowLeft: [-6, 0], ArrowRight: [6, 0], ArrowUp: [0, 0.04], ArrowDown: [0, -0.04] };
          const m = move[event.key];
          if (!m) return;
          event.preventDefault();
          set(h + m[0], l + m[1]);
        }}
      >
        <i className="cv-colour-thumb" style={{ left: `${(h / 360) * 100}%`, top: `${((PALE - Math.min(PALE, Math.max(DARK, l))) / (PALE - DARK)) * 100}%`, background: value }} />
      </div>
      {setting.presets ? (
        <div className="cv-colour-presets">
          {setting.presets.map((preset) => (
            <button
              key={preset.colour}
              type="button"
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={preset.colour.toLowerCase() === value.toLowerCase()}
              className={`cv-colour-chip ${preset.colour.toLowerCase() === value.toLowerCase() ? "cv-colour-chip-on" : ""}`}
              style={{ background: preset.colour }}
              onClick={() => {
                store.set(name, preset.colour);
                sound.play("click", { gain: 0.4 });
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
  // A slider ticks like Caustic's compass as it moves: a click for every notch that passes, a whole step on a stepped
  // slider and a twentieth of the way on a smooth one, and never more than one every 30 ms.
  const ratchet = useRef({ notch: NaN, at: 0 });

  if (setting.type === "action") {
    const busy = !!setting.busyLabel && value === true;
    return (
      <button type="button" className="cv-action" disabled={busy} aria-busy={busy} onClick={() => store.trigger(name)}>
        {busy ? (
          <>
            <i className="cv-spinner" aria-hidden="true" />
            {setting.busyLabel}
          </>
        ) : (
          setting.label
        )}
      </button>
    );
  }

  if (setting.type === "toggle" && setting.sides) {
    // Two named states either side of the switch, the chosen one lit.
    const on = value as boolean;
    return (
      <label className="cv-control cv-control-sides" aria-label={setting.label}>
        <span className={on ? "" : "cv-side-on"}>{setting.sides[0]}</span>
        <input className="cv-switch" type="checkbox" role="switch" checked={on} onChange={(event) => store.set(name, event.target.checked)} />
        <span className={on ? "cv-side-on" : ""}>{setting.sides[1]}</span>
      </label>
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

  if (setting.type === "colour") return <ColourControl name={name} setting={setting} store={store} value={value as string} />;

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

  const max = setting.phoneMax !== undefined && narrowScreen() ? setting.phoneMax : setting.max;
  const number = Math.min(value as number, max);
  const fill = ((number - setting.min) / (max - setting.min)) * 100;
  return (
    <label className="cv-control">
      <span className="cv-control-label">
        {setting.label}
        <span className="cv-control-value">
          {setting.reset !== undefined && Math.abs(number - setting.reset) > 1e-6 ? (
            <button
              type="button"
              className="cv-reset-value"
              onClick={(event) => {
                event.preventDefault();
                store.set(name, setting.reset!);
                sound.play("click", { gain: 0.4 });
              }}
            >
              Reset
            </button>
          ) : null}
          <output>{setting.step && setting.step >= 1 ? number : number.toFixed(2)}</output>
        </span>
      </span>
      <input
        type="range"
        className="cv-range"
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        min={setting.min}
        max={max}
        step={setting.step ?? 0.01}
        value={number}
        onChange={(event) => {
          const next = Number(event.target.value);
          const span = setting.step && setting.step >= 1 ? setting.step : (max - setting.min) / 20;
          const notch = Math.round((next - setting.min) / span);
          const now = performance.now();
          const last = Number.isNaN(ratchet.current.notch) ? Math.round((number - setting.min) / span) : ratchet.current.notch;
          if (notch !== last && now - ratchet.current.at > 30) {
            sound.play("click", { gain: 0.38, pitch: 0.9 + Math.random() * 0.25 });
            ratchet.current.at = now;
          }
          ratchet.current.notch = notch;
          store.set(name, next);
        }}
      />
    </label>
  );
}

// A pause icon: two white bars.
const PAUSE_ICON = (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
  </svg>
);

function PhonePill({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const value = useSyncExternalStore(store.subscribe, () => store.get(name));
  const showWhile = setting.type === "toggle" ? setting.showWhile : undefined;
  const allowed = useSyncExternalStore(store.subscribe, () => (showWhile ? store.get(showWhile) !== false : true));
  if (setting.type === "toggle" && setting.icon) {
    const gone = (value as boolean) || !allowed;
    return (
      <button
        type="button"
        className={`cv-pill cv-pill-icon ${gone ? "cv-pill-gone" : ""}`}
        aria-label={setting.label}
        aria-hidden={gone}
        tabIndex={gone ? -1 : 0}
        onClick={() => store.set(name, true)}
      >
        {PAUSE_ICON}
      </button>
    );
  }
  if (setting.type === "action") {
    const busy = !!setting.busyLabel && value === true;
    return (
      <button type="button" className="cv-pill cv-pill-busy-able" disabled={busy} aria-busy={busy} onClick={() => store.trigger(name)}>
        {busy ? (
          <>
            <i className="cv-spinner" aria-hidden="true" />
            {setting.busyLabel}
          </>
        ) : (
          setting.label
        )}
      </button>
    );
  }
  if (setting.type === "toggle") {
    // On a phone a pair of pills, one for each side; or one pill that lights while it is on.
    const on = value as boolean;
    if (setting.sides)
      return (
        <>
          {setting.sides.map((label, i) => (
            <button key={label} type="button" className={`cv-pill ${on === (i === 1) ? "cv-pill-on" : ""}`} aria-pressed={on === (i === 1)} onClick={() => store.set(name, i === 1)}>
              {label}
            </button>
          ))}
        </>
      );
    return (
      <button type="button" className={`cv-pill ${on ? "cv-pill-on" : ""}`} aria-pressed={on} onClick={() => store.set(name, !on)}>
        {setting.label}
      </button>
    );
  }
  if (setting.type === "colour")
    return (
      <>
        {setting.presets?.map((preset) => (
          <button
            key={preset.colour}
            type="button"
            className={`cv-pill ${preset.colour.toLowerCase() === String(value).toLowerCase() ? "cv-pill-on" : ""}`}
            aria-pressed={preset.colour.toLowerCase() === String(value).toLowerCase()}
            onClick={() => store.set(name, preset.colour)}
          >
            <span className="cv-swatch" aria-hidden="true">
              <i style={{ background: preset.colour }} />
            </span>
            {preset.label}
          </button>
        ))}
      </>
    );
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

// Whether a setting is shown, by its `when`.
function useShown(setting: Setting, store: SettingsStore) {
  const chosen = useSyncExternalStore(store.subscribe, () => (setting.when ? store.get(setting.when.setting) : null), () => null);
  return !setting.when || ("is" in setting.when ? chosen === setting.when.is : chosen !== setting.when.not);
}

function DockRow({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const value = useSyncExternalStore(store.subscribe, () => store.get(name));
  if (!useShown(setting, store)) return null;
  if (setting.type === "choice")
    return (
      <div className="cv-dock-row cv-dock-choices" role="radiogroup" aria-label={setting.label}>
        {setting.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className={`cv-dock-chip ${value === option.value ? "cv-dock-chip-on" : ""}`}
            onClick={() => store.set(name, option.value)}
          >
            {option.short ?? option.label}
          </button>
        ))}
      </div>
    );
  return (
    <div className="cv-dock-row">
      <Control name={name} setting={{ ...setting, label: setting.short ?? setting.label } as Setting} store={store} />
    </div>
  );
}

// A phone's dock: the day's main settings along the bottom, sliders that sit next to each other paired in a row.
function PhoneDock({ names, pills, store, hidden }: { names: string[]; pills?: string[]; store: SettingsStore; hidden: boolean }) {
  const groups: string[][] = [];
  for (const name of names) {
    const setting = store.schema[name];
    if (!setting) continue;
    const last = groups[groups.length - 1];
    if (setting.type === "range" && last && store.schema[last[0]].type === "range") last.push(name);
    else groups.push([name]);
  }
  return (
    <div className={`cv-dock ${hidden ? "cv-dock-hidden" : ""}`}>
      {pills ? (
        <div className="cv-dock-pills">
          {pills.map((name) => (store.schema[name] ? <PhonePill key={name} name={name} setting={store.schema[name]} store={store} /> : null))}
        </div>
      ) : null}
      {groups.map((group) =>
        group.length > 1 ? (
          <div className="cv-dock-pair" key={group.join()}>
            {group.map((name) => (
              <DockRow key={name} name={name} setting={store.schema[name]} store={store} />
            ))}
          </div>
        ) : (
          <DockRow key={group[0]} name={group[0]} setting={store.schema[group[0]]} store={store} />
        )
      )}
    </div>
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
  prompt?: { title: string; detail?: string; high?: boolean; low?: boolean; phoneUp?: number; phoneAside?: boolean };
  notes?: string;
  overview?: OverviewSection[];
  Overlay?: ComponentType;
  settings: SettingsStore | null;
  phonePills?: string[];
  phoneDock?: string[];
  phoneDockPills?: string[];
  tier: QualityTier;
  choice: QualityChoice;
  onChoice: (choice: QualityChoice) => void;
  isWebGPU: boolean;
  fpsRef: RefObject<HTMLElement | null>;
};

function ControlRow({ name, setting, store }: { name: string; setting: Setting; store: SettingsStore }) {
  const chosen = useSyncExternalStore(store.subscribe, () => (setting.when ? store.get(setting.when.setting) : null), () => null);
  // An icon setting is its own button, beside the panel or on the dock, not a row in it.
  if (setting.hidden || (setting.type === "toggle" && setting.icon)) return null;
  if (setting.when && ("is" in setting.when ? chosen !== setting.when.is : chosen === setting.when.not)) return null;
  return (
    <motion.div className="cv-panel-row" variants={rise}>
      <Control name={name} setting={setting} store={store} />
    </motion.div>
  );
}

export function Hud({ day, hint, prompt, notes, overview, Overlay, settings, phonePills, phoneDock, phoneDockPills, tier, choice, onChoice, isWebGPU, fpsRef }: HudProps) {
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
        <a className="cv-pill cv-round" href={REPO} target="_blank" rel="noreferrer" aria-label="The code on GitHub" onClick={() => track("bar-github")}>
          <GithubIcon />
        </a>
        <a className="cv-pill cv-round" href={X_URL} target="_blank" rel="noreferrer" aria-label="Adam on X" onClick={() => track("bar-x")}>
          <XIcon />
        </a>
        <a className="cv-pill cv-round" href={LINKEDIN_URL} target="_blank" rel="noreferrer" aria-label="Adam on LinkedIn" onClick={() => track("bar-linkedin")}>
          <LinkedInIcon />
        </a>
        <ShareButton day={day} />
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

      {settings ? (
        <div className="cv-desk-icons" key={`icons-${day.day}`}>
          {Object.entries(settings.schema).map(([name, setting]) =>
            setting.type === "toggle" && setting.icon ? <PhonePill key={name} name={name} setting={setting} store={settings} /> : null
          )}
        </div>
      ) : null}

      {settings && phoneDock ? <PhoneDock key={`dock-${day.day}`} names={phoneDock} pills={phoneDockPills} store={settings} hidden={panelOpen} /> : null}

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
              {/* Frame times while developing only; the deployed site never shows them. */}
              {process.env.NODE_ENV !== "production" ? <FrameGraph /> : null}
            </footer>
          </div>
        </div>
      </aside>

      <AnimatePresence>
        {prompt && !promptDone ? (
          <motion.div className={`cv-prompt ${prompt.high ? "cv-prompt-high" : prompt.low ? "cv-prompt-low" : ""} ${prompt.phoneAside ? "cv-prompt-aside" : ""}`} style={prompt.phoneUp ? ({ "--cv-prompt-up": `${prompt.phoneUp}px` } as CSSProperties) : undefined} key={`prompt-${day.day}`} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10, scale: 0.97 }} transition={SETTLE}>
            <i aria-hidden="true" />
            <p>{prompt.title}</p>
            {prompt.detail ? <small>{prompt.detail}</small> : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <FollowCard dayNumber={day.day} />

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
