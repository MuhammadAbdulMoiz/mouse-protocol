/*
 * AULA SC580 settings channel (see docs/aula-sc580.md).
 * Frame, both ways: [cmd, status, 0x01, len, data..., zero pad, checksum at [31]], where the
 * checksum is the low byte of the sum of the data bytes. Replies carry status 0 (ok), 1 (busy) or
 * 2 (rejected: the mouse is asleep and the receiver only echoes the request).
 */

export const AULA_SETTINGS_USAGE_PAGE = 0xff02;
export const AULA_REPORT_ID = 0;
export const AULA_PAYLOAD_SIZE = 32;
export const AULA_MAX_DATA = 27;
export const AULA_STAGE_COUNT = 6;

export const AULA_CMD_IDENTIFY = 0x30;
export const AULA_CMD_READ_DPI = 0x13;
export const AULA_CMD_WRITE_DPI = 0x03;
export const AULA_CMD_READ_RATE = 0x12;
export const AULA_CMD_WRITE_RATE = 0x02;
export const AULA_CMD_READ_BUTTONS = 0x11;
export const AULA_CMD_WRITE_BUTTON = 0x01;
/** Unsolicited link event; not part of any exchange. */
export const AULA_CMD_LINK_EVENT = 0xd1;

export const AULA_STATUS_OK = 0;
export const AULA_STATUS_BUSY = 1;
export const AULA_STATUS_ASLEEP = 2;

export interface AulaProduct {
  readonly model: "SC580";
  readonly vendorId: number;
  readonly productId: number;
  readonly wireless: boolean;
  /** True only after this exact ID and connection path were exercised on hardware. */
  readonly verified: boolean;
}

export const AULA_PRODUCTS: readonly AulaProduct[] = [
  { model: "SC580", vendorId: 0x089d, productId: 0x062f, wireless: true, verified: true },
  { model: "SC580", vendorId: 0x088d, productId: 0x062e, wireless: false, verified: true },
];

/** One data byte, one bit per rate in this order (0x01 125 Hz ... 0x08 1000 Hz). */
export const AULA_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

/** The vendor config grid: 50 to 10000 in steps of 50, then 10100 to 12000 in steps of 100. */
export const AULA_DPI_OPTIONS: readonly number[] = [
  ...Array.from({ length: 200 }, (_, i) => (i + 1) * 50),
  ...Array.from({ length: 20 }, (_, i) => 10100 + i * 100),
];

/** Slot order of the 0x11 button map: 6 slots x 3 bytes. */
export const AULA_BUTTON_NAMES = ["Left", "Right", "Middle", "Back", "Forward", "DPI"] as const;

/**
 * The selectable actions, label to 3-byte code. First byte is the family: 0x20 mouse button bitmask,
 * 0x50 DPI cycle, 0x70 disabled, 0x80 keyboard key (modifier mask, HID usage), 0x90 HID consumer usage.
 */
export const AULA_BUTTON_ACTIONS: readonly { readonly label: string; readonly code: readonly [number, number, number] }[] = [
  { label: "Left click", code: [0x20, 0x01, 0x00] },
  { label: "Right click", code: [0x20, 0x02, 0x00] },
  { label: "Middle click", code: [0x20, 0x04, 0x00] },
  { label: "Back", code: [0x20, 0x08, 0x00] },
  { label: "Forward", code: [0x20, 0x10, 0x00] },
  { label: "DPI cycle", code: [0x50, 0x01, 0x00] },
  { label: "Disabled", code: [0x70, 0x00, 0x00] },
  { label: "Cut", code: [0x80, 0x01, 0x1b] },
  { label: "Copy", code: [0x80, 0x01, 0x06] },
  { label: "Paste", code: [0x80, 0x01, 0x19] },
  { label: "Play / pause", code: [0x90, 0xcd, 0x00] },
  { label: "Stop", code: [0x90, 0xb7, 0x00] },
  { label: "Volume up", code: [0x90, 0xe9, 0x00] },
  { label: "Volume down", code: [0x90, 0xea, 0x00] },
  { label: "Mute", code: [0x90, 0xe2, 0x00] },
  { label: "Mail", code: [0x90, 0x8a, 0x01] },
  { label: "My computer", code: [0x90, 0x94, 0x01] },
  { label: "Browser home", code: [0x90, 0x23, 0x02] },
];

const MAX_RAW = 220;
const isByte = (value: number) => Number.isInteger(value) && value >= 0 && value <= 255;
const sumByte = (bytes: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 1) sum += bytes[i]!;
  return sum & 0xff;
};

export function aulaBuildFrame(cmd: number, data: ArrayLike<number> = []): Uint8Array<ArrayBuffer> {
  if (!isByte(cmd)) throw new RangeError(`AULA command ${cmd} is not a byte.`);
  if (!Number.isInteger(data.length) || data.length < 0 || data.length > AULA_MAX_DATA) {
    throw new RangeError(`AULA frame data length must be 0..${AULA_MAX_DATA}.`);
  }
  for (let i = 0; i < data.length; i += 1) {
    if (!isByte(data[i]!)) throw new RangeError(`AULA data byte ${i} is not a byte.`);
  }
  const frame = new Uint8Array(AULA_PAYLOAD_SIZE);
  frame[0] = cmd;
  frame[2] = 0x01;
  frame[3] = data.length;
  for (let i = 0; i < data.length; i += 1) frame[4 + i] = data[i]!;
  frame[31] = sumByte(data);
  return frame;
}

export interface AulaReply { cmd: number; status: number; data: Uint8Array }

/** A status-2 echo is the request frame, so its checksum is not validated. */
export function aulaParseReply(bytes: Uint8Array): AulaReply {
  if (bytes.length < AULA_PAYLOAD_SIZE) throw new RangeError("AULA reply is shorter than 32 bytes.");
  const status = bytes[1]!;
  const len = bytes[3]!;
  if (len > AULA_MAX_DATA) throw new RangeError("AULA reply length is out of range.");
  const data = bytes.slice(4, 4 + len);
  if (status === AULA_STATUS_OK && sumByte(data) !== bytes[31]) throw new RangeError("AULA reply checksum mismatch.");
  return { cmd: bytes[0]!, status, data };
}

export interface AulaIdentity { batteryPercent: number | null; batteryState: "Charging" | "Discharging" }

/**
 * Data starts "M137". Byte 8 is 1 while the cable is in (charging) and 0 on battery. Byte 9 is the
 * charge in percent on battery, but a fixed 100 on the cable, so it is dropped while charging.
 */
export function aulaDecodeIdentify(data: Uint8Array): AulaIdentity {
  if (data.length < 10 || String.fromCharCode(...data.slice(0, 4)) !== "M137") {
    throw new RangeError("This device did not identify as an AULA SC580.");
  }
  const charging = data[8] === 1;
  const battery = data[9]!;
  return {
    batteryPercent: !charging && battery <= 100 ? battery : null,
    batteryState: charging ? "Charging" : "Discharging",
  };
}

/** Raw stage byte: DPI / 50 up to 10000 (raw 200), then 200 + (DPI - 10000) / 100, so 12000 is raw 220. */
export function aulaDpiFromRaw(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_RAW) throw new RangeError(`AULA raw DPI ${raw} is out of range.`);
  return raw <= 200 ? raw * 50 : 10000 + (raw - 200) * 100;
}

export function aulaRawFromDpi(dpi: number): number {
  if (!AULA_DPI_OPTIONS.includes(dpi)) throw new RangeError(`DPI ${dpi} is not on the AULA grid.`);
  return dpi <= 10000 ? dpi / 50 : 200 + (dpi - 10000) / 100;
}

export function aulaDecodeDpiTable(data: Uint8Array): { header: number; stages: number[] } {
  if (data.length < 1 + AULA_STAGE_COUNT * 4) throw new RangeError("AULA sent a short DPI table.");
  return { header: data[0]!, stages: Array.from({ length: AULA_STAGE_COUNT }, (_, i) => aulaDpiFromRaw(data[1 + i * 4]!)) };
}

/** The 27 data bytes of a DPI write: offset 0, the header as read, six 4-byte stages, one pad byte. */
export function aulaEncodeDpiWrite(header: number, stages: readonly number[]): Uint8Array {
  if (!isByte(header)) throw new RangeError("AULA DPI header must be a byte.");
  if (stages.length !== AULA_STAGE_COUNT) throw new RangeError(`AULA DPI write needs exactly ${AULA_STAGE_COUNT} stages.`);
  const data = new Uint8Array(AULA_MAX_DATA);
  data[1] = header;
  stages.forEach((dpi, i) => { data[2 + i * 4] = aulaRawFromDpi(dpi); });
  return data;
}

export function aulaEncodePollingRate(rate: number): number {
  const index = AULA_POLLING_RATES.indexOf(rate);
  if (index < 0) throw new RangeError(`${rate} Hz is not supported by the AULA SC580.`);
  return 1 << index;
}

/** 0 when the byte is not one of the known single-bit values. */
export function aulaDecodePollingRate(bits: number): number {
  const index = [1, 2, 4, 8].indexOf(bits);
  return index < 0 ? 0 : AULA_POLLING_RATES[index]!;
}

/** Option that restores a slot's factory action; never a decoded label. */
export const AULA_DEFAULT_OPTION = "Default";

/** Factory action per button (read after a vendor reset). */
export const AULA_BUTTON_DEFAULTS: Readonly<Record<(typeof AULA_BUTTON_NAMES)[number], string>> = {
  Left: "Left click",
  Right: "Right click",
  Middle: "Middle click",
  Back: "Back",
  Forward: "Forward",
  DPI: "DPI cycle",
};

/** Only these modifier bits are exposed; Alt and Win were not tested. Label order is this order. */
export const AULA_SHORTCUT_MODIFIERS: readonly { readonly name: string; readonly bit: number }[] = [
  { name: "Ctrl", bit: 0x01 },
  { name: "Shift", bit: 0x02 },
];

/** Standard HID keyboard usages offered for shortcuts, in display order. */
export const AULA_SHORTCUT_KEYS: readonly { readonly name: string; readonly usage: number }[] = [
  ...Array.from({ length: 26 }, (_, i) => ({ name: String.fromCharCode(65 + i), usage: 0x04 + i })),
  ...[..."1234567890"].map((name, i) => ({ name, usage: 0x1e + i })),
  { name: "Enter", usage: 0x28 }, { name: "Escape", usage: 0x29 }, { name: "Backspace", usage: 0x2a },
  { name: "Tab", usage: 0x2b }, { name: "Space", usage: 0x2c },
  ...Array.from({ length: 12 }, (_, i) => ({ name: `F${i + 1}`, usage: 0x3a + i })),
  { name: "Insert", usage: 0x49 }, { name: "Home", usage: 0x4a }, { name: "Page up", usage: 0x4b },
  { name: "Delete", usage: 0x4c }, { name: "End", usage: 0x4d }, { name: "Page down", usage: 0x4e },
  { name: "Right arrow", usage: 0x4f }, { name: "Left arrow", usage: 0x50 },
  { name: "Down arrow", usage: 0x51 }, { name: "Up arrow", usage: 0x52 },
];

/** `Ctrl+Shift+A`, `Shift+F5` or `A`: modifiers in fixed order, then the key. Null for anything else. */
function shortcutLabel(mask: number, usage: number): string | null {
  const key = AULA_SHORTCUT_KEYS.find((k) => k.usage === usage);
  const allowed = AULA_SHORTCUT_MODIFIERS.reduce((all, m) => all | m.bit, 0);
  if (!key || (mask & ~allowed) !== 0) return null;
  return [...AULA_SHORTCUT_MODIFIERS.filter((m) => mask & m.bit).map((m) => m.name), key.name].join("+");
}

/** Strict: known modifiers once each, then exactly one known key. Returns the 3-byte code. */
function parseShortcut(label: string): [number, number, number] {
  const parts = label.split("+");
  const last = parts.pop();
  const key = AULA_SHORTCUT_KEYS.find((k) => k.name === last);
  if (!key) throw new RangeError(`AULA button action "${label}" is not supported.`);
  let mask = 0;
  for (const part of parts) {
    const modifier = AULA_SHORTCUT_MODIFIERS.find((m) => m.name === part);
    if (!modifier || mask & modifier.bit) throw new RangeError(`AULA button action "${label}" is not supported.`);
    mask |= modifier.bit;
  }
  return [0x80, mask, key.usage];
}

/** Label for one 3-byte code: the action table first, then a shortcut, else `Custom (xx xx xx)`. */
export function aulaDecodeButtonCode(code: ArrayLike<number>): string {
  const known = AULA_BUTTON_ACTIONS.find((a) => a.code.every((byte, i) => byte === code[i]));
  if (known) return known.label;
  const shortcut = code[0] === 0x80 ? shortcutLabel(code[1]!, code[2]!) : null;
  return shortcut ?? `Custom (${Array.from({ length: 3 }, (_, i) => code[i]!.toString(16).padStart(2, "0")).join(" ")})`;
}

/** One label per slot, in `AULA_BUTTON_NAMES` order; an unknown code reads as `Custom (xx xx xx)`. */
export function aulaDecodeButtonMap(data: Uint8Array): string[] {
  if (data.length !== AULA_BUTTON_NAMES.length * 3) throw new RangeError(`AULA button map must be ${AULA_BUTTON_NAMES.length * 3} bytes.`);
  return AULA_BUTTON_NAMES.map((_, slot) => aulaDecodeButtonCode(data.slice(slot * 3, slot * 3 + 3)));
}

/**
 * The 4 data bytes of a single-slot write: slot, then the 3-byte code of a table action, a shortcut
 * label, or `Default` (the slot's factory action).
 */
export function aulaEncodeButtonWrite(slot: number, label: string): Uint8Array {
  if (!Number.isInteger(slot) || slot < 0 || slot >= AULA_BUTTON_NAMES.length) throw new RangeError(`AULA button slot must be 0..${AULA_BUTTON_NAMES.length - 1}.`);
  const name = label === AULA_DEFAULT_OPTION ? AULA_BUTTON_DEFAULTS[AULA_BUTTON_NAMES[slot]!] : label;
  const action = AULA_BUTTON_ACTIONS.find((a) => a.label === name);
  return Uint8Array.of(slot, ...(action ? action.code : parseShortcut(name)));
}

export function aulaGetDpiOptions(): number[] {
  return [...AULA_DPI_OPTIONS];
}
