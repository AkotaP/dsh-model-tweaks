/**
 * Offline test harness for dsh-model-tweaks.
 *
 * The plugin ships as hand-written artifacts — a Node ESM host half (`lib/index.js`) and a
 * browser bundle (`lib/client.js`) that expects `window.__ModuleLoader__`, React and the DSH
 * client primitives. This harness stands in for all of that: a stub module graph, a minimal
 * React runtime (hooks + JSX elements), a tiny DOM double for the plugin's `<style>` injection,
 * and a tiny renderer, so both halves can be exercised in plain `node --test` with no DSH and
 * no browser.
 *
 * Adapted from `dsh-archived-sessions/test/support/harness.mjs`; the plugin-specific bits are
 * the module id (`dsh-model-tweaks`), the API prefix (`/model-tweaks/api`), a settings double
 * for the host half, and the recording DOM double.
 *
 * Quick reference (see the sections below for the details):
 *   loadHost()            → the host half's ESM namespace (name/inject/apply)
 *   loadClient()          → the client half's exports (apply/inject)
 *   getClientLoad()       → metadata of the last client load: { moduleId, required, dom, exports }
 *   makeHostContext(svc)  → { ctx, routes, logs } host-side cordis double (webServer.register recorded)
 *   makeCtx               → alias of makeHostContext
 *   makeClientContext(o)  → { ctx, slots, injections } client-side cordis double (slots.register recorded)
 *   mountClient(o)        → loadClient + makeClientContext + apply, with a fetch double installed
 *   makeSettingsDouble(o) → { service, mutations, state } double of `ctx.settings`
 *   makeLlmDouble(o)      → { service, calls } double of `ctx.llm` (v1.7 provider/model catalog)
 *   callApi(routes, m, b, o) → { status, body, text } call the recorded prefix route
 *   installFetch(v, o)    → records `/model-tweaks/api/*` fetches; returns the call log
 *   renderSlot(c, props)  → elements of one rendered component instance
 *   createInstance()      → one component instance (hook slots), for re-renders
 *   renderComponent(i, C, props), collect(), collectStrings(), textOf(), findElement(),
 *   findByType(), findAllByType(), findByProp(), hasClass(), isElement()
 *   installDocument()     → minimal document double recording injected <style> tags
 *   flush(ms)             → await microtasks/timers before re-rendering
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

/** Package name, also the loader entry id and the client module id (contract §1). */
export const PLUGIN_NAME = "dsh-model-tweaks";
/** The id `lib/client.js` must pass to `window.__ModuleLoader__.load`. */
export const CLIENT_MODULE_ID = "dsh-model-tweaks";
/** Host HTTP API prefix (contract §4). */
export const API_PREFIX = "/model-tweaks/api";
/** Settings slot the plugin fills, and the registration id (contract §1/§6.2). */
export const SLOT_NAME = "settings.section";
export const SECTION_ID = "model-tweaks";

/** Repository root (two levels above `test/support/`). */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** Absolute path of a repository file. */
export const repoPath = (...parts) => join(ROOT, ...parts);

/** Read a repository file as UTF-8. */
export const readRepo = (...parts) => readFileSync(repoPath(...parts), "utf8");

/** Whether a repository file exists (used to skip tests for not-yet-written halves). */
export const repoExists = (...parts) => existsSync(repoPath(...parts));

/** Resolve after `ms` (default: one macrotask). Components fetch inside effects, so tests
 * usually need `await flush()` before re-rendering to observe the updated state. */
export const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

//#region timer policy
/**
 * Long-lived tickers (relative-time refreshers and the like) must not keep the test process
 * alive. Intervals become no-ops; `setTimeout` stays real because tests assert the transient
 * save notice (the 2.5s auto-hide) and use `flush()` for effect settling.
 */
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};
//#endregion

//#region jsx runtime stub
const FRAGMENT = Symbol.for("react.fragment");
const jsx = (type, config, key) => ({ __el: true, type, key: key ?? config?.key, props: config ?? {} });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: FRAGMENT };
/** Whether a value is an element produced by the stub jsx runtime. */
export const isElement = (value) => value !== null && typeof value === "object" && value.__el === true;
//#endregion

//#region mini react
const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** One component instance: hook slots plus pending effects. Reuse it across renders to see
 * state written by a handler or an effect. */
export function createInstance() {
  return { slot: 0, state: {}, effects: {}, refs: {}, memos: {}, pending: [] };
}

let currentInstance = null;
const baseReact = {
  useState(init) {
    const instance = currentInstance;
    const index = instance.slot++;
    if (!(index in instance.state)) instance.state[index] = typeof init === "function" ? init() : init;
    return [instance.state[index], (next) => { instance.state[index] = typeof next === "function" ? next(instance.state[index]) : next; }];
  },
  useReducer(reducer, init, lazy) {
    const instance = currentInstance;
    const index = instance.slot++;
    if (!(index in instance.state)) instance.state[index] = lazy ? lazy(init) : init;
    return [instance.state[index], (action) => { instance.state[index] = reducer(instance.state[index], action); }];
  },
  useRef(init) {
    const instance = currentInstance;
    const index = instance.slot++;
    if (!(index in instance.refs)) instance.refs[index] = { current: init };
    return instance.refs[index];
  },
  useEffect(fn, deps) {
    const instance = currentInstance;
    const index = instance.slot++;
    if (!instance.effects[index] || !sameDeps(instance.effects[index], deps)) {
      instance.effects[index] = deps;
      instance.pending.push(fn);
    }
  },
  useLayoutEffect(fn, deps) { baseReact.useEffect(fn, deps); },
  useInsertionEffect(fn, deps) { baseReact.useEffect(fn, deps); },
  useMemo(fn, deps) {
    const instance = currentInstance;
    const index = instance.slot++;
    const previous = instance.memos[index];
    if (!previous || !sameDeps(previous.deps, deps)) instance.memos[index] = { deps, value: fn() };
    return instance.memos[index].value;
  },
  useCallback(fn, deps) { return baseReact.useMemo(() => fn, deps); },
  useSyncExternalStore(_subscribe, getSnapshot) { currentInstance.slot++; return getSnapshot(); },
  useContext() { currentInstance.slot++; return undefined; },
  useId() { currentInstance.slot++; return "id"; },
  useImperativeHandle() { currentInstance.slot++; },
  useDebugValue() { currentInstance.slot++; },
  useDeferredValue(value) { currentInstance.slot++; return value; },
  useTransition() { currentInstance.slot++; return [false, (fn) => { fn(); }]; },
  memo: (component) => component,
  forwardRef: (component) => component,
  createContext: () => ({ Provider: (props) => props.children, Consumer: () => null }),
  createRef: () => ({ current: null }),
  cloneElement: (element, props) => jsx(element.type, { ...element.props, ...props }),
  isValidElement: (value) => isElement(value),
  createElement: (type, props, ...children) => {
    const kids = children.length === 0 ? props?.children : children.length === 1 ? children[0] : children;
    return jsx(type, { ...props, children: kids });
  },
  Children: { map: (children, fn) => [].concat(children ?? []).map(fn), toArray: (children) => [].concat(children ?? []), count: (children) => [].concat(children ?? []).length },
  startTransition: (fn) => fn(),
  Fragment: FRAGMENT,
};
const react = new Proxy(baseReact, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === "string" && key.startsWith("use")) return () => undefined;
    return undefined;
  },
});

/** Stub `@deepseek-ai/dsh-client-ui-primitives`: every export is a real component that forwards
 * its props (and a `__stub` marker) into a plain `div`. */
export function createPrimitives() {
  const cache = new Map();
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name === "symbol") return undefined;
      const key = String(name);
      if (!cache.has(key)) cache.set(key, (props) => jsx("div", { ...props, __stub: key }));
      return cache.get(key);
    },
    has: () => true,
  });
}
//#endregion

//#region rendering
/** Render one component instance, running the effects scheduled during that pass. */
export function renderComponent(instance, Component, props) {
  const previous = currentInstance;
  currentInstance = instance;
  instance.slot = 0;
  let tree;
  try { tree = Component(props); } finally { currentInstance = previous; }
  const pending = instance.pending;
  instance.pending = [];
  for (const fn of pending) {
    try { fn(); } catch { /* an effect that throws must not abort the assertion run */ }
  }
  return tree;
}

/** Flatten an element tree into every element it renders (nested components included). */
export function collect(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, out); return out; }
  if (typeof node !== "object" || !node.__el) return out;
  out.push(node);
  if (typeof node.type === "function") collect(renderComponent(createInstance(), node.type, node.props), out);
  else collect(node.props?.children, out);
  return out;
}

/** Every string reachable in an element tree. */
export function collectStrings(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (node === null || node === undefined || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const child of node) collectStrings(child, out); return out; }
  if (node.__el) collectStrings(node.props?.children, out);
  return out;
}

/** Every string reachable from a set of elements (their props' children). */
export const textOf = (elements) => collectStrings({ __el: true, props: { children: elements.map((el) => el.props.children) } });

/** Render a slot component in a fresh instance and return its flattened element list. */
export const renderSlot = (component, props) => collect(renderComponent(createInstance(), component, props));

/** First element matching a predicate. */
export const findElement = (elements, predicate) => elements.find(predicate);

/** First element whose `type` is exactly `type` (a tag string or a component function). */
export const findByType = (elements, type) => elements.find((el) => el.type === type);

/** Every element whose `type` is exactly `type`. */
export const findAllByType = (elements, type) => elements.filter((el) => el.type === type);

/** First element whose props carry `props[key] === value`. */
export const findByProp = (elements, key, value) => elements.find((el) => el.props?.[key] === value);

/** Class-name helpers for the plugin's generated classes. */
export const hasClass = (element, suffix) => typeof element.props.className === "string" && element.props.className.split(/\s+/).some((name) => name.endsWith(suffix));
//#endregion

//#region document double
const CSS_SELECTOR = /^style\[data-plugin-css=(.*)\]$/;

/**
 * Minimal `document` double for the plugin's `<style data-plugin-css="…">` injection
 * (contract §1.3: remove the stale tag, then insert the fresh one on every load).
 * Returns `{ document, styles }`; `styles` is the live list of appended tags, and a node's
 * `remove()` (or `document.head.removeChild`) takes it back out.
 */
export function installDocument({ location } = {}) {
  const styles = [];
  const drop = (node) => { const index = styles.indexOf(node); if (index >= 0) styles.splice(index, 1); return node; };
  const document = {
    head: { appendChild(node) { styles.push(node); return node; }, removeChild: drop },
    body: { appendChild: (node) => node },
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        attributes: {},
        textContent: "",
        setAttribute(key, value) { this.attributes[key] = value; },
        remove() { drop(this); },
      };
    },
    querySelectorAll(selector) {
      const match = CSS_SELECTOR.exec(String(selector).trim());
      if (match === null) return [];
      let wanted;
      try { wanted = JSON.parse(match[1]); } catch { wanted = match[1].trim().replace(/^["']|["']$/g, ""); }
      return styles.filter((node) => (node.dataset?.pluginCss ?? node.attributes?.["data-plugin-css"]) === wanted);
    },
    querySelector(selector) { return document.querySelectorAll(selector)[0] ?? null; },
    addEventListener() {},
    removeEventListener() {},
  };
  if (location !== undefined) document.location = location;
  globalThis.document = document;
  return { document, styles };
}
//#endregion

//#region plugin loading
const BROWSER_LOCATION = Object.freeze({
  href: "http://127.0.0.1:19387/",
  origin: "http://127.0.0.1:19387",
  host: "127.0.0.1:19387",
  hostname: "127.0.0.1",
  protocol: "http:",
  pathname: "/",
  search: "",
  hash: "",
});

let lastClientLoad = null;
/** Metadata of the most recent client load: `{ moduleId, required, dom, exports }`.
 * `required` is every module id the bundle asked `require()` for — assert it against
 * `package.json`'s `dsh.client.inject`. */
export const getClientLoad = () => lastClientLoad;

/**
 * Instantiate a client bundle from source text. The source must call
 * `window.__ModuleLoader__.load({ id, factory })`; a missing call or a mismatched id throws,
 * so a drifted module id fails loudly instead of silently passing.
 *
 * To assert the plugin's "remove the stale `<style>` tag, then insert the fresh one" contract,
 * pass the **same** `dom` to several loads — a fresh DOM per load would make that assertion
 * vacuous. `const dom = installDocument(); loadClient({ dom }); loadClient({ dom });`.
 *
 * @param source   bundle source (defaults to `lib/client.js` when omitted by `loadClient`).
 * @param filename filename to report in VM stack traces.
 * @param options.expectId required module id (defaults to the contract's `dsh-model-tweaks`).
 * @param options.dom      reuse an existing `installDocument()` double instead of installing a fresh one.
 */
export function instantiateClient(source, filename = "lib/client.js", { expectId = CLIENT_MODULE_ID, dom } = {}) {
  const activeDom = dom ?? installDocument({ location: BROWSER_LOCATION });
  let captured;
  globalThis.window = {
    __ModuleLoader__: { load: (options) => { captured = options; } },
    location: BROWSER_LOCATION,
    document: activeDom.document,
  };
  vm.runInThisContext(source, { filename });
  if (captured === undefined) throw new Error(filename + " did not call window.__ModuleLoader__.load");
  if (expectId !== null && captured.id !== expectId) {
    throw new Error(filename + " registered module id " + JSON.stringify(captured.id) + " but the contract requires " + JSON.stringify(expectId));
  }
  const required = [];
  const primitives = createPrimitives();
  const requireStub = (id) => {
    required.push(id);
    return id === "react/jsx-runtime" ? jsxRuntime
      : id === "react" ? react
        : id === "@deepseek-ai/dsh-client-ui-primitives" ? primitives
          : new Proxy({}, { get: () => undefined });
  };
  const exports = captured.factory(requireStub);
  lastClientLoad = { moduleId: captured.id, required, dom: activeDom, exports };
  return exports;
}

/** Load a fresh instance of the client half (module state is per call).
 * Pass `{ dom }` to reuse a DOM double across loads (needed to assert the stale-`<style>` removal). */
export function loadClient(options = {}) {
  return instantiateClient(readRepo("lib", "client.js"), "lib/client.js", options);
}

/** Load a fresh instance of the host half. */
export function loadHost(cacheBust = String(Date.now())) {
  return import("file:///" + repoPath("lib", "index.js").replace(/\\/g, "/") + "?t=" + cacheBust);
}
//#endregion

//#region contexts
/** A recording logger double. */
function createLogger(logs) {
  const push = (level) => (message) => { logs.push([level, String(message)]); };
  return { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error"), log: push("info") };
}

/**
 * A host-side cordis context double. `ctx.get("webServer")` returns a recorder that captures
 * every `register({ kind, path, handler })` call into `routes`; every other name resolves from
 * `services` (both through `ctx.get(name)` and as a direct property, mirroring cordis `inject`).
 * A `settings` service is normally `makeSettingsDouble().service`; `logger`/`log` are always
 * available and recorded into `logs`.
 *
 * @returns `{ ctx, routes, logs, disposals }`
 */
export function makeHostContext(services = {}) {
  const routes = [];
  const logs = [];
  const disposals = [];
  const logger = createLogger(logs);
  const providedWebServer = services.webServer;
  const webServer = {
    register(options) {
      routes.push(options);
      const dispose = providedWebServer?.register?.(options);
      return () => { if (typeof dispose === "function") dispose(); };
    },
  };
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") disposals.push(dispose);
      return () => { if (typeof dispose === "function") dispose(); };
    },
    get(name) {
      if (name === "webServer") return webServer;
      if (name === "logger" || name === "log") return logger;
      return services[name];
    },
    on: () => () => {},
    logger,
    log: logger,
  };
  for (const key of Object.keys(services)) if (!(key in ctx)) ctx[key] = services[key];
  ctx.webServer = webServer;
  return { ctx, routes, logs, disposals };
}

/** Alias of `makeHostContext` for the shorter task-facing name. */
export const makeCtx = makeHostContext;

/**
 * A double of the host `llm` service (contract v1.7): the model catalog the client groups by
 * provider. Pass it to `makeHostContext({ llm: llmDouble.service })`, where it is reachable as both
 * `ctx.llm` and `ctx.get("llm")`.
 *
 * @param options.providers `listConfigurableProviders()` result — `[{ provider, displayName }]`.
 * @param options.models    `listModels(provider)` result — `{ <provider>: [{ provider, id, name }] }`.
 * @param options.info      `resolveModelInfo(provider, model, signal)` result: a function
 *                          `(provider, model) => info | Promise<info>`, or a map keyed by
 *                          `provider:model` / `model` / `info[provider][model]`.
 * @param options.failing   providers whose `listModels` rejects — for "one group failing must not
 *                          fail the whole catalog" assertions.
 *
 * @returns `{ service, calls }` — `calls` records every call as
 *          `{ method, provider?, model?, signal? }`; the list methods return detached copies, so a
 *          caller mutating them cannot affect the double.
 */
export function makeLlmDouble({ providers = [{ provider: "ollama", displayName: "ollama" }], models = {}, info = {}, failing = [] } = {}) {
  const calls = [];
  const failingProviders = new Set(failing);
  const copies = (value) => (Array.isArray(value) ? value.map((item) => (isPlainObject(item) ? { ...item } : item)) : []);
  const pickInfo = (provider, model) => {
    if (typeof info === "function") return info(provider, model);
    if (!isPlainObject(info)) return undefined;
    if (isPlainObject(info[provider]) && model in info[provider]) return info[provider][model];
    if ((provider + ":" + model) in info) return info[provider + ":" + model];
    if (model in info) return info[model];
    return undefined;
  };
  const service = {
    listConfigurableProviders() {
      calls.push({ method: "listConfigurableProviders" });
      return copies(providers).map((entry) => ({ ...entry }));
    },
    async listModels(provider) {
      calls.push({ method: "listModels", provider });
      if (failingProviders.has(provider)) throw new Error('llm service failed to list models for provider "' + provider + '"');
      return copies(models[provider]);
    },
    async resolveModelInfo(provider, model, signal) {
      calls.push({ method: "resolveModelInfo", provider, model, signal });
      return await pickInfo(provider, model);
    },
  };
  return { service, calls };
}

/**
 * The locale service double: `register(ns, dict)` is recorded; `bind(ns)` (and `t`) resolve a key
 * through the registered dictionary and fall back to the key itself, so a missing dictionary never
 * crashes the page. Dictionaries may be flat (`{ nav: "Model Capabilities" }`) or nested by locale
 * (`{ en: {…}, zh: {…} }`), and `{name}` placeholders are interpolated from the second argument.
 */
export function makeLocaleDouble(dictionaries = {}, locale = "en") {
  const registered = new Map();
  const lookup = (namespace, key, language) => {
    const dictionary = registered.get(namespace) ?? dictionaries[namespace];
    if (!isPlainObject(dictionary)) return undefined;
    const scoped = isPlainObject(dictionary[language]) ? dictionary[language] : dictionary;
    const value = scoped[key];
    return typeof value === "string" ? value : undefined;
  };
  const translate = (namespace) => (key, vars) => {
    const value = lookup(namespace, key, locale) ?? lookup(namespace, key, "en") ?? lookup(namespace, key, "zh");
    if (value === undefined) return key;
    return vars === undefined ? value : value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  };
  const service = {
    register: (namespace, dictionary) => { registered.set(namespace, dictionary); },
    bind: (namespace) => translate(namespace),
    t: translate,
    get locale() { return locale; },
    getLocale: () => locale,
    use: () => locale,
    locales: ["en", "zh"],
  };
  return { registered, service, lookup, translate };
}

/**
 * A client-side cordis context double.
 *
 * @param options.locale    locale service double (defaults to `makeLocaleDouble().service`).
 * @param options.services  extra services, reachable through `ctx.get(name)` and `ctx[name]`.
 * @param options.guarded   service names whose property read throws — emulates the browser
 *                          facade when the plugin forgot to declare them in `inject` (contract §1.4).
 * @param options.slotResult value returned by `ctx.slots.register`, when a test needs the dispose.
 *
 * @returns `{ ctx, slots, injections, locale }` — `slots` maps a slot name to `{ options, component }`.
 */
export function makeClientContext({ locale, services = {}, guarded = [], slotResult } = {}) {
  const slots = new Map();
  const registered = [];
  const injections = [];
  const localeDouble = locale === undefined ? makeLocaleDouble() : null;
  const localeService = locale ?? localeDouble.service;
  const ctx = {
    locale: localeService,
    effect(fn) { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    get: (name) => (guarded.includes(name) ? uninjected(name) : (name in ctx ? ctx[name] : services[name])),
    slots: {
      inject(name, callback) {
        injections.push(name);
        if (typeof callback === "function") callback();
        return () => {};
      },
      register(options, component) {
        registered.push({ options, component });
        slots.set(options.name, { options, component });
        return slotResult ?? (() => {});
      },
    },
  };
  for (const name of guarded) {
    Object.defineProperty(ctx, name, {
      get() { return uninjected(name); },
      configurable: true,
    });
  }
  for (const key of Object.keys(services)) if (!(key in ctx)) ctx[key] = services[key];
  return { ctx, slots, injections, locale: localeService, registered, localeDouble };
}

function uninjected(name) {
  if (name === "locale") return undefined;
  throw new Error('cannot get property "' + name + '" without inject');
}

/**
 * One-call client mount: install a fetch double, load `lib/client.js`, apply it to a fresh
 * client context, and hand back the registered slot components.
 *
 * @param options.value         per-method value map (or a resolver) for the fetch double.
 * @param options.fetchOptions  options forwarded to `installFetch` (`fail`, `ok`, `status`, …).
 * @param options.context       options forwarded to `makeClientContext`.
 * @param options.dom           reuse an existing `installDocument()` double (defaults to a fresh one).
 *
 * @returns `{ plugin, ctx, slots, injections, required, component, calls, dom }`
 */
export function mountClient({ value = {}, fetchOptions = {}, context = {}, dom } = {}) {
  const calls = installFetch(value, fetchOptions);
  const plugin = loadClient(dom === undefined ? {} : { dom });
  const { ctx, slots, injections, registered } = makeClientContext(context);
  plugin.apply(ctx);
  const component = (name) => slots.get(name)?.component;
  return { plugin, ctx, slots, injections, registered, required: getClientLoad()?.required ?? [], component, calls, dom: getClientLoad()?.dom };
}
//#endregion

//#region fetch + host API doubles
const originalFetch = globalThis.fetch;
/** Restore the real `fetch` after an `installFetch` test. */
export function restoreFetch() { globalThis.fetch = originalFetch; }

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map([["content-type", "application/json"]]),
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

/**
 * Install a fetch double for the plugin's `/model-tweaks/api/*` calls and return the call log.
 *
 * `value` is either a map from API method (`get`/`save`/`presets`) to the `value` wrapped into
 * the success envelope `{ ok: true, value }`, or a function `(record) => value`.
 *
 * @param value                   per-method value map — each entry is either the `value` wrapped
 *                                into `{ ok: true, value }`, or a `(record) => value` resolver
 *                                called per request (also accepts a single whole-function resolver).
 * @param options.fail            reject with this error message (true → "network down").
 * @param options.ok              false → answer `{ ok: false, error }` with `options.status`.
 * @param options.status          HTTP status for the failure branches.
 * @param options.error           error object for the `ok: false` branch.
 * @param options.envelope        true → answer the resolved value verbatim instead of wrapping it
 *                                into `{ ok: true, value }` (for the `save` → `{ ok, model }` shape).
 *
 * Each log entry is `{ method, url, init, body, headers }` with `method` being the last URL
 * segment and `body` the parsed JSON (or the raw string when it is not JSON).
 */
export function installFetch(value = {}, options = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const text = typeof init.body === "string" ? init.body : undefined;
    const method = String(url).slice(String(url).lastIndexOf("/") + 1);
    let body;
    try { body = text === undefined ? undefined : JSON.parse(text); } catch { body = text; }
    const record = { method, url: String(url), init, body, headers: init.headers ?? {} };
    calls.push(record);
    if (options.fail !== undefined && options.fail !== false) throw new Error(options.fail === true ? "network down" : String(options.fail));
    if (options.ok === false || (typeof options.status === "number" && options.status >= 400)) {
      return jsonResponse(options.payload ?? { ok: false, error: options.error ?? { code: "http-error", message: "HTTP " + (options.status ?? 500) } }, options.status ?? 500);
    }
    // `value` may be a per-method map whose entry is either a value or a `(record) => value`
    // resolver; a whole-function `value` is accepted too. Per-method resolvers are the natural
    // form for "the first call succeeds, the second fails" style tests.
    const entry = typeof value === "function" ? value : (method in value ? value[method] : undefined);
    const resolved = typeof entry === "function" ? await entry(record) : await entry;
    return jsonResponse(options.envelope === true ? (resolved ?? {}) : { ok: true, value: resolved ?? {} });
  };
  return calls;
}

/** Find the recorded route for an API prefix (defaults to `/model-tweaks/api`). */
export function findApiRoute(routes, prefix = API_PREFIX) {
  return routes.find((entry) => entry.kind === "prefix" && entry.path === prefix) ?? routes.find((entry) => entry.kind === "prefix");
}

const makeRequest = ({ method, url, headers, payload }) => {
  const request = {
    method,
    url,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
    httpVersion: "1.1",
    async *[Symbol.asyncIterator]() { yield payload === undefined ? Buffer.alloc(0) : payload; },
    on(event, handler) {
      if (event === "data") queueMicrotask(() => handler(payload === undefined ? Buffer.alloc(0) : payload));
      else if (event === "end") queueMicrotask(() => handler());
      return request;
    },
    once(event, handler) { return request.on(event, handler); },
    destroy() {},
  };
  return request;
};

const makeResponse = (state) => ({
  statusCode: 200,
  headers: {},
  setHeader(key, value) { state.headers[key.toLowerCase()] = value; return this; },
  getHeader(key) { return state.headers[key.toLowerCase()]; },
  removeHeader(key) { delete state.headers[key.toLowerCase()]; },
  writeHead(code, headers) {
    state.status = code;
    if (headers && typeof headers === "object") for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  },
  write(chunk) { state.text += chunk === undefined ? "" : String(chunk); return true; },
  end(chunk) { if (chunk !== undefined && chunk !== null) state.text += String(chunk); state.ended = true; },
});

/**
 * Call the recorded `/model-tweaks/api` route with a JSON body (contract §4).
 *
 * @param routes  the `routes` array from `makeHostContext`.
 * @param apiMethod e.g. `get` / `save` / `presets`; appended to the API prefix.
 * @param body    JSON-serialised body (a string is sent verbatim).
 * @param options.headers extra request headers (merged over the loopback defaults).
 * @param options.method  HTTP method (default POST) — use GET to exercise the 405 branch.
 * @param options.raw     raw body text, overriding `body` (for 413 / 415 cases).
 * @param options.prefix  API prefix (default `/model-tweaks/api`).
 * @param options.path    explicit request path, overriding prefix+method.
 *
 * @returns `{ status, body, text, headers }` with `body` parsed when the response is JSON.
 */
export async function callApi(routes, apiMethod, body, options = {}) {
  const route = findApiRoute(routes, options.prefix ?? API_PREFIX);
  if (route === undefined || typeof route.handler !== "function") throw new Error("the plugin registered no " + (options.prefix ?? API_PREFIX) + " route");
  const raw = options.raw !== undefined ? options.raw : (typeof body === "string" ? body : JSON.stringify(body ?? {}));
  const headers = {
    host: "127.0.0.1:19387",
    origin: "http://127.0.0.1:19387",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    ...options.headers,
  };
  const request = makeRequest({ method: options.method ?? "POST", url: options.path ?? (options.prefix ?? API_PREFIX) + "/" + apiMethod, headers, payload: Buffer.from(raw) });
  const state = { status: 0, text: "", headers: {}, ended: false };
  const response = makeResponse(state);
  await route.handler(request, response);
  let parsed;
  try { parsed = state.text === "" ? undefined : JSON.parse(state.text); } catch { parsed = undefined; }
  return { status: state.status, body: parsed, text: state.text, headers: state.headers };
}
//#endregion

//#region settings double
/** The conflict error DSH raises when a `mutate` carries a stale revision (contract §3). */
export class SettingsConflictError extends Error {
  constructor(message = "settings conflict") { super(message); this.name = "SettingsConflictError"; }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value))));
/** Deep-merge `patch` over `base` for plain objects; arrays and scalars replace. */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch) ?? clone(base);
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

const pathParts = (path) => (Array.isArray(path) ? path.map(String) : String(path).split(".").filter((part) => part !== ""));

/**
 * Apply one `set`/`unset` op the way the **running** `dsh-settings` (0.1.7-rc.2) `applyPathOp`
 * does (contract v1.6): the tree is rebuilt along the path, array nodes are preserved and
 * indexed, an `unset` of an array element with an empty rest splices it out, a leaf `unset`
 * deletes the object property, and an out-of-range array index throws
 * `TypeError: Config array index "…" is out of range`.
 *
 * The one sharp edge that is still real: when the user layer has **no** array at that path yet,
 * walking into it degrades the intermediate node to a plain object (`models` becomes
 * `{"0": …}`), which the model schema (`z.array`) rejects. That is exactly why the plugin — like
 * the official Models page — writes the whole `models` array (`["providers", p, "models"]`) in a
 * single `set`, which is valid in every state.
 */
function editPath(value, parts, op) {
  const [head, ...rest] = parts;
  if (head === undefined) return op.op === "set" ? clone(op.value) : undefined;
  if (Array.isArray(value)) {
    // 0.1.7-rc.2 rejects an out-of-range index instead of silently extending the array.
    if (!/^(0|[1-9][0-9]*)$/.test(head) || Number(head) > value.length
      || (Number(head) === value.length && (rest.length > 0 || op.op === "unset"))) {
      throw new TypeError('Config array index "' + head + '" is out of range');
    }
    const result = [...value];
    const index = Number(head);
    if (rest.length === 0 && op.op === "unset") result.splice(index, 1);
    else result[index] = editPath(value[index], rest, op);
    return result;
  }
  const result = isPlainObject(value) ? { ...value } : {};
  const child = editPath(result[head], rest, op);
  if (child === undefined) Reflect.deleteProperty(result, head);
  else result[head] = child;
  return result;
}

/**
 * A double of `ctx.settings` (contract §3): `get` resolves base+user, `describe` reports the
 * user layer plus `revision`/`writable`, `mutate` applies `{op:"set"|"unset", path, value}` ops
 * (one revision bump per call) and rejects a stale `expectedRevision` with `SettingsConflictError`.
 *
 * It also reproduces the running `dsh-settings` (0.1.7-rc.2) path semantics (contract v1.6):
 * `set`/`unset` rebuild the tree along the path, arrays are preserved and indexed, and an `unset`
 * leaf deletes the property (an array element with an empty rest is spliced out). A `set` with a
 * `null` value writes `null`; it is *not* treated as a removal. When the user layer has no array
 * at that path yet, walking into it degrades the node to an object (`{"0": …}`) — which is why the
 * plugin writes whole arrays instead of per-index paths.
 *
 * @param options.ns        namespace (default `llm-pi-ai`).
 * @param options.base      composite/base layer.
 * @param options.user      user layer (what `mutate` writes into).
 * @param options.revision  starting revision.
 * @param options.writable  `describe()[0].writable`.
 * @param options.descriptorValue initial `describe()[0].value` / `get()` projection. Defaults to
 *                          `deepMerge(base, user)`; when given explicitly it is kept in sync by
 *                          `mutate`/`replace`/`setUser`/`setBase`.
 * @param options.omitGet   `true` drops `get()` entirely — the **running** `SettingsProvider`
 *                          (0.1.7-rc.2) has no `get(ns)`, `describe()[0].value` is the read surface.
 *                          Use it to lock in "read the right surface" regressions.
 *
 * @returns `{ service, mutations, ns, state, conflictError }` — `state` is live (`{base,user,revision,writable}`).
 */
export function makeSettingsDouble({ ns = "llm-pi-ai", base = {}, user = {}, revision = 1, writable = true, descriptorValue, omitGet = false } = {}) {
  let state = { base: clone(base) ?? {}, user: clone(user) ?? {}, revision, writable };
  const mutations = [];
  const hasProjection = descriptorValue !== undefined;
  let projected = hasProjection ? clone(descriptorValue) : undefined;
  /** What the provider reports: the explicit projection, else the composed base+user value. */
  const resolved = () => (hasProjection ? clone(projected) : deepMerge(state.base, state.user));
  const service = {
    // The real `SettingsProvider` exposes `writable` as an abstract field; the double mirrors it
    // (and `describe()[0].writable` carries the same state, so both read paths stay exercised).
    get writable() { return state.writable; },
    describe() { return [{ ns, base: clone(state.base), user: clone(state.user), revision: state.revision, writable: state.writable, value: resolved() }]; },
    async mutate(name, ops, expectedRevision) {
      if (name !== ns) throw new Error("unknown settings namespace " + JSON.stringify(name));
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== state.revision) {
        throw new SettingsConflictError("settings revision " + expectedRevision + " is stale (current " + state.revision + ")");
      }
      if (!state.writable) throw new Error("settings namespace " + ns + " is read-only");
      mutations.push({ ns: name, ops: clone(ops), expectedRevision });
      for (const op of ops ?? []) {
        // Faithful to the running `applyPathOp`: only `unset` removes, and `set` keeps whatever
        // value it was given — including `null` — so a Default that went through `set` instead of
        // being removed fails loudly here instead of being silently turned into a removal.
        state.user = editPath(state.user, pathParts(op.path), op) ?? {};
        if (hasProjection) projected = editPath(projected, pathParts(op.path), op) ?? {};
      }
      state.revision += 1;
      return { revision: state.revision };
    },
    async replace(name, section, expectedRevision) {
      if (name !== ns) throw new Error("unknown settings namespace " + JSON.stringify(name));
      if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== state.revision) {
        throw new SettingsConflictError("settings revision " + expectedRevision + " is stale (current " + state.revision + ")");
      }
      state.user = clone(section) ?? {};
      if (hasProjection) projected = clone(section) ?? {};
      state.revision += 1;
      return { revision: state.revision };
    },
  };
  if (!omitGet) service.get = (name) => (name === ns ? resolved() : undefined);
  return {
    service,
    mutations,
    ns,
    conflictError: SettingsConflictError,
    get state() { return state; },
    get descriptorValue() { return resolved(); },
    setUser(next) { state = { ...state, user: clone(next) ?? {} }; if (hasProjection) projected = deepMerge(state.base, state.user); },
    setBase(next) { state = { ...state, base: clone(next) ?? {} }; if (hasProjection) projected = deepMerge(state.base, state.user); },
    bump() { state = { ...state, revision: state.revision + 1 }; },
    setWritable(next) { state = { ...state, writable: next }; },
  };
}
//#endregion

export { FRAGMENT as Fragment, jsx };
