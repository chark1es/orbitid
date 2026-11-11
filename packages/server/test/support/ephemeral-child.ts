// Opens a throwaway SQLite database and waits to be killed, so the parent can prove the process-level cleanup
// (exit/SIGINT/SIGTERM) removes the per-process temp directory. Prints one JSON line once the handle is ready.
import { createDb } from "../../src/db";

try {
  const handle = await createDb(":memory:");
  console.log(JSON.stringify({ pid: process.pid, label: handle.label, error: "" }));
  // The database module installs the SIGTERM handler; keep the event loop alive until it fires.
  setInterval(() => {}, 1_000);
} catch (error) {
  console.log(JSON.stringify({ pid: process.pid, label: "", error: String(error) }));
  process.exit(1);
}
