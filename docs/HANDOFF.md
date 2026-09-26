# dsh-model-tweaks 开发与维护说明

> 面向后续维护者。接口、数据语义与 UI 结构约束以 [docs/CONTRACT.md](CONTRACT.md) 为准；本文件只讲工程结构、依赖解析、测试基础设施与开发约定。

## 1. 工程结构

| 路径 | 职责 |
|---|---|
| `lib/index.js` | host 半：Node ESM、手写、零外部依赖；settings 读写 + `/model-tweaks/api/*` |
| `lib/client.js` | client 半：浏览器 bundle、手写、非构建产物；设置页 UI |
| `cordis.patch.yml` | bundle patch：insert 一个 id 为 `dsh-model-tweaks` 的 loader 条目 |
| `test/support/harness.mjs` | 离线测试桩：stub 模块图 + 迷你 React + DOM / settings 双击 |
| `test/support/format-cases.mjs` | `formatCount` 共用用例表（host 与 client 各有一份实现，靠它焊接） |
| `docs/CONTRACT.md` | 接口与数据契约 |
| `docs/images/{zh,en}/` | 文档截图（离线渲染产物） |

三处 id 必须一致：patch 的 insert `id`、`lib/client.js` 的 `__ModuleLoader__.load({ id })`、`lib/index.js` 导出的 `name`。

## 2. 依赖解析规则

| 半边 | 解析方式 | 约束 |
|---|---|---|
| host（`lib/index.js`） | Node 原生 ESM：裸包名只沿模块自身所在目录向上查找 | 真 `import` 的 `@deepseek-ai/*` 必须写进 `package.json` 并装进该插件自己的 `node_modules`；当前实现零外部依赖，全部能力经 `ctx.get("…")` 读取 |
| client（`lib/client.js`） | DSH 客户端模块表（`__ModuleLoader__`） | 用到的客户端插件包写进 `package.json` 的 `dsh.client.inject`，不需要安装；`react` / `react/jsx-runtime` 是基线模块，不声明 |

- `dsh.client.inject` 的语义是「客户端模块图 + 激活顺序」，不是 Node 包名。当前列：`@deepseek-ai/dsh-client-runtime`、`-locale`、`-ui-slots`、`-ui-settings`（`ui-slots` 提供 `slots`，`client-locale` 提供 `locale`，声明与实际用到的服务必须对应）。
- `peerDependencies` 只保留 `@deepseek-ai/cordis`（optional）。
- host 一旦需要 import DSH 包，manifest 测试会要求同步补 `dependencies`，否则测试变红。

## 3. 生效机制

| 改动 | 生效方式 |
|---|---|
| `lib/client.js` | `dsh-client-hmr` 轮询到文件变化后重载 bundle，页面无需手动刷新 |
| `lib/index.js`（含内置预设默认值） | 必须重启 DSH：host 模块不参与热更新，重启会打断正在运行的会话 |

- 已发布的版本用 `dsh plugin --profile desktop add dsh-model-tweaks` 装进 profile：插件管理器会把该包写入 `dsh.profile.bundles`，新装的组合包默认启用；卸载走侧边栏「插件」页或 `dsh plugin --profile desktop remove …`。本地开发则把仓库以 link / junction 方式接进 profile，此时仓库路径即运行版路径，不存在第二份副本。
- 「插件」页的**添加插件**与 `dsh plugin --profile <name> add` 接受同一组 spec：npm 包名、`github:owner/repo`（gitlab / bitbucket / gist 同理）、托管的仓库地址 `https://host/owner/repo(.git)(#ref)`、git URL（`git://`、`git+ssh://`、`git@host:owner/repo`）、`*.tgz` / `*.tar.gz`、以及绝对本地目录。宿主先解析 spec，再对 github.com 仓库做一次 `git ls-remote` 预检（默认 5s、禁用凭据助手，只有网络失败或超时会中止），最后交给 pnpm；安装会拒绝没有 bundle patch 的包装。
- `{DSH_HOME}/dsh-model-tweaks/presets.json` 一旦存在，host 只读该文件、不再使用内置默认值；要让新的内置默认生效，需在预设页点「恢复默认」或删除该文件。

## 4. 离线测试基础设施（`test/support/harness.mjs`）

`node --test` 不需要 DSH 与浏览器：harness 用 stub 模块图 + 迷你 React + DOM/settings 双击，直接加载 `lib/index.js` / `lib/client.js`。

- **加载**：`loadHost()` → host 命名空间（`{ name, inject, apply }`）；`loadClient({ dom })` → client 导出，模块 id 不符即抛错；断言 CSS「先删后插」必须传入同一个 `dom`（否则每次加载都新建 DOM，断言会变成恒真）。
- **上下文**：`makeHostContext({ settings, llm, webServer })` → `{ ctx, routes, logs }`，`webServer.register` 的调用全部记录在 `routes`；`makeClientContext({ locale, services, guarded })` → `{ ctx, slots, injections }`，`guarded` 用于模拟漏写 `inject` 时的属性读取异常。
- **host API**：`callApi(routes, method, body, options)` → `{ status, body }`；默认带 loopback + same-origin 头，413/415 用 `raw`/`headers` 构造，405 用 `options.method: "GET"`；成功响应读 `body.value`。
- **settings 双击** `makeSettingsDouble(...)`：复刻 0.1.7-rc.2 的 `applyPathOp`（数组按索引编辑、叶子 `unset` 是 `delete`、越界索引抛 `TypeError`、`set` 的 `null` 就是 `null`）；`omitGet: true` 去掉 `get()`，用于钉住「读取面必须是 `describe()[].value`」的回归；`writable` 同时挂在 service 与 descriptor 上，以覆盖 host 的两条读取路径。
- **llm 双击** `makeLlmDouble(...)`：`listConfigurableProviders` / `listModels`（可指定某些 provider 失败，用于验证「单组失败不整体失败」）/ `resolveModelInfo`。
- **fetch 双击** `installFetch(value)`：把响应包成 `{ ok: true, value }` 并记录每次调用（`{ method, url, body }`）。
- **渲染**：`createInstance()` + `renderComponent()` 复用同一实例才能观察 effect 里的 `setState`（首帧 → `await flush()` → 重渲染）；`collect` / `textOf` / `hasClass` 等用于断言元素树。
- harness 顶层把 `setInterval` 置为 no-op、保留真实 `setTimeout`（组件 2.5 秒自动收起依赖它）。

## 5. 测试文件与断言要点

| 文件 | 锁定内容 |
|---|---|
| `test/manifest.test.mjs` | 三处 id 一致、`dsh.client.inject`、host 依赖声明守卫、host 与 client 的 `DEFAULT_PRESETS` 与 `formatCount` 逐字一致、内置思考组合以 `off` 开头且只用已知挡位 |
| `test/host-api.test.mjs` | 围栏状态码；`get` 的分组过滤、`effective`/`userDeclared`、`warnings`、`llm` 缺失回退；整数组写入与 Default → 删除字段；校验 400 与冲突 409；预设读写与损坏回落；`formatCount` |
| `test/client-page.test.mjs` | 模块 id / inject / slot 注册；页签与控件语义；草稿语义（改动零请求、Apply 恰好一次 save、Default → `null`、切模型丢草稿）；卡片折叠与选中；每张卡片自己的 Apply 与整份文档提交；诊断行；CSS 先删后插、扁平化与分隔 token 约束 |
| `test/support/format-cases.mjs` | `formatCount` 共用用例表，跨半数用同一张表断言 |

- `node --test` 会把 `test/support/harness.mjs` 与 `format-cases.mjs` 也当作测试文件各执行一次（0 断言、显示通过），属预期现象。
- 结构类断言具备突变敏感性：破坏卡片壳类名、默认折叠态、默认选中状态或分隔 token 都会让用例变红。

## 6. 常见工程问题

| 现象 | 原因与处理 |
|---|---|
| 设置里没有新页签 | profile 的 `dsh.profile.bundles` 未注册，或未重启 DSH |
| 页签出现但 API 全部失败 | host 半改动后没有重启 DSH |
| 页面白屏 / `require` 失败 | client 半 `require` 了既不是基线模块、也没写进 `dsh.client.inject` 的包 |
| 日志 `ERR_MODULE_NOT_FOUND` | host 半 import 了没装进该插件 `node_modules` 的 `@deepseek-ai/*` |
| 客户端服务读到 `undefined` | 用到的服务未写进 `inject` 数组 |
| 热更新后新样式不生效 | `<style>` 注入未先删除同名旧标签 |
| 保存报 `settings-conflict` | 并发写冲突，刷新页面重试（响应带宿主原文） |

功能类缺陷（读错读取面、整数组写入、预设白屏等）见 [docs/CONTRACT.md](CONTRACT.md) 第 10 节。

## 7. 代码与样式约定

- `lib/client.js` 是手写产物（含超长 CSS 字符串、既有类名映射、CRLF 行尾）：用工具修改而非手抄；改完必须通过语法检查与 `node --test`。
- 设置页只使用 React 与原生元素（`div` / `select` / `input` / `button`），不引入新的运行时依赖；图标不使用 UI primitives。
- 样式只用 DSH 主题 token，不写死颜色；与官方样式冲突时用双类名提升权重；状态色使用语义 token（`--dsw-alias-state-success-*` / `-error-*`）。
- 品牌色只用于页签激活下划线、复选框 `accent-color` 与主按钮；不在公开 token 列表里的变量必须写成带 fallback 的形式。
- 不新增聊天页、卡片墙或装饰性 UI：该插件只提供一个设置页。

## 8. 文档与发布约定

- `README.md` / `README.en.md`：只保留四段结构（作用、预设功能、安装、测试）与截图；功能或安装方式变化必须同步。
- `docs/CONTRACT.md` 是接口与语义的唯一依据；实现与契约不一致时，先改契约再改代码。
- 截图位于 `docs/images/{zh,en}/`，为离线渲染产物（非真机截屏）；UI 变更后需重新生成。
- 发布（尚未执行）：更新 `package.json` 的 `version`，确认 `node --test` 全绿且 `skipped 0`；`files` 白名单为 `lib`、`cordis.patch.yml`、`README.md`、`README.en.md`、`docs`、`package.json`。插件以链接方式安装，不需要 `npm publish`。
