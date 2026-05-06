# @luaskills/sdk

English documentation is the default package documentation. For Chinese, see [README_cn.md](README_cn.md).

Main LuaSkills repository: [LuaSkills/luaskills](https://github.com/LuaSkills/luaskills)

TypeScript / Node.js SDK for integrating the LuaSkills runtime through the public JSON FFI surface.

The SDK wraps native library loading, JSON FFI buffers, engine lifecycle, formal skill roots, authority-aware management calls, skill config, provider callbacks, host-tool callbacks, and runtime asset installation. Hosts should not need to hand-write low-level FFI buffers or JSON envelopes for normal integration.

## Installation

```bash
npm install @luaskills/sdk
```

The npm package does not embed native runtime binaries or LuaRocks modules. Prepare a `runtimeRoot` with `install-runtime`, or pass an explicit `libraryPath` / `LUASKILLS_LIB` when you manage native files yourself.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

Linux and macOS use the corresponding `.so` / `.dylib` binaries installed under `runtimeRoot/libs`.

## Runtime Assets

`install-runtime` downloads GitHub Release assets, verifies `.sha256` sidecars, extracts native files and Lua runtime packages, and writes:

```text
runtimeRoot/resources/luaskills-sdk-runtime-manifest.json
```

Supported database modes:

- `none`: installs the Lua runtime archive and the LuaSkills FFI SDK archive, without database providers.
- `vldb-direct`: installs `vldb-sqlite-lib` and `vldb-lancedb-lib` dynamic libraries and uses `dynamic_library` provider mode.
- `vldb-controller`: installs `vldb-controller` and uses managed `space_controller` provider mode.
- `host-callback`: installs no VLDB binaries and generates `host_callback + json` host options.

Default LuaSkills assets:

- `lua-runtime-packages-{platform}.tar.gz` from `LuaSkills/luaskills-packages`: installed by default; provides `lua_packages`, package-side runtime `libs`, `resources`, and third-party runtime licenses.
- `luaskills-ffi-sdk-{platform}.tar.gz`: installed by default; provides the public FFI dynamic library, headers, and FFI licenses.
- `lua-deps-{platform}.tar.gz`: not installed by the SDK; it is a build-time bundle for CI, source builds, or advanced native module rebuilds.

The SDK keeps LuaSkills core aligned with the SDK release and resolves runtime packages from the compatible `0.1` series by selecting the newest published patch automatically.

## Upgrading from `0.2` to `0.3`

If you are upgrading from the `0.2.x` line:

- keep the SDK and LuaSkills core on the same `0.3.x` version line
- expect Lua runtime packages and native deps to come from `LuaSkills/luaskills-packages`, not only from the main `luaskills` release
- expect the installer to resolve the newest published patch from the compatible `0.1` packages series unless you pin an exact packages version
- if you copied old runtime install scripts or release assumptions into your own project, update them to the split `core + packages` model

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk install-runtime --database host-callback --runtime-root D:\runtime\luaskills
```

Use `--dry-run` to inspect exact release URLs before downloading:

```powershell
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills --dry-run
```

Advanced hosts that already manage Lua packages can skip the Lua runtime archive:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills --skip-lua-runtime
```

## Skill Roots

The SDK default root chain is formal and layered:

```text
ROOT    = system-protected layer
PROJECT = ordinary project layer
USER    = ordinary user layer
```

`RuntimeRoots.standard(runtimeRoot)` maps to:

```text
runtimeRoot/root_skills
runtimeRoot/project_skills
runtimeRoot/user_skills
```

Put user-facing demo or installed skills under `user_skills` or `project_skills`. The legacy `skills` directory is not part of the SDK standard chain.

## CLI Flow

End-to-end CLI flow with a prepared runtime root:

```powershell
$env:NODE_USE_ENV_PROXY = "1" # only needed when Node fetch must use HTTP_PROXY/HTTPS_PROXY

npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
npx @luaskills/sdk list --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"npx"}' --runtime-root D:\runtime\luaskills
```

If you prefer the shared controller mode:

```powershell
npx @luaskills/sdk install-runtime --database vldb-controller --runtime-root D:\runtime\luaskills
npx @luaskills/sdk call demo-standard-ffi-skill-ping '{"note":"controller"}' --runtime-root D:\runtime\luaskills
```

The SDK automatically resolves `luaskills.dll` / `libluaskills.so` / `libluaskills.dylib` from the runtime manifest and `runtimeRoot/libs`.

## Code Usage

Basic client usage:

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

```ts
const client = LuaSkillsClient.create({
  libraryPath: "D:/path/to/luaskills.dll",
  runtimeRoot: "D:/runtime/luaskills",
});
```

## Examples

Published examples import the package exactly as an external user would:

```js
import { LuaSkillsClient } from "@luaskills/sdk";
```

Run after preparing `runtimeRoot`:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
$env:LUASKILLS_RUNTIME_ROOT = "D:\runtime\luaskills"
node node_modules\@luaskills\sdk\examples\basic.mjs
```

For source-tree examples, use npm scripts:

```powershell
npm run example:basic
npm run example:call
npm run example:host-tool-callback
npm run example:query
npm run example:lifecycle
npm run example:runtime-session
npm run example:provider-callback
```

The query, lifecycle, and runtime-session examples use the bundled fixture skill at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. Install runtime assets into that root first:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

See [examples/README.md](examples/README.md) for the full example index and runtime notes. The Chinese example guide is [examples/README_cn.md](examples/README_cn.md).

## Persistent Runtime Sessions

Use `client.runtimeSessions()` for the public lease endpoints, or `client.system(authority).runtimeSessions()` when the host wants fixed authority injection through the dedicated system runtime-session exports provided by the latest native library.

```ts
import { Authority, LuaSkillsClient } from "@luaskills/sdk";

const client = LuaSkillsClient.create({ runtimeRoot: "D:/runtime/luaskills" });

try {
  const sessions = client.system(Authority.System).runtimeSessions();
  const session = sessions.createHandle("demo-session", 600, true);
  const result = session.eval("counter = (counter or 0) + 1; return { counter = counter }");
  console.log(result.result);
  console.log(session.status());
  console.log(session.close());
} finally {
  client.close();
}
```

## Migration Notes

- Existing `client.system(authority)` lifecycle calls keep working; the returned wrapper now also exposes query helpers and `runtimeSessions()`.
- `RuntimeSessionHandle` persists `lease_id + sid + generation` and automatically reattaches identity guards on `eval`, `status`, and `close`.
- `client.system(authority).runtimeSessions()` requires the dedicated `luaskills_ffi_system_runtime_session_*` exports from the latest native library and fails fast when they are missing.
- Source-tree examples now load the published package when available and otherwise fall back to the local `dist` build, so the repository smoke path and standalone examples package use the same scripts.

## JSON Provider Callback

SQLite / LanceDB `host_callback + json` mode can be registered through the SDK before engine creation:

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

## Host Tool Callback

`vulcan.host.*` uses the fixed host-tool callback registered through `luaskills_ffi_set_host_tool_json_callback`. Register it before running skills that may call host-owned tools:

```ts
import { LuaSkillsJsonFfi, type HostToolJsonRequest } from "@luaskills/sdk";

// Runtime root used by the host integration.
// 宿主集成使用的运行时根目录。
const runtimeRoot = "D:/runtime/luaskills";
// Low-level FFI bridge that owns callback registration.
// 持有 callback 注册的底层 FFI 桥。
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

// Handle list, has, and call actions from vulcan.host.*.
// 处理来自 vulcan.host.* 的 list、has 和 call 动作。
ffi.setHostToolJsonCallback((request: HostToolJsonRequest) => {
  switch (request.action) {
    case "list":
      return [{ name: "model.embed", description: "embedding model bridge" }];
    case "has":
      return request.tool_name === "model.embed";
    case "call":
      return { ok: true, value: { request: request.args } };
    default:
      return { ok: false, error: { code: "unsupported_action", message: request.action } };
  }
});
```

The callback receives `{ action, tool_name, args }`. `list` should return host-visible tool metadata, `has` should return a boolean or an object with `exists` / `has` / `available`, and `call` should return one complete table-shaped result. Call `ffi.clearHostToolJsonCallback()` during shutdown. Streaming is intentionally outside this bridge.

## Model Callback

`vulcan.models.*` uses fixed model callbacks registered through `luaskills_ffi_set_model_embed_json_callback` and `luaskills_ffi_set_model_llm_json_callback`. Lua skills can only call `vulcan.models.embed(text)` and `vulcan.models.llm(system, user)`; provider selection, model names, keys, temperature, thinking, limits, and stream policy stay fully host-owned.

Register model callbacks before creating or using an engine that may run model-aware skills. Keep the `LuaSkillsJsonFfi` instance alive for as long as the callback should stay registered, and clear callbacks during shutdown or test teardown.

The SDK callback is the host boundary:

- It receives a fixed request shape from LuaSkills.
- It should call the host-selected provider using host-managed configuration.
- It should return a bare success payload for successful provider calls.
- It should return an error envelope for provider failures that need `provider_message`, `provider_code`, or `provider_status`.
- It should not expose API keys, Authorization headers, signatures, or raw request headers in provider error fields.

```ts
import {
  LuaSkillsJsonFfi,
  type RuntimeModelEmbedRequest,
  type RuntimeModelLlmRequest,
} from "@luaskills/sdk";

const runtimeRoot = "D:/runtime/luaskills";
const ffi = new LuaSkillsJsonFfi({ runtimeRoot });

ffi.setModelEmbedJsonCallback((request: RuntimeModelEmbedRequest) => {
  return {
    vector: [0.1, 0.2, 0.3],
    dimensions: 3,
    usage: { input_tokens: request.text.length },
  };
});

ffi.setModelLlmJsonCallback((request: RuntimeModelLlmRequest) => {
  if (request.user.includes("missing-model")) {
    return {
      ok: false,
      error: {
        code: "provider_error",
        message: "model provider rejected the request",
        provider_message: "raw provider message after host-side redaction",
        provider_code: "model_not_found",
        provider_status: 404,
      },
    };
  }
  return {
    assistant: `handled ${request.system}: ${request.user}`,
    usage: { input_tokens: 12, output_tokens: 8 },
  };
});
```

The callback request includes `{ text, caller }` for embeddings and `{ system, user, caller }` for LLM calls. Return bare success payloads, or `{ ok: false, error: { code, message, provider_message?, provider_code?, provider_status? } }` for provider failures. Call `ffi.clearModelEmbedJsonCallback()` and `ffi.clearModelLlmJsonCallback()` during shutdown.

Minimal runtime check after registration:

```ts
const status = client.runLua("return vulcan.models.status()");
const embedResult = client.runLua('return vulcan.models.embed("hello")');
const llmResult = client.runLua('return vulcan.models.llm("system", "user")');
```

Common integration mistakes:

- `model_unavailable`: the matching callback was not registered or was cleared before the skill call.
- Missing provider details: return a structured error envelope instead of throwing provider errors from the callback.
- Missing FFI symbol: install a LuaSkills runtime that exports `luaskills_ffi_set_model_embed_json_callback` and `luaskills_ffi_set_model_llm_json_callback`.
- Empty `caller` fields: call through a loaded runtime skill or a runtime `runLua` context, not a detached provider unit test.

## Authority And Management

Query APIs default to `Authority.DelegatedTool`, so ROOT skills are hidden from delegated tools:

```ts
client.listEntries();
client.listSkillHelp();
client.isSkill("some-root-tool");
```

`Authority.System` only means the host may manage ROOT. It does not bypass ROOT ownership or same-`skill_id` conflict rules.

Ordinary management should target USER or PROJECT:

```powershell
npx @luaskills/sdk install LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk update LuaSkills/luaskills-demo-skill --target-root USER
npx @luaskills/sdk uninstall luaskills-demo-skill --target-root USER
```

System management should be exposed only through trusted host/admin surfaces:

```powershell
npx @luaskills/sdk system-install LuaSkills/luaskills-demo-skill --target-root ROOT --authority system
```

If a system command is wrapped for ordinary tools, bind `--authority delegated_tool` in the host wrapper instead of letting the caller choose it.

## Call Surface

`callSkill` and `runLua` execute active runtime code. They are not the same as delegated visibility queries.

If your product should not expose arbitrary Lua execution, do not expose `runLua` to untrusted users. If only selected tools should be callable, enforce that allowlist in your host tool wrapper.

## Skill Config

Skill config is a plain `skill_id + key` storage surface:

```ts
client.config.set("my-skill", "api_key", "value");
client.config.get("my-skill", "api_key");
client.config.list("my-skill");
client.config.delete("my-skill", "api_key");
```

Configuration only affects behavior when the Lua skill reads it. It is not a hard runtime policy layer.

If the host does not want users to change a core capability, implement that capability as host-controlled logic or a trusted system surface instead of relying on writable skill config.

## Troubleshooting

### `fetch failed` while installing runtime assets

`install-runtime` uses Node `fetch` to download GitHub Release assets. In proxy environments, PowerShell or curl may work while Node fetch still fails with `ECONNRESET` or `UND_ERR_CONNECT_TIMEOUT`.

Set proxy variables and enable Node environment proxy support when needed:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:10808"
$env:HTTPS_PROXY = "http://127.0.0.1:10808"
$env:NODE_USE_ENV_PROXY = "1"
npx @luaskills/sdk install-runtime --database vldb-direct --runtime-root D:\runtime\luaskills
```

### `LuaSkills library path is required`

This means the SDK could not find a native LuaSkills library. Run `install-runtime`, pass `--runtime-root`, or set `LUASKILLS_LIB`.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
npx @luaskills/sdk version --runtime-root D:\runtime\luaskills
```

### Lua modules are missing at runtime

If a skill fails with Lua module loading errors, make sure `install-runtime` was run without `--skip-lua-runtime` and that `runtimeRoot/lua_packages` exists. The SDK installs `lua-runtime-packages-{platform}.tar.gz` from `LuaSkills/luaskills-packages` by default for this reason.

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root D:\runtime\luaskills
Test-Path D:\runtime\luaskills\lua_packages
```

### `list` is empty after copying a demo skill

Check the directory. SDK standard roots are `root_skills`, `project_skills`, and `user_skills`; putting a skill under `runtimeRoot/skills` will not load it through the standard chain.

```text
D:\runtime\luaskills\user_skills\demo-standard-ffi-skill\skill.yaml
```

### JSON parse errors on Windows local shims

When calling the local npm `.cmd` shim directly from PowerShell, single-quoted JSON may be forwarded differently and produce `Expected property name or '}' in JSON`. Prefer `npx`, the `.ps1` shim, or a JS script for local smoke tests.

```powershell
.\node_modules\.bin\luaskills.ps1 call demo-standard-ffi-skill-ping '{"note":"powershell"}' --runtime-root D:\runtime\luaskills
```

### `vldb-controller` process remains after tests

Managed controller mode may keep a controller process alive for its lease/idle timeout. For tests, stop only the controller executable under your test `runtimeRoot/bin`.

## JSON FFI Coverage

The SDK covers the public JSON FFI surface:

- version / describe
- engine_new / engine_free
- load_from_roots / reload_from_roots
- list_entries / list_skill_help / render_skill_help_detail
- prompt_argument_completions / is_skill / skill_name_for_tool
- call_skill / run_lua
- skill_config list / get / set / delete
- SQLite / LanceDB JSON provider callback register / clear
- Host-tool JSON callback register / clear
- Model embed / LLM JSON callback register / clear
- disable / enable / install / update / uninstall
- system_disable / system_enable / system_install / system_update / system_uninstall

## Publishing

The release version is stored in `VERSION`. Keep `VERSION`, `package.json`, and `package-lock.json` aligned before publishing.

For one unified ecosystem release, publish `LuaSkills/luaskills-packages` first, then publish `LuaSkills/luaskills`, so the default runtime installer assets for this SDK already exist before npm goes live.

Before publishing:

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

The package exposes:

- `main`: `dist/index.js`
- `types`: `dist/index.d.ts`
- `bin`: `dist/cli.js`

Use a new patch version for every npm publish. Published versions cannot be overwritten.

Recommended unified publish order: `luaskills-packages` -> `luaskills` core release -> TypeScript SDK -> Python SDK -> Go SDK -> SDK examples releases.

After npm publishes successfully, run the GitHub Actions workflow **Examples Release** manually. It reads `VERSION`, installs `@luaskills/sdk@{VERSION}` from npm, installs LuaSkills runtime assets, runs the examples, then creates or updates the `examples-v{VERSION}` GitHub Release with:

- `luaskills-sdk-typescript-examples-{VERSION}.zip`
- `luaskills-sdk-typescript-examples-{VERSION}.zip.sha256`

The examples release tag intentionally uses the `examples-v` prefix because it is an examples asset release, not an SDK package version.
