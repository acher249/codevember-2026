"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { dayFromPath, type CodevemberDay } from "../days";
import { Loader, type LoadStep } from "./Loader";

const Stage = dynamic(() => import("../engine/Stage"), { ssr: false });

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

// Lives in the root layout, so the renderer survives moving between days.
export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const day = dayFromPath(pathname);

  return (
    <>
      {children}
      {day && day.live ? <Experience day={day} /> : null}
    </>
  );
}
