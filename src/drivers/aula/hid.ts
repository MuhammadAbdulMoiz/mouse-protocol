import type { MouseStatus } from "../mouse-types.ts";
import {
  AULA_CMD_IDENTIFY,
  AULA_CMD_LINK_EVENT,
  AULA_BUTTON_ACTIONS,
  AULA_BUTTON_NAMES,
  AULA_CMD_READ_BUTTONS,
  AULA_CMD_READ_DPI,
  AULA_CMD_READ_RATE,
  AULA_CMD_WRITE_BUTTON,
  AULA_CMD_WRITE_DPI,
  AULA_CMD_WRITE_RATE,
  AULA_POLLING_RATES,
  AULA_PRODUCTS,
  AULA_REPORT_ID,
  AULA_SETTINGS_USAGE_PAGE,
  AULA_STAGE_COUNT,
  AULA_STATUS_ASLEEP,
  AULA_STATUS_BUSY,
  AULA_STATUS_OK,
  aulaBuildFrame,
  aulaDecodeButtonMap,
  aulaDecodeDpiTable,
  aulaDecodeIdentify,
  aulaDecodePollingRate,
  aulaEncodeButtonWrite,
  aulaEncodeDpiWrite,
  aulaEncodePollingRate,
  aulaGetDpiOptions,
  aulaParseReply,
  type AulaReply,
} from "../../aula/index.ts";

const WAKE_MESSAGE = "AULA SC580 did not answer. Move the mouse to wake it, then try again.";

export interface AulaSc580Options { replyTimeoutMs?: number; retries?: number; retryDelayMs?: number }

/**
 * AULA SC580. The settings collection (usage page 0xFF02) is hidden from browsers, so this client
 * is reached through OpenMouse Bridge. The active DPI stage is not readable, so `dpi` is 0.
 */
export class AulaSc580HidClient {
  readonly device: HIDDevice;
  private readonly replyTimeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private opened = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice, options: AulaSc580Options = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 800;
    this.retries = options.retries ?? 10;
    this.retryDelayMs = options.retryDelayMs ?? 400;
  }

  /** The mouse itself on its cable rather than the receiver; while plugged in it only talks this way. */
  static isWired(device: HIDDevice): boolean {
    return AULA_PRODUCTS.some((p) => !p.wireless && p.vendorId === device.vendorId && p.productId === device.productId);
  }

  static isSupported(device: HIDDevice): boolean {
    return AULA_PRODUCTS.some((p) => p.vendorId === device.vendorId && p.productId === device.productId)
      && device.collections.some((c) => c.usagePage === AULA_SETTINGS_USAGE_PAGE);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    this.opened = true;
  }

  async close(): Promise<void> {
    if (this.opened && this.device.opened) await this.device.close();
    this.opened = false;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.device.opened) await this.open();
    this.opened = true;
  }

  getDpiOptions(): number[] {
    return aulaGetDpiOptions();
  }

  get supportedPollingRates(): number[] {
    return [...AULA_POLLING_RATES];
  }

  async readStatus(): Promise<MouseStatus> {
    const identity = aulaDecodeIdentify(await this.exchange(AULA_CMD_IDENTIFY, []));
    const { stages } = await this.readTable();
    const buttonMappings = await this.readButtons();
    const pollingRateHz = await this.readPollingRate();
    // dpi 0 means unknown (the active stage is not readable); so does pollingRateHz 0.
    return {
      brand: "AULA",
      name: "AULA SC580",
      batteryPercent: identity.batteryPercent,
      batteryState: identity.batteryState,
      connectionType: AulaSc580HidClient.isWired(this.device) ? "Wired" : "Wireless",
      dpi: 0,
      pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      liftOffDistance: null,
      firmware: [],
      dpiStages: stages,
      buttonMappings,
      buttonOptions: AULA_BUTTON_ACTIONS.map((a) => a.label),
      fixedButtons: ["Left"],
      ui: { dpiStageEditor: { maxStages: AULA_STAGE_COUNT, countEditable: false, minDpi: 50, maxDpi: 12000, stepDpi: 50 } },
    };
  }

  /** `stage` is 0-based. Read-modify-write keeps the header byte; returns the DPI read back. */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= AULA_STAGE_COUNT) throw new Error(`DPI stage must be between 1 and ${AULA_STAGE_COUNT}.`);
    if (!aulaGetDpiOptions().includes(dpi)) throw new Error(`DPI ${dpi} is not supported by the AULA SC580.`);
    const { header, stages } = await this.readTable();
    stages[stage] = dpi;
    await this.exchange(AULA_CMD_WRITE_DPI, aulaEncodeDpiWrite(header, stages));
    const confirmed = (await this.readTable()).stages[stage]!;
    if (confirmed !== dpi) throw new Error(`AULA SC580 kept DPI ${confirmed} instead of ${dpi}.`);
    return confirmed;
  }

  /** Writes one slot, requires the echo, then re-reads the map to confirm. Left stays fixed. */
  async setButtonMapping(button: string, label: string): Promise<void> {
    const slot = (AULA_BUTTON_NAMES as readonly string[]).indexOf(button);
    if (slot < 0) throw new Error(`${button} is not a button on the AULA SC580.`);
    if (button === "Left") throw new Error("The AULA SC580 left button cannot be remapped.");
    let data: Uint8Array;
    try { data = aulaEncodeButtonWrite(slot, label); } catch { throw new Error(`${label} is not supported by the AULA SC580.`); }
    const echo = await this.exchange(AULA_CMD_WRITE_BUTTON, data);
    if (echo.length !== data.length || data.some((byte, i) => byte !== echo[i])) throw new Error("AULA SC580 did not echo the button write.");
    const confirmed = (await this.readButtons())[button];
    if (confirmed !== label) throw new Error(`AULA SC580 kept ${confirmed} instead of ${label} on ${button}.`);
  }

  /** Writes the rate bit and returns the rate read back. */
  async setPollingRate(rate: number): Promise<number> {
    let bits: number;
    try { bits = aulaEncodePollingRate(rate); } catch { throw new Error(`${rate} Hz is not supported by the AULA SC580.`); }
    await this.exchange(AULA_CMD_WRITE_RATE, [bits]);
    const confirmed = await this.readPollingRate();
    if (confirmed !== rate) throw new Error(`AULA SC580 kept ${confirmed} Hz instead of ${rate} Hz.`);
    return confirmed;
  }

  private async readPollingRate(): Promise<number> {
    const [bits] = await this.exchange(AULA_CMD_READ_RATE, []);
    return aulaDecodePollingRate(bits ?? 0);
  }

  private async readButtons(): Promise<Record<string, string>> {
    const labels = aulaDecodeButtonMap(await this.exchange(AULA_CMD_READ_BUTTONS, []));
    return Object.fromEntries(AULA_BUTTON_NAMES.map((name, i) => [name, labels[i]!]));
  }

  private async readTable(): Promise<{ header: number; stages: number[] }> {
    return aulaDecodeDpiTable(await this.exchange(AULA_CMD_READ_DPI, []));
  }

  private exchange(cmd: number, data: ArrayLike<number>): Promise<Uint8Array> {
    const run = async () => {
      await this.ensureOpen();
      return this.exchangeOnce(cmd, data);
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async exchangeOnce(cmd: number, data: ArrayLike<number>): Promise<Uint8Array> {
    const frame = aulaBuildFrame(cmd, data);
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const reply = await this.sendAndWait(cmd, frame);
      if (reply && reply.status === AULA_STATUS_OK) return reply.data;
      // Busy and asleep are transient; seen on hardware, the same frame succeeds on retry.
      if (reply && reply.status !== AULA_STATUS_BUSY && reply.status !== AULA_STATUS_ASLEEP) {
        throw new Error(`AULA SC580 rejected the request (status 0x${reply.status.toString(16)}).`);
      }
      if (reply) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
    }
    throw new Error(WAKE_MESSAGE);
  }

  private sendAndWait(cmd: number, frame: Uint8Array<ArrayBuffer>): Promise<AulaReply | null> {
    return new Promise((resolve, reject) => {
      const finish = (value: AulaReply | null) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", onReport);
        resolve(value);
      };
      const onReport = (event: HIDInputReportEvent) => {
        if (event.reportId !== AULA_REPORT_ID) return;
        let parsed: AulaReply;
        try {
          parsed = aulaParseReply(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        } catch {
          return; // a malformed frame is treated as noise; the timeout covers a lost reply
        }
        if (parsed.cmd !== AULA_CMD_LINK_EVENT && parsed.cmd === cmd) finish(parsed);
      };
      const timer = setTimeout(() => finish(null), this.replyTimeoutMs);
      this.device.addEventListener("inputreport", onReport);
      this.device.sendReport(AULA_REPORT_ID, frame).catch((error) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", onReport);
        reject(error);
      });
    });
  }
}
