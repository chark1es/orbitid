/**
 * Static files for the docs page, read once from `docs-assets/` next to this module.
 *
 * The server is consumed as TypeScript source (there is no build step), so the files ship with it. Keeping them as
 * real `.html`/`.css`/`.js` files means editors and linters treat them as what they are.
 */
import { readFileSync } from "node:fs";

const read = (name: string): string => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

export const DOCS_HTML = read("page.html");
export const DOCS_CSS = read("viewer.css");
export const DOCS_JS = read("viewer.js");
