import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { validateArchiveMembers } from "../dist/index.js";

/**
 * Build one USTAR header block; size is the payload byte count and type the tar type flag.
 * 构造单个 USTAR header block；size 为载荷字节数，type 为 tar 类型标记。
 */
function tarHeader(name, size, type, linkName = "") {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write(linkName, 157, 100, "utf8");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

/**
 * One tar entry: header, payload and zero padding to the next block.
 * 单个 tar 条目：header、载荷及补齐到下一 block 的零填充。
 */
function tarEntry(name, payload, type = "0", linkName = "") {
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, payload.length, type, linkName), payload, padding]);
}

/**
 * One pax extended header carrying the given records.
 * 携带给定记录的单个 pax 扩展 header。
 */
function paxEntry(records, type = "x") {
  const lines = Object.entries(records).map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    let length = Buffer.byteLength(body) + 1;
    while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`);
    return `${length}${body}`;
  });
  return tarEntry("PaxHeader", Buffer.from(lines.join(""), "utf8"), type);
}

const workspace = mkdtempSync(join(tmpdir(), "luaskills-tar-gz-validation-"));
const destination = join(workspace, "extract");
let archiveIndex = 0;

/**
 * Write the entries as one gzip tar archive and validate it.
 * 将条目写为单个 gzip tar 归档并校验。
 */
async function validate(entries) {
  const archive = join(workspace, `case-${archiveIndex++}.tar.gz`);
  writeFileSync(archive, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])));
  await validateArchiveMembers(archive, destination);
}

try {
  // A long pax path spans several decompressed chunks; it must be gathered whole before use.
  // 较长的 pax 路径跨越多个解压分块；使用前必须完整收集。
  const deepPath = `${"segment/".repeat(4096)}file.txt`;
  await validate([paxEntry({ path: deepPath }), tarEntry("short.txt", Buffer.from("x"))]);
  await assert.rejects(
    validate([paxEntry({ path: `../${deepPath}` }), tarEntry("short.txt", Buffer.from("x"))]),
    /Archive member escapes extraction directory/,
  );

  // GNU long names and long links replace the header fields of the next member only.
  // GNU 长名称与长链接只替换下一个成员的 header 字段。
  await validate([tarEntry("././@LongLink", Buffer.from(`${deepPath}\0`), "L"), tarEntry("short", Buffer.from("x")), tarEntry("next.txt", Buffer.alloc(0))]);
  await assert.rejects(
    validate([tarEntry("././@LongLink", Buffer.from("../escape.txt\0"), "L"), tarEntry("short", Buffer.from("x"))]),
    /Archive member escapes extraction directory/,
  );
  await assert.rejects(
    validate([tarEntry("././@LongLink", Buffer.from("../../../escape.txt\0"), "K"), tarEntry("dir/link", Buffer.alloc(0), "2", "target")]),
    /Archive member escapes extraction directory/,
  );

  // Symlink targets, member types and global pax path overrides keep their checks.
  // 符号链接目标、成员类型与全局 pax 路径覆盖保持原有检查。
  await validate([tarEntry("dir/link", Buffer.alloc(0), "2", "../sibling.txt")]);
  await assert.rejects(validate([tarEntry("dir/link", Buffer.alloc(0), "2", "../../outside.txt")]), /Archive member escapes extraction directory/);
  await assert.rejects(validate([tarEntry("fifo", Buffer.alloc(0), "6")]), /Unsupported tar member type/);
  await assert.rejects(validate([paxEntry({ path: "renamed.txt" }, "g")]), /Unsupported global pax path override/);

  // A large member is skipped, not buffered: the walk reaches the member after it in linear time.
  // 大成员被跳过而不是缓存：遍历以线性时间到达其后的成员。
  const large = Buffer.alloc(96 * 1024 * 1024);
  const started = performance.now();
  await validate([tarEntry("lib/large.bin", large), tarEntry("after.txt", Buffer.from("x"))]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 20_000, `Validating a 96 MiB member took ${Math.round(elapsed)} ms; the walk should not grow quadratically`);
  await assert.rejects(
    validate([tarEntry("lib/large.bin", large), tarEntry("../after.txt", Buffer.from("x"))]),
    /Archive member escapes extraction directory/,
  );
  console.log(`tar.gz member validation verified (96 MiB member in ${Math.round(elapsed)} ms)`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
