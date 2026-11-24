"use client";

import dynamic from "next/dynamic";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { dayFromSlug, days, daySlug } from "@/shared/days";
import { withRetries } from "@/shared/engine/retry";
import { Loader, type LoadStep } from "@/shared/ui/Loader";
import { CrashScreen } from "@/shared/ui/Shell";
import { makePortal } from "./portal";
import { setPrefaceStep } from "./preface";
import { finishReturn, requestReturn, returnState, useReturnState } from "./returning";

const HubStage = dynamic(() => withRetries(() => import("./HubStage")), { ssr: false });

const HUB = "/";

function dayFromHubPath(pathname: string) {
  const slug = pathname.slice(HUB.length - 1).replace(/^\//, "").replace(/\/$/, "");
  const day = slug ? dayFromSlug(slug) : undefined;
  return day && day.live ? day : null;
}

// The site's Shell for the hub: the stage stays up on the calendar too, which is the hub, and the loader shows only for a
// day. The days' own HUD links back to /; here those links, and the keys for the next and previous day, stay
// in the hub instead.
export function HubShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const day = dayFromHubPath(pathname);
  const [step, setStep] = useState<LoadStep>("engine");
  // The calendar page as plain HTML (HubPage.tsx) shows the stage's progress on its way into 3D.
  useEffect(() => setPrefaceStep(step), [step]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a");
      const href = link?.getAttribute("href");
      // The plain page's links (HubFallback.tsx) load as new pages, with a fresh graphics device.
      if (!href || !href.startsWith("/") || link?.hasAttribute("data-cv-full")) return;
      event.preventDefault();
      event.stopPropagation();
      // On the way back already: a second press, by mouse or by keyboard, is not a second trip.
      if (returnState().phase !== "idle") return;
      // The calendar button, from a day that is up: the long way back, through its poster.
      if (href === "/" && requestReturn()) return;
      router.push(HUB + href.slice("/".length));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [router]);

  // In development, a day posed as its poster and held, for scripts/capture-hub-posters.mjs.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const handle = window as unknown as { cvPose?: () => boolean };
    handle.cvPose = () => requestReturn(true);
    return () => {
      delete handle.cvPose;
    };
  }, []);

  useEffect(() => {
    if (!day) return;
    const reachable = days.filter((day) => day.live);
    const position = reachable.findIndex((item) => item.day === day.day);
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "[" && event.key !== "]") return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      event.stopPropagation();
      if (event.repeat || returnState().phase !== "idle") return;
      const to = event.key === "[" ? reachable[position - 1] : reachable[position + 1];
      if (to) router.push(`${HUB}${daySlug(to)}/`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [day, router]);

  return (
    // Its "All days" link is to /, which the listener above keeps in the hub.
    <CrashScreen>
      {children}
      <HubStage day={day} onStep={setStep} />
      {/* Only for a day: the calendar is up as plain HTML at once (HubPage.tsx), and back from a day, that day's last frame
      covers the hub coming up. */}
      {day ? <Loader day={day} step={step} /> : null}
      <HeldFrame />
    </CrashScreen>
  );
}

// A day's last frame, held over everything while the hub comes up behind it, rippling as it waits; then, once the hub is
// standing at that day's portal, the ripples settle until the picture is still, and it fades (portal.ts). Faded plainly
// where that cannot be drawn. In seconds from the hub's arrival: how long the ripples take to settle, when the fade
// starts, and how long it takes.
const SETTLE = 1.1;
const FADE_FROM = 0.75;
const FADE = 0.7;
const CLOSE = FADE_FROM + FADE;
function HeldFrame() {
  const { phase, frame } = useReturnState();
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [plain, setPlain] = useState(false);
  // When it was first held, and when the hub arrived, by the page's clock, in seconds.
  const times = useRef({ held: 0, arrived: Infinity });

  useEffect(() => {
    if (phase === "arrived") times.current.arrived = performance.now() / 1000;
  }, [phase]);

  useEffect(() => {
    if (!canvas || !frame) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    times.current = { held: performance.now() / 1000, arrived: returnState().phase === "arrived" ? performance.now() / 1000 : Infinity };
    const portal = makePortal(canvas, frame);
    if (!portal) {
      setPlain(true);
      canvas.getContext("2d")?.drawImage(frame, 0, 0);
      return;
    }
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    let request = 0;
    const tick = () => {
      const now = performance.now() / 1000;
      const t = times.current;
      const since = Math.max(0, now - t.arrived);
      const stir = Math.min(1, (now - t.held) / 0.8);
      const settle = ease(Math.min(1, since / SETTLE));
      const fade = ease(Math.min(1, Math.max(0, (since - FADE_FROM) / FADE)));
      portal.draw(now - t.held, stir * stir * (3 - 2 * stir) * (1 - settle), fade);
      if (fade >= 1) {
        finishReturn();
        return;
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(request);
      portal.dispose();
    };
  }, [canvas, frame]);

  useEffect(() => {
    if (phase === "idle" || phase === "settling") return;
    document.documentElement.classList.remove("cv-hub-leaving");
    // Plainly faded, or, should the hub never arrive (it failed, or the visitor went back), not leaving the frame up for good.
    const timer = window.setTimeout(finishReturn, phase === "arrived" ? (plain ? 900 : CLOSE * 1000 + 600) : 10000);
    return () => window.clearTimeout(timer);
  }, [phase, plain]);

  if (!frame) return null;
  return <canvas ref={setCanvas} className={`cv-hub-held ${plain && phase === "arrived" ? "cv-hub-held-gone" : ""}`} aria-hidden="true" />;
}
