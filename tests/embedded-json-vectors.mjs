import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EmbeddedFloat, decodeEmbeddedJson, encodeEmbeddedJson } from "../dist/embedded-json.js";
import { decodeEmbeddedResponse } from "../dist/embedded-transport.js";

// The packaged contract and its digest own the corpus; no neighboring repository is consulted.
// 包内契约及其摘要拥有语料；不查询相邻仓库。
const corpus = JSON.parse(readFileSync(new URL("../contracts/embedded/v1/contract.json", import.meta.url), "utf8")).json_vectors;
assert.equal(corpus.version, 1);

/**
 * Return value's semantic fingerprint, preserving integer intent and exact IEEE binary64 bits.
 * 返回 value 的语义指纹，保留整数意图及精确 IEEE 双精度浮点位。
 * @param {unknown} value The decoded JSON value to inspect.
 * 待检查的已解码 JSON 值。
 * @returns {unknown[]} A JSON-comparable tagged representation.
 * 可按 JSON 比较的带标记表示。
 */
function fingerprint(value) {
  if (value === null) return ["null"];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "bigint") return ["integer", String(value)];
  if (value instanceof EmbeddedFloat || typeof value === "number") {
    if (!(value instanceof EmbeddedFloat) && Number.isInteger(value)) return ["integer", String(value)];
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value instanceof EmbeddedFloat ? value.value : value);
    return ["float", bytes.toString("hex")];
  }
  if (Array.isArray(value)) return ["array", value.map(fingerprint)];
  return ["object", Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fingerprint(child)]))];
}

for (const entry of corpus.valid) test(`shared JSON valid: ${entry.id}`, () => {
  const value = decodeEmbeddedJson(Buffer.from(entry.json));
  assert.deepEqual(fingerprint(value), entry.expected);
  const encoded = encodeEmbeddedJson(value, 4096);
  assert.deepEqual(fingerprint(decodeEmbeddedJson(encoded)), entry.expected);
  assert.deepEqual(encodeEmbeddedJson(value, encoded.length), encoded);
  assert.throws(() => encodeEmbeddedJson(value, encoded.length - 1));
  assert.deepEqual(fingerprint(decodeEmbeddedResponse(Buffer.from(`{"protocol_version":1,"status":"ok","result":${entry.json}}`))), entry.expected);
});

for (const entry of corpus.invalid) test(`shared JSON invalid: ${entry.id}`, () => {
  assert.throws(() => decodeEmbeddedJson(Buffer.from(entry.json)));
  assert.throws(() => decodeEmbeddedResponse(Buffer.from(`{"protocol_version":1,"status":"ok","result":${entry.json}}`)));
});

for (const entry of corpus.invalid_bytes) test(`shared JSON bytes: ${entry.id}`, () => {
  assert.throws(() => decodeEmbeddedJson(Buffer.from(entry.hex, "hex")));
});

for (const entry of corpus.invalid_envelopes) test(`shared JSON envelope: ${entry.id}`, () => {
  assert.throws(() => decodeEmbeddedResponse(Buffer.from(entry.json)));
});
