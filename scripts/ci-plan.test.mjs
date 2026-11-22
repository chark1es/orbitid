import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { planCi, readCrateGraph, SHARDS } from "./ci-plan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const graph = readCrateGraph(root);
const shardNames = (plan) => plan.rustShards.map((shard) => shard.name);

test("the crate graph is read from the workspace manifests", () => {
  assert.ok(graph["orbitid-core"], "orbitid-core is a workspace crate");
  assert.deepEqual(graph["orbitid-core"].deps, []);
  assert.ok(graph["orbitid-server"].deps.includes("orbitid-oidc"));
});

test("every workspace crate is in exactly one shard", () => {
  const sharded = SHARDS.flatMap((shard) => shard.crates);
  assert.equal(new Set(sharded).size, sharded.length, "no crate is listed twice");
  assert.deepEqual([...sharded].sort(), Object.keys(graph).sort());
});

test("a push runs everything", () => {
  const plan = planCi(null, graph);
  assert.equal(plan.rust && plan.js && plan.nodeSdk && plan.container, true);
  assert.deepEqual(shardNames(plan), SHARDS.map((shard) => shard.name));
  for (const shard of plan.rustShards) assert.equal(shard.packages, shard.crates.map((name) => `-p ${name}`).join(" "));
});

test("documentation outside the code runs nothing but the repository checks", () => {
  const plan = planCi(["docs/API.md", "README.md", "crates/README.md", "crates/orbitid-core/README.md"], graph);
  assert.deepEqual(plan, { rust: false, rustShards: [], js: false, nodeSdk: false, container: false });
});

test("a leaf crate change runs that crate and every crate built on it", () => {
  const plan = planCi(["crates/orbitid-oidc/src/lib.rs"], graph);
  assert.deepEqual(shardNames(plan), ["server", "oidc"]);
  assert.equal(plan.nodeSdk, true, "the SDK tests run the rebuilt binary");
  assert.equal(plan.container, true);
  assert.equal(plan.js, false);
});

test("a shard runs only its affected crates", () => {
  const plan = planCi(["crates/orbitid-credentials/src/lib.rs"], graph);
  const shard = plan.rustShards.find((entry) => entry.name === "bapi-credentials");
  assert.deepEqual(shard.crates, ["orbitid-bapi", "orbitid-credentials"]);
  const corePlatform = planCi(["crates/orbitid-platform/src/lib.rs"], graph).rustShards.find((entry) => entry.name === "core-platform");
  assert.deepEqual(corePlatform.crates, ["orbitid-platform"]);
});

test("a core change runs every shard", () => {
  assert.deepEqual(shardNames(planCi(["crates/orbitid-core/src/lib.rs"], graph)), SHARDS.map((shard) => shard.name));
});

test("an integration-test-only change runs just that crate and skips the binary consumers", () => {
  const plan = planCi(["crates/orbitid-core/tests/models.rs"], graph);
  assert.deepEqual(plan.rustShards, [{ name: "core-platform", crates: ["orbitid-core"], packages: "-p orbitid-core" }]);
  assert.equal(plan.nodeSdk, false);
  assert.equal(plan.container, false);
});

test("the OpenAPI document is compiled into the server", () => {
  const plan = planCi(["docs/openapi.json"], graph);
  assert.deepEqual(shardNames(plan), ["server"]);
  assert.equal(plan.container, true);
});

test("workspace manifests and the pipeline run every Rust shard", () => {
  for (const file of ["Cargo.lock", "Cargo.toml", "rust-toolchain.toml", ".github/workflows/ci.yml", "scripts/ci-plan.mjs"]) {
    assert.equal(planCi([file], graph).rustShards.length, SHARDS.length, file);
  }
});

test("a dashboard change runs the JavaScript checks and the image, not Rust or the SDK", () => {
  const plan = planCi(["apps/dashboard/src/main.tsx"], graph);
  assert.deepEqual(plan, { rust: false, rustShards: [], js: true, nodeSdk: false, container: true });
});

test("a Node SDK change runs its integration tests but not the image", () => {
  const plan = planCi(["packages/node/src/client.ts"], graph);
  assert.equal(plan.js, true);
  assert.equal(plan.nodeSdk, true);
  assert.equal(plan.container, false);
  assert.equal(plan.rust, false);
});

test("the container smoke script runs only the container job", () => {
  assert.deepEqual(planCi(["scripts/smoke-container.sh"], graph), { rust: false, rustShards: [], js: false, nodeSdk: false, container: true });
});
