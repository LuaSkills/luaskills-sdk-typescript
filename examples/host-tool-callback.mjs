import { LuaSkillsClient, LuaSkillsJsonFfi } from "@luaskills/sdk";
import { resolve } from "node:path";

// Runtime root used by this host-tool callback example.
// 当前宿主工具 callback 示例使用的 runtime root。
const runtimeRoot = process.env.LUASKILLS_RUNTIME_ROOT ?? resolve("luaskills-runtime");

// SDK options derived from either runtimeRoot or an explicit native library path.
// 基于 runtimeRoot 或显式原生动态库路径派生的 SDK 选项。
const sdkOptions = process.env.LUASKILLS_LIB
  ? { libraryPath: process.env.LUASKILLS_LIB, runtimeRoot }
  : { runtimeRoot };

// Low-level FFI bridge that owns the process-wide host-tool callback slot.
// 持有进程级宿主工具 callback 槽位的底层 FFI 桥。
const ffi = new LuaSkillsJsonFfi(sdkOptions);

// Mock host tool metadata exposed through vulcan.host.list().
// 通过 vulcan.host.list() 暴露的 mock 宿主工具元数据。
const hostTools = [
  {
    name: "model.embed",
    description: "Mock embedding tool for SDK examples",
  },
];

// Host-tool callback that handles list, has, and call actions from Lua.
// 处理来自 Lua 的 list、has 与 call 动作的宿主工具 callback。
const hostToolCallback = (request) => {
  if (request.action === "list") {
    return hostTools;
  }
  if (request.action === "has") {
    return hostTools.some((tool) => tool.name === request.tool_name);
  }
  if (request.action === "call" && request.tool_name === "model.embed") {
    return {
      ok: true,
      value: {
        model: request.args?.model ?? "mock-embedding",
        input: request.args?.input ?? "",
        embedding: [0.1, 0.2, 0.3],
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "tool_not_found",
      message: `Unknown host tool: ${request.tool_name ?? "<missing>"}`,
    },
  };
};

// Inline Lua snippet that exercises vulcan.host.list, vulcan.host.has, and vulcan.host.call.
// 调用 vulcan.host.list、vulcan.host.has 与 vulcan.host.call 的内联 Lua 片段。
const luaCode = `
local tools = vulcan.host.list()
local result = vulcan.host.call("model.embed", {
  model = "mock-embedding",
  input = args.input,
})

return {
  tool_count = #tools,
  has_embed = vulcan.host.has("model.embed"),
  has_missing = vulcan.host.has_tool("missing.tool"),
  result = result,
}
`;

// High-level SDK client that owns one native LuaSkills engine.
// 拥有单个原生 LuaSkills engine 的高级 SDK client。
let client = null;

ffi.setHostToolJsonCallback(hostToolCallback);
try {
  client = LuaSkillsClient.create(sdkOptions);
  const luaResult = client.runLua(luaCode, { input: "hello from TypeScript" });
  console.log(JSON.stringify(luaResult, null, 2));
} finally {
  if (client) {
    client.close();
  }
  ffi.clearHostToolJsonCallback();
}
