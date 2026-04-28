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

`lifecycle.mjs` demonstrates `disable` and `enable` through the ordinary Skills plane.

```powershell
node .\examples\lifecycle.mjs
```

`provider-callback.mjs` registers a JSON SQLite provider callback before engine creation.

```powershell
node .\examples\provider-callback.mjs
```

## Fixture Skill

The fixture skill is stored at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. It intentionally lives in USER so delegated-query examples can see it without System authority.
