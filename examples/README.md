# LuaSkills TypeScript SDK Examples

These examples use the published SDK package shape and are intended to be copied into host applications.

这些示例使用发布后的 SDK 包形态，适合复制到宿主应用中参考。

## Runtime Preparation

Install runtime assets before running examples:

运行示例前先安装 runtime 资产：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

If you already manage the native library yourself, set `LUASKILLS_LIB` instead:

如果宿主自行管理原生动态库，也可以设置 `LUASKILLS_LIB`：

```powershell
$env:LUASKILLS_LIB = "D:\runtime\luaskills\libs\luaskills.dll"
```

## Example Index

`basic.mjs` queries the JSON FFI version through `LuaSkillsClient.version`.

`basic.mjs` 通过 `LuaSkillsClient.version` 查询 JSON FFI 版本。

```powershell
node .\examples\basic.mjs
```

`query.mjs` loads the bundled USER-layer fixture skill, lists delegated-visible entries, checks `isSkill`, resolves `skillNameForTool`, and reads help/completion surfaces.

`query.mjs` 会加载内置 USER 层夹具 skill，列出委托工具可见入口，检查 `isSkill`，解析 `skillNameForTool`，并读取 help/completion 查询面。

```powershell
node .\examples\query.mjs
```

`call.mjs` demonstrates `callSkill` and `runLua` with an invocation context.

`call.mjs` 演示带调用上下文的 `callSkill` 与 `runLua`。

```powershell
node .\examples\call.mjs
```

`lifecycle.mjs` demonstrates `disable` and `enable` through the ordinary Skills plane.

`lifecycle.mjs` 演示通过普通 Skills plane 执行 `disable` 与 `enable`。

```powershell
node .\examples\lifecycle.mjs
```

`provider-callback.mjs` registers a JSON SQLite provider callback before engine creation.

`provider-callback.mjs` 演示在 engine 创建前注册 JSON SQLite provider callback。

```powershell
node .\examples\provider-callback.mjs
```

## Fixture Skill

The fixture skill is stored at `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`. It intentionally lives in USER so delegated-query examples can see it without System authority.

夹具 skill 位于 `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`。它故意放在 USER 层，这样委托查询示例不需要 System 权限也能看到它。
