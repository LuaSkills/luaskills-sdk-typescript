import { sdk } from "./load-sdk.mjs";
import { resolve } from "node:path";

const { LuaSkillsClient, LuaSkillsJsonFfi } = sdk;

const runtimeRoot = process.env.LUASKILLS_RUNTIME_ROOT ?? resolve("luaskills-runtime");
const sdkOptions = process.env.LUASKILLS_LIB
  ? { libraryPath: process.env.LUASKILLS_LIB, runtimeRoot }
  : { runtimeRoot };
const ffi = new LuaSkillsJsonFfi(sdkOptions);

// Return a minimal host-side SQLite provider response for demo requests.
// 为演示请求返回一个最小宿主侧 SQLite provider 响应。
const sqliteProvider = (request) => ({ ok: true, request });

ffi.setSqliteProviderJsonCallback(sqliteProvider);

try {
  const client = LuaSkillsClient.create({
    ...sdkOptions,
    runtimeRoot,
    hostOptions: {
      sqlite_provider_mode: "host_callback",
      sqlite_callback_mode: "json",
    },
  });
  client.close();
  console.log("SQLite JSON provider callback registered before engine creation.");
} finally {
  ffi.clearSqliteProviderJsonCallback();
}
