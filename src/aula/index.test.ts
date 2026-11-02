import assert from "node:assert/strict";
import test from "node:test";

import {
  AULA_DPI_OPTIONS,
  AULA_PRODUCTS,
  aulaBuildFrame,
  aulaDecodeDpiTable,
  aulaDecodeIdentify,
  aulaDecodePollingRate,
  aulaDpiFromRaw,
  aulaEncodeDpiWrite,
  aulaEncodePollingRate,
  aulaParseReply,
  aulaRawFromDpi,
} from "./index.ts";

const hex = (text: string) => Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));
const pad = (text: string) => { const out = new Uint8Array(32); out.set(hex(text)); return out; };

const WRITE_FRAME = hex("03 00 01 1b 00 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 18");
const READ_REPLY = hex("13 00 01 19 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 00 18");
const BATTERY_IDENTIFY = (() => { const r = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 00 3e 01"); r[31] = 0xf9; return r; })();
const CABLE_IDENTIFY = (() => { const r = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 01 64 01"); r[31] = 0x20; return r; })();
const STAGES = [800, 1900, 2400, 3200, 6400, 12000];

test("catalog lists both verified connection paths", () => {
  assert.deepEqual(AULA_PRODUCTS.map((p) => [p.vendorId, p.productId, p.wireless, p.verified]), [
    [0x089d, 0x062f, true, true],
    [0x088d, 0x062e, false, true],
  ]);
});

test("write frame matches the vendor capture byte for byte", () => {
  assert.deepEqual(aulaBuildFrame(0x03, aulaEncodeDpiWrite(0x16, STAGES)), WRITE_FRAME);
});

test("identify and polling write requests", () => {
  assert.deepEqual(aulaBuildFrame(0x30), pad("30 00 01 00"));
  assert.deepEqual(aulaBuildFrame(0x02, [0x08]), pad("02 00 01 01 08").fill(0x08, 31));
});

test("frame build validates the command and data", () => {
  assert.throws(() => aulaBuildFrame(256), RangeError);
  assert.throws(() => aulaBuildFrame(-1), RangeError);
  assert.throws(() => aulaBuildFrame(1.5), RangeError);
  assert.throws(() => aulaBuildFrame(1, new Array(28).fill(0)), RangeError);
  assert.throws(() => aulaBuildFrame(1, { length: -1 } as ArrayLike<number>), RangeError);
  assert.throws(() => aulaBuildFrame(1, { length: 1.5, 0: 1 } as ArrayLike<number>), RangeError);
  assert.throws(() => aulaBuildFrame(1, [256]), RangeError);
  assert.throws(() => aulaBuildFrame(1, [1.5]), RangeError);
  assert.equal(aulaBuildFrame(1, new Array(27).fill(1))[31], 27);
});

test("parses captured replies and echoes", () => {
  const table = aulaParseReply(READ_REPLY);
  assert.equal(table.cmd, 0x13);
  assert.equal(table.status, 0);
  assert.equal(table.data.length, 25);
  assert.deepEqual(aulaDecodeDpiTable(table.data), { header: 0x16, stages: STAGES });
  const echo = aulaBuildFrame(0x13);
  echo[1] = 0x02;
  echo[31] = 0x77;
  assert.equal(aulaParseReply(echo).status, 2);
});

test("reply decoding rejects short, oversized and corrupt frames", () => {
  assert.throws(() => aulaParseReply(new Uint8Array(31)), RangeError);
  const long = READ_REPLY.slice();
  long[3] = 28;
  assert.throws(() => aulaParseReply(long), RangeError);
  const bad = READ_REPLY.slice();
  bad[31] ^= 0xff;
  assert.throws(() => aulaParseReply(bad), RangeError);
});

test("identify decodes battery and the charging flag", () => {
  assert.deepEqual(aulaDecodeIdentify(aulaParseReply(BATTERY_IDENTIFY).data), { batteryPercent: 0x3e, batteryState: "Discharging" });
  assert.deepEqual(aulaDecodeIdentify(aulaParseReply(CABLE_IDENTIFY).data), { batteryPercent: null, batteryState: "Charging" });
  const odd = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 00 65 01").slice(4, 15);
  assert.equal(aulaDecodeIdentify(odd).batteryPercent, null);
  assert.throws(() => aulaDecodeIdentify(hex("00 00 00 00 00 00 00 00 00 00")), RangeError);
  assert.throws(() => aulaDecodeIdentify(hex("4d 31 33 37")), RangeError);
});

test("stage bytes switch to 100 DPI steps above 10000", () => {
  for (const [raw, dpi] of [[1, 50], [16, 800], [200, 10000], [201, 10100], [0xdc, 12000]] as const) {
    assert.equal(aulaDpiFromRaw(raw), dpi);
    assert.equal(aulaRawFromDpi(dpi), raw);
  }
});

test("every grid DPI round trips and the grid has the expected shape", () => {
  assert.equal(AULA_DPI_OPTIONS.length, 220);
  assert.equal(AULA_DPI_OPTIONS[0], 50);
  assert.equal(AULA_DPI_OPTIONS.at(-1), 12000);
  for (const dpi of AULA_DPI_OPTIONS) assert.equal(aulaDpiFromRaw(aulaRawFromDpi(dpi)), dpi);
  for (let raw = 1; raw <= 220; raw += 1) assert.equal(aulaRawFromDpi(aulaDpiFromRaw(raw)), raw);
});

test("DPI conversion rejects off-grid and out-of-range values", () => {
  for (const dpi of [0, 25, 10050, 12100, -50, 75, NaN]) assert.throws(() => aulaRawFromDpi(dpi), RangeError);
  for (const raw of [0, 221, 255, -1, 1.5, NaN]) assert.throws(() => aulaDpiFromRaw(raw), RangeError);
});

test("DPI table decode rejects short tables and bad stage bytes", () => {
  assert.throws(() => aulaDecodeDpiTable(new Uint8Array(24)), RangeError);
  const zero = aulaParseReply(READ_REPLY).data.slice();
  zero[1] = 0;
  assert.throws(() => aulaDecodeDpiTable(zero), RangeError);
  const high = aulaParseReply(READ_REPLY).data.slice();
  high[5] = 221;
  assert.throws(() => aulaDecodeDpiTable(high), RangeError);
});

test("DPI write validates stage count, grid and header", () => {
  assert.throws(() => aulaEncodeDpiWrite(0x16, STAGES.slice(0, 5)), RangeError);
  assert.throws(() => aulaEncodeDpiWrite(0x16, [...STAGES, 800]), RangeError);
  assert.throws(() => aulaEncodeDpiWrite(0x16, [800, 1900, 2400, 3200, 6400, 10050]), RangeError);
  assert.throws(() => aulaEncodeDpiWrite(256, STAGES), RangeError);
  assert.throws(() => aulaEncodeDpiWrite(1.5, STAGES), RangeError);
  assert.throws(() => aulaEncodeDpiWrite(-1, STAGES), RangeError);
});

test("polling bits map to rates and back", () => {
  for (const [rate, bits] of [[125, 1], [250, 2], [500, 4], [1000, 8]] as const) {
    assert.equal(aulaEncodePollingRate(rate), bits);
    assert.equal(aulaDecodePollingRate(bits), rate);
  }
  for (const rate of [0, 2000, 8000, 100]) assert.throws(() => aulaEncodePollingRate(rate), RangeError);
  for (const bits of [0, 3, 5, 16, 255]) assert.equal(aulaDecodePollingRate(bits), 0);
});
