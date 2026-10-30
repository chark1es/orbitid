import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_LINES = 500;
export const MAX_BYTES = 32 * 1024;
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".md", ".sh", ".yml", ".yaml", ".json", ".html", ".sql"]);

/** Generated artifacts retain their canonical format; splitting them would break their consumers. */
export function isMaintainedText(path) {
  const normalized = path.replaceAll("\\", "/");
  if (/(^|\/)(node_modules|dist|build|coverage|\.next)(\/|$)/.test(normalized)) return false;
  if (normalized.startsWith("packages/server/drizzle/")) return false;
  if (normalized === "docs/openapi.json" || /(^|\/)(package-lock|npm-shrinkwrap)\.json$/.test(normalized)) return false;
  return textExtensions.has(extname(normalized));
}

export function sizeViolation(path, bytes) {
  if (!isMaintainedText(path)) return null;
  const text = bytes.toString("utf8");
  const lines = text ? text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0) : 0;
  if (lines <= MAX_LINES && bytes.length <= MAX_BYTES) return null;
  return `${path}: ${lines} lines, ${bytes.length} bytes (limits: ${MAX_LINES} lines, ${MAX_BYTES} bytes)`;
}

/** File links only; URL routes and heading anchors require different validation. */
export function localMarkdownLinks(markdown) {
  const prose = markdown.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
  return [...prose.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?["'])?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, ""))
    .filter((target) => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target));
}

export function brokenMarkdownLinks(path, markdown) {
  return localMarkdownLinks(markdown).flatMap((target) => {
    const file = target.split(/[?#]/)[0];
    if (!file) return [];
    try {
      return existsSync(resolve(dirname(path), decodeURIComponent(file))) ? [] : [`${path}: missing link target ${target}`];
    } catch {
      return [`${path}: malformed link target ${target}`];
    }
  });
}

export function checkRepository(root, mode = "all") {
  if (!["all", "sizes", "docs"].includes(mode)) throw new Error(`Unknown check: ${mode}`);
  // Include new files so a local check catches a newly introduced large module before it is committed.
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
  const findings = [];
  for (const path of files) {
    const fullPath = resolve(root, path);
    if (!existsSync(fullPath) || !lstatSync(fullPath).isFile() || !isMaintainedText(path)) continue;
    const bytes = readFileSync(fullPath);
    if (mode !== "docs") {
      const issue = sizeViolation(path, bytes);
      if (issue) findings.push(issue);
    }
    if (mode !== "sizes" && extname(path) === ".md") findings.push(...brokenMarkdownLinks(fullPath, bytes.toString("utf8")));
  }
  return findings;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const findings = checkRepository(process.cwd(), process.argv[2] ?? "all");
    if (findings.length) {
      console.error(findings.join("\n"));
      process.exitCode = 1;
    } else console.log("Repository checks passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
