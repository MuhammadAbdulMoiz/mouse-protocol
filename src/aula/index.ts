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

export function aulaGetDpiOptions(): number[] {
  return [...AULA_DPI_OPTIONS];
}
