# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Nothing has been published yet. `0.2.0` is the current version and the first release line cut from this repository; `0.1.0` was an internal development line that never shipped, so its entries are kept below as history and its features are available from `0.2.0` onward.

## [0.2.0] — 2026-11-10

### Added

- **Per-model effort memory**: every `provider/model` remembers its own reasoning effort in the browser's `localStorage` (browser-local, never a config or preset-document field). A model switch restores that memory; a model with no memory yet walks the **default reasoning chain** (built-in `high → medium → low`, edited on the Presets tab) top-down for the first level it supports, with a rendered, unstored, non-removable `Default` fallback. A remembered `default` keeps the field undeclared. Two switches — **remember each model's effort** and **pick from the chain automatically**, both on by default and both ordinary preset-document fields (draft + Apply) at the top of the chain card: the memory off reads and records nothing (existing entries are kept); the chain off leaves DSH's own value alone for a model without a usable memory. The resolution is installed by wrapping `ctx.modelDirectories.directoryFor().select`; models without reasoning metadata are left alone, and a rejected selection is never remembered.
- The preset document now carries `reasoningChain`; a pre-existing file is back-filled with the built-in chain narrowed to the levels it declares, and an invalid chain is refused with a 400 naming the level.
- `test/reasoning-chain.test.mjs` covering the document rules, the memory round-trip, the resolution rule and the directory hook (including HMR replacement and failed-selection cases).
- `repository` metadata in `package.json` and this changelog.
- An explicit DSH compatibility declaration — `@deepseek-ai/dsh` `^0.1.7-rc.2` in `peerDependencies`, the field the runtime actually checks (a mismatch refuses the install) — and a manifest test that keeps it from being dropped.

### Performance

- The model-switch hook no longer rebuilds its `select` wrapper on every `directoryFor`/`inject` call (a per-bundle token makes it idempotent), so React is not handed a fresh function prop on each render; the decoded effort memory, the `reasoning.efforts` id lists and the raw storage comparison are cached, and the memory write moved off the selection path onto an idle callback. Behavior is unchanged.

### Changed

- The DSH runtime peer is open-ended (`>=0.1.7-rc.2`), so the plugin stays installable on the 0.2.x runtime; `0.1.0` was never shipped and its entries below are history.
- `dsh.client.inject` now declares `@deepseek-ai/dsh-client-ui-model-selection`, whose `ctx.modelDirectories` service carries the model-switch hook.
- `README.md` reduced to four sections (what it does, presets, install, test) and mirrored by `README.en.md`; both link the repository and this changelog.
- `docs/CONTRACT.md` and `docs/HANDOFF.md` rewritten as concise third-person references: interface and data semantics in the former, engineering conventions and test infrastructure in the latter.
- `README.md` and `README.en.md` link each other and state the supported DSH range in one line; the compatibility mechanism stays in the contract.
- Install instructions now cover the three supported routes — the Plugin page's **Add plugin** field, `dsh plugin --profile desktop add <spec>`, and a copy-paste prompt for agent-driven installs — using the GitHub repository address, since the package is not on npm yet; the manual link / junction steps are gone.

## [0.1.0] — not released

### Added

- **Model Capabilities** page in DSH Settings (`settings.section`, id `model-tweaks`, order `250`), with English and Chinese labels.
- Two-level collapsible provider and model cards; no card expanded and no model selected on load.
- Per-model editing of `contextWindow`, `maxTokens`, `input` and `reasoningEfforts` in the `llm-pi-ai` settings namespace, listing only providers that are configured and expose at least one model.
- **Presets** tab managing four plugin-owned lists (`contextWindows`, `maxOutputs`, `reasoningLevels`, `reasoningPresets`) persisted to `{DSH_HOME}/dsh-model-tweaks/presets.json`, falling back to built-in defaults when the file is missing or broken.
- Host HTTP API `POST /model-tweaks/api/{get,save,presets}` mounted on the official web server, restricted to loopback + same-origin requests and answering in a uniform `{ ok, value }` / `{ ok, error }` envelope.
- Offline test suite (`node --test`) built on a stub module graph, a minimal React renderer and DOM / settings / LLM / fetch doubles.

### Fixed

- Model lists came back empty because the effective configuration was read through `settings.get(ns)`, which the running `SettingsProvider` does not implement; reads now go through `describe()[].value` and the model catalogue through `ctx.llm`.
- Saves changed nothing, or turned the `models` array into an object, because they wrote per-field paths into an array that only existed in the base layer; a model is now written as one whole-array `set`.
- The Apply button looked disabled: it referenced theme variables missing from the runtime token list without a fallback, so its background resolved to nothing.
- Text / Image checkboxes were unclickable while `Default` was ticked; the modalities now toggle `Default` automatically in both directions.
- The Presets tab went blank when the host reply carried no `presets`; that reply is now treated as a failed save and the draft is rolled back.

### Notes

- **Default means "do not declare".** Choosing Default removes the field instead of writing `null`, `0` or an empty object, leaving the DSH engine's own default in charge.
- **Draft + Apply.** No control writes on change; every model editor and every preset card has its own `Apply`, and one `Apply` submits the whole document it belongs to.
- **Decimal-only size labels.** `1000000 → 1M`, `128000 → 128K`; binary values keep their exact digits (`1048576`, `131072`), so `1M` can never be read as `1048576`.
- **Reasoning presets start with `off`** (`DeepSeek`, `OpenAI Standard`, `Simple`): `off` is the only level pi-ai maps to `null`, and every preset keeps at least one non-`off` level.
- **A single failing provider no longer blanks the page** — it is reported on a diagnostic line below the list.
