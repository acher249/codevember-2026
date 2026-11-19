import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

// Use the project's existing compiler and Node test runner, with no added dependency.
const root = join(import.meta.dirname, "..");
const cache = join(root, ".cache");
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(join(cache, "pendulum-zuv-test-"));
try {
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/lib/tsc.js"),
    "18-pendulum/zuv.test.ts", "18-pendulum/pendulum.test.ts", "18-pendulum/brush-colors.test.ts", "--outDir", output, "--target", "ES2020",
    "--module", "nodenext", "--moduleResolution", "nodenext", "--esModuleInterop", "--skipLibCheck"
  ], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, ["--test", join(output, "zuv.test.js"), join(output, "pendulum.test.js"), join(output, "brush-colors.test.js")], { cwd: root, stdio: "inherit" });
} finally {
  if (dirname(output) !== cache) throw new Error("Unexpected test-output directory");
  rmSync(output, { recursive: true, force: true });
}
