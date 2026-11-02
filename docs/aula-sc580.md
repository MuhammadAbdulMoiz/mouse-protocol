# AULA SC580

Driver: `src/drivers/aula/hid.ts` (`AulaSc580HidClient`), codec: `src/aula/index.ts`
(exported as `aula`). Frames: `captures/aula-sc580/frames.json`.

## Devices and interfaces

| Path | VID:PID | Catalog `verified` |
| --- | --- | --- |
| 2.4 GHz receiver | `0x089D:0x062F` | true |
| USB cable (mouse itself) | `0x088D:0x062E` | true |

The settings channel is the HID collection on usage page `0xFF02` (usage `0x0000`), report ID 0,
32-byte payload (`sendReport(0, 32 bytes)`, replies arrive as `inputreport` with report ID 0 and 32
bytes). Browsers hide this interface, so it is reachable only through OpenMouse Bridge. The driver
matches only the `0xFF02` collection, so sibling collections of the same device score 0.

## Frame

`[0]=cmd, [1]=status, [2]=0x01, [3]=len, [4..4+len-1]=data, zero pad, [31]=checksum`, where the
checksum is `sum(data) & 0xff`. Requests carry status 0. Replies carry 0 (ok), 1 (busy) or 2
(rejected because the mouse is asleep; the receiver echoes the request frame, so its checksum is not
checked). Maximum data length is 27. Unsolicited `0xd1` link events also arrive on the channel and
are ignored.

## Commands

| Cmd | Meaning | Data |
| --- | --- | --- |
| `0x30` | Identify | Starts "M137". `data[8]` is 1 on the cable (charging), 0 on battery. `data[9]` is the battery percent on battery only; on the cable it is a fixed 100, so the driver reports no percent and state "Charging". |
| `0x13` | Read DPI table | len `0x19`: header byte, then 6 x (raw, 0, 0, 0). |
| `0x03` | Write DPI table | len `0x1b`: `0x00` offset, the header as read, 6 x 4 bytes, `0x00`. |
| `0x12` | Read polling rate | One byte, a single bit per rate: `0x01` 125, `0x02` 250, `0x04` 500, `0x08` 1000 Hz. Any other byte reads as "unknown" (0). |
| `0x02` | Write polling rate | Same byte. |

DPI raw byte: up to 200 it is `raw * 50`; above 200 it is `10000 + (raw - 200) * 100`, so 12000 is
raw 220 (`0xdc`). The grid is 50..10000 in steps of 50 and 10100..12000 in steps of 100.

## Evidence

- Request frames were decoded from the vendor CBMouse app's `WriteFile` calls, captured with a
  debugger.
- Replies come from passive, read-only HID listening alongside the vendor app.
- Polling and DPI values were cross-checked against the vendor app's UI (for example raw `0xdc`
  displayed as 12000 DPI).

## Verified on hardware

On both the receiver and the cable: identify, DPI table read, DPI table write with read-back,
polling read and write, battery on battery power, and the charging flag on the cable. Status 1 and 2
replies were seen and succeed on retry; the driver retries up to 10 times (400 ms apart) and then
reports that the mouse needs to be moved to wake it.

## Driver behaviour

- `MouseStatus.dpi` is 0 (unknown): the active stage is not readable. There is no `setDpi`,
  `activeDpiStage` or `setActiveDpiStage`.
- `setDpiStageValue(stage, dpi)` (0-based) reads the table, changes one stage, writes the whole table
  with the header byte preserved, and re-reads to confirm. `setPollingRate(rate)` also reads back.
- DPI values are written to the mouse; whether they persist across power cycles was not tested.
- `connectionType` is "Wired" for the cable and "Wireless" for the receiver.

## Unknown

- The active DPI stage is not readable. Command `0x11` returns a 6 x 3-byte button map; it is
  deliberately not implemented.
- Lighting, sleep time and debounce are not decoded.
- The meaning of the DPI header byte (`0x16` on the tested unit) is unknown; it is preserved on write.
- Firmware version and lift-off distance are not read.
