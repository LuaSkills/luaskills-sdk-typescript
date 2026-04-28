# @luaskills/sdk

TypeScript / Node.js SDK for integrating the LuaSkills runtime through the public JSON FFI surface.

TypeScript / Node.js SDK，用于通过公共 JSON FFI 接入 LuaSkills 运行时。

The SDK wraps native library loading, JSON FFI buffers, engine lifecycle, formal skill roots, authority-aware management calls, skill config, provider callbacks, and runtime asset installation. Hosts should not need to hand-write `FfiBorrowedBuffer`, `FfiOwnedBuffer`, or low-level JSON envelopes for normal integration.

SDK 封装了原生动态库加载、JSON FFI buffer、engine 生命周期、正式 skill root、带权限语义的管理调用、skill config、provider callback 与 runtime 资产安装。宿主在常规集成中不需要手写 `FfiBorrowedBuffer`、`FfiOwnedBuffer` 或底层 JSON 包络。

## Installation

```bash
npm install @luaskills/sdk
```

The npm package does not embed native runtime binaries or LuaRocks modules. Prepare a `runtimeRoot` with `install-runtime`, or pass an explicit `libraryPath` / `LUASKILLS_LIB` when you manage native files yourself.

npm 包不内置原生 runtime 二进制文件或 LuaRocks 模块。请先用 `install-runtime` 准备 `runtimeRoot`；如果宿主自行管理原生文件，也可以显式传入 `libraryPath` / `LUASKILLS_LIB`。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

Linux and macOS use the corresponding `.so` / `.dylib` binaries installed under `runtimeRoot/libs`.

Linux 与 macOS 会使用安装在 `runtimeRoot/libs` 下的 `.so` / `.dylib` 动态库。

## Runtime Assets

`install-runtime` downloads GitHub Release assets, verifies `.sha256` sidecars, extracts native files and Lua runtime packages, and writes:

`install-runtime` 会下载 GitHub Release 资产、校验 `.sha256` 旁路文件、解压原生文件与 Lua runtime 包，并写入：

```text
runtimeRoot/resources/luaskills-sdk-runtime-manifest.json
```

Supported database modes:

支持的数据库模式：

- `none`: installs the Lua runtime archive and the LuaSkills FFI SDK archive, without database providers.
- `none`：安装 Lua runtime 归档与 LuaSkills FFI SDK 归档，但不安装数据库 provider。
- `vldb-direct`: installs `vldb-sqlite-lib` and `vldb-lancedb-lib` dynamic libraries and uses `dynamic_library` provider mode.
- `vldb-direct`：安装 `vldb-sqlite-lib` 与 `vldb-lancedb-lib` 动态库，并使用 `dynamic_library` provider 模式。
- `vldb-controller`: installs `vldb-controller` and uses managed `space_controller` provider mode.
- `vldb-controller`：安装 `vldb-controller`，并使用托管的 `space_controller` provider 模式。
- `host-callback`: installs no VLDB binaries and generates `host_callback + json` host options.
- `host-callback`：不安装 VLDB 二进制文件，只生成 `host_callback + json` 宿主配置。

Default LuaSkills assets:

默认 LuaSkills 资产：

- `lua-runtime-{platform}.tar.gz`: installed by default; provides `lua_packages`, runtime `libs`, `resources`, and runtime licenses.
- `lua-runtime-{platform}.tar.gz`：默认安装；提供 `lua_packages`、运行时 `libs`、`resources` 与运行时授权材料。
- `luaskills-ffi-sdk-{platform}.tar.gz`: installed by default; provides the public FFI dynamic library, headers, and FFI licenses.
- `luaskills-ffi-sdk-{platform}.tar.gz`：默认安装；提供公共 FFI 动态库、头文件与 FFI 授权材料。
- `lua-deps-{platform}.tar.gz`: not installed by the SDK; it is a build-time bundle for CI, source builds, or advanced native module rebuilds.
- `lua-deps-{platform}.tar.gz`：SDK 不默认安装；它是 CI、源码构建或高级原生模块重建使用的构建期依赖包。

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database host-callback --runtime-root D:\runtime\luaskills
```

Use `--dry-run` to inspect the exact release URLs before downloading.

下载前可用 `--dry-run` 检查准确的 release URL。

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills --dry-run
```

Advanced hosts that already manage Lua packages can skip the Lua runtime archive:

已经自行管理 Lua 包的高级宿主可以跳过 Lua runtime 归档：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills --skip-lua-runtime
```

## Skill Roots

The SDK default root chain is formal and layered:

SDK 默认 root 链是正式分层模型：

```text
ROOT    = system-protected layer
PROJECT = ordinary project layer
USER    = ordinary user layer

ROOT    = 系统保护层
PROJECT = 项目普通层
USER    = 用户普通层
```

`RuntimeRoots.standard(runtimeRoot)` maps to:

`RuntimeRoots.standard(runtimeRoot)` 会映射到：

```text
runtimeRoot/root_skills
runtimeRoot/project_skills
runtimeRoot/user_skills
```

Put user-facing demo or installed skills under `user_skills` or `project_skills`. The legacy `skills` directory is not part of the SDK standard chain.

面向用户的 demo 或普通安装 skill 应放入 `user_skills` 或 `project_skills`。旧式 `skills` 目录不是 SDK 标准 root 链的一部分。

## CLI Flow

End-to-end CLI flow with a prepared runtime root:

基于已准备 runtime root 的 CLI 完整链路：

```powershell
$env:NODE_USE_ENV_PROXY = "1" # only needed when Node fetch must use HTTP_PROXY/HTTPS_PROXY

npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
npx @luaskills/sdk list --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"npx"}' --runtime-root D:\runtime\luaskills
```

If you prefer the shared controller mode:

如果更希望使用共享 controller 模式：

```powershell
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"controller"}' --runtime-root D:\runtime\luaskills
```

The SDK automatically resolves `luaskills.dll` / `libluaskills.so` / `libluaskills.dylib` from the runtime manifest and `runtimeRoot/libs`.

SDK 会自动从 runtime manifest 与 `runtimeRoot/libs` 解析 `luaskills.dll` / `libluaskills.so` / `libluaskills.dylib`。

## Code Usage

Basic client usage:

基础客户端用法：

```ts
import { Authority, LuaSkillsClient, RuntimeRoots } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const roots = RuntimeRoots.standard(runtimeRoot);
const client = LuaSkillsClient.create({ runtimeRoot });

try {
  client.loadFromRoots(roots);

  const entries = client.listEntries(Authority.DelegatedTool);
  const result = client.callSkill("demo-standard-ffi-skill-ping", {
    note: "typescript-sdk",
  });

  console.log(entries);
  console.log(result.content);
} finally {
  client.close();
}
```

Use `libraryPath` only when you intentionally bypass the runtime manifest:

只有在明确绕过 runtime manifest 时才需要使用 `libraryPath`：

```ts
const client = LuaSkillsClient.create({
  libraryPath: "D:/path/to/luaskills.dll",
  runtimeRoot: "D:/runtime/luaskills",
});
```

## Examples

Published examples import the package exactly as an external user would:

发布包中的示例会像外部用户一样直接引用 npm 包：

```js
import { LuaSkillsClient } from "@luaskills/sdk";
```

Run after preparing `runtimeRoot`:

准备好 `runtimeRoot` 后运行：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
$env:LUASKILLS_RUNTIME_ROOT = "D:\runtime\luaskills"
node node_modules\@luaskills\sdk\examples\basic.mjs
```

For source-tree examples, use the npm scripts:

源码仓库中的示例可以使用 npm scripts 运行：

```powershell
npm run example:basic
npm run example:call
npm run example:query
npm run example:lifecycle
npm run example:provider-callback
```

The query and lifecycle examples use the bundled fixture skill at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. Install runtime assets into that root first:

query 与 lifecycle 示例使用内置夹具 skill：`examples/fixture-runtime/user_skills/demo-standard-ffi-skill`。请先把 runtime 资产安装到该 root：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

See `examples/README.md` for the full example index and runtime notes.

完整示例索引与 runtime 注意事项见 `examples/README.md`。

For local repository development, run `npm run build` first. The examples still import `@luaskills/sdk`; Node resolves the current package by its package name when run inside the package.

本地仓库开发时请先运行 `npm run build`。示例仍然导入 `@luaskills/sdk`；在包目录内运行时，Node 会按包名解析当前 package。

## JSON Provider Callback

SQLite / LanceDB `host_callback + json` mode can be registered through the SDK before engine creation:

SQLite / LanceDB 的 `host_callback + json` 模式可以在 engine 创建前通过 SDK 注册：

```ts
import { LuaSkillsClient, LuaSkillsJsonFfi } from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setSqliteProviderJsonCallback((request) => {
  return { ok: true, request };
});

try {
  const client = LuaSkillsClient.create({
    runtimeRoot,
    hostOptions: {
      sqlite_provider_mode: "host_callback",
      sqlite_callback_mode: "json",
    },
  });
  client.close();
} finally {
  ffi.clearSqliteProviderJsonCallback();
}
```

Callbacks must be registered before `engine_new`. Changing callbacks later does not retroactively affect already-created engines.

callback 必须在 `engine_new` 前注册；engine 创建后再切换 callback 不会 retroactive 影响已存在的 engine。

## Authority And Management

Query APIs default to `Authority.DelegatedTool`, so ROOT skills are hidden from delegated tools:

查询 API 默认使用 `Authority.DelegatedTool`，因此委托工具看不到 ROOT skills：

```ts
client.listEntries();
client.listSkillHelp();
client.isSkill("some-root-tool");
```

`Authority.System` only means the host may manage ROOT. It does not bypass ROOT ownership or same-`skill_id` conflict rules.

`Authority.System` 只表示宿主可以管理 ROOT；它不表示可以绕过 ROOT 所有权或同名 `skill_id` 冲突规则。

Ordinary management should target USER or PROJECT:

普通管理面应固定目标为 USER 或 PROJECT：

```powershell
npx @luaskills/sdk install LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk update LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk uninstall luaskills-demo-skill --target-root USER
```

System management should be exposed only through trusted host/admin surfaces:

system 管理面只应通过可信宿主或管理员界面开放：

```powershell
npx @luaskills/sdk system-install LuaSkills/luaskills-demo-skill --target-root ROOT --authority system
```

If a system command is wrapped for ordinary tools, bind `--authority delegated_tool` in the host wrapper instead of letting the caller choose it.

如果 system 命令被封装给普通 tools，宿主 wrapper 应固定传入 `--authority delegated_tool`，而不是让调用方自行选择。

## Call Surface

`callSkill` and `runLua` execute active runtime code. They are not the same as delegated visibility queries.

`callSkill` 与 `runLua` 是运行时执行面，不等同于 delegated 可见性查询面。

If your product should not expose arbitrary Lua execution, do not expose `runLua` to untrusted users. If only selected tools should be callable, enforce that allowlist in your host tool wrapper.

如果产品不应该允许任意 Lua 执行，不要把 `runLua` 暴露给不可信用户。如果只允许调用部分工具，应在宿主工具 wrapper 中实现 allowlist。

## Skill Config

Skill config is a plain `skill_id + key` storage surface:

skill config 是普通的 `skill_id + key` 配置存储面：

```ts
client.config.set("my-skill", "api_key", "value");
client.config.get("my-skill", "api_key");
client.config.list("my-skill");
client.config.delete("my-skill", "api_key");
```

Configuration only affects behavior when the Lua skill reads it. It is not a hard runtime policy layer.

配置只有在 Lua skill 主动读取时才会影响行为；它不是运行时强制策略层。

If the host does not want users to change a core capability, implement that capability as host-controlled logic or a trusted system surface instead of relying on writable skill config.

如果宿主不希望用户修改核心能力，应把该能力实现为宿主受控逻辑或可信 system 面，而不是依赖可写 skill config。

## Troubleshooting

### `fetch failed` while installing runtime assets

`install-runtime` uses Node `fetch` to download GitHub Release assets. In proxy environments, PowerShell or curl may work while Node fetch still fails with `ECONNRESET` or `UND_ERR_CONNECT_TIMEOUT`.

`install-runtime` 使用 Node `fetch` 下载 GitHub Release 资产。在代理环境中，PowerShell 或 curl 可能可用，但 Node fetch 仍可能因为 `ECONNRESET` 或 `UND_ERR_CONNECT_TIMEOUT` 失败。

Set proxy variables and enable Node environment proxy support when needed:

必要时设置代理环境变量，并启用 Node 环境代理支持：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:NODE_USE_ENV_PROXY = "1"
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
```

### `LuaSkills library path is required`

This means the SDK could not find a native LuaSkills library. Run `install-runtime`, pass `--runtime-root`, or set `LUASKILLS_LIB`.

这表示 SDK 找不到 LuaSkills 原生动态库。请运行 `install-runtime`、传入 `--runtime-root`，或设置 `LUASKILLS_LIB`。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

### Lua modules are missing at runtime

If a skill fails with Lua module loading errors, make sure `install-runtime` was run without `--skip-lua-runtime` and that `runtimeRoot/lua_packages` exists. The SDK installs `lua-runtime-{platform}.tar.gz` by default for this reason.

如果 skill 运行时出现 Lua 模块加载错误，请确认运行 `install-runtime` 时没有使用 `--skip-lua-runtime`，并且 `runtimeRoot/lua_packages` 存在。SDK 默认安装 `lua-runtime-{platform}.tar.gz` 正是为了解决这个运行期依赖问题。

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
Test-Path D:\runtime\luaskills\lua_packages
```

### `list` is empty after copying a demo skill

Check the directory. SDK standard roots are `root_skills`, `project_skills`, and `user_skills`; putting a skill under `runtimeRoot/skills` will not load it through the standard chain.

请检查目录。SDK 标准 root 是 `root_skills`、`project_skills`、`user_skills`；把 skill 放到 `runtimeRoot/skills` 不会通过标准链加载。

```text
D:\runtime\luaskills\user_skills\demo-standard-ffi-skill\skill.yaml
```

### JSON parse errors on Windows local shims

When calling the local npm `.cmd` shim directly from PowerShell, single-quoted JSON may be forwarded differently and produce `Expected property name or '}' in JSON`. Prefer `npx`, the `.ps1` shim, or a JS script for local smoke tests.

在 PowerShell 中直接调用本地 npm `.cmd` shim 时，单引号 JSON 可能被不同方式转发，并触发 `Expected property name or '}' in JSON`。本地烟测建议优先使用 `npx`、`.ps1` shim 或 JS 脚本。

```powershell
.\node_modules\.bin\luaskills.ps1 call demo-standard-ffi-skill-ping '{"note":"powershell"}' --runtime-root D:\runtime\luaskills
```

### `vldb-controller` process remains after tests

Managed controller mode may keep a controller process alive for its lease/idle timeout. For tests, stop only the controller executable under your test `runtimeRoot/bin`.

托管 controller 模式可能会按 lease/idle timeout 保留 controller 进程。测试清理时只应停止测试 `runtimeRoot/bin` 下的 controller 可执行文件。

## JSON FFI Coverage

The SDK covers the public JSON FFI surface:

SDK 覆盖公共 JSON FFI 主要入口：

- version / describe
- engine_new / engine_free
- load_from_dirs / load_from_roots
- reload_from_dirs / reload_from_roots
- list_entries / list_skill_help / render_skill_help_detail
- prompt_argument_completions / is_skill / skill_name_for_tool
- call_skill / run_lua
- skill_config list / get / set / delete
- SQLite / LanceDB JSON provider callback register / clear
- disable / enable / install / update / uninstall
- system_disable / system_enable / system_install / system_update / system_uninstall

## Publishing

Before publishing:

发布前执行：

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

The package exposes:

包暴露：

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `dist/cli.js`

Use a new patch version for every npm publish. Published versions cannot be overwritten.

每次 npm publish 都必须使用新的 patch 版本；已发布版本不能覆盖。
