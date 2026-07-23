import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix as posixPath, relative, resolve, win32 as winPath } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import type { LuaRuntimeHostOptions } from "./types.js";

/**
 * Strict SHA-256 hexadecimal digest pattern used for downloaded runtime assets.
 * 下载运行时资产使用的严格 SHA-256 十六进制摘要模式。
 */
const SHA256_HEX_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Strict SHA-512 Base64 digest pattern used for npm integrity strings.
 * npm integrity 字符串使用的严格 SHA-512 Base64 摘要模式。
 */
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Default LuaSkills release tag used by SDK runtime installation.
 * SDK 运行时安装使用的默认 LuaSkills 发布标签。
 */
export const DEFAULT_LUASKILLS_VERSION = "v0.5.4";

/**
 * Default luaskills-packages release series used by SDK runtime installation.
 * SDK 运行时安装使用的默认 luaskills-packages 发布协议线。
 */
export const DEFAULT_LUASKILLS_PACKAGES_SERIES = "0.1";

/**
 * Default vldb-controller release tag used by SDK runtime installation.
 * SDK 运行时安装使用的默认 vldb-controller 发布标签。
 */
export const DEFAULT_VLDB_CONTROLLER_VERSION = "v0.2.3";

/**
 * Default vldb-sqlite release tag used by SDK runtime installation.
 * SDK 运行时安装使用的默认 vldb-sqlite 发布标签。
 */
export const DEFAULT_VLDB_SQLITE_VERSION = "v0.1.6";

/**
 * Default vldb-lancedb release tag used by SDK runtime installation.
 * SDK 运行时安装使用的默认 vldb-lancedb 发布标签。
 */
export const DEFAULT_VLDB_LANCEDB_VERSION = "v0.1.5";

/**
 * Default managed CPython version installed for Lua-driven child runtimes.
 * Lua 调度子运行时安装使用的默认受管 CPython 版本。
 */
export const DEFAULT_MANAGED_PYTHON_VERSION = "3.14.6";

/**
 * Default standalone uv version used to install managed Python environments.
 * 安装受管 Python 环境使用的默认独立 uv 版本。
 */
export const DEFAULT_MANAGED_UV_VERSION = "0.11.28";

/**
 * Default managed Node.js version installed for Lua-driven child runtimes.
 * Lua 调度子运行时安装使用的默认受管 Node.js 版本。
 */
export const DEFAULT_MANAGED_NODE_VERSION = "24.18.0";

/**
 * Default pnpm version used to install managed Node.js dependencies.
 * 安装受管 Node.js 依赖使用的默认 pnpm 版本。
 */
export const DEFAULT_MANAGED_PNPM_VERSION = "11.11.0";

/**
 * Manifest file name written into the runtime resources directory.
 * 写入 runtime resources 目录的清单文件名。
 */
export const RUNTIME_MANIFEST_FILE_NAME = "luaskills-sdk-runtime-manifest.json";

/**
 * Database integration preset selected by SDK users.
 * SDK 用户选择的数据库集成预设。
 */
export enum RuntimeDatabasePreset {
  /**
   * Do not install or configure database providers.
   * 不安装也不配置数据库 provider。
   */
  None = "none",
  /**
   * Use the shared vldb-controller executable through space_controller mode.
   * 通过 space_controller 模式使用共享 vldb-controller 可执行文件。
   */
  VldbController = "vldb-controller",
  /**
   * Use vldb-sqlite-lib and vldb-lancedb-lib dynamic libraries directly.
   * 直接使用 vldb-sqlite-lib 与 vldb-lancedb-lib 动态库。
   */
  VldbDirect = "vldb-direct",
  /**
   * Let the host provide JSON callbacks instead of native VLDB assets.
   * 由宿主提供 JSON callback，而不是安装原生 VLDB 资产。
   */
  HostCallback = "host-callback",
}

/**
 * Runtime asset role inside one installation manifest.
 * 安装清单中的运行时资产角色。
 */
export type RuntimeAssetRole = "lua_runtime" | "luaskills_ffi" | "vldb_controller" | "vldb_sqlite_lib" | "vldb_lancedb_lib";

/**
 * Managed child runtime group selected by SDK installation.
 * SDK 安装时选择的受管子运行时分组。
 */
export type ManagedRuntimeTarget = "none" | "all" | "python" | "node" | "package-managers";

/**
 * Supported platform descriptor used by release asset names.
 * 发布资产命名使用的受支持平台描述。
 */
export interface RuntimePlatformTarget {
  /**
   * LuaSkills platform key used by luaskills-ffi-sdk archives.
   * luaskills-ffi-sdk 归档使用的 LuaSkills 平台标识。
   */
  platform_key: string;
  /**
   * Rust-style target triple used by VLDB release archives.
   * VLDB 发布归档使用的 Rust 风格 target triple。
   */
  target_triple: string;
  /**
   * Archive extension used by this platform.
   * 当前平台使用的归档扩展名。
   */
  archive_ext: ".tar.gz" | ".zip";
  /**
   * vldb-controller executable file name inside the archive.
   * 归档内的 vldb-controller 可执行文件名。
   */
  controller_binary_name: string;
  /**
   * Dynamic library file extension used by this platform.
   * 当前平台使用的动态库文件扩展名。
   */
  dynamic_library_ext: ".dll" | ".so" | ".dylib";
  /**
   * Expected LuaSkills dynamic library file name after installation.
   * 安装后的预期 LuaSkills 动态库文件名。
   */
  luaskills_library_name: string;
  /**
   * Expected SQLite dynamic library file name after installation.
   * 安装后的预期 SQLite 动态库文件名。
   */
  sqlite_library_name: string;
  /**
   * Expected LanceDB dynamic library file name after installation.
   * 安装后的预期 LanceDB 动态库文件名。
   */
  lancedb_library_name: string;
}

/**
 * One GitHub Release asset needed by an SDK runtime installation.
 * SDK 运行时安装所需的单个 GitHub Release 资产。
 */
export interface RuntimeAssetDescriptor {
  /**
   * Logical asset role.
   * 逻辑资产角色。
   */
  role: RuntimeAssetRole;
  /**
   * GitHub repository in owner/name form.
   * owner/name 形式的 GitHub 仓库。
   */
  repository: string;
  /**
   * Release tag used by this asset.
   * 当前资产使用的发布标签。
   */
  version: string;
  /**
   * Exact release asset file name.
   * 精确的发布资产文件名。
   */
  asset_name: string;
  /**
   * Exact SHA-256 sidecar asset file name.
   * 精确的 SHA-256 旁路校验资产文件名。
   */
  sha256_asset_name: string;
  /**
   * Browser download URL for the archive.
   * 归档的浏览器下载地址。
   */
  download_url: string;
  /**
   * Browser download URL for the SHA-256 sidecar.
   * SHA-256 旁路文件的浏览器下载地址。
   */
  sha256_url: string;
  /**
   * Relative path where the installed executable, library, or marker file should live.
   * 已安装可执行文件、动态库或标记文件应位于的相对路径。
   */
  installed_path: string | null;
}

/**
 * Runtime installation manifest shared by all SDK languages.
 * 所有 SDK 语言共享的运行时安装清单。
 */
export interface RuntimeInstallManifest {
  /**
   * Manifest schema version.
   * 清单结构版本。
   */
  schema_version: 1;
  /**
   * ISO timestamp when the manifest was generated.
   * 生成清单时的 ISO 时间戳。
   */
  generated_at: string;
  /**
   * Absolute runtime root represented by the manifest.
   * 清单表示的绝对 runtime root。
   */
  runtime_root: string;
  /**
   * Selected database integration mode.
   * 选中的数据库集成模式。
   */
  database_mode: RuntimeDatabasePreset | `${RuntimeDatabasePreset}`;
  /**
   * Platform target used by every asset in this manifest.
   * 当前清单中所有资产使用的平台目标。
   */
  platform: RuntimePlatformTarget;
  /**
   * Assets required by the selected mode.
   * 选中模式所需的资产列表。
   */
  assets: RuntimeAssetDescriptor[];
  /**
   * Host option patch derived from installed runtime assets.
   * 从已安装运行时资产派生的宿主选项补丁。
   */
  host_options_patch: Partial<LuaRuntimeHostOptions>;
  /**
   * Planned or installed managed Python and Node.js child runtimes.
   * 已规划或已安装的受管 Python 与 Node.js 子运行时。
   */
  managed_runtimes?: ManagedRuntimeInstallPlan | null;
}

/**
 * Options used to build or install one SDK runtime asset set.
 * 构造或安装一组 SDK 运行时资产使用的选项。
 */
export interface RuntimeInstallOptions {
  /**
   * Runtime root that receives native assets and the manifest.
   * 接收原生资产与清单的 runtime root。
   */
  runtimeRoot: string;
  /**
   * Selected database integration mode.
   * 选中的数据库集成模式。
   */
  database?: RuntimeDatabasePreset | `${RuntimeDatabasePreset}`;
  /**
   * LuaSkills release tag.
   * LuaSkills 发布标签。
   */
  luaskillsVersion?: string;
  /**
   * Runtime packages release tag published by luaskills-packages.
   * luaskills-packages 发布的 runtime packages 标签。
   */
  luaRuntimeVersion?: string;
  /**
   * Runtime packages release series published by luaskills-packages.
   * luaskills-packages 发布的 runtime packages 协议线。
   */
  luaRuntimeSeries?: string;
  /**
   * vldb-controller release tag.
   * vldb-controller 发布标签。
   */
  vldbControllerVersion?: string;
  /**
   * vldb-sqlite release tag.
   * vldb-sqlite 发布标签。
   */
  vldbSqliteVersion?: string;
  /**
   * vldb-lancedb release tag.
   * vldb-lancedb 发布标签。
   */
  vldbLancedbVersion?: string;
  /**
   * Whether the LuaSkills FFI SDK archive should be included.
   * 是否包含 LuaSkills FFI SDK 归档。
   */
  includeLuaSkillsFfi?: boolean;
  /**
   * Whether the Lua runtime archive should be included.
   * 是否包含 Lua runtime 归档。
   */
  includeLuaRuntime?: boolean;
  /**
   * GitHub repository that publishes LuaSkills assets.
   * 发布 LuaSkills 资产的 GitHub 仓库。
   */
  luaskillsRepo?: string;
  /**
   * GitHub repository that publishes runtime packages assets.
   * 发布 runtime packages 资产的 GitHub 仓库。
   */
  luaRuntimeRepo?: string;
  /**
   * GitHub repository that publishes vldb-controller assets.
   * 发布 vldb-controller 资产的 GitHub 仓库。
   */
  vldbControllerRepo?: string;
  /**
   * GitHub repository that publishes vldb-sqlite assets.
   * 发布 vldb-sqlite 资产的 GitHub 仓库。
   */
  vldbSqliteRepo?: string;
  /**
   * GitHub repository that publishes vldb-lancedb assets.
   * 发布 vldb-lancedb 资产的 GitHub 仓库。
   */
  vldbLancedbRepo?: string;
  /**
   * Managed child runtime group to install under runtimeRoot/dependencies.
   * 安装到 runtimeRoot/dependencies 下的受管子运行时分组。
   */
  managedRuntimes?: ManagedRuntimeTarget;
  /**
   * Managed CPython version.
   * 受管 CPython 版本。
   */
  managedPythonVersion?: string;
  /**
   * Managed uv package-manager version.
   * 受管 uv 包管理器版本。
   */
  managedUvVersion?: string;
  /**
   * Managed Node.js version.
   * 受管 Node.js 版本。
   */
  managedNodeVersion?: string;
  /**
   * Managed pnpm package-manager version.
   * 受管 pnpm 包管理器版本。
   */
  managedPnpmVersion?: string;
  /**
   * Whether existing managed runtime directories should be replaced.
   * 是否替换已存在的受管运行时目录。
   */
  forceManagedRuntimes?: boolean;
}

/**
 * Managed runtime platform descriptor used by Python, uv, Node.js, and pnpm installers.
 * Python、uv、Node.js 与 pnpm 安装器使用的受管运行时平台描述。
 */
export interface ManagedRuntimePlatformTarget {
  /**
   * Stable LuaSkills managed-runtime platform key.
   * 稳定的 LuaSkills 受管运行时平台键。
   */
  platform_key: string;
  /**
   * uv release asset name for this platform.
   * 当前平台对应的 uv 发布资产名。
   */
  uv_asset_name: string;
  /**
   * Node.js release asset template.
   * Node.js 发布资产模板。
   */
  node_asset_template: string;
  /**
   * Node.js archive top-level directory template.
   * Node.js 归档顶层目录模板。
   */
  node_extract_template: string;
  /**
   * Relative uv executable path.
   * uv 可执行文件相对路径。
   */
  uv_executable: string;
  /**
   * Relative Node.js executable path.
   * Node.js 可执行文件相对路径。
   */
  node_executable: string;
}

/**
 * SDK manifest section describing managed child runtime installation.
 * 描述受管子运行时安装的 SDK 清单片段。
 */
export interface ManagedRuntimeInstallPlan {
  /**
   * Requested managed runtime target group.
   * 请求的受管运行时目标分组。
   */
  target: ManagedRuntimeTarget;
  /**
   * Platform metadata used by managed runtime assets.
   * 受管运行时资产使用的平台元数据。
   */
  platform: ManagedRuntimePlatformTarget;
  /**
   * Managed Python version.
   * 受管 Python 版本。
   */
  python_version: string;
  /**
   * Managed uv version.
   * 受管 uv 版本。
   */
  uv_version: string;
  /**
   * Managed Node.js version.
   * 受管 Node.js 版本。
   */
  node_version: string;
  /**
   * Managed pnpm version.
   * 受管 pnpm 版本。
   */
  pnpm_version: string;
  /**
   * Relative installation paths under runtime_root.
   * runtime_root 下的相对安装路径。
   */
  installed_paths: Record<string, string>;
}

/**
 * Return the runtime platform target for the current Node.js process.
 * 返回当前 Node.js 进程对应的运行时平台目标。
 */
export function resolveRuntimePlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): RuntimePlatformTarget {
  if (platform === "win32" && arch === "x64") {
    return {
      platform_key: "windows-x64",
      target_triple: "x86_64-pc-windows-msvc",
      archive_ext: ".zip",
      controller_binary_name: "vldb-controller.exe",
      dynamic_library_ext: ".dll",
      luaskills_library_name: "luaskills.dll",
      sqlite_library_name: "vldb_sqlite.dll",
      lancedb_library_name: "vldb_lancedb.dll",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return darwinTarget("x86_64", "macos-x64");
  }
  if (platform === "darwin" && arch === "arm64") {
    return darwinTarget("aarch64", "macos-arm64");
  }
  if (platform === "linux" && arch === "x64") {
    return linuxTarget("x86_64", "linux-x64");
  }
  if (platform === "linux" && arch === "arm64") {
    return linuxTarget("aarch64", "linux-arm64");
  }
  throw new Error(`Unsupported runtime platform: ${platform}/${arch}`);
}

/**
 * Build one deterministic runtime installation manifest.
 * 构造一个确定性的运行时安装清单。
 */
export function buildRuntimeInstallManifest(options: RuntimeInstallOptions): RuntimeInstallManifest {
  const runtimeRoot = resolve(options.runtimeRoot);
  const database = normalizeDatabasePreset(options.database ?? RuntimeDatabasePreset.None);
  const platform = resolveRuntimePlatformTarget();
  const resolvedLuaRuntimeVersion = options.luaRuntimeVersion
    ?? resolveLatestReleaseTagForSeriesSync(
      options.luaRuntimeRepo ?? "LuaSkills/luaskills-packages",
      options.luaRuntimeSeries ?? DEFAULT_LUASKILLS_PACKAGES_SERIES,
    );
  const assets = buildRuntimeAssetDescriptors({ ...options, database, runtimeRoot, luaRuntimeVersion: resolvedLuaRuntimeVersion }, platform);
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runtime_root: runtimeRoot,
    database_mode: database,
    platform,
    assets,
    host_options_patch: buildHostOptionsPatch(runtimeRoot, database, platform, assets),
    managed_runtimes: buildManagedRuntimeInstallPlan(options, runtimeRoot),
  };
}

/**
 * Install native runtime assets and write the shared manifest.
 * 安装原生运行时资产并写入共享清单。
 */
export async function installRuntimeAssets(options: RuntimeInstallOptions): Promise<RuntimeInstallManifest> {
  const manifest = buildRuntimeInstallManifest(options);
  await ensureRuntimeDirectories(manifest.runtime_root);
  const temporaryRoot = join(tmpdir(), `luaskills-runtime-assets-${process.pid}-${Date.now()}`);
  await mkdir(temporaryRoot, { recursive: true });
  try {
    for (const asset of manifest.assets) {
      await installOneAsset(manifest.runtime_root, asset, temporaryRoot, manifest.platform);
    }
    if (manifest.managed_runtimes && manifest.managed_runtimes.target !== "none") {
      await installManagedRuntimes(manifest.runtime_root, manifest.managed_runtimes, options.forceManagedRuntimes ?? false);
    }
    const refreshedManifest = refreshHostOptionsPatch(manifest);
    await writeRuntimeInstallManifest(refreshedManifest);
    return refreshedManifest;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Write one runtime install manifest into the runtime resources directory.
 * 将单个运行时安装清单写入 runtime resources 目录。
 */
export async function writeRuntimeInstallManifest(manifest: RuntimeInstallManifest): Promise<string> {
  const manifestPath = runtimeManifestPath(manifest.runtime_root);
  await mkdir(resolve(manifest.runtime_root, "resources"), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

/**
 * Load one runtime install manifest from the runtime resources directory.
 * 从 runtime resources 目录加载单个运行时安装清单。
 */
export async function loadRuntimeInstallManifest(runtimeRoot: string): Promise<RuntimeInstallManifest | null> {
  const manifestPath = runtimeManifestPath(runtimeRoot);
  try {
    const raw = await readFile(manifestPath, "utf8");
    return decodeRuntimeInstallManifest(manifestPath, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Load one runtime install manifest synchronously when SDK defaults need it.
 * 在 SDK 默认值需要时同步加载单个运行时安装清单。
 */
export function loadRuntimeInstallManifestSync(runtimeRoot: string): RuntimeInstallManifest | null {
  const manifestPath = runtimeManifestPath(runtimeRoot);
  try {
    return decodeRuntimeInstallManifest(manifestPath, readFileSync(manifestPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Return the absolute runtime manifest path for one runtime root.
 * 返回单个 runtime root 对应的绝对运行时清单路径。
 */
export function runtimeManifestPath(runtimeRoot: string): string {
  return resolve(runtimeRoot, "resources", RUNTIME_MANIFEST_FILE_NAME);
}

/**
 * Decode one runtime install manifest with path-aware diagnostics.
 * 使用带路径上下文的诊断解码单个运行时安装清单。
 */
export function decodeRuntimeInstallManifest(manifestPath: string, raw: string): RuntimeInstallManifest {
  if (raw.trim() === "") {
    throw new Error(`runtime install manifest ${manifestPath} is empty`);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`runtime install manifest ${manifestPath} is invalid JSON: ${errorMessage(error)}`);
  }
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error(`runtime install manifest ${manifestPath} must be one JSON object`);
  }
  return manifest as RuntimeInstallManifest;
}

/**
 * Convert one runtime manifest into host option overrides.
 * 将单个运行时清单转换为宿主选项覆盖。
 */
export function hostOptionsFromRuntimeManifest(manifest: RuntimeInstallManifest): Partial<LuaRuntimeHostOptions> {
  return sanitizeRuntimeManifestHostOptions(manifest.runtime_root, manifest.host_options_patch ?? {}) as Partial<LuaRuntimeHostOptions>;
}

/**
 * Validate runtime-root path fields from one manifest host option patch.
 * 校验单个 manifest 宿主选项补丁中受 runtime-root 约束的路径字段。
 */
export function sanitizeRuntimeManifestHostOptions(runtimeRoot: string, patch: unknown): Record<string, unknown> {
  if (typeof runtimeRoot !== "string" || !runtimeRoot.trim()) {
    throw new Error("runtime manifest runtime_root must be a string path");
  }
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new Error("host_options_patch must be one object");
  }
  const sanitized: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const key of ["sqlite_library_path", "lancedb_library_path"]) {
    const sanitizedPath = sanitizeRuntimeManifestPath(runtimeRoot, sanitized[key], key);
    if (sanitizedPath !== null) {
      sanitized[key] = sanitizedPath;
    }
  }
  if ("space_controller" in sanitized && sanitized.space_controller !== null && sanitized.space_controller !== undefined) {
    if (typeof sanitized.space_controller !== "object" || Array.isArray(sanitized.space_controller)) {
      throw new Error("host_options_patch.space_controller must be one object");
    }
    const spaceController = { ...(sanitized.space_controller as Record<string, unknown>) };
    const sanitizedPath = sanitizeRuntimeManifestPath(runtimeRoot, spaceController.executable_path, "space_controller.executable_path");
    if (sanitizedPath !== null) {
      spaceController.executable_path = sanitizedPath;
    }
    sanitized.space_controller = spaceController;
  }
  return sanitized;
}

/**
 * Validate one runtime-root-scoped host option path.
 * 校验单个受 runtime-root 约束的宿主选项路径。
 */
export function sanitizeRuntimeManifestPath(runtimeRoot: string, value: unknown, context: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`host_options_patch.${context} must be a string path`);
  }
  if (value.trim() === "" || value.includes("\0")) {
    throw new Error(`host_options_patch.${context} must be a path inside runtime root`);
  }
  const rootPath = resolve(runtimeRoot);
  let candidatePath = value;
  if (isAbsolute(value) || winPath.isAbsolute(value)) {
    candidatePath = resolve(value);
  } else {
    validateManagedRuntimeRelativePath(value, `host_options_patch.${context}`);
    candidatePath = resolve(rootPath, value);
  }
  ensurePathInsideRoot(rootPath, candidatePath, `host_options_patch.${context}`, value);
  ensureExistingPathInsideRoot(rootPath, candidatePath, `host_options_patch.${context}`, value);
  return candidatePath;
}

/**
 * Resolve an installed LuaSkills dynamic library from one runtime root.
 * 从单个 runtime root 解析已安装的 LuaSkills 动态库。
 */
export function resolveLuaSkillsLibraryPathFromRuntime(runtimeRoot: string, platform: RuntimePlatformTarget = resolveRuntimePlatformTarget()): string | null {
  const libsDir = resolve(runtimeRoot, "libs");
  const candidates = luaSkillsLibraryCandidates(platform);
  for (const candidate of candidates) {
    const candidatePath = resolve(libsDir, candidate);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  return null;
}

/**
 * Normalize one database preset string.
 * 归一化单个数据库预设字符串。
 */
export function normalizeDatabasePreset(value: RuntimeDatabasePreset | `${RuntimeDatabasePreset}`): RuntimeDatabasePreset {
  if (value === RuntimeDatabasePreset.None) {
    return RuntimeDatabasePreset.None;
  }
  if (value === RuntimeDatabasePreset.VldbController) {
    return RuntimeDatabasePreset.VldbController;
  }
  if (value === RuntimeDatabasePreset.VldbDirect) {
    return RuntimeDatabasePreset.VldbDirect;
  }
  if (value === RuntimeDatabasePreset.HostCallback) {
    return RuntimeDatabasePreset.HostCallback;
  }
  throw new Error(`Unsupported database preset: ${value}`);
}

/**
 * Normalize one managed runtime target string.
 * 归一化单个受管运行时目标字符串。
 */
export function normalizeManagedRuntimeTarget(value: ManagedRuntimeTarget | string | undefined): ManagedRuntimeTarget {
  const normalized = value ?? "none";
  if (normalized === "none" || normalized === "all" || normalized === "python" || normalized === "node" || normalized === "package-managers") {
    return normalized;
  }
  throw new Error(`Unsupported managed runtime target: ${value}`);
}

/**
 * Return the managed runtime platform target for the current Node.js process.
 * 返回当前 Node.js 进程对应的受管运行时平台目标。
 */
export function resolveManagedRuntimePlatformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): ManagedRuntimePlatformTarget {
  if (platform === "win32" && arch === "x64") {
    return {
      platform_key: "windows-x64",
      uv_asset_name: "uv-x86_64-pc-windows-msvc.zip",
      node_asset_template: "node-v{version}-win-x64.zip",
      node_extract_template: "node-v{version}-win-x64",
      uv_executable: "uv.exe",
      node_executable: "node.exe",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return managedUnixTarget("macos-x64", "x86_64", "x64", "darwin", ".tar.gz");
  }
  if (platform === "darwin" && arch === "arm64") {
    return managedUnixTarget("macos-arm64", "aarch64", "arm64", "darwin", ".tar.gz");
  }
  if (platform === "linux" && arch === "x64") {
    return managedUnixTarget("linux-x64", "x86_64", "x64", "linux", ".tar.xz");
  }
  if (platform === "linux" && arch === "arm64") {
    return managedUnixTarget("linux-arm64", "aarch64", "arm64", "linux", ".tar.xz");
  }
  throw new Error(`Unsupported managed runtime platform: ${platform}/${arch}`);
}

/**
 * Build one managed runtime installation plan for the SDK manifest.
 * 为 SDK 清单构造一个受管运行时安装计划。
 */
function buildManagedRuntimeInstallPlan(options: RuntimeInstallOptions, runtimeRoot: string): ManagedRuntimeInstallPlan | null {
  const target = normalizeManagedRuntimeTarget(options.managedRuntimes);
  if (target === "none") {
    return null;
  }
  const platform = resolveManagedRuntimePlatformTarget();
  const pythonVersion = options.managedPythonVersion ?? DEFAULT_MANAGED_PYTHON_VERSION;
  const uvVersion = options.managedUvVersion ?? DEFAULT_MANAGED_UV_VERSION;
  const nodeVersion = options.managedNodeVersion ?? DEFAULT_MANAGED_NODE_VERSION;
  const pnpmVersion = options.managedPnpmVersion ?? DEFAULT_MANAGED_PNPM_VERSION;
  return {
    target,
    platform,
    python_version: pythonVersion,
    uv_version: uvVersion,
    node_version: nodeVersion,
    pnpm_version: pnpmVersion,
    installed_paths: managedRuntimeInstalledPaths(runtimeRoot, platform, pythonVersion, uvVersion, nodeVersion, pnpmVersion),
  };
}

/**
 * Build one Unix-like managed runtime target descriptor.
 * 构造一个类 Unix 受管运行时目标描述。
 */
function managedUnixTarget(
  platformKey: string,
  rustArch: "x86_64" | "aarch64",
  nodeArch: "x64" | "arm64",
  nodeOs: "darwin" | "linux",
  nodeArchiveExt: ".tar.gz" | ".tar.xz",
): ManagedRuntimePlatformTarget {
  const uvOs = nodeOs === "darwin" ? "apple-darwin" : "unknown-linux-gnu";
  return {
    platform_key: platformKey,
    uv_asset_name: `uv-${rustArch}-${uvOs}.tar.gz`,
    node_asset_template: `node-v{version}-${nodeOs}-${nodeArch}${nodeArchiveExt}`,
    node_extract_template: `node-v{version}-${nodeOs}-${nodeArch}`,
    uv_executable: "uv",
    node_executable: "bin/node",
  };
}

/**
 * Build one macOS runtime platform descriptor.
 * 构造单个 macOS 运行时平台描述。
 */
function darwinTarget(archPrefix: "x86_64" | "aarch64", platformKey: string): RuntimePlatformTarget {
  return {
    platform_key: platformKey,
    target_triple: `${archPrefix}-apple-darwin`,
    archive_ext: ".tar.gz",
    controller_binary_name: "vldb-controller",
    dynamic_library_ext: ".dylib",
    luaskills_library_name: "libluaskills.dylib",
    sqlite_library_name: "libvldb_sqlite.dylib",
    lancedb_library_name: "libvldb_lancedb.dylib",
  };
}

/**
 * Build one Linux runtime platform descriptor.
 * 构造单个 Linux 运行时平台描述。
 */
function linuxTarget(archPrefix: "x86_64" | "aarch64", platformKey: string): RuntimePlatformTarget {
  return {
    platform_key: platformKey,
    target_triple: `${archPrefix}-unknown-linux-gnu`,
    archive_ext: ".tar.gz",
    controller_binary_name: "vldb-controller",
    dynamic_library_ext: ".so",
    luaskills_library_name: "libluaskills.so",
    sqlite_library_name: "libvldb_sqlite.so",
    lancedb_library_name: "libvldb_lancedb.so",
  };
}

/**
 * Build every asset descriptor required by one manifest.
 * 构造单个清单所需的全部资产描述。
 */
function buildRuntimeAssetDescriptors(options: RuntimeInstallOptions & { database: RuntimeDatabasePreset; runtimeRoot: string }, platform: RuntimePlatformTarget): RuntimeAssetDescriptor[] {
  const assets: RuntimeAssetDescriptor[] = [];
  if (options.includeLuaRuntime ?? true) {
    const assetName = `lua-runtime-packages-${platform.platform_key}.tar.gz`;
    assets.push(
      releaseAsset(
        "lua_runtime",
        options.luaRuntimeRepo ?? "LuaSkills/luaskills-packages",
        options.luaRuntimeVersion!,
        assetName,
        "resources/lua-runtime-manifest.json",
      ),
    );
  }
  if (options.includeLuaSkillsFfi ?? true) {
    const assetName = `luaskills-ffi-sdk-${platform.platform_key}.tar.gz`;
    assets.push(releaseAsset("luaskills_ffi", options.luaskillsRepo ?? "LuaSkills/luaskills", options.luaskillsVersion ?? DEFAULT_LUASKILLS_VERSION, assetName, `libs/${platform.luaskills_library_name}`));
  }
  if (options.database === RuntimeDatabasePreset.VldbController) {
    const assetName = `vldb-controller-${options.vldbControllerVersion ?? DEFAULT_VLDB_CONTROLLER_VERSION}-${platform.target_triple}${platform.archive_ext}`;
    assets.push(releaseAsset("vldb_controller", options.vldbControllerRepo ?? "OpenVulcan/vldb-controller", options.vldbControllerVersion ?? DEFAULT_VLDB_CONTROLLER_VERSION, assetName, `bin/${platform.controller_binary_name}`));
  }
  if (options.database === RuntimeDatabasePreset.VldbDirect) {
    const sqliteAsset = `vldb-sqlite-lib-${options.vldbSqliteVersion ?? DEFAULT_VLDB_SQLITE_VERSION}-${platform.target_triple}${platform.archive_ext}`;
    const lancedbAsset = `vldb-lancedb-lib-${options.vldbLancedbVersion ?? DEFAULT_VLDB_LANCEDB_VERSION}-${platform.target_triple}${platform.archive_ext}`;
    assets.push(releaseAsset("vldb_sqlite_lib", options.vldbSqliteRepo ?? "OpenVulcan/vldb-sqlite", options.vldbSqliteVersion ?? DEFAULT_VLDB_SQLITE_VERSION, sqliteAsset, `libs/${platform.sqlite_library_name}`));
    assets.push(releaseAsset("vldb_lancedb_lib", options.vldbLancedbRepo ?? "OpenVulcan/vldb-lancedb", options.vldbLancedbVersion ?? DEFAULT_VLDB_LANCEDB_VERSION, lancedbAsset, `libs/${platform.lancedb_library_name}`));
  }
  return assets;
}

/**
 * Build one release asset descriptor from exact naming inputs.
 * 从精确命名输入构造单个发布资产描述。
 */
function releaseAsset(role: RuntimeAssetRole, repository: string, version: string, assetName: string, installedPath: string | null): RuntimeAssetDescriptor {
  const encodedAssetName = encodeURIComponent(assetName);
  const baseUrl = `https://github.com/${repository}/releases/download/${version}/${encodedAssetName}`;
  return {
    role,
    repository,
    version,
    asset_name: assetName,
    sha256_asset_name: `${assetName}.sha256`,
    download_url: baseUrl,
    sha256_url: `${baseUrl}.sha256`,
    installed_path: installedPath,
  };
}

/**
 * Resolve the newest published release tag inside one semantic-version series.
 * 解析单个语义化版本协议线中的最新已发布标签。
 */
function resolveLatestReleaseTagForSeriesSync(repository: string, series: string): string {
  const apiScript = `
const https = require("node:https");
const repository = process.argv[1];
const series = process.argv[2];
const [majorText, minorText] = series.split(".");
const major = Number.parseInt(majorText, 10);
const minor = Number.parseInt(minorText, 10);
if (!Number.isFinite(major) || !Number.isFinite(minor)) {
  console.error("Invalid release series: " + series);
  process.exit(2);
}
const request = https.get(
  "https://api.github.com/repos/" + repository + "/releases?per_page=100",
  {
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "luaskills-sdk-typescript",
    },
  },
  (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => {
      if (response.statusCode !== 200) {
        console.error("GitHub releases API returned " + response.statusCode + " for " + repository);
        process.exit(3);
      }
      const releases = JSON.parse(body);
      const candidates = releases
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) => {
          const tag = String(release.tag_name || "");
          const match = /^v?(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(tag);
          if (!match) {
            return null;
          }
          const parsedMajor = Number.parseInt(match[1], 10);
          const parsedMinor = Number.parseInt(match[2], 10);
          const parsedPatch = Number.parseInt(match[3], 10);
          if (parsedMajor !== major || parsedMinor !== minor || !Number.isFinite(parsedPatch)) {
            return null;
          }
          return { tag, patch: parsedPatch };
        })
        .filter(Boolean)
        .sort((left, right) => right.patch - left.patch);
      if (!candidates.length) {
        console.error("No published release found in series " + series + " for " + repository);
        process.exit(4);
      }
      process.stdout.write(candidates[0].tag);
    });
  },
);
request.on("error", (error) => {
  console.error(String(error));
  process.exit(5);
});
`;
  const result = spawnSync(process.execPath, ["-e", apiScript, repository, series], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `Unable to resolve latest release for ${repository} series ${series}`;
    throw new Error(message);
  }
  const resolvedTag = result.stdout.trim();
  if (!resolvedTag) {
    throw new Error(`Unable to resolve latest release for ${repository} series ${series}`);
  }
  return resolvedTag;
}

/**
 * Return candidate LuaSkills dynamic library names for one platform.
 * 返回单个平台对应的 LuaSkills 动态库候选名称。
 */
function luaSkillsLibraryCandidates(platform: RuntimePlatformTarget): string[] {
  const names = [platform.luaskills_library_name];
  if (platform.dynamic_library_ext === ".dll") {
    names.push("libluaskills.dll");
  } else if (platform.dynamic_library_ext === ".dylib") {
    names.push("luaskills.dylib");
  } else {
    names.push("luaskills.so");
  }
  return [...new Set(names)];
}

/**
 * Build host option overrides for one database mode.
 * 为单个数据库模式构造宿主选项覆盖。
 */
function buildHostOptionsPatch(runtimeRoot: string, database: RuntimeDatabasePreset, platform: RuntimePlatformTarget, assets: RuntimeAssetDescriptor[]): Partial<LuaRuntimeHostOptions> {
  if (database === RuntimeDatabasePreset.HostCallback) {
    return {
      sqlite_provider_mode: "host_callback",
      sqlite_callback_mode: "json",
      lancedb_provider_mode: "host_callback",
      lancedb_callback_mode: "json",
    };
  }
  if (database === RuntimeDatabasePreset.VldbController) {
    return {
      sqlite_provider_mode: "space_controller",
      lancedb_provider_mode: "space_controller",
      space_controller: {
        endpoint: null,
        auto_spawn: true,
        executable_path: resolve(runtimeRoot, "bin", platform.controller_binary_name),
        process_mode: "managed",
        minimum_uptime_secs: 300,
        idle_timeout_secs: 900,
        default_lease_ttl_secs: 120,
        connect_timeout_secs: 5,
        startup_timeout_secs: 15,
        startup_retry_interval_ms: 250,
        lease_renew_interval_secs: 30,
      },
    };
  }
  if (database === RuntimeDatabasePreset.VldbDirect) {
    return {
      sqlite_library_path: resolveInstalledAsset(runtimeRoot, assets, "vldb_sqlite_lib"),
      sqlite_provider_mode: "dynamic_library",
      lancedb_library_path: resolveInstalledAsset(runtimeRoot, assets, "vldb_lancedb_lib"),
      lancedb_provider_mode: "dynamic_library",
    };
  }
  return {};
}

/**
 * Resolve the absolute path for one installed asset role.
 * 解析单个已安装资产角色对应的绝对路径。
 */
function resolveInstalledAsset(runtimeRoot: string, assets: RuntimeAssetDescriptor[], role: RuntimeAssetRole): string | null {
  const asset = assets.find((candidate) => candidate.role === role);
  return asset?.installed_path ? resolve(runtimeRoot, asset.installed_path) : null;
}

/**
 * Convert one absolute installed path into a manifest-relative path.
 * 将单个绝对安装路径转换为清单相对路径。
 */
export function relativeInstalledPath(runtimeRoot: string, installedPath: string): string {
  const rootPath = resolve(runtimeRoot);
  const absoluteInstalledPath = resolve(installedPath);
  ensurePathInsideRoot(rootPath, absoluteInstalledPath, "installed runtime manifest path", installedPath);
  ensureExistingPathInsideRoot(rootPath, absoluteInstalledPath, "installed runtime manifest path", installedPath);
  return relative(rootPath, absoluteInstalledPath).replace(/\\/g, "/");
}

/**
 * Ensure runtime directories used by SDK-managed assets exist.
 * 确保 SDK 管理资产使用的 runtime 目录存在。
 */
async function ensureRuntimeDirectories(runtimeRoot: string): Promise<void> {
  await mkdir(resolve(runtimeRoot, "bin"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "libs"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "include"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "lua_packages"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "licenses"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "resources"), { recursive: true });
  await mkdir(resolve(runtimeRoot, "dependencies"), { recursive: true });
}

/**
 * Resolve one managed runtime installation path inside the runtime root.
 * 在 runtime root 内解析单个受管运行时安装路径。
 */
export function resolveManagedRuntimeInstalledPath(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, runtimeName: keyof ManagedRuntimeInstallPlan["installed_paths"]): string {
  const pathValue = plan.installed_paths[runtimeName];
  return resolveManagedRuntimeChildPath(runtimeRoot, pathValue, `managed runtime installed path for ${String(runtimeName)}`);
}

/**
 * Resolve one relative child path and reject paths outside the root.
 * 解析单个相对子路径，并拒绝 root 外部路径。
 */
export function resolveManagedRuntimeChildPath(root: string, pathValue: string, context: string): string {
  validateManagedRuntimeRelativePath(pathValue, context);
  const rootPath = resolve(root);
  const childPath = resolve(rootPath, pathValue);
  ensurePathInsideRoot(rootPath, childPath, context, pathValue);
  ensureExistingPathInsideRoot(rootPath, childPath, context, pathValue);
  return childPath;
}

/**
 * Validate one managed runtime path string before filesystem resolution.
 * 在文件系统解析前校验单个受管运行时路径字符串。
 */
function validateManagedRuntimeRelativePath(pathValue: string, context: string): void {
  if (!pathValue || pathValue.includes("\0") || isAbsolute(pathValue) || winPath.isAbsolute(pathValue)) {
    throw new Error(`${context} must be a relative path inside its root`);
  }
  const normalized = pathValue.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${context} must be a relative path inside its root`);
  }
}

/**
 * Validate one candidate path is lexically inside the root.
 * 校验单个候选路径在词法上位于 root 内部。
 */
function ensurePathInsideRoot(rootPath: string, childPath: string, context: string, originalPath: string): void {
  const relativePath = relative(rootPath, childPath);
  if (relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return;
  }
  throw new Error(`${context} escapes its root: ${originalPath}`);
}

/**
 * Validate existing filesystem ancestors do not escape through symlinks.
 * 校验已存在的文件系统祖先不会通过符号链接逃逸。
 */
function ensureExistingPathInsideRoot(rootPath: string, childPath: string, context: string, originalPath: string): void {
  if (!existsSync(rootPath)) {
    return;
  }
  const existingPath = nearestExistingPath(childPath);
  if (!existingPath) {
    return;
  }
  if (existsSync(childPath) && lstatSync(childPath).isSymbolicLink()) {
    throw new Error(`${context} must not be a symbolic link: ${originalPath}`);
  }
  const realRoot = realpathSync(rootPath);
  const realExisting = realpathSync(existingPath);
  ensurePathInsideOrAtRoot(realRoot, realExisting, context, originalPath);
}

/**
 * Validate one existing ancestor is inside or equal to the root.
 * 校验单个已存在祖先位于 root 内部或等于 root。
 */
function ensurePathInsideOrAtRoot(rootPath: string, childPath: string, context: string, originalPath: string): void {
  const relativePath = relative(rootPath, childPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`${context} escapes its root: ${originalPath}`);
}

/**
 * Return the nearest existing filesystem path at or above one candidate.
 * 返回候选路径自身或其上方最近存在的文件系统路径。
 */
function nearestExistingPath(candidate: string): string | null {
  let current = candidate;
  while (current !== dirname(current)) {
    if (existsSync(current)) {
      return current;
    }
    current = dirname(current);
  }
  return existsSync(current) ? current : null;
}

/**
 * Install every managed child runtime selected by one plan.
 * 安装一个计划选择的全部受管子运行时。
 */
async function installManagedRuntimes(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, force: boolean): Promise<void> {
  if (plan.target === "all" || plan.target === "python") {
    await installManagedPythonRuntime(runtimeRoot, plan, force);
  }
  if (plan.target === "all" || plan.target === "node") {
    await installManagedNodeRuntime(runtimeRoot, plan, force);
    await installManagedPnpmRuntime(runtimeRoot, plan, force);
  }
  if (plan.target === "package-managers") {
    await installManagedUvRuntime(runtimeRoot, plan, force);
    await installManagedNodeRuntime(runtimeRoot, plan, force);
    await installManagedPnpmRuntime(runtimeRoot, plan, force);
  }
}

/**
 * Install one managed uv executable.
 * 安装一个受管 uv 可执行文件。
 */
async function installManagedUvRuntime(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, force: boolean): Promise<string> {
  const uvTarget = resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "uv");
  const uvExecutable = resolveManagedRuntimeChildPath(uvTarget, plan.platform.uv_executable, "managed uv executable");
  if (existsSync(uvExecutable) && !force) {
    return uvExecutable;
  }
  if (force) {
    await rm(uvTarget, { recursive: true, force: true });
  }
  const assetName = plan.platform.uv_asset_name;
  const assetUrl = `https://github.com/astral-sh/uv/releases/download/${plan.uv_version}/${assetName}`;
  const temporaryRoot = join(tmpdir(), `luaskills-managed-uv-${process.pid}-${Date.now()}`);
  const archivePath = join(temporaryRoot, assetName);
  const checksumPath = join(temporaryRoot, `${assetName}.sha256`);
  const extractDirectory = join(temporaryRoot, "extract");
  try {
    await mkdir(temporaryRoot, { recursive: true });
    await downloadFile(assetUrl, archivePath);
    await downloadFile(`${assetUrl}.sha256`, checksumPath);
    await verifySha256(archivePath, await readFile(checksumPath, "utf8"));
    await mkdir(extractDirectory, { recursive: true });
    await extractArchive(archivePath, extractDirectory);
    const extractedUv = await findFile(extractDirectory, (candidate) => candidate === (process.platform === "win32" ? "uv.exe" : "uv"));
    if (!extractedUv) {
      throw new Error(`uv executable was not found in ${assetName}`);
    }
    await mkdir(uvTarget, { recursive: true });
    await cp(extractedUv, uvExecutable, { force: true });
    await chmod(uvExecutable, 0o755).catch(() => undefined);
    await writeManagedRuntimeManifest(uvTarget, {
      schema_version: 1,
      runtime: "uv",
      version: plan.uv_version,
      platform: plan.platform.platform_key,
      executable: plan.platform.uv_executable,
      source: assetUrl,
    });
    await runProcess(uvExecutable, ["--version"]);
    return uvExecutable;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Install one managed CPython runtime through managed uv.
 * 通过受管 uv 安装一个受管 CPython 运行时。
 */
async function installManagedPythonRuntime(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, force: boolean): Promise<void> {
  const uvExecutable = await installManagedUvRuntime(runtimeRoot, plan, force);
  const pythonRoot = resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "python");
  const manifestPath = resolve(pythonRoot, "runtime-manifest.json");
  if (existsSync(manifestPath) && !force) {
    return;
  }
  if (force) {
    await rm(pythonRoot, { recursive: true, force: true });
  }
  await mkdir(pythonRoot, { recursive: true });
  const installArgs = force ? ["python", "install", plan.python_version, "--reinstall"] : ["python", "install", plan.python_version];
  await runProcessWithEnv(uvExecutable, installArgs, { UV_PYTHON_INSTALL_DIR: pythonRoot });
  const pythonExecutable = (await runProcessCaptureWithEnv(uvExecutable, ["python", "find", plan.python_version], { UV_PYTHON_INSTALL_DIR: pythonRoot })).trim().split(/\r?\n/)[0];
  if (!pythonExecutable || !existsSync(pythonExecutable)) {
    throw new Error(`uv installed Python ${plan.python_version} but no interpreter path could be resolved`);
  }
  await writeManagedRuntimeManifest(pythonRoot, {
    schema_version: 1,
    runtime: "python",
    version: plan.python_version,
    platform: plan.platform.platform_key,
    executable: relativeInstalledPath(pythonRoot, pythonExecutable),
    source: "uv-managed-python",
    package_manager: "uv",
    package_manager_version: plan.uv_version,
  });
  await runProcess(pythonExecutable, ["--version"]);
}

/**
 * Install one managed Node.js archive.
 * 安装一个受管 Node.js 归档。
 */
async function installManagedNodeRuntime(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, force: boolean): Promise<string> {
  const nodeTarget = resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "node");
  const nodeExecutable = resolveManagedRuntimeChildPath(nodeTarget, plan.platform.node_executable, "managed Node.js executable");
  if (existsSync(nodeExecutable) && !force) {
    return nodeExecutable;
  }
  if (force) {
    await rm(nodeTarget, { recursive: true, force: true });
  }
  const assetName = renderVersionTemplate(plan.platform.node_asset_template, plan.node_version);
  const extractName = renderVersionTemplate(plan.platform.node_extract_template, plan.node_version);
  const baseUrl = `https://nodejs.org/dist/v${plan.node_version}`;
  const assetUrl = `${baseUrl}/${assetName}`;
  const temporaryRoot = join(tmpdir(), `luaskills-managed-node-${process.pid}-${Date.now()}`);
  const archivePath = join(temporaryRoot, assetName);
  const shasumsPath = join(temporaryRoot, "SHASUMS256.txt");
  const extractDirectory = join(temporaryRoot, "extract");
  try {
    await mkdir(temporaryRoot, { recursive: true });
    await downloadFile(assetUrl, archivePath);
    await downloadFile(`${baseUrl}/SHASUMS256.txt`, shasumsPath);
    await verifyNamedSha256(archivePath, await readFile(shasumsPath, "utf8"), assetName);
    await mkdir(extractDirectory, { recursive: true });
    await extractArchive(archivePath, extractDirectory);
    const extractedRoot = join(extractDirectory, extractName);
    if (!existsSync(extractedRoot)) {
      throw new Error(`Node archive root '${extractName}' was not found in ${assetName}`);
    }
    await mkdir(resolve(nodeTarget, ".."), { recursive: true });
    await cp(extractedRoot, nodeTarget, { recursive: true, force: true });
    await writeManagedRuntimeManifest(nodeTarget, {
      schema_version: 1,
      runtime: "node",
      version: plan.node_version,
      platform: plan.platform.platform_key,
      executable: plan.platform.node_executable,
      source: assetUrl,
    });
    await runProcess(nodeExecutable, ["--version"]);
    return nodeExecutable;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Install one managed pnpm package without changing global npm state.
 * 安装一个受管 pnpm 包，且不修改全局 npm 状态。
 */
async function installManagedPnpmRuntime(runtimeRoot: string, plan: ManagedRuntimeInstallPlan, force: boolean): Promise<void> {
  const nodeExecutable = await installManagedNodeRuntime(runtimeRoot, plan, force);
  const pnpmTarget = resolveManagedRuntimeInstalledPath(runtimeRoot, plan, "pnpm");
  const pnpmEntry = resolve(pnpmTarget, "bin/pnpm.cjs");
  if (existsSync(pnpmEntry) && !force) {
    return;
  }
  if (force) {
    await rm(pnpmTarget, { recursive: true, force: true });
  }
  const metadataUrl = `https://registry.npmjs.org/pnpm/${plan.pnpm_version}`;
  const metadata = await downloadJson(metadataUrl);
  const tarballUrl = String(metadata?.dist?.tarball ?? "");
  const integrity = String(metadata?.dist?.integrity ?? "");
  if (!tarballUrl || !integrity.startsWith("sha512-")) {
    throw new Error(`pnpm metadata for ${plan.pnpm_version} does not contain a sha512 integrity tarball`);
  }
  const temporaryRoot = join(tmpdir(), `luaskills-managed-pnpm-${process.pid}-${Date.now()}`);
  const tarballPath = join(temporaryRoot, `pnpm-${plan.pnpm_version}.tgz`);
  const extractDirectory = join(temporaryRoot, "extract");
  try {
    await mkdir(temporaryRoot, { recursive: true });
    await downloadFile(tarballUrl, tarballPath);
    await verifySha512Integrity(tarballPath, integrity);
    await mkdir(extractDirectory, { recursive: true });
    await extractArchive(tarballPath, extractDirectory);
    const packageRoot = join(extractDirectory, "package");
    if (!existsSync(packageRoot)) {
      throw new Error("pnpm package root was not found in tarball");
    }
    await mkdir(resolve(pnpmTarget, ".."), { recursive: true });
    await cp(packageRoot, pnpmTarget, { recursive: true, force: true });
    await writeManagedRuntimeManifest(pnpmTarget, {
      schema_version: 1,
      runtime: "pnpm",
      version: plan.pnpm_version,
      platform: "any",
      executable: "bin/pnpm.cjs",
      source: tarballUrl,
      node_runtime_version: plan.node_version,
    });
    await runProcess(nodeExecutable, [pnpmEntry, "--version"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Download, verify, extract, and install one asset.
 * 下载、校验、解压并安装单个资产。
 */
async function installOneAsset(runtimeRoot: string, asset: RuntimeAssetDescriptor, temporaryRoot: string, platform: RuntimePlatformTarget): Promise<void> {
  const assetDirectory = join(temporaryRoot, asset.role);
  const archivePath = join(assetDirectory, asset.asset_name);
  const extractDirectory = join(assetDirectory, "extract");
  await mkdir(assetDirectory, { recursive: true });
  const sha256Text = await downloadText(asset.sha256_url);
  await downloadFile(asset.download_url, archivePath);
  await verifySha256(archivePath, sha256Text);
  await mkdir(extractDirectory, { recursive: true });
  await extractArchive(archivePath, extractDirectory);
  if (asset.role === "lua_runtime") {
    await installLuaRuntime(runtimeRoot, extractDirectory, asset);
  } else if (asset.role === "luaskills_ffi") {
    await installLuaSkillsFfi(runtimeRoot, extractDirectory, platform, asset);
  } else if (asset.role === "vldb_controller") {
    await installController(runtimeRoot, extractDirectory, platform, asset);
  } else if (asset.role === "vldb_sqlite_lib") {
    await installDynamicLibrary(runtimeRoot, extractDirectory, platform, "sqlite", asset);
  } else if (asset.role === "vldb_lancedb_lib") {
    await installDynamicLibrary(runtimeRoot, extractDirectory, platform, "lancedb", asset);
  }
}

/**
 * Download one UTF-8 text file.
 * 下载单个 UTF-8 文本文件。
 */
async function downloadText(url: string): Promise<string> {
  const response = await fetchReleaseAsset(url, "SHA-256 sidecar");
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Download one binary file to disk.
 * 将单个二进制文件下载到磁盘。
 */
async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetchReleaseAsset(url, "runtime archive");
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destination, buffer);
}

/**
 * Download and parse one JSON document.
 * 下载并解析单个 JSON 文档。
 */
async function downloadJson(url: string): Promise<any> {
  const response = await fetchReleaseAsset(url, "JSON metadata");
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Fetch one GitHub Release asset and wrap network failures with SDK integration guidance.
 * 拉取单个 GitHub Release 资产，并为网络失败包装 SDK 集成排障提示。
 */
async function fetchReleaseAsset(url: string, assetKind: string): Promise<Response> {
  try {
    return await fetch(url);
  } catch (error) {
    throw new Error(buildReleaseFetchFailureMessage(url, assetKind, error), { cause: error });
  }
}

/**
 * Build a clear release-download failure message for proxy and connectivity issues.
 * 为代理与连接问题构造清晰的 Release 下载失败信息。
 */
function buildReleaseFetchFailureMessage(url: string, assetKind: string, error: unknown): string {
  const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const nestedCause = error instanceof Error && "cause" in error && error.cause
    ? ` Cause: ${String(error.cause)}.`
    : "";
  return [
    `Failed to download ${assetKind} from ${url}.`,
    `Underlying fetch error: ${cause}.${nestedCause}`,
    "Ensure GitHub Release assets are reachable from this machine.",
    "If you are behind a proxy, configure HTTP_PROXY/HTTPS_PROXY and, on Node.js versions that require it, set NODE_USE_ENV_PROXY=1 before running install-runtime.",
  ].join(" ");
}

/**
 * Verify one downloaded archive against a SHA-256 sidecar.
 * 使用 SHA-256 旁路文件校验单个已下载归档。
 */
export async function verifySha256(filePath: string, sha256Text: string): Promise<void> {
  const expectedHash = sha256Text.trim().split(/\s+/)[0]?.toLowerCase();
  if (!expectedHash) {
    throw new Error(`invalid SHA-256 sidecar for ${filePath}`);
  }
  const normalizedExpectedHash = normalizeSha256Hash(expectedHash, `SHA-256 sidecar for ${filePath}`);
  const actualHash = await fileSha256(filePath);
  if (actualHash !== normalizedExpectedHash) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${normalizedExpectedHash}, got ${actualHash}`);
  }
}

/**
 * Verify one downloaded archive against a named SHA-256 manifest.
 * 使用包含文件名的 SHA-256 清单校验单个已下载归档。
 */
export async function verifyNamedSha256(filePath: string, sha256Text: string, assetName: string): Promise<void> {
  let expectedHash = "";
  for (const line of sha256Text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === assetName) {
      expectedHash = normalizeSha256Hash(parts[0], `checksum entry for ${assetName}`);
      break;
    }
  }
  if (!expectedHash) {
    throw new Error(`Checksum entry for ${assetName} was not found`);
  }
  const actualHash = await fileSha256(filePath);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expectedHash}, got ${actualHash}`);
  }
}

/**
 * Verify one downloaded npm tarball against an integrity string.
 * 使用 npm integrity 字符串校验单个已下载 tarball。
 */
export async function verifySha512Integrity(filePath: string, integrity: string): Promise<void> {
  const expectedDigest = normalizeSha512IntegrityDigest(filePath, integrity);
  const actualDigest = await fileSha512Base64(filePath);
  if (actualDigest !== expectedDigest) {
    throw new Error(`SHA-512 integrity mismatch for ${filePath}`);
  }
}

/**
 * Normalize and validate one SHA-256 hexadecimal digest.
 * 归一化并校验单个 SHA-256 十六进制摘要。
 */
export function normalizeSha256Hash(hashText: string, context: string): string {
  const normalized = hashText.toLowerCase();
  if (!SHA256_HEX_PATTERN.test(normalized)) {
    throw new Error(`invalid SHA-256 digest in ${context}: ${hashText}`);
  }
  return normalized;
}

/**
 * Extract and validate one SHA-512 Base64 digest from an integrity string.
 * 从 integrity 字符串提取并校验单个 SHA-512 Base64 摘要。
 */
export function normalizeSha512IntegrityDigest(filePath: string, integrity: string): string {
  if (!integrity.startsWith("sha512-")) {
    throw new Error(`invalid SHA-512 integrity for ${filePath}`);
  }
  const digest = integrity.slice("sha512-".length);
  if (!digest || digest.length % 4 !== 0 || !SHA512_BASE64_PATTERN.test(digest)) {
    throw new Error(`invalid SHA-512 integrity for ${filePath}`);
  }
  return digest;
}

/**
 * Compute the SHA-256 hash for one file.
 * 计算单个文件的 SHA-256 哈希。
 */
async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

/**
 * Compute the SHA-512 hash for one file as Base64.
 * 计算单个文件的 SHA-512 Base64 哈希。
 */
async function fileSha512Base64(filePath: string): Promise<string> {
  const hash = createHash("sha512");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", resolvePromise);
  });
  return hash.digest("base64");
}

/**
 * Extract one archive with the platform tar implementation.
 * 使用平台 tar 实现解压单个归档。
 */
async function extractArchive(archivePath: string, destination: string): Promise<void> {
  await validateArchiveMembers(archivePath, destination);
  await runProcess("tar", ["-xf", archivePath, "-C", destination]);
}

/**
 * Validate archive members before invoking the platform extractor.
 * 调用平台解压器前校验归档成员。
 */
export async function validateArchiveMembers(archivePath: string, destination: string): Promise<void> {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    await validateTarGzMembers(archivePath, destination);
    return;
  }
  const members = await listArchiveMembers(archivePath);
  for (const member of members) {
    validateArchiveMemberPath(destination, member);
  }
}

/**
 * List archive members through the platform tar implementation.
 * 通过平台 tar 实现列出归档成员。
 */
async function listArchiveMembers(archivePath: string): Promise<string[]> {
  const output = await runProcessCapture("tar", ["-tf", archivePath]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Validate one gzip-compressed tar archive including link targets.
 * 校验单个 gzip 压缩 tar 归档及其链接目标。
 */
async function validateTarGzMembers(archivePath: string, destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let buffer = Buffer.alloc(0);
    let pendingLongName: string | null = null;
    let pendingLongLink: string | null = null;
    let pendingPax: Record<string, string> | null = null;
    const stream = createReadStream(archivePath).pipe(createGunzip());

    const parseAvailableBlocks = (): void => {
      while (buffer.length >= 512) {
        const header = buffer.subarray(0, 512);
        if (isTarEndBlock(header)) {
          buffer = buffer.subarray(512);
          continue;
        }
        const size = parseTarSize(header.subarray(124, 136));
        const paddedSize = Math.ceil(size / 512) * 512;
        if (buffer.length < 512 + paddedSize) {
          return;
        }
        const payload = buffer.subarray(512, 512 + size);
        const typeFlag = tarString(header.subarray(156, 157));
        if (typeFlag === "L") {
          pendingLongName = tarPayloadString(payload);
        } else if (typeFlag === "K") {
          pendingLongLink = tarPayloadString(payload);
        } else if (typeFlag === "x") {
          pendingPax = parsePaxHeader(payload);
        } else if (typeFlag === "g") {
          validateGlobalPaxHeader(parsePaxHeader(payload));
        } else {
          const memberName = pendingPax?.path ?? pendingLongName ?? tarMemberName(header);
          const linkName = pendingPax?.linkpath ?? pendingLongLink ?? tarString(header.subarray(157, 257));
          validateTarMemberType(typeFlag, memberName);
          validateArchiveMemberPath(destination, memberName);
          if (typeFlag === "2") {
            validateArchiveLinkTarget(destination, memberName, linkName);
          } else if (typeFlag === "1" && linkName) {
            validateArchiveMemberPath(destination, linkName);
          }
          pendingLongName = null;
          pendingLongLink = null;
          pendingPax = null;
        }
        buffer = buffer.subarray(512 + paddedSize);
      }
    };

    stream.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        parseAvailableBlocks();
      } catch (error) {
        stream.destroy(error as Error);
      }
    });
    stream.on("error", rejectPromise);
    stream.on("end", () => {
      try {
        parseAvailableBlocks();
        resolvePromise();
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

/**
 * Return whether one tar header block marks archive end.
 * 返回单个 tar header block 是否表示归档结束。
 */
function isTarEndBlock(header: Buffer): boolean {
  return header.every((value) => value === 0);
}

/**
 * Parse one tar size field.
 * 解析单个 tar size 字段。
 */
function parseTarSize(field: Buffer): number {
  const value = tarString(field).trim();
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid tar member size: ${value}`);
  }
  return parsed;
}

/**
 * Parse one tar member name from name and prefix fields.
 * 从 name 与 prefix 字段解析单个 tar 成员名称。
 */
function tarMemberName(header: Buffer): string {
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/**
 * Decode one null-terminated tar string field.
 * 解码单个以 null 结尾的 tar 字符串字段。
 */
function tarString(field: Buffer): string {
  const zeroIndex = field.indexOf(0);
  const end = zeroIndex >= 0 ? zeroIndex : field.length;
  return field.subarray(0, end).toString("utf8");
}

/**
 * Decode one GNU tar long-name payload.
 * 解码单个 GNU tar 长名称载荷。
 */
function tarPayloadString(payload: Buffer): string {
  return tarString(payload).trim();
}

/**
 * Parse one POSIX pax header payload.
 * 解析单个 POSIX pax header 载荷。
 */
function parsePaxHeader(payload: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const spaceIndex = payload.indexOf(0x20, offset);
    if (spaceIndex < 0) {
      break;
    }
    const recordLength = Number.parseInt(payload.subarray(offset, spaceIndex).toString("ascii"), 10);
    if (!Number.isFinite(recordLength) || recordLength <= 0 || offset + recordLength > payload.length) {
      break;
    }
    const record = payload.subarray(spaceIndex + 1, offset + recordLength - 1).toString("utf8");
    const equalsIndex = record.indexOf("=");
    if (equalsIndex >= 0) {
      records[record.slice(0, equalsIndex)] = record.slice(equalsIndex + 1);
    }
    offset += recordLength;
  }
  return records;
}

/**
 * Validate one global pax header does not rewrite later member paths.
 * 校验单个全局 pax header 不会重写后续成员路径。
 */
function validateGlobalPaxHeader(records: Record<string, string>): void {
  if (records.path || records.linkpath) {
    throw new Error("Unsupported global pax path override");
  }
}

/**
 * Reject tar members that are not regular files, directories, or links.
 * 拒绝非常规文件、目录或链接的 tar 成员。
 */
export function validateTarMemberType(typeFlag: string, memberName: string): void {
  if (typeFlag === "" || typeFlag === "0" || typeFlag === "5" || typeFlag === "1" || typeFlag === "2") {
    return;
  }
  throw new Error(`Unsupported tar member type for ${memberName}: ${typeFlag}`);
}

/**
 * Validate that one archive member extracts inside the destination.
 * 校验单个归档成员会解压到目标目录内部。
 */
export function validateArchiveMemberPath(destination: string, memberName: string): void {
  if (!memberName || memberName.includes("\0") || isAbsolute(memberName) || winPath.isAbsolute(memberName)) {
    throw new Error(`Unsafe archive member path: ${memberName}`);
  }
  const destinationRoot = resolve(destination);
  const memberPath = resolve(destinationRoot, memberName);
  const relativePath = relative(destinationRoot, memberPath);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    return;
  }
  throw new Error(`Archive member escapes extraction directory: ${memberName}`);
}

/**
 * Validate that one symbolic link target remains inside the destination.
 * 校验单个符号链接目标保持在目标目录内部。
 */
export function validateArchiveLinkTarget(destination: string, memberName: string, linkName: string): void {
  if (!linkName || linkName.includes("\0") || isAbsolute(linkName) || winPath.isAbsolute(linkName)) {
    throw new Error(`Unsafe archive link target: ${memberName} -> ${linkName}`);
  }
  const normalizedMember = memberName.replace(/\\/g, "/");
  const normalizedLink = linkName.replace(/\\/g, "/");
  const combined = posixPath.join(posixPath.dirname(normalizedMember), normalizedLink);
  validateArchiveMemberPath(destination, combined);
}

/**
 * Install a Lua runtime archive into runtime lua_packages/libs/resources/licenses directories.
 * 将 Lua runtime 归档安装到 runtime 的 lua_packages/libs/resources/licenses 目录。
 */
async function installLuaRuntime(runtimeRoot: string, extractDirectory: string, asset: RuntimeAssetDescriptor): Promise<void> {
  await copyDirectoryIfPresent(join(extractDirectory, "lua_packages"), resolve(runtimeRoot, "lua_packages"));
  await copyDirectoryIfPresent(join(extractDirectory, "libs"), resolve(runtimeRoot, "libs"));
  await copyDirectoryIfPresent(join(extractDirectory, "resources"), resolve(runtimeRoot, "resources"));
  await copyDirectoryIfPresent(join(extractDirectory, "licenses"), resolve(runtimeRoot, "licenses"));
  const markerPath = resolve(runtimeRoot, "resources", "lua-runtime-manifest.json");
  if (!existsSync(markerPath)) {
    throw new Error(`Lua runtime manifest was not found after installing ${asset.asset_name}`);
  }
  asset.installed_path = relativeInstalledPath(runtimeRoot, markerPath);
}

/**
 * Install a LuaSkills FFI SDK archive into runtime include/libs/licenses directories.
 * 将 LuaSkills FFI SDK 归档安装到 runtime include/libs/licenses 目录。
 */
async function installLuaSkillsFfi(runtimeRoot: string, extractDirectory: string, platform: RuntimePlatformTarget, asset: RuntimeAssetDescriptor): Promise<void> {
  await copyDirectoryIfPresent(join(extractDirectory, "include"), resolve(runtimeRoot, "include"));
  await copyDirectoryIfPresent(join(extractDirectory, "lib"), resolve(runtimeRoot, "libs"));
  await copyDirectoryIfPresent(join(extractDirectory, "licenses"), resolve(runtimeRoot, "licenses", "luaskills-ffi"));
  const installedPath = resolveLuaSkillsLibraryPathFromRuntime(runtimeRoot, platform);
  if (!installedPath) {
    throw new Error(`LuaSkills dynamic library was not found after installing ${asset.asset_name}`);
  }
  asset.installed_path = relativeInstalledPath(runtimeRoot, installedPath);
}

/**
 * Install vldb-controller into the runtime bin directory.
 * 将 vldb-controller 安装到 runtime bin 目录。
 */
async function installController(runtimeRoot: string, extractDirectory: string, platform: RuntimePlatformTarget, asset: RuntimeAssetDescriptor): Promise<void> {
  const source = await findFile(extractDirectory, (candidate) => candidate === platform.controller_binary_name);
  if (!source) {
    throw new Error(`${platform.controller_binary_name} was not found in ${asset.asset_name}`);
  }
  const destination = resolve(runtimeRoot, "bin", platform.controller_binary_name);
  await cp(source, destination, { force: true });
  await chmod(destination, 0o755).catch(() => undefined);
  asset.installed_path = `bin/${platform.controller_binary_name}`;
}

/**
 * Install one VLDB dynamic library into the runtime libs directory.
 * 将单个 VLDB 动态库安装到 runtime libs 目录。
 */
async function installDynamicLibrary(runtimeRoot: string, extractDirectory: string, platform: RuntimePlatformTarget, nameHint: "sqlite" | "lancedb", asset: RuntimeAssetDescriptor): Promise<void> {
  const source = await findFile(extractDirectory, (candidate) => candidate.endsWith(platform.dynamic_library_ext) && candidate.toLowerCase().includes(nameHint));
  if (!source) {
    throw new Error(`Dynamic library for ${asset.role} was not found in ${asset.asset_name}`);
  }
  const destinationName = source.split(/[\\/]/).pop() ?? (nameHint === "sqlite" ? platform.sqlite_library_name : platform.lancedb_library_name);
  const destination = resolve(runtimeRoot, "libs", destinationName);
  await cp(source, destination, { force: true });
  asset.installed_path = `libs/${destinationName}`;
}

/**
 * Copy one directory only when it exists.
 * 仅在目录存在时复制单个目录。
 */
async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  try {
    await cp(source, destination, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/**
 * Find one file under a directory by base-name predicate.
 * 根据基础文件名谓词在目录下查找单个文件。
 */
async function findFile(root: string, predicate: (fileName: string) => boolean): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFile(fullPath, predicate);
      if (nested) {
        return nested;
      }
    } else if (entry.isFile() && predicate(entry.name)) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Build relative managed runtime installation paths under one runtime root.
 * 构造单个 runtime root 下的受管运行时相对安装路径。
 */
function managedRuntimeInstalledPaths(
  _runtimeRoot: string,
  platform: ManagedRuntimePlatformTarget,
  pythonVersion: string,
  uvVersion: string,
  nodeVersion: string,
  pnpmVersion: string,
): Record<string, string> {
  return {
    python: `dependencies/runtimes/python/cpython-${pythonVersion}-${platform.platform_key}`,
    uv: `dependencies/runtimes/python/uv-${uvVersion}-${platform.platform_key}`,
    node: `dependencies/runtimes/node/node-${nodeVersion}-${platform.platform_key}`,
    pnpm: `dependencies/runtimes/node/pnpm-${pnpmVersion}`,
  };
}

/**
 * Write one managed runtime manifest without a UTF-8 BOM.
 * 写入一个不带 UTF-8 BOM 的受管运行时 manifest。
 */
async function writeManagedRuntimeManifest(directory: string, manifest: Record<string, unknown>): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/**
 * Render one `{version}` template used by upstream managed runtime archives.
 * 渲染一个上游受管运行时归档使用的 `{version}` 模板。
 */
function renderVersionTemplate(template: string, version: string): string {
  return template.replace("{version}", version);
}

/**
 * Run one child process and reject when it fails.
 * 运行单个子进程，并在失败时拒绝。
 */
async function runProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Run one child process with extra environment variables.
 * 使用额外环境变量运行单个子进程。
 */
async function runProcessWithEnv(command: string, args: string[], env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

/**
 * Run one child process and capture stdout.
 * 运行单个子进程并捕获 stdout。
 */
async function runProcessCapture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      rejectPromise(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

/**
 * Run one child process with extra environment variables and capture stdout.
 * 使用额外环境变量运行单个子进程并捕获 stdout。
 */
async function runProcessCaptureWithEnv(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdoutChunks).toString("utf8"));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      rejectPromise(new Error(`${command} exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

/**
 * Convert an unknown thrown value into a stable error string.
 * 将未知抛出值转换为稳定错误字符串。
 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Refresh host option paths after extraction may have discovered exact library names.
 * 在解压发现精确动态库名称后刷新宿主选项路径。
 */
function refreshHostOptionsPatch(manifest: RuntimeInstallManifest): RuntimeInstallManifest {
  return {
    ...manifest,
    host_options_patch: buildHostOptionsPatch(manifest.runtime_root, normalizeDatabasePreset(manifest.database_mode), manifest.platform, manifest.assets),
  };
}
