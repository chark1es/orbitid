#!/usr/bin/env node
// Decides which CI jobs a change needs. The `changes` job in .github/workflows/ci.yml runs this with
// the pull request's changed files; pushes to main and manual runs pass no list and run everything.
//
//   node scripts/ci-plan.mjs crates/orbitid-core/src/lib.rs apps/dashboard/src/main.tsx
//
// Rust tests are sharded by crate. A crate's tests run when the crate itself or anything it depends on
// (including dev-dependencies) changed, so a dashboard-only change runs no Rust tests and a change to
// orbitid-oidc runs only the oidc and server shards. The dependency graph is read from the crates'
// Cargo.toml files, so a new crate is picked up without editing this file.

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Crates grouped into one CI job, balanced by test time (each shard runs its crates on the default
 * pool and again on a one-connection pool). A crate missing from this list gets a shard of its own.
 */
export const SHARDS = [
  { name: "server", crates: ["orbitid-server"] },
  { name: "federation", crates: ["orbitid-federation"] },
  { name: "fapi-auth", crates: ["orbitid-fapi-auth"] },
  { name: "identity", crates: ["orbitid-identity"] },
  { name: "fapi-account", crates: ["orbitid-fapi-account"] },
  { name: "oidc", crates: ["orbitid-oidc"] },
  { name: "bapi-credentials", crates: ["orbitid-bapi", "orbitid-credentials"] },
  { name: "core-platform", crates: ["orbitid-core", "orbitid-platform"] },
];

/** Files whose change can affect every job: the pipeline itself and this planner. */
const PIPELINE = [/^\.github\/(workflows|actions)\//, /^scripts\/ci-plan(\.test)?\.mjs$/];

/** Changes that touch every Rust crate. */
const RUST_GLOBAL = [/^Cargo\.(toml|lock)$/, /^rust-toolchain\.toml$/, ...PIPELINE];

/** Root JavaScript workspace configuration shared by every package. */
const JS_ROOT = [/^package\.json$/, /^bun\.lock$/, /^bunfig\.toml$/, /^tsconfig\.base\.json$/];

const JS = [/^(packages|apps|playground)\//, ...JS_ROOT, ...PIPELINE];

/** The Node SDK integration tests: the SDK, what it imports, and the example app they boot. */
const NODE_SDK = [/^packages\/(node|backend|shared)\//, /^apps\/example-node\//, ...JS_ROOT, ...PIPELINE];

/** Everything the Docker image is built from, plus the smoke test and compose files that exercise it. */
const CONTAINER = [
  /^Dockerfile$/,
  /^\.dockerignore$/,
  /^docker-compose[^/]*\.ya?ml$/,
  /^scripts\/smoke-container\.sh$/,
  /^Cargo\.(toml|lock)$/,
  /^docs\/openapi\.json$/,
  /^apps\/dashboard\//,
  /^packages\/(shared|ui|js|react)\//,
  ...JS_ROOT,
  ...PIPELINE,
];

/** Files outside a crate that a crate compiles in or its tests read. */
const CRATE_EXTRA_INPUTS = {
  "orbitid-server": [/^docs\/openapi\.json$/],
};

const matchesAny = (path, patterns) => patterns.some((re) => re.test(path));

/** Markdown inside a crate is documentation; nothing compiles or reads it. */
const isCrateDoc = (path) => /^crates\/.+\.md$/.test(path);

/** `{ crate: [orbitid crates it depends on, including dev-dependencies] }` from the workspace manifests. */
export function readCrateGraph(root) {
  const graph = {};
  for (const dir of readdirSync(resolve(root, "crates"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let manifest;
    try {
      manifest = readFileSync(resolve(root, "crates", dir.name, "Cargo.toml"), "utf8");
    } catch {
      continue;
    }
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? dir.name;
    const deps = new Set();
    for (const match of manifest.matchAll(/^\s*(orbitid-[a-z0-9-]+)\s*(?:=|\.)/gm)) {
      if (match[1] !== name) deps.add(match[1]);
    }
    graph[name] = { dir: dir.name, deps: [...deps].sort() };
  }
  return graph;
}

/** Every crate `name` depends on, directly or transitively, and itself. */
function closure(graph, name, seen = new Set()) {
  if (seen.has(name)) return seen;
  seen.add(name);
  for (const dep of graph[name]?.deps ?? []) closure(graph, dep, seen);
  return seen;
}

/**
 * The jobs a change needs. `files` is the list of changed paths, or `null` to run everything (pushes
 * to main keep the caches warm and verify the merged result in full).
 */
export function planCi(files, graph) {
  const all = files === null;
  const changed = all ? [] : files.map((file) => file.replaceAll("\\", "/"));
  const any = (patterns) => all || changed.some((path) => matchesAny(path, patterns));

  const rustGlobal = any(RUST_GLOBAL);
  // A crate whose shipped code changed affects every crate built on it; a crate whose integration
  // tests alone changed affects only itself (no crate reads another crate's tests/ directory).
  const dirtySource = new Set();
  const dirtyTests = new Set();
  for (const [name, { dir }] of Object.entries(graph)) {
    const prefix = `crates/${dir}/`;
    const extra = CRATE_EXTRA_INPUTS[name] ?? [];
    for (const path of changed) {
      if (matchesAny(path, extra)) dirtySource.add(name);
      if (!path.startsWith(prefix) || isCrateDoc(path)) continue;
      if (path.startsWith(`${prefix}tests/`)) dirtyTests.add(name);
      else dirtySource.add(name);
    }
    if (all || rustGlobal) dirtySource.add(name);
  }

  const affected = Object.keys(graph)
    .filter((name) => dirtyTests.has(name) || [...closure(graph, name)].some((dep) => dirtySource.has(dep)))
    .sort();

  const sharded = new Set(SHARDS.flatMap((shard) => shard.crates));
  const shards = [
    ...SHARDS,
    ...Object.keys(graph)
      .filter((name) => !sharded.has(name))
      .sort()
      .map((name) => ({ name: name.replace(/^orbitid-/, ""), crates: [name] })),
  ]
    .map((shard) => ({ name: shard.name, crates: shard.crates.filter((name) => affected.includes(name)) }))
    .filter((shard) => shard.crates.length > 0)
    .map((shard) => ({ ...shard, packages: shard.crates.map((name) => `-p ${name}`).join(" ") }));

  // Crate tests and in-crate docs never reach the binary, so they rerun neither the SDK tests nor the image.
  const binaryChanged = dirtySource.size > 0;
  return {
    rust: binaryChanged || dirtyTests.size > 0,
    rustShards: shards,
    js: any(JS),
    // The SDK tests run the real server binary, so a server change reruns them too.
    nodeSdk: binaryChanged || any(NODE_SDK),
    container: binaryChanged || any(CONTAINER),
  };
}

function writeOutputs(plan) {
  const lines = [
    `rust=${plan.rust}`,
    `rust_shards=${JSON.stringify(plan.rustShards)}`,
    `js=${plan.js}`,
    `node_sdk=${plan.nodeSdk}`,
    `container=${plan.container}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const shardList = plan.rustShards.map((shard) => `\`${shard.name}\` (${shard.crates.join(", ")})`).join(", ") || "none";
    const summary = [
      "### CI plan",
      "",
      `| Job | Runs |`,
      `| --- | --- |`,
      `| Rust lint | ${plan.rust ? "yes" : "skipped"} |`,
      `| Rust test shards | ${shardList} |`,
      `| JavaScript | ${plan.js ? "yes" : "skipped"} |`,
      `| Node SDK integration | ${plan.nodeSdk ? "yes" : "skipped"} |`,
      `| Container smoke | ${plan.container ? "yes" : "skipped"} |`,
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary.join("\n")}\n`);
  }
  console.log(lines.join("\n"));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  // CI passes the changed files as a JSON array in CHANGED_FILES; locally they are arguments.
  // RUN_ALL=true (pushes, manual runs) or no list at all means run everything.
  let files = null;
  if (process.env.RUN_ALL !== "true") {
    if (process.env.CHANGED_FILES) files = JSON.parse(process.env.CHANGED_FILES);
    else if (process.argv.length > 2) files = process.argv.slice(2);
  }
  writeOutputs(planCi(files, readCrateGraph(root)));
}
