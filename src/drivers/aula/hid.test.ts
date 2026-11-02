import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { aulaBuildFrame, aulaDpiFromRaw, aulaRawFromDpi } from "../../aula/index.ts";
import { clientSupportScore, createSupportedClient, deviceBrand } from "../registry.ts";
import { AulaSc580HidClient } from "./hid.ts";

const hex = (text: string) => Uint8Array.from(text.replace(/\s+/g, "").match(/../g)!.map((byte) => parseInt(byte, 16)));
const pad = (text: string) => { const out = new Uint8Array(32); out.set(hex(text)); return out; };

const WRITE_FRAME = hex("03 00 01 1b 00 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 18");
const READ_REPLY = hex("13 00 01 19 16 10 00 00 00 26 00 00 00 30 00 00 00 40 00 00 00 80 00 00 00 dc 00 00 00 00 00 18");
const IDENTIFY_REPLY = (() => { const r = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 00 3e 01"); r[31] = 0xf9; return r; })();
const FACTORY_MAP = [0x20, 0x01, 0x00, 0x20, 0x02, 0x00, 0x20, 0x04, 0x00, 0x20, 0x08, 0x00, 0x20, 0x10, 0x00, 0x50, 0x01, 0x00];
const FACTORY_LABELS = { Left: "Left click", Right: "Right click", Middle: "Middle click", Back: "Back", Forward: "Forward", DPI: "DPI cycle" };
const STAGES = [800, 1900, 2400, 3200, 6400, 12000];

interface FakeDevice extends HIDDevice { sent: Uint8Array[]; push(payload: Uint8Array, reportId?: number): void }

function fakeDevice(usagePage = 0xff02, respond?: (frame: Uint8Array, device: FakeDevice) => void): FakeDevice {
  const target = new EventTarget();
  const device = {
    productName: "Wireless-Receiver",
    vendorId: 0x089d,
    productId: 0x062f,
    collections: [{ usagePage, usage: 0, children: [], inputReports: [], outputReports: [], featureReports: [] }],
    opened: false,
    sent: [] as Uint8Array[],
    open: async () => { device.opened = true; },
    close: async () => { device.opened = false; },
    sendReport: async (_id: number, data: BufferSource) => {
      assert.ok(device.opened, "sendReport on a closed device");
      const frame = new Uint8Array(data as Uint8Array);
      device.sent.push(frame);
      // Microtask, not a timer: the repo test shim collapses timers to 1 ms, which would race the reply.
      queueMicrotask(() => respond?.(frame, device));
    },
    addEventListener: (type: string, fn: EventListener) => target.addEventListener(type, fn),
    removeEventListener: (type: string, fn: EventListener) => target.removeEventListener(type, fn),
    push: (payload: Uint8Array, reportId = 0) => {
      const event = Object.assign(new Event("inputreport"), { reportId, data: new DataView(payload.buffer.slice(0) as ArrayBuffer) });
      target.dispatchEvent(event);
    },
  };
  return device as unknown as FakeDevice;
}

/** A device that behaves like the mouse: identify, table read and echoed write. */
function mouse(stages = [...STAGES], rate = { bits: 0x02 }, buttons = [...FACTORY_MAP]) {
  return fakeDevice(0xff02, (frame, device) => {
    if (frame[0] === 0x30) device.push(IDENTIFY_REPLY);
    else if (frame[0] === 0x12) device.push(aulaBuildFrame(0x12, [rate.bits]));
    else if (frame[0] === 0x11) device.push(aulaBuildFrame(0x11, buttons));
    else if (frame[0] === 0x01) { buttons.splice(frame[4]! * 3, 3, frame[5]!, frame[6]!, frame[7]!); device.push(frame); }
    else if (frame[0] === 0x02) { rate.bits = frame[4]!; device.push(frame); }
    else if (frame[0] === 0x13) {
      const data = [0x16, ...stages.flatMap((dpi) => [aulaRawFromDpi(dpi), 0, 0, 0])];
      device.push(aulaBuildFrame(0x13, data));
    } else if (frame[0] === 0x03) {
      for (let i = 0; i < 6; i += 1) stages[i] = aulaDpiFromRaw(frame[4 + 2 + i * 4]!);
      device.push(frame);
    }
  });
}

const fast = { replyTimeoutMs: 20, retries: 3, retryDelayMs: 1 };
type Exchanger = { exchange(c: number, d: number[]): Promise<Uint8Array> };

describe("aula support", () => {
  test("isSupported needs the vendor pair and the 0xff02 collection", () => {
    assert.equal(AulaSc580HidClient.isSupported(fakeDevice(0xff02)), true);
    assert.equal(AulaSc580HidClient.isSupported(Object.assign(fakeDevice(0xff02), { vendorId: 0x088d, productId: 0x062e })), true);
    assert.equal(AulaSc580HidClient.isSupported(fakeDevice(0xff01)), false);
    assert.equal(AulaSc580HidClient.isSupported(Object.assign(fakeDevice(0xff02), { vendorId: 0x1234 })), false);
    assert.equal(AulaSc580HidClient.isSupported(Object.assign(fakeDevice(0xff02), { productId: 0x062e })), false);
  });

  test("isWired is true only for the cable", () => {
    assert.equal(AulaSc580HidClient.isWired(fakeDevice()), false);
    assert.equal(AulaSc580HidClient.isWired(Object.assign(fakeDevice(), { vendorId: 0x088d, productId: 0x062e })), true);
  });
});

describe("aula client", () => {
  test("opens the device first and reads status without inventing an active stage", async () => {
    const device = mouse();
    const status = await new AulaSc580HidClient(device, fast).readStatus();
    assert.equal(device.opened, true);
    assert.deepEqual(status.dpiStages, STAGES);
    assert.equal(status.dpi, 0);
    assert.equal("activeDpiStage" in status, false);
    assert.equal(status.batteryPercent, 0x3e);
    assert.equal(status.batteryState, "Discharging");
    assert.equal(status.connectionType, "Wireless");
    assert.equal(status.pollingRateHz, 250);
    assert.deepEqual(status.supportedPollingRates, [125, 250, 500, 1000]);
    assert.deepEqual(status.firmware, []);
    assert.equal(status.liftOffDistance, null);
    assert.equal(status.activeProfile, null);
    assert.deepEqual(status.ui?.dpiStageEditor, { maxStages: 6, countEditable: false, minDpi: 50, maxDpi: 12000, stepDpi: 50 });
  });

  test("readStatus reports the button map, the options and the fixed Left button", async () => {
    const status = await new AulaSc580HidClient(mouse(), fast).readStatus();
    assert.deepEqual(status.buttonMappings, FACTORY_LABELS);
    assert.equal(status.buttonOptions?.length, 18);
    assert.equal(status.buttonOptions?.[0], "Left click");
    assert.deepEqual(status.fixedButtons, ["Left"]);
  });

  test("a malformed button map rejects readStatus immediately", async () => {
    const device = fakeDevice(0xff02, (frame, d) => {
      if (frame[0] === 0x30) d.push(IDENTIFY_REPLY);
      else if (frame[0] === 0x13) d.push(READ_REPLY);
      else if (frame[0] === 0x11) d.push(aulaBuildFrame(0x11, FACTORY_MAP.slice(0, 17)));
    });
    await assert.rejects(new AulaSc580HidClient(device, fast).readStatus(), RangeError);
    assert.deepEqual(device.sent.map((frame) => frame[0]), [0x30, 0x13, 0x11]);
  });

  test("setButtonMapping writes one slot, then re-reads and confirms", async () => {
    const buttons = [...FACTORY_MAP];
    const device = mouse(undefined, undefined, buttons);
    await new AulaSc580HidClient(device, fast).setButtonMapping("Back", "Volume up");
    assert.deepEqual(device.sent.map((frame) => frame[0]), [0x01, 0x11]);
    assert.deepEqual(device.sent[0], aulaBuildFrame(0x01, [3, 0x90, 0xe9, 0x00]));
    assert.deepEqual(buttons.slice(9, 12), [0x90, 0xe9, 0x00]);
  });

  test("setButtonMapping refuses Left, bad buttons and unknown actions without sending", async () => {
    const device = mouse();
    const client = new AulaSc580HidClient(device, fast);
    await assert.rejects(client.setButtonMapping("Left", "Mute"), /left button/);
    await assert.rejects(client.setButtonMapping("Side", "Mute"), /not a button/);
    await assert.rejects(client.setButtonMapping("Back", "Custom (50 02 00)"), /not supported/);
    assert.equal(device.sent.length, 0);
  });

  test("setButtonMapping throws when the re-read does not show the new action", async () => {
    const device = fakeDevice(0xff02, (frame, d) => {
      if (frame[0] === 0x01) d.push(frame);
      else if (frame[0] === 0x11) d.push(aulaBuildFrame(0x11, FACTORY_MAP));
    });
    await assert.rejects(new AulaSc580HidClient(device, fast).setButtonMapping("Back", "Mute"), /kept Back instead of Mute/);
  });

  test("setPollingRate writes the vendor's rate bit and confirms it", async () => {
    const rate = { bits: 0x02 };
    const device = mouse(undefined, rate);
    assert.equal(await new AulaSc580HidClient(device, fast).setPollingRate(1000), 1000);
    assert.deepEqual(device.sent[0], pad("02 00 01 01 08").fill(0x08, 31));
    assert.equal(rate.bits, 0x08);
    await assert.rejects(new AulaSc580HidClient(mouse(), fast).setPollingRate(2000), /not supported/);
  });

  test("on the cable it reports Charging and hides the placeholder 100%", async () => {
    // Captured over the cable: byte 8 = 01 (charging), byte 9 = 0x64.
    const cableIdentify = (() => { const r = pad("30 00 01 0b 4d 31 33 37 01 16 11 aa 01 64 01"); r[31] = 0x20; return r; })();
    const device = Object.assign(fakeDevice(0xff02, (frame, d) => {
      if (frame[0] === 0x30) d.push(cableIdentify);
      else if (frame[0] === 0x13) d.push(READ_REPLY);
      else if (frame[0] === 0x11) d.push(aulaBuildFrame(0x11, FACTORY_MAP));
      else if (frame[0] === 0x12) d.push(aulaBuildFrame(0x12, [0x04]));
    }), { vendorId: 0x088d, productId: 0x062e });
    const status = await new AulaSc580HidClient(device, fast).readStatus();
    assert.equal(status.batteryState, "Charging");
    assert.equal(status.batteryPercent, null);
    assert.equal(status.connectionType, "Wired");
    assert.equal(status.pollingRateHz, 500);
  });

  test("an unknown rate byte reads as 0 rather than a guess", async () => {
    const status = await new AulaSc580HidClient(mouse(undefined, { bits: 0x03 }), fast).readStatus();
    assert.equal(status.pollingRateHz, 0);
  });

  for (const status of [1, 2]) {
    test(`retries after a status-${status} reply`, async () => {
      let calls = 0;
      const device = fakeDevice(0xff02, (frame, d) => {
        calls += 1;
        if (calls === 1) { const echo = frame.slice(); echo[1] = status; d.push(echo); } else d.push(IDENTIFY_REPLY);
      });
      const client = new AulaSc580HidClient(device, fast) as unknown as Exchanger;
      assert.equal((await client.exchange(0x30, [])).length, 11);
      assert.equal(device.sent.length, 2);
    });
  }

  test("throws on any other status", async () => {
    const device = fakeDevice(0xff02, (frame, d) => { const echo = frame.slice(); echo[1] = 3; d.push(echo); });
    const client = new AulaSc580HidClient(device, fast) as unknown as Exchanger;
    await assert.rejects(client.exchange(0x30, []), /status 0x3/);
  });

  test("times out repeatedly and throws the wake message", async () => {
    const device = fakeDevice();
    await assert.rejects(new AulaSc580HidClient(device, { ...fast, retries: 2 }).readStatus(), /Move the mouse to wake it/);
    assert.equal(device.sent.length, 3);
  });

  test("ignores a matching command on another report ID", async () => {
    const device = fakeDevice(0xff02, (_frame, d) => { d.push(IDENTIFY_REPLY, 7); d.push(IDENTIFY_REPLY); });
    const client = new AulaSc580HidClient(device, fast) as unknown as { exchange(c: number, d: number[]): Promise<Uint8Array> };
    assert.equal((await client.exchange(0x30, [])).length, 11);
    const silent = fakeDevice(0xff02, (_frame, d) => d.push(IDENTIFY_REPLY, 7));
    await assert.rejects(new AulaSc580HidClient(silent, { ...fast, retries: 1 }).readStatus(), /wake/);
  });

  test("ignores unsolicited 0xd1 events", async () => {
    const device = fakeDevice(0xff02, (_frame, d) => { d.push(pad("d1 00 01 00")); d.push(IDENTIFY_REPLY); });
    const client = new AulaSc580HidClient(device, fast) as unknown as Exchanger;
    assert.equal((await client.exchange(0x30, [])).length, 11);
  });

  test("setDpiStageValue writes the expected frame and confirms by re-reading", async () => {
    const stages = [800, 1900, 2400, 3200, 6400, 9000];
    const device = mouse(stages);
    const confirmed = await new AulaSc580HidClient(device, fast).setDpiStageValue(5, 12000);
    assert.equal(confirmed, 12000);
    assert.deepEqual(device.sent.map((frame) => frame[0]), [0x13, 0x03, 0x13]);
    assert.deepEqual(device.sent[1], WRITE_FRAME);
  });

  test("rejects off-grid DPI and bad stages before touching the device", async () => {
    const device = mouse();
    const client = new AulaSc580HidClient(device, fast);
    await assert.rejects(client.setDpiStageValue(0, 10050), /not supported/);
    await assert.rejects(client.setDpiStageValue(6, 800), /stage/);
    await assert.rejects(client.setDpiStageValue(-1, 800), /stage/);
    assert.equal(device.sent.length, 0);
  });

  test("exposes the DPI grid and polling rates", () => {
    const client = new AulaSc580HidClient(fakeDevice(), fast);
    assert.equal(client.getDpiOptions().length, 220);
    assert.deepEqual(client.supportedPollingRates, [125, 250, 500, 1000]);
  });
});

describe("aula registry wiring", () => {
  test("createSupportedClient picks the client and the brand is AULA", () => {
    const client = createSupportedClient(fakeDevice(0xff02));
    assert.ok(client instanceof AulaSc580HidClient);
    assert.equal(deviceBrand(client), "AULA");
  });

  test("only the 0xff02 collection scores, and the cable outranks the receiver", () => {
    const receiver = fakeDevice(0xff02);
    const cable = Object.assign(fakeDevice(0xff02), { vendorId: 0x088d, productId: 0x062e });
    assert.equal(clientSupportScore(fakeDevice(0xff01)), 0);
    assert.ok(clientSupportScore(receiver) > 0);
    assert.ok(clientSupportScore(cable) > clientSupportScore(receiver));
  });
});
