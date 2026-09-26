# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

No version has been released yet, so the entries below carry no release dates, and the development iterations that preceded the first release are folded into 0.1.0.

## [Unreleased]

### Added

- `repository` metadata in `package.json` and this changelog.
- An explicit DSH compatibility declaration — `@deepseek-ai/dsh` `^0.1.7-rc.2` in `peerDependencies`, the field the runtime actually checks (a mismatch refuses the install) — and a manifest test that keeps it from being dropped.

### Changed

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
