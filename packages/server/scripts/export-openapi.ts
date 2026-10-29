/**
 * Writes the OpenAPI document to `docs/openapi.json`.
 *
 * Run with `bun run openapi:export` from `packages/server` (or `bun run --filter @orbitid/server openapi:export`).
 * CI re-runs the export and fails when the committed file differs, so the published document can never lag the code.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildOpenApi } from "../src/openapi";

/** Relative to this file: `packages/server/scripts` → repository root → `docs/openapi.json`. */
const here = dirname(fileURLToPath(import.meta.url));
export const outputPath = resolve(here, "../../../docs/openapi.json");

/** Stable serialisation: two-space JSON with a trailing newline, so the committed file diffs cleanly. */
export function serialize(document: ReturnType<typeof buildOpenApi>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function render(): string {
  // `{baseUrl}` is replaced by the server at request time; the static document advertises the placeholder.
  return serialize(buildOpenApi({ baseUrl: "{baseUrl}" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(outputPath, render());
  console.log(`wrote ${outputPath}`);
}
