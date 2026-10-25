# Pico firmware

One image for the Pico 2 W:

- 8 × HORI Pokkén HID pads (VID `0x0F0D` / PID `0x0092`).
- UART1 on GP4/GP5, 921600 8N1, 84-byte frames.
- Wi-Fi STA control over UDP with HMAC-SHA256, or a provisioning SoftAP when no
  network is saved.
- USB CDC interface for setup, pairing and status. The eight HID interfaces
  remain first so the Switch sees the pads.
- BLE sleep-wake advertising (`wake_ble.c`), started lazily after the Wi-Fi STA
  link is up; it is off in provisioning AP mode.

The same frame format (`packet.h` / `apps/node/src/utils/packet.ts`) is used by
UART and Wi-Fi. Wi-Fi adds an authenticated outer header; the inner 84-byte
frame and the HID report are unchanged.

## Flash

Hold **BOOTSEL**, plug the Pico into the PC, and copy the UF2 to the `RP2350`
drive. For `pico2_w` the build also produces
`firmware/build/s2pipe-pico2w-wifi.uf2`.

After the first flash, the CDC port accepts:

```text
S2PIPE-BOOT
```

to reboot into BOOTSEL without unplugging.

## Pins / USB

| Pico     | Goes to                      |
| -------- | ---------------------------- |
| USB      | Switch dock (USB-A/USB-C)    |
| GP4 (TX) | UART adapter RX (optional)   |
| GP5 (RX) | UART adapter TX (optional)   |
| GND      | Adapter GND (optional)       |

No VCC on the UART header. UART1 is **921600 8N1**. A CP2102 is optional; the
Wi-Fi build does not need it.

The USB configuration contains:

| Interface | Function |
| --- | --- |
| 0-7 | HORI Pokkén HID IN+OUT pairs, 1 ms polling |
| 8-9 | CDC (setup/status; 115200, DTR required for the firmware to write) |

A 64-character serial-number string is taken from the board's unique ID.

## First boot / Wi-Fi setup

With no saved network the firmware starts:

- SoftAP `S2PIPE-<last 8 hex of board id>`, WPA2-PSK, random 12-character
  password.
- HTTP provisioning at `http://192.168.4.1/`.
- A CDC line every second:

```text
S2PIPE-SETUP {"id":"...","ssid":"S2PIPE-...","pass":"...","psk":"...","fw":"wifi-1.0.0","mode":"ap"}
```

`psk` is the 32-byte pairing key (64 hex). The launcher's **Pair from USB**
reads it. The setup page asks only for the home 2.4 GHz SSID/password; it never
prints that password.

Hold **BOOTSEL for 5 seconds while powered** to clear the network and
regenerate the setup password and pairing key. Do not hold it at power-on
unless you want the bootloader.

## Wi-Fi control

In STA mode the Pico:

- Connects asynchronously, retries every 5 s, and does not block USB HID.
- Uses WPA2, then mixed WPA2/WPA3, then WPA3 as fallbacks.
- Disables Wi-Fi power save (`CYW43_NONE_PM`) for control latency.
- Listens on UDP **30100** for authenticated HELLO/CONTROL/PING/TEST packets.
- Announces on UDP **30101** every 2 s and answers `{"s2pipe":1,"type":"discover"}`
  probes with name, IP, port, firmware, RSSI, session and boot ID.
- Applies a valid control frame immediately; out-of-order frames are counted but
  their older state is not applied.
- Neutralizes all pads after **250 ms** without a valid authenticated frame.

Outer header (little-endian):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 4 | magic `S2W1` (`0x31573253`) |
| 4 | 1 | version 1 |
| 5 | 1 | type (HELLO, HELLO_ACK, CONTROL, PING, PONG, TEST) |
| 6 | 2 | flags/reserved |
| 8 | 4 | session |
| 12 | 4 | sequence |
| 16 | 4 | sender milliseconds (low 32 bits) |
| 20 | 2 | payload length |
| 22 | 2 | reserved |
| 24 | 16 | HMAC-SHA256(prefix 24 bytes + payload), truncated |
| 40 | N | payload (84-byte inner frame for CONTROL) |

HELLO carries a 4-byte nonce and generates a new session. The PC verifies the
HMAC and nonce on HELLO_ACK. CONTROL requires the current session and passes
through a 64-bit sequence window. Discovery announcements are unauthenticated
and never change pad state.

The Pico's flash config is stored in the last two 4 KB sectors (double-buffered,
magic/version/sequence/CRC32). Only provisioning/reset writes it.

## Build

```sh
export PICO_SDK_PATH=/path/to/pico-sdk
cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
cmake --build firmware/build -j
```

Tested with Pico SDK 2.3.1 and Arm GNU Toolchain 15.2.rel1. The CMake project
uses a minimal `s2pipe_mbedtls_config.h` (HMAC-SHA256 only). `lwipopts.h`
enables DHCP, UDP, TCP, broadcast and a small HTTP server. `dhcpserver.c` is the
MIT-licensed MicroPython/Pico example DHCP server used only in AP mode.

Non-W boards still build the UART firmware; Wi-Fi sources are compiled only
when `PICO_CYW43_SUPPORTED`.

## Sleep wake

`wake_ble.c` is unchanged in protocol: the wake addresses and PID travel in the
inner frame. The Wi-Fi transport forwards them to `wake_ble_request` exactly
like the UART path. BLE starts after the STA link is up to avoid interfering
with Wi-Fi association; the SoftAP/provisioning mode does not start BLE.

Wi-Fi + BLE radio coexistence is still a hardware-validation item. If it is
unstable, Wi-Fi control remains functional and the fallback is a separate
wake-only image or the console's own controller. See
`docs/wifi-controller.md` and the test report.
