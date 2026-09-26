# dsh-model-tweaks 接口与数据契约

> 适用范围：该 DSH 设置页插件与 DSH 运行版（`@deepseek-ai/dsh-*` 0.1.7-rc.2）之间的接口与语义约定。下文所有标识、枚举、数值与状态码均为当前实现的事实，不含版本演进过程。

## 1. 标识与文件

| 项 | 值 |
|---|---|
| 包名 / loader entry id / client 模块 id | `dsh-model-tweaks` |
| host 入口 | `lib/index.js`（Node ESM，手写，零外部依赖）：settings 读写 + `/model-tweaks/api/*` |
| client 入口 | `lib/client.js`（浏览器 bundle，手写，非构建产物）：设置页 UI |
| 设置页 slot | `settings.section`，注册 id `model-tweaks`，order `250` |
| HTTP API 前缀 | `/model-tweaks/api` |
| 预设文件 | `{DSH_HOME}/dsh-model-tweaks/presets.json` |

三处 id 必须一致：`cordis.patch.yml` 的 insert `id`、`lib/client.js` 的 `__ModuleLoader__.load({ id })`、`lib/index.js` 导出的 `name`。

## 2. 数据来源与字段语义

模型能力的生效值由 settings namespace `llm-pi-ai` 承载：

```jsonc
llm-pi-ai.providers.<providerId>.models[i] = {
  "id": "...", "name": "...",
  "contextWindow": 128000,        // 上下文窗口
  "maxTokens": 64000,             // 最大输出
  "input": ["text", "image"],     // 输入模态
  "reasoningEfforts": { "off": null, "low": "low" }   // 思考挡位（对象）
  // 其它字段原样保留，插件不得触碰
}
```

- **输入模态只有 `text` / `image`**（`ModelModalityMap`，`@deepseek-ai/dsh-llm/lib/types/types.d.ts`），没有 audio/video。pi-ai 的 `declaredInput()` 把 `input: []` 与字段缺失同样视为未声明，因此空数组表达不了「显式不支持任何模态」。
- **思考挡位键只能是 `off, minimal, low, medium, high, xhigh, max`**（`THINKING_LEVELS`），没有 `none`。`reasoningEfforts` 是 `z.dict`：键 ⊆ 这七个，值 = 非空字符串，`off` 的值必须是 `null`（唯一允许 `null` 的键）；至少要有一个非 `off` 键，否则 DSH 报 `offers no level beyond "off"`；越界键被 schema 拒绝，未知键被静默忽略。
- 取值 `false` 表示非推理模型：不向用户暴露该状态，但读取时必须原样保留。
- **Default = 不声明**：把该字段从配置中删除，不写 `"default"`、`0`、空对象或空数组。字段消失后由 DSH 引擎自行回落（本机观测：`contextWindow 262144`、`maxTokens 32768`、`input ["text"]`；换 provider 或版本可能不同）。
- **模型目录来自 `ctx.llm`，不是 settings**：`listConfigurableProviders()` → `{ provider, displayName }[]`；`listModels(provider)` → `{ provider, id, name }[]`；`resolveModelInfo(provider, model, signal?)` 读取上游默认值。

## 3. 设置读写通道

`ctx.settings` 是 `@deepseek-ai/dsh-settings` 的 `SettingsProvider`：

| 方法 | 用途 |
|---|---|
| `describe()` | 返回 `SettingsDescriptor[]`，每项含 `ns` / `base` / `user` / `revision`，并自带生效值 `value` |
| `mutate(ns, ops, expectedRevision?)` | 按 path 写 user 层（`{ op: "set", path, value }`），用 revision 做并发控制 |
| `replace(ns, section, rev)` | 整体替换 user 段 |

- **生效配置的读取面是 `describe()[].value`**。运行版 `SettingsProvider` 没有 `get(ns)`（仅 0.1.5 存在），以 `settings.get(...)` 读模型列表会得到空结果。
- `SettingsDescriptor` 上没有 `writable` 字段；可写性取自 `SettingsProvider.writable`（`settings` 缺失或 `writable === false` 即不可写）。
- namespace 必须是小写连字符标识符（`llm-pi-ai` 合法）；写冲突抛 `SettingsConflictError`，需回 409 并把宿主原文交给 UI。
- 合并配置层时数组整体替换（`mergeLayers`）：用户层一旦存在同名数组，base 层同路径的值被完全覆盖。

## 4. 写入方式：整数组 `set`

保存某个模型时，对 `["providers", <providerId>, "models"]` 做**一次整数组 `set`**，而不是逐字段 path：

- 逐字段 path（`[..., "models", 0, "contextWindow"]`）只在**用户层已存在**该 `models` 数组时才安全。初始状态下该数组只存在于 base 层，path 会穿过一个不存在的数组，中间节点被兜底成普通对象（`models = {"0":{…}}`），被模型 schema 的 `z.array` 拒绝；越界数组索引在 0.1.7 还会抛 `TypeError: Config array index "0" is out of range`。整数组 `set` 在任何状态下都成立，DSH 官方 Models 设置页走的是同一条路。
- 实现：克隆生效值里的 `models` 数组，按 `id` 现查下标（不信任 client 传来的下标），对该条目逐字段 `delete entry[field]`（Default）或写入校验后的新值，然后一次 `mutate` 提交；host 不发送 `op: "unset"`。
- **副作用**：首次保存会把该 provider 的完整 `models` 数组物化进用户层 `settings.yaml`，从此覆盖 base 层（`cordis.patch.yml`）中同 provider 的模型列表，之后在 base 层新增或修改模型不会生效。恢复方式：删除 `settings.yaml` 中 `llm-pi-ai.providers.<provider>.models` 整个键。

## 5. HTTP API

- 仅 `POST /model-tweaks/api/<method>`，其它方法 → 405。
- 围栏：只接受 loopback + same-origin 请求，否则 → 403。
- 未知 method 或 method 含 `/` → 404；body 非 JSON → 415；body 超过 1 MiB → 413。
- 响应信封：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message } }`；client 只读 `body.value`。

| method | 入参 | 返回 `value` |
|---|---|---|
| `get` | `{}` | `{ providers, models, presets, writable, revision, modalities, warnings }` |
| `save` | `{ provider, model, changes }` | `{ model }` |
| `presets` | `{ action, payload }` | `{ presets }` |

**`get`**

- `providers[]` = `{ provider, displayName, declared, error, models[] }`；模型项 = `{ provider, providerName, id, name, effective, userDeclared }`。
- `models` 是 `providers[].models` 的扁平平铺，两者始终一致；旧 host 只给 `models` 时 client 退化为单个无标题分组。
- `effective` 只包含配置里真实存在的字段（缺键即省略）；`userDeclared` 表示 user 层显式声明过该字段（`input: []` 视为 Default）。
- `modalities` 恒为 `["text","image"]`；`warnings` 是诊断文案数组。
- 分组规则：只返回「用户配置过、且 `listModels` 至少返回一个模型」的 provider；未配置的 provider 不查询也不报警；配置了但失败或为空 → 该组不显示并记一条 warning；一个都没配置时退回 catalog 中非空的分组并记 warning。
- `llm-pi-ai` 未注册或不可读时返回 `models: []`、`writable: false`，不返回 5xx。

**`save`**

- `changes` 只处理出现的键：数字 / 字符串数组 / 对象 = 赋值，`null` = 删除该字段。
- 校验：`contextWindow`、`maxTokens` 必须为正整数；`input` 必须是 `["text","image"]` 的子集；`reasoningEfforts` 的键必须 ⊆ 七个挡位且值合法。越界 → 400，message 列出允许值。
- 目标模型不存在 → 400 `model-not-found`；`changes` 含受管四字段之外的键 → 400。
- 写冲突 → 409 `settings-conflict`（message 带宿主原文）；成功后回传保存后的该模型条目。

**`presets`**

- `action: "save"`：以完整 payload 整体替换预设文档；校验失败 → 400，写盘失败 → 500。
- `action: "resetDefaults"`：恢复内置默认并落盘后返回新文档；属显式确认动作，不受「草稿 + Apply」约束。

## 6. 预设存储与内置默认值

文件 `{DSH_HOME}/dsh-model-tweaks/presets.json`：

```jsonc
{ "version": 1, "contextWindows": [...], "maxOutputs": [...], "reasoningLevels": [...],
  "reasoningPresets": [{ "id": "...", "name": "...", "levels": [...] }] }
```

内置默认（host 与 client 各有一份逐字相同的镜像，跨半边测试逐项比对）：

| 字段 | 默认值 |
|---|---|
| `contextWindows` | `[8000, 16000, 32000, 64000, 128000, 256000, 512000, 1000000]` |
| `maxOutputs` | `[4000, 8000, 16000, 32000, 64000, 128000, 256000]` |
| `reasoningLevels` | `["off","minimal","low","medium","high","xhigh","max"]` |
| `reasoningPresets` | `DeepSeek = [off, low, high, max]`、`OpenAI Standard = [off, low, medium, high]`、`Simple = [off, low, high]`（都以 `off` 开头） |

- 文件不存在或损坏 → 回落内置默认并记 warning，不写盘、不报 5xx；第一次改动才落盘。
- 校验：数值列表为正整数、去重、升序；挡位列表为非空字符串并保持顺序；`reasoningPresets[].levels` 必须 ⊆ `reasoningLevels`，否则整体拒绝（400）。加载时某组合引用了文件里不存在的挡位，整份回落内置默认并记 warning。
- `Default` 行由 UI 渲染，不存储、不可删除。
- 显示名与存储值分离：**实际值永远存真实数字**，显示名只做十进制缩写——`formatCount`：能被 `1000000` 整除 → `<n>M`；能被 `1000` 整除 → `<n>K`；否则原样输出。即 `1000000→1M`、`128000→128K`、`200000→200K`、`1000→1K`；`1048576`、`131072`、`262144`、`32768`、`8192`、`1024` 等二进制值不做缩写。

## 7. 客户端契约

- 外壳：`window.__ModuleLoader__.load({ id: "dsh-model-tweaks", factory })`；`require` 只使用 `react` / `react/jsx-runtime`；导出 `apply` 与 `inject = ["slots", "locale"]`。
- slot 注册：`ctx.slots.register({ name: "settings.section", id: "model-tweaks", order: 250, label: () => t("nav"), locale: NS }, ModelCapabilitiesSection)`；label 走 locale（英文 `Model Capabilities`，中文 `模型能力`）。
- 页面：两个页签 `Model Capabilities` / `Presets`，只管理第 2 节的四个字段与第 6 节的四份预设列表。
- **草稿 + Apply**：所有编辑器改动（下拉、勾选、列表增删改与排序、`Reset to Default`）只写本地草稿；唯一写盘点是 `Apply`，有改动才可用。切换模型或页签必须丢弃未保存草稿。`Restore default presets` 与 `Save as preset…` 是显式确认动作，不受草稿约束。
- 结构（可断言约束）：
  - 卡片壳 `.mtw_group`（`border-l2` + 圆角 + `overflow:hidden`）与标题 `.mtw_groupHeader`（内含 `.mtw_caret` 与标题 span）在供应商卡片、模型卡片、Presets 折叠段三处共用；模型项为 `mtw_modelItem mtw_group`，选中态 `.mtw_modelRowActive`（仅加粗）。
  - 加载后**零默认展开、零默认选中**：没有卡片 `aria-expanded=true`，没有 `aria-pressed=true` 的行，也没有编辑区 / Apply / Reset。点击语义：点未选中行 → 选中并展开；再点同一行 → 收起但保留选中；点另一行 → 收起旧编辑区、丢弃草稿、展开新编辑区；点供应商标题只折叠、不改选中。
  - 模型编辑区是该模型卡片的直接子节点（`[行头, 编辑器]`）；Presets 展开体为 `.mtw_groupBody`（左缩进 16px）。
  - 层级与分隔：编辑区透明、无竖条与底色；Presets 条目之间用细线（`border-top`，必须用 `--dsw-alias-border-l1`，比卡片外壳的 `l2` 更弱），首行不画线；每张预设卡片底部 `.mtw_cardFooter` 内是自己的 `Apply`，与「添加 / 新建」之间用同一条 `l1` 细线分隔；动作型按钮为内容宽度（`.mtw_action`）。
  - 品牌色只用于页签激活下划线、复选框 `accent-color` 与主按钮。
- `Default` 与 Text / Image 是同一个选择：模态复选框不禁用，勾任一模态自动取消 `Default`，取消到最后一个模态自动回到 `Default`；写入语义不变（Default → 字段删除，有勾选 → 数组）。
- 反馈：成功绿字约 2.5 秒后自动收起；失败红字并附宿主原文；`warnings` 非空时页面底部以次要色渲染一行「诊断：…」（即使模型已列出也显示）。
- 主题 token 只使用运行版确实存在的名字（`--dsw-alias-brand-primary`、`--dsw-alias-bg-base/-layer-1/-layer-2/-overlay`、`--dsw-alias-border-l1/-l2`、`--dsw-alias-label-primary/-secondary`、`--dsw-alias-state-{error,success,warn,idle}-primary`、`--dsw-specific-sidebar-fill`），其余旧名必须写成 `var(--公开名, var(--旧名))` 的 fallback 形式；不写死颜色。
- 注入的 `<style data-plugin-css>` 每次加载先删同名旧标签再插。

## 8. 依赖与生效机制

- host 半零外部依赖：不 import 任何 `@deepseek-ai/*`，全部能力经 `ctx.get("…")` 宽容读取；若将来真的 import，必须同时声明依赖并装进该插件自己的 `node_modules`（manifest 测试有守卫）。host 用 Node 原生 ESM 解析，裸包名只从插件目录向上查找。
- client 半需要的包只写进 `package.json` 的 `dsh.client.inject`（即 DSH 客户端模块图与激活顺序），不需要安装：`@deepseek-ai/dsh-client-runtime`、`-locale`、`-ui-slots`、`-ui-settings`；`react` / `react/jsx-runtime` 是基线模块，不声明。
- client 改动由 `dsh-client-hmr` 重载 bundle，页面无需手动刷新；host 改动必须重启 DSH。
- 兼容性声明写在 `peerDependencies`：DSH 只校验名字为 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的条目，把声明范围与自己的运行时版本（prerelease 参与比较）做 semver 判定；不满足时安装被拒绝、启动给出告警，可用 `dsh plugin allow-version <包@版本> --dsh-version <确切版本>` 做确切版本豁免（记录在该 profile 的 `compatibility.json`）。`engines.dsh` 只是文档，运行时不会读取；`@deepseek-ai/cordis` 不在校验范围内。

## 9. 测试与验收

- `node --test`（等价 `pnpm test`）必须全绿且 `skipped 0`；全程离线，不需要 DSH 或浏览器。
- `test/manifest.test.mjs`：三处 id 一致、`dsh.client.inject`、host 未 import 未声明依赖、host 与 client 的 `DEFAULT_PRESETS` 与 `formatCount` 逐字一致、每个内置思考组合以 `off` 开头且只用已知挡位。
- `test/host-api.test.mjs`：围栏状态码、`get` 的枚举与 `effective`/`userDeclared`、整数组写入形状与 Default → 删除字段、正整数与挡位越界 400、`model-not-found`、`settings-conflict`、预设读写与损坏回落、`formatCount`，以及「仅 `describe().value` 可读」时的读取面回归。
- `test/client-page.test.mjs`：模块 id / inject / slot 注册、两个页签与四个控件、模态不含 Audio/Video、草稿语义（改动零请求、Apply 恰好一次 save、Default → `null`）、卡片折叠与选中、每卡片 Apply、诊断行、CSS 先删后插与扁平化与分隔 token 约束。
- 结构类断言具备突变敏感性：破坏卡片壳类名、默认折叠态或默认选中状态会被现有用例命中。

## 10. 已知缺陷与根因

| 现象 | 根因 |
|---|---|
| 页面上一个模型都列不出来 | 用 `settings.get("llm-pi-ai")` 读模型列表；运行版没有 `get(ns)`，应读 `describe()[].value` 并用 `ctx.llm` 枚举目录 |
| 保存后字段没变化，或 `models` 被写成对象 | 使用逐字段 path 写入；应改为整数组 `set`（第 4 节） |
| base 层新增的模型不生效 | 首次保存已把 `models` 数组物化进用户层并覆盖 base 层；删除 `settings.yaml` 中该键恢复 |
| 主按钮看起来像禁用 | 使用了不在公开 token 列表里的变量且没有 fallback，背景解析为空 |
| 空勾选集无法表达「不支持任何模态」 | `input: []` 与字段缺失在 pi-ai 中同义 |
| 自定义思考挡位写入失败 | `reasoningEfforts` 的键被 schema 限制为七个挡位；`none` 在 DSH 中对应 `off` |
| 热更新后样式不生效 | `<style>` 注入没有先删除同名旧标签 |
| 写盘成功但 Presets 页空白 | 宿主回包缺少 `presets` 时把 `undefined` 写入草稿；应按失败处理并回滚 |
