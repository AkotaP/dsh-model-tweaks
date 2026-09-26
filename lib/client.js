/**
 * dsh-model-tweaks — client half (hand-written browser bundle, no build step).
 *
 * Registers one Settings page that manages the per-model capabilities DSH reads
 * from the `llm-pi-ai` settings namespace, plus a "Presets" tab for this
 * plugin's own global preset lists.
 *
 * Two contract rules drive the whole file:
 *  - **Default = do not declare.** A field set to Default is sent as `null` and
 *    the host deletes it from the stored model entry. Never a sentinel value.
 *  - **Draft + Apply (v1.5).** No control writes on change: every edit touches
 *    local draft state only, and the single write point is the Apply button.
 *    The one exception is the explicit "Save as preset..." confirm button, which
 *    the user presses deliberately to create a named reasoning preset.
 *
 * Input modalities and thinking levels are deliberately narrow: DSH's
 * `ModelModalityMap` only knows `text`/`image`, and pi-ai's `THINKING_LEVELS`
 * only accepts off/minimal/low/medium/high/xhigh/max. Anything else is labelled
 * as unsupported rather than written.
 */
window.__ModuleLoader__.load({
	id: "dsh-model-tweaks",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const h = react.createElement;
		/** React's Fragment, resolved tolerantly so a minimal runtime still renders. */
		const Fragment = jsxRuntime.Fragment ?? react.Fragment ?? "div";

		const NS = "dsh-model-tweaks";
		const API = "/model-tweaks/api";

		//#region css
		const CSS = [
			".mtw_root{display:flex;flex-direction:column;gap:12px;padding:4px 0}",
			".mtw_tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".mtw_tab{cursor:pointer;background:none;border:none;border-bottom:2px solid transparent;border-radius:8px 8px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;padding:6px 12px}",
			".mtw_tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}",
			".mtw_tabActive{color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong));border-bottom-color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong))}",
			".mtw_tabActive:hover{color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong));background:none}",
			".mtw_field{display:flex;flex-direction:column;gap:6px}",
			".mtw_label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:18px}",
			".mtw_select,.mtw_input{box-sizing:border-box;min-width:220px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;padding:4px 8px}",
			".mtw_checks{display:flex;flex-wrap:wrap;align-items:center;gap:12px}",
			".mtw_check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px;line-height:18px}",
			".mtw_check input{width:14px;height:14px;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong))}",
			".mtw_supports{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".mtw_footer{display:flex;align-items:center;gap:8px;margin-top:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}",
			".mtw_button{cursor:pointer;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;padding:4px 12px}",
			".mtw_button:disabled{cursor:not-allowed;opacity:.5}",
			".mtw_buttonPrimary.mtw_buttonPrimary{background:var(--dsw-alias-brand-primary,var(--dsw-accent-strong));border-color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong));color:var(--dsw-alias-bg-base)}",
			".mtw_buttonPrimary:disabled.mtw_buttonPrimary:disabled{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);opacity:1}",
			".mtw_notice{margin-top:4px;font-size:12px;line-height:18px}",
			".mtw_noticeOk{color:var(--dsw-alias-state-success-primary)}",
			".mtw_noticeErr{color:var(--dsw-alias-state-error-primary)}",
			".mtw_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}",
			".mtw_row{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}",
			".mtw_list{display:flex;flex-direction:column;gap:4px}",
			".mtw_spacer{flex:1}",
			".mtw_value{min-width:80px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}",
			".mtw_muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			// v1.12: ONE card shell + ONE title style, shared by provider groups, model rows and
			// Presets sections. A fourth foldable box must reuse these classes rather than invent
			// its own — that divergence is exactly what this version fixes.
			".mtw_groups{display:flex;flex-direction:column;gap:6px;min-width:260px}",
			".mtw_group{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}",
			".mtw_groupHeader{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;cursor:pointer;text-align:left;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));border:none;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;padding:6px 8px}",
			".mtw_groupHeader:hover{color:var(--dsw-alias-brand-primary,var(--dsw-accent-strong))}",
			".mtw_caret{flex:none;width:12px;color:var(--dsw-alias-label-secondary)}",
			".mtw_groupTitle{font-weight:500}",
			// v1.13: the owner asked for a flat card look — **no accent bars and no filled panels**.
			// The card shell and the header fill alone carry the hierarchy; "which model is open" is
			// already answered by the editor sitting under its row (plus the bold row title).
			".mtw_groupBody{display:flex;flex-direction:column;gap:10px;margin:4px 8px 8px 10px;padding-left:16px}",
			".mtw_group .mtw_list{display:flex;flex-direction:column;gap:6px;padding:6px}",
			// v1.14: inside a Presets card the items are separated by a **subtle** hairline —
			// `border-l1` is the theme's "Primary subtle border" while `border-l2` ("Secondary
			// stronger border") stays on the card shells, so the divider can never look heavier than
			// the card it lives in. Action buttons hug their content instead of stretching into bars.
			".mtw_groupBody .mtw_list{gap:0;padding:0}",
			".mtw_groupBody .mtw_list > .mtw_row{padding:5px 0;border-top:1px solid var(--dsw-alias-border-l1)}",
			".mtw_groupBody .mtw_list > .mtw_row:first-child{border-top:none}",
			".mtw_action{align-self:flex-start}",
			// v1.16: the per-card Apply row. The hairline is what separates "add / new" (the action that
			// creates an item) from "Apply" (the action that persists the card) — both are content-width,
			// and the same subtle border-l1 tone as the item dividers.
			".mtw_cardFooter{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}",
			".mtw_modelRow{padding:4px 8px}",
			".mtw_modelRowActive{font-weight:500}",
			".mtw_modelName{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".mtw_modelItem{display:flex;flex-direction:column}",
			".mtw_editor{display:flex;flex-direction:column;gap:10px;margin:0 8px 8px;padding:8px 10px 10px}",
			".mtw_small{font-size:12px;line-height:16px;padding:2px 8px}"
		].join("");
		const TAG_ID = "dsh-model-tweaks/ModelCapabilities.module.css";
		// Re-inject on every load: HMR leaves the previous <style> in the head, so a
		// "only insert when absent" guard would make every CSS edit invisible.
		if (typeof document !== "undefined") {
			const selector = "style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]";
			for (const stale of document.querySelectorAll(selector)) stale.remove();
			const tag = document.createElement("style");
			tag.dataset.plugin = NS;
			tag.dataset.pluginCss = TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region dictionaries
		const en = {
			nav: "Model Capabilities",
			capsTab: "Model Capabilities",
			presetsTab: "Presets",
			model: "Model",
			provider: "Provider",
			contextWindow: "Context Window",
			maxOutput: "Max Output",
			inputModalities: "Input Modalities",
			reasoningLevels: "Reasoning Levels",
			reasoningDefault: "Default",
			global: "Global",
			custom: "Custom...",
			supports: "Supports:",
			resetDefault: "Reset to Default",
			apply: "Apply",
			unsaved: "Unsaved changes",
			saved: "Saved",
			saveNoReply: "The host did not return the saved presets",
			discarded: "Unsaved changes were discarded",
			loading: "Loading...",
			retry: "Retry",
			readOnly: "This deployment's settings are read-only.",
			noModels: "No configurable models were found.",
			defaultLabel: "Default",
			nothing: "None",
			add: "+ Add",
			edit: "Edit",
			delete: "Delete",
			save: "Save",
			cancel: "Cancel",
			newPreset: "+ New Preset",
			presetName: "Preset Name",
			restoreDefaults: "Restore default presets",
			saveAsPreset: "Save as preset...",
			dshUnsupported: "DSH does not support this level",
			contextWindowList: "Context Window",
			maxOutputList: "Max Output",
			reasoningLevelsList: "Reasoning Levels",
			reasoningPresetsList: "Reasoning Presets",
			declared: "Declared",
			unavailable: "Unavailable",
			diagnostics: "Diagnostics:"
		};
		const zh = {
			nav: "模型能力",
			capsTab: "模型能力",
			presetsTab: "预设",
			model: "模型",
			provider: "提供商",
			contextWindow: "上下文窗口",
			maxOutput: "最大输出",
			inputModalities: "输入模态",
			reasoningLevels: "思考挡位",
			reasoningDefault: "默认",
			global: "全局",
			custom: "自定义…",
			supports: "支持：",
			resetDefault: "重置为默认",
			apply: "应用",
			unsaved: "有未保存的修改",
			saved: "已保存",
			saveNoReply: "宿主没有返回保存后的预设",
			discarded: "已丢弃未保存的修改",
			loading: "载入中…",
			retry: "重试",
			readOnly: "当前部署的设置为只读。",
			noModels: "没有找到可配置的模型。",
			defaultLabel: "默认",
			nothing: "无",
			add: "+ 添加",
			edit: "编辑",
			delete: "删除",
			save: "保存",
			cancel: "取消",
			newPreset: "+ 新建组合",
			presetName: "组合名称",
			restoreDefaults: "恢复默认",
			saveAsPreset: "另存为组合…",
			dshUnsupported: "DSH 不支持该挡位",
			contextWindowList: "上下文窗口",
			maxOutputList: "最大输出",
			reasoningLevelsList: "思考挡位",
			reasoningPresetsList: "思考组合",
			declared: "已声明",
			unavailable: "不可用",
			diagnostics: "诊断："
		};
		//#endregion

		//#region vocabulary
		/** DSH's `ModelModalityMap` — the only modalities a profile may declare. */
		const MODALITIES = ["text", "image"];
		const MODALITY_LABEL = { text: "Text", image: "Image" };
		/** pi-ai's `THINKING_LEVELS`, in escalation order (there is no `none`). */
		const DSH_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		const VALUE_SECTIONS = ["contextWindows", "maxOutputs"];
		/**
		 * Mirror of the host's built-in defaults (v1.10: decimal round numbers; v1.17: every named
		 * reasoning preset starts with `off`), used when the host is unreachable. **Keep it
		 * byte-for-byte identical to `lib/index.js`'s `DEFAULT_PRESETS`** — `test/manifest.test.mjs`
		 * deep-compares the two exports, because "Restore default presets" (host value) and this
		 * host-unreachable fallback silently forking is exactly the bug class that already bit us once.
		 */
		const DEFAULT_PRESETS = {
			version: 1,
			contextWindows: [8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000],
			maxOutputs: [4000, 8000, 16000, 32000, 64000, 128000, 256000],
			reasoningLevels: DSH_LEVELS.slice(),
			reasoningPresets: [
				{ id: "p-deepseek", name: "DeepSeek", levels: ["off", "low", "high", "max"] },
				{ id: "p-openai-standard", name: "OpenAI Standard", levels: ["off", "low", "medium", "high"] },
				{ id: "p-simple", name: "Simple", levels: ["off", "low", "high"] }
			]
		};
		//#endregion

		//#region helpers
		/**
		 * v1.11: **decimal only** (the owner's call: "只用 10 进制算了吧，反正也比 2 的小一点，更安全").
		 * `1000000 → "1M"`, `128000 → "128K"`, `1000 → "1K"`; a binary round number is **not**
		 * abbreviated at all — `1048576`, `131072`, `1024` render as their plain value, so nothing can
		 * be mistaken for a decimal "1M"/"128K"/"1K". Must stay byte-for-byte identical to the host's
		 * copy (`test/manifest.test.mjs` compares the two over one shared table).
		 */
		const isPositiveInteger = (value) => typeof value === "number" && Number.isInteger(value) && value > 0;
		function formatCount(value) {
			if (!isPositiveInteger(value)) return String(value);
			if (value % 1000000 === 0) return `${value / 1000000}M`;
			if (value % 1000 === 0) return `${value / 1000}K`;
			return String(value);
		}
		function levelLabel(level) {
			return level.charAt(0).toUpperCase() + level.slice(1);
		}
		function modelKeyOf(model) {
			return model.provider + "\u0000" + model.id;
		}
		/**
		 * v1.7 provider groups for the Model control. The host sends
		 * `providers: [{ provider, displayName, declared, error, models[] }]`; an older host only
		 * sends the flat `models` list, so degrade to one untitled group instead of crashing.
		 */
		function providerGroupsOf(value) {
			const flat = Array.isArray(value && value.models) ? value.models : [];
			const listed = Array.isArray(value && value.providers) ? value.providers : [];
			if (listed.length === 0) {
				return flat.length === 0 ? [] : [{ key: "__all", displayName: null, declared: undefined, error: undefined, models: flat }];
			}
			return listed
				.filter((group) => group !== null && typeof group === "object")
				.map((group) => ({
					key: String(group.provider !== undefined && group.provider !== null ? group.provider : (group.displayName ?? "__all")),
					displayName: typeof group.displayName === "string" && group.displayName !== "" ? group.displayName : String(group.provider ?? ""),
					declared: group.declared,
					error: group.error === undefined || group.error === null || group.error === false ? undefined : group.error,
					models: (Array.isArray(group.models) ? group.models : []).filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string")
				}));
		}
		/** Dedupe + ascending order, which is how the host stores both value lists. */
		function normalizeNumbers(list) {
			return Array.from(new Set(list)).sort((a, b) => a - b);
		}
		/** Order-insensitive level comparison restricted to DSH's vocabulary. */
		function levelKey(levels) {
			return DSH_LEVELS.filter((level) => (levels ?? []).indexOf(level) >= 0).join(",");
		}
		function sameLevels(a, b) {
			return levelKey(a) === levelKey(b);
		}
		function supportsText(levels, t) {
			const ordered = DSH_LEVELS.filter((level) => (levels ?? []).indexOf(level) >= 0);
			if (ordered.length === 0) return t("nothing");
			return ordered.map(levelLabel).join(" · ");
		}
		/** One label + control row. */
		function field(label, control) {
			return h("div", { className: "mtw_field" }, h("div", { className: "mtw_label" }, label), control);
		}
		/** The only wire call shape: POST JSON, unwrap `{ ok, value }`, throw host text. */
		async function api(method, body) {
			const response = await fetch(API + "/" + method, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body ?? {})
			});
			let payload;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (payload === undefined || payload.ok !== true) {
				const message = payload && payload.error && payload.error.message ? payload.error.message : "HTTP " + response.status;
				const error = new Error(message);
				error.code = payload && payload.error ? payload.error.code : undefined;
				throw error;
			}
			return payload.value;
		}
		//#endregion

		//#region draft model
		/**
		 * Draft state for one model. `contextWindow`/`maxTokens` are `null` when the
		 * user layer does not declare them (the UI shows Default); `inputDefault`
		 * marks the Default posture for the whole modality list, because DSH cannot
		 * express "declares nothing" once the array is materialized.
		 */
		function baselineOf(model, presets) {
			const effective = model.effective ?? {};
			const declared = model.userDeclared ?? {};
			const declaredReasoning = declared.reasoningEfforts === true;
			const efforts = effective.reasoningEfforts;
			let levels = [];
			if (declaredReasoning && efforts !== null && typeof efforts === "object" && !Array.isArray(efforts)) {
				levels = DSH_LEVELS.filter((level) => Object.prototype.hasOwnProperty.call(efforts, level));
			}
			let kind = "default";
			if (declaredReasoning) {
				const globalLevels = (presets && presets.reasoningLevels) || DSH_LEVELS;
				if (sameLevels(levels, globalLevels)) kind = "global";
				else {
					const match = ((presets && presets.reasoningPresets) || []).find((preset) => sameLevels(levels, preset.levels));
					kind = match ? "preset:" + match.id : "custom";
				}
			}
			return {
				contextWindow: declared.contextWindow === true && typeof effective.contextWindow === "number" ? effective.contextWindow : null,
				maxTokens: declared.maxTokens === true && typeof effective.maxTokens === "number" ? effective.maxTokens : null,
				inputDefault: declared.input !== true,
				input: declared.input === true && Array.isArray(effective.input) ? effective.input.slice() : [],
				reasoningKind: kind,
				reasoningLevels: kind === "default" ? [] : levels.slice()
			};
		}
		/** The draft's four managed fields as `changes`; Default is always `null`. */
		function changesOf(draft) {
			return {
				contextWindow: draft.contextWindow,
				maxTokens: draft.maxTokens,
				input: draft.inputDefault ? null : draft.input.slice(),
				reasoningEfforts: reasoningValue(draft)
			};
		}
		/**
		 * Turn the draft's level set into pi-ai's `reasoningEfforts` map. Levels DSH
		 * does not accept are dropped here; `off` alone cannot stand on its own, so an
		 * empty result is sent as Default (`null`) rather than an invalid map.
		 */
		function reasoningValue(draft) {
			if (draft.reasoningKind === "default") return null;
			const levels = DSH_LEVELS.filter((level) => draft.reasoningLevels.indexOf(level) >= 0);
			if (levels.length === 0) return null;
			const out = {};
			for (const level of levels) out[level] = level === "off" ? null : level;
			return out;
		}
		function sameDraft(a, b) {
			return a.contextWindow === b.contextWindow
				&& a.maxTokens === b.maxTokens
				&& a.inputDefault === b.inputDefault
				&& (a.input ?? []).slice().sort().join(",") === (b.input ?? []).slice().sort().join(",")
				&& a.reasoningKind === b.reasoningKind
				&& sameLevels(a.reasoningLevels, b.reasoningLevels);
		}
		function reasoningOptions(t, presets) {
			const options = [
				h("option", { key: "default", value: "default" }, t("reasoningDefault")),
				h("option", { key: "global", value: "global" }, t("global"))
			];
			for (const preset of (presets && presets.reasoningPresets) || []) {
				options.push(h("option", { key: "preset:" + preset.id, value: "preset:" + preset.id }, preset.name));
			}
			options.push(h("option", { key: "custom", value: "custom" }, t("custom")));
			return options;
		}
		/** Switching the reasoning select replaces the level set, never writes. */
		function withReasoningKind(draft, kind, presets) {
			if (kind === "default") return { ...draft, reasoningKind: "default", reasoningLevels: [] };
			if (kind === "global") return { ...draft, reasoningKind: "global", reasoningLevels: (((presets && presets.reasoningLevels) || DSH_LEVELS)).slice() };
			if (kind === "custom") return { ...draft, reasoningKind: "custom", reasoningLevels: draft.reasoningLevels.slice() };
			const preset = ((presets && presets.reasoningPresets) || []).find((candidate) => "preset:" + candidate.id === kind);
			return { ...draft, reasoningKind: kind, reasoningLevels: preset ? preset.levels.slice() : [] };
		}
		//#endregion

		/** The Settings page: two tabs, both strictly draft + Apply. */
		function ModelCapabilitiesSection(props) {
			const t = typeof props?.t === "function" ? props.t : (key) => en[key] ?? key;
			const [load, setLoad] = react.useState({ status: "loading" });
			const [tab, setTab] = react.useState("caps");
			const [selectedKey, setSelectedKey] = react.useState(null);
			/** v1.9/v1.12: selection and expansion are separate states — the page opens with neither. */
			const [expandedKey, setExpandedKey] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [notice, setNotice] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [presetDraft, setPresetDraft] = react.useState(null);
			const [rowEdit, setRowEdit] = react.useState(null);
			const [addForm, setAddForm] = react.useState(null);
			const [presetForm, setPresetForm] = react.useState(null);
			const [naming, setNaming] = react.useState(null);
			/**
			 * v1.12 folding state: **empty set = every provider is folded**, so the page opens as a
			 * column of closed cards (v1.7 had the opposite default). Purely local, never writes.
			 */
			const [expandedGroups, setExpandedGroups] = react.useState({});
			/** v1.9: Presets sections start **collapsed**; this maps the currently expanded ones. */
			const [expandedSections, setExpandedSections] = react.useState({});
			const noticeTimer = react.useRef(null);

			const toggleCollapse = (setter, key) => setter((current) => ({ ...current, [key]: !(current[key] === true) }));

			/** Show a status line; successes fade after 2.5s, failures stay. */
			const flash = (next) => {
				setNotice(next);
				if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
				if (next !== null && next.kind !== "err") {
					noticeTimer.current = setTimeout(() => setNotice(null), 2500);
				}
			};

			/**
			 * v1.12: adopting a fresh snapshot selects **nothing** — no row is highlighted, no editor
			 * exists, and Apply/Reset are absent until the user clicks a model. (v1.9 only stopped the
			 * auto-*expansion* while still preselecting the first model.)
			 */
			const adopt = (value) => {
				setLoad({ status: "ready", value });
				setPresetDraft(value.presets ?? DEFAULT_PRESETS);
				setSelectedKey(null);
				setExpandedKey(null);
				setDraft(null);
				setRowEdit(null);
				setAddForm(null);
				setPresetForm(null);
				setNaming(null);
			};

			const refresh = () => {
				setLoad({ status: "loading" });
				api("get", {}).then(
					(value) => adopt(value),
					(error) => setLoad({ status: "error", message: String(error?.message ?? error) })
				);
			};

			react.useEffect(() => {
				refresh();
			}, []);
			react.useEffect(() => () => {
				if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
			}, []);

			const ready = load.status === "ready";
			const value = ready ? load.value : null;
			const presets = ready ? (load.value.presets ?? DEFAULT_PRESETS) : DEFAULT_PRESETS;
			/** v1.7 provider groups (rendering order); `models` stays the flat selection list. */
			const groups = ready ? providerGroupsOf(load.value) : [];
			const models = [];
			{
				const seen = new Set();
				const flat = ready && Array.isArray(load.value.models) ? load.value.models : [];
				for (const candidate of flat.concat(groups.flatMap((group) => group.models))) {
					const key = modelKeyOf(candidate);
					if (!seen.has(key)) {
						seen.add(key);
						models.push(candidate);
					}
				}
			}
			const model = models.find((candidate) => modelKeyOf(candidate) === selectedKey) ?? null;
			const baseline = model === null ? null : baselineOf(model, presets);
			const dirty = draft !== null && baseline !== null && !sameDraft(draft, baseline);
			const writable = ready && load.value.writable !== false;

			const patchDraft = (patch) => setDraft((current) => (current === null ? current : { ...current, ...patch }));
			/**
			 * v1.9: clicking a row either opens its editor, closes the open one, or switches models
			 * (which drops the draft and says so). Folding a provider group never touches this.
			 */
			const pickModel = (key) => {
				if (key === selectedKey) {
					setExpandedKey(expandedKey === key ? null : key);
					return;
				}
				if (dirty) flash({ kind: "info", text: t("discarded") });
				const next = models.find((candidate) => modelKeyOf(candidate) === key) ?? null;
				setSelectedKey(key);
				setDraft(next === null ? null : baselineOf(next, presets));
				setExpandedKey(key);
			};
			const resetToDefault = () => {
				setDraft({ contextWindow: null, maxTokens: null, inputDefault: true, input: [], reasoningKind: "default", reasoningLevels: [] });
			};
			/** The only model write point in this file. */
			const applyChanges = () => {
				if (draft === null || model === null || saving || !writable) return;
				setSaving(true);
				api("save", { provider: model.provider, model: model.id, changes: changesOf(draft) }).then(
					(result) => {
						setSaving(false);
						const key = modelKeyOf(model);
						setLoad((current) => {
							if (current.status !== "ready") return current;
							// Keep BOTH the flat compatibility list and the v1.7 provider groups in sync,
							// otherwise the grouped rows would keep the pre-save entry and the draft
							// would never look clean again.
							const replaceIn = (list) => (Array.isArray(list)
								? list.map((candidate) => (modelKeyOf(candidate) === key ? result.model : candidate))
								: list);
							const nextValue = { ...current.value, models: replaceIn(current.value.models) };
							if (Array.isArray(current.value.providers)) {
								nextValue.providers = current.value.providers.map((group) => ({ ...group, models: replaceIn(group.models) }));
							}
							return { status: "ready", value: nextValue };
						});
						setDraft(baselineOf(result.model, presets));
						if (dirty) setNaming(null);
						flash({ kind: "ok", text: t("saved") });
					},
					(error) => {
						setSaving(false);
						flash({ kind: "err", text: String(error?.message ?? error) });
					}
				);
			};
			const savePresets = (next) => api("presets", { action: "save", payload: next }).then((result) => result.presets);
			/**
			 * v1.15: adopt the document a write handed back. A reply that carries no usable `presets`
			 * (malformed or older host) must **not** be written into state — doing so nulled the draft
			 * and blanked the whole Presets tab. Returns `null` instead, so each caller can report the
			 * failure and keep showing the last persisted document.
			 */
			const adoptPresets = (result) => {
				const saved = result === null || result === undefined ? undefined : result.presets;
				if (saved === null || saved === undefined) return null;
				setPresetDraft(saved);
				setLoad((current) => (current.status === "ready" ? { status: "ready", value: { ...current.value, presets: saved } } : current));
				return saved;
			};
			/** The last document the host confirmed — also the rollback target when a write fails. */
			const persistedPresets = () => (load.status === "ready" ? (load.value.presets ?? DEFAULT_PRESETS) : DEFAULT_PRESETS);
			/**
			 * Roll the UI back to the persisted document and say why the write did not land. The
			 * transient inline editors are closed too: leaving an input showing the rejected value
			 * while the document behind it is the old one is exactly how "it looks saved" confusion
			 * happens.
			 */
			const rejectPresets = (error) => {
				setPresetDraft(persistedPresets());
				setRowEdit(null);
				setAddForm(null);
				setPresetForm(null);
				flash({ kind: "err", text: String(error?.message ?? error) });
			};
			/**
			 * v1.10: an explicit, confirmed action like "Save as preset..." — it is deliberately
			 * **outside** the draft+Apply gate, because it is the one-click way back to the
			 * (now decimal) built-in defaults after a binary-based preset list was saved.
			 */
			const restoreDefaultPresets = () => api("presets", { action: "resetDefaults" }).then(
				(result) => {
					if (adoptPresets(result) === null) { rejectPresets(t("saveNoReply")); return; }
					setRowEdit(null);
					setAddForm(null);
					setPresetForm(null);
					flash({ kind: "ok", text: t("saved") });
				},
				rejectPresets
			);
			/** Explicit confirm button: creates the preset, then selects it. */
			const saveAsPreset = () => {
				if (naming === null || presetDraft === null || draft === null) return;
				const name = naming.value.trim();
				if (name === "") return;
				const id = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
				const levels = DSH_LEVELS.filter((level) => draft.reasoningLevels.indexOf(level) >= 0);
				const next = { ...presetDraft, reasoningPresets: (presetDraft.reasoningPresets ?? []).concat([{ id, name, levels }]) };
				savePresets(next).then(
					(result) => {
						if (adoptPresets(result) === null) { rejectPresets(t("saveNoReply")); return; }
						setNaming(null);
						setDraft({ ...draft, reasoningKind: "preset:" + id, reasoningLevels: levels });
						flash({ kind: "ok", text: t("saved") });
					},
					rejectPresets
				);
			};

			const noticeLine = () => (notice === null ? null : h("div", {
				className: "mtw_notice " + (notice.kind === "err" ? "mtw_noticeErr" : "mtw_noticeOk")
			}, notice.text));

			/**
			 * v1.7 diagnostics: the host records why the catalog may be empty or a group failed
			 * (missing `llm`, a provider's `listModels` rejecting, …). Show it in secondary colour
			 * whenever there is one — an empty page with no explanation was the real-machine bug.
			 */
			const warningsLine = () => {
				const warnings = ready && value !== null && Array.isArray(value.warnings)
					? value.warnings.filter((entry) => typeof entry === "string" && entry !== "")
					: [];
				if (warnings.length === 0) return null;
				return h("div", { className: "mtw_muted" }, t("diagnostics") + " " + warnings.join(" · "));
			};

			const numberOptions = (list, currentValue) => {
				const options = [h("option", { key: "__default", value: "__default" }, t("defaultLabel"))];
				for (const entry of list) {
					options.push(h("option", { key: String(entry), value: String(entry) }, formatCount(entry)));
				}
				if (currentValue !== null && list.indexOf(currentValue) < 0) {
					options.push(h("option", { key: "current", value: String(currentValue) }, formatCount(currentValue)));
				}
				return options;
			};

			/**
			 * v1.7/v1.12: one **closed** card per provider; a model is itself a foldable card inside
			 * it (`mtw_group` + `mtw_groupHeader`, the very same shell and title classes as the
			 * provider card and the Presets cards). Selecting a row keeps the v1.5 draft rules.
			 */
			const renderModelPicker = () => {
				if (groups.length === 0) return h("div", { className: "mtw_muted" }, t("noModels"));
				return h("div", { className: "mtw_groups" }, groups.map((group) => {
					const expandedGroup = expandedGroups[group.key] === true;
					return h("div", { className: "mtw_group", key: group.key },
						h("button", {
							type: "button",
							className: "mtw_groupHeader",
							"aria-expanded": expandedGroup,
							onClick: () => toggleCollapse(setExpandedGroups, group.key)
						},
							h("span", { className: "mtw_caret" }, expandedGroup ? "▾" : "▸"),
							h("span", { className: "mtw_groupTitle" }, (group.displayName === null || group.displayName === "" ? "" : group.displayName + " ") + "(" + group.models.length + ")"),
							group.declared === true ? h("span", { className: "mtw_muted" }, t("declared")) : null,
							group.error ? h("span", { className: "mtw_error" }, group.error === true ? t("unavailable") : String(group.error)) : null),
						expandedGroup ? h("div", { className: "mtw_list" }, group.models.map((candidate) => {
							const key = modelKeyOf(candidate);
							const selected = key === selectedKey;
							// v1.9: a row is only *highlighted* when selected; its editor opens on demand.
							const expanded = selected && key === expandedKey;
							return h("div", { className: "mtw_modelItem mtw_group", key },
								h("button", {
									type: "button",
									className: "mtw_groupHeader mtw_modelRow" + (selected ? " mtw_modelRowActive" : ""),
									"aria-pressed": selected,
									"aria-expanded": expanded,
									onClick: () => pickModel(key)
								},
									h("span", { className: "mtw_caret" }, expanded ? "▾" : "▸"),
									h("span", { className: "mtw_modelName" }, candidate.name ?? candidate.id)),
								expanded ? renderEditor() : null);
						})) : null);
				}));
			};

			/**
			 * v1.8: the four capability controls plus Apply live **inside the selected model's node**
			 * (right below its row) instead of a shared panel at the bottom of the page. Only the
			 * selected row renders it, so switching models moves the editor and drops the draft.
			 * `warnings` stays page-level: it is global diagnostics, not per-model.
			 */
			const renderEditor = () => {
				if (model === null || draft === null) return null;
				return h("div", { className: "mtw_editor" },
					field(t("contextWindow"), h("select", {
						className: "mtw_select",
						value: draft.contextWindow === null ? "__default" : String(draft.contextWindow),
						onChange: (event) => patchDraft({ contextWindow: event.target.value === "__default" ? null : Number(event.target.value) })
					}, numberOptions(presets.contextWindows ?? [], draft.contextWindow))),
					field(t("maxOutput"), h("select", {
						className: "mtw_select",
						value: draft.maxTokens === null ? "__default" : String(draft.maxTokens),
						onChange: (event) => patchDraft({ maxTokens: event.target.value === "__default" ? null : Number(event.target.value) })
					}, numberOptions(presets.maxOutputs ?? [], draft.maxTokens))),
					field(t("inputModalities"), h("div", { className: "mtw_checks" },
						h("label", { className: "mtw_check" },
							h("input", {
								type: "checkbox",
								checked: draft.inputDefault,
								onChange: (event) => patchDraft({ inputDefault: event.target.checked, input: event.target.checked ? [] : draft.input })
							}),
							t("defaultLabel")),
						MODALITIES.map((modality) => h("label", {
							key: modality,
							className: "mtw_check"
						},
							h("input", {
								type: "checkbox",
								checked: draft.inputDefault !== true && draft.input.indexOf(modality) >= 0,
								// v1.18: picking a modality clears Default by itself, and clearing the last
								// modality turns Default back on. The boxes used to be `disabled` while
								// Default was on, forcing the owner to uncheck Default first — annoying,
								// because "Default" vs "Text/Image" is ONE choice, not two.
								onChange: (event) => {
									const remaining = draft.input.filter((entry) => entry !== modality);
									if (!event.target.checked) {
										patchDraft(remaining.length === 0 ? { inputDefault: true, input: remaining } : { inputDefault: false, input: remaining });
										return;
									}
									patchDraft({ inputDefault: false, input: draft.input.concat([modality]) });
								}
							}),
							MODALITY_LABEL[modality])))),
					field(t("reasoningLevels"), h("div", { className: "mtw_field" },
						h("select", {
							className: "mtw_select",
							value: draft.reasoningKind,
							onChange: (event) => setDraft(withReasoningKind(draft, event.target.value, presets))
						}, reasoningOptions(t, presets)),
						h("div", { className: "mtw_supports" }, t("supports") + " " + supportsText(draft.reasoningLevels, t)))),
					draft.reasoningKind === "custom" ? h("div", { className: "mtw_field" },
						h("div", { className: "mtw_checks" }, (presets.reasoningLevels ?? DSH_LEVELS).map((level) => h("label", {
							key: level,
							className: "mtw_check"
						},
							h("input", {
								type: "checkbox",
								checked: draft.reasoningLevels.indexOf(level) >= 0,
								onChange: (event) => patchDraft({
									reasoningLevels: event.target.checked ? draft.reasoningLevels.concat([level]) : draft.reasoningLevels.filter((entry) => entry !== level)
								})
							}),
							levelLabel(level),
							DSH_LEVELS.indexOf(level) < 0 ? h("span", { className: "mtw_muted" }, " (" + t("dshUnsupported") + ")") : null))),
						naming === null
							? h("button", { className: "mtw_button mtw_small mtw_action", onClick: () => setNaming({ value: "" }) }, t("saveAsPreset"))
							: h("div", { className: "mtw_row" },
								h("input", {
									className: "mtw_input",
									placeholder: t("presetName"),
									value: naming.value,
									onChange: (event) => setNaming({ value: event.target.value })
								}),
								h("button", { className: "mtw_button mtw_small", disabled: naming.value.trim() === "", onClick: saveAsPreset }, t("save")),
								h("button", { className: "mtw_button mtw_small", onClick: () => setNaming(null) }, t("cancel")))) : null,
					h("div", { className: "mtw_footer" },
						h("button", { className: "mtw_button", onClick: resetToDefault, disabled: !writable }, t("resetDefault")),
						h("button", { className: "mtw_button mtw_buttonPrimary", disabled: !dirty || saving || !writable, onClick: applyChanges }, t("apply")),
						dirty ? h("span", { className: "mtw_muted" }, t("unsaved")) : null),
					noticeLine(),
					writable ? null : h("div", { className: "mtw_error" }, t("readOnly")));
			};

			const renderCapabilities = () => {
				if (groups.length === 0) return h("div", { className: "mtw_muted" }, t("noModels"));
				return field(t("provider"), renderModelPicker());
			};

			//#region presets tab (v1.15: every committed edit writes immediately)
			/**
			 * v1.16: recording an edit is **draft-only** again. The write point is the Apply button at
			 * the bottom of each card (`applyPresets`). (v1.15 briefly wrote on every commit; the owner
			 * replaced that with a per-card Apply.)
			 */
			const commitPresets = (next) => setPresetDraft(next);
			/** v1.16: per-card dirty check — a card's Apply only lights up for edits of its own field. */
			const cardDirty = (card) => {
				if (presetDraft === null) return false;
				const persisted = persistedPresets();
				return JSON.stringify(presetDraft[card] ?? null) !== JSON.stringify(persisted[card] ?? null);
			};
			/**
			 * v1.16: the single write point of the Presets tab, rendered at the bottom of **every**
			 * card. It submits the whole pending document — the host contract is a whole-document
			 * write — so if a second card still has pending edits they are saved as well. That is
			 * deliberate: one document must never end up half-saved.
			 */
			const applyPresets = () => {
				if (presetDraft === null) return;
				if (!writable) {
					flash({ kind: "err", text: t("readOnly") });
					return;
				}
				api("presets", { action: "save", payload: presetDraft }).then(
					(result) => {
						if (adoptPresets(result) === null) { rejectPresets(t("saveNoReply")); return; }
						setRowEdit(null);
						setAddForm(null);
						setPresetForm(null);
						flash({ kind: "ok", text: t("saved") });
					},
					rejectPresets
				);
			};
			const commitNumberAdd = (section) => {
				if (addForm === null) return;
				const parsed = Number(addForm.text.trim());
				if (!Number.isInteger(parsed) || parsed <= 0) return;
				commitPresets({ ...presetDraft, [section]: normalizeNumbers((presetDraft[section] ?? []).concat([parsed])) });
				setAddForm(null);
			};
			const commitNumberEdit = (section, index) => {
				if (rowEdit === null) return;
				const parsed = Number(rowEdit.text.trim());
				if (!Number.isInteger(parsed) || parsed <= 0) return;
				const values = (presetDraft[section] ?? []).slice();
				values[index] = parsed;
				commitPresets({ ...presetDraft, [section]: normalizeNumbers(values) });
				setRowEdit(null);
			};
			const removeNumber = (section, index) => {
				const values = (presetDraft[section] ?? []).slice();
				values.splice(index, 1);
				commitPresets({ ...presetDraft, [section]: values });
			};
			const commitLevelAdd = () => {
				if (addForm === null) return;
				const level = addForm.text.trim();
				if (level === "") return;
				const levels = presetDraft.reasoningLevels ?? [];
				if (levels.indexOf(level) < 0) commitPresets({ ...presetDraft, reasoningLevels: levels.concat([level]) });
				setAddForm(null);
			};
			const commitLevelEdit = (index) => {
				if (rowEdit === null) return;
				const level = rowEdit.text.trim();
				if (level === "") return;
				const levels = (presetDraft.reasoningLevels ?? []).slice();
				const previous = levels[index];
				levels[index] = level;
				commitPresets({
					...presetDraft,
					reasoningLevels: levels,
					reasoningPresets: (presetDraft.reasoningPresets ?? []).map((preset) => ({
						...preset,
						levels: preset.levels.map((entry) => (entry === previous ? level : entry))
					}))
				});
				setRowEdit(null);
			};
			/** Removing a level also drops it from every preset that referenced it. */
			const removeLevel = (index) => {
				const levels = (presetDraft.reasoningLevels ?? []).slice();
				const removed = levels.splice(index, 1)[0];
				commitPresets({
					...presetDraft,
					reasoningLevels: levels,
					reasoningPresets: (presetDraft.reasoningPresets ?? []).map((preset) => ({
						...preset,
						levels: preset.levels.filter((entry) => entry !== removed)
					}))
				});
			};
			const moveLevel = (index, delta) => {
				const levels = (presetDraft.reasoningLevels ?? []).slice();
				const target = index + delta;
				if (target < 0 || target >= levels.length) return;
				const moved = levels.splice(index, 1)[0];
				levels.splice(target, 0, moved);
				commitPresets({ ...presetDraft, reasoningLevels: levels });
			};
			const commitPresetForm = () => {
				if (presetForm === null) return;
				const name = presetForm.name.trim();
				if (name === "") return;
				if (presetForm.id === null) {
					const id = "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
					commitPresets({ ...presetDraft, reasoningPresets: (presetDraft.reasoningPresets ?? []).concat([{ id, name, levels: presetForm.levels.slice() }]) });
				} else {
					commitPresets({
						...presetDraft,
						reasoningPresets: (presetDraft.reasoningPresets ?? []).map((preset) => (preset.id === presetForm.id ? { ...preset, name, levels: presetForm.levels.slice() } : preset))
					});
				}
				setPresetForm(null);
			};
			const removePreset = (id) => {
				commitPresets({ ...presetDraft, reasoningPresets: (presetDraft.reasoningPresets ?? []).filter((preset) => preset.id !== id) });
			};

			const numberSection = (section) => {
				const values = presetDraft[section] ?? [];
				const edit = rowEdit !== null && rowEdit.section === section ? rowEdit : null;
				const add = addForm !== null && addForm.section === section ? addForm : null;
				const rows = values.map((entry, index) => h("div", { className: "mtw_row", key: section + ":" + entry },
					edit !== null && edit.index === index
						? h(Fragment, null,
							h("input", { className: "mtw_input", value: edit.text, onChange: (event) => setRowEdit({ ...edit, text: event.target.value }) }),
							h("button", { className: "mtw_button mtw_small", onClick: () => commitNumberEdit(section, index) }, t("save")),
							h("button", { className: "mtw_button mtw_small", onClick: () => setRowEdit(null) }, t("cancel")))
						: h(Fragment, null,
							h("span", { className: "mtw_value" }, formatCount(entry)),
							h("span", { className: "mtw_spacer" }),
							h("button", { className: "mtw_button mtw_small", onClick: () => setRowEdit({ section, index, text: String(entry) }) }, t("edit")),
							h("button", { className: "mtw_button mtw_small", onClick: () => removeNumber(section, index) }, t("delete")))));
				return h("div", { className: "mtw_field", key: section },
					h("div", { className: "mtw_list" },
						h("div", { className: "mtw_row", key: section + ":default" }, h("span", { className: "mtw_value" }, t("defaultLabel"))),
						rows),
					add === null
						? h("button", { className: "mtw_button mtw_small mtw_action", onClick: () => setAddForm({ section, text: "" }) }, t("add"))
						: h("div", { className: "mtw_row" },
							h("input", { className: "mtw_input", value: add.text, onChange: (event) => setAddForm({ section, text: event.target.value }) }),
							h("button", { className: "mtw_button mtw_small", onClick: () => commitNumberAdd(section) }, t("save")),
							h("button", { className: "mtw_button mtw_small", onClick: () => setAddForm(null) }, t("cancel"))));
			};

			const levelSection = () => {
				const levels = presetDraft.reasoningLevels ?? [];
				const edit = rowEdit !== null && rowEdit.section === "reasoningLevels" ? rowEdit : null;
				const add = addForm !== null && addForm.section === "reasoningLevels" ? addForm : null;
				return h("div", { className: "mtw_field" },
					h("div", { className: "mtw_list" }, levels.map((level, index) => h("div", { className: "mtw_row", key: "level:" + level },
						edit !== null && edit.index === index
							? h(Fragment, null,
								h("input", { className: "mtw_input", value: edit.text, onChange: (event) => setRowEdit({ ...edit, text: event.target.value }) }),
								h("button", { className: "mtw_button mtw_small", onClick: () => commitLevelEdit(index) }, t("save")),
								h("button", { className: "mtw_button mtw_small", onClick: () => setRowEdit(null) }, t("cancel")))
							: h(Fragment, null,
								h("span", { className: "mtw_value" }, level),
								DSH_LEVELS.indexOf(level) < 0 ? h("span", { className: "mtw_muted" }, " (" + t("dshUnsupported") + ")") : null,
								h("span", { className: "mtw_spacer" }),
								h("button", { className: "mtw_button mtw_small", disabled: index === 0, onClick: () => moveLevel(index, -1) }, "↑"),
								h("button", { className: "mtw_button mtw_small", disabled: index === levels.length - 1, onClick: () => moveLevel(index, 1) }, "↓"),
								h("button", { className: "mtw_button mtw_small", onClick: () => setRowEdit({ section: "reasoningLevels", index, text: level }) }, t("edit")),
								h("button", { className: "mtw_button mtw_small", onClick: () => removeLevel(index) }, t("delete")))))),
					add === null
						? h("button", { className: "mtw_button mtw_small mtw_action", onClick: () => setAddForm({ section: "reasoningLevels", text: "" }) }, t("add"))
						: h("div", { className: "mtw_row" },
							h("input", { className: "mtw_input", value: add.text, onChange: (event) => setAddForm({ section: "reasoningLevels", text: event.target.value }) }),
							h("button", { className: "mtw_button mtw_small", onClick: commitLevelAdd }, t("save")),
							h("button", { className: "mtw_button mtw_small", onClick: () => setAddForm(null) }, t("cancel"))));
			};

			const presetSection = () => {
				const presetList = presetDraft.reasoningPresets ?? [];
				const available = presetDraft.reasoningLevels ?? [];
				return h("div", { className: "mtw_field" },
					h("div", { className: "mtw_list" }, presetList.map((preset) => h("div", { className: "mtw_row", key: "preset:" + preset.id },
						h("span", { className: "mtw_value" }, preset.name),
						h("span", { className: "mtw_muted" }, supportsText(preset.levels, t)),
						h("span", { className: "mtw_spacer" }),
						h("button", { className: "mtw_button mtw_small", onClick: () => setPresetForm({ id: preset.id, name: preset.name, levels: preset.levels.slice() }) }, t("edit")),
						h("button", { className: "mtw_button mtw_small", onClick: () => removePreset(preset.id) }, t("delete"))))),
					presetForm === null
						? h("button", { className: "mtw_button mtw_small mtw_action", onClick: () => setPresetForm({ id: null, name: "", levels: [] }) }, t("newPreset"))
						: h("div", { className: "mtw_field" },
							h("div", { className: "mtw_row" },
								h("input", {
									className: "mtw_input",
									placeholder: t("presetName"),
									value: presetForm.name,
									onChange: (event) => setPresetForm({ ...presetForm, name: event.target.value })
								}),
								h("button", { className: "mtw_button mtw_small", disabled: presetForm.name.trim() === "", onClick: commitPresetForm }, t("save")),
								h("button", { className: "mtw_button mtw_small", onClick: () => setPresetForm(null) }, t("cancel"))),
							h("div", { className: "mtw_checks" }, available.map((level) => h("label", { key: "pf:" + level, className: "mtw_check" },
								h("input", {
									type: "checkbox",
									checked: presetForm.levels.indexOf(level) >= 0,
									onChange: (event) => setPresetForm({
										...presetForm,
										levels: event.target.checked ? presetForm.levels.concat([level]) : presetForm.levels.filter((entry) => entry !== level)
									})
								}),
								levelLabel(level))))));
			};

			/**
			 * v1.16: one card's own Apply row, pinned to the bottom of that card's body. Enabled only
			 * for that card's pending edits; the hairline above it separates it from the + Add / + New
			 * Preset action. `writable === false` keeps it disabled (plus the page-level read-only line).
			 */
			const cardFooter = (card) => {
				const dirty = cardDirty(card);
				return h("div", { className: "mtw_cardFooter" },
					h("button", {
						className: "mtw_button mtw_buttonPrimary",
						disabled: !dirty || !writable,
						onClick: applyPresets
					}, t("apply")),
					dirty ? h("span", { className: "mtw_muted" }, t("unsaved")) : null);
			};

			/**
			 * v1.7/v1.12/v1.16: one foldable **card** per Presets section (default folded, folding never
			 * writes). The shell and title classes are deliberately the same ones the provider and model
			 * cards use, so the owner sees one consistent card style across both tabs — and each card
			 * ends with its own Apply.
			 */
			const collapsible = (key, title, body, card) => {
				const expanded = expandedSections[key] === true;
				return h("div", { className: "mtw_group", key },
					h("button", {
						type: "button",
						className: "mtw_groupHeader",
						"aria-expanded": expanded,
						onClick: () => toggleCollapse(setExpandedSections, key)
					},
						h("span", { className: "mtw_caret" }, expanded ? "▾" : "▸"),
						h("span", { className: "mtw_groupTitle" }, title)),
					expanded ? h("div", { className: "mtw_groupBody" }, body, cardFooter(card)) : null);
			};

			const renderPresets = () => {
				if (presetDraft === null) return h("div", { className: "mtw_muted" }, t("loading"));
				return h(Fragment, null,
					collapsible("contextWindows", t("contextWindowList"), numberSection("contextWindows"), "contextWindows"),
					collapsible("maxOutputs", t("maxOutputList"), numberSection("maxOutputs"), "maxOutputs"),
					collapsible("reasoningLevels", t("reasoningLevelsList"), levelSection(), "reasoningLevels"),
					collapsible("reasoningPresets", t("reasoningPresetsList"), presetSection(), "reasoningPresets"),
					// v1.16: the page-level footer keeps only the explicit "restore built-in defaults"
					// action; every Apply now lives inside its own card.
					h("div", { className: "mtw_footer" },
						h("button", {
							className: "mtw_button",
							disabled: !writable,
							onClick: restoreDefaultPresets
						}, t("restoreDefaults"))),
					noticeLine(),
					writable ? null : h("div", { className: "mtw_error" }, t("readOnly")));
			};
			//#endregion

			if (load.status === "loading") return h("div", { className: "mtw_muted" }, t("loading"));
			if (load.status === "error") {
				return h("div", { className: "mtw_field" },
					h("div", { className: "mtw_error" }, load.message),
					h("button", { className: "mtw_button", onClick: refresh }, t("retry")));
			}
			return h("div", { className: "mtw_root" },
				h("div", { className: "mtw_tabs" },
					h("button", {
						className: "mtw_tab" + (tab === "caps" ? " mtw_tabActive" : ""),
						onClick: () => setTab("caps")
					}, t("capsTab")),
					h("button", {
						className: "mtw_tab" + (tab === "presets" ? " mtw_tabActive" : ""),
						onClick: () => setTab("presets")
					}, t("presetsTab"))),
				tab === "caps" ? renderCapabilities() : renderPresets(),
				warningsLine());
		}

		/** Cordis services this half needs: slot registration + dictionaries. */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			const locale = ctx.locale;
			if (locale !== undefined && locale !== null && typeof locale.register === "function") {
				ctx.effect(() => locale.register(NS, { zh, en }), NS + ": dictionaries");
			}
			const t = locale !== undefined && locale !== null && typeof locale.bind === "function"
				? locale.bind(NS)
				: (key) => en[key] ?? key;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "model-tweaks",
				order: 250,
				label: () => t("nav"),
				locale: NS
			}, ModelCapabilitiesSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		/**
		 * v1.10: exported purely so offline tests can pin it. `formatCount` has to exist on both
		 * halves (the client bundle cannot import the host half, and the host cannot import a browser
		 * bundle), so there is no single source of truth to share — instead the two copies are welded
		 * together by one shared input/output table plus a cross-half assertion in
		 * `test/manifest.test.mjs`. DSH itself only reads `apply` / `inject`.
		 */
		exports.formatCount = formatCount;
		/** v1.10: same reason as `formatCount` — a mirrored fallback the cross-half test deep-compares. */
		exports.DEFAULT_PRESETS = DEFAULT_PRESETS;
		return module.exports;
	}
});
