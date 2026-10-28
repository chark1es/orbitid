import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

/** Runs one of the repository's TypeScript entry points on Node with the local tsx loader. */
export function nodeTs(script: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}) {
  const child = spawn(process.execPath, ["--import", require.resolve("tsx"), resolve(here, script), ...args], {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(options.input ?? "");
  const done = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
  return { child, done };
}

/** Resolves a path next to this file, for the child scripts. */
export const supportScript = (name: string) => resolve(here, name);

/** CLI output: the last JSON line is the machine-readable summary (human progress may follow it). */
export function lastJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
  if (!line) throw new Error("no JSON output");
  return JSON.parse(line) as T;
}
