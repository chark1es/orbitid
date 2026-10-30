/*
 * OrbitID API reference viewer — entry point.
 *
 * Vanilla ES modules, no dependencies: fetches /v1/openapi.json, then hands it to the page renderer. Everything is
 * built with DOM APIs and `textContent`, never `innerHTML`, so a hostile schema string cannot inject markup. That is
 * what lets the page run under a strict CSP (`script-src 'self'`, no inline handlers, no `eval`).
 *
 * The renderer is split across `viewer/*.js` so each module stays small; the server serves them from
 * `/docs/assets/viewer/*` (see `assets.ts`).
 */
import { fail, start } from "./viewer/page.js";

fetch("/v1/openapi.json", { credentials: "same-origin" })
  .then(function (response) {
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  })
  .then(start)
  .catch(function (error) {
    fail("Could not load /v1/openapi.json (" + error.message + ").");
  });
