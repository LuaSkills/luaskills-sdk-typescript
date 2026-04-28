# LuaSkills TypeScript SDK 示例

中文示例文档。英文默认文档见 [README.md](README.md)。

LuaSkills 主仓库：[LuaSkills/luaskills](https://github.com/LuaSkills/luaskills)

这些示例使用发布后的 SDK 包形态，适合复制到宿主应用中参考。

## Runtime 准备

运行示例前先安装 runtime 资产：

```powershell
npx @luaskills/sdk install-runtime --database none --runtime-root .\examples\fixture-runtime
```

如果宿主自行管理原生动态库，也可以设置 `LUASKILLS_LIB`：

```powershell
$env:LUASKILLS_LIB = "D:\runtime\luaskills\libs\luaskills.dll"
```

## 示例索引

`basic.mjs` 通过 `LuaSkillsClient.version` 查询 JSON FFI 版本。

```powershell
node .\examples\basic.mjs
```

`query.mjs` 会加载内置 USER 层夹具 skill，列出委托工具可见入口，检查 `isSkill`，解析 `skillNameForTool`，并读取 help/completion 查询面。

```powershell
node .\examples\query.mjs
```

`call.mjs` 演示带调用上下文的 `callSkill` 与 `runLua`。

```powershell
node .\examples\call.mjs
```

`lifecycle.mjs` 演示通过普通 Skills plane 执行 `disable` 与 `enable`。

```powershell
node .\examples\lifecycle.mjs
```

`provider-callback.mjs` 演示在 engine 创建前注册 JSON SQLite provider callback。

```powershell
node .\examples\provider-callback.mjs
```

## Fixture Skill

夹具 skill 位于 `examples/fixture-runtime/user_skills/demo-standard-ffi-skill`。它故意放在 USER 层，这样委托查询示例不需要 System 权限也能看到它。

## 示例发布包

仓库工作流 **Examples Release** 会在匹配的 npm 包发布后生成 `luaskills-sdk-typescript-examples-{VERSION}.zip`。工作流会从 npm 安装 `@luaskills/sdk@{VERSION}` 并运行示例，通过后再上传资产。

release tag 使用 `examples-v{VERSION}`，因此示例资产与 SDK 包版本保持分离。
