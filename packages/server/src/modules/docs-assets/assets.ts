/**
 * Static files for the docs page, read once from `docs-assets/` next to this module.
 *
 * The server is consumed as TypeScript source (there is no build step), so the files ship with it. Keeping them as
 * real `.html`/`.css`/`.js` files means editors and linters treat them as what they are.
 *
 * The viewer is a small ES module graph (`viewer.js` plus `viewer/*.js`). Every JavaScript and CSS file under
 * `docs-assets/` is served from `/docs/assets/<relative path>`, so a split into modules needs no route table edit.
 * `page.html` is the page itself and is exported separately, never served as an asset.
 */
import { readdirSync, readFileSync } from "node:fs";

const root = new URL("./", import.meta.url);

export interface DocsAsset {
  body: string;
  contentType: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function read(name: string): string {
  return readFileSync(new URL(name, root), "utf8");
}

/** Relative asset paths (for example `viewer/page.js`) mapped to their bytes and MIME type. */
function collect(prefix = ""): Record<string, DocsAsset> {
  const assets: Record<string, DocsAsset> = {};
  for (const entry of readdirSync(new URL(prefix, root), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) {
      Object.assign(assets, collect(name + "/"));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    const contentType = CONTENT_TYPES[extension];
    if (!contentType) continue;
    assets[name] = { body: read(name), contentType };
  }
  // Sorted so route registration is deterministic and diffs stay readable.
  return Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)));
}

export const DOCS_ASSETS = collect();
export const DOCS_HTML = read("page.html");
