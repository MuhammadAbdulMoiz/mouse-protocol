import assert from "node:assert/strict";
import test from "node:test";

import {
  AULA_DPI_OPTIONS,
  AULA_BUTTON_ACTIONS,
  AULA_BUTTON_DEFAULTS,
  AULA_BUTTON_NAMES,
  AULA_PRODUCTS,
  AULA_SHORTCUT_KEYS,
  AULA_SHORTCUT_MODIFIERS,
  aulaBuildFrame,
  aulaDecodeButtonMap,
  aulaDecodeDpiTable,
  aulaDecodeIdentify,
  aulaDecodePollingRate,
  aulaDpiFromRaw,
  aulaEncodeButtonWrite,
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

const FACTORY_MAP = hex("20 01 00 20 02 00 20 04 00 20 08 00 20 10 00 50 01 00");

test("button writes match the vendor captures byte for byte", () => {
  for (const [slot, label, frame] of [
    [4, "Back", "01 00 01 04 04 20 08 00"],
    [1, "Volume up", "01 00 01 04 01 90 e9 00"],
    [3, "Copy", "01 00 01 04 03 80 01 06"],
  ] as const) {
    const expected = pad(frame);
    expected[31] = { Back: 0x2c, "Volume up": 0x7a, Copy: 0x8a }[label];
    assert.deepEqual(aulaBuildFrame(0x01, aulaEncodeButtonWrite(slot, label)), expected);
  }
});

test("the factory button map decodes to the stock actions", () => {
  assert.deepEqual(aulaDecodeButtonMap(FACTORY_MAP), ["Left click", "Right click", "Middle click", "Back", "Forward", "DPI cycle"]);
  assert.deepEqual(AULA_BUTTON_NAMES, ["Left", "Right", "Middle", "Back", "Forward", "DPI"]);
  assert.equal(AULA_BUTTON_ACTIONS.length, 18);
});

test("every table action round trips through a slot", () => {
  for (const { label } of AULA_BUTTON_ACTIONS) {
    const data = aulaEncodeButtonWrite(5, label);
    assert.equal(data.length, 4);
    const map = FACTORY_MAP.slice();
    map.set(data.slice(1), 15);
    assert.equal(aulaDecodeButtonMap(map)[5], label);
  }
});

test("codes outside the table decode as Custom and button map decode is strict", () => {
  const map = FACTORY_MAP.slice();
  map.set([0x50, 0x02, 0x00], 15);
  map.set([0x40, 0x32, 0x03], 0);
  assert.deepEqual([aulaDecodeButtonMap(map)[5], aulaDecodeButtonMap(map)[0]], ["Custom (50 02 00)", "Custom (40 32 03)"]);
  for (const length of [0, 17, 19]) assert.throws(() => aulaDecodeButtonMap(new Uint8Array(length)), RangeError);
});

test("button write rejects bad slots and unknown labels", () => {
  for (const slot of [-1, 6, 1.5, NaN]) assert.throws(() => aulaEncodeButtonWrite(slot, "Back"), RangeError);
  for (const label of ["Custom (50 02 00)", "back", ""]) assert.throws(() => aulaEncodeButtonWrite(1, label), RangeError);
});

const SHORTCUT_KEY_COUNT = AULA_SHORTCUT_KEYS.length;

test("Default writes each slot's factory code", () => {
  AULA_BUTTON_NAMES.forEach((name, slot) => {
    assert.deepEqual(aulaEncodeButtonWrite(slot, "Default"), Uint8Array.of(slot, ...FACTORY_MAP.slice(slot * 3, slot * 3 + 3)));
    assert.equal(AULA_BUTTON_DEFAULTS[name], aulaDecodeButtonMap(FACTORY_MAP)[slot]);
  });
});

test("shortcut table covers the requested keys", () => {
  assert.equal(SHORTCUT_KEY_COUNT, 26 + 10 + 5 + 12 + 10);
  assert.deepEqual(AULA_SHORTCUT_MODIFIERS.map((m) => m.name), ["Ctrl", "Shift"]);
  assert.equal(AULA_SHORTCUT_KEYS.find((k) => k.name === "Up arrow")?.usage, 0x52);
});

test("shortcuts round trip across the key table", () => {
  for (const { name, usage } of AULA_SHORTCUT_KEYS) {
    for (const [prefix, mask] of [["", 0], ["Ctrl+", 1], ["Shift+", 2], ["Ctrl+Shift+", 3]] as const) {
      const label = prefix + name;
      const data = aulaEncodeButtonWrite(3, label);
      assert.deepEqual([...data], [3, 0x80, mask, usage]);
      const map = FACTORY_MAP.slice();
      map.set(data.slice(1), 9);
      const decoded = aulaDecodeButtonMap(map)[3];
      // Ctrl+X, Ctrl+C and Ctrl+V are table actions and win.
      assert.equal(decoded, { "Ctrl+X": "Cut", "Ctrl+C": "Copy", "Ctrl+V": "Paste" }[label] ?? label);
    }
  }
});

test("shortcut parsing is strict and accepts any modifier order", () => {
  assert.deepEqual([...aulaEncodeButtonWrite(3, "Shift+Ctrl+A")], [3, 0x80, 3, 4]);
  for (const label of ["Alt+A", "Ctrl+Ctrl+A", "A+Ctrl", "Ctrl+", "Ctrl", "Shift+", "A+B", "Ctrl+Nope", "ctrl+a", "Ctrl+a", "+A", "Ctrl++A"]) {
    assert.throws(() => aulaEncodeButtonWrite(3, label), RangeError, label);
  }
});

test("other modifier bits and unknown usages decode as Custom", () => {
  const map = FACTORY_MAP.slice();
  map.set([0x80, 0x04, 0x04], 3);
  map.set([0x80, 0x01, 0x00], 6);
  map.set([0x80, 0x03, 0x65], 9);
  assert.deepEqual(aulaDecodeButtonMap(map).slice(1, 4), ["Custom (80 04 04)", "Custom (80 01 00)", "Custom (80 03 65)"]);
});

test("captured shortcut frames match byte for byte", () => {
  for (const [slot, label, frame, sum] of [
    [3, "A", "01 00 01 04 03 80 00 04", 0x87],
    [4, "Shift+A", "01 00 01 04 04 80 02 04", 0x8a],
  ] as const) {
    const expected = pad(frame);
    expected[31] = sum;
    assert.deepEqual(aulaBuildFrame(0x01, aulaEncodeButtonWrite(slot, label)), expected);
  }
});
