import { sdk } from "./load-sdk.mjs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { LuaSkillsClient } = sdk;

// Runtime root that a host may install read-only, for example inside a versioned application directory.
// 宿主可以只读安装的 runtime root，例如位于带版本的应用目录中。
const runtimeRoot = process.env.LUASKILLS_EXAMPLE_RUNTIME_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "fixture-runtime");

// Host-owned writable directory outside runtimeRoot.
// runtimeRoot 之外的宿主自有可写目录。
const writableRoot = process.env.LUASKILLS_EXAMPLE_WRITABLE_ROOT ?? mkdtempSync(join(tmpdir(), "luaskills-host-writable-"));
const tempDir = join(writableRoot, "temp");
const downloadCacheRoot = join(writableRoot, "downloads");

// The host creates temp_dir; the engine creates the download cache when it first needs it.
// 宿主创建 temp_dir；引擎在首次需要时创建下载缓存。
mkdirSync(tempDir, { recursive: true });

// preserve_host_writable_dirs keeps both paths instead of deriving them from runtimeRoot.
// preserve_host_writable_dirs 保留这两个路径，不再从 runtimeRoot 推导。
const client = LuaSkillsClient.create({
  ...(process.env.LUASKILLS_LIB ? { libraryPath: process.env.LUASKILLS_LIB } : {}),
  runtimeRoot,
  hostOptions: {
    preserve_host_writable_dirs: true,
    temp_dir: tempDir,
    download_cache_root: downloadCacheRoot,
  },
});

try {
  console.log("Lua temp_dir:", client.runLua("return vulcan.runtime.temp_dir"));
} finally {
  client.close();
}
