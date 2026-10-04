"""Exercise real npm archive bytes and release-gate failures without publication or Cargo.
使用真实 npm 归档字节验证发布门禁失败分支，不发布也不运行 Cargo。
"""

import argparse
import base64
import copy
import contextlib
import importlib.util
import io
import json
import os
import hashlib
import shutil
import zipfile
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Keep the explicit test inputs separate from release CLI; mocks exist only in this test module.
# 将显式测试输入与发布 CLI 分离；替身仅存在于本测试模块。
PARSER = argparse.ArgumentParser()
PARSER.add_argument("--core-root", required=True)
PARSER.add_argument("--archive", required=True)
OPTIONS, TEST_ARGUMENTS = PARSER.parse_known_args()
# Import this SDK's real gate and the core's sole platform authority.
# 导入本 SDK 真实门禁与核心唯一平台权威。
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sdk_release", ROOT / "scripts/release/sdk_release.py")
RELEASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RELEASE)
CORE = RELEASE.authority(OPTIONS.core_root)
RECOVERY, SHARED = RELEASE.recovery_authority(OPTIONS.core_root)


class RecoveryHttp:
    """Serve exact documented read-only attempts and actual ZIP fixtures; reject every undefined URL.
    提供精确文档只读轮次及实际 ZIP 夹具；拒绝每个未定义 URL。
    """

    def __init__(self, responses):
        """Store explicit URL responses and initialize a call trace; return the offline fixture.
        保存明确 URL 响应并初始化调用轨迹；返回离线夹具。
        """
        self.responses = responses
        self.calls = []

    def json(self, url):
        """Return a detached exact JSON fixture for URL or propagate its explicit missing state.
        返回 URL 对应独立精确 JSON 夹具，或传播明确缺失状态。
        """
        self.calls.append(url)
        if url not in self.responses:
            raise ValueError("Offline HTTP 404: " + url)
        return copy.deepcopy(self.responses[url])

    def get(self, url, binary=False):
        """Return real ZIP bytes/headers for the exact route; require its Actions JSON-media delegation.
        为精确路由返回真实 ZIP 字节／头部；要求其 Actions JSON 媒体委托。
        """
        self.calls.append(url)
        if url not in self.responses:
            raise ValueError("Offline HTTP 404: " + url)
        if binary is not False or not url.endswith("/zip"):
            raise AssertionError("Exact Actions ZIP must delegate Core's JSON Accept with raw bytes")
        return self.responses[url], {}



class NpmPublicationDiagnosticsTests(unittest.TestCase):
    """Exercise only the npm boundary with real owned Python children and captured terminal bytes.
    仅使用真实自有 Python 子进程及捕获的终端字节验证 npm 边界。
    """

    def test_real_zero_exit_shows_original_streams_and_exact_status(self):
        """Require both real child streams and its exact zero status without running npm publication.
        不执行 npm 发布，要求真实子进程双流及精确零退出状态。
        """
        # Preserve the real child implementation while replacing only the external npm executable.
        # 保留真实子进程实现，仅替换外部 npm 可执行入口。
        original_run = RELEASE.subprocess.run
        # These actual bytes include CRLF so diagnostic preservation differs from text normalization.
        # 这些实际字节包含 CRLF，使诊断留存区别于文本归一化。
        expected_stdout, expected_stderr = b'{}\r\n', b'warning\r\n'
        # Capture terminal bytes and actual process results without fabricating a result object.
        # 捕获终端字节及实际子进程结果，不伪造结果对象。
        stdout, stderr, observed = io.BytesIO(), io.BytesIO(), []

        def actual_child(arguments, **options):
            """Validate original npm arguments, execute the owned child and retain its actual result.
            验证原 npm 参数，执行自有子进程并保留实际结果。
            """
            self.assertEqual(arguments[1:3], ['publish', 'unit-owned.tgz'])
            self.assertEqual(options['timeout'], 180)
            # Write bytes directly through actual operating-system stdout and stderr descriptors.
            # 经实际操作系统标准输出及错误描述符直接写出字节。
            program = "import os; os.write(1,b'{}\\r\\n'); os.write(2,b'warning\\r\\n')"
            # The original process options remain authoritative for the production capture behavior.
            # 原子进程选项仍是生产捕获行为的权威。
            completed = original_run([RELEASE.sys.executable, '-I', '-B', '-c', program], **options)
            observed.append(completed)
            return completed

        with patch.object(RELEASE.shutil, 'which', return_value=RELEASE.sys.executable), \
                patch.object(RELEASE.subprocess, 'run', side_effect=actual_child), \
                patch.object(RELEASE.sys, 'stdout', SimpleNamespace(buffer=stdout)), \
                patch.object(RELEASE.sys, 'stderr', SimpleNamespace(buffer=stderr)):
            self.assertFalse(RELEASE.npm_publish_archive(Path('unit-owned.tgz'), '0.6.3'))
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0].returncode, 0)
        self.assertEqual(stdout.getvalue(), expected_stdout)
        self.assertEqual(stderr.getvalue(), expected_stderr + b'npm publication process returncode=0\n')

    def execute_child(self, stdout_bytes, stderr_bytes, returncode, prefix, pause=False, diagnostic_descriptor=None):
        """Run one real child through npm's boundary and return outcome, terminal bytes and actual process trace.
        经 npm 边界运行一个真实子进程，返回结果、终端字节及实际子进程轨迹。
        stdout_bytes/stderr_bytes and returncode define this owned child; prefix selects its fresh logs.
        stdout_bytes/stderr_bytes 和 returncode 定义本自有子进程；prefix 选择全新日志。
        pause shortens only the test timeout; no npm publication or fabricated result/exception is used.
        pause 仅缩短测试超时；不执行 npm 发布，也不伪造结果或异常。
        diagnostic_descriptor optionally selects a real closed-read pipe for secondary diagnostic failure.
        diagnostic_descriptor 可选地指定真实已关闭读端管道，用于次要诊断失败。
        """
        # Keep actual execution and raw terminal buffers separate from the publication decision.
        # 将实际执行及原始终端缓冲与发布判定分离。
        original_run = RELEASE.subprocess.run
        stdout, stderr, observed = io.BytesIO(), io.BytesIO(), []
        # The script emits exact OS bytes then either sleeps or exits with the requested real status.
        # 脚本写出精确操作系统字节，然后休眠或以指定实际状态退出。
        program = f"import os,time,sys; os.write(1,{stdout_bytes!r}); os.write(2,{stderr_bytes!r}); " + (
            "time.sleep(30)" if pause else f"sys.exit({returncode})")

        def write_stderr(content):
            """Capture original content; route only the secondary diagnostic to the optional real OS pipe.
            捕获原内容；仅将次要诊断送往可选真实操作系统管道。
            """
            if diagnostic_descriptor is not None and content.startswith(b'npm process diagnostic failed:'):
                return os.write(diagnostic_descriptor, content)
            return stderr.write(content)

        def actual_child(arguments, **options):
            """Validate original argv/budget and execute the real owned child with the same capture options.
            验证原参数及预算，用相同捕获选项执行真实自有子进程。
            """
            self.assertEqual(arguments[1:], ['publish', 'unit-owned.tgz', '--ignore-scripts', '--provenance',
                '--access', 'public', '--registry', 'https://registry.npmjs.org', '--json'])
            self.assertEqual(options['timeout'], 180)
            self.assertEqual(options['cwd'], RELEASE.ROOT)
            self.assertNotIn('env', options)
            if pause:
                options['timeout'] = 1
            try:
                # Store the true result for exact integer status comparisons.
                # 保存真实结果以精确比较整数退出状态。
                completed = original_run([RELEASE.sys.executable, '-I', '-B', '-c', program], **options)
                observed.append(completed)
                return completed
            except RELEASE.subprocess.TimeoutExpired as error:
                observed.append(error)
                raise

        with patch.object(RELEASE.shutil, 'which', return_value=RELEASE.sys.executable), \
                patch.object(RELEASE.subprocess, 'run', side_effect=actual_child), \
                patch.object(RELEASE.sys, 'stdout', SimpleNamespace(buffer=stdout)), \
                patch.object(RELEASE.sys, 'stderr', SimpleNamespace(buffer=SimpleNamespace(write=write_stderr,flush=stderr.flush))):
            try:
                # Outcome is either the existing Boolean decision or the actual production exception.
                # outcome 是既有布尔判定或实际生产异常。
                outcome = RELEASE.npm_publish_archive(Path('unit-owned.tgz'), '0.6.3', log_prefix=prefix)
            except (ValueError, RELEASE.subprocess.TimeoutExpired) as error:
                outcome = error
        return outcome, stdout.getvalue(), stderr.getvalue(), observed

    def test_real_completed_processes_preserve_raw_logs_and_existing_decisions(self):
        """Verify zero/conflict/unknown/JSON/UTF-8 behavior from real process bytes and exact exit receipts.
        经真实子进程字节及精确退出回执验证零退出、冲突、未知、JSON 和 UTF-8 行为。
        """
        # Define only original documented conflict semantics and actual malformed output boundaries.
        # 仅定义原已声明冲突语义及实际坏输出边界。
        cases = [
            (b'{}\r\n', b'warning\r\n', 0, False),
            (b'{"error":{"code":"EPUBLISHCONFLICT","summary":"Conflict"}}\r\n', b'npm conflict\r\n', 17, True),
            (b'{"error":{"code":"E409","summary":"Conflict"}}\n', b'npm conflict\n', 18, True),
            (b'{"error":{"summary":"You cannot publish over the previously published versions: 0.6.3."}}\n', b'npm conflict\n', 19, True),
            (b'{"error":{"code":"E403","summary":"Forbidden"}}\r\n', b'denied\r\n', 23, ValueError),
            (b'{invalid json\r\n', b'bad JSON\r\n', 24, json.JSONDecodeError),
            (b'{}\xff\r\n', b'bad encoding\r\n', 0, UnicodeDecodeError),
            (b'{}\r\n', b'bad encoding\xfe\r\n', 0, UnicodeDecodeError)]
        for stdout_bytes, stderr_bytes, returncode, expected in cases:
            with self.subTest(returncode=returncode, stdout=stdout_bytes), tempfile.TemporaryDirectory() as directory:
                # Own one fresh raw-log prefix per true child, never a publication-success observation.
                # 每个真实子进程独占一个原始日志前缀，不作为发布成功观察。
                prefix = Path(directory) / 'npm'
                outcome, stdout, stderr, observed = self.execute_child(stdout_bytes, stderr_bytes, returncode, prefix)
                if isinstance(expected, type):
                    self.assertIsInstance(outcome, expected)
                else:
                    self.assertIs(outcome, expected)
                self.assertEqual(len(observed), 1)
                self.assertEqual(observed[0].returncode, returncode)
                self.assertEqual(stdout, stdout_bytes)
                self.assertEqual(stderr, stderr_bytes + f'npm publication process returncode={returncode}\n'.encode('ascii'))
                self.assertEqual(Path(str(prefix)+'.stdout.log').read_bytes(), stdout_bytes)
                self.assertEqual(Path(str(prefix)+'.stderr.log').read_bytes(), stderr_bytes)
                # Receipt status is an observation only and includes no environment or claimed publish outcome.
                # 回执状态仅是观察，不包含环境或宣称发布结果。
                receipt = RELEASE.read_json(Path(str(prefix)+'.process.json'))
                self.assertEqual(receipt['returncode'], returncode)
                self.assertFalse(receipt['timed_out'])
                self.assertIsNone(receipt['observed_timeout'])
                self.assertNotIn('env', receipt)
                self.assertNotIn('success', receipt)

    def test_real_timeout_and_log_failures_preserve_original_error_and_evidence(self):
        """Require actual partial bytes and exception identity despite real existing-file/parent-file failures.
        即使真实已有文件或父路径文件导致失败，仍要求实际部分字节及原异常身份。
        """
        for case in ('fresh', 'existing', 'parent-file'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                # Establish real filesystem obstacles, retaining every original sentinel byte.
                # 建立真实文件系统障碍，保留每个原哨兵字节。
                parent = Path(directory)/'logs'
                prefix = parent/'npm'
                preserved = {}
                if case == 'parent-file':
                    parent.write_bytes(b'owned-parent')
                    preserved[parent] = parent.read_bytes()
                elif case == 'existing':
                    parent.mkdir()
                    for suffix in ('stdout.log', 'stderr.log', 'process.json'):
                        filename = Path(str(prefix)+'.'+suffix)
                        filename.write_bytes(b'owned-'+suffix.encode('ascii'))
                        preserved[filename] = filename.read_bytes()
                # Non-UTF8 timeout bytes are real; strict normal-result decoding is never applied to them.
                # 超时非 UTF-8 字节是真实的；不对其应用普通结果严格解码。
                outcome, stdout, stderr, observed = self.execute_child(b'OUT\xff\r\n', b'ERR\xfe\r\n', 0, prefix, pause=True)
                self.assertIsInstance(outcome, RELEASE.subprocess.TimeoutExpired)
                self.assertEqual(len(observed), 1)
                self.assertIs(outcome, observed[0])
                self.assertEqual(outcome.output, b'OUT\xff\r\n')
                self.assertEqual(outcome.stderr, b'ERR\xfe\r\n')
                self.assertEqual(stdout, outcome.output)
                self.assertTrue(stderr.startswith(outcome.stderr+b'npm publication process timed out\n'))
                if case == 'fresh':
                    self.assertEqual(Path(str(prefix)+'.stdout.log').read_bytes(), outcome.output)
                    self.assertEqual(Path(str(prefix)+'.stderr.log').read_bytes(), outcome.stderr)
                    receipt = RELEASE.read_json(Path(str(prefix)+'.process.json'))
                    self.assertIsNone(receipt['returncode'])
                    self.assertTrue(receipt['timed_out'])
                    self.assertEqual(receipt['observed_timeout'], outcome.timeout)
                else:
                    for filename, content in preserved.items():
                        self.assertEqual(filename.read_bytes(), content)
                    self.assertTrue(any('npm process diagnostic failed:' in note for note in outcome.__notes__))
                    self.assertFalse(any(str(parent) in note for note in outcome.__notes__))

    def test_real_secondary_diagnostic_pipe_failure_cannot_replace_timeout(self):
        """Require the same actual timeout when both exclusive persistence and a real OS pipe fail.
        独占持久化和真实操作系统管道均失败时，仍要求同一实际超时。
        """
        with tempfile.TemporaryDirectory() as directory:
            # Preserve an actual existing file and create a real broken pipe, not an exception substitute.
            # 保留实际已有文件并创建真实坏管道，不使用异常替身。
            prefix = Path(directory)/'npm'
            filename = Path(str(prefix)+'.stdout.log')
            filename.write_bytes(b'owned-before')
            read_descriptor, write_descriptor = os.pipe()
            os.close(read_descriptor)
            try:
                # Execute one actual child and fail only the secondary diagnostic's OS write.
                # 执行一个实际子进程，仅使次要诊断的操作系统写入失败。
                outcome, stdout, stderr, observed = self.execute_child(b'OUT\xff\n', b'ERR\xfe\n', 0,
                    prefix, pause=True, diagnostic_descriptor=write_descriptor)
            finally:
                os.close(write_descriptor)
            self.assertIs(outcome,observed[0])
            self.assertIsInstance(outcome,RELEASE.subprocess.TimeoutExpired)
            self.assertEqual(stdout,b'OUT\xff\n')
            self.assertEqual(stderr,b'ERR\xfe\nnpm publication process timed out\n')
            self.assertEqual(filename.read_bytes(),b'owned-before')
            self.assertEqual(len(outcome.__notes__),2)
            self.assertIn('npm process diagnostic failed:',outcome.__notes__[0])
            self.assertIn('npm diagnostic display failed:',outcome.__notes__[1])
            self.assertFalse(any(str(prefix) in note for note in outcome.__notes__))

    def test_real_silent_timeout_records_only_observed_streams(self):
        """Retain the actual no-output timeout identity without inventing unavailable bytes or an exit code.
        保留实际无输出超时身份，不伪造不可用字节或退出码。
        """
        with tempfile.TemporaryDirectory() as directory:
            # Keep one new destination and the true OS exception streams, including optional None.
            # 保留一个新目的地及真实操作系统异常输出，包括可选 None。
            prefix = Path(directory)/'npm'
            outcome, stdout, stderr, observed = self.execute_child(b'', b'', 0, prefix, pause=True)
            self.assertIsInstance(outcome, RELEASE.subprocess.TimeoutExpired)
            self.assertEqual(len(observed), 1)
            self.assertIs(outcome, observed[0])
            self.assertEqual(stdout,b'')
            self.assertEqual(stderr,b'npm publication process timed out\n')
            for suffix, content in (('stdout.log',outcome.output),('stderr.log',outcome.stderr)):
                # None means no observed stream, while an observed empty byte stream is saved exactly.
                # None 表示未观察到输出流，观察到的空字节流则精确保存。
                filename = Path(str(prefix)+'.'+suffix)
                if content is None:
                    self.assertFalse(filename.exists())
                else:
                    self.assertEqual(filename.read_bytes(),content)
            self.assertIsNone(RELEASE.read_json(Path(str(prefix)+'.process.json'))['returncode'])

    def test_real_json_error_survives_secondary_log_failure(self):
        """Keep the original JSON error visible while preserving existing log bytes and actual process status.
        保留既有日志字节及实际子进程状态，同时保持原 JSON 错误可见。
        """
        with tempfile.TemporaryDirectory() as directory:
            # A real existing stdout log denies exclusive persistence without hiding malformed JSON.
            # 真实已有标准输出日志拒绝独占持久化，但不隐藏坏 JSON。
            prefix = Path(directory)/'npm'
            filename = Path(str(prefix)+'.stdout.log')
            filename.write_bytes(b'owned-before')
            outcome, stdout, stderr, observed = self.execute_child(b'{bad\n', b'ERR\n', 31, prefix)
            self.assertIsInstance(outcome, json.JSONDecodeError)
            self.assertEqual(filename.read_bytes(), b'owned-before')
            self.assertEqual(stdout,b'{bad\n')
            self.assertTrue(stderr.startswith(b'ERR\nnpm publication process returncode=31\n'))
            self.assertIn(b'npm process diagnostic failed:',stderr)
            self.assertEqual(observed[0].returncode,31)


class TimeoutDiagnosticsTests(unittest.TestCase):
    """Verify binary partial output and silent timeouts with real subprocess exceptions.
    使用真实子进程异常核验二进制部分输出及无输出超时。
    """

    def test_real_timeout_preserves_binary_partial_output_and_none(self):
        """Require original timeout identity, exact partial bytes and None handling; return nothing.
        要求原超时身份、精确部分字节及 None 处理；无返回值。
        """
        # Retain the true subprocess function; the wrapper changes only its timeout budget.
        # 保留真实子进程函数；包装器仅改变超时预算。
        original_run = RELEASE.subprocess.run
        # Exercise both observed binary output and the actual no-output exception state.
        # 覆盖已观察二进制输出及真实无输出异常状态。
        for silent in (False, True):
            with self.subTest(silent=silent), tempfile.TemporaryDirectory() as directory:
                # Own a fresh destination, expected stream bytes and an exception identity trace.
                # 拥有新目的地、期望输出字节及异常身份轨迹。
                root = Path(directory)
                prefix = root / "partial"
                expected_stdout, expected_stderr = (b"", b"") if silent else (b"OUT\xff\n", b"ERR\xfe\n")
                observed = []
                # Capture real terminal bytes without decoding non-UTF8 child output.
                # 捕获真实终端字节，不解码子进程非 UTF-8 输出。
                stdout = io.BytesIO()
                stderr = io.BytesIO()
                # Use an actual sleeping child; never construct an exception or process result.
                # 使用真实休眠子进程；绝不构造异常或进程结果。
                program = "import time; time.sleep(30)" if silent else "import os,time; os.write(1,b'OUT\\xff\\n'); os.write(2,b'ERR\\xfe\\n'); time.sleep(30)"
                command = [RELEASE.sys.executable, "-I", "-B", "-c", program]

                def shorter_timeout(*arguments, **options):
                    """Execute real arguments after shortening options' timeout; propagate its same exception.
                    缩短 options 超时后真实执行 arguments；传播同一异常。
                    """
                    options["timeout"] = 1
                    try:
                        return original_run(*arguments, **options)
                    except RELEASE.subprocess.TimeoutExpired as error:
                        observed.append(error)
                        raise

                with patch.object(RELEASE.subprocess, "run", side_effect=shorter_timeout), \
                        patch.object(RELEASE.sys, "stdout", SimpleNamespace(buffer=stdout)), \
                        patch.object(RELEASE.sys, "stderr", SimpleNamespace(buffer=stderr)):
                    # Capture the exact exception rethrown by the production boundary.
                    # 捕获生产边界重抛的精确异常。
                    with self.assertRaises(RELEASE.subprocess.TimeoutExpired) as caught:
                        RELEASE.run(command, cwd=root, timeout=120, log_prefix=prefix)
                self.assertEqual(len(observed), 1)
                self.assertIs(caught.exception, observed[0])
                self.assertEqual(caught.exception.timeout, 1)
                if silent:
                    self.assertIn(caught.exception.output, (None, b""))
                    self.assertIn(caught.exception.stderr, (None, b""))
                else:
                    self.assertIsInstance(caught.exception.output, bytes)
                self.assertEqual(stdout.getvalue(), expected_stdout)
                self.assertEqual(stderr.getvalue(), expected_stderr)
                # Compare actual optional exception streams with their exclusively saved logs.
                # 将真实可选异常输出与其独占保存日志对比。
                for suffix, content in (("stdout.log", caught.exception.output), ("stderr.log", caught.exception.stderr)):
                    # None has no observed bytes; an observed empty byte stream remains a real empty file.
                    # None 没有已观察字节；观察到的空字节流仍对应真实空文件。
                    filename = Path(str(prefix) + "." + suffix)
                    if content is None:
                        self.assertFalse(filename.exists())
                    else:
                        self.assertEqual(filename.read_bytes(), content)


    def test_real_timeout_log_failures_preserve_original_exception_and_evidence(self):
        """Require real existing-file/parent-file failures to retain partial bytes and original timeout.
        要求真实已有文件及父路径为文件的失败保留部分字节和原超时。
        """
        # The subprocess implementation remains real; the test changes only its timeout budget.
        # 子进程实现保持真实；测试仅改变其超时预算。
        original_run = RELEASE.subprocess.run
        for case in ("existing-logs", "parent-file", "diagnostic-pipe-closed"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                # Own fresh paths, immutable sentinels and an original exception trace.
                # 拥有新路径、不可变哨兵及原异常轨迹。
                root = Path(directory)
                parent = root / "logs"
                prefix = parent / "native"
                preserved = {}
                observed = []
                stdout = io.BytesIO()
                stderr = io.BytesIO()
                if case == "parent-file":
                    parent.write_bytes(b"owned-parent-sentinel")
                    preserved[parent] = parent.read_bytes()
                else:
                    parent.mkdir()
                    # Preserve both existing real files, never merely a simulated FileExistsError.
                    # 保留两个真实已有文件，绝不仅模拟 FileExistsError。
                    for suffix in ("stdout.log", "stderr.log"):
                        filename = Path(str(prefix) + "." + suffix)
                        filename.write_bytes(("owned-" + suffix).encode("ascii"))
                        preserved[filename] = filename.read_bytes()
                # A real closed-read pipe supplies the optional secondary diagnostic write failure.
                # 真实关闭读端的管道提供可选次要诊断写失败。
                read_descriptor, write_descriptor = os.pipe()
                os.close(read_descriptor)

                def stderr_write(content):
                    """Preserve real partial content; use an OS pipe for this case's diagnostic write.
                    保留真实部分 content；对此用例的诊断写入使用操作系统管道。
                    """
                    if case == "diagnostic-pipe-closed" and content.startswith(b"Partial log persistence failed:"):
                        return os.write(write_descriptor, content)
                    return stderr.write(content)

                def shorter_timeout(*arguments, **options):
                    """Execute real arguments with shortened options timeout; observe and propagate its exception.
                    以缩短 options 超时执行真实 arguments；观察并传播其异常。
                    """
                    options["timeout"] = 1
                    try:
                        return original_run(*arguments, **options)
                    except RELEASE.subprocess.TimeoutExpired as error:
                        observed.append(error)
                        raise

                # Emit invalid UTF-8 bytes through real child stdout/stderr before sleeping.
                # 真实子进程休眠前通过标准输出及错误输出写出无效 UTF-8 字节。
                program = "import os,time; os.write(1,b'OUT\\xff\\n'); os.write(2,b'ERR\\xfe\\n'); time.sleep(30)"
                command = [RELEASE.sys.executable, "-I", "-B", "-c", program]
                try:
                    with patch.object(RELEASE.subprocess, "run", side_effect=shorter_timeout), \
                            patch.object(RELEASE.sys, "stdout", SimpleNamespace(buffer=stdout)), \
                            patch.object(RELEASE.sys, "stderr", SimpleNamespace(buffer=SimpleNamespace(write=stderr_write, flush=stderr.flush))):
                        # Require the identical actual timeout even if either logging or diagnostic persistence fails.
                        # 即使日志或诊断持久化失败，也要求同一真实超时。
                        with self.assertRaises(RELEASE.subprocess.TimeoutExpired) as caught:
                            RELEASE.run(command, cwd=root, timeout=120, log_prefix=prefix)
                finally:
                    os.close(write_descriptor)
                self.assertEqual(len(observed), 1)
                self.assertIs(caught.exception, observed[0])
                self.assertEqual(caught.exception.output, b"OUT\xff\n")
                self.assertEqual(caught.exception.stderr, b"ERR\xfe\n")
                self.assertEqual(stdout.getvalue(), b"OUT\xff\n")
                self.assertTrue(stderr.getvalue().startswith(b"ERR\xfe\n"))
                for filename, content in preserved.items():
                    self.assertEqual(filename.read_bytes(), content)
                self.assertEqual(set(root.rglob("*")), {parent, *preserved})
                # Safe notes retain type/errno, without exposing path strings or losing the first failure.
                # 安全注记保留类型及 errno，不暴露路径字符串或丢失首个失败。
                notes = caught.exception.__notes__
                self.assertIn("Partial log persistence failed:", notes[0])
                self.assertIn(" errno=", notes[0])
                self.assertFalse(any(str(root) in note for note in notes))
                if case == "diagnostic-pipe-closed":
                    self.assertEqual(stderr.getvalue(), b"ERR\xfe\n")
                    self.assertEqual(len(notes), 2)
                    self.assertIn("Partial log diagnostic display failed:", notes[1])
                else:
                    self.assertEqual(len(notes), 1)
                    self.assertIn(notes[0].encode("ascii"), stderr.getvalue())


class ReleaseGateTests(unittest.TestCase):
    """Check identity, aggregation, issuer authentication and immutable assets using unit-only fixtures.
    使用仅限单测的夹具检查身份、聚合、签发方认证和不可变资产。
    """

    def setUp(self):
        """Copy the actual tgz and create distinctly synthetic evidence for each isolated test.
        复制实际 tgz，并为每个隔离测试创建明确合成的证据。
        """
        self.temporary = tempfile.TemporaryDirectory(prefix="luaskills-release-test-")
        self.root = Path(self.temporary.name)
        (self.root / "original").mkdir()
        self.archive = self.root / "original" / Path(OPTIONS.archive).name
        self.archive.write_bytes(Path(OPTIONS.archive).read_bytes())
        self.core_tag = RELEASE.default_tag(RELEASE.archive_files(self.archive)["src/runtime-assets.ts"].decode())
        self.core_version = self.core_tag.removeprefix("v")
        self.identity = {"schema_version": RELEASE.SDK_SCHEMA, "sdk_source_sha": "a" * 40,
            "workflow_source_sha": "a" * 40, "sdk_version": RELEASE.versions(ROOT), "core_tag": self.core_tag,
            "core_commit": "b" * 40, "lock_sha256": RELEASE.digest(ROOT / "package-lock.json"),
            "archive": self.archive.name, "tgz_sha256": RELEASE.digest(self.archive)}
        self.artifact = self.root / "original" / RELEASE.RELEASE_FILES["artifact"]
        RELEASE.write_json(self.artifact, self.identity)
        self.prerequisites = self.root / "prerequisites.json"
        self.core_input = {name: {"schema_version": CORE.MANIFEST_VERSION, "platform": name,
            "core_version": self.core_version, "source_commit": "b" * 40, "library": "/unit-only/library",
            "description": "/unit-only/description", "library_sha256": "c" * 64,
            "description_sha256": "d" * 64, "archive_sha256": "e" * 64,
            "build": {"contract_sha256": "f" * 64, "inputs_sha256": "9" * 64}}
            for name in CORE.PLATFORMS}
        self.document = {"schema_version": CORE.MANIFEST_VERSION, "phase": "complete", "complete": True,
            "core_tag": self.core_tag, "core_version": self.core_version, "core_commit": "b" * 40,
            "registry": {"name": "luaskills", "version": self.core_version, "vcs_commit": "b" * 40,
                "consumer": {"commands": [{"command": ["unit-only-command"], "exit_code": 0,
                    "stdout_sha256": "1" * 64, "stderr_sha256": "2" * 64} for _ in range(4)],
                    "executable": "/unit-only/executable", "executable_sha256": "3" * 64,
                    "cargo_lock_sha256": "4" * 64, "package_id": "unit-only", "source": "unit-only",
                    "result": {"challenge": "5" * 64, "runtime": True, "pool_reuse": True,
                               "capability_calls": 2, "drained": True}}}, "sdk_inputs": self.core_input}
        RELEASE.write_json(self.prerequisites, self.document)
        self.descriptions = self.root / "descriptions"
        self.descriptions.mkdir()
        for name in CORE.PLATFORMS:
            RELEASE.write_json(self.descriptions / (name + ".json"), {"core_version": self.core_version,
                "protocol_version": 1, "build": self.core_input[name]["build"]})
        self.evidence = self.root / "native-evidence"
        self.evidence.mkdir()
        self.records = {name: {"schema_version": RELEASE.SDK_SCHEMA, "platform": name, "artifact": copy.deepcopy(self.identity),
            "core_input": {k: v for k, v in value.items() if k not in ("library", "description")},
            "test": {"core_version": self.core_version, "protocol_version": 1, "contract_sha256": "f" * 64,
                     "callback_count": 2, "scope": "closed"}, "success": True, "skipped": False}
            for name, value in self.core_input.items()}
        for name, record in self.records.items():
            RELEASE.write_json(self.evidence / (name + ".json"), record)
        self.args = SimpleNamespace(core_root=OPTIONS.core_root, artifact=self.artifact, prerequisites=self.prerequisites,
                                    evidence_dir=self.evidence, output=self.root / "aggregate.json")

    def tearDown(self):
        """Remove only this test's unique temporary directory; return nothing.
        仅删除本测试唯一临时目录；无返回值。
        """
        self.temporary.cleanup()

    def aggregate(self):
        """Run actual strict aggregation with only source checkout validation replaced for unit fixtures.
        仅替换单测夹具的源码检出验证，运行实际严格聚合。
        """
        with patch.object(RELEASE, "authority", return_value=CORE), patch.object(RELEASE, "shared_gate", return_value=self.shared_fixture()):
            RELEASE.aggregate(self.args)

    def shared_fixture(self):
        """Return a unit-only resolver exposing explicit on-disk description fixture bytes.
        返回仅限单测的解析器，提供显式磁盘描述夹具字节。
        """
        def resolve(prerequisites, name):
            """Return the exact selected fixture input; never resolve candidate files in production.
            返回精确选定的夹具输入；绝不解析生产候选文件。
            """
            return {**self.core_input[name], "description": str(self.descriptions / (name + ".json"))}

        return SimpleNamespace(resolve_sdk_inputs=resolve)

    def publication_args(self):
        """Create actual aggregation of unit-only native records; return the exact publication arguments.
        对仅限单测的原生记录执行实际聚合；返回精确发布参数。
        """
        self.aggregate()
        return SimpleNamespace(**vars(self.args), aggregate=self.args.output, repository="test/repo", candidate=self.root, intent="publish")

    def publication_context(self, metadata, content, completed):
        """Replace only external source/API/process boundaries while preserving archive and matrix validation.
        仅替换外部源码、API、进程边界，保留归档及矩阵实际验证。
        """
        stack = contextlib.ExitStack()
        stack.enter_context(patch.object(RELEASE, "authority", return_value=CORE))
        stack.enter_context(patch.object(RELEASE, "shared_gate", return_value=self.shared_fixture()))
        stack.enter_context(patch.object(RELEASE, "local_candidate", return_value={"root": self.root, "identity": self.identity}))
        stack.enter_context(patch.object(RELEASE, "current_completion"))
        stack.enter_context(patch.object(RELEASE, "run", side_effect=lambda command: self.identity["sdk_source_sha"] if command[1:3] == ["rev-parse", "HEAD"] else ""))
        stack.enter_context(patch.object(RELEASE, "publication_preflight"))
        stack.enter_context(patch.object(RELEASE, "tools"))
        stack.enter_context(patch.object(RELEASE, "request_json", side_effect=metadata))
        stack.enter_context(patch.object(RELEASE.urllib.request, "urlopen", side_effect=content))
        stack.enter_context(patch.object(RELEASE.shutil, "which", return_value="unit-only-npm"))
        command = stack.enter_context(patch.object(RELEASE.subprocess, "run", return_value=completed))
        return stack, command

    def npm_metadata(self):
        """Return a clearly unit-only official metadata shape for the actual archive version.
        为实际归档版本返回明确仅限单测的官方元数据形状。
        """
        return {"name": "@luaskills/sdk", "version": self.identity["sdk_version"],
                "dist": {"tarball": "https://registry.npmjs.org/@luaskills/sdk/-/sdk.tgz"}}

    def missing_npm_version(self, code=404):
        """Return the requested HTTP error for this exact npm version endpoint, never its tarball.
        返回此精确 npm 版本端点请求的 HTTP 错误，绝不代表 tarball。
        """
        error = RELEASE.urllib.error.HTTPError("https://registry.npmjs.org/@luaskills%2fsdk/" + self.identity["sdk_version"],
                                               code, "unit-only registry error", {}, None)
        self.addCleanup(error.close)
        return error

    def alter_record(self, change):
        """Apply a requested mutation to one existing platform record and persist its bytes.
        对一个已有平台记录应用请求变更并保存字节。
        """
        name = next(iter(self.records))
        record = copy.deepcopy(self.records[name])
        change(record)
        (self.evidence / (name + ".json")).write_text(json.dumps(record), encoding="utf-8")



    def test_actual_tgz_contract_and_defaults(self):
        """Check real archive members, authoritative version and source/compiled default tag agree.
        检查真实归档成员、权威版本与源码、编译默认标签一致。
        """
        files = RELEASE.archive_files(self.archive)
        self.assertEqual(json.loads(files["package.json"])["version"], RELEASE.versions(ROOT))
        self.assertEqual(files["VERSION"].decode().strip(), RELEASE.versions(ROOT))
        self.assertEqual(RELEASE.default_tag(files["src/runtime-assets.ts"].decode()),
                         RELEASE.default_tag(files["dist/runtime-assets.js"].decode()))
        self.assertIn("examples/embedded-candidate.mjs", files)
        RELEASE.validate_artifact(self.identity, self.archive)

    def test_real_distribution_verifier_and_artifact_identity(self):
        """Run the real archive/codec verifier while source-state substitution stays unit-only.
        运行真实归档、编码器验证器；源码状态替换仍仅限单测。
        """
        files = RELEASE.archive_files(self.archive)
        frozen = {k: v for k, v in self.identity.items() if k not in ("archive", "tgz_sha256")}
        frozen["core_tag"] = RELEASE.default_tag(files["src/runtime-assets.ts"].decode())
        freeze_file = self.root / "freeze.json"
        RELEASE.write_json(freeze_file, frozen)
        args = SimpleNamespace(freeze=freeze_file, archive=self.archive, output=self.root / "real-artifact.json")
        original = RELEASE.run

        def command(arguments, *extra, **keywords):
            """Keep the real Node verifier and substitute only synthetic git fixture identity.
            保持真实 Node 验证器，仅替换合成 Git 夹具身份。
            """
            if arguments[:2] == ["git", "rev-parse"]:
                return frozen["sdk_source_sha"]
            if arguments[:2] == ["git", "status"]:
                return ""
            return original(arguments, *extra, **keywords)

        with patch.object(RELEASE, "run", side_effect=command):
            RELEASE.artifact(args)
        record = RELEASE.read_json(args.output)
        self.assertEqual(record["tgz_sha256"], RELEASE.digest(self.archive))
        self.assertEqual(record["core_tag"], frozen["core_tag"])

    def test_version_lock_mirrors_fail(self):
        """Reject an actual changed VERSION or lock root mirror in an isolated source fixture.
        在隔离源码夹具中拒绝实际改变的 VERSION 或锁根镜像。
        """
        for name in ("package.json", "package-lock.json", "VERSION"):
            (self.root / name).write_bytes((ROOT / name).read_bytes())
        self.assertEqual(RELEASE.versions(self.root), RELEASE.versions(ROOT))
        (self.root / "VERSION").write_text("0.0.0", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "VERSION mismatch"):
            RELEASE.versions(self.root)
        (self.root / "VERSION").write_bytes((ROOT / "VERSION").read_bytes())
        lock = RELEASE.read_json(self.root / "package-lock.json")
        lock["packages"][""]["version"] = "0.0.0"
        (self.root / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Lock version mismatch"):
            RELEASE.versions(self.root)




    def test_strict_complete_platform_aggregation(self):
        """Accept all authority-derived fixture platforms and bind the actual tgz hash.
        接受全部权威派生夹具平台并绑定实际 tgz 摘要。
        """
        self.aggregate()
        result = RELEASE.read_json(self.args.output)
        self.assertEqual(set(result["platforms"]), set(CORE.PLATFORMS))
        self.assertEqual(result["artifact"]["tgz_sha256"], RELEASE.digest(self.archive))
        self.assertIs(result["complete"], True)

    def test_missing_platform_fails_without_success_evidence(self):
        """Missing one required native platform must fail before writing aggregate proof.
        缺失一个必需原生平台时，必须在写入聚合证明前失败。
        """
        next(self.evidence.iterdir()).unlink()
        with self.assertRaisesRegex(ValueError, "Missing native platform"):
            self.aggregate()
        self.assertFalse(self.args.output.exists())

    def test_duplicate_platform_fails(self):
        """Reject two records claiming the same actual platform identity.
        拒绝两个记录声明同一实际平台身份。
        """
        RELEASE.write_json(self.evidence / "duplicate.json", next(iter(self.records.values())))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            self.aggregate()

    def test_tampered_sdk_core_schema_and_test_evidence_fail(self):
        """Reject identity drift, skipped/error results, unsupported schema and incomplete native work.
        拒绝身份漂移、跳过、错误结果、不支持的结构版本与未完成原生操作。
        """
        changes = [lambda r: r["artifact"].update(tgz_sha256="0" * 64),
                   lambda r: r["artifact"].update(sdk_source_sha="0" * 40),
                   lambda r: r["core_input"].update(library_sha256="0" * 64),
                   lambda r: r.update(schema_version=999), lambda r: r.update(schema_version=True),
                   lambda r: r.update(skipped=True), lambda r: r.update(success=False),
                   lambda r: r["test"].update(callback_count=0), lambda r: r["test"].update(scope="open"),
                   lambda r: r["test"].update(protocol_version=2), lambda r: r.update(extra=True)]
        for change in changes:
            with self.subTest(change=change):
                for name, record in self.records.items():
                    (self.evidence / (name + ".json")).write_text(json.dumps(record), encoding="utf-8")
                self.alter_record(change)
                with self.assertRaises((ValueError, KeyError)):
                    self.aggregate()
                self.assertFalse(self.args.output.exists())

    def test_all_platform_protocol_mutation_rejected_by_actual_description(self):
        """Even unanimous protocol tampering must disagree with verified description bytes and fail.
        即使全部平台一致篡改协议，也必须因与已验证描述字节不一致而失败。
        """
        for name, record in self.records.items():
            changed = copy.deepcopy(record)
            changed["test"]["protocol_version"] = 2
            (self.evidence / (name + ".json")).write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "actual core description"):
            self.aggregate()
        self.assertFalse(self.args.output.exists())

    def test_changed_actual_archive_fails(self):
        """An appended byte changes the actual archive digest and must fail before aggregation.
        追加字节改变实际归档摘要，必须在聚合前失败。
        """
        with self.archive.open("ab") as stream:
            stream.write(b"changed")
        with self.assertRaisesRegex(ValueError, "Artifact bytes changed"):
            self.aggregate()

    def test_github_only_and_missing_registry_consumer_fail(self):
        """A GitHub-only flag or erased/failed real registry consumer cannot authorize release.
        仅 GitHub 标志或被删除、失败的真实 registry 消费者不能授权发布。
        """
        changes = [lambda d: d.update(phase="github-only", complete=False, registry=None),
                   lambda d: d.update(registry={}), lambda d: d["registry"]["consumer"].update(commands=[]),
                   lambda d: d["registry"]["consumer"]["commands"][0].update(exit_code=1),
                   lambda d: d["registry"]["consumer"]["result"].update(drained=False)]
        for change in changes:
            with self.subTest(change=change):
                document = copy.deepcopy(self.document)
                change(document)
                self.prerequisites.write_text(json.dumps(document), encoding="utf-8")
                with self.assertRaises((ValueError, KeyError)):
                    self.aggregate()

    def test_duplicate_json_keys_and_unsafe_tar_members_fail(self):
        """Reject duplicate identity keys and archive links or traversal before file materialization.
        在文件落盘前拒绝重复身份键与归档链接、路径穿越。
        """
        duplicate = self.root / "duplicate.json"
        duplicate.write_text('{"schema_version":1,"schema_version":2}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Duplicate JSON"):
            RELEASE.read_json(duplicate)
        for name, kind in (("package/../escape", tarfile.REGTYPE), ("package/link", tarfile.SYMTYPE),
                           ("package//escape", tarfile.REGTYPE), ("package/./escape", tarfile.REGTYPE),
                           ("package/a//escape", tarfile.REGTYPE), ("package/C:/escape", tarfile.REGTYPE)):
            unsafe = self.root / "unsafe.tgz"
            with tarfile.open(unsafe, "w:gz") as bundle:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.size = 1 if kind == tarfile.REGTYPE else 0
                bundle.addfile(entry, io.BytesIO(b"x") if entry.size else None)
            with self.assertRaisesRegex(ValueError, "Unsafe|Non-regular"):
                RELEASE.archive_files(unsafe)

    def test_native_child_error_never_emits_success(self):
        """Propagate a real child error boundary without replacing it with caller-provided success.
        传播真实子进程错误边界，不以调用者成功文字替代。
        """
        args = SimpleNamespace(core_root=OPTIONS.core_root, artifact=self.artifact, prerequisites=self.prerequisites,
                               platform=next(iter(CORE.PLATFORMS)), output=self.root / "native.json")
        decoded = {"core_version": self.core_version, "protocol_version": 1, "build": {"contract_sha256": "f" * 64}}
        with patch.object(RELEASE, "run", side_effect=[self.identity["sdk_source_sha"], ValueError("actual child failed")]), \
             patch.object(RELEASE, "native_inputs", return_value=(next(iter(self.core_input.values())), self.archive, self.archive, decoded)):
            with self.assertRaisesRegex(ValueError, "actual child failed"):
                RELEASE.native(args)
        self.assertFalse(args.output.exists())

    def test_native_output_is_exact_and_never_skip(self):
        """Require one full native callback/close JSON result instead of success-looking text.
        要求一个完整原生回调、关闭 JSON 结果，不能使用看似成功的文字。
        """
        decoded = {"core_version": self.core_version, "protocol_version": 1, "build": {"contract_sha256": "f" * 64}}
        result = next(iter(self.records.values()))["test"]
        self.assertEqual(RELEASE.parse_native(json.dumps(result) + "\nGate verified", decoded), result)
        for stdout in ("skipped", "Gate verified", json.dumps(result) + "\n" + json.dumps(result),
                       json.dumps({**result, "callback_count": 0}), json.dumps({**result, "scope": "open"})):
            with self.subTest(stdout=stdout), self.assertRaises(ValueError):
                RELEASE.parse_native(stdout, decoded)

    def test_source_workflow_version_and_default_tag_failures(self):
        """Fail frozen source/workflow drift and actual mismatched SDK/core default tags.
        冻结源码、工作流漂移及实际 SDK、核心默认标签不一致时失败。
        """
        args = SimpleNamespace(core_root=OPTIONS.core_root, core_tag="v999.0.0", core_commit="b" * 40,
                               sdk_source_sha="a" * 40, workflow_source_sha="a" * 40, output=self.root / "freeze.json")
        with patch.object(RELEASE, "run", side_effect=["a" * 40, ""]), patch.object(RELEASE, "authority", return_value=CORE):
            with self.assertRaisesRegex(ValueError, "Default core asset tag"):
                RELEASE.freeze(args)
        args.workflow_source_sha = "c" * 40
        with self.assertRaisesRegex(ValueError, "Workflow source"):
            RELEASE.freeze(args)
        self.assertFalse(args.output.exists())

    def test_same_asset_reused_different_asset_rejected_before_upload(self):
        """Reuse identical assets and reject any conflicting member before an upload mutation.
        复用相同资产，并在上传变更前拒绝任一冲突成员。
        """
        asset = self.root / "asset.zip"
        asset.write_bytes(b"same")
        release = {"id": 1, "draft": False, "prerelease": False, "immutable": False}
        entries = {"asset.zip": {"id": 2}}
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "github_request", return_value=b"same"), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", return_value=entries), \
             patch.object(RELEASE, "run") as command:
            RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [asset], "title", asset)
            command.assert_not_called()
        missing = self.root / "missing.zip"
        missing.write_bytes(b"new")
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "github_request", return_value=b"different"), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", return_value=entries), \
             patch.object(RELEASE, "run") as command:
            with self.assertRaisesRegex(ValueError, "Existing asset differs"):
                RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [missing, asset], "title", asset)
            command.assert_not_called()

    def test_final_release_never_appended(self):
        """Reject missing final-release assets before mutation, even when server immutability is off.
        即使服务器未启用不可变设置，也在变更前拒绝正式发布缺失资产。
        """
        release = {"id": 1, "draft": False, "prerelease": False, "immutable": False}
        with patch.object(RELEASE, "release_by_tag", return_value=release), patch.object(RELEASE, "resolve_sdk_tag"), \
             patch.object(RELEASE, "release_assets", return_value={}), patch.object(RELEASE, "run") as command:
            with self.assertRaisesRegex(ValueError, "final releases are never appended"):
                RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", self.archive)
            command.assert_not_called()

    def test_draft_all_assets_verified_before_publish(self):
        """Upload only a missing draft asset and publish only after rechecking all actual bytes.
        仅上传缺失草稿资产，在复核全部实际字节后才发布。
        """
        draft = {"id": 1, "draft": True, "prerelease": False, "tag_name": "v0.5.7", "target_commitish": "a" * 40}
        published = {"id": 1, "draft": False, "prerelease": False, "immutable": False, "tag_name": "v0.5.7"}
        with patch.object(RELEASE, "release_by_tag", return_value=draft), \
             patch.object(RELEASE, "github_request", side_effect=[self.archive.read_bytes(), published, self.archive.read_bytes()]), \
             patch.object(RELEASE, "resolve_sdk_tag"), patch.object(RELEASE, "release_assets", side_effect=[{}, {self.archive.name: {"id": 10}}, {self.archive.name: {"id": 10}}]), \
             patch.object(RELEASE, "run") as command:
            RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", self.archive)
            self.assertEqual([call.args[0] for call in command.call_args_list], [
                ["gh", "release", "upload", "v0.5.7", self.archive, "--repo", "test/repo"],
                ["gh", "release", "edit", "v0.5.7", "--repo", "test/repo", "--draft=false"]])

    def test_create_and_resume_draft_use_authenticated_list_ids(self):
        """Use the actual creation ID while the authenticated list remains unchanged; reuse only an existing listed draft.
        在认证列表仍未变化时使用实际创建 ID；仅复用列表中已存在的草稿。
        """
        for existing in (False, True):
            with self.subTest(existing_draft=existing):
                notes = self.root / "draft-notes.md"
                notes.write_text("unit-only notes", encoding="utf-8")
                state = {"created": existing, "uploaded": False, "published": False}
                draft = {"id": 7, "tag_name": "v0.5.7", "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                published = {**draft, "draft": False, "immutable": False}
                calls = []

                def reader(repository, path, binary=False):
                    """Serve actual list/ID routes and forbid using published-by-tag to read a draft.
                    提供真实列表、ID 路由，禁止用已公开按标签接口读取草稿。
                    """
                    if path.startswith("releases/tags/"):
                        raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft is not published", {}, None)
                    if path == "git/ref/tags/v0.5.7":
                        if not state["published"]:
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/ref/tags/v0.5.7", 404, "pending tag", {}, None)
                        return {"ref": "refs/tags/v0.5.7", "object": {"type": "commit", "sha": "a" * 40}}
                    if path == "releases?per_page=100&page=1":
                        return [draft] if existing else []
                    if path == "releases?per_page=100&page=2":
                        return []
                    if path == "releases/7/assets?per_page=100&page=1":
                        return [{"id": 100, "name": self.archive.name}] if state["uploaded"] else []
                    if path == "releases/7/assets?per_page=100&page=2":
                        return []
                    if path == "releases/assets/100":
                        self.assertTrue(state["uploaded"])
                        return self.archive.read_bytes()
                    if path == "releases/7":
                        self.assertTrue(state["created"])
                        return published if state["published"] else draft
                    raise AssertionError("Unexpected draft API route: " + path)

                def command(arguments):
                    """Mutate only the unit fixture after validating create, upload and public ordering.
                    验证创建、上传、公开顺序后，仅变更单测夹具。
                    """
                    calls.append(arguments)
                    if arguments[:3] == ["gh", "release", "create"]:
                        self.assertFalse(state["created"])
                        self.assertIn("--draft", arguments)
                        self.assertNotIn(self.archive, arguments)
                        state["created"] = True
                    elif arguments[:3] == ["gh", "release", "upload"]:
                        self.assertTrue(state["created"])
                        self.assertFalse(state["published"])
                        state["uploaded"] = True
                    elif arguments[:3] == ["gh", "release", "edit"]:
                        self.assertTrue(state["uploaded"])
                        self.assertIn("--draft=false", arguments)
                        state["published"] = True
                    else:
                        raise AssertionError("Unexpected draft command")
                    return ""

                def create(repository, tag, commit, title, notes_path):
                    """Return the explicit created ID without making it appear in the offline release list.
                    返回明确创建 ID，不使其出现在离线发布列表中。
                    repository/tag/commit/title are the exact requested owner/name, tag, source and title; notes_path owns notes bytes.
                    repository／tag／commit／title 是精确请求的仓库、标签、源码和标题；notes_path 拥有说明字节。
                    Return the explicit draft record after recording one unit-only creation.
                    记录一次仅限单测创建后返回明确草稿记录。
                    """
                    self.assertEqual((repository, tag, commit, title, notes_path), ("test/repo", "v0.5.7", "a" * 40, "title", notes))
                    self.assertFalse(state["created"])
                    calls.append(["REST", "release", "create"])
                    state["created"] = True
                    return draft

                with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run", side_effect=command), patch.object(RELEASE, "create_draft", side_effect=create):
                    RELEASE.immutable_upload("test/repo", "v0.5.7", "a" * 40, [self.archive], "title", notes)
                expected = ["upload", "edit"] if existing else ["create", "upload", "edit"]
                self.assertEqual([call[2] for call in calls], expected)
                self.assertTrue(state["published"])

    def test_create_draft_http201_id_and_independent_readback_guards(self):
        """Exercise the real Request/opener boundary offline; exact 201 IDs and source/state must bind both responses.
        离线验证真实 Request／opener 边界；精确 201 ID 与来源／状态必须绑定两个响应。
        self owns the isolated fixture paths and assertions; return nothing and make no real network request.
        self 拥有隔离夹具路径及断言；无返回值，也不发出真实网络请求。
        """
        # notes owns the exact local UTF-8 notes fixture, never a claim of real GitHub authorization.
        # notes 拥有精确本地 UTF-8 说明夹具，绝不声称真实 GitHub 授权。
        notes = self.root / "created-notes.md"
        notes.write_bytes(b"exact notes\n")
        # url is the sole offline repository release creation endpoint expected by the actual Request.
        # url 是实际 Request 预期的唯一离线仓库发布创建端点。
        url = "https://api.github.com/repos/test/repo/releases"
        # original is the independent valid response baseline for both creation and exact-ID readback.
        # original 是创建及精确 ID 回读两者独立有效响应基线。
        original = {"id": 7, "url": url + "/7", "tag_name": "v0.5.7", "target_commitish": "a" * 40,
                    "name": "title", "body": "exact notes\n", "draft": True, "prerelease": False, "assets": []}
        # cases enumerates the valid request and each independently corrupted HTTP/identity/readback fact.
        # cases 列举有效请求及各独立损坏的 HTTP／身份／回读事实。
        cases = ("valid", "status", "boolean-id", "zero-id", "foreign-url", "redirect", "source", "tag", "readback-id", "readback-url", "readback-source", "readback-tag", "readback-assets", "unknown-readback")
        # case selects one mutation; opener captures the real POST boundary and reader isolates exact-ID GET.
        # case 选取一个变异；opener 捕获实际 POST 边界，reader 隔离精确 ID GET。
        for case in cases:
            with self.subTest(case=case), patch.dict(os.environ, {"GH_TOKEN": "unit-only-current-token"}), patch.object(RELEASE.urllib.request, "build_opener") as opener, patch.object(RELEASE, "github_request") as reader:
                # created is the mutable POST record; observed is the independent GET record for this mutation.
                # created 是可变 POST 记录；observed 是本变异的独立 GET 记录。
                created, observed = copy.deepcopy(original), copy.deepcopy(original)
                # response is the context-managed offline HTTP response returned by the single captured POST.
                # response 是单次捕获 POST 返回的上下文管理离线 HTTP 响应。
                response = opener.return_value.open.return_value.__enter__.return_value
                response.status = 200 if case == "status" else 201
                response.geturl.return_value = url + "/other" if case == "redirect" else url
                if case == "boolean-id":
                    created["id"] = True
                elif case == "zero-id":
                    created["id"] = 0
                elif case == "foreign-url":
                    created["url"] = "https://api.github.com/repos/other/repo/releases/7"
                elif case == "source":
                    created["target_commitish"] = "b" * 40
                elif case == "tag":
                    created["tag_name"] = "v9.9.9"
                elif case == "readback-id":
                    observed["id"] = 8
                elif case == "readback-url":
                    observed["url"] = "https://api.github.com/repos/other/repo/releases/7"
                elif case == "readback-source":
                    observed["target_commitish"] = "b" * 40
                elif case == "readback-tag":
                    observed["tag_name"] = "v9.9.9"
                elif case == "readback-assets":
                    observed["assets"] = [{"name": "unexpected"}]
                response.read.return_value = json.dumps(created).encode("utf-8")
                reader.return_value = observed
                if case == "unknown-readback":
                    reader.side_effect = RELEASE.urllib.error.HTTPError(url + "/7", 403, "unknown readback", {}, None)
                    self.addCleanup(reader.side_effect.close)
                if case == "valid":
                    self.assertEqual(RELEASE.create_draft("test/repo", "v0.5.7", "a" * 40, "title", notes), original)
                    reader.assert_called_once_with("test/repo", "releases/7")
                else:
                    with self.assertRaises((ValueError, RELEASE.urllib.error.HTTPError)):
                        RELEASE.create_draft("test/repo", "v0.5.7", "a" * 40, "title", notes)
                self.assertEqual(opener.return_value.open.call_count, 1)
                # request is the actual urllib Request, whose endpoint, method, credential and exact body are asserted.
                # request 是实际 urllib Request，其端点、方法、凭据和精确正文均受断言检查。
                request = opener.return_value.open.call_args.args[0]
                self.assertEqual(request.get_method(), "POST")
                self.assertEqual(request.full_url, url)
                self.assertEqual(request.get_header("Authorization"), "Bearer unit-only-current-token")
                self.assertEqual(json.loads(request.data), {"tag_name": "v0.5.7", "target_commitish": "a" * 40,
                                 "name": "title", "body": "exact notes\n", "draft": True, "prerelease": False})

    def test_wrong_actual_tag_prevents_every_sdk_and_example_release_mutation(self):
        """Reject a wrong recursive real tag despite a matching draft target, before upload/create/edit.
        草稿目标匹配但递归真实标签错误时，在上传、创建、公开前拒绝。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            for draft_exists in (False, True):
                with self.subTest(tag=tag, draft_exists=draft_exists):
                    draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}

                    def reader(repository, path, binary=False):
                        """Keep published-by-tag absent and expose the separate real annotated Git reference.
                        保持已公开按标签查询缺失，独立暴露真实附注 Git 引用。
                        """
                        if path.startswith("releases/tags/"):
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft", {}, None)
                        if path == "releases?per_page=100&page=1":
                            return [draft] if draft_exists else []
                        if path == "releases?per_page=100&page=2":
                            return []
                        if path == "git/ref/tags/" + tag:
                            return {"ref": "refs/tags/" + tag, "object": {"type": "tag", "sha": "c" * 40}}
                        if path == "git/tags/" + "c" * 40:
                            return {"sha": "c" * 40, "object": {"type": "tag", "sha": "d" * 40}}
                        if path == "git/tags/" + "d" * 40:
                            return {"sha": "d" * 40, "object": {"type": "commit", "sha": "b" * 40}}
                        raise AssertionError("Unexpected tag API route: " + path)

                    with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                         patch.object(RELEASE, "release_assets") as assets, self.assertRaisesRegex(ValueError, "tag/source mismatch"):
                        RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                    command.assert_not_called()
                    assets.assert_not_called()

    def test_only_initial_exact_tag_ref_404_means_absence(self):
        """Reject nested-object or unexpected-origin 404 while typing only the initial exact missing ref.
        拒绝嵌套对象及非预期来源 404，仅初始精确引用缺失可具备专用类型。
        """
        reference = {"ref": "refs/tags/v0.5.7", "object": {"type": "tag", "sha": "c" * 40}}
        for initial, url, expected in ((True, "https://api.github.com/repos/test/repo/git/ref/tags/v0.5.7", RELEASE.SDKTagMissing),
                                       (True, "https://api.github.com/unexpected", RELEASE.urllib.error.HTTPError),
                                       (False, "https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, RELEASE.urllib.error.HTTPError)):
            with self.subTest(initial=initial, url=url):
                error = RELEASE.urllib.error.HTTPError(url, 404, "unit-only missing ref/object", {}, None)
                self.addCleanup(error.close)
                replies = [error] if initial else [reference, error]
                with patch.object(RELEASE, "github_request", side_effect=replies), self.assertRaises(expected):
                    RELEASE.resolve_sdk_tag("test/repo", "v0.5.7", "a" * 40)

    def test_preflight_existing_unresolved_annotation_never_authorizes(self):
        """Preserve an existing annotated-ref object's 404 as unknown despite a valid source/workflow.
        即使源码、工作流有效，既有附注引用对象的 404 仍保留为未知。
        """
        args = SimpleNamespace(repository="test/repo", version="0.5.7", sdk_source_sha="a" * 40,
                               output=self.root / "preflight.json")
        error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
        self.addCleanup(error.close)
        replies = [{"full_name": "test/repo", "permissions": {"push": True}, "default_branch": "main"},
                   {"object": {"type": "commit", "sha": "a" * 40}},
                   {"type": "file", "encoding": "base64", "content": RELEASE.base64.b64encode((ROOT / ".github/workflows/sdk-release.yml").read_bytes()).decode()},
                   {"ref": "refs/tags/v0.5.7", "object": {"type": "tag", "sha": "c" * 40}}, error]
        with patch.dict(os.environ, {"GH_TOKEN": "fixture-only"}), \
                patch.object(RELEASE, "github_request", side_effect=replies), self.assertRaises(RELEASE.urllib.error.HTTPError):
            RELEASE.publication_preflight(args)
        self.assertFalse(args.output.exists())

    def test_actual_blob_denial_stops_real_npm_publication_entry(self):
        """Run real publish_or_verify and real preflight; reject HTTP403 before registry reads or npm invocation.
        运行真实 publish_or_verify 及真实 preflight；HTTP403 在 registry 读取或 npm 调用前拒绝。
        """
        # Arguments retain real package and native fixtures; preflight is saved before external fixtures enter.
        # arguments 保留真实包及原生夹具；preflight 在外部夹具进入前保存。
        arguments = self.publication_args()
        preflight = RELEASE.publication_preflight
        arguments.output = self.root / "must-not-publish.json"
        with RepositoryRootTests.transport(self) as state, \
                self.publication_context([], [], SimpleNamespace(returncode=0, stdout="", stderr=""))[0], \
                patch.object(RELEASE, "publication_preflight", wraps=preflight), \
                patch.object(RELEASE, "registry_package") as registry, \
                patch.object(RELEASE, "npm_publish_archive") as npm:
            # tag is the current real package's release tag, independently of the transport's historical fixture.
            # tag 是当前真实包的发布标签，独立于传输的历史夹具。
            tag = "v" + self.identity["sdk_version"]
            state.routes[state.base + "/git/ref/tags/" + tag] = {"ref": "refs/tags/" + tag,
                "object": {"type": "commit", "sha": state.source}}
            state.status = 403
            with self.assertRaises(RELEASE.urllib.error.HTTPError) as rejection:
                RELEASE.publish_or_verify(arguments)
            self.assertEqual(rejection.exception.code, 403)
            registry.assert_not_called()
            npm.assert_not_called()
        self.assertFalse(arguments.output.exists())

    def test_unresolved_annotation_prevents_every_release_mutation(self):
        """Fail SDK/examples create/resume before any mutation when a real existing tag cannot resolve.
        真实既有标签不能解析时，SDK、示例新建及恢复在任何变更前失败。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            for draft_exists in (False, True):
                with self.subTest(tag=tag, draft_exists=draft_exists):
                    draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                    error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
                    self.addCleanup(error.close)

                    def reader(repository, path, binary=False):
                        """Serve a present exact ref and fail its object lookup, with published-by-tag still absent.
                        提供存在的精确引用并使其对象查询失败，已公开按标签查询仍缺失。
                        """
                        if path.startswith("releases/tags/"):
                            raise RELEASE.urllib.error.HTTPError("https://api.github.com/fixture", 404, "draft", {}, None)
                        if path == "releases?per_page=100&page=1":
                            return [draft] if draft_exists else []
                        if path == "releases?per_page=100&page=2":
                            return []
                        if path == "git/ref/tags/" + tag:
                            return {"ref": "refs/tags/" + tag, "object": {"type": "tag", "sha": "c" * 40}}
                        if path == "git/tags/" + "c" * 40:
                            raise error
                        raise AssertionError("Unexpected unresolved tag route: " + path)

                    with patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                         patch.object(RELEASE, "release_assets") as assets, self.assertRaises(RELEASE.urllib.error.HTTPError):
                        RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                    command.assert_not_called()
                    assets.assert_not_called()

    def test_prepublication_tag_recheck_rejects_nested_404_without_edit(self):
        """Recheck a previously valid tag before public edit and reject a newly unresolved annotation.
        公开变更前重查先前有效标签，拒绝新出现的附注对象无法解析。
        """
        for tag in ("v0.5.7", "examples-v0.5.7"):
            with self.subTest(tag=tag):
                draft = {"id": 7, "tag_name": tag, "draft": True, "prerelease": False, "target_commitish": "a" * 40}
                state = {"refs": 0}
                error = RELEASE.urllib.error.HTTPError("https://api.github.com/repos/test/repo/git/tags/" + "c" * 40, 404, "missing annotation", {}, None)
                self.addCleanup(error.close)

                def reader(repository, path, binary=False):
                    """Serve matching existing draft bytes and make only the final real tag lookup unresolved.
                    提供匹配的既有草稿字节，仅使最后真实标签查询无法解析。
                    """
                    if path == "git/ref/tags/" + tag:
                        state["refs"] += 1
                        kind = "commit" if state["refs"] == 1 else "tag"
                        sha = "a" * 40 if state["refs"] == 1 else "c" * 40
                        return {"ref": "refs/tags/" + tag, "object": {"type": kind, "sha": sha}}
                    if path == "git/tags/" + "c" * 40:
                        raise error
                    if path == "releases/assets/10":
                        return self.archive.read_bytes()
                    raise AssertionError("Unexpected final tag recheck route: " + path)

                with patch.object(RELEASE, "release_by_tag", return_value=draft), patch.object(RELEASE, "github_request", side_effect=reader), \
                     patch.object(RELEASE, "release_assets", return_value={self.archive.name: {"id": 10}}), \
                     patch.object(RELEASE, "run") as command, self.assertRaises(RELEASE.urllib.error.HTTPError):
                    RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                command.assert_not_called()
                self.assertEqual(state["refs"], 2)

    def test_existing_exact_npm_bytes_reused_without_publish(self):
        """Download real tgz bytes through the official metadata boundary and reuse without npm mutation.
        经官方元数据边界下载真实 tgz 字节，无 npm 变更地复用。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        stack, command = self.publication_context([self.npm_metadata()], [io.BytesIO(self.archive.read_bytes())], None)
        with stack:
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertEqual(RELEASE.read_json(args.output)["action"], "reused")

    def test_existing_changed_npm_bytes_fail_without_publish(self):
        """Reject a changed official tarball before any npm publish and omit success evidence.
        官方 tarball 字节变化时在 npm 发布前拒绝，不输出成功证据。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        stack, command = self.publication_context([self.npm_metadata()], [io.BytesIO(b"other bytes")], None)
        with stack, self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())

    def test_only_exact_version_404_publishes_once_then_checks_actual_bytes(self):
        """Publish only after exact version absence and require a fresh post-publish actual tgz download.
        仅精确版本缺失后发布，且要求发布后全新下载实际 tgz。
        """
        args = self.publication_args()
        args.output = self.root / "publication.json"
        completed = RELEASE.subprocess.CompletedProcess([], 0, b"{}", b"")
        stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()],
                                                  [io.BytesIO(self.archive.read_bytes())], completed)
        with stack:
            RELEASE.publish_or_verify(args)
        command.assert_called_once()
        self.assertEqual(command.call_args.args[0], ["unit-only-npm", "publish", str(self.archive), "--ignore-scripts", "--provenance",
                                                     "--access", "public", "--registry", "https://registry.npmjs.org", "--json"])
        self.assertEqual(RELEASE.read_json(args.output)["action"], "published")

    def test_postpublication_exact_404_preserves_failure_without_second_publish(self):
        """Preserve the actual second HTTP404 after zero/conflict; record process evidence but no success.
        在零退出或冲突后保留第二个实际 HTTP404；记录子进程证据而不生成成功。
        """
        # Both original accepted npm decisions must still obey the fresh registry postcondition.
        # 两种原可接受 npm 判定都必须服从全新注册表后置条件。
        args = self.publication_args()
        for conflict in (False, True):
            with self.subTest(conflict=conflict):
                # Keep each output and derived diagnostics distinct and originally nonexistent.
                # 每份输出及派生诊断保持独立且原先不存在。
                args.output = self.root / f'postpublication-404-{conflict}.json'
                # Model only the external npm boundary as in existing publication tests.
                # 按既有发布测试，仅模拟外部 npm 边界。
                stdout = b'{"error":{"code":"E409","summary":"Conflict"}}' if conflict else b'{}'
                completed = RELEASE.subprocess.CompletedProcess([], 17 if conflict else 0, stdout, b'observed stderr\r\n')
                # The second precise endpoint exception must retain its original object identity.
                # 第二个精确端点异常必须保留原对象身份。
                second = self.missing_npm_version()
                stack, command = self.publication_context([self.missing_npm_version(), second], [], completed)
                with stack, self.assertRaises(RELEASE.urllib.error.HTTPError) as caught:
                    RELEASE.publish_or_verify(args)
                self.assertIs(caught.exception, second)
                command.assert_called_once()
                self.assertFalse(args.output.exists())
                # The actual diagnostic receipt never asserts publication success or triggers retry.
                # 实际诊断回执绝不声称发布成功或触发重试。
                prefix = args.output.with_suffix('.npm')
                self.assertEqual(Path(str(prefix)+'.stdout.log').read_bytes(), stdout)
                self.assertEqual(Path(str(prefix)+'.stderr.log').read_bytes(), b'observed stderr\r\n')
                self.assertEqual(RELEASE.read_json(Path(str(prefix)+'.process.json'))['returncode'], completed.returncode)

    def test_registry_unknown_or_missing_tarball_never_publishes(self):
        """Reject permission/service states and a broken existing tarball without interpreting them as absence.
        拒绝权限、服务状态及既有 tarball 损坏，不能把这些解释成缺失。
        """
        args = self.publication_args()
        for code in (401, 403, 503):
            with self.subTest(code=code):
                args.output = self.root / f"publication-{code}.json"
                stack, command = self.publication_context([self.missing_npm_version(code)], [], None)
                with stack, self.assertRaises(RELEASE.urllib.error.HTTPError):
                    RELEASE.publish_or_verify(args)
                command.assert_not_called()
                self.assertFalse(args.output.exists())
        args.output = self.root / "tarball-404.json"
        error = RELEASE.urllib.error.HTTPError(self.npm_metadata()["dist"]["tarball"], 404, "missing tarball", {}, None)
        self.addCleanup(error.close)
        stack, command = self.publication_context([self.npm_metadata()], [error], None)
        with stack, self.assertRaises(RELEASE.urllib.error.HTTPError):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())

    def test_npm_race_requires_exact_fresh_registry_bytes(self):
        """Accept only explicit known version races followed by real exact bytes; reject a changed winner.
        仅明确已知版本竞争加真实精确字节可通过；拒绝获胜者字节变化。
        """
        args = self.publication_args()
        errors = [{"code": "EPUBLISHCONFLICT", "summary": "Cannot publish over existing version."},
                  {"code": "E409", "summary": "Conflict"},
                  {"summary": f"You cannot publish over the previously published versions: {self.identity['sdk_version']}."}]
        for index, error in enumerate(errors):
            with self.subTest(error=error):
                args.output = self.root / f"race-{index}.json"
                completed = RELEASE.subprocess.CompletedProcess([], 1, json.dumps({"error": error}).encode("utf-8"), b"")
                stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()],
                                                          [io.BytesIO(self.archive.read_bytes())], completed)
                with stack:
                    RELEASE.publish_or_verify(args)
                command.assert_called_once()
                self.assertEqual(RELEASE.read_json(args.output)["action"], "race-reused")
        args.output = self.root / "race-changed.json"
        stack, command = self.publication_context([self.missing_npm_version(), self.npm_metadata()], [io.BytesIO(b"changed winner")], completed)
        with stack, self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.publish_or_verify(args)
        command.assert_called_once()
        self.assertFalse(args.output.exists())

    def test_npm_publish_unknown_error_never_becomes_registry_success(self):
        """Fail closed for permission/service/unstructured errors instead of rechecking arbitrary publish failures.
        权限、服务、无结构错误必须失败，不能将任意发布失败变成注册表复核成功。
        """
        args = self.publication_args()
        for index, error in enumerate(({"code": "E403", "summary": "Forbidden"}, {"code": "E503", "summary": "Unavailable"},
                                        {"summary": "Unknown failure"}, {"code": "E403", "summary": f"You cannot publish over the previously published versions: {self.identity['sdk_version']}."})):
            with self.subTest(error=error):
                args.output = self.root / f"failure-{index}.json"
                completed = RELEASE.subprocess.CompletedProcess([], 1, json.dumps({"error": error}).encode("utf-8"), b"")
                stack, command = self.publication_context([self.missing_npm_version()], [], completed)
                with stack, self.assertRaisesRegex(ValueError, "npm publication failed"):
                    RELEASE.publish_or_verify(args)
                command.assert_called_once()
                self.assertFalse(args.output.exists())

    def test_publication_source_or_matrix_drift_prevents_registry_and_publish(self):
        """Check the publication wrapper rejects actual freeze/matrix drift before any external registry operation.
        验证发布入口在任何外部注册表操作前拒绝冻结身份、矩阵漂移。
        """
        args = self.publication_args()
        args.output = self.root / "source-drift.json"
        stack, command = self.publication_context([], [], None)
        with stack, patch.object(RELEASE, "run", return_value="c" * 40), self.assertRaisesRegex(ValueError, "source/workflow SHA"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())
        args.output = self.root / "aggregate-drift.json"
        proof = RELEASE.read_json(args.aggregate)
        proof["complete"] = False
        args.aggregate.write_text(json.dumps(proof), encoding="utf-8")
        stack, command = self.publication_context([], [], None)
        with stack, self.assertRaisesRegex(ValueError, "Publication aggregate changed"):
            RELEASE.publish_or_verify(args)
        command.assert_not_called()
        self.assertFalse(args.output.exists())


    def test_formal_npm_tarball_hash_mismatch_rejected(self):
        """Reject an official-version response if its actual package bytes differ from tested tgz.
        官方版本响应的实际包字节与被测 tgz 不同时拒绝。
        """
        metadata = {"name": "@luaskills/sdk", "version": self.identity["sdk_version"],
                    "dist": {"tarball": "https://registry.npmjs.org/@luaskills/sdk/-/sdk.tgz"}}
        with patch.object(RELEASE, "request_json", return_value=metadata), \
             patch.object(RELEASE.urllib.request, "urlopen", return_value=io.BytesIO(b"other-package")), \
             self.assertRaisesRegex(ValueError, "differs from tested"):
            RELEASE.registry_package(self.identity, self.root)

    def attestation_fixture(self):
        """Return the official verified-output shape with clearly unit-only certificate values.
        返回官方验证输出形状，证书值明确仅限单测。
        """
        invocation = "https://github.com/test/repo/actions/runs/123/attempts/1"
        certificate = {"runInvocationURI": invocation, "sourceRepositoryURI": "https://github.com/test/repo",
            "sourceRepositoryDigest": "a" * 40, "buildSignerDigest": "a" * 40,
            "sourceRepositoryRef": "refs/heads/main", "buildSignerURI": "https://github.com/test/repo/.github/workflows/sdk-release.yml@refs/heads/main",
            "runnerEnvironment": "github-hosted"}
        return [{"verificationResult": {"signature": {"certificate": certificate}, "statement": {
            "predicateType": "https://slsa.dev/provenance/v1", "subject": [{"name": self.archive.name, "digest": {"sha256": RELEASE.digest(self.archive)}}],
            "predicate": {"runDetails": {"metadata": {"invocationId": invocation}}}}}}]

    def test_official_attestation_command_binds_actual_subject_and_certificate(self):
        """Require exact official verifier policy and actual subject/run/source certificate fields.
        要求精确官方验证器策略及实际主体、运行、源码证书字段。
        """
        bundle = self.root / "sigstore.jsonl"
        bundle.write_text("unit-only-bundle", encoding="utf-8")
        with patch.object(RELEASE, "run", return_value=json.dumps(self.attestation_fixture())) as command:
            RELEASE.verify_attestation(self.archive, bundle, "test/repo", "a" * 40, "123", 1, "refs/heads/main")
        self.assertEqual(command.call_args.args[0], ["gh", "attestation", "verify", self.archive, "--repo", "test/repo",
            "--signer-workflow", "test/repo/.github/workflows/sdk-release.yml", "--source-digest", "a" * 40,
            "--signer-digest", "a" * 40, "--source-ref", "refs/heads/main", "--deny-self-hosted-runners", "--bundle", bundle, "--format", "json"])

    def test_signed_certificate_subject_or_invocation_mutations_fail(self):
        """Self-rehashed metadata cannot replace the authenticated certificate, invocation or subject.
        自行重算摘要的元数据不能替代认证证书、调用或主体。
        """
        changes = [lambda r: r["signature"]["certificate"].update(runInvocationURI="https://github.com/test/repo/actions/runs/999/attempts/1"),
                   lambda r: r["signature"]["certificate"].update(sourceRepositoryDigest="0" * 40),
                   lambda r: r["signature"]["certificate"].update(buildSignerDigest="0" * 40),
                   lambda r: r["signature"]["certificate"].update(runnerEnvironment="self-hosted"),
                   lambda r: r["statement"]["subject"][0]["digest"].update(sha256="0" * 64),
                   lambda r: r["statement"]["predicate"]["runDetails"]["metadata"].update(invocationId="forged"),
                   lambda r: r["statement"].update(predicateType="unsupported")]
        for change in changes:
            with self.subTest(change=change):
                fixture = self.attestation_fixture()
                change(fixture[0]["verificationResult"])
                with patch.object(RELEASE, "run", return_value=json.dumps(fixture)), self.assertRaises(ValueError):
                    RELEASE.verify_attestation(self.archive, self.archive, "test/repo", "a" * 40, "123", 1, "refs/heads/main")
        with patch.object(RELEASE, "run", side_effect=ValueError("official signature verification failed")), self.assertRaisesRegex(ValueError, "official signature"):
            RELEASE.verify_attestation(self.archive, self.archive, "test/repo", "a" * 40, "123", 1, "refs/heads/main")



    def recovery_environment(self, run_id=123, attempt=2, intent="artifact-only", workflow=RELEASE.SDK_WORKFLOW):
        """Return explicit current GitHub identity for unit-only signed candidate/completion fixtures.
        返回单测签名候选、完成夹具的明确当前 GitHub 身份。
        """
        return {"GITHUB_SHA": self.identity["sdk_source_sha"], "GITHUB_WORKFLOW_SHA": self.identity["sdk_source_sha"],
            "GITHUB_RUN_ID": str(run_id), "GITHUB_RUN_ATTEMPT": str(attempt), "GITHUB_REF": "refs/heads/main",
            "GITHUB_WORKFLOW_REF": "test/repo/" + workflow + "@refs/heads/main", "DEFAULT_BRANCH": "main", "COMPLETION_INTENT": intent}

    def add_attempt(self, run_id, attempt, names, conclusion="failure", mode="artifact-only", workflow=RELEASE.SDK_WORKFLOW):
        """Register exact attempt/jobs responses without latest lookup; return its mutable actual run.
        注册精确轮次、作业响应而不查询最新状态；返回可变实际运行。
        """
        endpoint = f"https://api.github.com/repos/test/repo/actions/runs/{run_id}/attempts/{attempt}"
        actual = {"id": run_id, "run_attempt": attempt, "repository": {"full_name": "test/repo"}, "head_repository": {"full_name": "test/repo"},
            "head_sha": self.identity["sdk_source_sha"], "head_branch": "main", "path": workflow + "@main", "workflow_id": 7,
            "event": "workflow_dispatch", "display_title": ("SDK " if workflow == RELEASE.SDK_WORKFLOW else "Examples ") + self.identity["sdk_source_sha"] + " mode=" + mode,
            "status": "completed" if conclusion is not None else "in_progress", "conclusion": conclusion}
        jobs = [{"id": 1000 + index, "run_id": run_id, "head_sha": self.identity["sdk_source_sha"], "run_url": f"https://api.github.com/repos/test/repo/actions/runs/{run_id}",
            "name": name, "status": "completed", "conclusion": "success"} for index, name in enumerate(names)]
        self.http.responses[endpoint] = actual
        self.http.responses[endpoint + "/jobs?per_page=100&page=1"] = {"total_count": len(jobs), "jobs": jobs}
        return actual

    def fixture_signature(self, directory, name, run_id, attempt, workflow=RELEASE.SDK_WORKFLOW):
        """Store clearly synthetic official verifier output for every physical subject; no cryptographic success is claimed.
        保存每个物理主体的明确合成官方验证器输出；不声称加密验签成功。
        """
        marker = f"unit-only-signature-{workflow}-{run_id}-{attempt}"
        (directory / name).write_text(marker, encoding="utf-8")
        files = {path.name: path.read_bytes() for path in directory.iterdir() if path.is_file() and path.name != name}
        self.signatures[marker] = {"run_id": run_id, "attempt": attempt, "workflow": workflow, "files": files}

    def recovery_command(self, arguments, *extra, **keywords):
        """Replace git/official-verifier process boundaries only, preserving production parser and every byte check.
        仅替换 Git、官方验证器进程边界，保留生产解析器及每个字节检查。
        """
        if arguments[:3] == ["git", "rev-parse", "HEAD"]:
            return self.identity["sdk_source_sha"]
        if arguments[:3] == ["gh", "attestation", "verify"]:
            marker = Path(arguments[arguments.index("--bundle") + 1]).read_text(encoding="utf-8")
            signed = self.signatures[marker]
            invocation = RECOVERY.invocation_uri("test/repo", signed["run_id"], signed["attempt"])
            certificate = {"runInvocationURI": invocation, "sourceRepositoryURI": "https://github.com/test/repo",
                "sourceRepositoryDigest": self.identity["sdk_source_sha"], "buildSignerDigest": self.identity["sdk_source_sha"],
                "sourceRepositoryRef": "refs/heads/main", "buildSignerURI": "https://github.com/test/repo/" + signed["workflow"] + "@refs/heads/main", "runnerEnvironment": "github-hosted"}
            subjects = [{"name": name, "digest": {"sha256": hashlib.sha256(body).hexdigest()}} for name, body in signed["files"].items()]
            return json.dumps([{"verificationResult": {"signature": {"certificate": certificate}, "statement": {
                "predicateType": "https://slsa.dev/provenance/v1", "subject": subjects, "predicate": {"runDetails": {"metadata": {"invocationId": invocation}}}}}}])
        raise AssertionError("Unexpected recovery process: " + str(arguments))

    def recovery_context(self):
        """Bind real public recovery authority to an offline HTTP transport and exact unit-only core resolver.
        将真实公共恢复权威绑定到离线 HTTP 传输及精确仅限单测核心解析器。
        """
        shared = self.shared_fixture()
        shared.Http = lambda: self.http
        stack = contextlib.ExitStack()
        # The exact resolver instance is retained for assertions about both packing stages.
        # 保留精确解析器实例，用于断言两个打包阶段。
        stack.shared = shared
        stack.enter_context(patch.object(RELEASE, "authority", return_value=CORE))
        stack.enter_context(patch.object(RELEASE, "shared_gate", return_value=shared))
        stack.enter_context(patch.object(RELEASE, "recovery_authority", return_value=(RECOVERY, shared)))
        stack.enter_context(patch.object(RELEASE, "run", side_effect=self.recovery_command))
        # These pre-existing orchestration fixtures intentionally lack actual Core archive/native inputs.
        # 这些既有编排夹具刻意不包含实际 Core 归档及原生输入。
        stack.core_selection = stack.enter_context(patch.object(RELEASE, "core_proof_members",
            side_effect=lambda report, _: {path.relative_to(Path(report).parent).as_posix(): path
                                           for path in sorted(Path(report).parent.rglob("*")) if path.is_file()}))
        return stack

    def original_candidate_fixture(self):
        """Build the real schema2 bundle around actual tgz, full synthetic native logs and core bytes; return frozen files.
        围绕真实 tgz、完整合成原生日志及核心字节构建实际 schema2 包；返回冻结文件。
        """
        self.http = RecoveryHttp({})
        self.signatures = {}
        for key in CORE.PLATFORMS:
            (self.evidence / (key + ".json")).unlink()
            folder = self.evidence / ("native-" + key)
            folder.mkdir()
            RELEASE.write_json(folder / "result.json", self.records[key])
            (folder / "native.stdout.log").write_text(json.dumps(self.records[key]["test"]) + "\n", encoding="utf-8")
            (folder / "native.stderr.log").write_bytes(b"")
        self.aggregate()
        core = self.root / "core-proof"
        core.mkdir()
        (core / "prerequisites.json").write_bytes(self.prerequisites.read_bytes())
        (core / "actual-core.log").write_bytes(b"unit-only complete core evidence")
        self.add_attempt(123, 2, RELEASE.candidate_jobs(OPTIONS.core_root))
        directory = self.root / "signed-candidate"
        args = SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", mode="artifact-only", artifact=self.artifact,
            aggregate=self.args.output, prerequisites=core / "prerequisites.json", evidence_dir=self.evidence, output=directory)
        with self.recovery_context() as context, patch.dict(os.environ, self.recovery_environment()):
            with contextlib.redirect_stdout(io.StringIO()) as stdout:
                RELEASE.candidate_bundle(args)
            self.assertEqual(stdout.getvalue().strip(), RECOVERY.candidate_artifact_name(123, 2))
            context.core_selection.assert_called_once_with(args.prerequisites, context.shared)
        self.fixture_signature(directory, RELEASE.CANDIDATE_ATTESTATION, 123, 2)
        with self.recovery_context(), patch.dict(os.environ, self.recovery_environment()):
            RELEASE.candidate_seal(SimpleNamespace(core_root=OPTIONS.core_root, input=directory))
        files = {path.name: path.read_bytes() for path in directory.iterdir()}
        self.register_artifact(files, 77)
        return directory, files

    def register_artifact(self, files, artifact_id=77, run_id=123, attempt=2):
        """Build a real root-file ZIP and exact API metadata for the explicit uploaded artifact ID.
        为明确上传制品 ID 构建实际根文件 ZIP 及精确 API 元数据。
        """
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, body in files.items():
                archive.writestr(name, body)
        body = stream.getvalue()
        endpoint = f"https://api.github.com/repos/test/repo/actions/artifacts/{artifact_id}"
        self.http.responses[endpoint] = {"id": artifact_id, "name": RECOVERY.candidate_artifact_name(run_id, attempt), "expired": False,
            "workflow_run": {"id": run_id, "head_sha": self.identity["sdk_source_sha"]}, "size_in_bytes": len(body), "digest": "sha256:" + hashlib.sha256(body).hexdigest()}
        self.http.responses[endpoint + "/zip"] = body

    def fetch_args(self, output="restored"):
        """Return explicit candidate download inputs using the original second attempt, never the latest.
        返回使用原第二轮次的明确候选下载输入，绝不使用最新轮次。
        """
        return SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", sdk_source_sha=self.identity["sdk_source_sha"],
            candidate_run_id="123", candidate_run_attempt="2", candidate_artifact_id="77", output=self.root / output)

    def test_original_failed_whole_attempt_restores_exact_signed_bytes(self):
        """Recover successful original candidate gates while retaining their actual whole-attempt failure and mode.
        恢复成功原候选门禁，同时保留实际整轮失败及模式。
        """
        _, files = self.original_candidate_fixture()
        args = self.fetch_args()
        with self.recovery_context():
            RELEASE.candidate_fetch(args)
            state = RELEASE.local_candidate(SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", candidate=args.output))
        self.assertEqual(state["attempt"]["attempt"]["conclusion"], "failure")
        self.assertEqual(state["manifest"]["mode"], "artifact-only")
        self.assertEqual({p.name: p.read_bytes() for p in (args.output / "original").iterdir()}, files)
        self.assertFalse(any("filter=latest" in url or url.endswith("actions/runs/123") for url in self.http.calls))

    def test_current_active_candidate_preserves_actual_state(self):
        """Accept completed signed evidence gates during an active publish attempt without synthesizing success.
        在运行中发布轮次接受已完成签名证据门禁，不合成成功状态。
        """
        self.original_candidate_fixture()
        self.http.responses["https://api.github.com/repos/test/repo/actions/runs/123/attempts/2"].update(status="in_progress", conclusion=None)
        with self.recovery_context():
            RELEASE.candidate_fetch(self.fetch_args())
        header = RELEASE.read_json(self.root / "restored/candidate-authentication.json")
        self.assertEqual(header["attempt"]["attempt"]["status"], "in_progress")
        self.assertIsNone(header["attempt"]["attempt"]["conclusion"])

    def test_unknown_attempt_gate_missing_artifact_and_signature_fail_before_mutation(self):
        """Reject missing/unknown original authority, failed gates and expired/unsigned files before every publication call.
        在每次发布调用前拒绝缺失、未知原权威、失败门禁及过期、无签名文件。
        """
        _, original = self.original_candidate_fixture()
        endpoint = "https://api.github.com/repos/test/repo/actions/runs/123/attempts/2"
        mutations = [lambda: self.http.responses[endpoint].update(status="queued", conclusion=None),
            lambda: self.http.responses[endpoint + "/jobs?per_page=100&page=1"]["jobs"][-1].update(conclusion="failure"),
            lambda: self.http.responses["https://api.github.com/repos/test/repo/actions/artifacts/77"].update(expired=True),
            lambda: self.http.responses.pop("https://api.github.com/repos/test/repo/actions/artifacts/77"),
            lambda: self.register_artifact({n:b for n,b in original.items() if n != RELEASE.CANDIDATE_ATTESTATION}),
            lambda: self.register_artifact({**original, self.archive.name: b"modified original tgz"})]
        baseline = copy.deepcopy(self.http.responses)
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.http.responses = copy.deepcopy(baseline)
                mutate()
                args = self.fetch_args("rejected-" + str(index))
                with self.recovery_context(), patch.object(RELEASE, "immutable_upload") as mutation, patch.object(RELEASE, "npm_publish_archive") as npm, self.assertRaises(ValueError):
                    RELEASE.candidate_fetch(args)
                mutation.assert_not_called()
                npm.assert_not_called()
                self.assertFalse((args.output / "candidate-authentication.json").exists())

    def test_explicit_original_attempt_cannot_use_other_attempt_signature(self):
        """An original artifact's signature cannot be rebound to another explicit successful API attempt.
        原制品签名不能重新绑定到另一明确成功 API 轮次。
        """
        self.original_candidate_fixture()
        self.add_attempt(123, 3, RELEASE.candidate_jobs(OPTIONS.core_root), conclusion="success")
        args = self.fetch_args()
        args.candidate_run_attempt = "3"
        self.http.responses["https://api.github.com/repos/test/repo/actions/artifacts/77"]["name"] = RECOVERY.candidate_artifact_name(123, 3)
        with self.recovery_context(), self.assertRaisesRegex(ValueError, "certificate issuer/source/run"):
            RELEASE.candidate_fetch(args)

    def completion_fixture(self):
        """Create a new signed completion referencing an actual unit-only main Release with unchanged original package bytes.
        创建引用实际单测主 Release 的新签名完成证明，保持原包字节不变。
        """
        _, files = self.original_candidate_fixture()
        with self.recovery_context():
            RELEASE.candidate_fetch(self.fetch_args())
        self.add_attempt(456, 3, [RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"publish")], conclusion="success", mode="recover")
        # Each name/body maps an original filename to its exact bytes; only nonempty bytes enter the remote fixture.
        # 各 name／body 将原文件名映射到精确字节；仅非空字节进入远端夹具。
        self.release_files = {11: {name: body for name, body in files.items() if body}}
        self.releases = {11: {"id":11,"tag_name":"v" + self.identity["sdk_version"],"draft":False,"prerelease":False,"immutable":False}}
        root = self.root / "restored"
        consumer = self.root / "fresh-consumer.json"
        RELEASE.write_json(consumer, {"schema_version":1,"artifact":self.identity,"success":True,"cache":"new-empty-cache","test":next(iter(self.records.values()))["test"]})
        proof = self.root / "fresh-aggregate.json"
        core = root / "core-prerequisites/prerequisites.json"
        main = self.root / "main-release.json"
        RELEASE.write_json(main, self.releases[11])
        args = SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", candidate=root, intent="recover", consumer=consumer,
            aggregate=proof, prerequisites=core, main_release=main, output=self.root / "completion")
        with self.recovery_context() as context, patch.object(RELEASE,"github_request",side_effect=self.recovery_reader), patch.dict(os.environ,self.recovery_environment(456,3,"recover")):
            RELEASE.aggregate(SimpleNamespace(core_root=OPTIONS.core_root, artifact=root/"original"/RELEASE.RELEASE_FILES["artifact"],
                prerequisites=core,evidence_dir=root/"native-evidence",output=proof))
            RELEASE.completion_bundle(args)
            context.core_selection.assert_called_once_with(args.prerequisites, context.shared)
        self.fixture_signature(args.output, RELEASE.COMPLETION_ATTESTATION, 456, 3)
        self.release_files[22] = {p.name:p.read_bytes() for p in args.output.iterdir()}
        self.releases[22] = {"id":22,"tag_name":RELEASE.completion_tag(self.identity["sdk_version"],456,3),"draft":False,"prerelease":False,"immutable":False}
        return args

    def recovery_reader(self, repository, path, binary=False):
        """Expose real ID/tag/assets routes for permanent original/completion files and fail undefined API requests.
        暴露持久原候选、完成文件的真实 ID、标签、资产路由，对未定义 API 请求失败。
        """
        self.assertEqual(repository,"test/repo")
        if path.startswith("actions/"):
            return self.http.json("https://api.github.com/repos/test/repo/" + path)
        if path.startswith("git/ref/tags/"):
            tag=path.removeprefix("git/ref/tags/")
            return {"ref":"refs/tags/"+tag,"object":{"type":"commit","sha":self.identity["sdk_source_sha"]}}
        if path.startswith("releases/tags/"):
            tag=path.removeprefix("releases/tags/")
            return next(record for record in self.releases.values() if record["tag_name"]==tag)
        if path.startswith("releases/assets/"):
            self.assertTrue(binary)
            number=int(path.removeprefix("releases/assets/"))
            release_id,index=divmod(number,100)
            return list(sorted(self.release_files[release_id].items()))[index][1]
        if "/assets?per_page=100&page=" in path:
            release_id=int(path.split("/")[1])
            if path.endswith("page=1"):
                return [{"id":release_id*100+index,"name":name,"size":len(body)} for index,(name,body) in enumerate(sorted(self.release_files[release_id].items()))]
            return []
        if path.startswith("releases/"):
            return self.releases[int(path.removeprefix("releases/"))]
        raise AssertionError("Unexpected permanent recovery URL: " + path)

    def formal_args(self):
        """Return the explicit original and completion consumer identities, preserving all four run/attempt inputs.
        返回明确原候选、完成消费身份，保留全部四个运行、轮次输入。
        """
        return SimpleNamespace(core_root=OPTIONS.core_root,repository="test/repo",sdk_source_sha=self.identity["sdk_source_sha"],sdk_version=self.identity["sdk_version"],
            candidate_run_id="123",candidate_run_attempt="2",completion_run_id="456",completion_run_attempt="3",
            completion_source_sha=self.identity["sdk_source_sha"],output=self.root/"formal")

    def test_main_release_retains_signed_empty_logs_without_empty_attachments(self):
        """Verify a nonempty physical GA while preserving every signed logical member in the candidate.
        验证非空物理 GA，同时在候选中保留每个签名逻辑成员。
        self owns the isolated original candidate and remote fixture; return nothing or fail an assertion.
        self 拥有隔离原候选及远端夹具；无返回值或使断言失败。
        """
        # files owns complete original subject bytes; the unused first result is discarded, not a fallback source.
        # files 拥有完整原主体字节；不使用的首项结果被丢弃，并非回退来源。
        _, files = self.original_candidate_fixture()
        # Each name/body maps the original filename/bytes; only the remote physical fixture excludes empty members.
        # 各 name／body 映射原文件名／字节；仅远端物理夹具排除空成员。
        self.release_files = {11: {name: body for name, body in files.items() if body}}
        self.releases = {11: {"id": 11, "tag_name": "v" + self.identity["sdk_version"], "draft": False, "prerelease": False}}
        with self.recovery_context(), patch.object(RELEASE, "github_request", side_effect=self.recovery_reader):
            RELEASE.candidate_fetch(self.fetch_args())
            # state is the actually verified local candidate that still owns every signed logical member.
            # state 是实际验证的本地候选，仍拥有每个签名逻辑成员。
            state = RELEASE.local_candidate(SimpleNamespace(core_root=OPTIONS.core_root, repository="test/repo", candidate=self.root / "restored"))
            RELEASE.main_release_matches("test/repo", state, 11)
        # Assertion path/body identify each actual restored path and each original byte string, including empty logs.
        # 断言 path／body 标识各实际恢复路径及各原字节串，包含空日志。
        self.assertEqual({path.name: path.read_bytes() for path in (state["root"] / "original").iterdir()}, files)
        self.assertTrue(any(not body for body in files.values()))

    def test_publish_candidate_passes_only_authenticated_nonempty_files(self):
        """Authenticate the complete real fixture before passing only nonempty original paths to the generic uploader.
        在只向通用上传者传入非空原路径前认证完整实际夹具。
        self owns the isolated recovery candidate and consumer record; return nothing or fail an assertion.
        self 拥有隔离恢复候选及消费记录；无返回值或使断言失败。
        """
        # The existing recovery fixture supplies the original candidate and current completion authority.
        # 既有恢复夹具提供原候选及当前完成权威。
        self.completion_fixture()
        # original maps each path's actual filename to bytes before publication can select physical assets.
        # original 在发布选取物理资产前将各 path 的实际文件名映射到字节。
        original = {path.name: path.read_bytes() for path in (self.root / "restored/original").iterdir()}
        # consumer is the explicit unit-only successful fresh-consumption record path required by publication.
        # consumer 是发布要求的明确仅限单测成功新消费记录路径。
        consumer = self.root / "publish-consumer.json"
        RELEASE.write_json(consumer, {"artifact": self.identity, "success": True, "cache": "new-empty-cache"})
        # args binds exact original candidate, recovery intent, prerequisites and isolated output for this entry.
        # args 为该入口绑定精确原候选、恢复意图、前置证明及隔离输出。
        args = SimpleNamespace(core_root=OPTIONS.core_root, candidate=self.root / "restored", repository="test/repo",
            intent="recover", consumer=consumer, prerequisites=self.prerequisites, output=self.root / "published.json")
        # upload captures only the generic uploader's supplied paths without any actual publication.
        # upload 仅捕获传给通用上传者的路径，不执行任何实际发布。
        with self.recovery_context(), patch.object(RELEASE, "github_request", side_effect=self.recovery_reader), \
             patch.dict(os.environ, self.recovery_environment(456, 3, "recover")), \
             patch.object(RELEASE, "immutable_upload", return_value=self.releases[11]) as upload:
            RELEASE.publish_candidate(args)
        # Comprehension path/name/body are respectively the supplied path, original filename and original bytes.
        # 推导式 path／name／body 分别是传入路径、原文件名和原字节。
        self.assertEqual({path.name for path in upload.call_args.args[3]}, {name for name, body in original.items() if len(body) > 0})
        self.assertTrue(all(path.read_bytes() for path in upload.call_args.args[3]))
        self.assertEqual({path.name: path.read_bytes() for path in (self.root / "restored/original").iterdir()}, original)

    def test_formal_proof_restores_original_empty_members_from_signed_bundle(self):
        """Read the complete signed logical inventory from a GA with no empty attachments before acceptance.
        在接受前从没有空附件的 GA 读取完整签名逻辑库存。
        self owns the isolated original bundle and formal output; return nothing or fail an assertion.
        self 拥有隔离原 bundle 及正式输出；无返回值或使断言失败。
        """
        self.completion_fixture()
        # original maps each original path's name to its bytes independently of the later consumer reconstruction.
        # original 独立于后续消费恢复，将各原 path 的名称映射到其字节。
        original = {path.name: path.read_bytes() for path in (self.root / "restored/original").iterdir()}
        # Each name/body retains the original filename/bytes while the remote fixture exposes only nonempty members.
        # 各 name／body 保留原文件名／字节，远端夹具仅暴露非空成员。
        self.release_files[11] = {name: body for name, body in original.items() if body}
        # args selects the exact original candidate/completion identities and isolated accepted output path.
        # args 选取精确原候选／完成身份及隔离接受输出路径。
        args = self.formal_args()

        def consume(options):
            """Emit explicit unit-only consumer evidence; options owns its exact output path; return nothing.
            生成明确仅限单测消费证据；options 拥有精确输出路径；无返回值。
            """
            RELEASE.write_json(options.output, {"unit_only": True, "artifact": self.identity, "success": True, "cache": "new-empty-cache"})

        with self.recovery_context(), patch.object(RELEASE, "github_request", side_effect=self.recovery_reader), patch.object(RELEASE, "registry_consumer", side_effect=consume):
            RELEASE.formal_proof(args)
        # Assertion path is each actual restored original member whose bytes must equal the untouched baseline.
        # 断言 path 是各实际恢复原成员，其字节必须等于未变基线。
        self.assertEqual({path.name: path.read_bytes() for path in (args.output / "candidate/original").iterdir()}, original)
        self.assertTrue((args.output / "accepted.json").is_file())

    def test_formal_physical_assets_and_empty_bundle_members_fail_closed(self):
        """Reject missing/extra physical files and authenticated size/digest/member inconsistencies before consuming npm.
        在消费 npm 前拒绝缺失／多余物理文件及认证大小／摘要／成员不一致。
        self owns the isolated signed-fixture inputs and rejected outputs; return nothing or fail an assertion.
        self 拥有隔离签名夹具输入及拒绝输出；无返回值或使断言失败。
        """
        self.completion_fixture()
        # original is the independent baseline remote asset map, retaining each member's original bytes.
        # original 是独立基线远端资产映射，保留各成员原字节。
        original = copy.deepcopy(self.release_files)
        # signatures is the independent baseline of clearly synthetic official-verifier fixtures.
        # signatures 是明确合成官方验证器夹具的独立基线。
        signatures = copy.deepcopy(self.signatures)
        # zero_name is the existing fixture's exact signed zero-byte subject, never a production suffix guess.
        # zero_name 是既有夹具精确签名零字节主体，绝不是生产后缀猜测。
        zero_name = "native-linux-arm64.stderr.log"
        # cases enumerates each physical inventory or authenticated archive-member inconsistency separately.
        # cases 分别列举各物理库存或认证归档成员不一致。
        cases = ("missing-physical", "extra-physical", "empty-physical", "bundle-digest", "zero-digest", "zero-size", "missing-member", "changed-member", "extra-member")
        # case selects one isolated mutation after all original fixture observations are restored.
        # case 在全部原夹具观察恢复后选取一个隔离变异。
        for case in cases:
            with self.subTest(case=case):
                self.release_files = copy.deepcopy(original)
                self.signatures = copy.deepcopy(signatures)
                # files is this case's mutable physical main-release map, not the immutable baseline.
                # files 是本案例可变物理主发布映射，而非不可变基线。
                files = self.release_files[11]
                if case == "missing-physical":
                    del files[self.archive.name]
                elif case == "extra-physical":
                    files["unexpected.txt"] = b"unexpected"
                elif case == "empty-physical":
                    files[zero_name] = b""
                elif case == "bundle-digest":
                    files[RELEASE.CANDIDATE_BUNDLE] += b"changed bundle"
                else:
                    # binding is the parsed signed inventory fixture being deliberately made inconsistent.
                    # binding 是被刻意改成不一致的解析签名清单夹具。
                    binding = json.loads(files[RECOVERY.BINDING_FILENAME])
                    # marker selects the exact unit-only verifier record that authenticates this mutated fixture.
                    # marker 选取认证本变异夹具的精确仅限单测验证器记录。
                    marker = files[RELEASE.CANDIDATE_ATTESTATION].decode("utf-8")
                    # Generator row is the exact signed inventory entry matched by the known fixture filename.
                    # 生成式 row 是按已知夹具文件名匹配的精确签名清单条目。
                    if case == "zero-digest":
                        next(row for row in binding["inventory"] if row["filename"] == zero_name)["sha256"] = hashlib.sha256(b"changed zero").hexdigest()
                    elif case == "zero-size":
                        next(row for row in binding["inventory"] if row["filename"] == zero_name)["size"] = 1
                        files[zero_name] = b""
                    else:
                        # archive owns the actual mutable fixture tar bytes, never a product phase or fallback log.
                        # archive 拥有实际可变夹具 tar 字节，绝不是产品阶段或回退日志。
                        archive = self.root / (case + ".tar.gz")
                        archive.write_bytes(files[RELEASE.CANDIDATE_BUNDLE])
                        # members maps the actual canonical archive filenames to their bytes before this mutation.
                        # members 在本变异前将实际规范归档文件名映射到其字节。
                        members = RELEASE.signed_members(archive)
                        if case == "missing-member":
                            del members[zero_name]
                        elif case == "changed-member":
                            members[zero_name] = b"changed member"
                        else:
                            members["unexpected.txt"] = b"unexpected member"
                        # stream stores the newly serialized mutated fixture archive in memory.
                        # stream 在内存中保存新序列化的变异夹具归档。
                        stream = io.BytesIO()
                        # tar writes only explicit fixture members into that in-memory gzip stream.
                        # tar 仅将明确夹具成员写入该内存 gzip 流。
                        with tarfile.open(fileobj=stream, mode="w:gz") as tar:
                            # name/body are the current exact member filename and bytes to be written.
                            # name／body 是当前要写入的精确成员文件名及字节。
                            for name, body in sorted(members.items()):
                                # member is the regular tar header whose size is derived from those actual bytes.
                                # member 是普通 tar 头，其大小从这些实际字节派生。
                                member = tarfile.TarInfo(name)
                                member.size = len(body)
                                tar.addfile(member, io.BytesIO(body))
                        files[RELEASE.CANDIDATE_BUNDLE] = stream.getvalue()
                        # row is the single signed bundle entry whose digest/size must track this mutated archive.
                        # row 是唯一签名 bundle 条目，其摘要／大小必须跟随本变异归档。
                        row = next(row for row in binding["inventory"] if row["filename"] == RELEASE.CANDIDATE_BUNDLE)
                        row.update(size=len(files[RELEASE.CANDIDATE_BUNDLE]), sha256=hashlib.sha256(files[RELEASE.CANDIDATE_BUNDLE]).hexdigest())
                        self.signatures[marker]["files"][RELEASE.CANDIDATE_BUNDLE] = files[RELEASE.CANDIDATE_BUNDLE]
                    files[RECOVERY.BINDING_FILENAME] = json.dumps(binding).encode("utf-8")
                    self.signatures[marker]["files"][RECOVERY.BINDING_FILENAME] = files[RECOVERY.BINDING_FILENAME]
                # args keeps the original formal identities while selecting a unique rejected output for this case.
                # args 保留原正式身份，同时为本案例选取唯一拒绝输出。
                args = self.formal_args()
                args.output = self.root / ("formal-rejected-" + case)
                # consume records any attempted npm consumer call so rejection must precede all consumption.
                # consume 记录任何尝试的 npm 消费调用，确保拒绝先于全部消费。
                with self.recovery_context(), patch.object(RELEASE, "github_request", side_effect=self.recovery_reader), patch.object(RELEASE, "registry_consumer") as consume, self.assertRaises(ValueError):
                    RELEASE.formal_proof(args)
                consume.assert_not_called()
                self.assertFalse((args.output / "accepted.json").exists())

    def test_dual_formal_proof_preserves_original_failure_and_requires_fresh_consumer(self):
        """Authenticate both permanent chains and emit the explicit accepted header only after a new consumer file exists.
        认证两条持久证明链，仅在新的消费文件存在后输出明确接受头。
        """
        self.completion_fixture()
        args=self.formal_args()

        def consume(options):
            """Write distinctly unit-only fresh consumer evidence without outbound npm/native execution.
            写入明确仅限单测的新消费证据，不执行外部 npm、原生调用。
            """
            RELEASE.write_json(options.output,{"unit_only":True,"artifact":self.identity,"success":True,"cache":"new-empty-cache"})

        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer",side_effect=consume):
            RELEASE.formal_proof(args)
        header=RELEASE.read_json(args.output/"accepted.json")
        self.assertEqual(header["schema_version"],2)
        self.assertNotIn("run_id",header)
        self.assertEqual((header["candidate_run_id"],header["candidate_run_attempt"],header["completion_run_id"],header["completion_run_attempt"]),("123",2,"456",3))
        self.assertEqual(header["registry_consumer_sha256"],RELEASE.digest(args.output/header["registry_consumer_file"]))
        manifest=RELEASE.read_json(args.output/"completion"/RELEASE.COMPLETION_MANIFEST)
        self.assertEqual(manifest["candidate_attempt_observation"]["attempt"]["conclusion"],"failure")

    def test_unsigned_changed_completed_or_active_completion_never_accepts(self):
        """Reject unknown/current-active completion, corrupt original/completion subjects and missing fresh consumption.
        拒绝未知、当前运行中完成、损坏原候选或完成主体，以及缺失新消费。
        """
        self.completion_fixture()
        endpoint="https://api.github.com/repos/test/repo/actions/runs/456/attempts/3"
        baseline=copy.deepcopy(self.http.responses)
        files=copy.deepcopy(self.release_files)
        mutations=[lambda:self.http.responses[endpoint].update(status="in_progress",conclusion=None),
            lambda:self.http.responses[endpoint].update(conclusion="failure"),
            lambda:self.release_files[11].update({self.archive.name:b"changed original"}),
            lambda:self.release_files[22].update({"sdk-completion-aggregate.json":b"changed completion"})]
        for index,mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.http.responses=copy.deepcopy(baseline)
                self.release_files=copy.deepcopy(files)
                mutate()
                args=self.formal_args()
                args.output=self.root/str(index)
                with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer") as consumer,self.assertRaises(ValueError):
                    RELEASE.formal_proof(args)
                consumer.assert_not_called()
                self.assertFalse((args.output/"accepted.json").exists())
        self.http.responses=baseline
        self.release_files=files
        args=self.formal_args()
        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.object(RELEASE,"registry_consumer"),self.assertRaises(ValueError):
            RELEASE.formal_proof(args)
        self.assertFalse((args.output/"accepted.json").exists())

    def test_completion_retry_keeps_original_candidate_and_uses_new_unique_tag(self):
        """A failed completion retry is independently signed; original packages/manifests/bundles remain byte-identical.
        完成失败后的重试独立签名；原包、清单、bundle 保持字节完全相同。
        """
        args=self.completion_fixture()
        original={p.name:p.read_bytes() for p in (args.candidate/"original").iterdir()}
        first=RELEASE.read_json(args.output/RELEASE.COMPLETION_MANIFEST)
        self.add_attempt(456,4,[RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"publish")],None,"recover")
        args.output=self.root/"retry-completion"
        with self.recovery_context(),patch.object(RELEASE,"github_request",side_effect=self.recovery_reader),patch.dict(os.environ,self.recovery_environment(456,4,"recover")):
            RELEASE.completion_bundle(args)
        second=RELEASE.read_json(args.output/RELEASE.COMPLETION_MANIFEST)
        for key in ("candidate_manifest_sha256","candidate_bundle_sha256","candidate_attestation_sha256","candidate_binding_sha256","packages"):
            self.assertEqual(first[key],second[key])
        self.assertEqual(second["run_attempt"],4)
        self.assertNotEqual(RELEASE.completion_tag(self.identity["sdk_version"],456,3),RELEASE.completion_tag(self.identity["sdk_version"],456,4))
        self.assertEqual(original,{p.name:p.read_bytes() for p in (args.candidate/"original").iterdir()})

    def test_default_artifact_only_never_authorizes_mutation(self):
        """Current explicit artifact-only intent is rejected even when original candidate and source are valid.
        即使原候选与源码有效，当前明确 artifact-only 意图仍被拒绝。
        """
        args=SimpleNamespace(repository="test/repo",intent="artifact-only")
        with patch.dict(os.environ,self.recovery_environment()),patch.object(RELEASE,"github_request") as api,self.assertRaisesRegex(ValueError,"cannot authorize publication"):
            RELEASE.current_completion(args,{"identity":self.identity})
        api.assert_not_called()

    def test_public_success_with_lost_readback_reuses_exact_bytes_without_mutation(self):
        """A public edit followed by lost readback is recovered from its actual final ID/bytes without re-upload.
        公开变更后丢失回读时，从实际最终 ID、字节恢复，不重新上传。
        """
        _, files = self.original_candidate_fixture()
        directory=self.root/"signed-candidate"
        state={"public":False,"readback_lost":True}
        tag="v"+self.identity["sdk_version"]
        draft={"id":9,"tag_name":tag,"draft":True,"prerelease":False,"target_commitish":self.identity["sdk_source_sha"]}
        final={**draft,"draft":False,"immutable":False}
        ordered=sorted(files)
        assets={name:{"id":index+1,"name":name} for index,name in enumerate(ordered)}

        def reader(repository,path,binary=False):
            """Expose existing full draft bytes and fail only the first post-publication ID read.
            暴露既有完整草稿字节，仅使首次公开后的 ID 回读失败。
            """
            if path.startswith("git/ref/tags/"):
                if not state["public"]:
                    raise RELEASE.SDKTagMissing("Exact pending initial tag")
                return {"ref":"refs/tags/"+tag,"object":{"type":"commit","sha":self.identity["sdk_source_sha"]}}
            if path.startswith("releases/assets/"):
                return files[ordered[int(path.split("/")[-1])-1]]
            if path=="releases/9":
                if state["readback_lost"]:
                    state["readback_lost"]=False
                    raise ValueError("Actual publish succeeded but readback connection lost")
                return final
            raise AssertionError("Unexpected lost-readback fixture route")

        def mutate(arguments):
            """Allow only one draft public edit in this fixture and preserve every original asset.
            本夹具仅允许一次草稿公开变更，并保留每个原资产。
            """
            self.assertEqual(arguments[:3],["gh","release","edit"])
            self.assertFalse(state["public"])
            state["public"]=True

        with patch.object(RELEASE,"release_by_tag",side_effect=lambda *args:final if state["public"] else draft), \
             patch.object(RELEASE,"release_assets",return_value=assets),patch.object(RELEASE,"github_request",side_effect=reader),patch.object(RELEASE,"run",side_effect=mutate) as command:
            with self.assertRaisesRegex(ValueError,"readback connection lost"):
                RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
            observed=RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        command.assert_called_once()
        self.assertEqual(observed["id"],9)
        self.assertEqual(files,{p.name:p.read_bytes() for p in directory.iterdir()})

    def test_partial_draft_reuses_original_signed_files_and_rejects_extra_asset(self):
        """Resume a subset of the same original candidate inventory; reject unknown assets before upload or edit.
        恢复同一原候选清单的部分资产；上传或公开前拒绝未知资产。
        """
        directory,files=self.original_candidate_fixture()
        tag="v"+self.identity["sdk_version"]
        draft={"id":9,"tag_name":tag,"draft":True,"prerelease":False,"target_commitish":self.identity["sdk_source_sha"]}
        assets={"unrecognized-old-proof.json":{"id":10}}
        with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag",side_effect=RELEASE.SDKTagMissing("pending exact initial ref")), \
             patch.object(RELEASE,"release_assets",return_value=assets),patch.object(RELEASE,"run") as command,self.assertRaisesRegex(ValueError,"unexpected original evidence"):
            RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        command.assert_not_called()
        ordered=sorted(files)
        assets={ordered[0]:{"id":1}}
        state={"public":False}

        def reader(repository,path,binary=False):
            """Read only actual existing/uploaded root bytes or the final published ID.
            仅读取实际既有、已上传根字节或最终公开 ID。
            """
            if path.startswith("releases/assets/"):
                return files[ordered[int(path.split("/")[-1])-1]]
            if path=="releases/9":
                return {**draft,"draft":False,"immutable":False}
            raise AssertionError("Unexpected partial-draft reader route")

        def mutate(arguments):
            """Upload each absent original member once, then publicize only the exact completed inventory.
            每个缺失原成员只上传一次，然后仅公开精确完整清单。
            """
            if arguments[:3]==["gh","release","upload"]:
                name=arguments[4].name
                self.assertFalse(state["public"])
                self.assertNotIn(name,assets)
                assets[name]={"id":ordered.index(name)+1}
            else:
                self.assertEqual(arguments[:3],["gh","release","edit"])
                self.assertEqual(set(assets),set(files))
                state["public"]=True

        with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag",side_effect=lambda *a:None if state["public"] else (_ for _ in ()).throw(RELEASE.SDKTagMissing("pending exact initial ref"))), \
             patch.object(RELEASE,"release_assets",side_effect=lambda *a:copy.deepcopy(assets)),patch.object(RELEASE,"github_request",side_effect=reader),patch.object(RELEASE,"run",side_effect=mutate) as command:
            RELEASE.immutable_upload("test/repo",tag,self.identity["sdk_source_sha"],sorted(directory.iterdir()),"title",self.archive)
        self.assertEqual(command.call_count,len(files))
        self.assertEqual(files,{p.name:p.read_bytes() for p in directory.iterdir()})

    def test_real_six_example_zip_is_signed_once_and_recovers_identical_bytes(self):
        """Exercise real fixed-six ZIP validation plus public recovery/signature binding, preserving the original source package.
        验证真实固定六例 ZIP 及公共恢复、签名绑定，保留原源码包。
        """
        self.http=RecoveryHttp({})
        self.signatures={}
        proof=self.root/"sdk-proof"
        proof.mkdir()
        consumer={"artifact":self.identity,"success":True,"cache":"new-empty-cache","unit_only":True}
        RELEASE.write_json(proof/"formal-consumer.json",consumer)
        header={"schema_version":2,"sdk_source_sha":self.identity["sdk_source_sha"],"sdk_version":self.identity["sdk_version"],
            "core_tag":self.core_tag,"core_commit":self.identity["core_commit"],"repository":"test/repo","candidate_run_id":"123","candidate_run_attempt":2,
            "completion_run_id":"456","completion_run_attempt":3,"completion_source_sha":self.identity["sdk_source_sha"],"accepted":True,
            "registry_consumer_file":"formal-consumer.json","registry_consumer_sha256":RELEASE.digest(proof/"formal-consumer.json")}
        RELEASE.write_json(proof/"accepted.json",header)
        packager=RELEASE.example_packager()
        package_name="luaskills-sdk-typescript-examples-"+self.identity["sdk_version"]
        staged=self.root/package_name
        packager.stage_package(staged,self.identity["sdk_version"])
        archive=self.root/(package_name+".zip")
        packager.archive_package(staged,archive,self.identity["sdk_version"])
        sidecar=self.root/(archive.name+".sha256")
        sidecar.write_text(RELEASE.digest(archive)+"  "+archive.name+"\n",encoding="utf-8")
        notes=self.root/"example-notes.md"
        notes.write_text("unit-only source examples notes",encoding="utf-8")
        log=self.root/"example-smoke.log"
        log.write_text("unit-only six-example smoke fixture",encoding="utf-8")
        args=SimpleNamespace(core_root=OPTIONS.core_root,repository="test/repo",sdk_proof=proof,archive=archive,sidecar=sidecar,notes=notes,
            smoke_log=log,mode="artifact-only",output=self.root/"examples-candidate")
        self.add_attempt(123,2,[RELEASE.workflow_job_name(RELEASE.EXAMPLES_WORKFLOW,"candidate-evidence")],mode="artifact-only",workflow=RELEASE.EXAMPLES_WORKFLOW)
        with self.recovery_context(),patch.dict(os.environ,self.recovery_environment(workflow=RELEASE.EXAMPLES_WORKFLOW)),contextlib.redirect_stdout(io.StringIO()):
            RELEASE.examples_bundle(args)
        self.fixture_signature(args.output,RELEASE.EXAMPLES_ATTESTATION,123,2,RELEASE.EXAMPLES_WORKFLOW)
        with self.recovery_context(),patch.dict(os.environ,self.recovery_environment(workflow=RELEASE.EXAMPLES_WORKFLOW)):
            RELEASE.examples_seal(SimpleNamespace(core_root=OPTIONS.core_root,input=args.output))
        files={p.name:p.read_bytes() for p in args.output.iterdir()}
        self.register_artifact(files)
        fetch=self.fetch_args("restored-examples")
        with self.recovery_context():
            RELEASE.examples_fetch(fetch)
            state=RELEASE.local_examples(SimpleNamespace(core_root=OPTIONS.core_root,candidate=fetch.output,repository="test/repo"))
        self.assertEqual(state["manifest"]["mode"],"artifact-only")
        self.assertEqual(len(state["manifest"]["examples"]),6)
        self.assertEqual((fetch.output/"original"/archive.name).read_bytes(),archive.read_bytes())
        self.assertEqual(files,{p.name:p.read_bytes() for p in (fetch.output/"original").iterdir()})

    def test_frozen_workflow_orders_signed_candidate_before_all_publication(self):
        """Check named jobs, explicit recovery interfaces and isolated signing/publication privileges from actual frozen source.
        从实际冻结源码检查命名作业、明确恢复接口及隔离签名、发布权限。
        """
        sdk=(ROOT/RELEASE.SDK_WORKFLOW).read_text(encoding="utf-8")
        examples=(ROOT/RELEASE.EXAMPLES_WORKFLOW).read_text(encoding="utf-8")
        self.assertEqual(RELEASE.workflow_job_name(RELEASE.SDK_WORKFLOW,"candidate-evidence"),"candidate-evidence")
        self.assertEqual(RELEASE.workflow_job_name(RELEASE.EXAMPLES_WORKFLOW,"candidate-evidence"),"examples-candidate-evidence")
        for text in (sdk,examples):
            self.assertIn("default: artifact-only",text)
            self.assertIn("environment: production",text)
            self.assertNotIn("--clobber",text)
            self.assertNotIn("--run-id",text)
        self.assertEqual(sdk.count("npm pack "),1)
        self.assertEqual(sdk.count("sdk_release.py publish-or-verify "),1)
        self.assertLess(sdk.index("candidate-seal "),sdk.index("sdk_release.py publish-or-verify "))
        self.assertLess(sdk.index("candidate-fetch "),sdk.index("sdk_release.py publish-or-verify "))
        self.assertLess(examples.index("examples-seal "),examples.index("sdk_release.py publish-examples "))
        self.assertIn("--completion-source-sha",examples)
        self.assertEqual(sdk.count("      actions: read"),2)
        self.assertEqual(examples.count("      actions: read"),2)

    def test_recovery_authority_in_fresh_python_and_cli_binding_rejection(self):
        """Load the real Core recovery API in isolated new Python processes and reject missing/invalid CLI bindings; return nothing.
        在隔离的新 Python 进程加载真实 Core 恢复 API，并拒绝 CLI 缺失或不合法绑定；无返回值。
        Each child starts without this suite's candidate modules or import paths; no native, HTTP or signature verification is mocked.
        每个子进程均无此套件的 candidate 模块及导入路径；不替换原生、HTTP 或签名校验。
        """
        # Program arguments select exactly this SDK control and the existing explicit Core checkout.
        # Program 参数精确选择本 SDK 控制代码及既有明确 Core 检出。
        program = ("import importlib.util,json,sys\n"
                   "# Load only the SDK file supplied as argv[1]; argv[2] is its sole Core root.\n"
                   "# 仅加载 argv[1] 指定 SDK 文件；argv[2] 为其唯一 Core 根。\n"
                   "spec=importlib.util.spec_from_file_location('sdk_release',sys.argv[1])\n"
                   "# Module executes the actual control source without test-suite initialization.\n"
                   "# Module 执行实际控制源码，不继承测试套件初始化。\n"
                   "module=importlib.util.module_from_spec(spec)\n"
                   "spec.loader.exec_module(module)\n"
                   "# Recovery and shared must initialize their adjacent candidate from this exact root.\n"
                   "# Recovery 和 shared 必须从此精确根初始化相邻 candidate。\n"
                   "recovery,shared=module.recovery_authority(sys.argv[2])\n"
                   "print(json.dumps({'recovery':recovery.__file__,'shared':shared.__file__,"
                   "'candidate':shared.candidate.__file__,'binding':recovery.BINDING_FILENAME}))\n")
        # Isolated mode prevents inherited PYTHONPATH, cwd or earlier unit modules from hiding missing initialization.
        # 隔离模式阻止继承 PYTHONPATH、cwd 或先前单测模块掩盖缺少初始化。
        command = [RELEASE.sys.executable, "-I", "-B", "-c", program,
                   str(ROOT / "scripts/release/sdk_release.py"), str(Path(OPTIONS.core_root).resolve())]
        # Actual child output identifies all three imported authority files, not a synthetic module result.
        # 实际子进程输出标识三份导入权威文件，绝不是合成模块结果。
        completed = RELEASE.subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        # Loaded paths must belong to the one declared Core directory.
        # Loaded 路径必须属于唯一声明 Core 目录。
        loaded = json.loads(completed.stdout)
        for field, filename in (("recovery", "sdk_recovery.py"), ("shared", "sdk_prerequisites.py"), ("candidate", "candidate.py")):
            self.assertEqual(Path(loaded[field]).resolve(), Path(OPTIONS.core_root).resolve() / "scripts/release" / filename)
        self.assertEqual(loaded["binding"], RECOVERY.BINDING_FILENAME)
        # Each case reaches the actual fresh candidate-seal CLI and must still reject incomplete evidence before HTTP/signatures.
        # 每个场景进入实际全新 candidate-seal CLI，仍须在 HTTP 或签名前拒绝不完整证明。
        for name, content, error in (("missing", None, "FileNotFoundError"), ("non-object", b"[]", "Expected JSON object"),
                                     ("missing-identity", b"{}", "KeyError: 'repository'")):
            with self.subTest(binding=name):
                # Directory is an independent rejected-input fixture; no original candidate bytes are edited.
                # Directory 为独立拒绝输入夹具，不编辑任何原候选字节。
                directory = self.root / ("fresh-seal-" + name)
                directory.mkdir()
                if content is not None:
                    (directory / RECOVERY.BINDING_FILENAME).write_bytes(content)
                # CLI uses the original operation and options without any bypass or synthetic successful seal.
                # CLI 使用原操作及选项，没有绕过或合成成功封印。
                result = RELEASE.subprocess.run([RELEASE.sys.executable, "-I", "-B", str(ROOT / "scripts/release/sdk_release.py"),
                    "candidate-seal", "--core-root", str(Path(OPTIONS.core_root).resolve()), "--input", str(directory)],
                    capture_output=True, text=True, encoding="utf-8", timeout=30)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("ModuleNotFoundError", result.stderr)
                self.assertIn(error, result.stderr)

    @unittest.skipUnless("SDK_RELEASE_TEST_CORE_PROOF" in os.environ, "Explicit original complete Core proof required")
    def test_workflow_output_uses_binding_after_pretty_core_stdout(self):
        """Execute the real workflow consumer after original Core JSON and an actual unit candidate binding; return nothing.
        在原 Core JSON 与实际单测候选绑定后执行真实工作流消费者；无返回值。
        The producer alone replays frozen stdout; the consumer imports the unchanged SDK/Core authorities and writes its real envfile.
        仅生产者重放冻结 stdout；消费者导入未变 SDK/Core 权威并写入实际环境文件。
        """
        # Bash is the workflow's actual shell, never a substitute envfile parser.
        # Bash 是工作流实际 shell，绝不使用替代环境文件解析器。
        bash = shutil.which("bash")
        if bash is None:
            self.skipTest("Actual workflow Bash is required")
        # This existing fixture runs candidate_bundle itself with explicit unit-only native/HTTP boundaries.
        # 此既有夹具实际执行 candidate_bundle，原生与 HTTP 边界明确仅属单测。
        directory, files = self.original_candidate_fixture()
        # Binding comes from that real producer and retains Core's sole filename/name authority.
        # Binding 来自该真实生产者，保持 Core 唯一文件名及名称权威。
        binding = RELEASE.read_json(directory / RECOVERY.BINDING_FILENAME)
        # Original producer files use the same Core encode bytes that sdk_inputs prints to stdout.
        # 原生产者文件使用与 sdk_inputs 打印到 stdout 相同的 Core encode 字节。
        original = Path(os.environ["SDK_RELEASE_TEST_CORE_PROOF"]).resolve(strict=True)
        # Two complete resolver passes preserve the actual aggregate/selector multiline output shape.
        # 两轮完整解析保持实际汇总及选择器的多行输出形状。
        printed = "".join((original / "sdk-inputs" / platform / "sdk-validation-inputs.json").read_text(encoding="utf-8")
                          for platform in CORE.PLATFORMS) * 2 + binding["artifact_name"] + "\n"
        (self.root / "producer.stdout.log").write_text(printed, encoding="utf-8")
        # Stage real SDK/Core Python source and every original fixture subject for the untouched consumer.
        # 暂存真实 SDK/Core Python 源及全部原夹具主体，供未替换的消费者执行。
        scripts = self.root / "scripts/release"
        scripts.mkdir(parents=True)
        shutil.copyfile(ROOT / "scripts/release/sdk_release.py", scripts / "sdk_release.py")
        shutil.copytree(Path(OPTIONS.core_root) / "scripts/release", self.root / "core-release/scripts/release",
                        ignore=shutil.ignore_patterns("__pycache__"))
        # Destination follows the real workflow's single candidate directory.
        # Destination 遵循真实工作流唯一候选目录。
        destination = self.root / "target/original-candidate"
        shutil.copytree(directory, destination)
        # Read the sole named step from the actual workflow, including its production output commands.
        # 从实际工作流读取唯一命名步骤，包括生产输出命令。
        workflow = (ROOT / RELEASE.SDK_WORKFLOW).read_text(encoding="utf-8")
        # Match only this existing step boundary; no candidate path or field guessing occurs.
        # 仅匹配此既有步骤边界，不猜测候选路径或字段。
        step = RELEASE.re.search(r"^      - name: Freeze all original tested subjects before any publication\n"
                                 r"(.*?)(?=^      - )", workflow, RELEASE.re.MULTILINE | RELEASE.re.DOTALL)
        self.assertIsNotNone(step)
        # Body preserves the workflow's actual shell commands after removing YAML indentation.
        # Body 去除 YAML 缩进后保留工作流实际 shell 命令。
        body = "\n".join(line[10:] for line in step.group(1).split("        run: |\n", 1)[1].splitlines()) + "\n"
        # Replay only the candidate CLI boundary; inline Python, JSON reads and envfile writes execute unchanged.
        # 仅重放候选 CLI 边界；内联 Python、JSON 读取及环境文件写入均原样执行。
        producer = ('python() {\n'
                    '  if [[ "$1" == "scripts/release/sdk_release.py" && "$2" == "candidate-bundle" ]]; then\n'
                    '    cat producer.stdout.log\n'
                    '  else\n'
                    '    command python "$@"\n'
                    '  fi\n'
                    '}\n')
        # Environment selects the real fixture run and a fresh actual GitHub output file.
        # Environment 选择真实夹具运行及新建实际 GitHub 输出文件。
        environment = {**os.environ, "GITHUB_REPOSITORY": "test/repo", "MODE": "artifact-only",
                       "GITHUB_OUTPUT": str(self.root / "github-output")}
        # Execute the original Bash consumer; this is not a mirrored Python envfile implementation.
        # 执行原 Bash 消费者，不以镜像 Python 环境文件实现替代。
        completed = RELEASE.subprocess.run([bash, "-euo", "pipefail", "-c", producer + body], cwd=self.root,
                                           env=environment, capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual((self.root / "github-output").read_text(encoding="utf-8"),
                         "artifact_name=" + binding["artifact_name"] + "\n")
        self.assertEqual(completed.stdout, printed)
        self.assertEqual({path.name: path.read_bytes() for path in destination.iterdir()}, files)

    def test_extra_asset_in_initial_final_or_late_draft_never_becomes_valid_release(self):
        """Reject extra root subjects at every actual asset snapshot, before public edit when observable.
        在每个实际资产快照拒绝多余根主体；可观察时在公开变更前拒绝。
        """
        base={self.archive.name:{"id":10}}
        extra={**base,"orphan-proof.json":{"id":11}}
        for phase in ("initial-draft","initial-final","late-draft","final-readback"):
            with self.subTest(phase=phase):
                draft={"id":1,"draft":phase!="initial-final","prerelease":False,"tag_name":"v0.5.7","target_commitish":"a"*40,"immutable":False}
                final={**draft,"draft":False}
                assets=[extra] if phase.startswith("initial") else [base,extra] if phase=="late-draft" else [base,base,extra]
                replies=[self.archive.read_bytes()]
                if phase=="final-readback":
                    replies += [self.archive.read_bytes(),final]
                with patch.object(RELEASE,"release_by_tag",return_value=draft),patch.object(RELEASE,"resolve_sdk_tag"), \
                     patch.object(RELEASE,"release_assets",side_effect=assets),patch.object(RELEASE,"github_request",side_effect=replies), \
                     patch.object(RELEASE,"run") as command,self.assertRaisesRegex(ValueError,"unexpected original evidence|exactly the frozen|different complete asset set"):
                    RELEASE.immutable_upload("test/repo","v0.5.7","a"*40,[self.archive],"title",self.archive)
                if phase=="final-readback":
                    self.assertEqual([call.args[0][2] for call in command.call_args_list],["edit"])
                else:
                    command.assert_not_called()

    def test_wrong_final_tag_rejects_without_success_or_completion_record(self):
        """Require the actual final tag despite valid draft/source/assets, and propagate late failure before completion evidence.
        即使草稿、源码、资产有效也要求实际最终标签匹配，并在完成证据前传播末期失败。
        """
        for tag in ("v0.5.7", "examples-v0.5.7", "recovery-v0.5.7-r456-a3"):
            with self.subTest(tag=tag):
                # The actual Git reference remains correct; only the published Release's physical tag changes.
                # 实际 Git 引用保持正确；仅已公开 Release 的物理标签发生变化。
                draft = {"id": 1, "draft": True, "prerelease": False, "tag_name": tag, "target_commitish": "a" * 40}
                published = {**draft, "draft": False, "tag_name": "different-release-tag", "immutable": False}
                assets = {self.archive.name: {"id": 10}}

                def reader(repository, path, binary=False):
                    """Serve legal exact source/member bytes and the mismatched final ID response; fail all other requests.
                    提供合法精确源码、成员字节及不匹配最终 ID 响应；其他请求一律失败。
                    """
                    if path == "git/ref/tags/" + tag:
                        return {"ref": "refs/tags/" + tag, "object": {"type": "commit", "sha": "a" * 40}}
                    if path == "releases/assets/10":
                        self.assertTrue(binary)
                        return self.archive.read_bytes()
                    if path == "releases/1":
                        return published
                    raise AssertionError("Unexpected final-tag fixture URL: " + path)

                with patch.object(RELEASE, "release_by_tag", return_value=draft), patch.object(RELEASE, "release_assets", return_value=assets), \
                     patch.object(RELEASE, "github_request", side_effect=reader), patch.object(RELEASE, "run") as command, \
                     contextlib.redirect_stdout(io.StringIO()) as output, self.assertRaisesRegex(ValueError, "exact formal release"):
                    RELEASE.immutable_upload("test/repo", tag, "a" * 40, [self.archive], "title", self.archive)
                self.assertEqual(output.getvalue(), "")
                self.assertEqual([call.args[0][2] for call in command.call_args_list], ["edit"])
        # A failed actual main-release readback cannot create the receipt later consumed by completion-bundle.
        # 实际主 Release 回读失败不能创建随后由 completion-bundle 消费的回执。
        consumer = self.root / "consumer.json"
        RELEASE.write_json(consumer, {"artifact": self.identity, "success": True, "cache": "new-empty-cache"})
        args = SimpleNamespace(core_root=OPTIONS.core_root, candidate=self.root, repository="test/repo", intent="recover",
            consumer=consumer, prerequisites=self.prerequisites, output=self.root / "main-release.json")
        with patch.object(RELEASE, "local_candidate", return_value={"root": self.root, "identity": self.identity}), \
             patch.object(RELEASE, "current_completion"), patch.object(RELEASE, "authority", return_value=CORE), \
             patch.object(RELEASE, "immutable_upload", side_effect=ValueError("Draft release did not become the exact formal release")), \
             self.assertRaisesRegex(ValueError, "exact formal release"):
            RELEASE.publish_candidate(args)
        self.assertFalse(args.output.exists())


class CoreProofSelectionTests(unittest.TestCase):
    """Exercise original complete Core bytes with the real resolver; return no publication evidence.
    使用真实解析器验证原完整 Core 字节；不产生发布证明。
    """

    @unittest.skipUnless("SDK_RELEASE_TEST_CORE_PROOF" in os.environ, "Explicit original complete Core proof required")
    def test_audit_retention_missing_required_and_tampered_copy(self):
        """Select original proof, retain every audit file, and reject missing/tampered bytes without synthetic large data.
        选择原证明、保留全部审计文件，并拒绝缺失、篡改字节，不合成大数据。
        """
        # Original is read-only; an independent short-path copy avoids Windows hard-link path limits.
        # Original 只读；独立短路径副本避免 Windows 硬链接路径上限。
        original = Path(os.environ["SDK_RELEASE_TEST_CORE_PROOF"]).resolve(strict=True)
        with tempfile.TemporaryDirectory(prefix="cp-") as temporary:
            # Root contains actual producer bytes, not a mirrored synthetic Core protocol.
            # Root 包含实际生产者字节，不是镜像合成 Core 协议。
            root = Path(temporary) / "core"
            shutil.copytree(original, root, copy_function=shutil.copyfile)
            # Selected mapping is validated by all five actual Core archive/source/native checks.
            # Selected 映射经过全部五平台实际 Core 归档、源码、原生校验。
            selected = RELEASE.core_proof_members(root / "prerequisites.json", SHARED)
            self.assertIn("candidate/luaskills-ffi-sdk-windows-x64.tar.gz", selected)
            self.assertNotIn("candidate/luaskills-demo-ffi-windows-x64.tar.gz", selected)
            self.assertNotIn("downloads/assets/luaskills-ffi-sdk-windows-x64.tar.gz", selected)
            for path in (root / "registry").rglob("*"):
                if path.is_file():
                    self.assertEqual(selected[path.relative_to(root).as_posix()].read_bytes(), path.read_bytes())
            # Required authenticated manifest cannot be omitted even when all audit bytes still exist.
            # 即使全部审计字节仍在，也不得省略必需的已认证清单。
            required = root / "downloads/candidate-manifest.json"
            required.unlink()
            with self.assertRaises(FileNotFoundError):
                RELEASE.core_proof_members(root / "prerequisites.json", SHARED)
            shutil.copyfile(original / "downloads/candidate-manifest.json", required)
            # A discarded archive copy still requires its actual official SHA before selection can omit it.
            # 被省略的归档副本仍须符合实际正式 SHA，选择函数才能省略。
            source = CORE.read_json(root / "candidate/candidate-manifest.json")["source_archive"]["name"]
            copy = root / "downloads/assets" / source
            copy.unlink()
            copy.write_bytes(b"tampered archive copy")
            with self.assertRaisesRegex(ValueError, "differs from official asset"):
                RELEASE.core_proof_members(root / "prerequisites.json", SHARED)


class ArtifactMediaTests(unittest.TestCase):
    """Exercise the SDK adapter through real Core HTTP Requests and artifact byte validation offline.
    离线通过真实 Core HTTP Request 及制品字节验证测试 SDK 适配器。
    """

    def test_bound_archive_media_and_original_core_byte_guards(self):
        """Prove original 415, exact bound-media repair and retained byte/endpoint guards; return nothing.
        证明原 415、精确绑定媒体修复及字节／端点护栏保留；无返回值。
        """
        # Standard-library fixtures replace only network I/O, never Core get/download or SDK media decisions.
        # 标准库夹具仅替换网络 I/O，绝不替换 Core get/download 或 SDK 媒体决策。
        import hashlib
        import urllib.error
        import zipfile
        # Bind the test to already imported actual frozen Core modules and this SDK wrapper.
        # 将测试绑定到已导入真实冻结 Core 模块及本 SDK 包装。
        shared, recovery, wrapper = SHARED, RECOVERY, RELEASE.ArtifactHttp
        # Offline identities are explicit fixture values and make no official signing claim.
        # 离线身份为明确夹具值，不声称官方签名。
        endpoint = "https://api.github.com/repos/test/repo/actions/artifacts/77"
        archive_url = endpoint + "/zip"
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("original.txt", b"original ZIP bytes")
        # Actual ZIP bytes are consumed by the unmodified Core digest/size/unpack implementation.
        # 实际 ZIP 字节由未修改 Core 的摘要／大小／解包实现消费。
        content = buffer.getvalue()
        metadata = {"id": 77, "name": recovery.candidate_artifact_name(123, 1), "expired": False,
                    "workflow_run": {"id": 123, "head_sha": "a" * 40}, "size_in_bytes": len(content),
                    "digest": "sha256:" + hashlib.sha256(content).hexdigest()}
        arguments = dict(repository="test/repo", source_sha="a" * 40, run_id=123, artifact_id=77,
                         artifact_name=metadata["name"])
        # Exact unrelated routes expose accidental broader binary rewrites without probing a real network.
        # 精确无关路由暴露意外宽泛二进制改写，不探测真实网络。
        others = ("https://api.github.com/repos/test/repo/actions/artifacts/78/zip",
                  archive_url + "?part=1", "https://example.invalid/native.dll")
        routes = {archive_url: content, **{url: b"unrelated bytes" for url in others}}
        requests, reads = [], []

        class Response(io.BytesIO):
            """Retain byte-body fixture semantics while observing the real Core bounded read.
            保留字节正文夹具语义，同时观察真实 Core 有界读取。
            """

            def read(self, size=-1):
                """Record requested size and return original fixture bytes without altering the body.
                记录请求 size 并返回原夹具字节，不改变正文。
                """
                reads.append(size)
                return super().read(size)

        class Opener:
            """Serve declared routes and reject the bound ZIP's octet Accept with the original 415.
            提供已声明路由，并对绑定 ZIP 的 octet Accept 返回原 415。
            """

            def open(self, request, timeout):
                """Observe the real Request and timeout; return body or the explicit media rejection.
                观察真实 Request 及 timeout；返回正文或明确媒体拒绝。
                """
                # Store only safe URL/media/timeout facts, never the Request's authorization header.
                # 仅保存安全 URL／媒体／超时事实，绝不保存 Request 的授权头。
                accept = request.get_header("Accept")
                requests.append((request.full_url, accept, timeout))
                if request.full_url == archive_url and accept != "application/json":
                    raise urllib.error.HTTPError(request.full_url, 415, "Unsupported Accept", {}, io.BytesIO())
                # Metadata JSON encoding belongs only to its declared API route, not the ZIP body.
                # 元数据 JSON 编码仅属于已声明 API 路由，不属于 ZIP 正文。
                body = json.dumps(metadata).encode() if request.full_url == endpoint else routes[request.full_url]
                response = Response(body)
                response.status = 200
                response.headers = {"Content-Type": "application/json" if request.full_url == endpoint else "application/zip"}
                return response

        # The same real Core instance retains its original get/json implementations and bounded reads.
        # 同一真实 Core 实例保留原 get/json 实现及有界读取。
        http = shared.Http()
        opener = Opener()
        http.opener = opener
        with self.assertRaisesRegex(ValueError, "status 415"):
            recovery.download_artifact(http, **arguments)
        self.assertEqual(requests[-1], (archive_url, "application/octet-stream", 60))
        # Only the SDK wrapper changes bound media; Core still authenticates the ZIP digest/size and members.
        # 仅 SDK 包装改变绑定媒体；Core 仍认证 ZIP 摘要／大小及成员。
        adapted = wrapper(http, "test/repo", 77)
        evidence, files = recovery.download_artifact(adapted, **arguments)
        self.assertEqual(files, {"original.txt": b"original ZIP bytes"})
        self.assertEqual(evidence["archive_sha256"], hashlib.sha256(content).hexdigest())
        self.assertEqual(requests[-1], (archive_url, "application/json", 60))
        self.assertIs(http.opener, opener)
        self.assertEqual(adapted.json(endpoint), metadata)
        self.assertEqual(requests[-1], (endpoint, "application/json", 60))
        for url in others:
            with self.subTest(url=url):
                self.assertEqual(adapted.get(url, binary=True)[0], b"unrelated bytes")
                self.assertEqual(requests[-1], (url, "application/octet-stream", 60))
                self.assertEqual(adapted.get(url, binary=False)[0], b"unrelated bytes")
                self.assertEqual(requests[-1], (url, "application/json", 60))
        self.assertEqual(adapted.get(archive_url, binary=False)[0], content)
        # Wrong API size or digest must still fail inside real Core before its artifact members are accepted.
        # 错误 API 大小或摘要仍须在真实 Core 内失败，之后才可能接受制品成员。
        for field, changed in (("size_in_bytes", len(content) + 1), ("digest", "sha256:" + "0" * 64)):
            with self.subTest(field=field):
                original = metadata[field]
                metadata[field] = changed
                with self.assertRaisesRegex(ValueError, "downloaded bytes differ"):
                    recovery.download_artifact(adapted, **arguments)
                metadata[field] = original
        # Even correctly sized/hashed JSON cannot replace ZIP: real Core's ZIP parser rejects it.
        # 即使大小／摘要正确，JSON 也不能替代 ZIP：真实 Core ZIP 解析器拒绝它。
        routes[archive_url] = b"{}"
        metadata["size_in_bytes"] = len(routes[archive_url])
        metadata["digest"] = "sha256:" + hashlib.sha256(routes[archive_url]).hexdigest()
        with self.assertRaises((ValueError, zipfile.BadZipFile)):
            recovery.download_artifact(adapted, **arguments)
        self.assertTrue(reads)
        self.assertTrue(all(size == shared.MAX_BODY_BYTES + 1 for size in reads))


class RepositoryRootTests(unittest.TestCase):
    """Exercise exact repository routes and existing-blob write authorization through real HTTPS openers.
    通过真实 HTTPS openers 验证精确仓库路由及既有 blob 写授权。
    """

    @contextlib.contextmanager
    def transport(self):
        """Yield exact offline RELEASE state using original Request/opener/redirect guards; return no network side effects.
        使用原 Request／opener／重定向护栏产生精确离线 RELEASE 状态；无网络副作用。
        """
        import urllib.response
        authority = SHARED
        # Source and workflow bytes identify the sole current definition; OID uses Git's real blob format.
        # source 及 workflow 字节标识唯一当前定义；oid 使用真实 Git blob 格式。
        source = "a" * 40
        workflow = (ROOT / ".github/workflows/sdk-release.yml").read_bytes()
        oid = hashlib.sha1(b"blob " + str(len(workflow)).encode("ascii") + b"\0" + workflow).hexdigest()
        # Base and endpoints bind every GET/POST to the exact declared repository and immutable source.
        # base 及 endpoints 将每次 GET／POST 绑定到精确声明仓库及不可变源码。
        base = "https://api.github.com/repos/" + "test/repo"
        endpoint = base + "/git/blobs"
        definition = base + "/contents/.github/workflows/sdk-release.yml?ref=" + source
        # Routes retain exact RELEASE fields; false metadata push deliberately cannot substitute for real authorization.
        # routes 保留精确 RELEASE 字段；刻意为 false 的元数据 push 不能代替真实授权。
        routes = {base: {"full_name": "test/repo", "permissions": {"push": False}, "default_branch": "main"},
                  base + "/git/ref/heads/main": {"object": {"type": "commit", "sha": source}},
                  base + "/git/ref/heads/other": {"object": {"type": "commit", "sha": "b" * 40}},
                  definition: {"type": "file", "encoding": "base64", "sha": oid,
                               "content": base64.b64encode(workflow).decode("ascii")},
                  base + "/git/ref/tags/v0.6.1": {"ref": "refs/tags/v0.6.1", "object": {"type": "commit", "sha": source}},
                  base + "/releases/assets/7": b"unchanged binary asset"}
        # State holds response controls and observed requests only; builder remains the original opener factory.
        # state 仅保存响应控制及已观察请求；builder 保持原 opener 工厂。
        state = SimpleNamespace(base=base, source=source, workflow=workflow, oid=oid, definition=definition,
            endpoint=endpoint, routes=routes, requests=[], redirects=[], status=201, sha=oid,
            response_url=endpoint, blob_url=endpoint + "/" + oid, authority=authority)
        builder = RELEASE.urllib.request.build_opener

        class OfflineHTTPS(RELEASE.urllib.request.HTTPSHandler):
            """Replace only network I/O with exact JSON responses; real HTTP status processing still runs.
            仅以精确 JSON 响应替换网络 I/O；真实 HTTP 状态处理仍执行。
            """

            def https_open(self, request):
                """Capture original Request and return selected status/body; parameters include immutable URL/body/token.
                捕获原 Request 并返回选定 status／body；参数包括不可变 URL／正文／令牌。
                """
                state.requests.append(request)
                # POST body is checked at the transport boundary, not by mirroring production conditionals.
                # 在传输边界检查 POST 正文，不镜像生产条件分支。
                if request.get_method() == "POST":
                    self_test.assertEqual(request.full_url, endpoint)
                    self_test.assertEqual(json.loads(request.data),
                        {"content": base64.b64encode(workflow).decode("ascii"), "encoding": "base64"})
                    body, status = json.dumps({"sha": state.sha, "url": state.blob_url}).encode(), state.status
                    response_url = state.response_url
                elif request.full_url == base + "/":
                    body, status, response_url = b'{"message":"Not Found"}', 404, request.full_url
                else:
                    # Value is the sole route record; bytes stay unchanged for the existing binary path.
                    # value 为唯一路由记录；现有二进制路径保留原字节。
                    value = routes[request.full_url]
                    body, status, response_url = value if isinstance(value, bytes) else json.dumps(value).encode(), 200, request.full_url
                # Response reaches the real error processor; HTTP403 is not represented as a successful JSON object.
                # response 进入真实错误处理器；HTTP403 不表示为成功 JSON 对象。
                response = urllib.response.addinfourl(io.BytesIO(body), {"Content-Type": "application/json"}, response_url, status)
                response.msg = "Created" if status == 201 else "Forbidden" if status == 403 else "OK"
                return response

        def build_with_network_fixture(*handlers):
            """Retain original SafeRedirect handlers and append offline HTTPS I/O; return real OpenerDirector.
            保留原 SafeRedirect handlers 并添加离线 HTTPS I/O；返回真实 OpenerDirector。
            """
            state.redirects.extend(handlers)
            return builder(*handlers, OfflineHTTPS())

        # Self_test is this testcase used by the network handler; env binds only fixture credentials/current identity.
        # self_test 为网络 handler 使用的本 testcase；env 仅绑定夹具凭据／当前身份。
        self_test = self
        env = {"GH_TOKEN": "fixture-only", "GITHUB_TOKEN": "unused-second-token", "GITHUB_REF": "refs/heads/main",
               "GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "test/repo",
               "GITHUB_SHA": source, "GITHUB_WORKFLOW_SHA": source, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        with patch.dict(os.environ, env), patch.object(RELEASE.urllib.request, "build_opener", side_effect=build_with_network_fixture):
            yield state
        self.assertTrue(all(isinstance(handler, RELEASE.SafeRedirect) for handler in state.redirects))

    def preflight(self, state, output):
        """Run the actual SDK preflight with state's fixed source and output receipt; return its original result.
        以 state 固定源码及 output 回执运行真实 SDK preflight；返回原结果。
        """
        return RELEASE.publication_preflight(SimpleNamespace(repository="test/repo", sdk_source_sha=state.source, version="0.6.1", output=output))

    def test_root_preflight_and_nonempty_request_guards(self):
        """Accept one real-opener HTTP201 despite metadata push false, preserving authenticated GET/binary routes.
        即使元数据 push 为 false 也接受真实 opener HTTP201，保留已认证 GET／二进制路由。
        """
        with self.transport() as state, tempfile.TemporaryDirectory(prefix="ls-blob-") as temporary:
            self.preflight(state, Path(temporary) / "receipt.json")
            self.assertTrue(state.redirects)
            self.assertEqual(state.requests[0].full_url, state.base)
            self.assertEqual(state.requests[0].get_method(), "GET")
            self.assertEqual(state.requests[0].get_header("Authorization"), "Bearer fixture-only")
            # Posts and request are actual transport observations, never inferred from YAML permissions.
            # posts 及 request 为实际传输观察，绝非从 YAML 权限推断。
            posts = [request for request in state.requests if request.get_method() == "POST"]
            self.assertEqual(len(posts), 1)
            request = posts[0]
            self.assertEqual(request.get_header("Authorization"), "Bearer fixture-only")
            self.assertEqual(request.get_header("Accept"), "application/vnd.github+json")
            self.assertEqual(request.get_header("Content-type"), "application/json")
            self.assertEqual(request.get_header("X-github-api-version"), "2022-11-28")
            self.assertEqual(request.timeout, 60)
            self.assertEqual(RELEASE.github_request("test/repo", "releases/assets/7", binary=True), b"unchanged binary asset")
            self.assertEqual(state.requests[-1].get_header("Accept"), "application/octet-stream")


    def test_existing_blob_write_rejections_preserve_original_gates(self):
        """Reject status/identity/token/source/workflow/tag errors through real preflight before downstream publication.
        通过真实 preflight 在下游发布前拒绝状态／身份／令牌／源码／工作流／标签错误。
        """
        # Cases select one exact altered fact and expected write count; no retries or alternate endpoints exist.
        # cases 选择唯一变化事实及预期写入数；不存在重试或备用端点。
        cases = ("forbidden", "not-created", "wrong-return-sha", "wrong-return-url", "redirected",
                 "missing-token", "identity", "default-branch", "source", "workflow", "workflow-type", "workflow-encoding", "workflow-sha", "tag")
        for case in cases:
            with self.subTest(case=case), self.transport() as state, tempfile.TemporaryDirectory(prefix="ls-blob-") as temporary:
                if case == "forbidden":
                    state.status = 403
                elif case == "not-created":
                    state.status = 200
                elif case == "wrong-return-sha":
                    state.sha = "b" * 40
                elif case == "wrong-return-url":
                    state.blob_url = "https://api.github.com/repos/other/repo/git/blobs/" + state.oid
                elif case == "redirected":
                    state.response_url = "https://api.github.com/repos/other/repo/git/blobs"
                elif case == "missing-token":
                    os.environ["GH_TOKEN"] = ""
                elif case == "identity":
                    state.routes[state.base]["full_name"] = "other/repo"
                elif case == "default-branch":
                    state.routes[state.base]["default_branch"] = "other"
                elif case == "source":
                    state.routes[state.base + "/git/ref/heads/main"]["object"]["sha"] = "b" * 40
                elif case == "workflow":
                    state.routes[state.definition]["content"] = base64.b64encode(b"edited definition").decode()
                elif case == "workflow-type":
                    state.routes[state.definition]["type"] = "dir"
                elif case == "workflow-encoding":
                    state.routes[state.definition]["encoding"] = "none"
                elif case == "workflow-sha":
                    state.routes[state.definition]["sha"] = "b" * 40
                else:
                    state.routes[state.base + "/git/ref/tags/v0.6.1"]["object"]["sha"] = "b" * 40
                # Output is a new local receipt; failed authorization must never manufacture successful evidence.
                # output 为新本地回执；失败授权绝不能制造成功证据。
                output = Path(temporary) / "rejected.json"
                with self.assertRaises((ValueError, RELEASE.urllib.error.HTTPError)):
                    self.preflight(state, output)
                self.assertFalse(output.exists())
                self.assertEqual(sum(request.get_method() == "POST" for request in state.requests),
                                 1 if case in ("forbidden", "not-created", "wrong-return-sha", "wrong-return-url", "redirected") else 0)


if __name__ == "__main__":
    unittest.main(argv=[__file__, *TEST_ARGUMENTS])
