# LuaSkills TypeScript SDK Examples

English documentation is the default example documentation. For Chinese, see [README_cn.md](README_cn.md).

Main LuaSkills repository: [LuaSkills/luaskills](https://github.com/LuaSkills/luaskills)

These examples use the published SDK package shape and are intended to be copied into host applications.

## Runtime Preparation

Install runtime assets before running examples:

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

If you already manage the native library yourself, set `LUASKILLS_LIB` instead:

```powershell
$env:LUASKILLS_LIB = "D:\runtime\luaskills\libs\luaskills.dll"
```

## Example Index

`basic.mjs` queries the JSON FFI version through `LuaSkillsClient.version`.

```powershell
node .\examples\basic.mjs
```

`query.mjs` loads the bundled USER-layer fixture skill, lists delegated-visible entries, checks `isSkill`, resolves `skillNameForTool`, and reads help/completion surfaces.

```powershell
node .\examples\query.mjs
```

`call.mjs` demonstrates `callSkill` and `runLua` with an invocation context.

```powershell
node .\examples\call.mjs
```

`host-tool-callback.mjs` registers a mock `model.embed` host-tool callback and exercises `vulcan.host.list`, `vulcan.host.has`, and `vulcan.host.call` from inline Lua.

```powershell
node .\examples\host-tool-callback.mjs
```

`lifecycle.mjs` demonstrates `disable` and `enable` through the ordinary Skills plane.

```powershell
node .\examples\lifecycle.mjs
```

`runtime-session.mjs` demonstrates one persistent runtime lease, authority-bound system queries, and repeated `eval` calls that reuse one interactive child-process handle.

```powershell
node .\examples\runtime-session.mjs
```

`provider-callback.mjs` registers a JSON SQLite provider callback before engine creation.

```powershell
node .\examples\provider-callback.mjs
```

Model callback integration is documented in the main [SDK README](../README.md#model-callback). The generic examples do not call a real model provider because model credentials, provider choice, budgets, and redaction policy are host-owned.

## Fixture Skill

The fixture skill is stored at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. It intentionally lives in USER so delegated-query examples can see it without System authority.

## Release Package

The repository workflow **Examples Release** creates `luaskills-sdk-typescript-examples-{VERSION}.zip` after the matching npm package is published. The workflow installs `@luaskills/sdk@{VERSION}` from npm and runs the examples before uploading the asset.

The release tag is `examples-v{VERSION}` so example assets stay separate from SDK package versions.
