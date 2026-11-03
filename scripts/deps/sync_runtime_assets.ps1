param(
    # Asset group to synchronize into the runtime root.
    # 要同步到运行根目录的资产分组。
    [ValidateSet("all", "luaskills", "lua")]
    [string]$Target = "all",
    # Runtime root that receives all synchronized assets.
    # 接收全部同步资产的运行根目录。
    [string]$RuntimeRoot = "output",
    # Core major.minor series; empty uses core_series from contracts/embedded/v1/contract.json.
    # 核心 major.minor 系列；为空时使用 contracts/embedded/v1/contract.json 的 core_series。
    [string]$LuaSkillsSeries = "",
    # Optional exact core tag inside the series; empty installs the newest published patch.
    # 系列内可选的精确核心标签；为空时安装最新已发布补丁版本。
    [string]$LuaSkillsVersion = "",
    # Compatible Lua runtime packages release series.
    # 兼容的 Lua runtime packages 发布协议线。
    [string]$LuaRuntimeSeries = "0.1",
    # Optional exact Lua runtime packages release tag.
    # 可选的精确 Lua runtime packages 发布标签。
    [string]$LuaRuntimeVersion = ""

)

$ErrorActionPreference = "Stop"

# ScriptRoot identifies the shared dependency script directory.
# ScriptRoot 标识共享依赖脚本目录。
$ScriptRoot = $PSScriptRoot
# RepositoryRoot identifies the SDK or LuaSkills repository root.
# RepositoryRoot 标识 SDK 或 LuaSkills 仓库根目录。
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $ScriptRoot "..\..")).Path
# FfiScript identifies the canonical LuaSkills FFI synchronization implementation.
# FfiScript 标识 LuaSkills FFI 同步的规范实现。
$FfiScript = Join-Path $RepositoryRoot "scripts\ffi\fetch_ffi.ps1"
# DependenciesScript identifies the canonical Lua runtime synchronization implementation.
# DependenciesScript 标识 Lua runtime 同步的规范实现。
$DependenciesScript = Join-Path $ScriptRoot "fetch_deps.ps1"

if ($Target -eq "all" -or $Target -eq "luaskills") {
    & $FfiScript -RuntimeRoot $RuntimeRoot -LuaSkillsSeries $LuaSkillsSeries -LuaSkillsVersion $LuaSkillsVersion
}
if ($Target -eq "all" -or $Target -eq "lua") {
    & $DependenciesScript -Target lua -RuntimeRoot $RuntimeRoot -LuaRuntimeSeries $LuaRuntimeSeries -LuaRuntimeVersion $LuaRuntimeVersion
}

Write-Host "Runtime asset target '$Target' synchronized into $RuntimeRoot"
