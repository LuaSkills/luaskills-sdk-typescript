import { sdk } from "./load-sdk.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Authority, LuaSkillsClient, RuntimeRoots } = sdk;

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

// High-level SDK client that owns one native LuaSkills engine.
// 拥有单个原生 LuaSkills engine 的高级 SDK client。
const client = LuaSkillsClient.create(sdkOptions);

try {
  client.loadFromRoots(skillRoots);

  // Entries visible to delegated tools; fixture skill lives in USER.
  // 委托工具可见的入口；夹具 skill 位于 USER 层。
  const entries = client.listEntries(Authority.DelegatedTool);
  console.log("Entry count:", entries.length);

  // Canonical tool name exposed by the fixture skill.
  // 夹具 skill 暴露的 canonical tool 名称。
  const toolName = "demo-standard-ffi-skill-ping";

  // Whether the selected authority can see the fixture tool.
  // 所选权限是否可见夹具 tool。
  const visible = client.isSkill(toolName, Authority.DelegatedTool);
  console.log("Is delegated-visible skill:", visible);

  // Owning skill id resolved from the canonical tool name.
  // 从 canonical tool 名称解析出的所属 skill id。
  const skillId = client.skillNameForTool(toolName, Authority.DelegatedTool);
  console.log("Owning skill id:", skillId);

  // Completion values currently exposed by the runtime.
  // 当前 runtime 暴露的补全值。
  const completions = client.promptArgumentCompletions(toolName, "note", Authority.DelegatedTool) ?? [];
  console.log("Prompt completion count:", completions.length);

  // Help descriptors visible to delegated tools.
  // 委托工具可见的帮助描述。
  const help = client.listSkillHelp(Authority.DelegatedTool);
  console.log("Help tree count:", help.length);
} finally {
  client.close();
}
