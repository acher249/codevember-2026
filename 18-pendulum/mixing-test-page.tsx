"use client";

import { useRef, useState } from "react";
import { runMixingGpuTests, type GpuTestReport, type GpuTestResult } from "./mixing-gpu-test";

// Opt-in verification page: re-export from a temporary app route as described in README.md.
export default function PendulumMixingTest() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<GpuTestResult[]>([]);
  const [report, setReport] = useState<GpuTestReport | null>(null);
  const run = async () => {
    if (!canvas.current || running) return;
    setRunning(true); setResults([]); setReport(null);
    try {
      const completed = await runMixingGpuTests(canvas.current, (result) => setResults((previous) => [...previous, result]));
      setReport(completed);
    } finally { setRunning(false); }
  };
  return (
    <main style={{ position: "fixed", inset: 0, zIndex: 100000, overflow: "auto", padding: "32px max(24px, calc((100vw - 1080px) / 2))", background: "#11151a", color: "#eff3f5", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Pendulum paint mixing · WebGPU regression</h1>
      <p style={{ marginBottom: 20, color: "#b7c3ce", maxWidth: 900 }}>Runs the production paint and colour shaders on this browser’s WebGPU device. Numeric checks compare actual GPU buffers to independent references. The simulation stays separate from the live painting.</p>
      <button type="button" disabled={running} onClick={run} style={{ padding: "12px 20px", borderRadius: 8, border: 0, background: "#baf2d4", color: "#10271c", cursor: running ? "wait" : "pointer", fontWeight: 700 }}>{running ? "Running GPU tests…" : "Run GPU tests"}</button>
      <canvas ref={canvas} width={16} height={16} style={{ position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }} aria-hidden="true" />
      <p role="status" style={{ margin: "20px 0", fontWeight: 700 }}>
        {report ? `${report.passed ? "PASS" : "FAIL"}: ${results.filter((result) => result.passed).length} of ${results.length} checks passed.` : running ? `${results.length} checks completed…` : "Ready. WebGPU is required; a WebGL fallback is reported as a failure."}
      </p>
      <ol style={{ paddingLeft: 24 }}>
        {results.map((result, index) => <li key={index} style={{ padding: "10px 0", borderBottom: "1px solid #29323b" }}><strong style={{ color: result.passed ? "#a6edc3" : "#ffa5a5" }}>{result.passed ? "PASS" : "FAIL"}</strong>{" · "}<strong>{result.name}</strong><pre style={{ whiteSpace: "pre-wrap", font: "12px/1.5 ui-monospace, monospace", marginTop: 4, color: "#b7c3ce" }}>{result.detail}</pre></li>)}
      </ol>
      {report?.gradients.map((gradient) => <figure key={gradient.name} style={{ marginTop: 28 }}><figcaption style={{ marginBottom: 8 }}>{gradient.name}</figcaption><div style={{ display: "flex", height: 64, borderRadius: 8, overflow: "hidden" }}>{gradient.colours.map((colour, index) => <span key={index} style={{ background: colour, flex: 1 }} />)}</div></figure>)}
    </main>
  );
}
