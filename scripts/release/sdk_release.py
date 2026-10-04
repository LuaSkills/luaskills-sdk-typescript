"""Bind one npm archive to its SDK source and the shared core release gate.
将单个 npm 归档绑定到 SDK 源码与公共核心发布门禁。
"""

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

# Resolve only this repository; core definitions are imported from the caller's frozen checkout.
# 仅解析本仓库；核心定义从调用者指定的冻结检出导入。
ROOT = Path(__file__).resolve().parents[2]
# This is the SDK evidence format, independent of the core candidate schema.
# 这是 SDK 证据格式，与核心候选清单结构版本独立。
SDK_SCHEMA = 1
# Persistent release assets have one naming authority shared by issuer and consumer.
# 持久发布资产只有一个命名权威，供签发方与消费方共同使用。
RELEASE_FILES = {"artifact": "sdk-artifact.json", "aggregate": "sdk-aggregate.json",
                 "consumer": "sdk-formal-consumer.json", "core": "sdk-core-prerequisites.tar.gz"}
# GitHub requires each Release asset to remain below this single shared byte boundary.
# GitHub 要求每个 Release 资产低于这个单一共享字节边界。
MAX_RELEASE_ASSET_BYTES = 2 * 1024 * 1024 * 1024
# Candidate and completion subjects remain physically separate; the main release receives only candidate bytes.
# 候选及完成主体物理分离；主 Release 仅接收候选字节。
SDK_WORKFLOW = ".github/workflows/sdk-release.yml"
EXAMPLES_WORKFLOW = ".github/workflows/examples-release.yml"
EXAMPLES_MANIFEST = "examples-candidate-manifest.json"
EXAMPLES_ATTESTATION = "examples-candidate-attestation.jsonl"
CANDIDATE_MANIFEST = "sdk-candidate-manifest.json"
CANDIDATE_BUNDLE = "sdk-candidate-bundle.tar.gz"
CANDIDATE_ATTESTATION = "sdk-candidate-attestation.jsonl"
COMPLETION_MANIFEST = "sdk-completion-manifest.json"
COMPLETION_ATTESTATION = "sdk-completion-attestation.jsonl"


class SDKTagMissing(ValueError):
    """Represent only an exact initial Git-ref 404, never an unresolved existing annotated tag.
    仅表示精确初始 Git 引用 404，绝不表示既有附注标签无法解析。
    """


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    """Permit HTTPS asset redirects without forwarding GitHub credentials across hosts.
    允许 HTTPS 资产重定向，同时不跨主机转发 GitHub 凭据。
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Return a safe redirected request for the supplied response or reject plaintext.
        为所给响应返回安全重定向请求，或拒绝明文。
        """
        require(urllib.parse.urlsplit(newurl).scheme == "https", "HTTPS download redirect required")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None and urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
            redirected.remove_header("Authorization")
        return redirected


def require(condition, message):
    """Raise a visible gate error when the supplied invariant is false; return nothing.
    所给不变量不成立时抛出明确门禁错误；无返回值。
    """
    if not condition:
        raise ValueError(message)


def digest(path):
    """Return SHA-256 of the exact regular input file selected by path.
    返回路径选定的精确普通输入文件 SHA-256。
    """
    require(Path(path).is_file(), f"Missing regular file: {path}")
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pairs(entries):
    """Reject duplicate JSON object keys and return their unique mapping.
    拒绝重复 JSON 对象键并返回唯一映射。
    """
    result = {}
    for key, value in entries:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    """Read one explicit UTF-8 JSON file using duplicate-key rejection; return its object.
    使用重复键拒绝读取单个显式 UTF-8 JSON 文件；返回其对象。
    """
    value = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=pairs)
    require(isinstance(value, dict), f"Expected JSON object: {path}")
    return value


def write_json(path, value):
    """Exclusively create the requested evidence JSON; existing evidence always fails.
    独占创建请求的证据 JSON；已有证据一律失败。
    """
    filename = Path(path)
    filename.parent.mkdir(parents=True, exist_ok=True)
    with filename.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")


def run(arguments, cwd=ROOT, env=None, timeout=120, log_prefix=None):
    """Run the exact argument vector without a shell; return stdout or propagate failure.
    不经 shell 运行精确参数向量；返回标准输出或传播失败。
    """
    executable = shutil.which(str(arguments[0]))
    require(executable is not None, f"Missing command: {arguments[0]}")
    try:
        # Capture bytes so Windows text-reader threads cannot discard invalid UTF-8 before timeout.
        # 捕获字节，防止 Windows 文本读取线程在超时前丢弃无效 UTF-8。
        completed = subprocess.run([executable, *map(str, arguments[1:])], cwd=cwd, env=env,
                                   capture_output=True, timeout=timeout)
    # The timeout exception owns partial bytes even when the normal runner requests text.
    # 即使普通运行器请求文本，超时异常仍拥有部分输出字节。
    except subprocess.TimeoutExpired as error:
        # Display both actual partial streams before attempting any filesystem persistence.
        # 在任何文件系统持久化前显示两路真实部分输出。
        for content, terminal in ((error.output, sys.stdout), (error.stderr, sys.stderr)):
            if content is not None:
                try:
                    terminal.buffer.write(content)
                    terminal.buffer.flush()
                # The original timeout remains authoritative even if a terminal pipe fails.
                # 即使终端管道失败，原超时仍为权威。
                except OSError as terminal_error:
                    error.add_note(f"Partial stream display failed: {type(terminal_error).__name__} errno={terminal_error.errno}")
        if log_prefix is not None:
            try:
                # Use only the original destination; None never creates invented bytes or files.
                # 仅使用原目的地；None 绝不制造字节或文件。
                prefix = Path(log_prefix)
                prefix.parent.mkdir(parents=True, exist_ok=True)
                # Save each observed byte stream exclusively under its existing exact suffix.
                # 将每路已观察字节流独占保存到既有精确后缀。
                for suffix, content in (("stdout.log", error.output), ("stderr.log", error.stderr)):
                    if content is not None:
                        # Binary preservation cannot overwrite previous evidence or normalize partial output.
                        # 二进制保留不能覆盖以前证据，也不能归一化部分输出。
                        with Path(str(prefix) + "." + suffix).open("xb") as stream:
                            stream.write(content)
            # Persistence failures are secondary diagnostics, never a replacement process failure.
            # 持久化失败是次要诊断，绝不是替代的进程失败。
            except OSError as log_error:
                # Include only safe exception type/errno, never paths, child arguments or environment.
                # 仅包含安全异常类型及 errno，绝不包含路径、子进程参数或环境。
                diagnostic = f"Partial log persistence failed: {type(log_error).__name__} errno={log_error.errno}"
                error.add_note(diagnostic)
                try:
                    sys.stderr.buffer.write((diagnostic + "\n").encode("ascii"))
                    sys.stderr.buffer.flush()
                # Keep the first safe note even when its terminal diagnostic cannot be written.
                # 即使终端诊断无法写入，也保留首个安全异常注记。
                except OSError as diagnostic_error:
                    error.add_note(f"Partial log diagnostic display failed: {type(diagnostic_error).__name__} errno={diagnostic_error.errno}")
        raise
    # Preserve the existing strict UTF-8 and universal-newline contract after real completion.
    # 真实完成后保留既有严格 UTF-8 及通用换行契约。
    completed.stdout = completed.stdout.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    completed.stderr = completed.stderr.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if log_prefix is not None:
        # Preserve raw success/error streams before checking the result; candidate signatures include these exact logs.
        # 检查结果前保留原始成功、错误流；候选签名包含这些精确日志。
        prefix = Path(log_prefix)
        prefix.parent.mkdir(parents=True, exist_ok=True)
        for suffix, content in (("stdout.log", completed.stdout), ("stderr.log", completed.stderr)):
            with Path(str(prefix) + "." + suffix).open("x", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
    require(completed.returncode == 0,
            f"Command failed ({completed.returncode}): {arguments}\n{completed.stdout}\n{completed.stderr}")
    return completed.stdout.strip()


def authority(core_root, commit=None):
    """Import core candidate definitions from an exact clean checkout and return the module.
    从精确干净检出导入核心候选定义并返回模块。
    """
    root = Path(core_root).resolve(strict=True)
    require((root / "scripts/release/sdk_prerequisites.py").is_file(), "Shared core gate is missing")
    if commit is not None:
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid core commit")
        require(run(["git", "rev-parse", "HEAD"], root) == commit, "Core checkout SHA mismatch")
        require(not run(["git", "status", "--porcelain", "--untracked-files=no"], root), "Core checkout is dirty")
    directory = root / "scripts/release"
    # Core's adjacent imports resolve from the same frozen directory, never a second SDK copy.
    # 核心相邻导入来自同一冻结目录，绝不来自 SDK 的第二份复制。
    sys.path.insert(0, str(directory))
    specification = importlib.util.spec_from_file_location("candidate", directory / "candidate.py")
    module = importlib.util.module_from_spec(specification)
    sys.modules["candidate"] = module
    specification.loader.exec_module(module)
    return module


def shared_gate(core_root):
    """Import the public prerequisite helper from the same verified core checkout; return it.
    从同一已验证核心检出导入公共前置 helper；返回该模块。
    """
    specification = importlib.util.spec_from_file_location("sdk_prerequisites", Path(core_root).resolve() / "scripts/release/sdk_prerequisites.py")
    shared = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(shared)
    return shared


def recovery_authority(core_root):
    """Import the frozen core's recovery API and its authenticated HTTP transport; return both modules.
    导入冻结核心的恢复 API 及认证 HTTP 传输；返回两个模块。
    """
    # Fresh CLI processes must initialize the same Core candidate and adjacent imports before loading recovery.
    # 全新 CLI 进程须在加载恢复模块前初始化同一 Core candidate 及相邻导入。
    authority(core_root)
    shared = shared_gate(core_root)
    sys.modules["sdk_prerequisites"] = shared
    path = Path(core_root).resolve() / "scripts/release/sdk_recovery.py"
    require(path.is_file(), "Frozen shared SDK recovery API is missing")
    specification = importlib.util.spec_from_file_location("sdk_recovery", path)
    recovery = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(recovery)
    return recovery, shared


def core_proof_members(prerequisites_path, shared):
    """Select validated Core proof files for both signed SDK stages; return relative-name/Path pairs.
    为 SDK 两个签名阶段选择已验证 Core 证明文件；返回相对名称与 Path 映射。
    prerequisites_path identifies the complete original report; shared is the frozen Core prerequisite authority.
    prerequisites_path 指定完整原报告；shared 为冻结 Core 前置条件权威。
    """
    # Keep every audit byte; only exact official auxiliary/copy archives are redundant for SDK consumers.
    # 保留全部审计字节；仅精确正式辅助归档及归档副本对 SDK 消费者冗余。
    root = Path(prerequisites_path).resolve(strict=True).parent
    # Members retain all otherwise unclassified files, never a broad prefix or size-based exclusion.
    # Members 保留所有未分类文件，绝不采用宽泛前缀或按大小排除。
    members = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink() and path.resolve().is_relative_to(root), "Core proof contains an escaping path or symlink")
        if path.is_file():
            members[path.relative_to(root).as_posix()] = path
    # Core owns the complete report and all five native/source/build/contract byte checks.
    # Core 拥有完整报告及全部五平台原生、源码、构建、契约字节校验。
    core = shared.candidate
    proof = core.read_json(Path(prerequisites_path))
    require(proof["phase"] == "complete" and proof["complete"] is True and isinstance(proof["registry"], dict),
            "Complete Core proof is required before SDK member selection")
    for platform in core.PLATFORMS:
        shared.resolve_sdk_inputs(prerequisites_path, platform)
    # Manifest source ownership is already authenticated by the original Core resolver.
    # Manifest 的源码归属已由原 Core 解析器认证。
    manifest = core.read_json(root / "candidate/candidate-manifest.json")
    # Archive names derive solely from the frozen Core declarations and authenticated source record.
    # 归档名仅从冻结 Core 声明及已认证源码记录派生。
    archives = {f"luaskills-{family}-{platform}.tar.gz" for platform in core.PLATFORMS for family in core.ARCHIVE_FAMILIES}
    source_name = manifest["source_archive"]["name"]
    # Manifest hashes bind auxiliary archives as well as the required FFI/source originals.
    # Manifest 摘要绑定辅助归档及必需 FFI、源码原件。
    manifest_hashes = {name: sha for record in manifest["platforms"] for name, sha in record["archives"].items()}
    manifest_hashes[source_name] = manifest["source_archive"]["sha256"]
    # Exact paths exclude only auxiliary candidate archives and all downloaded archive copies.
    # 精确路径仅排除候选辅助归档及全部已下载归档副本。
    excluded = {"candidate/" + name for name in archives if name not in {f"luaskills-ffi-sdk-{platform}.tar.gz" for platform in core.PLATFORMS}}
    excluded.update("downloads/assets/" + name for name in archives | {source_name})
    for name in sorted(archives | {source_name}):
        # Both actual copies must equal the official asset and authenticated candidate manifest before omission.
        # 省略前，两份实际副本必须均等于正式资产及已认证候选清单。
        expected = proof["github"]["assets"][name]["sha256"]
        require(expected == manifest_hashes[name], "Core archive manifest differs from official asset: " + name)
        for relative in ("candidate/" + name, "downloads/assets/" + name):
            require(relative in members and core.digest(members[relative].read_bytes()) == expected,
                    "Core archive copy is missing or differs from official asset: " + relative)
    return {name: path for name, path in members.items() if name not in excluded}


def workflow_job_name(workflow_path, job_id):
    """Read one explicitly named job from the frozen workflow's restricted layout; return its literal template.
    从冻结工作流限定布局读取一个显式作业名；返回其字面模板。
    """
    text = (ROOT / workflow_path).read_text(encoding="utf-8")
    matches = re.findall(r"^  " + re.escape(job_id) + r":\n(.*?)(?=^  [a-z][a-z-]*:|\Z)", text, re.MULTILINE | re.DOTALL)
    require(len(matches) == 1, "Frozen workflow job must exist exactly once: " + job_id)
    names = re.findall(r"^    name: ([^\n]+)$", matches[0], re.MULTILINE)
    require(len(names) == 1, "Frozen workflow job must declare one explicit name: " + job_id)
    return names[0]


def candidate_jobs(core_root, include_evidence=True):
    """Derive every required SDK candidate job name from the frozen workflow and core platforms.
    从冻结工作流及核心平台派生每个 SDK 候选必需作业名。
    """
    core = authority(core_root)
    template = workflow_job_name(SDK_WORKFLOW, "native")
    require(template.count("${{ matrix.platform }}") == 1, "Native job must name its exact core platform")
    names = [workflow_job_name(SDK_WORKFLOW, name) for name in ("prepare", "aggregate")]
    names.extend(template.replace("${{ matrix.platform }}", key) for key in core.PLATFORMS)
    if include_evidence:
        names.append(workflow_job_name(SDK_WORKFLOW, "candidate-evidence"))
    return names


def write_files(directory, files):
    """Exclusively materialize verified root files below a new directory; reject any nonportable name.
    在新目录下独占落盘已验证根文件；拒绝任何不可移植名称。
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    for name, body in files.items():
        relative_member(name)
        require(Path(name).name == name, "Evidence requires root filenames")
        with (directory / name).open("xb") as stream:
            stream.write(body)


def unpack_core(archive, directory):
    """Extract only canonical regular core-proof members into a fresh directory; return its prerequisite path.
    仅把规范普通核心证明成员解包到新目录；返回前置证明路径。
    """
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    with tarfile.open(archive, "r:gz") as bundle:
        names = set()
        for member in bundle.getmembers():
            relative_member(member.name)
            require(member.isfile() and member.name not in names, "Unsafe/duplicate core proof member")
            names.add(member.name)
            path = directory / member.name
            require(path.resolve().is_relative_to(directory), "Core proof escapes its root")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(bundle.extractfile(member).read())
    require((directory / "prerequisites.json").is_file(), "Core prerequisite is missing from the signed proof")
    return directory / "prerequisites.json"
def relative_member(name):
    """Require a canonical nonempty relative archive path without empty or dot components.
    要求规范非空相对归档路径，不允许空分量或点分量。
    """
    require(isinstance(name, str) and name and ":" not in name and "\\" not in name
            and all(part not in ("", ".", "..") for part in name.split("/"))
            and not Path(name).is_absolute(), f"Unsafe relative archive path: {name}")
    return name


def default_tag(text):
    """Read the unique declared DEFAULT_LUASKILLS_VERSION literal; return its tag.
    读取唯一声明的 DEFAULT_LUASKILLS_VERSION 字面量；返回其标签。
    """
    matches = re.findall(r'export const DEFAULT_LUASKILLS_VERSION\s*=\s*"([^"\n]+)";', text)
    require(len(matches) == 1, "Expected one default core asset declaration")
    return matches[0]


def versions(root):
    """Check package.json's authoritative version against VERSION and lock mirrors; return it.
    校验 package.json 权威版本与 VERSION、锁镜像一致；返回该版本。
    """
    package = read_json(Path(root) / "package.json")
    version = package["version"]
    require(package["name"] == "@luaskills/sdk", "Unexpected SDK package name")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version), "Invalid SDK version")
    require((Path(root) / "VERSION").read_text(encoding="utf-8").strip() == version, "VERSION mismatch")
    lock = read_json(Path(root) / "package-lock.json")
    require(lock["version"] == version and lock["packages"][""]["version"] == version, "Lock version mismatch")
    require(lock["name"] == package["name"] and lock["packages"][""]["name"] == package["name"], "Lock name mismatch")
    return version


def freeze(args):
    """Freeze clean SDK/workflow/core source SHAs and exact version/default tag; write evidence.
    冻结干净 SDK、工作流、核心源码 SHA 及精确版本、默认标签；写入证据。
    """
    require(re.fullmatch(r"[0-9a-f]{40}", args.sdk_source_sha), "Invalid SDK source SHA")
    require(args.sdk_source_sha == args.workflow_source_sha, "Workflow source must equal SDK source")
    require(run(["git", "rev-parse", "HEAD"]) == args.sdk_source_sha, "SDK checkout SHA mismatch")
    require(not run(["git", "status", "--porcelain", "--untracked-files=no"]), "Tracked SDK source must be clean before building")
    authority(args.core_root, args.core_commit)
    version = versions(ROOT)
    require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", args.core_tag), "Explicit core release tag required")
    require(default_tag((ROOT / "src/runtime-assets.ts").read_text(encoding="utf-8")) == args.core_tag,
            "Default core asset tag differs from explicit prerequisite tag")
    write_json(args.output, {"schema_version": SDK_SCHEMA, "sdk_source_sha": args.sdk_source_sha,
                           "workflow_source_sha": args.workflow_source_sha, "sdk_version": version,
                           "core_tag": args.core_tag, "core_commit": args.core_commit,
                           "lock_sha256": digest(ROOT / "package-lock.json")})


def archive_files(archive):
    """Read regular package/ members without filesystem extraction; reject unsafe members.
    不解压到文件系统地读取 package/ 普通成员；拒绝不安全成员。
    """
    files = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            require(member.name.startswith("package/") and ".." not in member.name.split("/")
                    and "\\" not in member.name and ":" not in member.name, f"Unsafe npm member: {member.name}")
            require(member.isfile(), f"Non-regular npm member: {member.name}")
            relative = relative_member(member.name.removeprefix("package/"))
            require(relative and relative not in files, f"Duplicate npm member: {relative}")
            files[relative] = bundle.extractfile(member).read()
    return files


def artifact(args):
    """Verify the one built tgz against frozen source and package defaults; write its identity.
    对照冻结源码与包默认值验证唯一构建的 tgz；写入其身份。
    """
    frozen = read_json(args.freeze)
    require(frozen["schema_version"] == SDK_SCHEMA, "Unsupported SDK freeze schema")
    require(run(["git", "rev-parse", "HEAD"]) == frozen["sdk_source_sha"], "SDK source changed")
    require(not run(["git", "status", "--porcelain", "--untracked-files=no"]), "Tracked SDK source changed before packing")
    require(versions(ROOT) == frozen["sdk_version"] and digest(ROOT / "package-lock.json") == frozen["lock_sha256"], "SDK version/lock changed")
    archive = Path(args.archive).resolve(strict=True)
    files = archive_files(archive)
    require(json.loads(files["package.json"], object_pairs_hook=pairs)["version"] == frozen["sdk_version"], "Packed version mismatch")
    require(files["VERSION"].decode().strip() == frozen["sdk_version"], "Packed VERSION mismatch")
    for name in ("src/runtime-assets.ts", "dist/runtime-assets.js"):
        require(default_tag(files[name].decode()) == frozen["core_tag"], "Packed default asset tag mismatch")
    # Reuse the established distribution/codec verifier against the archive built once in this checkout.
    # 对本检出只构建一次的归档复用既有分发、编码器验证器。
    run(["node", ROOT / "scripts/verify-embedded-distribution.mjs", archive])
    write_json(args.output, {**frozen, "archive": archive.name, "tgz_sha256": digest(archive)})


def validate_artifact(record, archive):
    """Reject malformed artifact identity or different tgz bytes; return nothing.
    拒绝畸形产物身份或不同 tgz 字节；无返回值。
    """
    expected = {"schema_version", "sdk_source_sha", "workflow_source_sha", "sdk_version", "core_tag", "core_commit", "lock_sha256", "archive", "tgz_sha256"}
    require(set(record) == expected and type(record["schema_version"]) is int and record["schema_version"] == SDK_SCHEMA, "Invalid artifact schema")
    for key in ("sdk_source_sha", "workflow_source_sha", "core_commit"):
        require(re.fullmatch(r"[0-9a-f]{40}", record[key]), f"Invalid {key}")
    for key in ("lock_sha256", "tgz_sha256"):
        require(re.fullmatch(r"[0-9a-f]{64}", record[key]), f"Invalid {key}")
    require(record["sdk_source_sha"] == record["workflow_source_sha"], "Artifact workflow SHA mismatch")
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", record["sdk_version"]), "Invalid artifact version")
    require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", record["core_tag"]), "Invalid artifact core tag")
    require(record["archive"] == Path(record["archive"]).name and "\\" not in record["archive"]
            and record["archive"].endswith(".tgz"), "Unsafe artifact archive filename")
    require(Path(archive).name == record["archive"] and digest(archive) == record["tgz_sha256"], "Artifact bytes changed")
    files = archive_files(archive)
    package = json.loads(files["package.json"], object_pairs_hook=pairs)
    require(package["name"] == "@luaskills/sdk" and package["version"] == record["sdk_version"]
            and files["VERSION"].decode().strip() == record["sdk_version"], "Artifact package version/name mismatch")
    require(default_tag(files["src/runtime-assets.ts"].decode()) == record["core_tag"]
            and default_tag(files["dist/runtime-assets.js"].decode()) == record["core_tag"], "Artifact default core asset tag mismatch")


def prerequisites(record, core, identity):
    """Validate shared complete evidence and its exact platform identities; return the record.
    校验公共完整证据及其精确平台身份；返回该记录。
    """
    require(type(record["schema_version"]) is int and record["schema_version"] == core.MANIFEST_VERSION, "Unsupported core prerequisite schema")
    require(record["phase"] == "complete" and record["complete"] is True and isinstance(record["registry"], dict), "Complete registry-consumer prerequisite required")
    require(record["core_tag"] == identity["core_tag"] and record["core_commit"] == identity["core_commit"], "Core prerequisite identity mismatch")
    require(record["core_tag"] == "v" + record["core_version"], "Core tag/version mismatch")
    registry = record["registry"]
    require(registry["name"] == "luaskills" and registry["version"] == record["core_version"]
            and registry["vcs_commit"] == record["core_commit"], "Registry core identity mismatch")
    consumer = registry["consumer"]
    require(set(consumer) == {"commands", "executable", "executable_sha256", "cargo_lock_sha256", "package_id", "source", "result"},
            "Invalid actual registry consumer schema")
    require(len(consumer["commands"]) == 4, "Complete actual registry command evidence required")
    for command in consumer["commands"]:
        require(set(command) == {"command", "exit_code", "stdout_sha256", "stderr_sha256"}
                and type(command["exit_code"]) is int and command["exit_code"] == 0
                and isinstance(command["command"], list) and command["command"]
                and all(isinstance(value, str) for value in command["command"]), "Registry command failed or missing")
        for key in ("stdout_sha256", "stderr_sha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", command[key]), "Invalid actual registry log digest")
    result = consumer["result"]
    require(set(result) == {"challenge", "runtime", "pool_reuse", "capability_calls", "drained"}
            and re.fullmatch(r"[0-9a-f]{64}", result["challenge"])
            and result["runtime"] is True and result["pool_reuse"] is True and result["drained"] is True
            and type(result["capability_calls"]) is int and result["capability_calls"] == 2,
            "Real registry runtime/callback/drain proof required")
    require(set(record["sdk_inputs"]) == set(core.PLATFORMS), "Missing or unexpected core platform")
    for key, value in record["sdk_inputs"].items():
        require(type(value["schema_version"]) is int and value["schema_version"] == core.MANIFEST_VERSION and value["platform"] == key
                and value["source_commit"] == record["core_commit"] and value["core_version"] == record["core_version"], "Invalid platform core identity")
        for field in ("library_sha256", "description_sha256", "archive_sha256"):
            require(re.fullmatch(r"[0-9a-f]{64}", value[field]), f"Invalid core {field}")
    return record


def matrix(args):
    """Derive native jobs from core's unique platform set; print the runner matrix.
    从核心唯一平台集合派生原生任务；输出执行器矩阵。
    """
    core = authority(args.core_root)
    # These are runner routing labels, not a copied core platform/asset declaration.
    # 这些是执行器路由标签，不是复制的核心平台、资产声明。
    runners = {("linux", "x86_64"): "ubuntu-24.04", ("linux", "aarch64"): "ubuntu-24.04-arm",
               ("macos", "x86_64"): "macos-15-intel", ("macos", "aarch64"): "macos-15",
               ("windows", "x86_64"): "windows-2025"}
    value = {"include": [{"platform": name, "runner": runners[(entry[1], entry[2])]}
                          for name, entry in core.PLATFORMS.items()]}
    write_json(args.output, value)
    print(json.dumps(value, separators=(",", ":")))


def native_inputs(args, identity):
    """Resolve only the contract's fixed platform paths and recheck all bytes; return inputs.
    仅解析契约固定平台路径并重新校验全部字节；返回输入。
    """
    core = authority(args.core_root, identity["core_commit"])
    document = prerequisites(read_json(args.prerequisites), core, identity)
    system = {"Linux": "linux", "Darwin": "macos", "Windows": "windows"}[platform.system()]
    machine = {"AMD64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}[platform.machine()]
    if args.platform == "host":
        selected = [name for name, value in core.PLATFORMS.items() if (value[1], value[2]) == (system, machine)]
        require(len(selected) == 1, "Host must resolve to exactly one core platform")
        args.platform = selected[0]
    require(args.platform in core.PLATFORMS, "Unknown core platform")
    target = core.PLATFORMS[args.platform]
    require((system, machine) == (target[1], target[2]), "Native platform must match the actual runner")
    # Path relocation and byte verification belong only to the core's shared input resolver.
    # 路径重定位、字节校验仅属于核心公共输入解析器。
    record = shared_gate(args.core_root).resolve_sdk_inputs(Path(args.prerequisites).resolve(), args.platform)
    library = Path(record["library"])
    description = Path(record["description"])
    decoded = read_json(description)
    require(decoded["core_version"] == document["core_version"] and decoded["build"] == record["build"], "Core description/build identity mismatch")
    return record, library.resolve(), description.resolve(), decoded


def parse_native(stdout, description):
    """Require exactly one completed callback/close result from the real child; return it.
    要求真实子进程恰有一个回调、关闭完成结果；返回该结果。
    """
    results = [json.loads(line, object_pairs_hook=pairs) for line in stdout.splitlines() if line.startswith("{")]
    require(len(results) == 1, "Missing or ambiguous native evidence")
    result = results[0]
    require(set(result) == {"core_version", "protocol_version", "contract_sha256", "callback_count", "scope"}, "Invalid native result schema")
    require(type(result["callback_count"]) is int and result["callback_count"] == 2 and result["scope"] == "closed", "Native callbacks/close did not complete")
    require(result["core_version"] == description["core_version"] and result["protocol_version"] == description["protocol_version"]
            and result["contract_sha256"] == description["build"]["contract_sha256"], "Native result/core mismatch")
    return result


def native(args):
    """Run the existing installed-package gate against exact core bytes; write success only afterward.
    对精确核心字节运行既有安装包门禁；仅随后写入成功。
    """
    identity = read_json(args.artifact)
    archive = Path(args.artifact).resolve().parent / identity["archive"]
    validate_artifact(identity, archive)
    require(run(["git", "rev-parse", "HEAD"]) == identity["sdk_source_sha"], "Native verifier SDK source mismatch")
    require(digest(ROOT / "package-lock.json") == identity["lock_sha256"], "Native verifier lock mismatch")
    inputs, library, description, decoded = native_inputs(args, identity)
    files = archive_files(archive)
    # No TypeScript rebuild occurs in matrix jobs: the verifier's baseline is the tested tgz itself.
    # 矩阵任务不重新构建 TypeScript；验证器基线就是被测 tgz 本身。
    with tempfile.TemporaryDirectory(prefix="luaskills-sdk-native-") as temporary:
        baseline = Path(temporary)
        for name, content in files.items():
            output = baseline / name
            require(output.resolve().is_relative_to(baseline.resolve()), "Npm member escapes verifier baseline")
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(content)
        shutil.copyfile(ROOT / "package-lock.json", baseline / "package-lock.json")
        shutil.copyfile(ROOT / "scripts/verify-embedded-candidate.mjs", baseline / "scripts/verify-embedded-candidate.mjs")
        stdout = run(["npm", "run", "test:embedded-candidate", "--", archive, library,
                      inputs["library_sha256"], description], baseline, timeout=180,
                     log_prefix=Path(args.output).parent / "native")
    result = parse_native(stdout, decoded)
    write_json(args.output, {"schema_version": SDK_SCHEMA, "platform": args.platform, "artifact": identity,
                           "core_input": {k: v for k, v in inputs.items() if k not in ("library", "description")},
                           "test": result, "success": True, "skipped": False})


def aggregate(args):
    """Reject missing, duplicate, skipped or tampered platform results; write complete SDK proof.
    拒绝缺失、重复、跳过或篡改的平台结果；写入完整 SDK 证明。
    """
    identity = read_json(args.artifact)
    validate_artifact(identity, Path(args.artifact).resolve().parent / identity["archive"])
    core = authority(args.core_root, identity["core_commit"])
    document = prerequisites(read_json(args.prerequisites), core, identity)
    shared = shared_gate(args.core_root)
    descriptions = {}
    for name in core.PLATFORMS:
        verified = shared.resolve_sdk_inputs(Path(args.prerequisites).resolve(), name)
        description = read_json(verified["description"])
        require(type(description["protocol_version"]) is int and description["protocol_version"] > 0
                and description["core_version"] == document["core_version"]
                and description["build"] == document["sdk_inputs"][name]["build"], "Actual core description identity mismatch")
        descriptions[name] = description
    records = {}
    for path in sorted(Path(args.evidence_dir).rglob("*.json")):
        record = read_json(path)
        require(set(record) == {"schema_version", "platform", "artifact", "core_input", "test", "success", "skipped"}, "Invalid platform evidence schema")
        name = record["platform"]
        require(name in core.PLATFORMS and name not in records, "Duplicate or unexpected platform evidence")
        require(type(record["schema_version"]) is int and record["schema_version"] == SDK_SCHEMA and record["artifact"] == identity, "SDK artifact identity mismatch")
        require(record["success"] is True and record["skipped"] is False, "Native failure/skip is not success")
        expected = document["sdk_inputs"][name]
        require(record["core_input"] == {k: v for k, v in expected.items() if k not in ("library", "description")}, "Platform core identity mismatch")
        test = record["test"]
        require(set(test) == {"core_version", "protocol_version", "contract_sha256", "callback_count", "scope"}, "Invalid platform test schema")
        require(test["callback_count"] == 2 and test["scope"] == "closed" and test["core_version"] == document["core_version"]
                and test["contract_sha256"] == expected["build"]["contract_sha256"], "Incomplete native test")
        require(type(test["protocol_version"]) is int and test["protocol_version"] > 0, "Invalid native protocol")
        require(test["protocol_version"] == descriptions[name]["protocol_version"], "Native protocol differs from actual core description")
        records[name] = record
    require(set(records) == set(core.PLATFORMS), "Missing native platform evidence")
    require(len({record["test"]["protocol_version"] for record in records.values()}) == 1, "Platform protocol drift")
    write_json(args.output, {"schema_version": SDK_SCHEMA, "artifact": identity, "platforms": records,
                           "prerequisites_sha256": digest(args.prerequisites), "complete": True})


def request_json(url):
    """Read JSON from the explicit official npm URL; return its object or fail visibly.
    从显式官方 npm URL 读取 JSON；返回对象或明确失败。
    """
    require(url.startswith("https://registry.npmjs.org/"), "Official npm registry required")
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read(), object_pairs_hook=pairs)


def registry_package(identity, directory):
    """Download the exact official npm version and require the tested tgz digest; return metadata.
    下载精确官方 npm 版本并要求被测 tgz 摘要；返回元数据。
    """
    metadata = request_json(f"https://registry.npmjs.org/@luaskills%2fsdk/{identity['sdk_version']}")
    require(metadata["name"] == "@luaskills/sdk" and metadata["version"] == identity["sdk_version"], "Registry package/version mismatch")
    url = metadata["dist"]["tarball"]
    require(url.startswith("https://registry.npmjs.org/@luaskills/sdk/-/"), "Unexpected registry tarball origin")
    with urllib.request.urlopen(url, timeout=60) as response:
        content = response.read()
    require(hashlib.sha256(content).hexdigest() == identity["tgz_sha256"], "Formal npm tarball differs from tested archive")
    (Path(directory) / identity["archive"]).write_bytes(content)
    return metadata


def npm_process_diagnostics(command, stdout, stderr, returncode, log_prefix, timeout_error=None):
    """Display actual npm bytes/status and exclusively save optional raw logs; never replace process errors.
    显示实际 npm 字节及状态并独占保存可选原始日志，绝不替代子进程错误。
    command is the exact argv, stdout/stderr are observed optional bytes, returncode is the actual exit or None.
    command 是精确参数，stdout/stderr 是观察到的可选字节，returncode 是实际退出值或 None。
    log_prefix selects the sole evidence destination; timeout_error retains the original timeout identity.
    log_prefix 选择唯一证据目的地；timeout_error 保留原超时身份。
    Return nothing; filesystem and terminal failures are secondary type/errno diagnostics only.
    无返回值；文件系统及终端失败仅是次要类型和 errno 诊断。
    """
    def secondary_failure(error):
        """Attach/display safe error type and errno; preserve error authority even if display also fails.
        附加及显示安全错误类型和 errno；即使显示也失败，仍保留原错误权威。
        """
        # Include no environment, token, path or child-output text in a secondary diagnostic.
        # 次要诊断不包含环境、令牌、路径或子进程输出正文。
        diagnostic = f"npm process diagnostic failed: {type(error).__name__} errno={error.errno}"
        if timeout_error is not None:
            timeout_error.add_note(diagnostic)
        try:
            sys.stderr.buffer.write((diagnostic + "\n").encode("ascii"))
            sys.stderr.buffer.flush()
        except OSError as display_error:
            if timeout_error is not None:
                timeout_error.add_note(f"npm diagnostic display failed: {type(display_error).__name__} errno={display_error.errno}")

    # Display observed bytes before any decode or persistence, including invalid UTF-8 partial output.
    # 在任何解码或持久化前显示已观察字节，包括无效 UTF-8 部分输出。
    for content, terminal in ((stdout, sys.stdout), (stderr, sys.stderr)):
        if content is not None:
            try:
                terminal.buffer.write(content)
                terminal.buffer.flush()
            except OSError as display_error:
                secondary_failure(display_error)
    # A timeout has no completed returncode; never fabricate an exit status for it.
    # 超时没有完成的退出值；绝不为其伪造退出状态。
    status = "npm publication process timed out\n" if timeout_error is not None else f"npm publication process returncode={returncode}\n"
    try:
        sys.stderr.buffer.write(status.encode("ascii"))
        sys.stderr.buffer.flush()
    except OSError as display_error:
        secondary_failure(display_error)
    if log_prefix is not None:
        try:
            # All names derive from the fresh publication output; old evidence is never overwritten.
            # 全部名称派生自全新发布输出；绝不覆盖旧证据。
            prefix = Path(log_prefix)
            prefix.parent.mkdir(parents=True, exist_ok=True)
            for suffix, content in (("stdout.log", stdout), ("stderr.log", stderr)):
                if content is not None:
                    with Path(str(prefix) + "." + suffix).open("xb") as stream:
                        stream.write(content)
            write_json(Path(str(prefix) + ".process.json"), {"argv":command, "cwd":str(ROOT),
                "returncode":returncode, "timed_out":timeout_error is not None,
                "observed_timeout":None if timeout_error is None else timeout_error.timeout})
        except OSError as log_error:
            secondary_failure(log_error)


def npm_publish_archive(archive, version, log_prefix=None):
    """Publish the exact archive once; return whether a documented version-conflict requires verification.
    仅发布精确归档一次；返回是否出现需复核的已定义版本冲突。
    """
    # archive/version identify the authenticated package; optional log_prefix owns raw process diagnostics.
    # archive/version 标识已认证包；可选 log_prefix 拥有原始子进程诊断。
    # JSON is npm's documented error transport; permission/service failures never imply successful publication.
    # JSON 是 npm 已定义的错误传输；权限、服务错误绝不能代表发布成功。
    executable = shutil.which("npm")
    require(executable is not None, "Missing command: npm")
    command = [executable, "publish", str(archive), "--ignore-scripts", "--provenance", "--access", "public",
               "--registry", "https://registry.npmjs.org", "--json"]
    try:
        # Capture raw streams once; preserve the original 180-second budget and inherited environment.
        # 仅捕获一次原始双流；保留原 180 秒预算及继承环境。
        completed = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=180)
    except subprocess.TimeoutExpired as error:
        npm_process_diagnostics(command, error.output, error.stderr, None, log_prefix, error)
        raise
    npm_process_diagnostics(command, completed.stdout, completed.stderr, completed.returncode, log_prefix)
    # Retain strict UTF-8 and universal newlines before the existing zero/conflict/error decisions.
    # 在原零退出、冲突及错误判定前保留严格 UTF-8 和通用换行。
    stdout = completed.stdout.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    # The original text reader rejected malformed stderr too, even for a zero exit.
    # 原文本读取器也拒绝坏标准错误编码，即使子进程零退出。
    completed.stderr.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    if completed.returncode == 0:
        return False
    failure = json.loads(stdout, object_pairs_hook=pairs)
    require(isinstance(failure, dict) and isinstance(failure.get("error"), dict), "npm publication failed without a structured error")
    error = failure["error"]
    require(isinstance(error.get("summary"), str), "npm publication failed without an error summary")
    # npm 11 rejects an existing version either with its explicit conflict code or this exact uncoded client error.
    # npm 11 以明确冲突代码或此精确无代码客户端错误拒绝既有版本。
    conflict = error.get("code") in ("EPUBLISHCONFLICT", "E409") or (
        "code" not in error and error["summary"] == f"You cannot publish over the previously published versions: {version}.")
    require(conflict, f"npm publication failed ({completed.returncode}): {error['summary']}")
    return True


def publish_or_verify(args):
    """Revalidate source/core/matrix before one npm publish or exact official-byte reuse; write its observation.
    单次 npm 发布或精确官方字节复用前重新验证源码、核心、矩阵；写入本次观测。
    """
    require(not Path(args.output).exists(), "Publication observation must be a fresh file")
    state = local_candidate(args)
    current_completion(args, state)
    require(Path(args.artifact).resolve() == state["root"] / "original" / RELEASE_FILES["artifact"]
        and Path(args.evidence_dir).resolve() == state["root"] / "native-evidence", "Publication must use the authenticated original candidate paths")
    tools(args)
    identity = read_json(args.artifact)
    archive = Path(args.artifact).resolve().parent / identity["archive"]
    validate_artifact(identity, archive)
    require(run(["git", "rev-parse", "HEAD"]) == identity["sdk_source_sha"]
            and identity["workflow_source_sha"] == identity["sdk_source_sha"], "Publication source/workflow SHA mismatch")
    require(not run(["git", "status", "--porcelain", "--untracked-files=no"]), "Publication SDK source must be clean")
    require(versions(ROOT) == identity["sdk_version"] and digest(ROOT / "package-lock.json") == identity["lock_sha256"],
            "Publication version/lock differs from the source freeze")
    with tempfile.TemporaryDirectory(prefix="luaskills-sdk-publish-") as temporary:
        # Full matrix reconstruction and actual token/default-tree checks precede both publishing and reuse.
        # 完整矩阵重建、实际令牌及默认树检查必须先于发布或复用。
        directory = Path(temporary)
        aggregate(argparse.Namespace(core_root=args.core_root, artifact=args.artifact, prerequisites=args.prerequisites,
                                  evidence_dir=args.evidence_dir, output=directory / "aggregate.json"))
        require(read_json(directory / "aggregate.json") == read_json(args.aggregate), "Publication aggregate changed")
        publication_preflight(argparse.Namespace(repository=args.repository, sdk_source_sha=identity["sdk_source_sha"],
                                             version=identity["sdk_version"], output=directory / "preflight.json"))
        # Only a 404 for this exact version endpoint means absence; a missing tarball is a broken existing package.
        # 仅此精确版本端点的 404 代表缺失；缺失 tarball 代表既有包损坏。
        version_url = f"https://registry.npmjs.org/@luaskills%2fsdk/{identity['sdk_version']}"
        try:
            metadata = registry_package(identity, directory)
            action = "reused"
        except urllib.error.HTTPError as missing:
            if missing.code != 404 or missing.url != version_url:
                raise
            missing.close()
            # Diagnostics share the original output's unique ownership, independently of publication success.
            # 诊断共享原输出的唯一归属，独立于发布是否成功。
            log_prefix = Path(args.output).with_suffix(".npm")
            race = npm_publish_archive(archive, identity["sdk_version"], log_prefix=log_prefix)
            # A zero exit or known race is still not success until a fresh official download matches the tested bytes.
            # 零退出码或已知竞争仍不是成功，必须新下载官方字节并匹配被测归档。
            metadata = registry_package(identity, directory)
            action = "race-reused" if race else "published"
    write_json(args.output, {"schema_version": SDK_SCHEMA, "artifact": identity, "action": action,
                            "aggregate_sha256": digest(args.aggregate), "prerequisites_sha256": digest(args.prerequisites),
                            "registry": {"name": metadata["name"], "version": metadata["version"],
                                         "tarball": metadata["dist"]["tarball"], "tgz_sha256": identity["tgz_sha256"]}})


def installed_bytes(identity, archive, consumer, registry):
    """Check a physical npm install and lock provenance against every tested archive member.
    对照被测归档每个成员校验物理 npm 安装与锁来源。
    """
    sdk = Path(consumer) / "node_modules/@luaskills/sdk"
    lock = read_json(Path(consumer) / "package-lock.json")["packages"]["node_modules/@luaskills/sdk"]
    require(lock["version"] == identity["sdk_version"] and lock["resolved"] == registry["tarball"]
            and lock["integrity"] == registry["integrity"], "Installed registry provenance mismatch")
    require(sdk.resolve() == sdk.absolute() and not sdk.is_symlink(), "Independent physical npm install required")
    for name, content in archive_files(archive).items():
        require((sdk / name).read_bytes() == content, f"Installed npm bytes changed: {name}")
    return sdk


def installed(args):
    """Verify the standalone smoke install is the exact already proven npm artifact.
    验证独立示例冒烟安装就是已证明的精确 npm 产物。
    """
    identity = read_json(args.artifact)
    archive = Path(args.artifact).resolve().parent / identity["archive"]
    validate_artifact(identity, archive)
    proof = read_json(args.registry_proof)
    require(proof["artifact"] == identity and proof["success"] is True, "Installed SDK proof mismatch")
    installed_bytes(identity, archive, Path(args.root).resolve(), proof["registry"])


def registry_consumer(args):
    """Install exact official npm version with a fresh cache and run its real native example.
    使用全新缓存安装精确官方 npm 版本并运行其真实原生示例。
    """
    identity = read_json(args.artifact)
    validate_artifact(identity, Path(args.artifact).resolve().parent / identity["archive"])
    inputs, library, description, decoded = native_inputs(args, identity)
    with tempfile.TemporaryDirectory(prefix="luaskills-sdk-formal-") as temporary:
        consumer = Path(temporary).resolve()
        metadata = registry_package(identity, consumer)
        (consumer / "package.json").write_text('{"name":"luaskills-formal-consumer","private":true,"type":"module"}', encoding="utf-8")
        # A new cache and explicit official registry avoid accepting the candidate cache as published proof.
        # 全新缓存和显式官方注册表避免将候选缓存当作已发布证明。
        environment = {k: v for k, v in os.environ.items() if not k.lower().startswith("npm_config_")}
        environment["NPM_CONFIG_USERCONFIG"] = str(consumer / "empty.npmrc")
        (consumer / "empty.npmrc").write_text("", encoding="utf-8")
        run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org",
             "--cache", consumer / "cache", "@luaskills/sdk@" + identity["sdk_version"]], consumer, environment, 180)
        sdk = installed_bytes(identity, consumer / identity["archive"], consumer, metadata["dist"])
        stdout = run(["node", sdk / "examples/embedded-candidate.mjs", library, description], consumer, environment)
        result = parse_native(stdout, decoded)
    write_json(args.output, {"schema_version": SDK_SCHEMA, "artifact": identity, "platform": args.platform,
                           "registry": {"name": "@luaskills/sdk", "version": identity["sdk_version"],
                                        "tarball": metadata["dist"]["tarball"], "integrity": metadata["dist"]["integrity"],
                                        "tgz_sha256": identity["tgz_sha256"]}, "test": result,
                           "success": True, "cache": "new-empty-cache"})


def github_request(repository, path, binary=False):
    """Read an exact GitHub REST path with the runner token; return JSON or original bytes.
    使用执行器令牌读取精确 GitHub REST 路径；返回 JSON 或原字节。
    """
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid GitHub repository")
    headers = {"Accept": "application/octet-stream" if binary else "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "luaskills-sdk-release", "Cache-Control": "no-cache"}
    if "GH_TOKEN" in os.environ:
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    # The repository root is the exact no-slash endpoint; nonempty REST paths retain their original bytes.
    # 仓库根为精确无尾斜杠端点；非空 REST 路径保留原字节。
    url = f"https://api.github.com/repos/{repository}" + ("" if path == "" else "/" + path)
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.build_opener(SafeRedirect()).open(request, timeout=60) as response:
        content = response.read(MAX_RELEASE_ASSET_BYTES)
        require(len(content) < MAX_RELEASE_ASSET_BYTES, "Release asset exceeds the GitHub asset size limit")
    return content if binary else json.loads(content, object_pairs_hook=pairs)


def resolve_sdk_tag(repository, tag, commit):
    """Resolve the exact lightweight or annotated SDK tag to commit; return nothing.
    将精确轻量或附注 SDK 标签解析到提交；无返回值。
    """
    # Absence belongs solely to the initial exact ref endpoint; recursive object errors remain unknown and fail closed.
    # 缺失仅属于初始精确引用端点；递归对象错误始终为未知并必须失败。
    reference_path = "git/ref/tags/" + urllib.parse.quote(tag, safe="")
    try:
        reference = github_request(repository, reference_path)
    except urllib.error.HTTPError as error:
        if error.code == 404 and error.url == f"https://api.github.com/repos/{repository}/{reference_path}":
            error.close()
            raise SDKTagMissing(f"Exact SDK tag is absent: {tag}") from error
        raise
    require(reference["ref"] == "refs/tags/" + tag, "Unexpected SDK tag reference")
    current = reference["object"]
    visited = set()
    while current["type"] == "tag":
        require(current["sha"] not in visited and len(visited) < 32, "Cyclic/deep SDK annotated tag")
        visited.add(current["sha"])
        annotation = github_request(repository, "git/tags/" + current["sha"])
        require(annotation["sha"] == current["sha"], "SDK annotation identity mismatch")
        current = annotation["object"]
    require(current["type"] == "commit" and current["sha"] == commit, "SDK release tag/source mismatch")


def release_assets(repository, release_id):
    """Read all asset pages and reject duplicate names or IDs; return the unique asset mapping.
    读取全部资产分页并拒绝重复名称、ID；返回唯一资产映射。
    """
    require(type(release_id) is int and release_id > 0, "Invalid release ID")
    result = {}
    ids = set()
    page = 1
    while True:
        entries = github_request(repository, f"releases/{release_id}/assets?per_page=100&page={page}")
        require(isinstance(entries, list), "Invalid release asset response")
        if not entries:
            break
        for entry in entries:
            require(entry["name"] not in result and entry["id"] not in ids, "Duplicate release asset identity")
            require(type(entry["id"]) is int and entry["id"] > 0, "Invalid asset ID")
            result[entry["name"]] = entry
            ids.add(entry["id"])
        page += 1
    return result


def release_by_tag(repository, tag):
    """Find one exact tag through authenticated release pages, including pending-tag drafts.
    通过认证发布分页查找唯一精确标签，包含标签待创建的草稿。
    """
    selected = []
    seen = set()
    page = 1
    while True:
        entries = github_request(repository, f"releases?per_page=100&page={page}")
        require(isinstance(entries, list), "Invalid authenticated release list")
        if not entries:
            break
        for entry in entries:
            require(type(entry["id"]) is int and entry["id"] > 0 and entry["id"] not in seen, "Duplicate release list identity")
            seen.add(entry["id"])
            if entry["tag_name"] == tag:
                selected.append(entry)
        page += 1
    require(len(selected) <= 1, "Ambiguous published/draft release tag")
    return selected[0] if selected else None


def verify_attestation(subject, bundle, repository, source_sha, run_id, attempt, source_ref, workflow_path=SDK_WORKFLOW):
    """Verify the actual subject with official gh, then bind certificate and signed statement issuer.
    使用官方 gh 验证实际主体，再绑定证书与签名声明的签发方。
    """
    workflow = repository + "/" + workflow_path
    stdout = run(["gh", "attestation", "verify", subject, "--repo", repository,
                  "--signer-workflow", workflow, "--source-digest", source_sha, "--signer-digest", source_sha,
                  "--source-ref", source_ref, "--deny-self-hosted-runners", "--bundle", bundle, "--format", "json"])
    entries = json.loads(stdout, object_pairs_hook=pairs)
    require(isinstance(entries, list) and len(entries) == 1, "One verified SDK attestation required")
    result = entries[0]["verificationResult"]
    certificate = result["signature"]["certificate"]
    invocation = f"https://github.com/{repository}/actions/runs/{run_id}/attempts/{attempt}"
    signer = "https://github.com/" + workflow + "@" + source_ref
    require(certificate["runInvocationURI"] == invocation and certificate["sourceRepositoryURI"] == "https://github.com/" + repository
            and certificate["sourceRepositoryDigest"] == source_sha and certificate["buildSignerDigest"] == source_sha
            and certificate["sourceRepositoryRef"] == source_ref and certificate["buildSignerURI"] == signer
            and certificate["runnerEnvironment"] == "github-hosted", "Signed SDK certificate issuer/source/run mismatch")
    statement = result["statement"]
    require(statement["predicateType"] == "https://slsa.dev/provenance/v1"
            and statement["predicate"]["runDetails"]["metadata"]["invocationId"] == invocation,
            "Signed SDK predicate invocation mismatch")
    expected = {"name": Path(subject).name, "digest": {"sha256": digest(subject)}}
    require(statement["subject"].count(expected) == 1, "Signed SDK subject name/digest mismatch")
    return result


def signed_members(archive):
    """Read only canonical regular proof subject members and return their exact bytes.
    仅读取规范普通证明主体成员并返回精确字节。
    """
    result = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            relative_member(member.name)
            require(member.isfile() and member.name not in result, "Unsafe or duplicate signed proof member")
            result[member.name] = bundle.extractfile(member).read()
    return result


def existing_workflow_write(repository, content, body):
    """POST repository's already authenticated content/body once; return True only for the identical HTTP201 blob.
    对 repository 已认证的 content/body 仅 POST 一次；仅相同 blob 的 HTTP201 返回 True。
    content is the fixed-source contents record; body is the exact local workflow, never a new tree or ref.
    content 为固定源码 contents 记录；body 为精确本地工作流，绝不创建新 tree 或 ref。
    """
    require(bool(os.environ.get("GH_TOKEN")), "Current GH_TOKEN is required for the existing workflow write gate")
    # Git's blob header binds the original byte length and bytes to the authenticated contents OID.
    # Git blob 头将原字节长度及字节绑定到已认证 contents OID。
    oid = hashlib.sha1(b"blob " + str(len(body)).encode("ascii") + b"\0" + body).hexdigest()
    require(content["sha"] == oid, "Workflow contents Git blob SHA differs from exact local bytes")
    # The same blob is content-addressed: this request introduces no tree, commit, tag or reference.
    # 同一 blob 按内容寻址：此请求不引入 tree、commit、tag 或引用。
    url = f"https://api.github.com/repos/{repository}/git/blobs"
    # Use only the current issuing credential and original redirect/body guards, without retries.
    # 仅使用当前签发凭据和原重定向／正文护栏，不重试。
    headers = {"Accept": "application/vnd.github+json", "Content-Type": "application/json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "luaskills-sdk-release",
               "Cache-Control": "no-cache", "Authorization": "Bearer " + os.environ["GH_TOKEN"]}
    # Payload re-encodes the exact existing bytes, independent of the GET record's base64 line wrapping.
    # payload 重新编码精确既有字节，不受 GET 记录 base64 换行影响。
    payload = json.dumps({"content": base64.b64encode(body).decode("ascii"), "encoding": "base64"}).encode("utf-8")
    # Request explicitly carries that payload to the sole authorized POST endpoint.
    # request 明确将该载荷发送到唯一授权 POST 端点。
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    with urllib.request.build_opener(SafeRedirect()).open(request, timeout=60) as response:
        require(response.status == 201 and response.geturl() == url,
                "Existing workflow write must return HTTP 201 from the original blob URL")
        # Response bytes retain the existing release asset boundary before strict JSON decoding.
        # 严格 JSON 解码前，响应字节保留既有发布资产边界。
        result_body = response.read(MAX_RELEASE_ASSET_BYTES)
        require(len(result_body) < MAX_RELEASE_ASSET_BYTES, "Release asset exceeds the GitHub asset size limit")
    # Both response identities must describe precisely the already authenticated blob in this repository.
    # 两个响应身份必须精确描述此仓库中已认证的既有 blob。
    result = json.loads(result_body, object_pairs_hook=pairs)
    require(result["sha"] == oid and result["url"] == url + "/" + oid,
            "Existing workflow write returned a different Git blob identity")
    return True


def publication_preflight(args):
    """Check current token write permission, default-branch source, and immutable SDK tag before npm.
    在 npm 发布前检查当前令牌写权限、默认分支源码与不可变 SDK 标签。
    """
    require(bool(os.environ.get("GH_TOKEN")), "Current GH_TOKEN is required for the existing workflow write gate")
    repository = github_request(args.repository, "")
    require(repository["full_name"] == args.repository, "SDK repository identity differs from its issuing source")
    reference = github_request(args.repository, "git/ref/heads/" + urllib.parse.quote(repository["default_branch"], safe=""))
    require(reference["object"]["type"] == "commit" and reference["object"]["sha"] == args.sdk_source_sha,
            "Authority workflow/SDK must already be on the unchanged default branch")
    content = github_request(args.repository, "contents/.github/workflows/sdk-release.yml?ref=" + args.sdk_source_sha)
    # Original local workflow bytes are the sole allowed write subject, never a caller-provided payload.
    # 原本地工作流字节是唯一允许写入主体，绝非调用者提供的载荷。
    body = (ROOT / SDK_WORKFLOW).read_bytes()
    require(content["type"] == "file" and content["encoding"] == "base64"
            and base64.b64decode(content["content"]) == body,
            "Default branch SDK workflow/source is missing or differs")
    try:
        resolve_sdk_tag(args.repository, "v" + args.version, args.sdk_source_sha)
    except SDKTagMissing:
        pass
    # Actual Contents/write acceptance must precede npm; repository metadata roles cannot establish it.
    # 实际 Contents/write 验收必须先于 npm；仓库元数据角色不能建立该权限。
    contents_write = existing_workflow_write(args.repository, content, body)
    write_json(args.output, {"sdk_source_sha": args.sdk_source_sha, "sdk_version": args.version,
                           "repository": args.repository, "default_branch": repository["default_branch"], "contents_write": contents_write})


def create_draft(repository, tag, commit, title, notes):
    """Create repository/tag's empty draft once from commit/title/notes; return its independently read exact ID.
    根据 commit／title／notes 仅创建一次 repository／tag 空草稿；返回独立回读的精确 ID 对象。
    repository is owner/name; tag is the exact release tag; commit is the frozen SDK source SHA.
    repository 为所有者／仓库名；tag 为精确发布标签；commit 为冻结 SDK 源码 SHA。
    title is the requested release name; notes is the UTF-8 notes file path; return the validated GET release record.
    title 为请求的发布标题；notes 为 UTF-8 说明文件路径；返回已验证的 GET 发布记录。
    """
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository), "Invalid GitHub repository")
    require(bool(os.environ.get("GH_TOKEN")), "Current GH_TOKEN is required for draft creation")
    # url is the sole repository creation endpoint; creation has no retry or list-based ID discovery.
    # url 是唯一仓库创建端点；创建不重试，也不从列表发现 ID。
    url = f"https://api.github.com/repos/{repository}/releases"
    # headers bind the original API version, JSON media and current credential to that endpoint.
    # headers 将原 API 版本、JSON 媒体及当前凭据绑定到该端点。
    headers = {"Accept": "application/vnd.github+json", "Content-Type": "application/json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "luaskills-sdk-release",
               "Cache-Control": "no-cache", "Authorization": "Bearer " + os.environ["GH_TOKEN"]}
    # body is the exact notes file decoded as UTF-8 without newline conversion.
    # body 是精确说明文件按 UTF-8 解码的内容，不转换换行。
    body = Path(notes).read_bytes().decode("utf-8")
    # payload encodes only the exact requested source, tag, title, notes and empty draft state.
    # payload 仅编码精确请求的源码、标签、标题、说明及空草稿状态。
    payload = json.dumps({"tag_name": tag, "target_commitish": commit, "name": title, "body": body,
                          "draft": True, "prerelease": False}).encode("utf-8")
    # request carries that payload once to the sole authorized POST URL.
    # request 将该正文一次发送到唯一授权 POST URL。
    request = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    # response is the actual creation HTTP response, whose status and original URL must both match.
    # response 是实际创建 HTTP 响应，其状态及原 URL 必须同时匹配。
    with urllib.request.build_opener(SafeRedirect()).open(request, timeout=60) as response:
        require(response.status == 201 and response.geturl() == url, "Draft creation requires HTTP 201 from the original repository URL")
        # content retains the bounded original response bytes before strict duplicate-key JSON parsing.
        # content 在严格重复键 JSON 解析前保留有界原响应字节。
        content = response.read(MAX_RELEASE_ASSET_BYTES)
        require(len(content) < MAX_RELEASE_ASSET_BYTES, "Draft response exceeds the GitHub asset size limit")
    # created is the actual 201 JSON record; only its valid ID owns readback, never another draft or retry.
    # created 是实际 201 JSON 记录；仅其有效 ID 拥有回读，绝不选择其他草稿或重试。
    created = json.loads(content, object_pairs_hook=pairs)
    require(type(created["id"]) is int and created["id"] > 0 and created["url"] == url + "/" + str(created["id"]), "Invalid actual created draft ID/URL")
    # release is the independent GET record for the sole ID returned by the creation request.
    # release 是创建请求返回唯一 ID 的独立 GET 记录。
    release = github_request(repository, "releases/" + str(created["id"]))
    # record selects each observed POST/GET object for the same exact request invariants.
    # record 依次选取观察到的 POST／GET 对象，以检查同一精确请求不变量。
    for record in (created, release):
        require(type(record["id"]) is int and record["id"] == created["id"] and record["url"] == created["url"]
                and record["tag_name"] == tag and record["target_commitish"] == commit
                and record["draft"] is True and record["prerelease"] is False and record["assets"] == []
                and record["name"] == title and record["body"] == body, "Created draft source/tag/state/notes differ from the exact request")
    return release


def candidate_physical_names(sizes):
    """Project verified filename-to-size entries onto nonempty GitHub assets; return their unique names.
    将已验证文件名到大小的条目投影为非空 GitHub 资产；返回唯一名称集合。
    sizes maps verified logical names to byte counts; size is each count and name is its canonical filename.
    sizes 将已验证逻辑名称映射到字节数；size 是各字节数，name 是其规范文件名。
    """
    require(type(sizes) is dict and all(type(size) is int and size >= 0 for size in sizes.values()), "Invalid candidate physical inventory sizes")
    # Empty logical subjects remain signed inside the original bundle; this is the sole physical projection rule.
    # 空逻辑主体仍在原 bundle 内保留签名；这里是唯一物理投影规则。
    return {name for name, size in sizes.items() if size > 0}


def immutable_upload(repository, tag, commit, files, title, notes):
    """Check all existing bytes, upload only to drafts, then publish the complete release.
    检查全部已有字节，仅向草稿上传，然后发布完整 Release。
    """
    release = release_by_tag(repository, tag)
    if release is None:
        try:
            resolve_sdk_tag(repository, tag, commit)
        except SDKTagMissing:
            pass
        release = create_draft(repository, tag, commit, title, notes)
    require(release["prerelease"] is False and type(release["draft"]) is bool, "Release state must be explicit")
    if release["draft"]:
        require(release["tag_name"] == tag and release["target_commitish"] == commit, "Draft source must be the exact SDK commit")
        try:
            resolve_sdk_tag(repository, tag, commit)
        except SDKTagMissing:
            pass
    else:
        resolve_sdk_tag(repository, tag, commit)
    assets = release_assets(repository, release["id"])
    expected_names = {filename.name for filename in files}
    require(len(expected_names) == len(files) and set(assets).issubset(expected_names), "Release contains unexpected original evidence assets")
    missing = []
    for filename in files:
        if filename.name not in assets:
            missing.append(filename)
            continue
        content = github_request(repository, "releases/assets/" + str(assets[filename.name]["id"]), binary=True)
        require(hashlib.sha256(content).hexdigest() == digest(filename), f"Existing asset differs: {filename.name}")
    require(release["draft"] or not missing, "Published release is missing required assets; final releases are never appended")
    for filename in missing:
        run(["gh", "release", "upload", tag, filename, "--repo", repository])
    if release["draft"]:
        # Verify every complete draft byte before making the release public, regardless of server immutability policy.
        # 将发布公开前验证完整草稿每个字节，不依赖服务器不可变策略设置。
        uploaded = release_assets(repository, release["id"])
        require(set(uploaded) == expected_names, "Complete draft must contain exactly the frozen original assets")
        for filename in files:
            require(filename.name in uploaded, "Draft upload set is incomplete")
            content = github_request(repository, "releases/assets/" + str(uploaded[filename.name]["id"]), binary=True)
            require(hashlib.sha256(content).hexdigest() == digest(filename), "Draft asset bytes changed before publication")
        # Recheck the real tag immediately before public mutation; a draft's target field cannot substitute for it.
        # 公开变更前立即重查真实标签；草稿 target 字段不能代替真实标签。
        try:
            resolve_sdk_tag(repository, tag, commit)
        except SDKTagMissing:
            pass
        run(["gh", "release", "edit", tag, "--repo", repository, "--draft=false"])
        published = github_request(repository, "releases/" + str(release["id"]))
        require(published["id"] == release["id"] and published["tag_name"] == tag
                and published["draft"] is False and published["prerelease"] is False,
                "Draft release did not become the exact formal release")
        resolve_sdk_tag(repository, tag, commit)
        final_assets = release_assets(repository, published["id"])
        require(set(final_assets) == expected_names, "Published Release readback contains a different complete asset set")
        for filename in files:
            content = github_request(repository, "releases/assets/" + str(final_assets[filename.name]["id"]), binary=True)
            require(hashlib.sha256(content).hexdigest() == digest(filename), "Published Release readback changed original asset bytes")
        release = published
    print(json.dumps({"release_id": release["id"], "tag_name": tag, "server_immutable": release["immutable"]}))
    return release


def publish_examples(args):
    """Reauthenticate frozen six-example bytes and a new dual-chain SDK consumer before immutable publication.
    不可变发布前重新认证冻结六例字节及新的双链 SDK 消费者。
    """
    state = local_examples(args)
    current_completion(args, {"identity": {"sdk_source_sha": state["manifest"]["sdk_source_sha"]}}, EXAMPLES_WORKFLOW)
    header = example_sdk_proof(args.sdk_proof)
    require(sdk_proof_identity(header) == sdk_proof_identity(state["sdk_proof"]), "Examples recovery cannot select a different formal SDK issuer")
    with tempfile.TemporaryDirectory(prefix="luaskills-examples-preflight-") as temporary:
        publication_preflight(argparse.Namespace(repository=args.repository, sdk_source_sha=header["sdk_source_sha"],
            version=header["sdk_version"], output=Path(temporary) / "preflight.json"))
    original = Path(args.candidate).resolve() / "original"
    immutable_upload(args.repository, "examples-v" + header["sdk_version"], header["sdk_source_sha"],
        sorted(original.iterdir()), "LuaSkills TypeScript SDK Examples " + header["sdk_version"], original / "RELEASE_NOTES.md")


def normalized_signature(result, recovery):
    """Normalize only the official verifier's authenticated subjects/certificate for the shared recovery API.
    仅归一化官方验证器已认证 subject、证书，供公共恢复 API 使用。
    """
    subjects = {}
    for subject in result["statement"]["subject"]:
        require(set(subject) == {"name", "digest"} and set(subject["digest"]) == {"sha256"}, "Unexpected official subject schema")
        name = recovery.safe_filename(subject["name"])
        require(name not in subjects, "Duplicate official attestation subject")
        subjects[name] = recovery.sha256(subject["digest"]["sha256"])
    certificate = result["signature"]["certificate"]
    return {"verified_subjects": subjects, "verified_invocation_uri": certificate["runInvocationURI"],
            "verified_source_sha": certificate["buildSignerDigest"]}


def candidate_bundle(args):
    """Freeze tested package/native/core bytes before mutation and emit the sole original artifact name.
    在变更前冻结已测包、原生、核心字节，输出唯一原始制品名。
    """
    require(args.mode in ("artifact-only", "publish"), "Only tested candidates may be frozen")
    identity = read_json(args.artifact)
    archive = Path(args.artifact).resolve().parent / identity["archive"]
    validate_artifact(identity, archive)
    authority(args.core_root, identity["core_commit"])
    recovery, shared = recovery_authority(args.core_root)
    require(os.environ["GITHUB_SHA"] == identity["sdk_source_sha"] and run(["git", "rev-parse", "HEAD"]) == identity["sdk_source_sha"], "Candidate source differs from its freeze")
    run_id, attempt = int(os.environ["GITHUB_RUN_ID"]), int(os.environ["GITHUB_RUN_ATTEMPT"])
    actual = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=SDK_WORKFLOW,
        source_sha=identity["sdk_source_sha"], run_id=run_id, run_attempt=attempt,
        required_jobs=candidate_jobs(args.core_root, include_evidence=False), phase="candidate")
    require(actual["attempt"]["event"] == "workflow_dispatch" and actual["attempt"]["display_title"] ==
            f"SDK {identity['sdk_source_sha']} mode={args.mode}", "Candidate dispatch intent differs from its actual run")
    directory = Path(args.output).resolve()
    core_root = Path(args.prerequisites).resolve().parent
    require(not directory.is_relative_to(core_root), "Candidate bundle cannot contain itself")
    directory.mkdir(parents=True, exist_ok=False)
    aggregate(argparse.Namespace(core_root=args.core_root, artifact=args.artifact, prerequisites=args.prerequisites,
                                evidence_dir=args.evidence_dir, output=directory / RELEASE_FILES["aggregate"]))
    require(read_json(directory / RELEASE_FILES["aggregate"]) == read_json(args.aggregate), "Original aggregate bytes/identity changed")
    shutil.copyfile(args.artifact, directory / RELEASE_FILES["artifact"])
    shutil.copyfile(archive, directory / identity["archive"])
    with tarfile.open(directory / RELEASE_FILES["core"], "x:gz") as bundle:
        for name, path in core_proof_members(args.prerequisites, shared).items():
            bundle.add(path, arcname=name, recursive=False)
    proof = read_json(args.aggregate)
    for key in authority(args.core_root).PLATFORMS:
        reports = list(Path(args.evidence_dir).rglob("native-" + key + "/result.json"))
        require(len(reports) == 1, "Exact native report missing/duplicated: " + key)
        require(read_json(reports[0]) == proof["platforms"][key], "Original native report differs from aggregate")
        shutil.copyfile(reports[0], directory / ("native-" + key + ".json"))
        for stream in ("stdout", "stderr"):
            shutil.copyfile(reports[0].parent / ("native." + stream + ".log"), directory / ("native-" + key + "." + stream + ".log"))
    files = {path.name: path.read_bytes() for path in directory.iterdir()}
    packages = recovery.inventory_for({identity["archive"]: files[identity["archive"]]})
    write_json(directory / CANDIDATE_MANIFEST, {"schema_version": recovery.SCHEMA_VERSION, "kind": "sdk-candidate",
        "repository": args.repository, "workflow_path": SDK_WORKFLOW, "sdk_source_sha": identity["sdk_source_sha"],
        "sdk_version": identity["sdk_version"], "core_tag": identity["core_tag"], "core_commit": identity["core_commit"],
        "mode": args.mode, "run_id": run_id, "run_attempt": attempt, "packages": packages, "assets": recovery.inventory_for(files)})
    with tarfile.open(directory / CANDIDATE_BUNDLE, "x:gz") as bundle:
        for path in sorted(directory.iterdir()):
            if path.name != CANDIDATE_BUNDLE:
                bundle.add(path, arcname=path.name, recursive=False)
    files = {path.name: path.read_bytes() for path in directory.iterdir()}
    require(sum(map(len, files.values())) < recovery.MAX_ARTIFACT_BYTES, "Candidate artifact exceeds the public expansion limit")
    name = recovery.candidate_artifact_name(run_id, attempt)
    write_json(directory / recovery.BINDING_FILENAME, {"schema_version": recovery.SCHEMA_VERSION, "kind": "sdk-candidate",
        "repository": args.repository, "workflow_path": SDK_WORKFLOW, "source_sha": identity["sdk_source_sha"],
        "run_id": run_id, "run_attempt": attempt, "artifact_name": name, "inventory": recovery.inventory_for(files)})
    print(name)


def verify_candidate_files(args, files, actual, directory):
    """Authenticate all physical original candidate bytes and validate SDK-specific package/matrix contracts.
    认证全部物理原候选字节，并验证 SDK 专属包、矩阵契约。
    """
    recovery, shared = recovery_authority(args.core_root)
    binding = recovery.BINDING_FILENAME
    require(binding in files and CANDIDATE_ATTESTATION in files, "Original candidate binding/signature is missing")
    write_files(directory, files)
    result = verify_attestation(Path(directory) / binding, Path(directory) / CANDIDATE_ATTESTATION, args.repository,
        args.sdk_source_sha, int(args.candidate_run_id), int(args.candidate_run_attempt), "refs/heads/" + actual["attempt"]["head_branch"])
    normalized = normalized_signature(result, recovery)
    verified = recovery.verify_signed_binding(files[binding], **normalized, repository=args.repository, workflow_path=SDK_WORKFLOW,
        source_sha=args.sdk_source_sha, run_id=int(args.candidate_run_id), run_attempt=int(args.candidate_run_attempt),
        artifact_name=recovery.candidate_artifact_name(int(args.candidate_run_id), int(args.candidate_run_attempt)))
    inventory = recovery.verify_inventory(verified, files, attestation_filename=CANDIDATE_ATTESTATION)
    require(normalized["verified_subjects"] == {row["filename"]: row["sha256"] for row in recovery.inventory_for(
        {name: body for name, body in files.items() if name != CANDIDATE_ATTESTATION})}, "Official signature does not cover every original candidate subject")
    manifest = read_json(Path(directory) / CANDIDATE_MANIFEST)
    require(set(manifest) == {"schema_version", "kind", "repository", "workflow_path", "sdk_source_sha", "sdk_version", "core_tag", "core_commit", "mode", "run_id", "run_attempt", "packages", "assets"}
        and type(manifest["schema_version"]) is int and manifest["schema_version"] == recovery.SCHEMA_VERSION and manifest["kind"] == "sdk-candidate", "Invalid original candidate manifest")
    require(manifest["repository"] == args.repository and manifest["workflow_path"] == SDK_WORKFLOW and manifest["sdk_source_sha"] == args.sdk_source_sha
        and type(manifest["run_id"]) is int and manifest["run_id"] == int(args.candidate_run_id)
        and type(manifest["run_attempt"]) is int and manifest["run_attempt"] == int(args.candidate_run_attempt)
        and manifest["mode"] in ("artifact-only", "publish"), "Original candidate identity/mode mismatch")
    require(actual["attempt"]["event"] == "workflow_dispatch" and actual["attempt"]["display_title"] ==
        f"SDK {args.sdk_source_sha} mode={manifest['mode']}", "Original candidate actual intent mismatch")
    payload = {name: body for name, body in files.items() if name not in (binding, CANDIDATE_ATTESTATION, CANDIDATE_MANIFEST, CANDIDATE_BUNDLE)}
    recovery.compare_inventory(manifest["assets"], payload)
    bundled = signed_members(Path(directory) / CANDIDATE_BUNDLE)
    require(bundled == {**payload, CANDIDATE_MANIFEST: files[CANDIDATE_MANIFEST]}, "Original candidate bundle differs from frozen subjects")
    identity = read_json(Path(directory) / RELEASE_FILES["artifact"])
    validate_artifact(identity, Path(directory) / identity["archive"])
    require(identity["sdk_source_sha"] == args.sdk_source_sha and identity["sdk_version"] == manifest["sdk_version"]
        and identity["core_tag"] == manifest["core_tag"] and identity["core_commit"] == manifest["core_commit"], "Candidate SDK/core identity mismatch")
    require(manifest["packages"] == recovery.inventory_for({identity["archive"]: files[identity["archive"]]}), "Candidate package inventory mismatch")
    return {"manifest": manifest, "identity": identity, "binding": verified, "inventory": inventory, "attempt": actual}


def materialize_candidate_core(args, directory, state):
    """Validate the full original core/native aggregate from signed bytes and return its restored prerequisite path.
    从签名字节验证完整原核心、原生聚合，并返回恢复的前置证明路径。
    """
    original = Path(directory) / "original"
    prerequisites_path = unpack_core(original / RELEASE_FILES["core"], Path(directory) / "core-prerequisites")
    evidence = Path(directory) / "native-evidence"
    evidence.mkdir()
    core = authority(args.core_root, state["identity"]["core_commit"])
    expected_native = set()
    for key in core.PLATFORMS:
        destination = evidence / key
        destination.mkdir()
        for suffix, output_name in (("json", "result.json"), ("stdout.log", "native.stdout.log"), ("stderr.log", "native.stderr.log")):
            name = "native-" + key + "." + suffix
            expected_native.add(name)
            shutil.copyfile(original / name, destination / output_name)
    allowed = {state["identity"]["archive"], RELEASE_FILES["artifact"], RELEASE_FILES["aggregate"], RELEASE_FILES["core"], *expected_native}
    require({row["filename"] for row in state["manifest"]["assets"]} == allowed, "Original candidate payload set differs from the complete SDK contract")
    output = Path(directory) / "verified-aggregate.json"
    aggregate(argparse.Namespace(core_root=args.core_root, artifact=original / RELEASE_FILES["artifact"], prerequisites=prerequisites_path,
        evidence_dir=evidence, output=output))
    require(read_json(output) == read_json(original / RELEASE_FILES["aggregate"]), "Original full matrix cannot be reproduced from its evidence")
    for key in core.PLATFORMS:
        decoded = read_json(shared_gate(args.core_root).resolve_sdk_inputs(prerequisites_path, key)["description"])
        require(parse_native((evidence / key / "native.stdout.log").read_text(encoding="utf-8"), decoded) ==
            read_json(evidence / key / "result.json")["test"], "Original native stdout differs from its result")
    return prerequisites_path


class ArtifactHttp:
    """Adapt only an explicitly bound Actions artifact ZIP's Accept using the original Core HTTP instance.
    仅使用原 Core HTTP 实例适配明确绑定 Actions 制品 ZIP 的 Accept。
    """

    def __init__(self, http, repository, artifact_id):
        """Retain http and bind repository/artifact_id to one exact ZIP URL; return no value.
        保留 http 并将 repository/artifact_id 绑定到唯一精确 ZIP URL；无返回值。
        Core download_artifact validates these explicit identities before any request.
        Core download_artifact 在任何请求前验证这些明确身份。
        """
        # The same Core instance retains its opener, credentials, HTTPS rules and body limit.
        # 同一 Core 实例保留其 opener、凭据、HTTPS 规则及正文界限。
        self.http = http
        # GitHub's Actions ZIP endpoint requires JSON Accept even though the redirected body is ZIP bytes.
        # GitHub Actions ZIP 端点要求 JSON Accept，尽管重定向后的正文是 ZIP 字节。
        self.archive_url = f"https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}/zip"

    def json(self, url):
        """Delegate url's JSON read and decoding to the same Core HTTP; return its object unchanged.
        将 url 的 JSON 读取及解码委托同一 Core HTTP；原样返回其对象。
        """
        return self.http.json(url)

    def get(self, url, binary=False):
        """Read url with binary's original media except the bound ZIP; return original bytes/headers.
        按 binary 原媒体读取 url，仅绑定 ZIP 例外；返回原字节／响应头。
        """
        # Core's binary flag only chooses Accept; false still returns bounded raw bytes without JSON decoding.
        # Core 的 binary 标志仅选择 Accept；false 仍返回有界原字节，不作 JSON 解码。
        return self.http.get(url, binary=False if url == self.archive_url and binary is True else binary)


def candidate_fetch(args):
    """Download the explicit original artifact, authenticate its exact attempt/signature, then restore its immutable files.
    下载明确原制品，认证其精确轮次、签名，然后恢复不可变文件。
    """
    authority(args.core_root)
    recovery, shared = recovery_authority(args.core_root)
    require(run(["git", "rev-parse", "HEAD"]) == args.sdk_source_sha, "Recovery verifier must use the exact original SDK source")
    actual = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=SDK_WORKFLOW, source_sha=args.sdk_source_sha,
        run_id=int(args.candidate_run_id), run_attempt=int(args.candidate_run_attempt), required_jobs=candidate_jobs(args.core_root), phase="candidate")
    download, files = recovery.download_artifact(ArtifactHttp(shared.Http(), args.repository, int(args.candidate_artifact_id)), repository=args.repository, source_sha=args.sdk_source_sha,
        run_id=int(args.candidate_run_id), artifact_id=int(args.candidate_artifact_id),
        artifact_name=recovery.candidate_artifact_name(int(args.candidate_run_id), int(args.candidate_run_attempt)))
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    state = verify_candidate_files(args, files, actual, directory / "original")
    materialize_candidate_core(args, directory, state)
    write_json(directory / "candidate-authentication.json", {"download": download, "attempt": actual,
        "sdk_source_sha": args.sdk_source_sha, "repository": args.repository, "candidate_run_id": int(args.candidate_run_id),
        "candidate_run_attempt": int(args.candidate_run_attempt), "candidate_artifact_id": int(args.candidate_artifact_id)})


def local_candidate(args):
    """Reauthenticate the original local files against the explicit remote artifact and exact attempt; return state.
    对照明确远端制品、精确轮次重新认证原本地文件；返回状态。
    """
    root = Path(args.candidate).resolve()
    header = read_json(root / "candidate-authentication.json")
    require(header["repository"] == args.repository and header["sdk_source_sha"] == run(["git", "rev-parse", "HEAD"]), "Current completion must use the original SDK source")
    recovery, shared = recovery_authority(args.core_root)
    actual = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=SDK_WORKFLOW, source_sha=header["sdk_source_sha"],
        run_id=header["candidate_run_id"], run_attempt=header["candidate_run_attempt"], required_jobs=candidate_jobs(args.core_root), phase="candidate")
    download, files = recovery.download_artifact(ArtifactHttp(shared.Http(), args.repository, header["candidate_artifact_id"]), repository=args.repository, source_sha=header["sdk_source_sha"],
        run_id=header["candidate_run_id"], artifact_id=header["candidate_artifact_id"],
        artifact_name=recovery.candidate_artifact_name(header["candidate_run_id"], header["candidate_run_attempt"]))
    require(files == {path.name: path.read_bytes() for path in (root / "original").iterdir() if path.is_file()}, "Original local candidate differs from its exact authenticated artifact")
    with tempfile.TemporaryDirectory(prefix="luaskills-original-verify-") as temporary:
        state = verify_candidate_files(argparse.Namespace(core_root=args.core_root, repository=args.repository, sdk_source_sha=header["sdk_source_sha"],
            candidate_run_id=header["candidate_run_id"], candidate_run_attempt=header["candidate_run_attempt"]), files, actual, Path(temporary) / "original")
    state.update(root=root, download=download, header=header)
    for key in authority(args.core_root).PLATFORMS:
        for suffix, output_name in (("json", "result.json"), ("stdout.log", "native.stdout.log"), ("stderr.log", "native.stderr.log")):
            require((root / "native-evidence" / key / output_name).read_bytes() == files["native-" + key + "." + suffix],
                "Restored native evidence differs from original signed bytes")
    return state


def candidate_seal(args):
    """Verify every official candidate subject before artifact upload, without claiming the current evidence job succeeded.
    制品上传前验证每个官方候选主体，不声称当前证据作业已成功。
    """
    files = {path.name: path.read_bytes() for path in Path(args.input).iterdir() if path.is_file()}
    recovery, shared = recovery_authority(args.core_root)
    binding = read_json(Path(args.input) / recovery.BINDING_FILENAME)
    actual = recovery.verify_attempt(shared.Http(), repository=binding["repository"], workflow_path=SDK_WORKFLOW, source_sha=binding["source_sha"],
        run_id=binding["run_id"], run_attempt=binding["run_attempt"], required_jobs=candidate_jobs(args.core_root, include_evidence=False), phase="candidate")
    require(binding["source_sha"] == os.environ["GITHUB_SHA"] and binding["run_id"] == int(os.environ["GITHUB_RUN_ID"])
        and binding["run_attempt"] == int(os.environ["GITHUB_RUN_ATTEMPT"]), "Candidate signing issuer differs from current exact attempt")
    with tempfile.TemporaryDirectory(prefix="luaskills-candidate-seal-") as temporary:
        expected = argparse.Namespace(core_root=args.core_root, repository=binding["repository"], sdk_source_sha=binding["source_sha"],
            candidate_run_id=binding["run_id"], candidate_run_attempt=binding["run_attempt"])
        state = verify_candidate_files(expected, files, actual, Path(temporary) / "original")
        materialize_candidate_core(expected, temporary, state)


def current_completion(args, state, workflow_path=SDK_WORKFLOW):
    """Require explicit protected publish/recover intent and the same frozen SDK/workflow source; preserve separate completion identity.
    要求显式受保护发布、恢复意图及相同冻结 SDK、工作流源码；保留独立完成身份。
    """
    require(args.intent in ("publish", "recover") and os.environ["COMPLETION_INTENT"] == args.intent, "Artifact-only cannot authorize publication")
    source = state["identity"]["sdk_source_sha"]
    require(os.environ["GITHUB_SHA"] == source and os.environ["GITHUB_WORKFLOW_SHA"] == source
        and run(["git", "rev-parse", "HEAD"]) == source, "Initial completion source must equal original SDK source")
    require(workflow_path in (SDK_WORKFLOW, EXAMPLES_WORKFLOW), "Unknown protected publication workflow")
    require(os.environ["GITHUB_WORKFLOW_REF"] == args.repository + "/" + workflow_path + "@refs/heads/" + os.environ["DEFAULT_BRANCH"], "Completion must execute the frozen default-branch workflow")
    actual = github_request(args.repository, "actions/runs/" + os.environ["GITHUB_RUN_ID"] + "/attempts/" + os.environ["GITHUB_RUN_ATTEMPT"])
    title = "SDK" if workflow_path == SDK_WORKFLOW else "Examples"
    require(type(actual["id"]) is int and actual["id"] == int(os.environ["GITHUB_RUN_ID"])
        and type(actual["run_attempt"]) is int and actual["run_attempt"] == int(os.environ["GITHUB_RUN_ATTEMPT"])
        and actual["repository"]["full_name"] == args.repository and actual["head_repository"]["full_name"] == args.repository
        and actual["path"].split("@", 1)[0] == workflow_path
        and actual["head_sha"] == source and actual["event"] == "workflow_dispatch" and actual["display_title"] ==
        f"{title} {source} mode={args.intent}", "Actual completion dispatch intent/source mismatch")
    return {"run_id": int(os.environ["GITHUB_RUN_ID"]), "run_attempt": int(os.environ["GITHUB_RUN_ATTEMPT"]),
            "completion_source_sha": source, "completion_intent": args.intent}


def publish_candidate(args):
    """Publish/reuse only authenticated original candidate assets and record the actual immutable main release.
    仅发布、复用已认证原候选资产，并记录实际不可变主 Release。
    """
    state = local_candidate(args)
    current_completion(args, state)
    consumer = read_json(args.consumer)
    require(consumer["artifact"] == state["identity"] and consumer["success"] is True and consumer["cache"] == "new-empty-cache",
        "Actual new-cache official npm consumer is required")
    core = authority(args.core_root, state["identity"]["core_commit"])
    prerequisites(read_json(args.prerequisites), core, state["identity"])
    notes = state["root"] / "candidate-release-notes.md"
    notes.write_text("Original tested SDK candidate assets; completion is recorded by a separate signed recovery release.\n"
        "原始已测 SDK 候选资产；完成状态由独立签名恢复发布记录。\n", encoding="utf-8", newline="\n")
    # original maps each authenticated logical filename to its original path; path/name retain that exact ownership.
    # original 将每个认证逻辑文件名映射到原路径；path／name 保留该精确归属。
    original = {path.name: path for path in (state["root"] / "original").iterdir()}
    # physical contains only nonempty original names; the generic uploader never drops supplied files.
    # physical 仅包含非空原名称；通用上传者绝不丢弃传入文件。
    physical = candidate_physical_names({name: len(path.read_bytes()) for name, path in original.items()})
    release = immutable_upload(args.repository, "v" + state["identity"]["sdk_version"], state["identity"]["sdk_source_sha"],
        [original[name] for name in sorted(physical)], "LuaSkills SDK " + state["identity"]["sdk_version"], notes)
    write_json(args.output, release)


def completion_tag(version, run_id, attempt):
    """Return the single immutable recovery release tag for explicit version and completion identity.
    根据显式版本及完成身份返回唯一不可变恢复 Release 标签。
    """
    require(re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", version), "Invalid completion SDK version")
    require(type(run_id) is int and run_id > 0 and type(attempt) is int and attempt > 0, "Explicit completion run/attempt required")
    return f"recovery-v{version}-r{run_id}-a{attempt}"


def main_release_matches(repository, state, release_id):
    """Read main release by ID and require every nonempty original candidate asset byte and real tag source.
    按 ID 读取主 Release，要求每个非空原候选资产字节及真实标签源码匹配。
    """
    release = github_request(repository, "releases/" + str(release_id))
    identity = state["identity"]
    require(type(release["id"]) is int and release["id"] == release_id and release["draft"] is False
        and release["prerelease"] is False and release["tag_name"] == "v" + identity["sdk_version"], "Actual main release identity/state mismatch")
    resolve_sdk_tag(repository, release["tag_name"], identity["sdk_source_sha"])
    expected = {path.name: path.read_bytes() for path in (state["root"] / "original").iterdir() if path.is_file()}
    # physical selects nonempty expected names; each comprehension name/body is its original filename/bytes.
    # physical 选取非空预期名称；推导式各 name／body 是其原文件名／字节。
    physical = candidate_physical_names({name: len(body) for name, body in expected.items()})
    assets = release_assets(repository, release_id)
    require(set(assets) == physical, "Main release must contain exactly the nonempty original candidate assets")
    # name is the exact physical member currently being compared against its complete local logical evidence.
    # name 是当前与完整本地逻辑证据比较的精确物理成员名。
    for name in sorted(physical):
        current = github_request(repository, "releases/assets/" + str(assets[name]["id"]), binary=True)
        require(current == expected[name], "Main release changed original candidate bytes: " + name)
    return release


def completion_bundle(args):
    """Freeze fresh complete-core/npm proof and actual main release, referencing immutable original candidate hashes.
    冻结全新完整核心、npm 证明及实际主 Release，引用不可变原候选摘要。
    """
    state = local_candidate(args)
    current = current_completion(args, state)
    recovery, shared = recovery_authority(args.core_root)
    directory = Path(args.output).resolve()
    core_root = Path(args.prerequisites).resolve().parent
    require(not directory.is_relative_to(core_root), "Completion bundle cannot contain itself")
    consumer = read_json(args.consumer)
    require(consumer["artifact"] == state["identity"] and consumer["success"] is True and consumer["cache"] == "new-empty-cache",
        "Fresh official registry consumption is required")
    proof = read_json(args.aggregate)
    require(proof["complete"] is True and proof["artifact"] == state["identity"] and proof["prerequisites_sha256"] == digest(args.prerequisites), "Fresh completion core/matrix identity mismatch")
    prerequisites(read_json(args.prerequisites), authority(args.core_root, state["identity"]["core_commit"]), state["identity"])
    with tempfile.TemporaryDirectory(prefix="luaskills-completion-matrix-") as temporary:
        verified = Path(temporary) / "aggregate.json"
        aggregate(argparse.Namespace(core_root=args.core_root, artifact=state["root"] / "original" / RELEASE_FILES["artifact"],
            prerequisites=args.prerequisites, evidence_dir=state["root"] / "native-evidence", output=verified))
        require(read_json(verified) == proof, "Completion matrix differs from its actual candidate/native inputs")
    original_release = read_json(args.main_release)
    release = main_release_matches(args.repository, state, original_release["id"])
    directory.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(args.consumer, directory / RELEASE_FILES["consumer"])
    shutil.copyfile(args.aggregate, directory / "sdk-completion-aggregate.json")
    write_json(directory / "sdk-main-release.json", release)
    with tarfile.open(directory / "sdk-completion-core.tar.gz", "x:gz") as bundle:
        for name, path in core_proof_members(args.prerequisites, shared).items():
            bundle.add(path, arcname=name, recursive=False)
    original = state["root"] / "original"
    files = {path.name: path.read_bytes() for path in directory.iterdir()}
    write_json(directory / COMPLETION_MANIFEST, {"schema_version": recovery.SCHEMA_VERSION, "kind": "sdk-completion", "repository": args.repository,
        "workflow_path": SDK_WORKFLOW, "sdk_source_sha": state["identity"]["sdk_source_sha"], "sdk_version": state["identity"]["sdk_version"],
        "core_tag": state["identity"]["core_tag"], "core_commit": state["identity"]["core_commit"], **current,
        "candidate_run_id": state["header"]["candidate_run_id"], "candidate_run_attempt": state["header"]["candidate_run_attempt"],
        "candidate_artifact_id": state["download"]["artifact"]["id"], "candidate_manifest_sha256": digest(original / CANDIDATE_MANIFEST),
        "candidate_bundle_sha256": digest(original / CANDIDATE_BUNDLE), "candidate_attestation_sha256": digest(original / CANDIDATE_ATTESTATION),
        "candidate_binding_sha256": digest(original / recovery.BINDING_FILENAME), "packages": state["manifest"]["packages"],
        "candidate_attempt_observation": state["attempt"], "main_release": {"id": release["id"], "tag": release["tag_name"], "source_sha": state["identity"]["sdk_source_sha"]},
        "assets": recovery.inventory_for(files)})
    require(sum(path.stat().st_size for path in directory.iterdir()) < recovery.MAX_ARTIFACT_BYTES, "Completion evidence exceeds the public byte limit")


def verify_completion_files(args, directory, source_ref):
    """Verify all completion subjects against the explicit completion signer and exact signed schema; return manifest.
    对照显式完成签发方及精确签名结构验证全部完成主体；返回清单。
    """
    directory = Path(directory)
    recovery, shared = recovery_authority(args.core_root)
    result = verify_attestation(directory / COMPLETION_MANIFEST, directory / COMPLETION_ATTESTATION, args.repository,
        args.completion_source_sha, int(args.completion_run_id), int(args.completion_run_attempt), source_ref)
    normalized = normalized_signature(result, recovery)
    files = {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file()}
    require(normalized["verified_subjects"] == {row["filename"]: row["sha256"] for row in recovery.inventory_for(
        {name: body for name, body in files.items() if name != COMPLETION_ATTESTATION})}, "Official completion signature does not cover every subject")
    manifest = read_json(directory / COMPLETION_MANIFEST)
    require(set(manifest) == {"schema_version", "kind", "repository", "workflow_path", "sdk_source_sha", "sdk_version", "core_tag", "core_commit",
        "run_id", "run_attempt", "completion_source_sha", "completion_intent", "candidate_run_id", "candidate_run_attempt", "candidate_artifact_id",
        "candidate_manifest_sha256", "candidate_bundle_sha256", "candidate_attestation_sha256", "candidate_binding_sha256", "packages",
        "candidate_attempt_observation", "main_release", "assets"} and type(manifest["schema_version"]) is int
        and manifest["schema_version"] == recovery.SCHEMA_VERSION and manifest["kind"] == "sdk-completion", "Invalid signed completion manifest")
    require(manifest["repository"] == args.repository and manifest["workflow_path"] == SDK_WORKFLOW
        and manifest["sdk_source_sha"] == args.sdk_source_sha and manifest["completion_source_sha"] == args.completion_source_sha
        and args.completion_source_sha == args.sdk_source_sha and manifest["run_id"] == int(args.completion_run_id)
        and type(manifest["run_id"]) is int and type(manifest["run_attempt"]) is int and manifest["run_attempt"] == int(args.completion_run_attempt)
        and manifest["candidate_run_id"] == int(args.candidate_run_id) and type(manifest["candidate_run_id"]) is int
        and manifest["candidate_run_attempt"] == int(args.candidate_run_attempt) and type(manifest["candidate_run_attempt"]) is int
        and type(manifest["candidate_artifact_id"]) is int and manifest["candidate_artifact_id"] > 0
        and manifest["completion_intent"] in ("publish", "recover"), "Completion original/current identity or explicit intent mismatch")
    recovery.compare_inventory(manifest["assets"], {name: body for name, body in files.items() if name not in (COMPLETION_MANIFEST, COMPLETION_ATTESTATION)})
    require({row["filename"] for row in manifest["assets"]} == {RELEASE_FILES["consumer"], "sdk-completion-aggregate.json", "sdk-main-release.json", "sdk-completion-core.tar.gz"}, "Completion proof payload set mismatch")
    return manifest


def publish_completion(args):
    """Publish a separate immutable completion release; never append or replace original main release assets.
    发布独立不可变完成 Release；绝不追加或替换原主 Release 资产。
    """
    directory = Path(args.input).resolve()
    manifest = read_json(directory / COMPLETION_MANIFEST)
    identity = {"sdk_source_sha": manifest["sdk_source_sha"]}
    current_completion(args, {"identity": identity})
    expected = argparse.Namespace(core_root=args.core_root, repository=args.repository, sdk_source_sha=manifest["sdk_source_sha"],
        completion_source_sha=manifest["completion_source_sha"], completion_run_id=os.environ["GITHUB_RUN_ID"],
        completion_run_attempt=os.environ["GITHUB_RUN_ATTEMPT"], candidate_run_id=manifest["candidate_run_id"], candidate_run_attempt=manifest["candidate_run_attempt"])
    verify_completion_files(expected, directory, os.environ["GITHUB_REF"])
    notes = directory.parent / "completion-release-notes.md"
    notes.write_text("Fresh signed completion of the exact original SDK candidate.\n精确原 SDK 候选的新签名完成证明。\n", encoding="utf-8", newline="\n")
    immutable_upload(args.repository, completion_tag(manifest["sdk_version"], manifest["run_id"], manifest["run_attempt"]),
        manifest["completion_source_sha"], sorted(directory.iterdir()), "LuaSkills SDK completion " + manifest["sdk_version"], notes)


def release_file(repository, assets, name):
    """Read one exact public Release asset ID and require its actual advertised size; return bytes.
    读取一个精确公共 Release 资产 ID 并要求实际声明大小匹配；返回字节。
    """
    require(name in assets, "Required permanent proof asset is missing: " + name)
    body = github_request(repository, "releases/assets/" + str(assets[name]["id"]), binary=True)
    require(len(body) == assets[name]["size"], "Permanent proof asset size mismatch")
    return body


def formal_proof(args):
    """Authenticate explicit original and completion attempts from permanent releases, then perform a new npm native consume.
    从持久发布认证显式原候选及完成轮次，再执行全新 npm 原生消费。
    """
    require(args.sdk_source_sha == args.completion_source_sha and run(["git", "rev-parse", "HEAD"]) == args.sdk_source_sha
        and versions(ROOT) == args.sdk_version, "Formal verifier must use exact original/completion SDK source and version")
    authority(args.core_root)
    recovery, shared = recovery_authority(args.core_root)
    original_attempt = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=SDK_WORKFLOW,
        source_sha=args.sdk_source_sha, run_id=int(args.candidate_run_id), run_attempt=int(args.candidate_run_attempt),
        required_jobs=candidate_jobs(args.core_root), phase="candidate")
    completion_attempt = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=SDK_WORKFLOW,
        source_sha=args.completion_source_sha, run_id=int(args.completion_run_id), run_attempt=int(args.completion_run_attempt),
        required_jobs=[workflow_job_name(SDK_WORKFLOW, "publish")], phase="completion")
    tag = completion_tag(args.sdk_version, int(args.completion_run_id), int(args.completion_run_attempt))
    completion_release = github_request(args.repository, "releases/tags/" + tag)
    require(completion_release["tag_name"] == tag and completion_release["draft"] is False and completion_release["prerelease"] is False, "Exact completion release required")
    resolve_sdk_tag(args.repository, tag, args.completion_source_sha)
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    completion_directory = output / "completion"
    completion_directory.mkdir()
    assets = release_assets(args.repository, completion_release["id"])
    for name in (COMPLETION_MANIFEST, COMPLETION_ATTESTATION):
        (completion_directory / name).write_bytes(release_file(args.repository, assets, name))
    result = verify_attestation(completion_directory / COMPLETION_MANIFEST, completion_directory / COMPLETION_ATTESTATION,
        args.repository, args.completion_source_sha, int(args.completion_run_id), int(args.completion_run_attempt),
        "refs/heads/" + completion_attempt["attempt"]["head_branch"])
    authenticated = normalized_signature(result, recovery)
    manifest = read_json(completion_directory / COMPLETION_MANIFEST)
    require(authenticated["verified_subjects"][COMPLETION_MANIFEST] == digest(completion_directory / COMPLETION_MANIFEST), "Completion manifest is not authenticated")
    for row in recovery.validate_inventory(manifest["assets"]):
        (completion_directory / row["filename"]).write_bytes(release_file(args.repository, assets, row["filename"]))
    manifest = verify_completion_files(args, completion_directory, "refs/heads/" + completion_attempt["attempt"]["head_branch"])
    require(set(assets) == {path.name for path in completion_directory.iterdir()}, "Completion release contains unexpected assets")
    require(manifest["sdk_version"] == args.sdk_version and completion_attempt["attempt"]["event"] == "workflow_dispatch"
        and completion_attempt["attempt"]["display_title"] == f"SDK {args.completion_source_sha} mode={manifest['completion_intent']}", "Actual completion intent/version mismatch")
    main = manifest["main_release"]
    require(set(main) == {"id", "tag", "source_sha"} and type(main["id"]) is int and main["id"] > 0
        and main["tag"] == "v" + args.sdk_version and main["source_sha"] == args.sdk_source_sha, "Signed main release identity mismatch")
    release = github_request(args.repository, "releases/" + str(main["id"]))
    require(release["id"] == main["id"] and release["tag_name"] == main["tag"] and release["draft"] is False and release["prerelease"] is False, "Actual original main release mismatch")
    resolve_sdk_tag(args.repository, main["tag"], args.sdk_source_sha)
    candidate_assets = release_assets(args.repository, main["id"])
    bootstrap = output / "candidate-bootstrap"
    bootstrap.mkdir()
    for name in (recovery.BINDING_FILENAME, CANDIDATE_ATTESTATION):
        (bootstrap / name).write_bytes(release_file(args.repository, candidate_assets, name))
    result = verify_attestation(bootstrap / recovery.BINDING_FILENAME, bootstrap / CANDIDATE_ATTESTATION, args.repository,
        args.sdk_source_sha, int(args.candidate_run_id), int(args.candidate_run_attempt), "refs/heads/" + original_attempt["attempt"]["head_branch"])
    normalized = normalized_signature(result, recovery)
    binding = recovery.verify_signed_binding((bootstrap / recovery.BINDING_FILENAME).read_bytes(), **normalized,
        repository=args.repository, workflow_path=SDK_WORKFLOW, source_sha=args.sdk_source_sha, run_id=int(args.candidate_run_id),
        run_attempt=int(args.candidate_run_attempt), artifact_name=recovery.candidate_artifact_name(int(args.candidate_run_id), int(args.candidate_run_attempt)))
    files = {path.name: path.read_bytes() for path in bootstrap.iterdir()}
    # inventory is the canonical authenticated logical list; absent or extra attachments never choose a fallback source.
    # inventory 是规范认证逻辑清单；缺失或多余附件绝不选择回退来源。
    inventory = recovery.validate_inventory(binding["binding"]["inventory"])
    # physical derives nonempty names only from each signed row's exact filename and byte count.
    # physical 仅从各签名 row 的精确文件名及字节数派生非空名称。
    physical = candidate_physical_names({row["filename"]: row["size"] for row in inventory})
    require(set(candidate_assets) == physical | set(files), "Main release contains unexpected or missing physical candidate assets")
    # row is the current signed logical inventory entry used to authenticate a physical download.
    # row 是用于认证物理下载的当前签名逻辑库存条目。
    for row in inventory:
        if row["filename"] in physical:
            # body is the actual downloaded member, verified before it joins the complete logical files.
            # body 是实际下载成员，加入完整逻辑 files 前须经验证。
            body = release_file(args.repository, candidate_assets, row["filename"])
            require(len(body) == row["size"] and hashlib.sha256(body).hexdigest() == row["sha256"], "Physical candidate asset differs from signed size/digest: " + row["filename"])
            files[row["filename"]] = body
    # Authenticate the bundle's original size/digest before parsing; empty bytes must come from actual regular members.
    # 解析前认证 bundle 原大小／摘要；空字节必须来自实际普通成员。
    require(CANDIDATE_BUNDLE in physical, "Signed nonempty candidate bundle is required")
    # bundle is the bootstrap path for the original already size/digest-verified archive bytes.
    # bundle 是原已验证大小／摘要的归档字节在引导目录中的路径。
    bundle = bootstrap / CANDIDATE_BUNDLE
    bundle.write_bytes(files[CANDIDATE_BUNDLE])
    # members maps each actual canonical regular tar member to its original bytes, including empty members.
    # members 将各实际规范普通 tar 成员映射到原字节，包含空成员。
    members = signed_members(bundle)
    # row is the exact signed logical entry whose zero size requires recovery from the authenticated archive.
    # row 是精确签名逻辑条目，其零大小要求从认证归档恢复。
    for row in inventory:
        if row["filename"] not in physical:
            require(row["filename"] in members, "Original empty candidate member is missing from signed bundle: " + row["filename"])
            # body is the actual named archive member, never synthesized empty bytes or a guessed log suffix.
            # body 是实际命名归档成员，绝不合成空字节或猜测日志后缀。
            body = members[row["filename"]]
            require(len(body) == row["size"] and hashlib.sha256(body).hexdigest() == row["sha256"], "Original empty candidate member differs from signed size/digest: " + row["filename"])
            files[row["filename"]] = body
    candidate_directory = output / "candidate"
    candidate_directory.mkdir()
    state = verify_candidate_files(args, files, original_attempt, candidate_directory / "original")
    materialize_candidate_core(args, candidate_directory, state)
    require(state["manifest"]["sdk_version"] == args.sdk_version and state["manifest"]["packages"] == manifest["packages"], "Completion package inventory differs from original candidate")
    for field, name in (("candidate_manifest_sha256", CANDIDATE_MANIFEST), ("candidate_bundle_sha256", CANDIDATE_BUNDLE),
                        ("candidate_attestation_sha256", CANDIDATE_ATTESTATION), ("candidate_binding_sha256", recovery.BINDING_FILENAME)):
        require(manifest[field] == hashlib.sha256(files[name]).hexdigest(), "Completion changed original candidate reference: " + field)
    require(manifest["core_tag"] == state["identity"]["core_tag"] and manifest["core_commit"] == state["identity"]["core_commit"], "Completion core differs from the original candidate")
    fresh_core = unpack_core(completion_directory / "sdk-completion-core.tar.gz", output / "completion-core")
    prerequisites(read_json(fresh_core), authority(args.core_root, state["identity"]["core_commit"]), state["identity"])
    verified_aggregate = output / "verified-completion-aggregate.json"
    aggregate(argparse.Namespace(core_root=args.core_root, artifact=candidate_directory / "original" / RELEASE_FILES["artifact"],
        prerequisites=fresh_core, evidence_dir=candidate_directory / "native-evidence", output=verified_aggregate))
    require(read_json(verified_aggregate) == read_json(completion_directory / "sdk-completion-aggregate.json"),
        "Signed completion aggregate differs from original native bytes and fresh core")
    main_record = read_json(completion_directory / "sdk-main-release.json")
    require(main_record["id"] == main["id"] and main_record["tag_name"] == main["tag"]
        and main_record["draft"] is False and main_record["prerelease"] is False, "Signed actual main Release record differs from completion")
    consumer = read_json(completion_directory / RELEASE_FILES["consumer"])
    require(consumer["artifact"] == state["identity"] and consumer["success"] is True and consumer["cache"] == "new-empty-cache", "Signed completion registry consumer is incomplete")
    shutil.copyfile(candidate_directory / "original" / RELEASE_FILES["artifact"], output / "artifact.json")
    shutil.copyfile(candidate_directory / "original" / state["identity"]["archive"], output / state["identity"]["archive"])
    registry_consumer(argparse.Namespace(core_root=args.core_root, artifact=output / "artifact.json", prerequisites=fresh_core,
        platform="host", output=output / "formal-consumer.json"))
    write_json(output / "accepted.json", {"schema_version": recovery.SCHEMA_VERSION, "sdk_source_sha": args.sdk_source_sha, "sdk_version": args.sdk_version,
        "core_tag": state["identity"]["core_tag"], "core_commit": state["identity"]["core_commit"], "repository": args.repository,
        "candidate_run_id": str(args.candidate_run_id), "candidate_run_attempt": int(args.candidate_run_attempt), "completion_run_id": str(args.completion_run_id),
        "completion_run_attempt": int(args.completion_run_attempt), "completion_source_sha": args.completion_source_sha, "accepted": True,
        "registry_consumer_file": "formal-consumer.json", "registry_consumer_sha256": digest(output / "formal-consumer.json")})


def sdk_proof_identity(header):
    """Select the explicit original/completion SDK identity fields; return their exact mapping.
    选择显式原候选、完成 SDK 身份字段；返回精确映射。
    """
    return {key: header[key] for key in ("sdk_source_sha", "sdk_version", "core_tag", "core_commit", "repository",
        "candidate_run_id", "candidate_run_attempt", "completion_run_id", "completion_run_attempt", "completion_source_sha")}


def example_sdk_proof(directory):
    """Require a fresh dual-chain accepted header and its physical npm consumer bytes; return the header.
    要求新的双链接受头及物理 npm 消费者字节；返回接受头。
    """
    directory = Path(directory)
    header = read_json(directory / "accepted.json")
    require(set(header) == {"schema_version", "sdk_source_sha", "sdk_version", "core_tag", "core_commit", "repository",
        "candidate_run_id", "candidate_run_attempt", "completion_run_id", "completion_run_attempt", "completion_source_sha",
        "accepted", "registry_consumer_file", "registry_consumer_sha256"} and type(header["schema_version"]) is int
        and header["schema_version"] == 2 and header["accepted"] is True, "Schema2 formal SDK acceptance required")
    require(header["registry_consumer_file"] == "formal-consumer.json" and digest(directory / "formal-consumer.json") == header["registry_consumer_sha256"],
        "Fresh formal SDK consumer bytes changed")
    consumer = read_json(directory / "formal-consumer.json")
    require(consumer["success"] is True and consumer["cache"] == "new-empty-cache" and
        consumer["artifact"]["sdk_source_sha"] == header["sdk_source_sha"] and consumer["artifact"]["sdk_version"] == header["sdk_version"]
        and consumer["artifact"]["core_tag"] == header["core_tag"] and consumer["artifact"]["core_commit"] == header["core_commit"], "Fresh formal SDK consumer identity mismatch")
    require(header["sdk_version"] == versions(ROOT) and header["sdk_source_sha"] == header["completion_source_sha"], "Examples source/version must match formal SDK")
    return header


def example_packager():
    """Import this repository's sole six-example selection and actual ZIP verifier; return the module.
    导入本仓库唯一六例选择及实际 ZIP 验证器；返回模块。
    """
    specification = importlib.util.spec_from_file_location("standalone_examples", ROOT / "scripts/package-standalone-examples.py")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def examples_bundle(args):
    """Freeze the once-tested reproducible ZIP, sidecar, formal SDK evidence and real smoke log before mutation.
    变更前冻结一次实测的可重复 ZIP、摘要、正式 SDK 证据及真实冒烟日志。
    """
    require(args.mode in ("artifact-only", "publish"), "Recovery cannot rebuild original examples")
    header = example_sdk_proof(args.sdk_proof)
    require(run(["git", "rev-parse", "HEAD"]) == header["sdk_source_sha"] == os.environ["GITHUB_SHA"], "Examples issuer source differs from the formal SDK")
    recovery, shared = recovery_authority(args.core_root)
    archive = Path(args.archive).resolve(strict=True)
    sidecar = Path(args.sidecar).resolve(strict=True)
    require(archive.name == "luaskills-sdk-typescript-examples-" + header["sdk_version"] + ".zip"
        and sidecar.name == archive.name + ".sha256" and sidecar.read_text().strip() == digest(archive) + "  " + archive.name, "Frozen example archive/sidecar identity mismatch")
    packager = example_packager()
    examples = packager.verify_archive(archive, archive.stem, header["sdk_version"])
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    for source, name in ((archive, archive.name), (sidecar, sidecar.name), (args.notes, "RELEASE_NOTES.md"),
                        (Path(args.sdk_proof) / "accepted.json", "examples-sdk-proof.json"),
                        (Path(args.sdk_proof) / "formal-consumer.json", "examples-sdk-consumer.json"), (args.smoke_log, "examples-smoke.log")):
        shutil.copyfile(source, directory / name)
    files = {path.name: path.read_bytes() for path in directory.iterdir()}
    run_id, attempt = int(os.environ["GITHUB_RUN_ID"]), int(os.environ["GITHUB_RUN_ATTEMPT"])
    write_json(directory / EXAMPLES_MANIFEST, {"schema_version": recovery.SCHEMA_VERSION, "kind": "examples-candidate",
        "repository": args.repository, "workflow_path": EXAMPLES_WORKFLOW, "sdk_source_sha": header["sdk_source_sha"],
        "sdk_version": header["sdk_version"], "mode": args.mode, "run_id": run_id, "run_attempt": attempt,
        "sdk_identity": sdk_proof_identity(header), "examples": examples, "archive": archive.name, "assets": recovery.inventory_for(files)})
    write_json(directory / recovery.BINDING_FILENAME, {"schema_version": recovery.SCHEMA_VERSION, "kind": "sdk-candidate",
        "repository": args.repository, "workflow_path": EXAMPLES_WORKFLOW, "source_sha": header["sdk_source_sha"],
        "run_id": run_id, "run_attempt": attempt, "artifact_name": recovery.candidate_artifact_name(run_id, attempt),
        "inventory": recovery.inventory_for({path.name: path.read_bytes() for path in directory.iterdir()})})
    print(recovery.candidate_artifact_name(run_id, attempt))


def verify_examples_files(args, files, actual, directory):
    """Authenticate the exact original examples attempt and physical inventory, then verify its real ZIP and SDK proof.
    认证精确原示例轮次及物理清单，然后验证实际 ZIP 及 SDK 证明。
    """
    recovery, shared = recovery_authority(args.core_root)
    require(recovery.BINDING_FILENAME in files and EXAMPLES_ATTESTATION in files, "Original examples binding/signature missing")
    write_files(directory, files)
    directory = Path(directory)
    result = verify_attestation(directory / recovery.BINDING_FILENAME, directory / EXAMPLES_ATTESTATION, args.repository,
        args.sdk_source_sha, int(args.candidate_run_id), int(args.candidate_run_attempt), "refs/heads/" + actual["head_branch"], EXAMPLES_WORKFLOW)
    normalized = normalized_signature(result, recovery)
    binding = recovery.verify_signed_binding(files[recovery.BINDING_FILENAME], **normalized, repository=args.repository, workflow_path=EXAMPLES_WORKFLOW,
        source_sha=args.sdk_source_sha, run_id=int(args.candidate_run_id), run_attempt=int(args.candidate_run_attempt),
        artifact_name=recovery.candidate_artifact_name(int(args.candidate_run_id), int(args.candidate_run_attempt)))
    recovery.verify_inventory(binding, files, attestation_filename=EXAMPLES_ATTESTATION)
    require(normalized["verified_subjects"] == {row["filename"]: row["sha256"] for row in recovery.inventory_for(
        {name: body for name, body in files.items() if name != EXAMPLES_ATTESTATION})}, "Official signature does not cover every example subject")
    manifest = read_json(directory / EXAMPLES_MANIFEST)
    require(set(manifest) == {"schema_version", "kind", "repository", "workflow_path", "sdk_source_sha", "sdk_version", "mode", "run_id", "run_attempt",
        "sdk_identity", "examples", "archive", "assets"} and type(manifest["schema_version"]) is int and manifest["schema_version"] == recovery.SCHEMA_VERSION
        and manifest["kind"] == "examples-candidate" and manifest["repository"] == args.repository and manifest["workflow_path"] == EXAMPLES_WORKFLOW
        and manifest["sdk_source_sha"] == args.sdk_source_sha and type(manifest["run_id"]) is int and manifest["run_id"] == int(args.candidate_run_id)
        and type(manifest["run_attempt"]) is int and manifest["run_attempt"] == int(args.candidate_run_attempt)
        and manifest["mode"] in ("artifact-only", "publish"), "Original examples manifest identity/schema mismatch")
    require(actual["event"] == "workflow_dispatch" and actual["head_sha"] == args.sdk_source_sha
        and actual["display_title"] == f"Examples {args.sdk_source_sha} mode={manifest['mode']}", "Original examples actual intent mismatch")
    payload = {name: body for name, body in files.items() if name not in (recovery.BINDING_FILENAME, EXAMPLES_ATTESTATION, EXAMPLES_MANIFEST)}
    recovery.compare_inventory(manifest["assets"], payload)
    archive = manifest["archive"]
    require(archive == "luaskills-sdk-typescript-examples-" + manifest["sdk_version"] + ".zip"
        and set(payload) == {archive, archive + ".sha256", "RELEASE_NOTES.md", "examples-sdk-proof.json", "examples-sdk-consumer.json", "examples-smoke.log"}, "Original examples payload set mismatch")
    require((directory / (archive + ".sha256")).read_text().strip() == digest(directory / archive) + "  " + archive, "Original examples sidecar differs")
    require(manifest["examples"] == example_packager().verify_archive(directory / archive, Path(archive).stem, manifest["sdk_version"]), "Original six-example inventory differs")
    header = read_json(directory / "examples-sdk-proof.json")
    require(sdk_proof_identity(header) == manifest["sdk_identity"] and header["schema_version"] == 2 and header["accepted"] is True
        and header["sdk_source_sha"] == args.sdk_source_sha and header["sdk_version"] == manifest["sdk_version"]
        and header["registry_consumer_file"] == "formal-consumer.json" and header["registry_consumer_sha256"] == digest(directory / "examples-sdk-consumer.json"), "Original examples SDK consumer identity differs")
    consumer = read_json(directory / "examples-sdk-consumer.json")
    require(consumer["artifact"]["sdk_source_sha"] == args.sdk_source_sha and consumer["artifact"]["sdk_version"] == manifest["sdk_version"]
        and consumer["success"] is True and consumer["cache"] == "new-empty-cache", "Original examples SDK consumer incomplete")
    return {"manifest": manifest, "sdk_proof": header, "binding": binding}


def examples_seal(args):
    """Verify every example signature before upload without claiming the current evidence job has completed.
    上传前验证每个示例签名，不声称当前证据作业已完成。
    """
    recovery, shared = recovery_authority(args.core_root)
    binding = read_json(Path(args.input) / recovery.BINDING_FILENAME)
    require(binding["source_sha"] == os.environ["GITHUB_SHA"] == run(["git", "rev-parse", "HEAD"])
        and binding["run_id"] == int(os.environ["GITHUB_RUN_ID"]) and binding["run_attempt"] == int(os.environ["GITHUB_RUN_ATTEMPT"]), "Example signing issuer differs from current exact attempt")
    actual = shared.Http().json("https://api.github.com/repos/" + binding["repository"] + "/actions/runs/" + str(binding["run_id"]) + "/attempts/" + str(binding["run_attempt"]))
    files = {path.name: path.read_bytes() for path in Path(args.input).iterdir() if path.is_file()}
    with tempfile.TemporaryDirectory(prefix="luaskills-examples-seal-") as temporary:
        verify_examples_files(argparse.Namespace(core_root=args.core_root, repository=binding["repository"], sdk_source_sha=binding["source_sha"],
            candidate_run_id=binding["run_id"], candidate_run_attempt=binding["run_attempt"]), files, actual, Path(temporary) / "original")


def examples_fetch(args):
    """Restore only an explicit authenticated original example artifact after its actual evidence job succeeded.
    仅在实际证据作业成功后恢复明确认证的原示例制品。
    """
    require(run(["git", "rev-parse", "HEAD"]) == args.sdk_source_sha, "Examples recovery verifier source mismatch")
    recovery, shared = recovery_authority(args.core_root)
    actual = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=EXAMPLES_WORKFLOW,
        source_sha=args.sdk_source_sha, run_id=int(args.candidate_run_id), run_attempt=int(args.candidate_run_attempt),
        required_jobs=[workflow_job_name(EXAMPLES_WORKFLOW, "candidate-evidence")], phase="candidate")
    download, files = recovery.download_artifact(ArtifactHttp(shared.Http(), args.repository, int(args.candidate_artifact_id)), repository=args.repository, source_sha=args.sdk_source_sha,
        run_id=int(args.candidate_run_id), artifact_id=int(args.candidate_artifact_id),
        artifact_name=recovery.candidate_artifact_name(int(args.candidate_run_id), int(args.candidate_run_attempt)))
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    verify_examples_files(args, files, actual["attempt"], directory / "original")
    write_json(directory / "candidate-authentication.json", {"download": download, "attempt": actual, "repository": args.repository,
        "sdk_source_sha": args.sdk_source_sha, "candidate_run_id": int(args.candidate_run_id), "candidate_run_attempt": int(args.candidate_run_attempt),
        "candidate_artifact_id": int(args.candidate_artifact_id)})


def local_examples(args):
    """Reauthenticate the explicit old artifact and compare all restored bytes; return verified example state.
    重新认证明确旧制品并比较全部恢复字节；返回已验证示例状态。
    """
    root = Path(args.candidate).resolve()
    header = read_json(root / "candidate-authentication.json")
    require(header["repository"] == args.repository and header["sdk_source_sha"] == run(["git", "rev-parse", "HEAD"]), "Examples completion must retain original source")
    recovery, shared = recovery_authority(args.core_root)
    actual = recovery.verify_attempt(shared.Http(), repository=args.repository, workflow_path=EXAMPLES_WORKFLOW, source_sha=header["sdk_source_sha"],
        run_id=header["candidate_run_id"], run_attempt=header["candidate_run_attempt"],
        required_jobs=[workflow_job_name(EXAMPLES_WORKFLOW, "candidate-evidence")], phase="candidate")
    download, files = recovery.download_artifact(ArtifactHttp(shared.Http(), args.repository, header["candidate_artifact_id"]), repository=args.repository, source_sha=header["sdk_source_sha"],
        run_id=header["candidate_run_id"], artifact_id=header["candidate_artifact_id"],
        artifact_name=recovery.candidate_artifact_name(header["candidate_run_id"], header["candidate_run_attempt"]))
    require(files == {path.name: path.read_bytes() for path in (root / "original").iterdir() if path.is_file()}, "Original local examples changed")
    with tempfile.TemporaryDirectory(prefix="luaskills-examples-verify-") as temporary:
        return verify_examples_files(argparse.Namespace(core_root=args.core_root, repository=args.repository, sdk_source_sha=header["sdk_source_sha"],
            candidate_run_id=header["candidate_run_id"], candidate_run_attempt=header["candidate_run_attempt"]), files, actual["attempt"], Path(temporary) / "original")


def tools(args):
    """Enforce official trusted publishing's Node/npm minimums; print measured versions.
    强制官方可信发布的 Node、npm 最低版本；输出实测版本。
    """
    node = run(["node", "--version"]).removeprefix("v")
    npm = run(["npm", "--version"])
    require(tuple(map(int, node.split("."))) >= (22, 14, 0), "Node >=22.14.0 required")
    require(tuple(map(int, npm.split("."))) >= (11, 5, 1), "npm >=11.5.1 required")
    print(json.dumps({"node": node, "npm": npm}))


def main():
    """Parse the strict release CLI and dispatch one evidence-producing operation.
    解析严格发布 CLI 并分派单个证据生成操作。
    """
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    operations = {"freeze": freeze, "artifact": artifact, "matrix": matrix, "native": native,
                  "aggregate": aggregate, "registry-consumer": registry_consumer, "formal-proof": formal_proof,
                  "publish-examples": publish_examples, "installed": installed, "publication-preflight": publication_preflight,
                  "candidate-bundle": candidate_bundle, "candidate-seal": candidate_seal, "candidate-fetch": candidate_fetch,
                  "publish-candidate": publish_candidate, "completion-bundle": completion_bundle, "publish-completion": publish_completion,
                  "publish-or-verify": publish_or_verify, "tools": tools}
    operations.update({"examples-bundle": examples_bundle, "examples-seal": examples_seal, "examples-fetch": examples_fetch})
    arguments = {"freeze": ("core-root", "core-tag", "core-commit", "sdk-source-sha", "workflow-source-sha", "output"),
                 "artifact": ("freeze", "archive", "output"), "matrix": ("core-root", "output"),
                 "native": ("core-root", "artifact", "prerequisites", "platform", "output"),
                 "aggregate": ("core-root", "artifact", "prerequisites", "evidence-dir", "output"),
                 "registry-consumer": ("core-root", "artifact", "prerequisites", "platform", "output"),
                 "formal-proof": ("core-root", "candidate-run-id", "candidate-run-attempt", "completion-run-id", "completion-run-attempt", "completion-source-sha", "repository", "sdk-source-sha", "sdk-version", "output"),
                 "publish-examples": ("core-root", "candidate", "intent", "repository", "sdk-proof"),
                 "installed": ("artifact", "registry-proof", "root"),
                 "publication-preflight": ("repository", "sdk-source-sha", "version", "output"),
                 "candidate-bundle": ("core-root", "artifact", "aggregate", "prerequisites", "evidence-dir", "repository", "mode", "output"),
                 "candidate-seal": ("core-root", "input"),
                 "candidate-fetch": ("core-root", "repository", "sdk-source-sha", "candidate-run-id", "candidate-run-attempt", "candidate-artifact-id", "output"),
                 "publish-candidate": ("core-root", "candidate", "intent", "repository", "consumer", "prerequisites", "output"),
                 "completion-bundle": ("core-root", "candidate", "intent", "repository", "consumer", "aggregate", "prerequisites", "main-release", "output"),
                 "publish-completion": ("core-root", "repository", "input", "intent"),
                 "publish-or-verify": ("core-root", "candidate", "intent", "artifact", "aggregate", "prerequisites", "evidence-dir", "repository", "output"), "tools": ()}
    arguments.update({"examples-bundle": ("core-root", "repository", "sdk-proof", "archive", "sidecar", "notes", "smoke-log", "mode", "output"),
        "examples-seal": ("core-root", "input"), "examples-fetch": ("core-root", "repository", "sdk-source-sha", "candidate-run-id", "candidate-run-attempt", "candidate-artifact-id", "output")})
    for name, options in arguments.items():
        command = commands.add_parser(name)
        for option in options:
            command.add_argument("--" + option, required=True)
        command.set_defaults(operation=operations[name])
    args = parser.parse_args()
    args.operation(args)


if __name__ == "__main__":
    main()
