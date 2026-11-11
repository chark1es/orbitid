// A `:memory:` SQLite handle is backed by a throwaway file in a per-process temp directory (so a second connection
// can own write transactions). Nothing may leak: the handle removes its directory on close, the process removes the
// whole tree on exit/SIGINT/SIGTERM, and a startup sweep clears directories left by a killed process.
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, dialect, sweepStaleEphemeralDirs } from "../../src/db";
import { nodeTs } from "../support/spawn-cli";

const PREFIX = "orbitid-sqlite-";
const created: string[] = [];
const sqliteOnly = dialect === "sqlite" ? it : it.skip;

function processDirName(pid: number): string | null {
  return readdirSync(tmpdir()).find((name) => name.startsWith(`${PREFIX}${pid}-`)) ?? null;
}

function handleDirs(processDir: string): string[] {
  return readdirSync(join(tmpdir(), processDir)).filter((name) => name.startsWith("db-"));
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(join(tmpdir(), dir), { recursive: true, force: true });
});

describe("ephemeral SQLite directories", () => {
  sqliteOnly("uses one per-process temp directory and removes the handle's database on close", async () => {
    const handle = await createDb(":memory:");
    const processDir = processDirName(process.pid);
    expect(processDir).toBeTruthy();
    created.push(processDir!);
    const during = handleDirs(processDir!);
    expect(during).toHaveLength(1);

    await handle.close();
    expect(handleDirs(processDir!)).not.toContain(during[0]);
  });

  sqliteOnly("sweeps an old directory whose PID is dead and keeps one whose PID is alive", () => {
    // A short-lived child gives us a PID that is certainly not running any more.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const deadDir = `${PREFIX}${dead}-stale`;
    const liveDir = `${PREFIX}${process.pid}-live`;
    const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    for (const dir of [deadDir, liveDir]) {
      const full = join(tmpdir(), dir);
      rmSync(full, { recursive: true, force: true });
      mkdirSync(full, { recursive: true });
      utimesSync(full, old, old);
      created.push(dir);
    }

    sweepStaleEphemeralDirs();

    expect(() => statSync(join(tmpdir(), deadDir))).toThrow();
    expect(statSync(join(tmpdir(), liveDir)).isDirectory()).toBe(true);
  });

  sqliteOnly("removes the process directory on SIGTERM", async () => {
    const child = nodeTs("ephemeral-child.ts", []);
    const ready = await new Promise<{ pid: number; error: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`child did not start: ${stderr}`)), 30_000);
      child.child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        const line = stdout.split("\n").find((candidate) => candidate.startsWith("{"));
        if (!line) return;
        clearTimeout(timer);
        resolve(JSON.parse(line) as { pid: number; error: string });
      });
      child.child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
      child.child.on("exit", (code) => {
        if (!stdout.includes("{")) {
          clearTimeout(timer);
          reject(new Error(`child exited (${code}): ${stderr}`));
        }
      });
    });
    const processDir = processDirName(ready.pid);
    expect(processDir).toBeTruthy();
    created.push(processDir!);
    expect(ready.error).toBe("");

    child.child.kill("SIGTERM");
    const result = await child.done;
    expect(result.status).toBe(143);
    expect(() => statSync(join(tmpdir(), processDir!))).toThrow();
  });
});
