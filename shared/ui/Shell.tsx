"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Component, useState, type ReactNode } from "react";
import { dayFromPath, type CodevemberDay } from "../days";
import { withRetries } from "../engine/retry";
import { Loader, type LoadStep } from "./Loader";

const Stage = dynamic(() => withRetries(() => import("../engine/Stage")), { ssr: false });

// The loader sits outside the lazy Stage, so it is in the first paint, before three.js downloads.
function Experience({ day }: { day: CodevemberDay }) {
  const [step, setStep] = useState<LoadStep>("engine");

  return (
    <>
      <Stage day={day} onStep={setStep} />
      <Loader day={day} step={step} />
    </>
  );
}

// A code file that fails to arrive is usually a dropped connection or an old page, and a reload fixes it. Tried once.
const RELOADED = "cv-reloaded";
const isLoadFailure = (error: Error) => /chunk|loading .*failed|failed to fetch|importing a module|module script/i.test(`${error.name} ${error.message}`);

// Anything that goes wrong in the 3D stops here, and not at the bare error page of the whole site.
class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
    if (isLoadFailure(error) && !sessionStorage.getItem(RELOADED)) {
      sessionStorage.setItem(RELOADED, "1");
      window.location.reload();
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="cv-crash" role="alert">
        <p>This one hit a snag.</p>
        <button type="button" className="cv-pill" onClick={() => window.location.reload()}>
          Try again
        </button>
        <a href={"/"}>All days</a>
        <small>{error.message}</small>
      </div>
    );
  }
}

// Lives in the root layout, so the renderer survives moving between days.
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const day = dayFromPath(pathname);

  return (
    <CrashScreen>
      {children}
      {day && day.live ? <Experience day={day} /> : null}
    </CrashScreen>
  );
}
