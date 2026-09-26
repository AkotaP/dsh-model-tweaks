/**
 * dsh-model-tweaks — host half (contract v1.2/v1.3).
 *
 * Exposes a fenced JSON API under `/model-tweaks/api/*` that the plugin's Settings
 * section calls to read and edit per-model capabilities of the DSH settings
 * namespace `llm-pi-ai`:
 *
 *   get     {}                          → models + presets + writable + revision + modalities
 *   save    { provider, model, changes } → one atomic `mutate` on the edited model
 *   presets { action, payload }         → save | resetDefaults
 *
 * Zero external dependencies: the settings service is reached through a lenient
 * `ctx.get("settings")` read (never a bare import).
 *
 * Write strategy — the whole `models` array, never an array index:
 * `mutate`'s path ops do not index arrays reliably (the runtime `applyPathOp`
 * treats a non-plain-object child as replaceable, so `path: [..., "models", 0, field]`
 * silently no-ops for `unset` and turns the array into `{"0": …}` for `set`).
 * The official DSH models UI therefore materializes the array: clone the resolved
 * `models` array, edit one entry, and submit one `{ op: "set", path: ["providers",
 * providerId, "models"], value: nextModels }`. Because `mergeLayers` replaces arrays
 * wholesale, that write overrides the base layer (cordis.patch.yml) array — which is
 * the documented behavior of the first edit.
 *
 * Default semantics: `null` in `changes` means *delete the field from that entry*, so
 * the capability falls back to the catalog / route defaults / DSH hard defaults
 * (contextWindow 262144, maxTokens 32768, input ["text"]). No sentinel is ever written.
 *
 * Facts this file relies on (verified against the shipped DSH bundles):
 *  - `llm-pi-ai`'s Config is `z.object({ providers: z.dict(profile).default({}).volatile() })`,
 *    so every path under `providers` is a legal `mutate` target.
 *  - `THINKING_LEVELS = off, minimal, low, medium, high, xhigh, max` (no `none`);
 *    `reasoningEfforts` is `z.union([z.const(false), z.dict(string|null, THINKING_LEVELS)])`.
 *  - `MODALITIES = text, image` only.
 *  - `describe()` yields `{ ns, value, base, user, revision, … }` where `user` is the
 *    profile override layer; `mutate(ns, ops, revision)` refuses a stale revision with
 *    `SettingsConflictError`.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const name = "dsh-model-tweaks";
// webServer is the only hard dependency (the plugin cannot serve its API without it).
// `settings` stays a lenient `ctx.get("settings")` read so a missing Settings service
// degrades to "read-only, no models" instead of blocking plugin activation.
const inject = ["webServer"];

/** Settings namespace that carries the model capabilities (contract §2). */
const SETTINGS_NS = "llm-pi-ai";
/** Host HTTP API prefix (contract §1). */
const API_PREFIX = "/model-tweaks/api";
/** API methods; anything else is a 404. */
const API_METHODS = new Set(["get", "save", "presets"]);
/** Request-body ceiling (contract §4). */
const MAX_JSON_BODY_BYTES = 1024 * 1024;
/** The model-entry fields this plugin manages; any other change key is refused. */
const MANAGED_FIELDS = ["contextWindow", "maxTokens", "input", "reasoningEfforts"];
const MANAGED_FIELD_SET = new Set(MANAGED_FIELDS);
/** Input modalities DSH's pi-ai profile accepts (`ModelModalityMap`, contract v1.2). */
const MODALITIES = ["text", "image"];
const MODALITY_SET = new Set(MODALITIES);
/** pi-ai thinking levels, in escalation order (contract v1.2; `none` does not exist). */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const THINKING_LEVEL_SET = new Set(THINKING_LEVELS);

/**
 * Built-in preset document (contract §5; reasoning list per v1.2, units per v1.10, `off` in every
 * named preset per v1.17).
 *
 * The value lists are **decimal** round numbers: that is what vendors publish and what
 * the owner writes by hand (`contextWindow: 1000000`), so "1M" here means the same 1M
 * the existing config already used. Binary round values (DSH's own 262144 / 32768
 * defaults) stay legal and are disambiguated by `formatCount`.
 *
 * v1.17: every named reasoning preset starts with `off` (owner request). `off` is the one level
 * pi-ai stores as `null`, so a preset without it can never be switched off from the picker; DSH
 * still requires at least one non-`off` level, which each of these keeps.
 */
const DEFAULT_PRESETS = {
	version: 1,
	contextWindows: [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000],
	maxOutputs: [4000, 8000, 16000, 32000, 64000, 128000, 256000],
	reasoningLevels: [...THINKING_LEVELS],
	reasoningPresets: [
		{ id: "p-deepseek", name: "DeepSeek", levels: ["off", "low", "high", "max"] },
		{ id: "p-openai-standard", name: "OpenAI Standard", levels: ["off", "low", "medium", "high"] },
		{ id: "p-simple", name: "Simple", levels: ["off", "low", "high"] }
	]
};

// -- small helpers -----------------------------------------------------------
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const cloneJson = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
/** Detached copy of JSON config data (the value a `mutate` op carries). */
const cloneDeep = (value) => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));
const isPositiveInteger = (value) => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Display formatting shared with the client half (contract §5 + v1.11).
 *
 * **Decimal only.** Round decimal values read the way vendors publish them
 * (`128K = 128000`, `1M = 1000000`); a binary round value — DSH's own hard defaults are
 * 262144 / 32768 — is simply shown as its exact number, with no abbreviated label and no
 * parenthesised suffix. The owner's call (v1.11): the decimal spelling is also the
 * smaller, therefore safer budget, so there is nothing to gain from advertising both.
 */
function formatCount(value) {
	if (!isPositiveInteger(value)) return String(value);
	if (value % 1000000 === 0) return `${value / 1000000}M`;
	if (value % 1000 === 0) return `${value / 1000}K`;
	return String(value);
}

/** Structural JSON equality (used to tell a real user override from an inherited value). */
function jsonEqual(a, b) {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => jsonEqual(value, b[index]));
	}
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((key) => hasOwn(b, key) && jsonEqual(a[key], b[key]));
	}
	return false;
}

/** An error carrying the HTTP status / machine code the API envelope reports. */
function httpError(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}
const badRequest = (message) => httpError(400, "bad-request", message);

/** Warn through the host logger (never through console — tests read `logs`). */
const warnedOnce = new Set();
function warn(ctx, message) {
	if (warnedOnce.has(message)) return;
	warnedOnce.add(message);
	const logger = ctx?.logger ?? (typeof ctx?.get === "function" ? ctx.get("logger") : undefined);
	if (typeof logger?.warn === "function") logger.warn(message);
}

// -- DSH home + preset storage (contract §5) ---------------------------------
/** The DSH home directory (mirrors `dshHomePath()`: empty env, `~` expansion, absolute). */
function dshHome() {
	const raw = process.env.DSH_HOME;
	const configured = raw !== void 0 && raw.trim().length > 0 ? raw.trim() : void 0;
	let base = configured ?? join(homedir(), ".dsh");
	if (base === "~") base = homedir();
	else if (base.startsWith("~/") || base.startsWith("~\\")) base = join(homedir(), base.slice(2));
	else if (base.startsWith("~")) base = join(homedir(), base.slice(1));
	return resolve(base);
}
/** `{DSH_HOME}/dsh-model-tweaks/presets.json`. */
function presetsPath() {
	return join(dshHome(), "dsh-model-tweaks", "presets.json");
}

/** Dedupe + ascending-sort a positive-integer list; `undefined` when the shape is wrong. */
function normalizeCounts(list) {
	if (!Array.isArray(list)) return undefined;
	const out = [];
	for (const value of list) {
		if (!isPositiveInteger(value)) return undefined;
		if (!out.includes(value)) out.push(value);
	}
	return out.sort((a, b) => a - b);
}

/** Non-empty string list, first-occurrence order preserved, duplicates dropped. */
function normalizeLevels(list) {
	if (!Array.isArray(list) || list.length === 0) return undefined;
	const out = [];
	for (const level of list) {
		if (typeof level !== "string" || level.trim() === "") return undefined;
		if (!out.includes(level)) out.push(level);
	}
	return out;
}

/**
 * Normalize a preset document. Returns `undefined` when the document's shape is
 * unusable (the caller falls back to the built-ins), and throws a 400 for the one
 * semantic violation the contract calls out: a preset level missing from
 * `reasoningLevels` (the message names both the preset and the level).
 */
function normalizePresets(raw, { strict } = {}) {
	if (!isPlainObject(raw)) return undefined;
	const contextWindows = normalizeCounts(raw.contextWindows);
	const maxOutputs = normalizeCounts(raw.maxOutputs);
	const reasoningLevels = normalizeLevels(raw.reasoningLevels);
	if (contextWindows === undefined || maxOutputs === undefined || reasoningLevels === undefined) return undefined;
	const list = raw.reasoningPresets === undefined ? [] : raw.reasoningPresets;
	if (!Array.isArray(list)) return undefined;
	const seenIds = new Set();
	const reasoningPresets = [];
	for (let index = 0; index < list.length; index++) {
		const item = list[index];
		if (!isPlainObject(item)) return undefined;
		if (typeof item.name !== "string" || item.name.trim() === "") return undefined;
		if (!Array.isArray(item.levels)) return undefined;
		const levels = [];
		for (const level of item.levels) {
			if (typeof level !== "string") return undefined;
			if (!reasoningLevels.includes(level)) {
				const message = `reasoning preset "${item.name}" references reasoning level "${level}", which is not in reasoningLevels (${reasoningLevels.join(", ")})`;
				if (strict === true) throw badRequest(message);
				return undefined;
			}
			if (!levels.includes(level)) levels.push(level);
		}
		// Host-owned stable id: keep a usable caller-provided one, otherwise mint one.
		const provided = typeof item.id === "string" && item.id.trim() !== "" && !seenIds.has(item.id) ? item.id : undefined;
		const id = provided ?? `p-${randomUUID()}`;
		seenIds.add(id);
		reasoningPresets.push({ id, name: item.name, levels });
	}
	return { version: 1, contextWindows, maxOutputs, reasoningLevels, reasoningPresets };
}

/** Read + normalize the preset file; absent/corrupt documents fall back to the built-ins. */
async function loadPresets(ctx) {
	const path = presetsPath();
	let text;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") warn(ctx, `dsh-model-tweaks: cannot read ${path} (${error?.message ?? error}) — using built-in presets`);
		return cloneJson(DEFAULT_PRESETS);
	}
	let raw;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		warn(ctx, `dsh-model-tweaks: ${path} is not valid JSON (${error?.message ?? error}) — using built-in presets`);
		return cloneJson(DEFAULT_PRESETS);
	}
	const normalized = normalizePresets(raw);
	if (normalized === undefined) {
		warn(ctx, `dsh-model-tweaks: ${path} has an unusable preset structure — using built-in presets`);
		return cloneJson(DEFAULT_PRESETS);
	}
	return normalized;
}

/** Write the preset document atomically (temp file + rename in the same directory). */
async function writePresets(presets) {
	const path = presetsPath();
	const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
	try {
		await mkdir(join(dshHome(), "dsh-model-tweaks"), { recursive: true });
		await writeFile(temporary, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		// Wrap every filesystem failure (ENOTDIR/EACCES/EPERM/…) into the contract code.
		throw httpError(500, "presets-write-failed", `cannot write ${path}: ${error?.code ?? "error"}: ${error?.message ?? error}`);
	}
}

// -- settings access ---------------------------------------------------------
/** Lenient `ctx.get("settings")` read; `undefined` when the service is absent. */
function settingsService(ctx) {
	const service = typeof ctx?.get === "function" ? ctx.get("settings") : ctx?.settings;
	return service === undefined || service === null ? undefined : service;
}

/** Lenient `ctx.get("llm")` read: the provider/model directory DSH itself resolves. */
function llmService(ctx) {
	const service = typeof ctx?.get === "function" ? ctx.get("llm") : ctx?.llm;
	return service === undefined || service === null ? undefined : service;
}

/** One-line diagnostic text for a caught value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/** The `llm-pi-ai` descriptor from `describe()` (revision + base/user layers). */
function settingsDescriptor(settings) {
	if (typeof settings?.describe !== "function") return undefined;
	try {
		const rows = settings.describe();
		if (!Array.isArray(rows)) return undefined;
		return rows.find((row) => isPlainObject(row) && row.ns === SETTINGS_NS);
	} catch {
		return undefined;
	}
}

/**
 * Whether the active profile accepts writes to the namespace (contract v1.6).
 *
 * `settings.writable` is the Settings provider's own policy field; older/Double
 * providers may expose it only on the descriptor, so both are honored — the
 * plugin never reports "writable" when either source refuses. A namespace
 * `describe()` does not list cannot be addressed by `mutate` at all.
 */
function settingsWritable(settings, descriptor) {
	return settings !== undefined
		&& settings.writable !== false
		&& descriptor !== undefined
		&& descriptor.writable !== false;
}

/**
 * The resolved (schema + base + user) value of the namespace; `undefined` on failure.
 *
 * The active runtime (0.1.7-rc.2) exposes **no `settings.get(ns)` at all** — `describe()`
 * is its read surface, and every descriptor already carries the projected
 * `value`/`base`/`user` layers. The descriptor `value` is therefore the primary source;
 * `get()` remains as a fallback for providers that only implement the 0.1.5 shape.
 */
function composedConfig(settings, descriptor) {
	if (isPlainObject(descriptor?.value)) return descriptor.value;
	if (typeof settings?.get !== "function") return undefined;
	try {
		const value = settings.get(SETTINGS_NS);
		return isPlainObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Find one model entry inside a layer. Resolved by `id` first (arrays are not
 * positionally stable across layers); a positional fallback only applies when the
 * layer entry carries no id at all.
 */
function layerModelEntry(layer, providerId, modelId, index) {
	const models = layer?.providers?.[providerId]?.models;
	if (!Array.isArray(models)) return undefined;
	const byId = models.find((entry) => isPlainObject(entry) && entry.id === modelId);
	if (byId !== undefined) return byId;
	const positional = models[index];
	return isPlainObject(positional) && positional.id === undefined ? positional : undefined;
}

/** The `effective` view of one model entry (values only, never a sentinel). */
function effectiveView(entry) {
	return {
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens,
		input: Array.isArray(entry.input) ? [...entry.input] : entry.input,
		// `false` means "non-reasoning model" and must survive read-back verbatim (v1.2 §4).
		reasoningEfforts: entry.reasoningEfforts === false ? false : (isPlainObject(entry.reasoningEfforts) ? { ...entry.reasoningEfforts } : entry.reasoningEfforts)
	};
}

/**
 * Whether the profile override layer carries a real *override* for each managed field.
 *
 * A save materializes the whole resolved `models` array into the profile override
 * (see the file header), so presence alone proves nothing: an entry copied over
 * untouched still carries every inherited field. "Declared" therefore means
 * "present in the user layer *and* different from the inherited layer", which is
 * the state the UI renders as non-Default.
 *
 * `input: []` is the one spelling that DSH itself reads as undeclared
 * (`declaredInput()` returns undefined for an empty list), so a materialized empty
 * list is reported as Default rather than as an override.
 */
function userDeclaredView(descriptor, providerId, entry, index) {
	const user = layerModelEntry(descriptor?.user, providerId, entry.id, index);
	const base = layerModelEntry(descriptor?.base, providerId, entry.id, index);
	const declared = {};
	for (const field of MANAGED_FIELDS) {
		if (user === undefined || !hasOwn(user, field)) {
			declared[field] = false;
			continue;
		}
		const value = user[field];
		if (field === "input" && Array.isArray(value) && value.length === 0) {
			declared[field] = false;
			continue;
		}
		declared[field] = !jsonEqual(value, base?.[field]);
	}
	return declared;
}

/** One `get`-shaped model row (v1.7: directory entry + the declared config entry, if any). */
function modelView(providerId, providerName, modelEntry, descriptor, index, configEntry) {
	return {
		provider: providerId,
		providerName,
		id: modelEntry.id,
		name: typeof modelEntry.name === "string" && modelEntry.name !== "" ? modelEntry.name : modelEntry.id,
		// A Default/override decision reads the declared entry; a directory-only model has
		// nothing declared yet, so its effective view stays empty (contract v1.6 §7).
		effective: configEntry === undefined ? {} : effectiveView(configEntry),
		userDeclared: userDeclaredView(descriptor, providerId, modelEntry, index)
	};
}

/** Read the adapter provider directory; `[]` (plus a warning) when it cannot be read. */
async function readCatalog(llm, warnings) {
	if (llm === undefined) {
		warnings.push("llm service is unavailable; the provider directory cannot be read");
		return [];
	}
	if (typeof llm.listConfigurableProviders !== "function") {
		warnings.push("llm.listConfigurableProviders is unavailable; the provider directory cannot be read");
		return [];
	}
	try {
		const catalog = await llm.listConfigurableProviders();
		return Array.isArray(catalog) ? catalog : [];
	} catch (error) {
		warnings.push(`llm.listConfigurableProviders failed: ${messageOf(error)}`);
		return [];
	}
}

/** One directory model row, or `undefined` when it is not usable. */
function directoryModel(entry) {
	return isPlainObject(entry) && typeof entry.id === "string" && entry.id !== "" ? entry : undefined;
}

/**
 * Resolve one provider group's models (contract v1.8).
 *
 * Returns `null` when the group must be hidden: `listModels` failed, or the route
 * advertises no concrete model at all. A hidden group is not necessarily a silent
 * failure — the caller decides whether the reason deserves a warning (`quiet` is set
 * for the fallback sweep, which walks dozens of unregistered catalog shells on purpose).
 */
async function collectGroup(llm, provider, entry, warnings, quiet) {
	if (typeof llm?.listModels !== "function") {
		if (quiet !== true) warnings.push(`llm.listModels is unavailable; provider "${provider}" lists no models`);
		return null;
	}
	let listed;
	try {
		const models = await llm.listModels(provider);
		listed = Array.isArray(models) ? models : [];
	} catch (error) {
		// One broken route must not empty the whole page — but a configured route that
		// cannot be listed is a real problem the user has to see.
		if (quiet !== true) warnings.push(`llm.listModels(${JSON.stringify(provider)}) failed: ${messageOf(error)}`);
		return null;
	}
	const models = listed.map(directoryModel).filter((model) => model !== undefined);
	// "No concrete models" means nothing to manage: keep it off the page entirely. A
	// *configured* route in this state earns one diagnostic line — the fallback sweep stays
	// quiet, because it deliberately walks dozens of unregistered shells (contract v1.8).
	if (models.length === 0) {
		if (quiet !== true) warnings.push(`provider ${JSON.stringify(provider)} is configured but advertises no models`);
		return null;
	}
	return {
		provider,
		displayName: typeof entry?.displayName === "string" && entry.displayName !== "" ? entry.displayName : provider,
		declared: entry?.declared === true,
		error: typeof entry?.error === "string" && entry.error !== "" ? entry.error : null,
		models
	};
}

/**
 * Provider groups for the settings page (contract v1.7 + v1.8).
 *
 * `ctx.llm` owns the provider vocabulary, but its directory names every route an adapter
 * *could* serve — on this machine 42 entries of which 39 are unregistered catalog shells.
 * Only routes the user actually configured are offered for management, and only when they
 * advertise at least one concrete model; everything else is skipped without even calling
 * `listModels`, so the page carries neither empty groups nor `no adapter registered` noise.
 */
async function providerGroups(ctx, composed, warnings) {
	const llm = llmService(ctx);
	const configured = isPlainObject(composed?.providers) ? composed.providers : {};
	const configuredIds = Object.keys(configured);
	const catalog = await readCatalog(llm, warnings);
	const groups = [];
	const seen = new Set();
	/** Whether a provider was declared in the composed (user/base) configuration. */
	const isManaged = (provider) => Object.prototype.hasOwnProperty.call(configured, provider);

	if (configuredIds.length > 0) {
		// Managed view: catalog declaration order first …
		for (const entry of catalog) {
			const provider = isPlainObject(entry) ? entry.provider : undefined;
			if (typeof provider !== "string" || provider === "" || seen.has(provider) || !isManaged(provider)) continue;
			seen.add(provider);
			const group = await collectGroup(llm, provider, entry, warnings, false);
			if (group !== null) groups.push(group);
		}
		// … then configured routes the directory does not name.
		for (const providerId of configuredIds) {
			if (seen.has(providerId)) continue;
			seen.add(providerId);
			const profile = configured[providerId];
			const models = (isPlainObject(profile) && Array.isArray(profile.models) ? profile.models : [])
				.map(directoryModel)
				.filter((model) => model !== undefined);
			if (models.length === 0) continue;
			groups.push({
				provider: providerId,
				displayName: typeof profile?.displayName === "string" && profile.displayName !== "" ? profile.displayName : providerId,
				declared: false,
				error: null,
				models
			});
		}
		return groups;
	}

	// Fallback view: nothing is configured at all, so there is no "user intent" to filter
	// by. Show every directory route that really advertises models — quietly, because the
	// sweep deliberately walks dozens of unregistered shells.
	warnings.push("no configured providers were found; showing the adapter directory instead");
	for (const entry of catalog) {
		const provider = isPlainObject(entry) ? entry.provider : undefined;
		if (typeof provider !== "string" || provider === "" || seen.has(provider)) continue;
		seen.add(provider);
		const group = await collectGroup(llm, provider, entry, warnings, true);
		if (group !== null) groups.push(group);
	}
	return groups;
}

/**
 * The `models` array a save must materialize for one provider, in precedence order: the
 * composed document, the user override layer, the composition base, and finally the
 * adapter directory. Never returns `undefined` — a model the directory advertises stays
 * savable even when no settings layer declares it yet.
 */
async function resolveWritableModels(ctx, descriptor, composed, providerId) {
	const fromComposed = composed?.providers?.[providerId]?.models;
	if (Array.isArray(fromComposed)) return cloneDeep(fromComposed);
	const fromUser = descriptor?.user?.providers?.[providerId]?.models;
	if (Array.isArray(fromUser)) return cloneDeep(fromUser);
	const fromBase = descriptor?.base?.providers?.[providerId]?.models;
	if (Array.isArray(fromBase)) return cloneDeep(fromBase);
	const llm = llmService(ctx);
	if (llm !== undefined && typeof llm.listModels === "function") {
		try {
			const listed = await llm.listModels(providerId);
			if (Array.isArray(listed)) {
				return listed
					.filter((model) => isPlainObject(model) && typeof model.id === "string" && model.id !== "")
					.map((model) => {
						const entry = { id: model.id };
						if (typeof model.name === "string" && model.name !== "") entry.name = model.name;
						return entry;
					});
			}
		} catch {
			// Unreachable directory: fall through to the empty array (the caller reports 400).
		}
	}
	return [];
}

// -- API: get ----------------------------------------------------------------
async function apiGet(ctx) {
	const settings = settingsService(ctx);
	const descriptor = settingsDescriptor(settings);
	const composed = composedConfig(settings, descriptor);
	const warnings = [];
	if (settings === undefined) warnings.push("settings service is unavailable");
	else {
		if (descriptor === undefined) warnings.push(`settings.describe() does not list the "${SETTINGS_NS}" namespace`);
		if (composed === undefined) {
			warnings.push(typeof settings.get === "function"
				? `settings.get("${SETTINGS_NS}") returned no plain object`
				: `describe() carries no plain value for "${SETTINGS_NS}" and settings.get is unavailable (0.1.7 exposes describe() only)`);
		}
	}
	const presets = await loadPresets(ctx);
	const groups = await providerGroups(ctx, composed, warnings);
	const providers = [];
	const models = [];
	for (const group of groups) {
		const profile = composed?.providers?.[group.provider];
		const configured = isPlainObject(profile) && Array.isArray(profile.models) ? profile.models : [];
		const rows = group.models.map((entry) => {
			const index = configured.findIndex((candidate) => isPlainObject(candidate) && candidate.id === entry.id);
			return modelView(group.provider, group.displayName, entry, descriptor, index, index >= 0 ? configured[index] : undefined);
		});
		providers.push({ provider: group.provider, displayName: group.displayName, declared: group.declared, error: group.error, models: rows });
		for (const row of rows) models.push(row);
	}
	return {
		providers,
		models,
		presets,
		// Writability is a property of the Settings provider (contract v1.6); the namespace
		// must additionally be configurable, otherwise `mutate` cannot address it at all.
		writable: settingsWritable(settings, descriptor),
		revision: typeof descriptor?.revision === "number" ? descriptor.revision : 0,
		modalities: [...MODALITIES],
		warnings
	};
}

// -- API: save ---------------------------------------------------------------
/**
 * Validate `changes` and apply them to one (detached) model entry.
 *
 * `null` is the Default signal and deletes the field; every other value is
 * validated first (this plugin never writes a sentinel). Returns the entry and
 * whether any managed field was addressed, so an empty `changes` stays a no-op.
 */
function applyChanges(entry, changes) {
	const next = { ...entry };
	let touched = false;
	for (const field of MANAGED_FIELDS) {
		if (!hasOwn(changes, field)) continue;
		touched = true;
		const value = changes[field];
		if (value === null) {
			delete next[field];
			continue;
		}
		if (field === "contextWindow" || field === "maxTokens") {
			if (!isPositiveInteger(value)) throw badRequest(`${field} must be a positive integer (got ${JSON.stringify(value)})`);
			next[field] = value;
			continue;
		}
		if (field === "input") {
			if (!Array.isArray(value) || value.some((modality) => typeof modality !== "string")) {
				throw badRequest("input must be an array of modality strings");
			}
			const unsupported = value.filter((modality) => !MODALITY_SET.has(modality));
			if (unsupported.length > 0) throw badRequest(`input contains unsupported modality ${JSON.stringify(unsupported[0])}; supported: ${MODALITIES.join(", ")}`);
			next[field] = [...value];
			continue;
		}
		next[field] = normalizeReasoningEfforts(value);
	}
	return { entry: next, touched };
}

/**
 * Validate a `reasoningEfforts` object: keys must be DSH thinking levels, `off`
 * maps to `null`, every other key to a non-empty string (default: the key name),
 * and at least one level beyond `off` must remain (DSH rejects an off-only map).
 * Emitted key order follows the pi-ai escalation order.
 */
function normalizeReasoningEfforts(value) {
	if (value === false) throw badRequest("reasoningEfforts: false (non-reasoning model) is read-only in v1");
	if (!isPlainObject(value)) throw badRequest("reasoningEfforts must be an object mapping thinking levels to wire values");
	const keys = Object.keys(value);
	for (const key of keys) {
		if (!THINKING_LEVEL_SET.has(key)) {
			throw badRequest(`DSH pi-ai 当前不支持挡位 "${key}"；支持：${THINKING_LEVELS.join("/")}`);
		}
	}
	const out = {};
	for (const level of THINKING_LEVELS) {
		if (!hasOwn(value, level)) continue;
		if (level === "off") {
			out.off = null;
			continue;
		}
		const wire = value[level];
		if (typeof wire !== "string" || wire === "") {
			throw badRequest(`reasoningEfforts.${level} must be a non-empty string (got ${JSON.stringify(wire)})`);
		}
		out[level] = wire;
	}
	if (Object.keys(out).every((level) => level === "off")) {
		throw badRequest('reasoningEfforts offers no level beyond "off"; DSH requires at least one thinking level');
	}
	return out;
}

/**
 * Apply one save: resolve the model from the *live* config (never from a
 * client-supplied index), materialize the whole `models` array with the edited
 * entry, commit it as a single `mutate` op with the revision just read, then
 * re-read so the caller gets the effective values back.
 */
async function apiSave(ctx, payload) {
	const settings = settingsService(ctx);
	if (typeof settings?.mutate !== "function") {
		throw httpError(500, "settings-unavailable", `settings service is unavailable; cannot write "${SETTINGS_NS}"`);
	}
	const descriptor = settingsDescriptor(settings);
	if (!settingsWritable(settings, descriptor)) {
		throw httpError(409, "settings-read-only", `settings namespace "${SETTINGS_NS}" is not writable in the active profile`);
	}
	const providerId = typeof payload?.provider === "string" && payload.provider !== "" ? payload.provider : undefined;
	const modelId = typeof payload?.model === "string" && payload.model !== "" ? payload.model : undefined;
	if (providerId === undefined || modelId === undefined) throw badRequest("provider and model are required");
	const changes = payload.changes;
	if (!isPlainObject(changes)) throw badRequest("changes must be an object");
	// A typo must fail loudly: silently ignoring an unknown key would report a save that
	// never happened.
	for (const key of Object.keys(changes)) {
		if (!MANAGED_FIELD_SET.has(key)) {
			throw badRequest(`unknown field ${JSON.stringify(key)}; allowed: ${MANAGED_FIELDS.join(", ")}`);
		}
	}

	const composed = composedConfig(settings, descriptor);
	const liveModels = await resolveWritableModels(ctx, descriptor, composed, providerId);
	const index = liveModels.findIndex((entry) => isPlainObject(entry) && entry.id === modelId);
	if (index < 0) throw httpError(400, "model-not-found", `model ${JSON.stringify(modelId)} was not found under provider ${JSON.stringify(providerId)}`);

	// Validate + build against a detached copy of the *resolved* array: every other
	// entry keeps every field it has (id/name/compat/…), and only the addressed
	// fields of the target entry change.
	const nextModels = cloneDeep(liveModels);
	const { entry, touched } = applyChanges(nextModels[index], changes);
	nextModels[index] = entry;

	const revision = typeof descriptor?.revision === "number" ? descriptor.revision : undefined;
	if (touched) {
		try {
			await settings.mutate(SETTINGS_NS, [{
				op: "set",
				path: ["providers", providerId, "models"],
				value: nextModels
			}], revision);
		} catch (error) {
			// SettingsConflictError from @deepseek-ai/dsh-settings (no import: match by name/code).
			if (error?.name === "SettingsConflictError" || error?.code === "SETTINGS_CONFLICT") {
				throw httpError(409, "settings-conflict", `settings namespace "${SETTINGS_NS}" changed since it was read: ${error?.message ?? error}`);
			}
			throw error;
		}
	}
	const after = await apiGet(ctx);
	const model = after.models.find((row) => row.provider === providerId && row.id === modelId);
	if (model === undefined) throw httpError(500, "internal", `model ${JSON.stringify(modelId)} disappeared after save`);
	return { model };
}

// -- API: presets ------------------------------------------------------------
async function apiPresets(ctx, payload) {
	const action = typeof payload?.action === "string" ? payload.action : "";
	if (action === "save") {
		const normalized = normalizePresets(payload?.payload, { strict: true });
		if (normalized === undefined) throw badRequest("payload must be a complete preset document (version/contextWindows/maxOutputs/reasoningLevels/reasoningPresets)");
		await writePresets(normalized);
		return { presets: normalized };
	}
	if (action === "resetDefaults") {
		const presets = cloneJson(DEFAULT_PRESETS);
		await writePresets(presets);
		return { presets };
	}
	throw badRequest(`unknown presets action ${JSON.stringify(action)}; supported: save, resetDefaults`);
}

// -- browser-trust fence (loopback + same-origin markers) --------------------
function header(headers, name) {
	const value = headers?.[name];
	return typeof value === "string" ? value : undefined;
}
function parseAuthority(authority) {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** The `/model-tweaks/api` fence: loopback Host, no cross-site fetch, same-origin Origin. */
function isTrustedApiRequest(request) {
	const host = header(request?.headers, "host");
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname)) return false;
	if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request.headers, "origin");
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

// -- HTTP helpers ------------------------------------------------------------
async function readJsonBody(req) {
	const contentType = header(req?.headers, "content-type");
	if (contentType !== undefined && !/^application\/json\b/i.test(contentType.trim())) {
		throw httpError(415, "unsupported-media-type", "content-type must be application/json");
	}
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		total += buffer.length;
		if (total > MAX_JSON_BODY_BYTES) throw httpError(413, "body-too-large", "request body too large");
		chunks.push(buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw httpError(400, "bad-json", "invalid JSON body");
	}
}
function writeJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
function writeOk(res, value) {
	writeJson(res, 200, { ok: true, value });
}
function writeFail(res, message, status = 500, code = "internal") {
	writeJson(res, status, { ok: false, error: { code, message } });
}

// -- plugin mount ------------------------------------------------------------
function apply(ctx) {
	ctx.effect(() => ctx.get("webServer")?.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			if (!isTrustedApiRequest(req)) {
				writeJson(res, 403, { ok: false, error: { code: "forbidden", message: "forbidden" } });
				return;
			}
			if (req.method !== "POST") {
				writeJson(res, 405, { ok: false, error: { code: "method-error", message: "method not allowed" } });
				return;
			}
			const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
			const method = pathname.startsWith(`${API_PREFIX}/`) ? pathname.slice(API_PREFIX.length + 1) : undefined;
			if (method === undefined || method === "" || method.includes("/")) {
				writeJson(res, 404, { ok: false, error: { code: "not-found", message: "unknown model-tweaks API method" } });
				return;
			}
			if (!API_METHODS.has(method)) {
				writeJson(res, 404, { ok: false, error: { code: "not-found", message: `unknown model-tweaks API method ${JSON.stringify(method)}` } });
				return;
			}
			try {
				const payload = await readJsonBody(req);
				if (method === "get") writeOk(res, await apiGet(ctx));
				else if (method === "save") writeOk(res, await apiSave(ctx, payload));
				else writeOk(res, await apiPresets(ctx, payload));
			} catch (error) {
				writeFail(res, error instanceof Error ? error.message : String(error), typeof error?.status === "number" ? error.status : 500, typeof error?.code === "string" ? error.code : "internal");
			}
		}
	}), "dsh-model-tweaks: /model-tweaks/api routes");
}

export { DEFAULT_PRESETS, apply, formatCount, inject, name };
