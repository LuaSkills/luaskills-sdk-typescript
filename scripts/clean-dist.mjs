import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ScriptDirectory is the canonical directory that owns this cleanup script.
// ScriptDirectory 是当前清理脚本所在的规范目录。
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
// RepositoryRoot is the only parent directory whose generated dist child may be removed.
// RepositoryRoot 是唯一允许删除其生成 dist 子目录的父目录。
const repositoryRoot = resolve(scriptDirectory, "..");
// DistributionRoot is the generated TypeScript output removed before every build and package operation.
// DistributionRoot 是每次构建与打包前删除的 TypeScript 生成输出目录。
const distributionRoot = resolve(repositoryRoot, "dist");

if (dirname(distributionRoot) !== repositoryRoot) {
  throw new Error(`refusing to clean unexpected distribution path: ${distributionRoot}`);
}

rmSync(distributionRoot, { recursive: true, force: true });
