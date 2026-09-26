/**
 * Client page contract: `lib/client.js` is a hand-written browser bundle, so these tests drive it
 * through the harness (stub `__ModuleLoader__` + mini React + fetch double) and assert the
 * *observable* surface only — never its internals:
 *
 *   - contract §6.1/§6.2: module id, inject list, the `settings.section` registration
 *   - contract §0/§6.3 + v1.2: two tabs, the four capability controls, no Audio/Video,
 *     the Reasoning option order, `Default` semantics
 *   - contract v1.5: draft + Apply — an edit must never fetch, `Apply` is the only writer
 *   - contract v1.7: provider groups with foldable headers (Model control) and foldable Presets
 *     sections, reading the new `providers` field and degrading to a single untitled group for an
 *     older host response; folding is local state and must never fetch
 *   - contract v1.8/v1.9: the capability editor is inline under the *opened* model row (page loads
 *     with nothing expanded; clicking the same row toggles it), provider groups and Presets
 *     sections fold without fetching, and Presets sections start collapsed with an indented body
 *   - contract §6.2/§6.3: a dead host or a rejected save renders an error line, never a crash
 *
 * While `lib/client.js` does not exist yet, the whole suite is reported as **skipped** (an explicit
 * `# SKIP waiting for lib/client.js`, not a silent pass).
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  API_PREFIX, CLIENT_MODULE_ID, SECTION_ID, SLOT_NAME, collect, collectStrings, createInstance,
  findAllByType, flush, getClientLoad, hasClass, installFetch, loadClient, makeClientContext,
  makeLocaleDouble, mountClient, readRepo, repoExists, renderComponent, restoreFetch, textOf,
} from "./support/harness.mjs";
import { FORMAT_COUNT_CASES } from "./support/format-cases.mjs";

const NEEDS_CLIENT = repoExists("lib", "client.js") ? false : "waiting for lib/client.js";

// -- fixtures ----------------------------------------------------------------
const PRESETS = {
  version: 1,
  contextWindows: [8192, 16384, 131072],
  maxOutputs: [4096, 8192],
  reasoningLevels: ["off", "low", "high", "max"],
  reasoningPresets: [
    { id: "p-deepseek", name: "DeepSeek", levels: ["low", "high", "max"] },
    { id: "p-simple", name: "Simple", levels: ["low", "high"] },
  ],
};

const ENTRY = (id, effective = {}) => ({
  provider: "ollama",
  providerName: "Ollama Local",
  id,
  name: id,
  effective: { contextWindow: 131072, maxTokens: 8192, input: ["text", "image"], reasoningEfforts: { off: null, low: "low", high: "high", max: "max" }, ...effective },
  userDeclared: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true },
});

const MODEL = ENTRY("deepseek-v4.1-flash");
const TINY = ENTRY("tiny-model");
const GPT = { ...ENTRY("gpt-x"), provider: "openai", providerName: "OpenAI" };

/** v1.7 shape: provider groups + the flat compatibility list + warnings. */
const PROVIDERS = () => [
  { provider: "ollama", displayName: "Ollama Local", declared: true, error: null, models: [MODEL, TINY] },
  { provider: "openai", displayName: "OpenAI", declared: false, error: null, models: [GPT] },
  { provider: "broken", displayName: "Broken Provider", declared: false, error: "listModels failed", models: [] },
];
const GET_VALUE = () => ({ providers: PROVIDERS(), models: [MODEL, TINY, GPT], presets: PRESETS, writable: true, revision: 1, modalities: ["text", "image"], warnings: [] });
/** An older host response: no `providers`, only the flat list. */
const LEGACY_VALUE = () => ({ models: [MODEL], presets: PRESETS, writable: true, revision: 1, modalities: ["text", "image"] });
const SAVED = (changes = {}) => ({ model: { ...MODEL, effective: { ...MODEL.effective, ...changes } } });

// -- DOM helpers over the mini element tree ----------------------------------
const optionsOf = (select) => collect(select.props?.children ?? []).filter((element) => element.type === "option");
const optionText = (select) => optionsOf(select).map((option) => String(option.props?.children ?? ""));
const optionValue = (select) => optionsOf(select).map((option) => String(option.props?.value ?? ""));
const selects = (elements) => findAllByType(elements, "select");
const buttons = (elements) => findAllByType(elements, "button");
const checkboxes = (elements) => findAllByType(elements, "input").filter((element) => element.props?.type === "checkbox");

/** Every string reachable through the element tree's props (text, option values, labels). */
const strings = (elements) => {
  const out = [];
  const walk = (value) => {
    if (typeof value === "string") { out.push(value); return; }
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value !== null && typeof value === "object" && value.__el === true) {
      for (const prop of Object.values(value.props ?? {})) walk(prop);
    }
  };
  walk(elements);
  return out;
};

const textIncludes = (elements, pattern) => strings(elements).some((value) => pattern.test(value));
const textOfButton = (button) => collectStrings(button.props?.children ?? []).join(" ");
const buttonByText = (elements, pattern) => buttons(elements).find((button) => pattern.test(textOfButton(button)));
const isCount = (value) => /^[0-9]+$/.test(value) && Number(value) >= 1024;
const countSelect = (elements, exclude = []) => selects(elements).filter((select) => !exclude.includes(select)).find((select) => optionValue(select).some(isCount));

/** A compact rendering summary used in assertion messages so a failure is self-explanatory. */
const inventory = (elements) => elements
  .map((element) => `${String(element.type)}${element.props?.className ? "." + String(element.props.className).split(/\s+/)[0] : ""} ${JSON.stringify(collectStrings(element.props?.children ?? [])).slice(0, 70)}`)
  .slice(0, 40)
  .join("\n  ");

const changeEvent = (value) => ({ target: { value }, currentTarget: { value }, value, preventDefault() {}, stopPropagation() {} });
const clickEvent = () => ({ target: {}, currentTarget: {}, preventDefault() {}, stopPropagation() {} });

const applyChange = (element, value) => {
  assert.equal(typeof element.props?.onChange, "function", "expected an onChange handler on " + String(element.type) + "; rendered:\n  " + inventory([element]));
  return element.props.onChange(changeEvent(value));
};
/** Checkbox handlers read `event.target.checked`, not `event.target.value`. */
const checkEvent = (checked) => ({ target: { checked, value: checked ? "on" : "" }, currentTarget: { checked }, preventDefault() {}, stopPropagation() {} });
const setChecked = (element, checked) => {
  assert.equal(typeof element.props?.onChange, "function", "expected an onChange handler on the checkbox; rendered:\n  " + inventory([element]));
  return element.props.onChange(checkEvent(checked));
};
const applyClick = async (element) => {
  assert.ok(element, "expected a clickable element to act on");
  assert.equal(typeof element.props?.onClick, "function", "expected an onClick handler on " + String(element.type) + " (" + textOfButton(element) + ")");
  const result = element.props.onClick(clickEvent());
  if (result !== null && typeof result === "object" && typeof result.then === "function") await result;
};

// -- mount helpers -----------------------------------------------------------
const mount = (options = {}) => {
  const mounted = mountClient({ value: { get: GET_VALUE() }, ...options });
  const instance = createInstance();
  const props = { t: mounted.ctx.locale.bind(CLIENT_MODULE_ID), locale: mounted.ctx.locale };
  const renderTree = () => renderComponent(instance, mounted.component(SLOT_NAME), props);
  /** Flattened elements for assertions, carrying `.tree` so v1.8 can assert real ancestry. */
  const render = () => {
    const tree = renderTree();
    const elements = collect(tree);
    elements.tree = tree;
    return elements;
  };
  return { ...mounted, instance, props, render, renderTree, initial: render() };
};

/** Mount, let the mount-time `get` settle, and render the loaded page. */
const loaded = async (options = {}) => {
  const mounted = mount(options);
  await flush(5);
  return { ...mounted, elements: mounted.render() };
};

/**
 * v1.12: provider groups start **folded** and no model is selected, so a test that needs a model
 * row must first open its provider group — exactly the two clicks a user makes.
 */
const openProviderGroup = async (mounted, groupPattern = /Ollama Local/) => {
  const header = buttonByText(mounted.elements, groupPattern);
  assert.ok(header, "no provider group header matching " + groupPattern + "; rendered:\n  " + inventory(mounted.elements));
  await applyClick(header);
  return mounted.render();
};

/** v1.12: open the provider group, then click the model row (which selects + expands it). */
const loadedExpanded = async (options = {}, modelPattern = /deepseek-v4\.1-flash/, groupPattern = /Ollama Local/) => {
  const mounted = await loaded(options);
  const expandedGroup = await openProviderGroup(mounted, groupPattern);
  await applyClick(buttonByText(expandedGroup, modelPattern));
  return { ...mounted, elements: mounted.render() };
};

/** Direct element children of one element (arrays flattened one level). */
const directChildren = (element) => {
  const out = [];
  const push = (node) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const item of node) push(item); return; }
    if (typeof node === "object" && node.__el === true) out.push(node);
  };
  push(element?.props?.children);
  return out;
};

/** Map each element of a raw tree to its parent element (`null` for the root). */
const parentMapOf = (root) => {
  const parents = new Map();
  const walk = (node, parent) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, parent); return; }
    if (typeof node !== "object" || node.__el !== true) return;
    parents.set(node, parent);
    walk(node.props?.children, node);
  };
  walk(root, null);
  return parents;
};

const ancestorsOf = (element, parents) => {
  const out = [];
  let current = parents.get(element) ?? null;
  while (current !== null && current !== undefined) { out.push(current); current = parents.get(current) ?? null; }
  return out;
};

const editorOf = (elements) => elements.find((element) => hasClass(element, "editor"));

/**
 * v1.8: the Apply button must live inside the selected model's inline editor. Every assertion that
 * clicks Apply goes through this helper, so "Apply is a shared page-bottom panel" cannot come back.
 */
const applyButton = (elements) => {
  assert.ok(elements && elements.tree, "applyButton() needs a tree-carrying render (use mount().render())");
  const parents = parentMapOf(elements.tree);
  const editor = editorOf(elements);
  assert.ok(editor, "no inline editor was rendered under the selected model; rendered:\n  " + inventory(elements));
  const apply = elements.find((element) => element.type === "button"
    && /apply|应用/i.test(textOfButton(element))
    && ancestorsOf(element, parents).includes(editor));
  assert.ok(apply, "no Apply button inside the selected model's inline editor; rendered:\n  " + inventory(elements));
  return apply;
};
/** Every save request the plugin issued, in order. */
const savesOf = (calls) => calls.filter((call) => String(call.url).endsWith(API_PREFIX + "/save"));

/** Load a fresh client and return the stylesheet it injected into its `<style>` tag. */
const injectedCss = () => {
  loadClient();
  return getClientLoad().dom.styles.map((style) => style.textContent).join("\n");
};

/**
 * The declaration block of one **exact** selector from the injected stylesheet. Fails when the rule
 * is gone, so "make it flat / separated" cannot be reached by deleting the whole rule.
 */
const declarationsIn = (css, selector) => {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}");
  const match = pattern.exec(css);
  assert.ok(match, "the injected stylesheet must still define " + selector);
  return match[1];
};

after(() => { restoreFetch(); });

// -- tests -------------------------------------------------------------------
describe("client page contract", { skip: NEEDS_CLIENT }, () => {
  it("loads with the contract module id and the minimal inject list", () => {
    const plugin = loadClient();
    assert.equal(getClientLoad().moduleId, CLIENT_MODULE_ID, "lib/client.js must register the contract module id");
    assert.deepEqual(plugin.inject, ["slots", "locale"], "configForms/remote must not be injected");
    // `react` / `react/jsx-runtime` are baseline client modules; `dsh.client.inject` lists the
    // client plugin packages (module graph + activation order), which this bundle may use freely.
    const allowed = ["react", "react/jsx-runtime", ...JSON.parse(readRepo("package.json")).dsh.client.inject];
    for (const id of getClientLoad().required) {
      assert.ok(allowed.includes(id), "undeclared client require: " + id);
    }
  });

  it("registers the settings.section slot with the contract id and order", () => {
    const plugin = loadClient();
    const { ctx, slots, injections } = makeClientContext();
    plugin.apply(ctx);
    assert.ok(injections.includes(SLOT_NAME), "apply() must inject into " + SLOT_NAME);
    const entry = slots.get(SLOT_NAME);
    assert.ok(entry, "no component registered for " + SLOT_NAME);
    assert.equal(entry.options.name, SLOT_NAME);
    assert.equal(entry.options.id, SECTION_ID);
    assert.equal(entry.options.order, 250);
    assert.equal(typeof entry.options.label, "function", "the nav label must be a function (locale-bound)");
    assert.equal(typeof entry.options.label(), "string");
    assert.ok(entry.options.label().length > 0);
  });

  it("renders a first frame without crashing before the data arrives", () => {
    const mounted = mountClient({ value: {} });
    const elements = collect(renderComponent(createInstance(), mounted.component(SLOT_NAME), {}));
    assert.ok(Array.isArray(elements), "the first frame must render an element tree");
    assert.ok(elements.length > 0, "the first frame must not be empty");
  });

  it("renders two tabs, the provider-grouped Model control and the four capability controls", async () => {
    const { elements } = await loadedExpanded();
    assert.ok(buttons(elements).length >= 2, "expected at least the two tab buttons; rendered:\n  " + inventory(elements));

    // v1.7: the Model control is a set of provider headers with selectable rows, not a <select>.
    assert.ok(
      !selects(elements).some((select) => optionText(select).some((text) => text.includes(MODEL.id))),
      "the Model control must no longer be a model-listing <select>; rendered:\n  " + inventory(elements),
    );
    const ollamaHeader = buttonByText(elements, /Ollama Local/);
    assert.ok(ollamaHeader, "no provider group header for Ollama Local; rendered:\n  " + inventory(elements));
    assert.match(textOfButton(ollamaHeader), /\(2\)/, "the group header must show how many models it holds");
    assert.ok(buttonByText(elements, /deepseek-v4\.1-flash/), "the group must list its models");
    assert.match(textOfButton(ollamaHeader), /Declared/, "a declared provider must be annotated");
    const brokenHeader = buttonByText(elements, /Broken Provider/);
    assert.ok(brokenHeader, "a provider whose listModels failed must still appear; rendered:\n  " + inventory(elements));
    assert.match(textOfButton(brokenHeader), /listModels failed/, "a failing provider group must surface the error");

    const contextWindow = countSelect(elements);
    assert.ok(contextWindow, "no Context Window dropdown (options from presets.contextWindows); rendered:\n  " + inventory(elements));
    const maxOutput = countSelect(elements, [contextWindow]);
    assert.ok(maxOutput, "no Max Output dropdown; rendered:\n  " + inventory(elements));
    for (const [name, select] of [["Context Window", contextWindow], ["Max Output", maxOutput]]) {
      assert.ok(optionText(select).some((text) => /default/i.test(text)), name + " must offer a Default option, got " + JSON.stringify(optionText(select)));
    }

    const boxes = checkboxes(elements);
    assert.ok(boxes.length >= 3, "expected a Default box plus Text/Image boxes, got " + boxes.length + "; rendered:\n  " + inventory(elements));
    assert.ok(!strings(elements).some((value) => /audio|video/i.test(value)), "DSH only supports text/image; Audio/Video must not be rendered");

    const reasoning = selects(elements).find((select) => optionText(select).some((text) => /custom/i.test(text)));
    assert.ok(reasoning, "no Reasoning Levels dropdown with a Custom… option; rendered:\n  " + inventory(elements));
    const labels = optionText(reasoning);
    assert.ok(labels.some((text) => /default/i.test(text)) && labels.some((text) => /global/i.test(text)), "Reasoning options must start with Default/Global, got " + JSON.stringify(labels));
    const index = (pattern) => labels.findIndex((text) => pattern.test(text));
    assert.ok(index(/default/i) < index(/global/i), "Default must precede Global, got " + JSON.stringify(labels));
    for (const preset of PRESETS.reasoningPresets) {
      const at = labels.findIndex((text) => text.includes(preset.name));
      assert.ok(at > index(/global/i), "preset " + preset.name + " must follow Global, got " + JSON.stringify(labels));
      assert.ok(at < index(/custom/i), "preset " + preset.name + " must precede Custom, got " + JSON.stringify(labels));
    }
    assert.ok(index(/custom/i) === labels.length - 1, "Custom… must be last, got " + JSON.stringify(labels));

    assert.ok(buttonByText(elements, /reset to default|重置为默认/i), "expected a Reset to Default button; rendered:\n  " + inventory(elements));
    const apply = applyButton(elements);
    assert.ok(apply, "expected an Apply button; rendered:\n  " + inventory(elements));
    assert.equal(apply.props.disabled, true, "Apply must be disabled while there is nothing to save");
  });

  it("folds a provider group without writing anything", async () => {
    const { elements, render, calls } = await loaded();
    const baseline = calls.length;
    const header = buttonByText(elements, /Ollama Local/);
    // v1.12: every provider card starts folded, so the first click opens it.
    assert.equal(header.props["aria-expanded"], false, "provider groups must start folded");
    assert.equal(buttonByText(elements, /tiny-model/), undefined, "no model row may render while the group is folded");

    await applyClick(header);
    const unfolded = render();
    assert.ok(buttonByText(unfolded, /tiny-model/), "opening a group must reveal its model rows");
    assert.equal(buttonByText(unfolded, /Ollama Local/).props["aria-expanded"], true, "the opened header must report aria-expanded=true");
    assert.equal(calls.length, baseline, "opening a group must not fetch (local state only)");

    await applyClick(buttonByText(unfolded, /Ollama Local/));
    const folded = render();
    assert.equal(buttonByText(folded, /tiny-model/), undefined, "closing a group must hide its model rows again");
    assert.ok(buttonByText(folded, /Ollama Local/), "the group header must stay visible while folded");
    assert.equal(buttonByText(folded, /Ollama Local/).props["aria-expanded"], false, "the folded header must report aria-expanded=false");
    assert.equal(calls.length, baseline, "closing must not fetch either");
  });

  it("selects another model from a group and saves that model", async () => {
    const mounted = await loaded({ value: { get: GET_VALUE(), save: SAVED() } });
    const { calls } = mounted;
    // v1.12: nothing is selected on load.
    assert.equal(buttons(mounted.elements).some((button) => button.props["aria-pressed"] === true), false, "no model may start selected");

    const opened = await openProviderGroup(mounted);
    await applyClick(buttonByText(opened, /deepseek-v4\.1-flash/));
    const first = mounted.render();
    assert.equal(buttonByText(first, /deepseek-v4\.1-flash/).props["aria-pressed"], true, "clicking a row must select it");
    assert.equal(buttonByText(first, /tiny-model/).props["aria-pressed"], false, "the other row must stay unselected");

    await applyClick(buttonByText(first, /tiny-model/));
    const selected = mounted.render();
    assert.equal(buttonByText(selected, /tiny-model/).props["aria-pressed"], true, "clicking another row must move the selection");
    assert.equal(buttonByText(selected, /deepseek-v4\.1-flash/).props["aria-pressed"], false, "the previous selection must be cleared");

    const contextWindow = countSelect(selected);
    applyChange(contextWindow, optionValue(contextWindow).find(isCount));
    await applyClick(applyButton(mounted.render()));
    await flush(5);

    const saves = savesOf(calls);
    assert.equal(saves.length, 1, "Apply must still issue exactly one save");
    assert.equal(saves[0].body.model, "tiny-model", "the save body must target the newly selected model");
    assert.equal(saves[0].body.provider, "ollama");
  });

  it("discards an unsaved draft when another group row is selected", async () => {
    const { elements, render, calls } = await loadedExpanded();
    const baseline = calls.length;
    const contextWindow = countSelect(elements);
    applyChange(contextWindow, optionValue(contextWindow).find(isCount));
    assert.notEqual(applyButton(render()).props.disabled, true, "the edit must make Apply available");

    await applyClick(buttonByText(render(), /tiny-model/));
    const switched = render();
    assert.equal(applyButton(switched).props.disabled, true, "switching models must drop the unsaved draft");
    assert.equal(calls.length, baseline, "switching models must not write");
    assert.ok(textIncludes(switched, /discard/i), "the user must be told the draft was discarded; rendered:\n  " + inventory(switched));
  });

  it("starts every Presets section collapsed and expands one without writing", async () => {
    const { elements, render, calls } = await loaded();
    const baseline = calls.length;
    const tab = buttonByText(elements, /preset/i) ?? buttons(elements)[1];
    assert.ok(tab, "no second tab to click; rendered:\n  " + inventory(elements));
    await applyClick(tab);
    const after = render();
    assert.notDeepEqual(textOf(after), textOf(elements), "clicking the Presets tab must change the view");

    for (const title of ["Context Window", "Max Output", "Reasoning Levels", "Reasoning Presets"]) {
      const header = buttonByText(after, new RegExp(title, "i"));
      assert.ok(header, "the Presets tab must have a foldable header for " + title + "; rendered:\n  " + inventory(after));
      assert.equal(header.props["aria-expanded"], false, title + " must start collapsed (v1.9)");
    }
    assert.ok(!textIncludes(after, /16384/), "no section body may be visible while every section is collapsed");

    await applyClick(buttonByText(after, /Context Window/i));
    const expanded = render();
    assert.ok(textIncludes(expanded, /16384/), "expanding must reveal that section's rows");
    assert.equal(buttonByText(expanded, /Context Window/i).props["aria-expanded"], true, "the header must report the expanded state");
    assert.ok(!textIncludes(expanded, /4096/), "expanding one section must not expand the others");
    const body = expanded.find((element) => hasClass(element, "groupBody"));
    assert.ok(body, "an expanded section must render an indented body so it reads as a child; rendered:\n  " + inventory(expanded));
    assert.equal(calls.length, baseline, "expanding a Presets section must not fetch");

    await applyClick(buttonByText(expanded, /Context Window/i));
    const collapsedAgain = render();
    assert.ok(!textIncludes(collapsedAgain, /16384/), "clicking the header again must collapse it");
    assert.equal(calls.length, baseline, "collapsing a Presets section must not fetch");
  });

  it("formats counts decimal-only, leaving binary values as plain numbers", async () => {
    const formatted = () => ({
      providers: [{ provider: "ollama", displayName: "Ollama Local", declared: true, error: null, models: [MODEL] }],
      models: [MODEL],
      presets: { version: 1, contextWindows: [8, 1000, 128000, 200000, 131072, 262144, 1048576, 1000000], maxOutputs: [4096], reasoningLevels: ["low"], reasoningPresets: [] },
      writable: true, revision: 1, modalities: ["text", "image"], warnings: [],
    });
    const { elements } = await loadedExpanded({ value: { get: formatted } });
    const contextWindow = countSelect(elements);
    assert.ok(contextWindow, "the Context Window dropdown must render; rendered:\n  " + inventory(elements));
    assert.deepEqual(optionText(contextWindow), [
      "Default", "8", "1K", "128K", "200K", "131072", "262144", "1048576", "1M",
    ], "only decimal round numbers are abbreviated: 1M means 1000000, and 1048576 stays a plain number");
  });

  it("formats the shared table exactly (the client copy of formatCount)", () => {
    const plugin = loadClient();
    assert.equal(typeof plugin.formatCount, "function", "lib/client.js must export formatCount for the cross-half table in manifest.test.mjs");
    // The one shared table (`test/support/format-cases.mjs`); the host's own table in
    // `test/host-api.test.mjs` must stay identical, because neither half can import the other.
    for (const [value, expected] of FORMAT_COUNT_CASES) {
      assert.equal(plugin.formatCount(value), expected, "formatCount(" + value + ")");
    }
  });

  it("restores the default presets with exactly one explicit resetDefaults request", async () => {
    const restored = { version: 1, contextWindows: [1000000], maxOutputs: [4000], reasoningLevels: ["low"], reasoningPresets: [] };
    const { elements, render, calls } = await loaded({ value: { get: GET_VALUE(), presets: () => ({ presets: restored }) } });
    const baseline = calls.length;
    await applyClick(buttonByText(elements, /preset/i));      // Presets tab
    let view = render();
    await applyClick(buttonByText(view, /Context Window/i));   // expand that section
    view = render();
    await applyClick(buttonByText(view, /delete/i));           // drop a row → the preset draft becomes dirty
    const dirty = render();
    assert.notEqual(buttonByText(dirty, /apply|应用/i).props.disabled, true, "a preset edit must enable Apply before we restore");

    await applyClick(buttonByText(dirty, /restore/i));
    await flush(5);
    const after = render();
    const resets = calls.filter((call) => String(call.url).endsWith(API_PREFIX + "/presets") && call.body?.action === "resetDefaults");
    assert.equal(resets.length, 1, "restore must send exactly one resetDefaults request");
    assert.equal(calls.length, baseline + 1, "restore must not send anything else");
    assert.equal(buttonByText(after, /apply|应用/i).props.disabled, true, "the restored draft is clean, so Apply is disabled again");
    assert.ok(textIncludes(after, /1M/), "the page must show the restored presets; rendered:\n  " + inventory(after));
    assert.ok(!textIncludes(after, /8192/), "the discarded draft rows must be gone (8192 no longer has a label to hide behind)");
  });

  it("shows the host message when restoring the default presets fails", async () => {
    const { elements, render } = await loaded();
    await applyClick(buttonByText(elements, /preset/i));
    installFetch({}, { ok: false, status: 500, error: { code: "presets-write-failed", message: "写入失败原文" } });
    await applyClick(buttonByText(render(), /restore/i));
    await flush(5);
    const failed = render();
    assert.ok(textIncludes(failed, /写入失败原文/), "the host text must surface in the red status line; rendered:\n  " + inventory(failed));
  });

  it("puts Apply in each Presets card footer, never on the page (v1.16)", async () => {
    const css = injectedCss();
    const footerRule = declarationsIn(css, ".mtw_cardFooter");
    assert.match(footerRule, /border-top:\s*1px solid var\(--dsw-alias-border-l1\)/, "the card footer must be separated by the subtle border-l1 line (v1.16)");
    assert.ok(!footerRule.includes("border-l2"), "the card footer separator must never use the stronger border-l2");
    assert.match(footerRule, /display:\s*flex/, "the card footer must lay its Apply out in a row");

    const mounted = await loaded();
    const baseline = mounted.calls.length;
    await applyClick(buttonByText(mounted.elements, /preset/i));
    const folded = mounted.render();
    assert.equal(buttonByText(folded, /apply|应用/i), undefined, "a folded Presets page must not render any Apply (v1.16)");
    assert.ok(buttonByText(folded, /restore/i), "the page bottom keeps only Restore default presets");
    assert.equal(mounted.calls.length, baseline, "switching tabs must not fetch");

    await applyClick(buttonByText(folded, /Context Window/i));
    const oneCard = mounted.render();
    const parents = parentMapOf(oneCard.tree);
    const footers = oneCard.filter((element) => hasClass(element, "cardFooter"));
    assert.equal(footers.length, 1, "one expanded card → exactly one footer; rendered:\n  " + inventory(oneCard));
    const footer = footers[0];
    const apply = buttonByText(oneCard, /apply|应用/i);
    assert.ok(apply, "the expanded card must expose its Apply; rendered:\n  " + inventory(oneCard));
    assert.ok(ancestorsOf(apply, parents).includes(footer), "Apply must live inside .mtw_cardFooter, not at the page bottom");
    assert.equal(apply.props.disabled, true, "a card with no pending edits keeps its Apply disabled");

    const body = parents.get(footer);
    assert.ok(hasClass(body, "groupBody"), "the footer must sit inside the card body");
    const bodyChildren = directChildren(body);
    assert.equal(bodyChildren[bodyChildren.length - 1], footer, "the footer must be the last item of the card body");
    const add = buttonByText(oneCard, /\+ add/i);
    assert.ok(add, "the card must still offer + Add; rendered:\n  " + inventory(oneCard));
    assert.ok(ancestorsOf(add, parents).includes(bodyChildren[bodyChildren.length - 2]),
      "the + Add action must sit directly above the card footer (the footer's top line is the separator)");
    assert.equal(mounted.calls.length, baseline, "expanding a card must not fetch");

    // a committed edit is draft-only…
    await applyClick(buttonByText(oneCard, /delete/i));
    const dirty = mounted.render();
    assert.equal(mounted.calls.length, baseline, "a preset edit must not fetch (draft only, v1.16)");
    assert.notEqual(buttonByText(dirty, /apply|应用/i).props.disabled, true, "the edited card's Apply must become available");

    // …and two expanded cards keep independent Apply states
    await applyClick(buttonByText(dirty, /Max Output/i));
    const twoCards = mounted.render();
    const applies = buttons(twoCards).filter((button) => /apply|应用/i.test(textOfButton(button)));
    assert.equal(applies.length, 2, "two expanded cards → two Applies");
    assert.deepEqual(applies.map((button) => button.props.disabled === true), [false, true],
      "only the edited card's Apply may be enabled; rendered:\n  " + inventory(twoCards));
  });

  it("one Apply saves the whole preset document and clears every card (v1.16)", async () => {
    const echo = (record) => (record.body?.action === "save" ? { presets: record.body.payload } : { presets: PRESETS });
    const mounted = await loaded({ value: { get: GET_VALUE(), presets: echo } });
    await applyClick(buttonByText(mounted.elements, /preset/i));
    await applyClick(buttonByText(mounted.render(), /Context Window/i));
    await applyClick(buttonByText(mounted.render(), /Max Output/i));
    await applyClick(buttonByText(mounted.render(), /delete/i));            // edit the Context Window card
    const edited = mounted.render();
    const applies = buttons(edited).filter((button) => /apply|应用/i.test(textOfButton(button)));
    assert.equal(applies.length, 2, "precondition: two card Applies");

    await applyClick(applies[0]);
    await flush(5);
    const saves = mounted.calls.filter((call) => String(call.url).endsWith(API_PREFIX + "/presets") && call.body?.action === "save");
    assert.equal(saves.length, 1, "Apply must send exactly one presets save");
    const payload = saves[0].body.payload;
    for (const field of ["version", "contextWindows", "maxOutputs", "reasoningLevels", "reasoningPresets"]) {
      assert.ok(field in payload, "the whole document must be submitted (" + field + " missing) — one document must never end up half-saved");
    }
    assert.deepEqual(payload.contextWindows, [16384, 131072], "the pending edit must be inside the submitted document");

    const settled = mounted.render();
    const settledApplies = buttons(settled).filter((button) => /apply|应用/i.test(textOfButton(button)));
    assert.equal(settledApplies.length, 2, "both cards stay expanded");
    assert.ok(settledApplies.every((button) => button.props.disabled === true), "after a successful Apply every card's Apply returns to disabled");

    // the Reasoning Presets card follows the same "footer under the + New Preset action" shape
    await applyClick(buttonByText(settled, /Reasoning Presets/i));
    const withPresetsCard = mounted.render();
    const cardParents = parentMapOf(withPresetsCard.tree);
    const newPreset = buttonByText(withPresetsCard, /new preset/i);
    assert.ok(newPreset, "the Reasoning Presets card must offer + New Preset; rendered:\n  " + inventory(withPresetsCard));
    const newPresetBody = ancestorsOf(newPreset, cardParents).find((element) => hasClass(element, "groupBody"));
    assert.ok(newPresetBody, "the + New Preset action must live inside a card body");
    const newPresetChildren = directChildren(newPresetBody);
    assert.ok(hasClass(newPresetChildren[newPresetChildren.length - 1], "cardFooter"),
      "the + New Preset card must end with its own footer; rendered:\n  " + inventory(withPresetsCard));
    assert.ok(ancestorsOf(newPreset, cardParents).includes(newPresetChildren[newPresetChildren.length - 2]),
      "the + New Preset action must sit directly above its card footer");
  });

  it("rolls the Presets draft back to the persisted document when Apply fails (v1.16)", async () => {
    const mounted = await loaded();
    await applyClick(buttonByText(mounted.elements, /preset/i));
    await applyClick(buttonByText(mounted.render(), /Context Window/i));
    await applyClick(buttonByText(mounted.render(), /delete/i));
    const dirty = mounted.render();
    assert.notEqual(buttonByText(dirty, /apply|应用/i).props.disabled, true, "precondition: the card is dirty");

    installFetch({}, { ok: false, status: 500, error: { code: "presets-write-failed", message: "写入失败原文" } });
    await applyClick(buttonByText(dirty, /apply|应用/i));
    await flush(5);
    const failed = mounted.render();
    assert.ok(textIncludes(failed, /写入失败原文/), "the host text must surface; rendered:\n  " + inventory(failed));
    assert.equal(buttonByText(failed, /apply|应用/i).props.disabled, true, "the failed write must roll the draft back to the persisted document");
    assert.ok(textIncludes(failed, /8192/), "the deleted row must come back after the rollback; rendered:\n  " + inventory(failed));
  });

  it("treats a presets reply without a document as a failure instead of blanking the page (v1.16)", async () => {
    const mounted = await loaded({ value: { get: GET_VALUE(), presets: () => ({}) } });
    await applyClick(buttonByText(mounted.elements, /preset/i));
    await applyClick(buttonByText(mounted.render(), /Context Window/i));
    await applyClick(buttonByText(mounted.render(), /delete/i));
    await applyClick(buttonByText(mounted.render(), /apply|应用/i));
    await flush(5);
    const after = mounted.render();
    assert.ok(after.length > 0, "the Presets page must not blank out");
    assert.ok(textIncludes(after, /did not return|没有返回/i), "the saveNoReply message must surface; rendered:\n  " + inventory(after));
    assert.ok(textIncludes(after, /8192/), "the page must still show the persisted document");
  });

  it("labels the model picker as Provider / 提供商 (v1.16)", async () => {
    const en = await loaded();
    assert.ok(textIncludes(en.elements, /provider/i), "the caps picker label must read Provider; rendered:\n  " + inventory(en.elements));
    assert.ok(!strings(en.elements).some((value) => /^(model|模型)$/.test(value.trim())), "Model must no longer be used as the picker's field label");
    assert.ok(textIncludes(en.elements, /model capabilities/i), "the tab label itself is untouched");

    const zh = await loaded({ context: { locale: makeLocaleDouble({}, "zh").service } });
    assert.ok(textIncludes(zh.elements, /提供商/), "the Chinese label must read 提供商; rendered:\n  " + inventory(zh.elements));
  });

  it("degrades to one untitled group for an older host response without `providers`", async () => {
    const mounted = await loaded({ value: { get: LEGACY_VALUE() } });
    const header = buttons(mounted.elements).find((button) => /\(\d+\)/.test(textOfButton(button)));
    assert.ok(header, "the fallback must render a single untitled group header; rendered:\n  " + inventory(mounted.elements));
    assert.equal(header.props["aria-expanded"], false, "the fallback group starts folded too (v1.12)");
    assert.equal(buttonByText(mounted.elements, /deepseek-v4\.1-flash/), undefined, "a folded group renders no model rows");

    await applyClick(header);
    const opened = mounted.render();
    assert.ok(buttonByText(opened, /deepseek-v4\.1-flash/), "opening the fallback group must reveal the legacy flat models list");

    await applyClick(buttons(opened).find((button) => /\(\d+\)/.test(textOfButton(button))));
    const folded = mounted.render();
    assert.equal(buttonByText(folded, /deepseek-v4\.1-flash/), undefined, "closing the fallback group must hide them again");
  });

  it("shows host warnings as a muted diagnostics line, and nothing when there are none", async () => {
    const clean = await loaded();
    assert.ok(!textIncludes(clean.elements, /diagnostics/i), "no warnings must render no diagnostics line; rendered:\n  " + inventory(clean.elements));

    const warned = await loaded({ value: { get: () => ({ ...GET_VALUE(), warnings: ['llm listModels("broken") failed: boom'] }) } });
    const line = warned.elements.find((element) => hasClass(element, "muted") && textIncludes([element], /boom/));
    assert.ok(line, "the warning must be rendered as a secondary-colour diagnostics line; rendered:\n  " + inventory(warned.elements));
    assert.ok(textIncludes(warned.elements, /diagnostics/i), "the diagnostics line must carry a prefix");
    assert.ok(!hasClass(line, "noticeErr"), "diagnostics must not be styled as an error notice");
  });

  it("shows the diagnostic even when no model could be listed (the real-machine case)", async () => {
    const empty = () => ({ models: [], providers: [], presets: PRESETS, writable: true, revision: 0, modalities: ["text", "image"], warnings: ["llm service is unavailable"] });
    const { elements } = await loaded({ value: { get: empty } });
    assert.ok(textIncludes(elements, /no configurable models/i), "the empty state itself must render; rendered:\n  " + inventory(elements));
    assert.ok(textIncludes(elements, /llm service is unavailable/), "the reason for the empty list must be visible, not left to guesswork");
  });

  it("starts with no editor open, so Apply and Reset only exist inside an opened row", async () => {
    const mounted = await loaded();
    assert.equal(mounted.elements.filter((element) => hasClass(element, "editor")).length, 0, "v1.12: nothing expands when the page loads");
    assert.equal(buttonByText(mounted.elements, /apply|应用/i), undefined, "Apply only exists inside an opened editor");
    assert.equal(buttonByText(mounted.elements, /reset to default|重置为默认/i), undefined, "Reset to Default only exists inside an opened editor");
    const headers = mounted.elements.filter((element) => hasClass(element, "groupHeader"));
    assert.ok(headers.length > 0, "the page must render the provider card headers; rendered:\n  " + inventory(mounted.elements));
    for (const header of headers) {
      assert.equal(header.props["aria-expanded"], false, "every card starts folded: " + textOfButton(header));
    }
    assert.equal(buttons(mounted.elements).some((button) => button.props["aria-pressed"] === true), false, "v1.12: no model starts selected");
  });

  it("keeps Apply a primary button with distinguishable enabled and disabled states", async () => {
    loadClient();
    const css = getClientLoad().dom.styles.map((style) => style.textContent).join("\n");
    assert.ok(css.includes("--dsw-alias-brand-primary"), "the enabled state must use a theme token that actually exists (the owner-visible bug)");
    assert.ok(!css.includes("--dsw-alias-label-primary-inverted"), "--dsw-alias-label-primary-inverted is not in the running theme's token list");
    assert.ok(!css.includes("--dsw-alias-label-tertiary"), "--dsw-alias-label-tertiary is not in the running theme's token list");
    assert.ok(css.includes(".mtw_buttonPrimary:disabled"), "the disabled state needs its own rule so it cannot look identical to the enabled one");

    const { elements, render } = await loadedExpanded();
    const apply = applyButton(elements);
    assert.match(String(apply.props.className), /mtw_buttonPrimary/, "Apply must keep the primary class");
    assert.equal(apply.props.disabled, true, "Apply must be disabled with nothing to save");

    const contextWindow = countSelect(elements);
    applyChange(contextWindow, optionValue(contextWindow).find(isCount));
    const changed = applyButton(render());
    assert.notEqual(changed.props.disabled, true, "Apply must become enabled once there is something to save");
    assert.match(String(changed.props.className), /mtw_buttonPrimary/, "the class must not change between states — CSS decides the look");
  });

  it("keeps the card UI flat: no decorative bars or filled blocks (v1.13)", () => {
    const css = injectedCss();

    // v1.13: hierarchy comes from the card shell + its header background only. The brand bars and
    // the dark editor block must not come back.
    const groupBody = declarationsIn(css, ".mtw_groupBody");
    const editor = declarationsIn(css, ".mtw_editor");
    const activeRow = declarationsIn(css, ".mtw_modelRowActive");
    assert.ok(!groupBody.includes("border-left"), ".mtw_groupBody must not paint a left vertical line again (v1.13)");
    assert.ok(!editor.includes("border-left"), ".mtw_editor must not paint a left brand bar again (v1.13)");
    assert.ok(!editor.includes("background"), ".mtw_editor must stay transparent, not a filled block again (v1.13)");
    assert.ok(!activeRow.includes("box-shadow"), ".mtw_modelRowActive must not paint the brand inset bar again (v1.13)");

    // …and the surviving cues must still be there, so "flat" cannot be reached by deleting rules.
    assert.match(groupBody, /padding-left:\s*16px/, "the indented Presets body must keep its 16px indent");
    assert.match(activeRow, /font-weight:\s*500/, "the selected model title must keep its bold weight");
    assert.match(editor, /display:\s*flex/, "the editor layout rule must still exist");
  });

  it("keeps preset dividers on border-l1 and action buttons at content width (v1.14)", async () => {
    const css = injectedCss();

    // ① action buttons must hug their content instead of spanning the card.
    assert.match(declarationsIn(css, ".mtw_action"), /align-self:\s*flex-start/, "action buttons must be content-width (v1.14)");

    // ② preset rows are separated by a *subtle* hairline. The card shell keeps border-l2, so an inner
    //    divider using l2 would out-weigh its own card border — the contract forbids exactly that.
    const listRule = declarationsIn(css, ".mtw_groupBody .mtw_list");
    assert.match(listRule, /gap:\s*0/, "the preset list must drop the card-list gap so the divider carries the separation");
    assert.match(listRule, /padding:\s*0/, "the preset list must drop the card-list padding");
    const rowRule = declarationsIn(css, ".mtw_groupBody .mtw_list > .mtw_row");
    assert.match(rowRule, /border-top:\s*1px solid var\(--dsw-alias-border-l1\)/, "preset rows must be separated with the subtle border-l1 token");
    assert.ok(!rowRule.includes("border-l2"), "the inner divider must never use the stronger border-l2 (contract v1.14)");
    assert.match(declarationsIn(css, ".mtw_groupBody .mtw_list > .mtw_row:first-child"), /border-top:\s*none/, "the first row must not draw a leading line");
    assert.match(declarationsIn(css, ".mtw_group"), /border:\s*1px solid var\(--dsw-alias-border-l2\)/, "the card shell must keep border-l2, so l1 < l2 still holds");

    // DOM: the four action buttons carry mtw_action…
    const mounted = await loaded();
    await applyClick(buttonByText(mounted.elements, /preset/i));
    for (const title of ["Context Window", "Max Output", "Reasoning Levels", "Reasoning Presets"]) {
      await applyClick(buttonByText(mounted.render(), new RegExp(title, "i")));
    }
    const presetsView = mounted.render();
    const actions = buttons(presetsView).filter((button) => hasClass(button, "action"));
    const actionLabels = actions.map(textOfButton);
    assert.equal(actions.filter((button) => /add/i.test(textOfButton(button))).length, 3,
      "each + Add (Context Window / Max Output / Reasoning Levels) must be an action button; got " + JSON.stringify(actionLabels));
    assert.ok(actions.some((button) => /new preset/i.test(textOfButton(button))), "+ New Preset must be an action button; got " + JSON.stringify(actionLabels));
    assert.equal(actions.length, 4, "only the four action buttons may carry mtw_action; got " + JSON.stringify(actionLabels));

    // …and no button inside a .mtw_row may carry it (Edit / Delete / ↑ / ↓ / Save / Cancel).
    const parents = parentMapOf(presetsView.tree);
    const rowButtons = presetsView.filter((element) => element.type === "button"
      && ancestorsOf(element, parents).some((ancestor) => hasClass(ancestor, "row")));
    assert.ok(rowButtons.some((button) => /^(Edit|Delete)$/.test(textOfButton(button).trim())),
      "the check would be vacuous without row buttons; rendered:\n  " + inventory(presetsView));
    for (const button of rowButtons) {
      assert.ok(!hasClass(button, "action"), "a button inside .mtw_row must not carry mtw_action: " + textOfButton(button));
    }

    // The fourth action button only exists in the Custom reasoning mode.
    const capabilities = await loadedExpanded();
    const reasoning = selects(capabilities.elements).find((select) => optionText(select).some((text) => /custom/i.test(text)));
    assert.ok(reasoning, "the Reasoning Levels select must offer Custom…; rendered:\n  " + inventory(capabilities.elements));
    applyChange(reasoning, "custom");
    const custom = capabilities.render();
    const saveAsPreset = buttonByText(custom, /save as preset/i);
    assert.ok(saveAsPreset, "the Custom reasoning mode must offer Save as preset; rendered:\n  " + inventory(custom));
    assert.ok(hasClass(saveAsPreset, "action"), "Save as preset... must also be content-width (mtw_action)");
  });

  it("keeps Apply inside the selected model's node instead of a shared page-bottom panel", async () => {
    const elements = (await loadedExpanded()).elements;
    const parents = parentMapOf(elements.tree);
    const editors = elements.filter((element) => hasClass(element, "editor"));
    assert.equal(editors.length, 1, "exactly one model may be expanded at a time; rendered:\n  " + inventory(elements));

    const apply = applyButton(elements);
    const editor = editors[0];
    assert.ok(ancestorsOf(apply, parents).includes(editor), "Apply must live inside the inline editor");
    assert.ok(!directChildren(elements.tree).includes(apply), "Apply must not be a direct child of mtw_root (that would be the old shared panel)");

    const selectedRow = buttonByText(elements, /deepseek-v4\.1-flash/);
    const item = parents.get(selectedRow);
    assert.ok(item && hasClass(item, "modelItem"), "the selected row must sit in its own model item");
    assert.ok(ancestorsOf(apply, parents).includes(item), "Apply must be inside the selected model's node");
    assert.ok(!directChildren(elements.tree).includes(editor), "the editor must not be a page-level block");
    assert.deepEqual(directChildren(item), [selectedRow, editor], "the editor must hang directly under the selected row");
    assert.equal(buttonByText(elements, /tiny-model/).props["aria-pressed"], false, "the unselected row must not carry an editor state");
  });

  it("toggles the editor on the same row, moves it on a switch, and hides it with its group", async () => {
    const mounted = await loaded();
    const { calls } = mounted;
    const baseline = calls.length;
    const itemOf = (rendered, modelId) => {
      const row = buttons(rendered).find((button) => textOfButton(button).includes(modelId));
      assert.ok(row, "no row for " + modelId + "; rendered:\n  " + inventory(rendered));
      const item = parentMapOf(rendered.tree).get(row);
      assert.ok(item, "the row for " + modelId + " has no model item");
      return item;
    };
    const hasEditor = (item) => directChildren(item).some((element) => hasClass(element, "editor"));

    // v1.12: the provider card is folded on load, so no model row exists yet.
    assert.equal(mounted.elements.filter((element) => hasClass(element, "editor")).length, 0, "nothing is expanded when the page opens");
    const grouped = await openProviderGroup(mounted);
    assert.ok(!hasEditor(itemOf(grouped, MODEL.id)), "opening the group must not open a model editor");

    await applyClick(buttonByText(grouped, /deepseek-v4\.1-flash/));
    const opened = mounted.render();
    assert.ok(hasEditor(itemOf(opened, MODEL.id)), "clicking the model row must open its editor");
    assert.equal(calls.length, baseline, "opening the editor must not fetch");

    await applyClick(buttonByText(opened, /deepseek-v4\.1-flash/));
    const closed = mounted.render();
    assert.ok(!hasEditor(itemOf(closed, MODEL.id)), "clicking the same row again must close the editor");
    assert.equal(buttonByText(closed, /deepseek-v4\.1-flash/).props["aria-pressed"], true, "closing must not clear the selection");
    assert.equal(calls.length, baseline, "closing the editor must not fetch");

    await applyClick(buttonByText(closed, /tiny-model/));
    const switched = mounted.render();
    assert.ok(hasEditor(itemOf(switched, "tiny-model")), "selecting another row must open its editor");
    assert.ok(!hasEditor(itemOf(switched, MODEL.id)), "the previously open row must close");
    assert.equal(calls.length, baseline, "switching models must not fetch");

    await applyClick(buttonByText(switched, /Ollama Local/));
    const folded = mounted.render();
    assert.equal(folded.filter((element) => hasClass(element, "editor")).length, 0, "closing the provider group must hide the editor");
    assert.equal(calls.length, baseline, "closing the group must not fetch");

    await applyClick(buttonByText(folded, /Ollama Local/));
    const unfolded = mounted.render();
    assert.equal(unfolded.filter((element) => hasClass(element, "editor")).length, 1, "reopening the group shows the editor again");
    assert.ok(hasEditor(itemOf(unfolded, "tiny-model")), "the selection itself must survive folding");
    assert.equal(buttonByText(unfolded, /tiny-model/).props["aria-pressed"], true, "folding must not change the selection");
    assert.equal(calls.length, baseline, "reopening must not fetch");
  });

  it("loads with every provider folded and no model selected", async () => {
    const mounted = await loaded();
    const headers = mounted.elements.filter((element) => hasClass(element, "groupHeader"));
    assert.ok(headers.length >= 2, "expected one card header per provider group; rendered:\n  " + inventory(mounted.elements));
    for (const header of headers) {
      assert.equal(header.props["aria-expanded"], false, "provider card must start folded: " + textOfButton(header));
    }
    for (const id of [MODEL.id, "tiny-model", GPT.id]) {
      const pattern = new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      assert.equal(buttonByText(mounted.elements, pattern), undefined, "no model row may render while every card is folded: " + id);
    }
    assert.equal(mounted.elements.filter((element) => hasClass(element, "editor")).length, 0, "no editor may be open on load");
    assert.equal(buttonByText(mounted.elements, /apply|应用/i), undefined, "no Apply outside an opened card");
    assert.equal(buttonByText(mounted.elements, /reset to default|重置为默认/i), undefined, "no Reset outside an opened card");
    assert.equal(buttons(mounted.elements).some((button) => button.props["aria-pressed"] === true), false, "no model may start selected");
  });

  it("presets cards and provider cards share one shell and header style", async () => {
    const mounted = await loaded();
    const providerHeader = buttonByText(mounted.elements, /Ollama Local/);
    const providerShell = parentMapOf(mounted.elements.tree).get(providerHeader);
    assert.ok(providerShell && hasClass(providerShell, "group"), "the provider card shell must use the shared card class; rendered:\n  " + inventory(mounted.elements));

    const opened = await openProviderGroup(mounted);
    const modelHeader = buttonByText(opened, /deepseek-v4\.1-flash/);
    const modelShell = parentMapOf(opened.tree).get(modelHeader);
    assert.ok(modelShell && hasClass(modelShell, "group"), "the model card shell must use the shared card class");
    assert.ok(hasClass(modelShell, "modelItem"), "the model card must stay identifiable as a model item");

    await applyClick(buttonByText(opened, /preset/i));
    const presetsView = mounted.render();
    const presetsHeader = buttonByText(presetsView, /Context Window/i);
    const presetsShell = parentMapOf(presetsView.tree).get(presetsHeader);
    assert.ok(presetsShell && hasClass(presetsShell, "group"), "the Presets card shell must reuse the shared card class");

    for (const [name, header] of [["provider", providerHeader], ["model", modelHeader], ["presets", presetsHeader]]) {
      assert.ok(header, name + " card header must exist");
      assert.ok(hasClass(header, "groupHeader"), name + " header must reuse the shared header class");
      // v1.12 ¶1: the shared header body is a caret plus a title span; a model row's title span is
      // the model name instead of a group title.
      assert.ok(directChildren(header).some((element) => hasClass(element, "caret")), name + " header must carry the shared caret");
      const titleClass = name === "model" ? "modelName" : "groupTitle";
      assert.ok(directChildren(header).some((element) => hasClass(element, titleClass)), name + " header must carry its shared title span (" + titleClass + ")");
    }
  });

  it("expanding a model card reveals its editor inside the card shell", async () => {
    const elements = (await loadedExpanded()).elements;
    const parents = parentMapOf(elements.tree);
    const editor = editorOf(elements);
    assert.ok(editor, "the opened model's editor must be rendered; rendered:\n  " + inventory(elements));
    const ancestors = ancestorsOf(editor, parents);
    assert.ok(ancestors.some((element) => hasClass(element, "modelItem")), "the editor must live inside a model card");
    assert.ok(ancestors.some((element) => hasClass(element, "group")), "the model card must use the shared card shell class");
    const item = parents.get(buttonByText(elements, /deepseek-v4\.1-flash/));
    assert.equal(item, ancestors.find((element) => hasClass(element, "modelItem")), "the row and its editor must live in the very same card");
  });

  it("renders a provider group whose model list is empty without crashing", async () => {
    const withEmpty = () => ({
      providers: [
        { provider: "ollama", displayName: "Ollama Local", declared: true, error: null, models: [MODEL, TINY] },
        { provider: "hollow", displayName: "Hollow Provider", declared: false, error: null, models: [] },
      ],
      models: [MODEL, TINY], presets: PRESETS, writable: true, revision: 1, modalities: ["text", "image"], warnings: [],
    });
    const { elements, render } = await loaded({ value: { get: withEmpty } });
    const header = buttonByText(elements, /Hollow Provider/);
    assert.ok(header, "an empty group must still render its header; rendered:\n  " + inventory(elements));
    assert.match(textOfButton(header), /\(0\)/, "the empty group must report 0 models");
    assert.ok(render().length > 0, "re-rendering an empty group must not crash");
  });

  it("keeps edits as a draft: no fetch until Apply, then exactly one save", async () => {
    const { elements, render, calls } = await loadedExpanded({ value: { get: GET_VALUE(), save: SAVED({ contextWindow: 16384 }) } });
    const baseline = calls.length;
    assert.equal(baseline, 1, "the mount performs exactly one get");

    const contextWindow = countSelect(elements);
    const target = optionValue(contextWindow).find(isCount);
    applyChange(contextWindow, target);

    assert.equal(calls.length, baseline, "an edit must not write anything (v1.5: draft + Apply)");

    const draftedElements = render();
    const apply = applyButton(draftedElements);
    assert.notEqual(apply.props.disabled, true, "Apply must become available once there are unsaved changes");
    await applyClick(apply);
    await flush(5);

    const saves = savesOf(calls);
    assert.equal(saves.length, 1, "Apply must issue exactly one save");
    assert.equal(calls.length, baseline + 1, "Apply must not fire any other request");
    assert.equal(saves[0].body.provider, MODEL.provider);
    assert.equal(saves[0].body.model, MODEL.id);
    assert.deepEqual(Object.keys(saves[0].body.changes ?? {}).sort(), ["contextWindow", "input", "maxTokens", "reasoningEfforts"], "every managed field must be submitted");
    assert.equal(saves[0].body.changes.contextWindow, Number(target), "the edited value must be submitted as a real number");

    const settled = render();
    assert.equal(applyButton(settled).props.disabled, true, "after a successful Apply the draft is clean again");
  });

  it("submits null for a field switched back to Default", async () => {
    const { elements, render, calls } = await loadedExpanded({ value: { get: GET_VALUE(), save: SAVED({ contextWindow: null }) } });
    const contextWindow = countSelect(elements);
    const defaultOption = optionsOf(contextWindow).find((option) => /default/i.test(String(option.props?.children ?? "")));
    assert.ok(defaultOption, "neither dropdown offers a Default option: " + JSON.stringify(optionText(contextWindow)));
    applyChange(contextWindow, String(defaultOption.props?.value ?? ""));
    await applyClick(applyButton(render()));
    await flush(5);

    const save = savesOf(calls)[0];
    assert.ok(save, "Apply must issue a save");
    assert.equal(save.body.changes.contextWindow, null, "Default must be sent as null (host deletes the field)");
  });

  it("keeps Text/Image clickable and treats them as one choice with Default (v1.18)", async () => {
    // The grey-out rule is gone together with the "uncheck Default first" dance.
    assert.ok(!injectedCss().includes(".mtw_checkOff"), ".mtw_checkOff must no longer exist — no modality may be un-clickable (v1.18)");

    // Start from the owner's exact scenario: the model declares no input, so Default is checked.
    const undeclared = () => {
      const model = { ...MODEL, userDeclared: { ...MODEL.userDeclared, input: false } };
      return { providers: [{ provider: "ollama", displayName: "Ollama Local", declared: true, error: null, models: [model] }], models: [model], presets: PRESETS, writable: true, revision: 1, modalities: ["text", "image"], warnings: [] };
    };
    const echo = (record) => ({ model: { ...MODEL, effective: { ...MODEL.effective, ...record.body.changes } } });
    const mounted = await loadedExpanded({ value: { get: undeclared, save: echo } });
    const baseline = mounted.calls.length;

    /** Map each checkbox to the label text next to it (`h("label.mtw_check", input, "Text")`). */
    const checkboxesByLabel = () => {
      const elements = mounted.render();
      const parents = parentMapOf(elements.tree);
      return checkboxes(elements).map((input) => ({ input, label: collectStrings(parents.get(input)?.props?.children ?? []).join(" ").trim() }));
    };
    const box = (label) => {
      const found = checkboxesByLabel().find((candidate) => candidate.label === label);
      assert.ok(found, "no checkbox labelled " + JSON.stringify(label) + "; rendered:\n  " + inventory(mounted.render()));
      return found.input;
    };
    const isChecked = (label) => box(label).props.checked === true;

    assert.equal(isChecked("Default"), true, "a model that declares no input must start on Default");
    for (const label of ["Text", "Image"]) {
      assert.equal(isChecked(label), false, label + " must start unchecked in the Default posture");
      assert.equal(box(label).props.disabled, undefined, label + " must not be disabled while Default is checked (v1.18)");
    }

    setChecked(box("Text"), true);
    assert.equal(isChecked("Default"), false, "checking Text must clear Default by itself (v1.18)");
    assert.equal(isChecked("Text"), true, "Text must stay checked");

    setChecked(box("Image"), true);
    assert.equal(isChecked("Default"), false, "Default stays clear while a modality is picked");
    assert.equal(isChecked("Text"), true, "Text keeps its state");
    assert.equal(isChecked("Image"), true, "Image is now picked as well");

    setChecked(box("Text"), false);
    assert.equal(isChecked("Image"), true, "unchecking Text must not touch Image");
    assert.equal(isChecked("Default"), false, "with Image still picked, Default must stay clear");

    setChecked(box("Image"), false);
    assert.equal(isChecked("Default"), true, "clearing the last modality must switch Default back on (v1.18)");
    assert.equal(isChecked("Text"), false, "no modality stays checked in the Default posture");
    assert.equal(isChecked("Image"), false, "no modality stays checked in the Default posture");

    assert.equal(mounted.calls.length, baseline, "the whole modality interaction must be draft-only (zero fetch)");

    // …and picking a modality after all that still submits an array, not the Default signal.
    setChecked(box("Text"), true);
    await applyClick(applyButton(mounted.render()));
    await flush(5);
    const saves = savesOf(mounted.calls);
    assert.equal(saves.length, 1, "Apply must issue exactly one save");
    assert.deepEqual(saves[0].body.changes.input, ["text"], "a picked modality must be submitted as an array");
  });

  it("submits null when the modalities are cleared back to Default (v1.18)", async () => {
    // This model DOES declare text+image, so clearing them is a real change → Apply becomes available.
    const { elements, render, calls } = await loadedExpanded({ value: { get: GET_VALUE(), save: SAVED() } });
    const parents = parentMapOf(elements.tree);
    const boxFor = (label) => {
      const found = checkboxes(elements).find((input) => collectStrings(parents.get(input)?.props?.children ?? []).join(" ").trim() === label);
      assert.ok(found, "no checkbox labelled " + label + "; rendered:\n  " + inventory(elements));
      return found;
    };
    // The render tree is immutable per render, so re-derive the boxes after every change.
    const currentBox = (label) => {
      const elementsNow = render();
      const parentsNow = parentMapOf(elementsNow.tree);
      const found = checkboxes(elementsNow).find((input) => collectStrings(parentsNow.get(input)?.props?.children ?? []).join(" ").trim() === label);
      assert.ok(found, "no checkbox labelled " + label + "; rendered:\n  " + inventory(elementsNow));
      return found;
    };
    assert.equal(boxFor("Default").props.checked, false, "a declared input starts off Default");
    setChecked(currentBox("Text"), false);
    setChecked(currentBox("Image"), false);
    assert.equal(currentBox("Default").props.checked, true, "clearing every modality returns to Default (v1.18)");

    await applyClick(applyButton(render()));
    await flush(5);
    const save = savesOf(calls)[0];
    assert.ok(save, "Apply must issue a save");
    assert.equal(save.body.changes.input, null, "the Default posture must be submitted as null (host deletes the field)");
  });

  it("shows the host message when the save is rejected", async () => {
    const { elements, render } = await loadedExpanded({ value: { get: GET_VALUE(), save: SAVED() } });
    const contextWindow = countSelect(elements);
    applyChange(contextWindow, optionValue(contextWindow).find(isCount));

    // The rejected write is the second request, so swap the double before clicking Apply.
    installFetch({}, { ok: false, status: 409, error: { code: "settings-conflict", message: "宿主冲突原文" } });
    await applyClick(applyButton(render()));
    await flush(5);
    const failed = render();
    assert.ok(textIncludes(failed, /宿主冲突原文/), "the host message must surface in the page; rendered:\n  " + inventory(failed));
  });

  it("renders an error line instead of crashing when the host is unavailable", async () => {
    const mounted = mountClient({ value: {}, fetchOptions: { fail: true } });
    const instance = createInstance();
    const render = () => collect(renderComponent(instance, mounted.component(SLOT_NAME), {}));
    const first = render();
    assert.ok(first.length > 0, "the page must still render something");
    await flush(5);
    const elements = render();
    assert.ok(elements.length > 0, "a dead host must not blank the page");
    assert.ok(
      textIncludes(elements, /error|fail|unavailable|失败|不可用|无法/i) || elements.some((element) => hasClass(element, "error") || hasClass(element, "Error")),
      "a dead host must render an error line; rendered:\n  " + inventory(elements),
    );
    restoreFetch();
  });

  it("re-injects its stylesheet on every load instead of leaving a stale <style>", () => {
    loadClient();                        // first load installs a DOM double and one <style>
    const dom = getClientLoad().dom;
    assert.equal(dom.styles.length, 1, "the first load must inject exactly one <style>");
    loadClient({ dom });                 // second load into the SAME document
    assert.equal(dom.styles.length, 1, "the stale <style> tag must be removed before the fresh one is inserted");
    assert.ok(dom.styles[0].textContent.length > 0, "the injected stylesheet must not be empty");
  });
});
