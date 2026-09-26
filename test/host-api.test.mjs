/**
 * `lib/index.js` — host half contract tests (node --test).
 *
 * Covers contract §4 (HTTP API fence + envelope), §4.1 (`get`), §4.2 (`save`),
 * §4.3/§5 (presets + formatCount) and the v1.2 revision (text/image modalities,
 * the seven pi-ai thinking levels, `reasoningEfforts === false` read-back).
 *
 * `save` is locked to the one write shape DSH's path ops support reliably: a single
 * `{ op: "set", path: ["providers", <p>, "models"], value: <whole array> }`.
 * Array-index paths are asserted *against* — see the "materializes" test.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import {
	API_PREFIX,
	PLUGIN_NAME,
	SettingsConflictError,
	callApi,
	findApiRoute,
	loadHost,
	makeHostContext,
	makeLlmDouble,
	makeSettingsDouble
} from "./support/harness.mjs";

const plugin = await loadHost();

// -- fixtures ----------------------------------------------------------------

/** A composed-config fixture: two addressable models, one provider without models. */
const baseConfig = () => ({
	providers: {
		ollama: {
			displayName: "Ollama Local",
			models: [
				{
					id: "deepseek-v4.1-flash",
					name: "deepseek-v4.1-flash",
					contextWindow: 1000000,
					maxTokens: 256000,
					input: ["text", "image"],
					reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
					compat: { supportsStore: false }
				},
				{ id: "tiny-model", name: "tiny-model" }
			]
		},
		openai: { models: [{ id: "gpt-x", contextWindow: 128000 }] },
		"no-models": { displayName: "Empty" }
	}
});

/** A complete user layer for `ollama`, i.e. the shape DSH's profile patch really holds. */
const userConfig = () => ({
	providers: {
		ollama: {
			models: [
				{
					id: "deepseek-v4.1-flash",
					name: "deepseek-v4.1-flash",
					contextWindow: 1000000,
					maxTokens: 256000,
					input: ["text", "image"],
					reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
					compat: { supportsStore: true }
				},
				{ id: "tiny-model", name: "tiny-model" }
			]
		}
	}
});

const mountHost = (services = {}) => {
	const made = makeHostContext(services);
	plugin.apply(made.ctx);
	return made;
};

const presetsFile = () => join(process.env.DSH_HOME, "dsh-model-tweaks", "presets.json");

const writePresetsFile = async (content) => {
	await mkdir(join(process.env.DSH_HOME, "dsh-model-tweaks"), { recursive: true });
	await writeFile(presetsFile(), typeof content === "string" ? content : JSON.stringify(content), "utf8");
};

/** The single `mutate` op a save must emit, asserted to be the whole-array write. */
function singleWriteOp(mutations, providerId) {
	assert.equal(mutations.length, 1, "one save = one mutate call (atomic)");
	assert.equal(mutations[0].ops.length, 1, "one save = one op");
	const [op] = mutations[0].ops;
	assert.equal(op.op, "set");
	assert.deepStrictEqual(op.path, ["providers", providerId, "models"]);
	assert.ok(Array.isArray(op.value), "the op must carry the whole models array");
	return op.value;
}

/** A settings double whose `mutate` always reports a stale revision. */
const conflictingSettings = (message = 'settings namespace "llm-pi-ai" changed since it was read (expected revision 4, now 5)') => ({
	get: () => baseConfig(),
	describe: () => [{ ns: "llm-pi-ai", base: baseConfig(), user: {}, revision: 4, writable: true }],
	async mutate() {
		throw new SettingsConflictError(message);
	}
});

/**
 * The **real 0.1.7-rc.2 `SettingsProvider` shape**: it exposes *no* `get(ns)` method at
 * all — `describe()` is the read surface, and each descriptor carries the projected
 * `value`/`base`/`user` layers. This is the shape that produced the live
 * "Model Capabilities 页没有任何模型" report (`models: []`, `writable: true`,
 * `revision: 0`), so the regression must always be asserted against a double without
 * `get()`: `makeSettingsDouble({ omitGet: true, descriptorValue })` provides exactly that
 * and keeps the projection in sync through `mutate`.
 */

// -- environment -------------------------------------------------------------
const tempDirs = [];
beforeEach(async () => {
	const dir = await mkdtemp(join(tmpdir(), "dsh-model-tweaks-host-"));
	tempDirs.push(dir);
	// Never unset DSH_HOME: an unset value would make a stray write hit the real ~/.dsh.
	process.env.DSH_HOME = dir;
});
afterEach(async () => {
	const dir = tempDirs.pop();
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});
after(async () => {
	for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// -- plugin shape ------------------------------------------------------------
describe("host plugin shape", () => {
	it("exports the contract identity and mounts a prefix route", () => {
		assert.equal(plugin.name, PLUGIN_NAME);
		assert.deepStrictEqual(plugin.inject, ["webServer"]);
		assert.equal(typeof plugin.apply, "function");
		assert.equal("Config" in plugin, false, "the host half must not declare its own Config");

		const { ctx, routes, disposals } = makeHostContext({});
		plugin.apply(ctx);
		const route = findApiRoute(routes, API_PREFIX);
		assert.ok(route, `no route registered at ${API_PREFIX}`);
		assert.equal(route.kind, "prefix");
		assert.equal(typeof route.handler, "function");
		assert.equal(disposals.length, 1, "the route must be registered inside ctx.effect");
	});

	it("survives a host without webServer", () => {
		const ctx = { effect: (fn) => { fn(); }, get: () => undefined };
		assert.doesNotThrow(() => plugin.apply(ctx));
	});
});

// -- fence + envelope --------------------------------------------------------
describe("POST /model-tweaks/api fence and envelope", () => {
	it("rejects a non-loopback Host with 403", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		const response = await callApi(routes, "get", {}, { headers: { host: "evil.example.com" } });
		assert.equal(response.status, 403);
		assert.equal(response.body.ok, false);
		assert.equal(response.body.error.code, "forbidden");
	});

	it("rejects a cross-site fetch and a mismatched Origin with 403", async () => {
		const { routes } = mountHost({});
		const crossSite = await callApi(routes, "get", {}, { headers: { "sec-fetch-site": "cross-site" } });
		assert.equal(crossSite.status, 403);
		const foreignOrigin = await callApi(routes, "get", {}, { headers: { origin: "http://evil.example.com" } });
		assert.equal(foreignOrigin.status, 403);
		const noHost = await callApi(routes, "get", {}, { headers: { host: "" } });
		assert.equal(noHost.status, 403);
	});

	it("rejects non-POST with 405", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", {}, { method: "GET" });
		assert.equal(response.status, 405);
		assert.equal(response.body.error.code, "method-error");
	});

	it("answers 404 for unknown, nested and empty methods", async () => {
		const { routes } = mountHost({});
		const unknown = await callApi(routes, "nope", {});
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.error.code, "not-found");

		const nested = await callApi(routes, "get/extra", {});
		assert.equal(nested.status, 404, "a method containing / must not reach the dispatcher");

		const empty = await callApi(routes, "", {}, { path: `${API_PREFIX}/` });
		assert.equal(empty.status, 404);

		const outside = await callApi(routes, "get", {}, { path: "/other/api/get" });
		assert.equal(outside.status, 404);
	});

	it("rejects a non-JSON content type with 415", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", {}, { headers: { "content-type": "text/plain" } });
		assert.equal(response.status, 415);
		assert.equal(response.body.error.code, "unsupported-media-type");
	});

	it("rejects a body above 1MiB with 413", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", undefined, { raw: "x".repeat(1024 * 1024 + 1) });
		assert.equal(response.status, 413);
		assert.equal(response.body.error.code, "body-too-large");
	});

	it("rejects malformed JSON with 400", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", undefined, { raw: "{oops" });
		assert.equal(response.status, 400);
		assert.equal(response.body.error.code, "bad-json");
	});

	it("wraps successes into { ok: true, value }", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		assert.ok("value" in response.body);
		assert.ok(Array.isArray(response.body.value.models));
	});
});

// -- get ---------------------------------------------------------------------
describe("get", () => {
	it("enumerates providers and models in declaration order", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: {} }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		assert.equal(body.ok, true);
		assert.deepStrictEqual(body.value.models.map((model) => [model.provider, model.id]), [
			["ollama", "deepseek-v4.1-flash"],
			["ollama", "tiny-model"],
			["openai", "gpt-x"]
		]);
		const ollama = body.value.models[0];
		assert.equal(ollama.providerName, "Ollama Local", "displayName wins over the provider key");
		assert.equal(body.value.models[2].providerName, "openai", "providerName falls back to the key");
	});

	it("reports the contract v1.2 modality list, writable and revision", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: {}, revision: 7 }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.modalities, ["text", "image"]);
		assert.equal(body.value.writable, true);
		assert.equal(body.value.revision, 7);
	});

	it("derives writable from the settings provider (v1.6)", async () => {
		const readOnly = mountHost({ settings: makeSettingsDouble({ base: baseConfig(), user: {}, writable: false }).service });
		const blocked = await callApi(readOnly.routes, "get", {});
		assert.equal(blocked.body.value.writable, false, "settings.writable === false must surface as writable: false");

		// A namespace `describe()` does not list cannot be addressed by `mutate`, so it is not writable.
		const notConfigurable = mountHost({ settings: { get: () => baseConfig(), describe: () => [] } });
		const missing = await callApi(notConfigurable.routes, "get", {});
		assert.equal(missing.body.value.writable, false);
		assert.equal(missing.body.value.revision, 0);
		assert.ok(missing.body.value.models.length > 0, "reads still work without a descriptor");
	});

	it("returns the effective values and userDeclared flags of an overridden model", async () => {
		const user = { providers: { ollama: { models: [{ id: "deepseek-v4.1-flash", contextWindow: 131072, input: ["text"] }] } } };
		const settings = makeSettingsDouble({ base: baseConfig(), user }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		const model = body.value.models.find((row) => row.id === "deepseek-v4.1-flash");
		assert.deepStrictEqual(model.effective, { contextWindow: 131072, input: ["text"] });
		assert.equal("maxTokens" in model.effective, false, "unset fields are simply absent");
		assert.equal("reasoningEfforts" in model.effective, false);
		assert.deepStrictEqual(model.userDeclared, {
			contextWindow: true,
			maxTokens: false,
			input: true,
			reasoningEfforts: false
		});
	});

	it("treats a user value identical to the inherited one as Default", async () => {
		// DSH's `mutate` cannot delete a field the base layer owns: an unset writes the
		// inherited value back into the profile override. "Declared" therefore means
		// "present in the user layer and different from the inherited value".
		const user = { providers: { ollama: { models: [{ id: "deepseek-v4.1-flash", contextWindow: 1000000, maxTokens: 4096 }] } } };
		const settings = makeSettingsDouble({ base: baseConfig(), user }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		const model = body.value.models.find((row) => row.id === "deepseek-v4.1-flash");
		assert.equal(model.userDeclared.contextWindow, false, "equal to the inherited value → Default");
		assert.equal(model.userDeclared.maxTokens, true, "differs from the inherited value → declared");
	});

	it("keeps reasoningEfforts === false verbatim (non-reasoning model)", async () => {
		const base = { providers: { ollama: { models: [{ id: "chat-only", reasoningEfforts: false }] } } };
		const settings = makeSettingsDouble({ base, user: {} }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		assert.equal(body.value.models[0].effective.reasoningEfforts, false);
		assert.notDeepStrictEqual(body.value.models[0].effective.reasoningEfforts, {});
	});

	it("reports a materialized input: [] as Default (DSH itself reads it as undeclared)", async () => {
		// A save materializes the resolved array, so `input: []` can appear in the user layer
		// without anyone touching that field. DSH's `declaredInput()` treats [] as absent, so it
		// is the Default state — while a real list that differs from the base layer is declared.
		const base = { providers: { ollama: { models: [{ id: "m1" }, { id: "m2", input: ["text"] }] } } };
		const user = { providers: { ollama: { models: [{ id: "m1", input: [] }, { id: "m2", input: ["text", "image"] }] } } };
		const settings = makeSettingsDouble({ base, user }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		const [first, second] = body.value.models;
		assert.equal(first.userDeclared.input, false);
		assert.equal(second.userDeclared.input, true);
	});

	it("skips providers without a models array and entries without an id", async () => {
		const base = {
			providers: {
				a: { models: [{ name: "no id" }, { id: "ok" }] },
				b: { models: "nope" },
				c: {},
				d: { models: [] }
			}
		};
		const settings = makeSettingsDouble({ base, user: {} }).service;
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.models.map((model) => model.id), ["ok"]);
	});

	it("degrades to an empty, read-only catalog when settings is missing", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200, "a missing settings service must not be a 500");
		assert.deepStrictEqual(response.body.value.models, []);
		assert.equal(response.body.value.writable, false);
		assert.equal(response.body.value.revision, 0);
	});

	it("degrades when the settings service throws", async () => {
		const settings = {
			get() { throw new Error("boom"); },
			describe() { throw new Error("boom"); }
		};
		const { routes } = mountHost({ settings });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		assert.deepStrictEqual(response.body.value.models, []);
		assert.equal(response.body.value.writable, false);
	});

	it("returns the built-in presets without writing a file", async () => {
		const { routes } = mountHost({});
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.presets.reasoningLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepStrictEqual(body.value.presets.contextWindows, [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000]);
		assert.deepStrictEqual(body.value.presets.maxOutputs, [4000, 8000, 16000, 32000, 64000, 128000, 256000]);
		assert.deepStrictEqual(body.value.presets.reasoningPresets.map((preset) => preset.name), ["DeepSeek", "OpenAI Standard", "Simple"]);
		assert.equal(existsSync(presetsFile()), false, "reading defaults must not create the file");
	});
});

// -- get: managed provider filtering (v1.8) ----------------------------------
describe("get — managed provider filtering (v1.8)", () => {
	/**
	 * A composed (base/user) layer declaring five routes, including two with nothing to
	 * manage: `deepseek-account` (the directory reports 0 models) and `composed-only`
	 * (no `models` array at all). Only `ollama` / `openai` / `broken` have anything to manage.
	 */
	const managedComposed = () => ({
		providers: {
			ollama: {
				displayName: "Ollama Local",
				models: [
					{
						id: "deepseek-v4.1-flash",
						name: "deepseek-v4.1-flash",
						contextWindow: 1000000,
						maxTokens: 256000,
						input: ["text", "image"],
						reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
						compat: { supportsStore: true }
					},
					{ id: "tiny-model", name: "tiny-model" }
				]
			},
			openai: { models: [{ id: "gpt-x", name: "gpt-x", contextWindow: 128000 }] },
			broken: { models: [{ id: "broken-1", name: "broken-1" }] },
			"deepseek-account": { models: [] },
			"composed-only": { displayName: "Composed Only" }
		}
	});

	it("manages only configured providers with concrete models, and never probes the rest", async () => {
		const llm = makeLlmDouble({
			providers: [
				{ provider: "ollama", displayName: "Ollama Local", declared: true },
				{ provider: "openai", displayName: "OpenAI" },
				{ provider: "broken", displayName: "Broken", error: "missing api key" },
				{ provider: "anthropic", displayName: "Anthropic", declared: true },
				{ provider: "deepseek-account", displayName: "DeepSeek Account" }
			],
			models: {
				ollama: [
					{ provider: "ollama", id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash" },
					{ provider: "ollama", id: "tiny-model", name: "tiny-model" },
					{ provider: "ollama", id: "kimi-k3", name: "Kimi K3" }
				],
				openai: [{ provider: "openai", id: "gpt-x", name: "gpt-x" }],
				broken: [{ provider: "broken", id: "broken-1", name: "broken-1" }],
				anthropic: [{ provider: "anthropic", id: "claude-x", name: "claude-x" }],
				"deepseek-account": []
			}
		});
		const settings = makeSettingsDouble({ base: managedComposed(), user: {}, revision: 7 }).service;
		const { routes } = mountHost({ settings, llm: llm.service });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		const { providers, models, warnings } = response.body.value;

		// Only configured routes that advertise concrete models are offered for management.
		assert.deepStrictEqual(providers.map((group) => group.provider), ["ollama", "openai", "broken"]);
		// Noise-free: skipping shells is silent; a *configured* route with 0 models is hidden but
		// diagnosed (contract §v1.8: "失败或返回空 → 不显示但必须记一条 warning").
		assert.ok(warnings.includes('provider "deepseek-account" is configured but advertises no models'), JSON.stringify(warnings));
		assert.ok(!warnings.some((text) => /anthropic|no adapter registered/.test(text)), JSON.stringify(warnings));
		assert.ok(!warnings.some((text) => text.includes("failed")), "listing 0 models is not a failure; the two diagnostics must not blur");
		// The unconfigured shell is never probed and never mentioned — this is what kept 39
		// `no adapter registered` shells off the page.
		const probed = llm.calls.filter((call) => call.method === "listModels").map((call) => call.provider);
		assert.deepStrictEqual([...probed].sort(), ["broken", "deepseek-account", "ollama", "openai"]);
		assert.ok(!probed.includes("anthropic"), "an unconfigured provider must not be probed");
		assert.ok(!warnings.some((text) => text.includes("anthropic")), JSON.stringify(warnings));

		// Nothing to manage → the group is hidden, from both views.
		assert.ok(!providers.some((group) => group.provider === "deepseek-account"), "a configured route with 0 models is hidden");
		assert.ok(!providers.some((group) => group.provider === "composed-only"), "a composed-only route with no models is hidden");
		assert.ok(!models.some((model) => model.provider === "deepseek-account"));
		assert.ok(!models.some((model) => model.provider === "composed-only"));

		// Diagnostics still travel on a managed group.
		const [ollama, openai, broken] = providers;
		assert.equal(ollama.displayName, "Ollama Local");
		assert.equal(ollama.declared, true);
		assert.equal(ollama.error, null);
		assert.equal(openai.displayName, "OpenAI");
		assert.equal(openai.declared, false, "declared is the directory flag, defaulted to false");
		assert.equal(openai.error, null);
		assert.equal(broken.error, "missing api key", "the directory error must be visible on a managed group");
		assert.deepStrictEqual(ollama.models.map((model) => model.id), ["deepseek-v4.1-flash", "tiny-model", "kimi-k3"]);

		// The compatibility list is the same rows as the groups, flattened.
		assert.deepStrictEqual(models, providers.flatMap((group) => group.models));
		assert.deepStrictEqual(models.map((model) => [model.provider, model.id]), [
			["ollama", "deepseek-v4.1-flash"],
			["ollama", "tiny-model"],
			["ollama", "kimi-k3"],
			["openai", "gpt-x"],
			["broken", "broken-1"]
		]);

		// A directory-only model has no declared config entry → empty effective view + Default flags.
		const directoryOnly = ollama.models.find((model) => model.id === "kimi-k3");
		assert.deepStrictEqual(directoryOnly.effective, {});
		assert.deepStrictEqual(directoryOnly.userDeclared, { contextWindow: false, maxTokens: false, input: false, reasoningEfforts: false });
		assert.equal(directoryOnly.providerName, "Ollama Local");
		// A declared model keeps its configuration view.
		assert.equal(ollama.models[0].effective.contextWindow, 1000000);
	});

	it("skips a catalog shell the user never configured, without probing or warning about it", async () => {
		const llm = makeLlmDouble({
			providers: [
				{ provider: "ollama", displayName: "ollama" },
				{ provider: "openai", displayName: "openai" },
				{ provider: "anthropic", displayName: "anthropic" }
			],
			models: {
				ollama: [{ provider: "ollama", id: "m1", name: "m1" }],
				openai: [{ provider: "openai", id: "m2", name: "m2" }],
				anthropic: [{ provider: "anthropic", id: "m3", name: "m3" }]
			}
		});
		const settings = makeSettingsDouble({ base: { providers: { ollama: { models: [{ id: "m1" }] } } }, user: {} }).service;
		const { routes } = mountHost({ settings, llm: llm.service });
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.providers.map((group) => group.provider), ["ollama"]);
		assert.deepStrictEqual(body.value.models.map((model) => model.id), ["m1"]);
		assert.deepStrictEqual(llm.calls.filter((call) => call.method === "listModels").map((call) => call.provider), ["ollama"]);
		assert.deepStrictEqual(body.value.warnings, []);
	});

	it("does not sweep dozens of unregistered shells when one provider is configured", async () => {
		// The live report: 42 catalog routes, 39 of them unregistered shells that each answer
		// `no adapter registered`. Only `ollama` is configured, so only `ollama` may be probed.
		const shells = Array.from({ length: 39 }, (_, index) => ({ provider: `shell-${index}`, displayName: `shell-${index}` }));
		const llm = makeLlmDouble({
			providers: [{ provider: "ollama", displayName: "ollama" }, ...shells],
			models: {
				ollama: [
					{ provider: "ollama", id: "m1", name: "m1" },
					{ provider: "ollama", id: "m2", name: "m2" },
					{ provider: "ollama", id: "m3", name: "m3" },
					{ provider: "ollama", id: "m4", name: "m4" }
				]
			},
			// Every shell would fail loudly if the host probed it.
			failing: shells.map((shell) => shell.provider)
		});
		const settings = makeSettingsDouble({ base: { providers: { ollama: { models: [{ id: "m1" }] } } }, user: {} }).service;
		const { routes } = mountHost({ settings, llm: llm.service });
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.providers.map((group) => group.provider), ["ollama"]);
		assert.equal(body.value.models.length, 4, "the one managed provider keeps all four directory models");
		assert.deepStrictEqual(body.value.warnings, [], "39 untouched shells must produce zero warnings");
		assert.deepStrictEqual(llm.calls.filter((call) => call.method === "listModels").map((call) => call.provider), ["ollama"]);
	});

	it("falls back to the composed providers when llm is unavailable", async () => {
		const settings = makeSettingsDouble({ base: managedComposed(), user: {}, revision: 3 }).service;
		const { routes } = mountHost({ settings });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200, "a missing llm service must not be a 500");
		const { providers, models, warnings } = response.body.value;
		assert.ok(warnings.some((text) => text.includes("llm service is unavailable")), JSON.stringify(warnings));
		assert.deepStrictEqual(providers.map((group) => group.provider), ["ollama", "openai", "broken"], "no directory, so every configured route with models is shown");
		assert.deepStrictEqual(models.map((model) => model.id), ["deepseek-v4.1-flash", "tiny-model", "gpt-x", "broken-1"]);
		assert.deepStrictEqual(providers.map((group) => group.declared), [false, false, false]);
		assert.equal(providers[0].displayName, "Ollama Local");
		assert.equal(models[0].effective.contextWindow, 1000000, "the composed fallback keeps real effective values");
	});

	it("still manages the configured providers when the catalog cannot be read", async () => {
		const llm = {
			listConfigurableProviders() { throw new Error("catalog offline"); },
			async listModels() { return []; }
		};
		const settings = makeSettingsDouble({ base: managedComposed(), user: {} }).service;
		const { routes } = mountHost({ settings, llm });
		const { body } = await callApi(routes, "get", {});
		assert.ok(body.value.warnings.some((text) => text.includes("llm.listConfigurableProviders failed: catalog offline")), JSON.stringify(body.value.warnings));
		assert.deepStrictEqual(body.value.providers.map((group) => group.provider), ["ollama", "openai", "broken"]);
	});

	it("hides a configured provider whose listModels fails, and warns about it", async () => {
		const llm = makeLlmDouble({
			providers: [{ provider: "ok", displayName: "OK" }, { provider: "flaky", displayName: "Flaky" }],
			models: { ok: [{ provider: "ok", id: "ok-1", name: "ok-1" }], flaky: [{ provider: "flaky", id: "flaky-1", name: "flaky-1" }] },
			failing: ["flaky"]
		});
		const settings = makeSettingsDouble({
			base: { providers: { ok: { models: [{ id: "ok-1" }] }, flaky: { models: [{ id: "flaky-1" }] } } },
			user: {}
		}).service;
		const { routes } = mountHost({ settings, llm: llm.service });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200, "one broken configured route must not fail the page");
		assert.deepStrictEqual(response.body.value.providers.map((group) => group.provider), ["ok"]);
		const { warnings } = response.body.value;
		// The failure diagnostic, verbatim and *only* that one: a throw must not also produce the
		// "advertises no models" line, and vice versa.
		assert.deepStrictEqual(warnings, ['llm.listModels("flaky") failed: llm service failed to list models for provider "flaky"']);
		assert.ok(!warnings.some((text) => text.includes("advertises no models")), JSON.stringify(warnings));
	});

	it("uses the quiet directory sweep when nothing is configured", async () => {
		const llm = makeLlmDouble({
			providers: [{ provider: "shell-a", displayName: "A" }, { provider: "shell-b", displayName: "B" }, { provider: "shell-c", displayName: "C" }],
			models: { "shell-a": [{ provider: "shell-a", id: "a1", name: "a1" }], "shell-b": [] },
			failing: ["shell-c"]
		});
		// Nothing is configured: the composed document declares no providers at all.
		const settings = makeSettingsDouble({ base: {}, user: {} }).service;
		const { routes } = mountHost({ settings, llm: llm.service });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		const { providers, models, warnings } = response.body.value;
		assert.deepStrictEqual(providers.map((group) => group.provider), ["shell-a"], "only routes that really advertise models survive the sweep");
		assert.deepStrictEqual(models, providers.flatMap((group) => group.models), "the flat list stays consistent after filtering");
		assert.deepStrictEqual(providers[0].models.map((model) => model.id), ["a1"]);
		// Exactly one summary warning: the empty shell and the failing shell stay silent. The
		// `quiet` sweep deliberately suppresses both the failure text and the
		// "advertises no models" diagnostic — "configured ⇒ diagnose, unconfigured ⇒ don't nag".
		assert.deepStrictEqual(warnings, ["no configured providers were found; showing the adapter directory instead"]);
	});
});

// -- get/save without settings.get() (real 0.1.7 provider shape) --------------
describe("settings provider without get() (real runtime shape)", () => {
	const realShapeValue = () => ({
		providers: {
			ollama: {
				displayName: "Ollama Local",
				models: [{
					id: "deepseek-v4.1-flash",
					name: "deepseek-v4.1-flash",
					contextWindow: 131072,
					input: ["text"],
					reasoningEfforts: { off: null, high: "high" }
				}]
			}
		}
	});

	it("reads the effective value from describe().value when the provider has no get()", async () => {
		const settings = makeSettingsDouble({ omitGet: true, descriptorValue: realShapeValue(), revision: 2 });
		assert.equal("get" in settings.service, false, "the real 0.1.7 provider exposes no get()");
		assert.equal(typeof settings.service.get, "undefined");
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		assert.equal(response.body.value.models.length, 1, "the live defect was models: [] here");
		const model = response.body.value.models[0];
		assert.equal(model.id, "deepseek-v4.1-flash");
		assert.equal(model.effective.contextWindow, 131072);
		assert.deepStrictEqual(model.effective.input, ["text"]);
		assert.deepStrictEqual(model.effective.reasoningEfforts, { off: null, high: "high" });
		assert.deepStrictEqual(model.userDeclared, { contextWindow: false, maxTokens: false, input: false, reasoningEfforts: false });
		const [group] = response.body.value.providers;
		assert.equal(group.provider, "ollama");
		assert.equal(group.displayName, "Ollama Local");
		assert.deepStrictEqual(group.models, [model], "the flat list mirrors the groups");
		assert.equal(response.body.value.revision, 2);
		assert.equal(response.body.value.writable, true);
		assert.ok(
			!response.body.value.warnings.some((text) => text.includes("settings service is unavailable")),
			JSON.stringify(response.body.value.warnings)
		);
	});

	it("saves through describe().value when the provider has no get()", async () => {
		const settings = makeSettingsDouble({
			omitGet: true,
			revision: 2,
			descriptorValue: {
				providers: {
					ollama: {
						models: [{
							id: "deepseek-v4.1-flash",
							name: "deepseek-v4.1-flash",
							contextWindow: 1000000,
							maxTokens: 256000,
							compat: { supportsStore: true }
						}]
					}
				}
			}
		});
		assert.equal("get" in settings.service, false);
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { contextWindow: 131072, maxTokens: null }
		});
		assert.equal(response.status, 200, "save must not need settings.get() either");
		// Still one atomic whole-array op, into the user layer.
		const entries = singleWriteOp(settings.mutations, "ollama");
		assert.deepStrictEqual(entries, [{ id: "deepseek-v4.1-flash", name: "deepseek-v4.1-flash", contextWindow: 131072, compat: { supportsStore: true } }]);
		assert.equal(settings.mutations[0].expectedRevision, 2);
		assert.deepStrictEqual(settings.state.user.providers.ollama.models, entries);
		// The provider's live projection moved with the write, which is what the post-save re-read reads.
		assert.deepStrictEqual(settings.descriptorValue.providers.ollama.models, entries);
		const model = response.body.value.model;
		assert.equal(model.effective.contextWindow, 131072);
		assert.equal("maxTokens" in model.effective, false, "Default deleted the field");
		assert.deepStrictEqual(model.userDeclared, { contextWindow: true, maxTokens: false, input: false, reasoningEfforts: false });
	});

	it("falls back to settings.get(ns) when a descriptor carries no value (0.1.5 provider)", async () => {
		// The compatibility half of the v1.8 fix: a provider with `get()` but a descriptor
		// without `value` must still list models through the legacy read surface.
		const settings = {
			get: () => ({ providers: { ollama: { models: [{ id: "legacy-model", contextWindow: 65536 }] } } }),
			describe: () => [{ ns: "llm-pi-ai", base: {}, user: {}, revision: 9, writable: true }],
			async mutate() { throw new Error("not used by this test"); }
		};
		const { routes } = mountHost({ settings });
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.models.map((model) => model.id), ["legacy-model"]);
		assert.equal(body.value.models[0].effective.contextWindow, 65536);
		assert.equal(body.value.revision, 9, "the descriptor still supplies revision/writability");
		assert.equal(body.value.writable, true);
	});
});

// -- save --------------------------------------------------------------------
describe("save", () => {
	it("commits one atomic op that rewrites the whole models array", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 3 });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			// A hostile client index must be ignored: tiny-model is at index 1 in the live config.
			model: "tiny-model",
			index: 99,
			changes: { contextWindow: 131072, maxTokens: 4096 }
		});
		assert.equal(response.status, 200);
		const models = singleWriteOp(settings.mutations, "ollama");
		assert.equal(models[1].id, "tiny-model", "the model is resolved by id, never by a client index");
		assert.equal(models[1].contextWindow, 131072);
		assert.equal(models[1].maxTokens, 4096);
		assert.equal(settings.mutations[0].expectedRevision, 3, "the revision read from describe() is sent back");
		assert.equal(settings.state.user.providers.ollama.models[1].contextWindow, 131072);
	});

	it("materializes every entry and deletes only the Default fields", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 2 });
		const before = settings.service.get("llm-pi-ai").providers.ollama.models;
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { contextWindow: null, maxTokens: null, input: null, reasoningEfforts: null }
		});
		assert.equal(response.status, 200);
		const models = singleWriteOp(settings.mutations, "ollama");
		assert.equal(models.length, before.length, "every model entry is carried over");
		for (const field of ["contextWindow", "maxTokens", "input", "reasoningEfforts"]) {
			assert.equal(Object.hasOwn(models[0], field), false, `${field}: Default deletes the field, it never writes a sentinel`);
		}
		assert.equal(models[0].name, "deepseek-v4.1-flash", "unmanaged fields survive the rewrite");
		assert.deepStrictEqual(models[0].compat, { supportsStore: true });
		assert.deepStrictEqual(models[1], before[1], "untouched entries are byte-identical");
		assert.deepStrictEqual(settings.state.user.providers.ollama.models, models, "the user layer receives the materialized array");
	});

	it("keeps untouched models and fields alone (partial save)", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 2 });
		const before = settings.service.get("llm-pi-ai").providers.ollama.models;
		const { routes } = mountHost({ settings: settings.service });
		await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { maxTokens: 8192 } });
		const models = singleWriteOp(settings.mutations, "ollama");
		assert.equal(models[0].maxTokens, 8192);
		assert.equal(models[0].contextWindow, 1000000, "an untouched field keeps its value");
		assert.deepStrictEqual(models[0].input, ["text", "image"]);
		assert.deepStrictEqual(models[0].reasoningEfforts, before[0].reasoningEfforts);
		assert.deepStrictEqual(Object.keys(models[0]), Object.keys(before[0]), "no field is added or dropped");
		assert.deepStrictEqual(models[1], before[1], "the other model entry is untouched");
	});

	it("writes reasoningEfforts with off → null and pi-ai escalation order", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 1 });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { reasoningEfforts: { max: "max", off: null, low: "low" } }
		});
		assert.equal(response.status, 200);
		const entry = singleWriteOp(settings.mutations, "ollama")[0];
		assert.deepStrictEqual(Object.keys(entry.reasoningEfforts), ["off", "low", "max"], "key order follows escalation order");
		assert.equal(entry.reasoningEfforts.off, null);
		assert.equal(entry.reasoningEfforts.low, "low");
	});

	it("preserves a caller-provided wire value and a deliberately empty input list", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 1 });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { reasoningEfforts: { low: "minimal-wire" }, input: [] }
		});
		assert.equal(response.status, 200);
		const entry = singleWriteOp(settings.mutations, "ollama")[0];
		assert.equal(entry.reasoningEfforts.low, "minimal-wire", "an explicit wire value is kept verbatim");
		assert.deepStrictEqual(entry.input, [], "[] is a legal declaration (DSH itself reads it as undeclared)");
	});

	it("returns the re-read model after saving", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 3 });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { contextWindow: 131072, maxTokens: null, input: ["text"], reasoningEfforts: { low: "low", max: "max" } }
		});
		assert.equal(response.status, 200);
		assert.equal(response.body.ok, true);
		const model = response.body.value.model;
		assert.equal(model.provider, "ollama");
		assert.equal(model.id, "deepseek-v4.1-flash");
		assert.deepStrictEqual(model.effective, {
			contextWindow: 131072,
			input: ["text"],
			reasoningEfforts: { low: "low", max: "max" }
		});
		assert.deepStrictEqual(model.userDeclared, {
			contextWindow: true,
			maxTokens: false,
			input: true,
			reasoningEfforts: true
		});
	});

	it("does not mutate when changes is empty", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), revision: 5 });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: {} });
		assert.equal(response.status, 200);
		assert.equal(settings.mutations.length, 0);
		assert.equal(response.body.value.model.id, "deepseek-v4.1-flash");
		assert.equal(settings.state.revision, 5, "no-op saves must not bump the revision");
	});

	it("saves a model that only the llm directory advertises (v1.7)", async () => {
		// No settings layer declares `models` for this provider: the catalog is the only source,
		// and the model must still be savable instead of answering model-not-found.
		const settings = makeSettingsDouble({ base: { providers: { ollama: { displayName: "Ollama Local" } } }, user: {}, revision: 4 });
		const llm = makeLlmDouble({
			providers: [{ provider: "ollama", displayName: "Ollama Local" }],
			models: { ollama: [{ provider: "ollama", id: "kimi-k3", name: "Kimi K3" }] }
		});
		const { routes } = mountHost({ settings: settings.service, llm: llm.service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "kimi-k3",
			changes: { contextWindow: 131072, reasoningEfforts: { low: "low" } }
		});
		assert.equal(response.status, 200, "a directory-only model must be savable");
		const models = singleWriteOp(settings.mutations, "ollama");
		assert.deepStrictEqual(models, [{ id: "kimi-k3", name: "Kimi K3", contextWindow: 131072, reasoningEfforts: { low: "low" } }]);
		assert.equal(settings.mutations[0].expectedRevision, 4);
		// The post-save re-read goes through the same catalog path.
		const model = response.body.value.model;
		assert.equal(model.provider, "ollama");
		assert.equal(model.id, "kimi-k3");
		assert.equal(model.providerName, "Ollama Local");
		assert.deepStrictEqual(model.effective, { contextWindow: 131072, reasoningEfforts: { low: "low" } });
		assert.deepStrictEqual(model.userDeclared, { contextWindow: true, maxTokens: false, input: false, reasoningEfforts: true });
	});

	it("rejects non-positive or non-integer sizes with 400", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		for (const changes of [{ contextWindow: 0 }, { contextWindow: -1 }, { contextWindow: 1.5 }, { contextWindow: "131072" }, { maxTokens: 0 }]) {
			const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes });
			assert.equal(response.status, 400, JSON.stringify(changes));
			assert.equal(response.body.error.code, "bad-request");
		}
		// A real HTTP body cannot carry NaN (`JSON.stringify(NaN)` is `null`, i.e. Default), but it
		// can carry a non-finite number: 1e999 parses to Infinity, which must be refused.
		const infinite = await callApi(routes, "save", undefined, {
			raw: '{"provider":"ollama","model":"deepseek-v4.1-flash","changes":{"maxTokens":1e999}}'
		});
		assert.equal(infinite.status, 400, "1e999 (Infinity) is not a positive integer");
		assert.equal(infinite.body.error.code, "bad-request");
	});

	it("rejects an out-of-enum input modality with 400 (v1.2: text/image only)", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		for (const input of [["audio"], ["video"], ["text", "nope"], "text", [1]]) {
			const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { input } });
			assert.equal(response.status, 400, JSON.stringify(input));
			assert.equal(response.body.error.code, "bad-request");
		}
		const audio = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { input: ["audio"] } });
		assert.match(audio.body.error.message, /audio/);
		assert.match(audio.body.error.message, /text, image/);
	});

	it("rejects unsupported reasoning levels with 400 naming the level (v1.2)", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		const response = await callApi(routes, "save", {
			provider: "ollama",
			model: "deepseek-v4.1-flash",
			changes: { reasoningEfforts: { none: null, low: "low" } }
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error.code, "bad-request");
		assert.match(response.body.error.message, /"none"/);
		assert.match(response.body.error.message, /off\/minimal\/low\/medium\/high\/xhigh\/max/);
	});

	it("rejects an off-only, empty or invalid reasoningEfforts map", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		for (const reasoningEfforts of [{ off: null }, {}, { low: null }, { low: "" }, { low: 3 }, false, "low", []]) {
			const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { reasoningEfforts } });
			assert.equal(response.status, 400, JSON.stringify(reasoningEfforts));
			assert.equal(response.body.error.code, "bad-request");
		}
	});

	it("answers 400 model-not-found for an unknown provider or model", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		const unknownModel = await callApi(routes, "save", { provider: "ollama", model: "ghost", changes: { maxTokens: 4096 } });
		assert.equal(unknownModel.status, 400);
		assert.equal(unknownModel.body.error.code, "model-not-found");
		const unknownProvider = await callApi(routes, "save", { provider: "ghost", model: "gpt-x", changes: { maxTokens: 4096 } });
		assert.equal(unknownProvider.status, 400);
		assert.equal(unknownProvider.body.error.code, "model-not-found");
	});

	it("requires provider and model and a changes object", async () => {
		const { routes } = mountHost({ settings: makeSettingsDouble({ base: baseConfig() }).service });
		for (const body of [{}, { provider: "ollama" }, { model: "tiny-model" }, { provider: "ollama", model: "tiny-model" }, { provider: "ollama", model: "tiny-model", changes: 5 }]) {
			const response = await callApi(routes, "save", body);
			assert.equal(response.status, 400, JSON.stringify(body));
			assert.equal(response.body.error.code, "bad-request");
		}
	});

	it("refuses to save when the settings provider is read-only (v1.6)", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig(), writable: false });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { maxTokens: 8192 } });
		assert.equal(response.status, 409);
		assert.equal(response.body.error.code, "settings-read-only");
		assert.equal(settings.mutations.length, 0, "a read-only namespace must not be written");
	});

	it("rejects a change key outside the managed fields with 400 (v1.6)", async () => {
		const settings = makeSettingsDouble({ base: baseConfig(), user: userConfig() });
		const { routes } = mountHost({ settings: settings.service });
		const response = await callApi(routes, "save", { provider: "ollama", model: "deepseek-v4.1-flash", changes: { maxOutput: 4096 } });
		assert.equal(response.status, 400, "a typo must fail loudly instead of reporting a save that never happened");
		assert.equal(response.body.error.code, "bad-request");
		assert.match(response.body.error.message, /unknown field "maxOutput"/);
		assert.match(response.body.error.message, /contextWindow, maxTokens, input, reasoningEfforts/);
		assert.equal(settings.mutations.length, 0);
	});

	it("maps SettingsConflictError to 409 with the host message", async () => {
		const { routes } = mountHost({ settings: conflictingSettings() });
		const response = await callApi(routes, "save", { provider: "ollama", model: "tiny-model", changes: { maxTokens: 4096 } });
		assert.equal(response.status, 409);
		assert.equal(response.body.ok, false);
		assert.equal(response.body.error.code, "settings-conflict");
		assert.match(response.body.error.message, /changed since it was read/);
	});

	it("answers 500 settings-unavailable when the service is missing", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "save", { provider: "ollama", model: "tiny-model", changes: { maxTokens: 4096 } });
		assert.equal(response.status, 500);
		assert.equal(response.body.error.code, "settings-unavailable");
	});

	it("propagates an unexpected mutate failure as a 500", async () => {
		const settings = {
			get: () => baseConfig(),
			describe: () => [{ ns: "llm-pi-ai", base: baseConfig(), user: {}, revision: 1, writable: true }],
			async mutate() { throw new Error("disk on fire"); }
		};
		const { routes } = mountHost({ settings });
		const response = await callApi(routes, "save", { provider: "ollama", model: "tiny-model", changes: { maxTokens: 4096 } });
		assert.equal(response.status, 500);
		assert.equal(response.body.error.code, "internal");
		assert.match(response.body.error.message, /disk on fire/);
	});
});

// -- presets -----------------------------------------------------------------
describe("presets", () => {
	it("normalizes, persists and returns the submitted document", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", {
			action: "save",
			payload: {
				version: 9,
				contextWindows: [16384, 8192, 8192, 4096],
				maxOutputs: [8192, 4096, 4096],
				reasoningLevels: ["high", "low", "high", "off"],
				reasoningPresets: [{ id: "p-custom", name: "Custom", levels: ["high", "high", "low"] }]
			}
		});
		assert.equal(response.status, 200);
		assert.deepStrictEqual(response.body.value.presets, {
			version: 1,
			contextWindows: [4096, 8192, 16384],
			maxOutputs: [4096, 8192],
			reasoningLevels: ["high", "low", "off"],
			reasoningPresets: [{ id: "p-custom", name: "Custom", levels: ["high", "low"] }]
		});
		const onDisk = JSON.parse(await readFile(presetsFile(), "utf8"));
		assert.deepStrictEqual(onDisk, response.body.value.presets);
		// And a later read returns the persisted document.
		const reread = await callApi(routes, "get", {});
		assert.deepStrictEqual(reread.body.value.presets, response.body.value.presets);
	});

	it("rejects a preset referencing an unknown level with 400 naming it", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", {
			action: "save",
			payload: {
				contextWindows: [8192],
				maxOutputs: [4096],
				reasoningLevels: ["low", "high"],
				reasoningPresets: [{ name: "Broken", levels: ["low", "none"] }]
			}
		});
		assert.equal(response.status, 400);
		assert.equal(response.body.error.code, "bad-request");
		assert.match(response.body.error.message, /"Broken"/);
		assert.match(response.body.error.message, /"none"/);
		assert.equal(existsSync(presetsFile()), false, "a rejected save must not write the file");
	});

	it("rejects an unusable shape with 400", async () => {
		const { routes } = mountHost({});
		const base = { contextWindows: [8192], maxOutputs: [4096], reasoningLevels: ["low"], reasoningPresets: [] };
		const payloads = [
			{ ...base, contextWindows: [0] },
			{ ...base, contextWindows: [1.5] },
			{ ...base, contextWindows: "8192" },
			{ ...base, maxOutputs: [] , contextWindows: undefined },
			{ ...base, reasoningLevels: [] },
			{ ...base, reasoningLevels: [""] },
			{ ...base, reasoningPresets: "no" },
			{ ...base, reasoningPresets: [{ name: "", levels: ["low"] }] },
			{ ...base, reasoningPresets: [{ name: "X", levels: [1] }] },
			"nope"
		];
		for (const payload of payloads) {
			const response = await callApi(routes, "presets", { action: "save", payload });
			assert.equal(response.status, 400, JSON.stringify(payload));
			assert.equal(response.body.error.code, "bad-request");
		}
	});

	it("mints stable unique preset ids when they are missing or duplicated", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", {
			action: "save",
			payload: {
				contextWindows: [8192],
				maxOutputs: [4096],
				reasoningLevels: ["low", "high"],
				reasoningPresets: [{ name: "No id", levels: ["low"] }, { id: "dup", name: "First", levels: ["high"] }, { id: "dup", name: "Second", levels: ["low"] }]
			}
		});
		assert.equal(response.status, 200);
		const presets = response.body.value.presets.reasoningPresets;
		const ids = presets.map((preset) => preset.id);
		assert.equal(new Set(ids).size, 3, `ids must be unique: ${JSON.stringify(ids)}`);
		assert.ok(ids.every((id) => typeof id === "string" && id !== ""));
		assert.equal(presets[1].id, "dup", "a usable caller id is preserved");
	});

	it("reads a valid file back in normalized form", async () => {
		await writePresetsFile({
			version: 1,
			contextWindows: [32768, 8192, 8192],
			maxOutputs: [131072, 4096],
			reasoningLevels: ["max", "off", "low"],
			reasoningPresets: [{ id: "p-mine", name: "Mine", levels: ["low", "max"] }]
		});
		const { routes } = mountHost({});
		const { body } = await callApi(routes, "get", {});
		assert.deepStrictEqual(body.value.presets.contextWindows, [8192, 32768]);
		assert.deepStrictEqual(body.value.presets.maxOutputs, [4096, 131072]);
		assert.deepStrictEqual(body.value.presets.reasoningLevels, ["max", "off", "low"], "user order is preserved");
		assert.deepStrictEqual(body.value.presets.reasoningPresets, [{ id: "p-mine", name: "Mine", levels: ["low", "max"] }]);
	});

	it("falls back to the built-ins for a corrupt file and warns", async () => {
		await writePresetsFile("{ this is not json");
		const { routes, logs } = mountHost({});
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200, "a corrupt preset file must not be a 500");
		assert.deepStrictEqual(response.body.value.presets.reasoningLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		assert.deepStrictEqual(response.body.value.presets.reasoningPresets.map((preset) => preset.name), ["DeepSeek", "OpenAI Standard", "Simple"]);
		assert.ok(logs.some(([level, message]) => level === "warn" && /not valid JSON/.test(message)), JSON.stringify(logs));
	});

	it("falls back to the built-ins for a structurally wrong file and warns", async () => {
		await writePresetsFile({ version: 1, contextWindows: ["8K"], maxOutputs: [], reasoningLevels: [], reasoningPresets: [] });
		const { routes, logs } = mountHost({});
		const response = await callApi(routes, "get", {});
		assert.equal(response.status, 200);
		assert.deepStrictEqual(response.body.value.presets.contextWindows, [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000]);
		assert.ok(logs.some(([level, message]) => level === "warn" && /unusable preset structure/.test(message)), JSON.stringify(logs));
	});

	it("resetDefaults returns and persists the built-ins", async () => {
		await writePresetsFile({
			version: 1,
			contextWindows: [8192],
			maxOutputs: [4096],
			reasoningLevels: ["low"],
			reasoningPresets: [{ id: "p-one", name: "One", levels: ["low"] }]
		});
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", { action: "resetDefaults" });
		assert.equal(response.status, 200);
		assert.equal(response.body.value.presets.reasoningLevels.length, 7);
		assert.deepStrictEqual(response.body.value.presets.reasoningPresets.map((preset) => preset.name), ["DeepSeek", "OpenAI Standard", "Simple"]);
		assert.deepStrictEqual(response.body.value.presets.contextWindows, [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000]);
		assert.deepStrictEqual(response.body.value.presets.maxOutputs, [4000, 8000, 16000, 32000, 64000, 128000, 256000]);
		const onDisk = JSON.parse(await readFile(presetsFile(), "utf8"));
		assert.deepStrictEqual(onDisk, response.body.value.presets);
	});

	it("rejects an unknown action with 400", async () => {
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", { action: "drop" });
		assert.equal(response.status, 400);
		assert.equal(response.body.error.code, "bad-request");
		assert.match(response.body.error.message, /drop/);
	});

	it("answers 500 when the preset file cannot be written", async () => {
		// DSH_HOME points at a regular file, so mkdir/write under it must fail.
		const blocked = join(process.env.DSH_HOME, "blocked");
		await writeFile(blocked, "not a directory", "utf8");
		process.env.DSH_HOME = blocked;
		const { routes } = mountHost({});
		const response = await callApi(routes, "presets", { action: "resetDefaults" });
		assert.equal(response.status, 500);
		assert.equal(response.body.error.code, "presets-write-failed");
	});
});

// -- formatCount -------------------------------------------------------------
describe("formatCount", () => {
	it("formats counts with the v1.11 decimal-only semantics", () => {
		// Kept byte-for-byte identical to shell-dev's `FORMAT_COUNT_CASES` so the host and
		// client copies of `formatCount` cannot drift apart silently.
		const cases = [
			[1000000, "1M"], [128000, "128K"], [200000, "200K"], [1000, "1K"], [100000000, "100M"],
			[1048576, "1048576"], [131072, "131072"], [262144, "262144"], [32768, "32768"],
			[8192, "8192"], [4096, "4096"], [524288, "524288"], [1024, "1024"],
			[2097152, "2097152"], [199999, "199999"], [8, "8"], [500, "500"], [0, "0"]
		];
		for (const [value, expected] of cases) assert.equal(plugin.formatCount(value), expected, `formatCount(${value})`);
	});

	it("exposes the built-in preset document for the client's fallback", () => {
		assert.equal(plugin.DEFAULT_PRESETS.version, 1);
		assert.deepStrictEqual(plugin.DEFAULT_PRESETS.reasoningLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
		// v1.10/v1.11: the built-in value lists are decimal — every entry is a multiple of 1000,
		// so each one abbreviates (or prints) as its own decimal value. A binary value such as
		// 8192/1048576 would no longer be a decimal round number, which is exactly what this
		// pair of assertions catches if someone puts one back into the defaults.
		assert.deepStrictEqual(plugin.DEFAULT_PRESETS.contextWindows, [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000]);
		assert.deepStrictEqual(plugin.DEFAULT_PRESETS.maxOutputs, [4000, 8000, 16000, 32000, 64000, 128000, 256000]);
		for (const value of [...plugin.DEFAULT_PRESETS.contextWindows, ...plugin.DEFAULT_PRESETS.maxOutputs]) {
			assert.equal(value % 1000, 0, `built-in default ${value} must be a decimal round number`);
			const expected = value % 1000000 === 0 ? `${value / 1000000}M` : `${value / 1000}K`;
			assert.equal(plugin.formatCount(value), expected, `built-in default ${value} must abbreviate decimally`);
		}
	});
});
