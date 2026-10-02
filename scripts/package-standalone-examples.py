"""Package and verify the published examples from one exact release manifest.
从一份精确发布清单打包并验证已发布示例。
"""

import argparse
import json
import posixpath
import re
import subprocess
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

# The checkout owns the source manifest; neither installed SDKs nor runtime caches select examples.
# 检出拥有源码清单；已安装 SDK 及运行时缓存都不能选择示例。
SOURCE_ROOT = Path(__file__).resolve().parent.parent
# Generated documentation and the consumer package are the only files outside the source manifest.
# 生成文档及消费端包是源码清单之外唯一文件。
GENERATED_FILES = ("package.json", "README.md", "README_cn.md", "examples/README.md", "examples/README_cn.md", "EXAMPLES_RELEASE.md")
# Source ZIPs use fixed metadata and stored bytes to remain independent of time, host modes and zlib versions.
# 源码 ZIP 使用固定元数据及原始字节，独立于时间、宿主权限和 zlib 版本。
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def release_manifest():
    """Read the sole example/support-file manifest and reject ambiguous source paths.
    读取唯一示例及支持文件清单，拒绝歧义源码路径。
    Returns the validated manifest without probing alternative files.
    返回已校验清单，不探测备用文件。
    """
    # Names determine source files, npm scripts, smoke execution and generated documentation together.
    # 名称共同决定源文件、npm 脚本、冒烟执行及生成文档。
    manifest = json.loads((SOURCE_ROOT / "scripts/standalone-examples-manifest.json").read_text(encoding="utf-8"))
    # Unique simple names cannot escape the examples directory.
    # 唯一简单名称不能逃逸示例目录。
    names = [entry["name"] for entry in manifest["examples"]]
    if not names or len(names) != len(set(names)) or any(not re.fullmatch(r"[a-z][a-z-]*", name) for name in names):
        raise ValueError("Standalone example names must be unique simple names")
    # Every support member is a canonical relative POSIX file path.
    # 每个支持成员都是规范相对 POSIX 文件路径。
    files = manifest["support_files"]
    if len(files) != len(set(files)) or any(posixpath.normpath(name) != name or name.startswith(("/", "../")) or "\\" in name for name in files):
        raise ValueError("Invalid standalone support file paths")
    return manifest


def member_files(manifest):
    """Derive every permitted source/generated ZIP member from the validated manifest.
    从已校验清单派生每个允许的源码及生成 ZIP 成员。
    manifest is the sole release selection; returns relative member names.
    manifest 是唯一发布选择；返回相对成员名称。
    """
    return [*(f"examples/{entry['name']}.mjs" for entry in manifest["examples"]), *manifest["support_files"], *GENERATED_FILES]


def consumer_package(manifest, version):
    """Build the exact published-package consumer configuration for version.
    为 version 构建精确已发布包消费配置。
    manifest supplies example scripts; returns package.json contents.
    manifest 提供示例脚本；返回 package.json 内容。
    """
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", version):
        raise ValueError("Invalid standalone SDK version")
    return {"private": True, "type": "module", "scripts": {
        "install-runtime": "luaskills install-runtime --database none --runtime-root examples/fixture-runtime",
        **{f"example:{entry['name']}": f"node examples/{entry['name']}.mjs" for entry in manifest["examples"]},
    }, "dependencies": {"@luaskills/sdk": version}}


def documentation(manifest, version, chinese=False, example_directory=False):
    """Generate standalone documentation whose local links all belong to the selected package.
    生成所有本地链接都属于所选包的独立文档。
    Parameters select language and document directory; returns Markdown text.
    参数选择语言及文档目录；返回 Markdown 文本。
    """
    # Relative link bases differ for root and example guides, while source selection stays identical.
    # 根及示例指南的相对链接基础不同，但源码选择保持相同。
    base = "" if example_directory else "examples/"
    # Each localized description comes from the same entry as the executable.
    # 每个本地化说明与可执行文件来自同一条目。
    language = "zh" if chinese else "en"
    # Companion links always target generated documents inside the archive.
    # 配套链接始终指向归档内生成文档。
    companion = "README.md" if chinese else "README_cn.md"
    # The published version is an explicit argument and never inferred from a development contract.
    # 已发布版本是显式参数，绝不从开发契约推断。
    title = f"LuaSkills TypeScript SDK {'示例' if chinese else 'Examples'} {version}"
    # Installation remains the documented standalone source-package flow.
    # 安装保持文档声明的独立源码包流程。
    preparation = "从包根运行以下命令；SDK 依赖固定到已发布版本。首次安装需要网络以获取 npm 依赖及当前平台运行时资产；ZIP 仅包含源码，不包含已安装 SDK 或运行时。" if chinese else "Run these commands from the package root; the SDK dependency is pinned to the published version. Initial installation requires network access for npm dependencies and platform runtime assets. This ZIP contains source files, without an installed SDK or runtime."
    # The index includes exactly the released examples and no development-only entry points.
    # 索引仅包含发布示例，不含仅开发入口。
    index = "\n".join(f"- [{entry['name']}.mjs]({base}{entry['name']}.mjs): {entry[language]} `npm run example:{entry['name']}`" for entry in manifest["examples"])
    # Additional links retain navigable bilingual guides after extraction.
    # 附加链接在解压后保留可导航双语指南。
    guide_filename = "README_cn.md" if chinese else "README.md"
    guide = f"[{'包根说明' if chinese else 'Package guide'}](../{guide_filename})" if example_directory else f"[{'示例指南' if chinese else 'Example guide'}](examples/{guide_filename})"
    return f"# {title}\n\n[{companion}]({companion}) · {guide}\n\n{preparation}\n\n```bash\nnpm install\nnpm run install-runtime\n```\n\n{index}\n\n" + ("此包只包含已发布 SDK 示例。开发 embedded 示例在 npm 候选包内运行。\n" if chinese else "This package contains published SDK examples. Development embedded examples run inside the npm candidate package.\n")


def stage_package(root, version):
    """Create a new standalone source package at root using the exact published version.
    使用精确已发布版本在 root 创建新的独立源码包。
    root must not exist; returns the populated path without installing dependencies.
    root 必须不存在；返回填充后的路径，不安装依赖。
    """
    # Validate selection and version before creating any output.
    # 创建任何输出前校验选择及版本。
    manifest = release_manifest()
    # The consumer configuration is reused by archive verification.
    # 消费配置由归档验证复用。
    package = consumer_package(manifest, version)
    root.mkdir(parents=True, exist_ok=False)
    # Only declared source files are copied; a new example never enters a release implicitly.
    # 仅复制声明源文件；新示例绝不隐式进入发布。
    source_files = [name for name in member_files(manifest) if name not in GENERATED_FILES]
    for name in source_files:
        # Exact relative destination preserves existing fixture lookup behavior.
        # 精确相对目标保留既有夹具查找行为。
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((SOURCE_ROOT / name).read_bytes())
    (root / "package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    for name, chinese, in_examples in (("README.md", False, False), ("README_cn.md", True, False), ("examples/README.md", False, True), ("examples/README_cn.md", True, True)):
        (root / name).write_text(documentation(manifest, version, chinese, in_examples), encoding="utf-8", newline="\n")
    (root / "EXAMPLES_RELEASE.md").write_text(f"# LuaSkills TypeScript SDK Examples {version}\n\n[English guide](README.md) · [中文指南](README_cn.md)\n", encoding="utf-8", newline="\n")
    return root


def verify_archive(archive, package_name, version):
    """Verify real ZIP membership, published scripts and every Markdown local-link target.
    验证真实 ZIP 成员、已发布脚本及每个 Markdown 本地链接目标。
    archive/package_name/version identify one artifact; returns its exact example names.
    archive/package_name/version 标识一个产物；返回其精确示例名称。
    """
    # The same manifest defines both required files and the only permitted members.
    # 同一清单定义必需文件及唯一允许成员。
    manifest = release_manifest()
    # Archive paths must have one explicit root and no duplicate members.
    # 归档路径必须拥有一个显式根且没有重复成员。
    expected = {f"{package_name}/{name}" for name in member_files(manifest)}
    with zipfile.ZipFile(archive) as zipped:
        # Inspection reads archive bytes directly and never extracts untrusted member paths.
        # 检查直接读取归档字节，绝不解压不可信成员路径。
        members = zipped.namelist()
        if len(members) != len(set(members)) or set(members) != expected:
            raise ValueError(f"Standalone ZIP members differ: missing={sorted(expected - set(members))}, unexpected={sorted(set(members) - expected)}")
        if json.loads(zipped.read(f"{package_name}/package.json")) != consumer_package(manifest, version):
            raise ValueError("Standalone ZIP published SDK dependency or example scripts differ")
        for member in members:
            if not member.endswith(".md"):
                continue
            # Generated guides use ordinary inline links; validate their actual archived destinations.
            # 生成指南使用普通内联链接；校验其实际归档目标。
            markdown = zipped.read(member).decode("utf-8")
            for link in re.findall(r"\[[^\]]*\]\(([^)]+)\)", markdown):
                # Remote links have no archive target; relative links must stay inside this package.
                # 远程链接没有归档目标；相对链接必须保持在此包内。
                parsed = urlsplit(link)
                if parsed.scheme or parsed.netloc:
                    continue
                # Normalize only the documented relative URL path, without searching alternatives.
                # 仅规范化文档中的相对 URL 路径，不搜索替代项。
                destination = posixpath.normpath(posixpath.join(posixpath.dirname(member), unquote(parsed.path)))
                if destination not in expected:
                    raise ValueError(f"Standalone ZIP broken documentation link: {member} -> {link}")
    return [entry["name"] for entry in manifest["examples"]]


def archive_package(root, archive, version):
    """Write only declared files from the staged package and verify the resulting ZIP.
    仅写入暂存包声明文件，并验证生成 ZIP。
    root is the staged package; archive is a new output; version pins its SDK dependency.
    root 是暂存包；archive 是新输出；version 固定其 SDK 依赖。
    """
    # Source membership never expands after npm/runtime installation adds generated files.
    # npm 或运行时安装增加生成文件后，源码成员绝不扩展。
    manifest = release_manifest()
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_STORED) as zipped:
        for name in sorted(member_files(manifest)):
            # Explicit regular-file metadata prevents fresh staging mtimes or platform defaults from changing the hash.
            # 显式普通文件元数据阻止新暂存时间或平台默认值改变摘要。
            member = zipfile.ZipInfo(f"{root.name}/{name}", ZIP_TIMESTAMP)
            member.create_system = 3
            member.external_attr = (0o100644 << 16)
            member.compress_type = zipfile.ZIP_STORED
            zipped.writestr(member, (root / name).read_bytes())
    return verify_archive(archive, root.name, version)


def smoke_package(root):
    """Run every selected published example using the staged package's installed SDK.
    使用暂存包已安装 SDK 运行每个选定已发布示例。
    root identifies the installed consumer; returns after all real example processes succeed.
    root 标识已安装消费端；全部真实示例进程成功后返回。
    """
    for entry in release_manifest()["examples"]:
        subprocess.run(["node", f"examples/{entry['name']}.mjs"], cwd=root, check=True)


def main():
    """Dispatch explicit local stage/smoke/archive/verify operations without publishing.
    分发显式本地暂存、冒烟、归档及验证操作，不执行发布。
    CLI arguments identify exact paths and versions; returns only after the selected operation succeeds.
    CLI 参数标识精确路径及版本；所选操作成功后才返回。
    """
    # Subcommands keep staging, installed smoke and final artifact verification independently reviewable.
    # 子命令保持暂存、安装后冒烟及最终产物验证可独立审核。
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("stage", "smoke", "archive", "verify"):
        # Each command requires only its own concrete inputs.
        # 每个命令仅要求自身具体输入。
        command = commands.add_parser(name)
        if name != "verify":
            command.add_argument("--root", type=Path, required=True)
        if name != "smoke":
            command.add_argument("--version", required=True)
        if name in ("archive", "verify"):
            command.add_argument("--archive", type=Path, required=True)
        if name == "verify":
            command.add_argument("--package-name", required=True)
    # Parsed arguments never trigger candidate/native discovery.
    # 解析后的参数绝不触发候选或原生发现。
    args = parser.parse_args()
    if args.command == "stage":
        stage_package(args.root, args.version)
    elif args.command == "smoke":
        smoke_package(args.root)
    elif args.command == "archive":
        print(json.dumps({"verified_examples": archive_package(args.root, args.archive, args.version)}))
    else:
        print(json.dumps({"verified_examples": verify_archive(args.archive, args.package_name, args.version)}))


if __name__ == "__main__":
    main()
