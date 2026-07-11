import { sdk } from "./load-sdk.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { Authority, LuaSkillsClient, RuntimeRoots } = sdk;

// Stable session id reused by the example lease lifecycle.
// 示例租约生命周期复用的稳定会话标识。
const RUNTIME_SESSION_SID = "typescript-sdk-runtime-lease-demo";

/**
 * Resolve the fixture runtime root used by this example.
 * 解析当前示例使用的夹具 runtime root。
 */
function resolveRuntimeRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  return process.env.LUASKILLS_EXAMPLE_RUNTIME_ROOT ?? resolve(dirname(currentFile), "fixture-runtime");
}

/**
 * Resolve SDK options from one explicit library path or the fixture runtime root.
 * 基于显式动态库路径或夹具 runtime root 解析 SDK 选项。
 */
function resolveSdkOptions(runtimeRoot) {
  return process.env.LUASKILLS_LIB
    ? { libraryPath: process.env.LUASKILLS_LIB, runtimeRoot }
    : { runtimeRoot };
}

/**
 * Run one persistent runtime-lease smoke flow through the high-level SDK surface.
 * 通过高级 SDK 接口执行一条持久运行时租约烟测链路。
 */
function main() {
  const runtimeRoot = resolveRuntimeRoot();
  const skillRoots = RuntimeRoots.standard(runtimeRoot);
  // SystemPackageRoot is the trusted package root retained for the complete lease lifetime.
  // SystemPackageRoot 是在完整租约生命周期内保持可信的包根。
  const systemPackageRoot = resolve(runtimeRoot, "system_lua_lib", "runtime-lease-example");
  // SystemPackage binds the stable package identity and exact dependency manifest.
  // SystemPackage 绑定稳定包身份与精确依赖清单。
  const systemPackage = {
    id: "runtime-lease-example",
    root: systemPackageRoot,
    dependencies_file: "dependencies.json",
  };
  const client = LuaSkillsClient.create(resolveSdkOptions(runtimeRoot));

  try {
    client.loadFromRoots(skillRoots);

    const system = client.system(Authority.System);
    console.log("Visible entry count:", system.listEntries().length);
    console.log(
      "Visible skill ownership:",
      system.skillNameForTool("demo-standard-ffi-skill-ping"),
    );

    const sessions = system.runtimeLeases();
    console.log(
      "Uses dedicated system runtime-lease endpoints:",
      sessions.usesSystemRuntimeLeaseEndpoints(),
    );

    const session = sessions.createHandle(RUNTIME_SESSION_SID, 600, true, {
      cwd: systemPackageRoot,
      mounts: { example: "typescript-runtime-lease" },
      system_package: systemPackage,
    });
    const identity = session.identityPayload();
    console.log("Lease created:", identity.lease_id);
    console.log("Lease handle count:", sessions.listHandles(RUNTIME_SESSION_SID).length);

    const opened = session.eval(
      `
local info = vulcan.os.info()
if not proc then
  local spec
  if info.os == "windows" then
    spec = {
      program = "cmd",
      args = { "/V:ON", "/C", "set /P line=&echo session:!line!" },
      encoding = "utf-8",
    }
  else
    spec = {
      program = "sh",
      args = { "-c", "read line; echo session:$line" },
      encoding = "utf-8",
    }
  end
  proc = vulcan.process.session.open(spec)
end
counter = (counter or 0) + 1
proc:write((args.input or "runtime-lease-demo") .. "\\n")
return {
  opened = true,
  counter = counter,
  input = args.input,
}
`,
      {
        input: "runtime-lease-demo",
      },
    );
    console.log("Open eval result:", opened.result);

    const readOutput = session.eval(
      `
counter = (counter or 0) + 1
local output = proc:read({ timeout_ms = 2000, max_bytes = 8192 })
return {
  counter = counter,
  stdout = output.stdout,
  stderr = output.stderr,
  timed_out = output.timed_out,
}
`,
    );
    console.log("Read eval result:", readOutput.result);

    console.log("Lease status result:", session.status());

    const closedProcess = session.eval(
      `
counter = (counter or 0) + 1
local status = proc:close({ timeout_ms = 3000 })
proc = nil
return {
  counter = counter,
  exited = status.exited,
  success = status.success,
}
`,
    );
    console.log("Close process eval result:", closedProcess.result);

    console.log("Lease close result:", session.close());
    console.log(
      "Post-close eval result:",
      sessions.callRaw("eval", {
        lease_id: identity.lease_id,
        sid: identity.sid,
        generation: identity.generation,
        timeout_ms: 60_000,
        args: {},
        code: "return 1",
      }),
    );
  } finally {
    client.close();
  }
}

main();
