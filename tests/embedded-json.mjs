import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbeddedFloat, encodeEmbeddedJson, decodeEmbeddedJson } from "../dist/index.js";
import { decodeEmbeddedResponse } from "../dist/embedded-transport.js";

// Every encoding assertion uses an explicit finite fixture budget.
// 每个编码断言均使用显式有限夹具预算。
const BUDGET = 4096;

test("all 64 integer bits survive JSON without quoting or rounding", () => {
  const values = [0, Number.MAX_SAFE_INTEGER, 9007199254740992n, 9007199254740993n, 9223372036854775808n, 18446744073709551615n, -9223372036854775808n];
  for (const value of values) {
    const encoded = encodeEmbeddedJson(value, BUDGET);
    assert.equal(encoded.toString(), String(value));
    assert.equal(decodeEmbeddedJson(encoded), value);
  }
  for (const value of [Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity, 18446744073709551616n, -9223372036854775809n]) assert.throws(() => encodeEmbeddedJson(value, BUDGET));
  for (const value of ["18446744073709551616", "-9223372036854775809", "1e400"]) assert.throws(() => decodeEmbeddedJson(Buffer.from(value)));
});

test("explicit float intent supports every finite double including large integral magnitudes", () => {
  for (const value of [1e100, Number.MAX_VALUE, 9007199254740992, 100, -0, 0, Number.MIN_VALUE, -1.25]) {
    const encoded = encodeEmbeddedJson(new EmbeddedFloat(value), BUDGET);
    assert.match(encoded.toString(), /[.e]/);
    const decoded = decodeEmbeddedJson(encoded);
    assert.ok(Object.is(decoded instanceof EmbeddedFloat ? decoded.value : decoded, value));
    assert.deepEqual(decodeEmbeddedJson(encodeEmbeddedJson(decoded, BUDGET)), decoded);
  }
  assert.equal(decodeEmbeddedJson(Buffer.from("1.25")), 1.25);
  assert.ok(Object.is(decodeEmbeddedJson(encodeEmbeddedJson(-0, BUDGET)).value, -0));
  assert.throws(() => new EmbeddedFloat(Infinity));
});

test("UTF-8, explicit null, false, empty collections and hostile property names remain exact", () => {
  const value = JSON.parse('{"__proto__":{"safe":true},"constructor":null,"array":[],"object":{},"boolean":false}');
  value.text = "中文\0🦥";
  const decoded = decodeEmbeddedJson(encodeEmbeddedJson(value, BUDGET));
  assert.deepEqual(decoded, value);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal({}.safe, undefined);
  for (const text of ["\ud800", "\udc00"]) assert.throws(() => encodeEmbeddedJson(text, BUDGET), /surrogate/);
  assert.throws(() => decodeEmbeddedJson(Buffer.from('"\\ud800"')), /surrogate/);
  assert.throws(() => decodeEmbeddedJson(Buffer.from('{"\\udc00":1}')), /surrogate/);
});

test("non-JSON structures cannot invoke serialization hooks or disappear silently", () => {
  let invoked = 0;
  const getter = { get field() { invoked += 1; return 1; } };
  const hook = { toJSON() { invoked += 1; return null; } };
  const proxy = new Proxy({}, { ownKeys() { invoked += 1; return []; } });
  const cycle = {}; cycle.self = cycle;
  const sparse = new Array(1);
  const decorated = [1]; decorated.extra = 2;
  const nonEnumerable = {}; Object.defineProperty(nonEnumerable, "hidden", { value: 1 });
  const decoratedFloat = Object.assign(Object.create(EmbeddedFloat.prototype), { value: 1, ignored: true });
  for (const value of [undefined, () => 1, Symbol(), { lost: undefined }, getter, hook, proxy, cycle, sparse, decorated, nonEnumerable, decoratedFloat, new Date(), new Map(), Buffer.from("a")]) assert.throws(() => encodeEmbeddedJson(value, BUDGET));
  assert.equal(invoked, 0);
  const child = { fine: true };
  assert.deepEqual(decodeEmbeddedJson(encodeEmbeddedJson([child, child], BUDGET)), [child, child]);
});

test("request limit measures exact encoded UTF-8 bytes and includes escapes", () => {
  const value = { text: "中文\0🦥\n\\\"" };
  const encoded = encodeEmbeddedJson(value, BUDGET);
  assert.deepEqual(encodeEmbeddedJson(value, BigInt(encoded.length)), encoded);
  assert.throws(() => encodeEmbeddedJson(value, encoded.length - 1), /maxBytes/);
  for (const budget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => encodeEmbeddedJson(null, budget));
});

test("decoding rejects duplicate decoded keys, invalid UTF-8, BOM and trailing bytes", () => {
  for (const source of ['{"x":1,"\\u0078":2}', '{"nested":[{"same":true,"same":false}]}', "null true", "\ufeffnull"]) assert.throws(() => decodeEmbeddedJson(Buffer.from(source)));
  assert.throws(() => decodeEmbeddedJson(Uint8Array.from([0xff])));
  assert.deepEqual(decodeEmbeddedJson(Buffer.from('{"text":"a \\\"key\\\": 1"}')), { text: 'a "key": 1' });
});

test("response envelope validates exact version and distinguishes null from absence", () => {
  for (const result of [null, false, 0, "", [], {}]) {
    assert.deepEqual(decodeEmbeddedResponse(encodeEmbeddedJson({ protocol_version: 1, status: "ok", result }, BUDGET)), result);
  }
  for (const envelope of [{ protocol_version: 1, status: "ok" }, { protocol_version: 2, status: "ok", result: null }, { protocol_version: true, status: "ok", result: null }, { protocol_version: 1, status: "ok", result: null, extra: null }]) assert.throws(() => decodeEmbeddedResponse(encodeEmbeddedJson(envelope, BUDGET)));
  assert.throws(() => decodeEmbeddedResponse(encodeEmbeddedJson({ protocol_version: 1, status: "error", error: { code: "busy", message: "Still owned" } }, BUDGET)), (error) => error.code === "busy" && error.message === "busy: Still owned");
});
