/**
 * v1.19 — the default reasoning-effort chain and the per-model effort memory.
 *
 * Three layers are covered:
 *  1. **Host preset document** — `reasoningChain` validation, defaults, persistence, and backward
 *     compatibility with a pre-v1.19 file (contract §6).
 *  2. **Resolution rule** — the pure `resolveSwitchEffort`: a remembered effort wins, a remembered
 *     `default` leaves the field alone, a stale memory falls back to the chain, and the chain's
 *     result is what the caller records (contract §10).
 *  3. **Service hook + memory** — `installReasoningChain` wraps `ctx.modelDirectories.directoryFor()`
 *     instances; a switch without memory picks from the chain and writes the memory, a manual pick
 *     writes it too, and a failed selection writes nothing.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
  callApi,
  createModelDirectoryDouble,
  flush,
  installLocalStorage,
  loadClient,
  loadHost,
  makeHostContext,
  makeModelDirectoriesDouble,
  mountClient,
  removeLocalStorage,
} from "./support/harness.mjs";

const host = await loadHost("reasoning-chain-host");
const client = loadClient();

const mountHost = () => {
  const made = makeHostContext({});
  host.apply(made.ctx);
  return made;
};

const presetsFile = () => join(process.env.DSH_HOME, "dsh-model-tweaks", "presets.json");

/** The smallest complete document the presets API accepts. */
const DOCUMENT = (overrides = {}) => ({
  version: 1,
  contextWindows: [8192],
  maxOutputs: [4096],
  reasoningLevels: ["off", "low", "high"],
  reasoningPresets: [],
  ...overrides,
});

/** The preset document the client's switch hook reads at mount time. */
const CHAIN_PRESETS = {
  version: 1,
  reasoningLevels: ["off", "low", "medium", "high", "max"],
  reasoningChain: ["high", "medium", "low"],
  rememberEffort: true,
  useReasoningChain: true,
};

const tempDirs = [];
beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-model-tweaks-chain-"));
  tempDirs.push(dir);
  process.env.DSH_HOME = dir;
});
afterEach(async () => {
  const dir = tempDirs.pop();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  removeLocalStorage();
  // Let a pending idle memory write fire while storage is gone (it must no-op), so one test's
  // scheduled write cannot land in the next test's double.
  await flush(5);
});
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// -- host: preset document ---------------------------------------------------
describe("host preset document (v1.19)", () => {
  it("ships the built-in chain, the two switches and no retired memory field", () => {
    assert.deepStrictEqual(host.DEFAULT_PRESETS.reasoningChain, ["high", "medium", "low"]);
    assert.equal(host.DEFAULT_PRESETS.rememberEffort, true, "the memory switch is a document field, on by default");
    assert.equal(host.DEFAULT_PRESETS.useReasoningChain, true, "the automatic-chain switch is a document field, on by default");
    assert.equal("keepLastReasoning" in host.DEFAULT_PRESETS, false, "the retired draft field stays out");
    assert.deepStrictEqual(client.DEFAULT_PRESETS.reasoningChain, host.DEFAULT_PRESETS.reasoningChain);
    assert.equal(client.DEFAULT_PRESETS.rememberEffort, host.DEFAULT_PRESETS.rememberEffort);
    assert.equal(client.DEFAULT_PRESETS.useReasoningChain, host.DEFAULT_PRESETS.useReasoningChain);
    assert.equal("keepLastReasoning" in client.DEFAULT_PRESETS, false);
  });

  it("persists a chain that references only declared levels", async () => {
    const { routes } = mountHost();
    const response = await callApi(routes, "presets", {
      action: "save",
      payload: DOCUMENT({ reasoningChain: ["high", "high", "low"] }),
    });
    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body.value.presets.reasoningChain, ["high", "low"], "duplicates collapse in first-occurrence order");
    assert.equal(response.body.value.presets.rememberEffort, true, "an omitted switch adopts the built-in default");
    assert.equal(response.body.value.presets.useReasoningChain, true);
    const onDisk = JSON.parse(await readFile(presetsFile(), "utf8"));
    assert.deepStrictEqual(onDisk, response.body.value.presets);
  });

  it("ignores a legacy keepLastReasoning field instead of failing", async () => {
    const { routes } = mountHost();
    const response = await callApi(routes, "presets", {
      action: "save",
      payload: DOCUMENT({ reasoningChain: ["high"], keepLastReasoning: false }),
    });
    assert.equal(response.status, 200, "a document saved by the earlier v1.19 draft must still load");
    assert.equal("keepLastReasoning" in response.body.value.presets, false, "the retired field is dropped from the normalized document");
    assert.deepStrictEqual(response.body.value.presets.reasoningChain, ["high"]);
    assert.equal(response.body.value.presets.rememberEffort, true);
    assert.equal(response.body.value.presets.useReasoningChain, true);
  });

  it("keeps an explicit empty chain (no preference; models without memory fall back to Default)", async () => {
    const { routes } = mountHost();
    const response = await callApi(routes, "presets", {
      action: "save",
      payload: DOCUMENT({ reasoningChain: [] }),
    });
    assert.equal(response.status, 200);
    assert.deepStrictEqual(response.body.value.presets.reasoningChain, []);
  });

  it("rejects an unknown chain level with 400 naming it", async () => {
    const { routes } = mountHost();
    const response = await callApi(routes, "presets", {
      action: "save",
      payload: DOCUMENT({ reasoningChain: ["high", "none"] }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "bad-request");
    assert.match(response.body.error.message, /"none"/);
    assert.equal(existsSync(presetsFile()), false, "a rejected save must not write the file");
  });

  it("rejects a non-boolean switch with 400 naming it", async () => {
    const { routes } = mountHost();
    for (const field of ["rememberEffort", "useReasoningChain"]) {
      const response = await callApi(routes, "presets", {
        action: "save",
        payload: DOCUMENT({ [field]: "yes" }),
      });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.error.code, "bad-request", field);
      assert.match(response.body.error.message, new RegExp(field), field + " must be named");
    }
  });

  it("rejects a non-array chain", async () => {
    const { routes } = mountHost();
    const response = await callApi(routes, "presets", {
      action: "save",
      payload: DOCUMENT({ reasoningChain: "high" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "bad-request");
  });

  it("back-fills an older file with the built-in chain narrowed to its declared levels", async () => {
    await mkdir(join(process.env.DSH_HOME, "dsh-model-tweaks"), { recursive: true });
    await writeFile(presetsFile(), JSON.stringify({
      version: 1,
      contextWindows: [8192],
      maxOutputs: [4096],
      reasoningLevels: ["max", "off", "low"],
      reasoningPresets: [],
    }), "utf8");
    const { routes } = mountHost();
    const { body } = await callApi(routes, "get", {});
    assert.deepStrictEqual(body.value.presets.reasoningChain, ["low"], "high/medium are not declared by that file");
    assert.equal(body.value.presets.rememberEffort, true, "both switches default on for an old file");
    assert.equal(body.value.presets.useReasoningChain, true);
    assert.equal("keepLastReasoning" in body.value.presets, false);
  });
});

// -- client: the browser-local memory --------------------------------------
describe("effort memory (v1.19)", () => {
  it("round-trips provider-scoped entries and stores an omitted effort as default", async () => {
    const localStorageDouble = installLocalStorage();
    client.rememberEffort({ provider: "ollama", model: "glm-5.3" }, "high");
    client.rememberEffort({ provider: "ollama", model: "deepseek-v4.1-flash" }, "max");
    client.rememberEffort({ provider: "openai", model: "glm-5.3" }, undefined);
    assert.deepStrictEqual(client.readEffortMemory(), {
      "ollama/glm-5.3": "high",
      "ollama/deepseek-v4.1-flash": "max",
      "openai/glm-5.3": "default",
    }, "the in-memory copy is current immediately (the switch never waits for the write)");
    await flush(5);
    const stored = JSON.parse(localStorageDouble.read(client.MEMORY_STORAGE_KEY));
    assert.equal(stored.version, 1);
    assert.equal(stored.efforts["ollama/glm-5.3"], "high", "the idle write lands in the store");
  });

  it("reads a corrupt or foreign value as an empty memory", () => {
    installLocalStorage({ [client.MEMORY_STORAGE_KEY]: "{oops" });
    assert.deepStrictEqual(client.readEffortMemory(), {});
    installLocalStorage({ [client.MEMORY_STORAGE_KEY]: JSON.stringify({ version: 1, efforts: { "a/b": 5, "c/d": "" } }) });
    assert.deepStrictEqual(client.readEffortMemory(), {}, "only non-empty string efforts count");
  });

  it("degrades to no memory when localStorage is unavailable", () => {
    removeLocalStorage();
    assert.deepStrictEqual(client.readEffortMemory(), {});
    assert.doesNotThrow(() => client.rememberEffort({ provider: "a", model: "b" }, "high"));
  });

  it("ignores the retired enabled field when reading the map", () => {
    installLocalStorage({ [client.MEMORY_STORAGE_KEY]: JSON.stringify({ version: 1, enabled: false, efforts: { "a/b": "high" } }) });
    assert.deepStrictEqual(client.readEffortMemory(), { "a/b": "high" });
  });
});

// -- client: switch resolution ----------------------------------------------
describe("resolveSwitchEffort (v1.19)", () => {
  const resolve = client.resolveSwitchEffort;
  const chain = ["high", "medium", "low"];
  const reasoning = { efforts: [{ id: "low" }, { id: "high" }] };

  const config = { chain, remember: true, useChain: true };

  it("applies the remembered effort and records nothing", () => {
    const resolved = resolve({ provider: "b", model: "m2" }, "high", reasoning, config);
    assert.equal(resolved.next.reasoningEffort, "high");
    assert.equal(resolved.record, undefined);
  });

  it("treats a remembered default as 'leave the field alone'", () => {
    const resolved = resolve({ provider: "b", model: "m2", reasoningEffort: "high" }, client.MEMORY_DEFAULT, reasoning, config);
    assert.equal("reasoningEffort" in resolved.next, false);
    assert.equal(resolved.record, undefined);
  });

  it("walks the chain when the model has no memory and records the pick", () => {
    const resolved = resolve({ provider: "b", model: "m2" }, undefined, reasoning, config);
    assert.equal(resolved.next.reasoningEffort, "high");
    assert.equal(resolved.record, "high");
  });

  it("replaces a stale memory with the chain result", () => {
    const resolved = resolve({ provider: "b", model: "m2" }, "max", reasoning, config);
    assert.equal(resolved.next.reasoningEffort, "high", "the model no longer supports max");
    assert.equal(resolved.record, "high", "the stale entry is overwritten after the selection");
  });

  it("falls back to Default and records it when nothing is supported", () => {
    const resolved = resolve({ provider: "b", model: "m2", reasoningEffort: "high" }, undefined, reasoning, { chain: ["xhigh"], remember: true, useChain: true });
    assert.equal("reasoningEffort" in resolved.next, false);
    assert.equal(resolved.record, client.MEMORY_DEFAULT);
  });

  it("leaves DSH's own value alone when the chain switch is off", () => {
    const selection = { provider: "b", model: "m2", reasoningEffort: "low" };
    const resolved = resolve(selection, undefined, reasoning, { chain, remember: true, useChain: false });
    assert.equal(resolved.next.reasoningEffort, "low", "no memory and no chain => the adapter default stands");
    assert.equal(resolved.record, undefined, "nothing is recorded when the chain did not choose");
  });

  it("records nothing when the memory switch is off", () => {
    const resolved = resolve({ provider: "b", model: "m2" }, undefined, reasoning, { chain, remember: false, useChain: true });
    assert.equal(resolved.next.reasoningEffort, "high");
    assert.equal(resolved.record, undefined, "a chain pick is applied but not remembered while the memory is off");
  });

  it("leaves a model without reasoning metadata untouched and unrecorded", () => {
    const selection = { provider: "b", model: "plain" };
    const resolved = resolve(selection, undefined, undefined, config);
    assert.deepEqual(resolved.next, selection);
    assert.equal(resolved.record, undefined);
  });
});

// -- client: directory hook + memory writes ---------------------------------
describe("installReasoningChain (v1.19)", () => {
  const mountWithDirectory = async (directory, presets = CHAIN_PRESETS) => {
    const modelDirectories = makeModelDirectoriesDouble({ directory });
    const mounted = mountClient({
      value: { get: () => ({ presets }) },
      context: { services: { modelDirectories: modelDirectories.service } },
    });
    await flush(5);
    return { mounted, modelDirectories };
  };

  const ALL_EFFORTS = { efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }] };

  it("remembers each model's manual pick and restores it on the way back", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3" },
      reasoning: { "ollama:glm-5.3": ALL_EFFORTS, "ollama:deepseek-v4.1-flash": ALL_EFFORTS },
    });
    const { mounted, modelDirectories } = await mountWithDirectory(directory);
    assert.ok(mounted.serviceInjections.includes("modelDirectories"), "the hook must be installed through a cordis service injection");
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    assert.ok(modelDirectories.calls.length > 0, "directoryFor must be forwarded to the wrapped service");

    // Switch to the other model: no memory yet, so the chain picks high and remembers it.
    await directory.select({ provider: "ollama", model: "deepseek-v4.1-flash" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "high");
    // Manual pick on that model.
    await directory.select({ provider: "ollama", model: "deepseek-v4.1-flash", reasoningEffort: "max" });
    await flush(0);
    // Switch back and forth: glm has no memory yet (the initial current route was not selected
    // through the hook), so the chain picks high and remembers it; deepseek now answers max.
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    assert.equal(directory.calls[2].reasoningEffort, "high");
    await directory.select({ provider: "ollama", model: "deepseek-v4.1-flash" });
    await flush(0);
    assert.equal(directory.calls[3].reasoningEffort, "max", "the remembered manual pick wins over the chain");
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    assert.equal(directory.calls[4].reasoningEffort, "high", "glm keeps its remembered high");
    assert.deepStrictEqual(client.readEffortMemory(), {
      "ollama/deepseek-v4.1-flash": "max",
      "ollama/glm-5.3": "high",
    });
  });

  it("remembers a manual Default so the chain does not come back", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3", reasoningEffort: "high" },
      reasoning: { "ollama:glm-5.3": ALL_EFFORTS, "ollama:other": ALL_EFFORTS },
    });
    const { mounted } = await mountWithDirectory(directory);
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    // Manual Default on the current model.
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    assert.equal(client.readEffortMemory()["ollama/glm-5.3"], "default");
    // Away and back: the remembered default keeps the field undeclared.
    await directory.select({ provider: "ollama", model: "other" });
    await flush(0);
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    assert.equal("reasoningEffort" in directory.calls[2], false, "a remembered default must not be overwritten by the chain");
  });

  it("writes nothing when the selection fails", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3" },
      reasoning: { "ollama:target": ALL_EFFORTS },
      outcome: { ok: false, error: { code: "session/writer-held", message: "busy" } },
    });
    const { mounted } = await mountWithDirectory(directory);
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    await directory.select({ provider: "ollama", model: "target" });
    await flush(0);
    assert.deepStrictEqual(client.readEffortMemory(), {}, "a rejected selection must not be remembered");
  });

  it("replaces the memory when the model no longer supports it", async () => {
    installLocalStorage({ [client.MEMORY_STORAGE_KEY]: JSON.stringify({ version: 1, efforts: { "ollama/target": "max" } }) });
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3" },
      reasoning: { "ollama:target": { efforts: [{ id: "low" }, { id: "high" }] } },
    });
    const { mounted } = await mountWithDirectory(directory);
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    await directory.select({ provider: "ollama", model: "target" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "high");
    assert.equal(client.readEffortMemory()["ollama/target"], "high", "the stale entry is replaced");
  });

  it("follows the chain on every switch and records nothing when the memory is off", async () => {
    installLocalStorage({ [client.MEMORY_STORAGE_KEY]: JSON.stringify({ version: 1, efforts: { "ollama/glm-5.3": "max" } }) });
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3", reasoningEffort: "max" },
      reasoning: {
        "ollama:glm-5.3": { efforts: [{ id: "low" }, { id: "high" }] },
        "ollama:deepseek-v4.1-flash": { efforts: [{ id: "low" }, { id: "high" }] },
      },
    });
    const { mounted } = await mountWithDirectory(directory, { ...CHAIN_PRESETS, rememberEffort: false });
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    await directory.select({ provider: "ollama", model: "deepseek-v4.1-flash" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "high", "no memory => the chain decides");
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    assert.equal(directory.calls[1].reasoningEffort, "high", "the remembered max is ignored while the switch is off");
    assert.equal(client.readEffortMemory()["ollama/glm-5.3"], "max", "the existing entry survives the switch being off");
    assert.equal(client.readEffortMemory()["ollama/deepseek-v4.1-flash"], undefined, "nothing is recorded while off");
  });

  it("leaves DSH's own value alone when the automatic-chain switch is off", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: { provider: "ollama", model: "glm-5.3" },
      reasoning: {
        "ollama:glm-5.3": { efforts: [{ id: "low" }, { id: "high" }] },
        "ollama:target": { efforts: [{ id: "low" }, { id: "high" }] },
      },
    });
    const { mounted } = await mountWithDirectory(directory, { ...CHAIN_PRESETS, useReasoningChain: false });
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    await directory.select({ provider: "ollama", model: "target", reasoningEffort: "low" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "low", "no memory and no chain => the selection reaches DSH as-is");
    assert.deepStrictEqual(client.readEffortMemory(), {}, "the chain did not choose, so nothing is remembered");
    // A manual pick is still remembered (the memory switch is on), so the next switch restores it.
    await directory.select({ provider: "ollama", model: "target", reasoningEffort: "high" });
    await flush(0);
    assert.equal(client.readEffortMemory()["ollama/target"], "high");
    await directory.select({ provider: "ollama", model: "glm-5.3" });
    await flush(0);
    await directory.select({ provider: "ollama", model: "target" });
    await flush(0);
    assert.equal(directory.calls[3].reasoningEffort, "high", "the remembered pick wins even with the chain off");
  });

  it("keeps the plugin usable when the model-selection service is absent", async () => {
    const mounted = mountClient({ value: { get: () => ({ presets: CHAIN_PRESETS }) } });
    await flush(5);
    assert.deepEqual(mounted.serviceInjections, ["modelDirectories"], "the optional service was requested");
    assert.ok(mounted.component("settings.section"), "the Settings section must still register");
  });

  it("applies the built-in chain when the host reply predates v1.19", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: null,
      reasoning: { "b:m2": { efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }] } },
    });
    const modelDirectories = makeModelDirectoriesDouble({ directory });
    const mounted = mountClient({
      value: { get: () => ({ presets: { version: 1, contextWindows: [8192], maxOutputs: [4096], reasoningLevels: ["off", "low", "medium", "high"], reasoningPresets: [] } }) },
      context: { services: { modelDirectories: modelDirectories.service } },
    });
    await flush(5);
    await mounted.ctx.modelDirectories.directoryFor("session-1");
    await directory.select({ provider: "b", model: "m2" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "high", "the built-in chain leads with high");
  });

  it("replaces its hook on a bundle reload instead of stacking stale config (HMR)", async () => {
    installLocalStorage();
    const directory = createModelDirectoryDouble({
      current: null,
      reasoning: { "b:m2": { efforts: [{ id: "low" }, { id: "high" }] } },
    });
    const service = makeModelDirectoriesDouble({ directory }).service;
    const first = mountClient({
      value: { get: () => ({ presets: { version: 1, reasoningLevels: ["off", "low", "high"], reasoningChain: ["low"] } }) },
      context: { services: { modelDirectories: service } },
    });
    await flush(5);
    // A rebuilt bundle re-applies over the same live service instance (HMR never restarts the Host).
    const second = mountClient({
      value: { get: () => ({ presets: { version: 1, reasoningLevels: ["off", "low", "high"], reasoningChain: ["high"] } }) },
      context: { services: { modelDirectories: service } },
    });
    await flush(5);
    assert.ok(first && second);
    await service.directoryFor("session-1");
    await directory.select({ provider: "b", model: "m2" });
    await flush(0);
    assert.equal(directory.calls[0].reasoningEffort, "high", "the latest bundle's chain must win after a reload");
  });
});
