import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_LINES = 500;
export const MAX_BYTES = 32 * 1024;
const textExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".md", ".sh", ".yml", ".yaml", ".json", ".html", ".sql"]);

/**
 * Product rule: nothing is locked behind a plan, tier or license. These patterns catch the vocabulary that
 * creeps into UI copy, docs and settings when a feature starts to look paid. A match is a finding unless the
 * file is a test/fixture or an allowlisted line explains why the word is legitimate (for example docs about
 * upgrading a guest account, which is an account conversion, not a purchase).
 */
export const PAYWALL_PATTERNS = [
  { name: "paywall", re: /\bpaywall\b/i },
  { name: "premium", re: /\bpremium\b/i },
  { name: "pro plan", re: /\bpro[\s-]plans?\b/i },
  { name: "enterprise plan", re: /\benterprise[\s-]plans?\b/i },
  { name: "license key", re: /\blicen[cs]e[\s-]keys?\b/i },
  { name: "contact sales", re: /\bcontact (?:sales|us to upgrade)\b/i },
  { name: "coming soon", re: /\bcoming soon\b/i },
  { name: "enterprise only", re: /\benterprise[\s-]only\b/i },
  { name: "feature locked", re: /\bfeature (?:is )?locked\b/i },
  { name: "paid plan", re: /\bpaid (?:plans?|tiers?|accounts?|subscriptions?)\b/i },
  { name: "upgrade to unlock", re: /\bupgrade (?:your plan|to (?:a )?(?:paid|pro|enterprise)|required|now)\b/i },
  { name: "upgrade your account", re: /\bupgraded? (?:your )?(?:account|plan|subscription)\b/i },
  { name: "seat limit", re: /\bseats? (?:limit|cap)\b/i },
  { name: "plan limit", re: /\bplan[\s-]limits?\b/i },
  { name: "trial expired", re: /\btrial (?:expired|ended|has ended)\b/i },
];

/** Tests, fixtures, the unshipped playground and generated output are not shipped copy. */
export function isShippedSource(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!isMaintainedText(normalized)) return false;
  if (normalized.startsWith("playground/")) return false;
  if (/(^|\/)(node_modules|dist|build|coverage|\.next|data)(\/|$)/.test(normalized)) return false;
  if (/(^|\/)(test|tests|__tests__)(\/|$)/.test(normalized)) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) return false;
  return true;
}

/** Legitimate uses of a blocked phrase, keyed by path and an exact substring on the line. */
export const PAYWALL_ALLOWLIST = [
  {
    path: "README.md",
    contains: "Everything is free",
    why: "The product statement that denies every gating concept.",
  },
  {
    path: "docs/DATA_MOVE.md",
    contains: "Cross-version upgrades",
    why: "Upgrading software, not selling a plan.",
  },
  {
    path: "docs/SECURITY.md",
    contains: "Upgrades.",
    why: "Dependency upgrades.",
  },
  {
    path: "scripts/check-repository.mjs",
    contains: 'name: "',
    why: "The guard's own pattern names, mode and npm script are implementation, not product copy.",
  },
  {
    path: "scripts/check-repository.mjs",
    contains: "paywall",
    why: "The guard's own mode and npm script name.",
  },
  {
    path: "package.json",
    contains: '"check:paywall"',
    why: "The guard's npm script name.",
  },
];

function allowedMatch(path, line) {
  return PAYWALL_ALLOWLIST.some((entry) => entry.path === path && line.includes(entry.contains));
}

/** Finds gating vocabulary in shipped source and UI copy. Returns `path:line: pattern` strings. */
export function paywallFindings(root) {
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean))];
  const findings = [];
  for (const path of files) {
    if (!isShippedSource(path)) continue;
    const fullPath = resolve(root, path);
    if (!existsSync(fullPath) || !lstatSync(fullPath).isFile()) continue;
    const lines = readFileSync(fullPath, "utf8").split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
      for (const pattern of PAYWALL_PATTERNS) {
        if (!pattern.re.test(line) || allowedMatch(path, line)) continue;
        findings.push(`${path}:${index + 1}: gating vocabulary "${pattern.name}" — ${line.trim().slice(0, 160)}`);
        break;
      }
    }
  }
  return findings;
}


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
  if (!["all", "sizes", "docs", "paywall"].includes(mode)) throw new Error(`Unknown check: ${mode}`);
  if (mode === "paywall") return paywallFindings(root);
  // Include new files so a local check catches a newly introduced large module before it is committed.
  const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean))];
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
  if (mode === "all") findings.push(...paywallFindings(root));
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
