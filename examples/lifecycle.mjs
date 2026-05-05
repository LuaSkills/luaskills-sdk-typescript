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

// Canonical tool name exposed by the fixture skill.
// 夹具 skill 暴露的 canonical tool 名称。
const toolName = "demo-standard-ffi-skill-ping";

// Stable skill id declared by the fixture skill.yaml.
// 夹具 skill.yaml 声明的稳定 skill id。
const skillId = "demo-standard-ffi-skill";

// High-level SDK client that owns one native LuaSkills engine.
// 拥有单个原生 LuaSkills engine 的高级 SDK client。
const client = LuaSkillsClient.create(sdkOptions);

try {
  client.loadFromRoots(skillRoots);

  // Call the fixture before lifecycle changes.
  // 在生命周期变更前调用夹具。
  const before = client.callSkill(toolName, { note: "before-disable" });
  console.log("Call before disable:", before.content);

  client.skills.disable(skillRoots, skillId, "example maintenance window");
  console.log("Skill disabled:", skillId);
  console.log("Visible after disable:", client.isSkill(toolName, Authority.DelegatedTool));

  try {
    client.callSkill(toolName, { note: "after-disable" });
    throw new Error("callSkill unexpectedly succeeded while the skill was disabled");
  } catch (error) {
    // Expected failure proves the lifecycle state was applied.
    // 预期失败说明生命周期状态已经生效。
    console.log("Call after disable failed as expected:", error instanceof Error ? error.message : error);
  }

  client.skills.enable(skillRoots, skillId);
  console.log("Skill enabled:", skillId);

  // Call the fixture again after enabling it.
  // 重新启用后再次调用夹具。
  const after = client.callSkill(toolName, { note: "after-enable" });
  console.log("Call after enable:", after.content);
} finally {
  client.close();
}
