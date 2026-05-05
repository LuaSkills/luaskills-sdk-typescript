import { sdk } from "./load-sdk.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { LuaSkillsClient, RuntimeRoots } = sdk;

// Absolute path for this example file.
// 当前示例文件的绝对路径。
const currentFile = fileURLToPath(import.meta.url);

// Runtime root used by the bundled fixture skill.
// 内置夹具 skill 使用的 runtime root。
const runtimeRoot = process.env.LUASKILLS_EXAMPLE_RUNTIME_ROOT ?? resolve(dirname(currentFile), "fixture-runtime");

// SDK options derived from either runtimeRoot or an explicit native library path.
// 基于 runtimeRoot 或显式原生动态库路径派生的 SDK 选项。
const sdkOptions = process.env.LUASKILLS_LIB
  ? { libraryPath: process.env.LUASKILLS_LIB, runtimeRoot }
  : { runtimeRoot };

// Formal ROOT, PROJECT, USER chain used by the example fixture.
// 示例夹具使用的正式 ROOT、PROJECT、USER root 链。
const skillRoots = RuntimeRoots.standard(runtimeRoot);

// Canonical tool name exposed by the fixture skill.
// 夹具 skill 暴露的 canonical tool 名称。
const toolName = "demo-standard-ffi-skill-ping";

// Invocation context forwarded into Lua as vulcan.context.
// 转发到 Lua 并作为 vulcan.context 暴露的调用上下文。
const invocationContext = {
  request_context: { transport_name: "typescript-sdk-example" },
  client_budget: { budget: 1 },
  tool_config: { mode: "call-demo" },
};

// High-level SDK client that owns one native LuaSkills engine.
// 拥有单个原生 LuaSkills engine 的高级 SDK client。
const client = LuaSkillsClient.create(sdkOptions);

try {
  client.loadFromRoots(skillRoots);

  // Result returned by the fixture skill entry.
  // 夹具 skill 入口返回的结果。
  const callResult = client.callSkill(toolName, { note: "typescript-call" }, invocationContext);
  console.log("Call content:", callResult.content);

  // Result returned by an inline Lua snippet.
  // 内联 Lua 片段返回的结果。
  const luaResult = client.runLua(
    "return { note = args.note, transport = vulcan.context.request.transport_name, budget = vulcan.context.client_budget.budget, mode = vulcan.context.tool_config.mode }",
    { note: "typescript-lua" },
    invocationContext,
  );
  console.log("Run Lua result:", luaResult);
} finally {
  client.close();
}
