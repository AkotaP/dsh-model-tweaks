/**
 * Manifest contracts (contract §1 and §7.1): the three ids that must agree — the cordis loader
 * entry id in `cordis.patch.yml`, the client module id in `lib/client.js`, and the `name`
 * exported by `lib/index.js` — plus the `package.json` declarations the DSH loader reads.
 *
 * The cross-half assertions are skipped while a half has not been written yet, so this file is
 * green from the first commit and gets stricter as `lib/` lands.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_MODULE_ID, PLUGIN_NAME, getClientLoad, loadClient, loadHost, readRepo, repoExists } from "./support/harness.mjs";
import { FORMAT_COUNT_CASES } from "./support/format-cases.mjs";

export { FORMAT_COUNT_CASES };

const manifest = JSON.parse(readRepo("package.json"));
const patch = readRepo("cordis.patch.yml");

/** Every `- id: …` entry in the patch file. */
const patchIds = [...patch.matchAll(/^\s*-\s*id:\s*["']?([^"'\s#]+)["']?\s*$/gm)].map((match) => match[1]);
/** The id `lib/client.js` passes to `window.__ModuleLoader__.load({ id })`. */
const clientModuleId = (source) => source.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?id\s*:\s*["']([^"']+)["']/)?.[1];
/** Bare `@deepseek-ai/*` packages a host module imports statically. */
const staticImports = (source) => [...source.matchAll(/(?:from|import)\s*\(?\s*["'](@deepseek-ai\/[^"']+)["']/g)].map((match) => match[1]);

const CLIENT_WRITTEN = repoExists("lib", "client.js");
const HOST_WRITTEN = repoExists("lib", "index.js");

test("package.json declares the host entry, the client entry and the bundle patch", () => {
  assert.equal(manifest.name, PLUGIN_NAME);
  assert.equal(manifest.type, "module", "the host half is plain Node ESM");
  assert.equal(manifest.main, "lib/index.js");
  assert.equal(manifest.exports["."].default, "./lib/index.js");
  assert.equal(manifest.exports["./client"].default, "./lib/client.js");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(manifest.engines.node, "engines.node must stay declared");
  assert.ok(manifest.engines.dsh, "engines.dsh must stay declared");
});

test("dsh.client.inject declares the DSH client plugin modules, not bare Node module names", () => {
  const inject = manifest.dsh.client.inject;
  assert.deepEqual(inject, [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-ui-settings",
  ], "client inject lists the client module graph + activation order (same shape as dsh-archived-sessions)");
  assert.equal(new Set(inject).size, inject.length, "no duplicate entries");
  assert.ok(!inject.includes("react") && !inject.includes("react/jsx-runtime"), "react and react/jsx-runtime are baseline client modules and must not be declared");
  assert.ok(!inject.includes("@deepseek-ai/dsh-client-ui-primitives"), "this plugin requires no UI primitives, so declaring them would be noise");
});

test("cordis.patch.yml inserts exactly one loader entry named after the plugin", () => {
  assert.equal(patchIds.length, 1, "the bundle patch must insert a single entry");
  assert.equal(patchIds[0], PLUGIN_NAME);
  assert.match(patch, new RegExp("name:\\s*['\"]?" + PLUGIN_NAME + "['\"]?"), "the inserted entry must keep its name");
});

test("the loader id, the client module id and the host export name agree", { skip: (!CLIENT_WRITTEN || !HOST_WRITTEN) && "waiting for lib/client.js and lib/index.js" }, async () => {
  const source = readRepo("lib", "client.js");
  assert.equal(clientModuleId(source), CLIENT_MODULE_ID, "lib/client.js must register the contract module id");
  const plugin = await loadHost("manifest-" + Math.random());
  assert.equal(plugin.name, PLUGIN_NAME, "lib/index.js must export the same name");
  assert.equal(patchIds[0], clientModuleId(source));
  assert.equal(patchIds[0], plugin.name);
  assert.ok(Array.isArray(plugin.inject), "the host half must declare its cordis inject list");
  assert.ok(plugin.inject.includes("webServer"), "the host half mounts the HTTP API on webServer");
  // No `settings` entry is required: contract v1.3(a) makes the host read every DSH capability
  // tolerantly through `ctx.get("…")`, so the settings service is not injected.
});

test("the client half only requires baseline modules plus its declared plugins", { skip: !CLIENT_WRITTEN && "waiting for lib/client.js" }, () => {
  const plugin = loadClient();
  const required = getClientLoad().required;
  // `react` / `react/jsx-runtime` are baseline client modules; everything else must be declared.
  const baseline = ["react", "react/jsx-runtime"];
  for (const id of required) {
    assert.ok(baseline.includes(id) || manifest.dsh.client.inject.includes(id), "undeclared client require: " + id);
  }
  assert.ok(baseline.every((id) => required.includes(id)), "the bundle must require react and the jsx runtime");
  assert.ok(Array.isArray(plugin.inject), "the client half must export its inject list");
});

test("every @deepseek-ai package the host imports is a declared dependency", { skip: !HOST_WRITTEN && "waiting for lib/index.js" }, () => {
  const source = readRepo("lib", "index.js");
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  for (const id of staticImports(source)) {
    assert.ok(declared.has(id), id + " is imported by lib/index.js but not declared in package.json (it must also be installed into this plugin's node_modules)");
  }
});

/**
 * `formatCount` necessarily exists twice: the host half is Node ESM and the client half is a browser
 * bundle, so neither can import the other and there is no single source of truth. The two copies are
 * therefore welded together by **one shared table** (`test/support/format-cases.mjs`) plus this
 * cross-half assertion: both implementations must reproduce every expected value exactly. The host's
 * own table in `test/host-api.test.mjs` must stay identical to that shared table.
 */
test("host and client formatCount agree on the shared table", { skip: (!CLIENT_WRITTEN || !HOST_WRITTEN) && "waiting for both halves" }, async () => {
  const host = await loadHost("format-count-" + Math.random());
  const client = loadClient();
  assert.equal(typeof host.formatCount, "function", "lib/index.js must export formatCount");
  assert.equal(typeof client.formatCount, "function", "lib/client.js must export formatCount");
  for (const [value, expected] of FORMAT_COUNT_CASES) {
    assert.equal(client.formatCount(value), expected, "client formatCount(" + value + ")");
    assert.equal(host.formatCount(value), expected, "host formatCount(" + value + ")");
    assert.equal(client.formatCount(value), host.formatCount(value), "host/client formatCount drifted at " + value);
  }
});

/**
 * The same "no single source of truth" problem as `formatCount`, for the built-in preset document:
 * the host uses it for `resetDefaults`, while the client keeps a copy for the host-unreachable
 * fallback. They must never fork — otherwise "Restore default presets" and the fallback disagree.
 */
test("host and client DEFAULT_PRESETS are identical", { skip: (!CLIENT_WRITTEN || !HOST_WRITTEN) && "waiting for both halves" }, async () => {
  const host = await loadHost("default-presets-" + Math.random());
  const client = loadClient();
  assert.ok(host.DEFAULT_PRESETS, "lib/index.js must export DEFAULT_PRESETS");
  assert.ok(client.DEFAULT_PRESETS, "lib/client.js must export DEFAULT_PRESETS");
  assert.deepStrictEqual(client.DEFAULT_PRESETS, host.DEFAULT_PRESETS, "the client fallback mirror forked from the host's built-in presets");
  // The owner's own profile declares maxTokens: 256000, so it has to be in both lists.
  assert.ok(host.DEFAULT_PRESETS.maxOutputs.includes(256000), "256000 must stay in maxOutputs");
});

/** The v1.17 built-ins: every combo starts with `off`, in `THINKING_LEVELS` order. */
const BUILT_IN_COMBOS = ["DeepSeek", "OpenAI Standard", "Simple"];
const BUILT_IN_LEVELS = {
  DeepSeek: ["off", "low", "high", "max"],
  "OpenAI Standard": ["off", "low", "medium", "high"],
  Simple: ["off", "low", "high"],
};

/**
 * v1.17: every built-in reasoning combo has to open with `off` — it is the only level pi-ai maps to
 * `null`, so a combo needs it to be truly switchable off — and every level it names must exist in
 * that half's own `reasoningLevels` (the preset file's validation rule, see contract §5). Checked on
 * **both halves**, because either one can drift.
 */
test("every built-in reasoning combo starts with off and only uses known levels (v1.17)", { skip: (!CLIENT_WRITTEN || !HOST_WRITTEN) && "waiting for both halves" }, async () => {
  const host = await loadHost("reasoning-off-" + Math.random());
  const client = loadClient();
  for (const [name, half] of [["host", host], ["client", client]]) {
    const presets = half.DEFAULT_PRESETS;
    assert.ok(presets, name + " must export DEFAULT_PRESETS");
    const combos = presets.reasoningPresets;
    const levels = presets.reasoningLevels;
    assert.ok(Array.isArray(combos) && Array.isArray(levels), name + " must expose its built-in presets and levels");
    assert.deepEqual(combos.map((combo) => combo.name), BUILT_IN_COMBOS, name + " must keep the built-in combos in their order");
    for (const combo of combos) {
      assert.equal(combo.levels[0], "off", name + " combo " + combo.name + " must start with off (v1.17)");
      assert.deepEqual(combo.levels, BUILT_IN_LEVELS[combo.name], name + " combo " + combo.name + " must match the v1.17 built-in levels");
      for (const level of combo.levels) {
        assert.ok(levels.includes(level), name + " combo " + combo.name + " names " + JSON.stringify(level) + ", which is not in its reasoningLevels");
      }
      assert.ok(combo.levels.some((level) => level !== "off"), name + " combo " + combo.name + " must keep at least one non-off level");
      assert.equal(new Set(combo.levels).size, combo.levels.length, name + " combo " + combo.name + " must not repeat a level");
    }
  }
});
