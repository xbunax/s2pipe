# s2pipe Wi-Fi controller (Pico 2 W)

This build removes the CP2102 UART adapter from the controller path. The Pico
2 W joins the 2.4 GHz home Wi-Fi and receives the same 84-byte controller
frames over UDP, authenticated with a pairing key. The video path is unchanged:
Switch 2 → HDMI capture → PC → WebRTC → iPhone/iPad.

```
iPhone / iPad
    │ WebRTC + WebSocket
    ▼
Windows PC (s2pipe)
    │ UDP 30100 (HMAC-SHA256)   UDP 30101 (discovery)
    ▼
Pico 2 W (2.4 GHz Wi-Fi)
    │ USB HID (8 × HORI Pokkén)
    ▼
Nintendo Switch 2
```

The firmware still accepts UART1 on GP4/GP5 at 921600 8N1. One image supports
both transports; the PC chooses serial or Wi-Fi in the launcher.

For the physical gamepad rebinding UI and the phone touch controller, see
[controllers.md](controllers.md).

## 1. Hardware

- Nintendo Switch 2, unmodified.
- Raspberry Pi Pico 2 W (RP2350 + CYW43439), board `pico2_w`.
- A 2.4 GHz Wi-Fi network. The CYW43439 has no 5 GHz radio.
- Windows 11 PC with the s2pipe launcher.
- HDMI capture card as before.
- **No CP2102, no TX/RX jumper wires, no extra power supply.**

The Pico is powered from the Switch dock USB. It enumerates as eight HORI HID
interfaces plus one CDC interface used for setup and pairing.

## 2. Flash the firmware

1. Download or build `s2pipe-pico2w-wifi.uf2`.
2. Hold **BOOTSEL**, plug the Pico into the PC, and release when an `RP2350`
   drive appears.
3. Copy the UF2 to that drive. The Pico reboots automatically.
4. Unplug it from the PC and plug it into the Switch 2 dock **after** Wi-Fi
   setup.

To build locally (Pico SDK 2.3.1 and Arm GNU Toolchain 15.2 were used here):

```sh
cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
cmake --build firmware/build -j
```

The SDK path must be set (`PICO_SDK_PATH`) and `arm-none-eabi-gcc` must be in
`PATH`. The output is `firmware/build/s2pipe_pico.uf2`; a copy named
`s2pipe-pico2w-wifi.uf2` is produced for `pico2_w`.

Firmware updates can also be triggered over the CDC port without unplugging:

```text
S2PIPE-BOOT
```

The Pico then reboots into BOOTSEL and mounts the `RP2350` drive.

## 3. First-time Wi-Fi setup

On first boot, or after a network reset, the Pico starts a protected setup
hotspot:

- SSID: `S2PIPE-xxxxxxxx` (the last 8 hex digits of the board ID)
- Security: WPA2-PSK
- Password: random 12 characters, printed on the USB CDC line
- Pairing key: random 32 bytes, printed on the same line

The launcher reads both over USB:

1. Connect the Pico to the PC with a **data** USB cable.
2. Open the launcher, choose **Pico → Wi-Fi → Pair from USB**.
3. The launcher shows the setup hotspot SSID and password, and stores the
   pairing key in `~/.s2pipe/config.json`.
4. On the phone, join the setup hotspot and open **http://192.168.4.1**.
5. Enter the home **2.4 GHz** SSID and password. Save.
6. The Pico reboots, joins the home Wi-Fi, and starts announcing itself.

The setup page does not log or display the home Wi-Fi password. The password is
stored only in the Pico's flash config record.

### Configure Wi-Fi from the launcher (no phone)

The launcher can also send the 2.4 GHz credentials over the Pico's USB CDC
port:

1. Connect the Pico to the PC with a data USB cable.
2. In the launcher choose **Pico → Wi-Fi → Configure Wi-Fi via USB**.
3. Enter the 2.4 GHz SSID (for example `Example_2.4G`) and password.
4. Click **Save Wi-Fi to Pico**.

The launcher sends an URL-encoded `S2PIPE-PROV` command over USB and waits for
`S2PIPE-PROV-OK`. The Pico writes the config, reboots, and joins the network.
The password is sent only over USB and is **not** stored by the launcher. The
phone setup page remains available as a fallback.

If the launcher is not available, any serial terminal at 115200 8N1 can read
the CDC line. It looks like:

```text
S2PIPE-SETUP {"id":"...","ssid":"S2PIPE-...","pass":"...","psk":"...","fw":"wifi-1.0.0","mode":"ap"}
```

The pairing key is the `psk` value (64 hex characters). The setup hotspot
password is `pass`.

### Reset Wi-Fi / re-pair

Hold **BOOTSEL for 5 seconds while the Pico is powered** (do not hold it at
power-on; that enters the bootloader). The firmware clears the Wi-Fi SSID,
password and pairing key, generates new setup credentials, and reboots into the
setup hotspot. Hold for a few seconds longer and the reset is followed by the
bootrom BOOTSEL check, which is useful for re-flashing.

## 4. Discover and connect from Windows

1. Start the launcher. Under **Pico**, select **Wi-Fi**.
2. Click **Scan Wi-Fi**. The launcher listens on UDP 30101 for broadcasts and
   probes `255.255.255.255`. Devices show name, IP, RSSI and firmware.
3. Select the Pico. If Scan is blocked by the firewall or AP isolation, type
   the IP manually (port `30100`).
4. Click **Test controller**. This performs an authenticated HELLO + PING,
   measures the real RTT, reports the Pico's RSSI, and pulses **A** on pad 1.
5. Click **Start s2pipe**. The Node process opens a UDP socket to the Pico and
   sends the same 8 ms controller frames as the serial transport.

Once running, the browser client shows `Pico Wi-Fi ready` and the status tooltip
contains the live RTT, RSSI, accepted packets, duplicates and authentication
failures. The Node reconnects every 5 seconds if the Pico disappears and
re-establishes a new authenticated session.

The Pico sends an announcement every 2 seconds. The Node can use these
announcements to follow a changed DHCP address when a device ID is configured.
A DHCP reservation is still recommended.

## 5. iPhone / iPad remote play

The iPhone/iPad flow is unchanged:

1. Start s2pipe on the PC with the Wi-Fi controller selected.
2. Open the client URL on the iPhone/iPad (LAN address, or the configured
   public/remote address).
3. Take a gamepad seat and play.

Only the client/node video path needs to be reachable from the iPhone/iPad.
The Pico control port is a LAN-only UDP port; **do not expose UDP 30100/30101
to the internet**.

Remote play requires the PC and the Pico to remain on the same LAN. The
iPhone/iPad can be anywhere the browser client can reach the node.

## 6. Security and protocol

- Pairing key: 32 random bytes generated on the Pico. The PC receives it over
  USB or from the setup page. It is stored in `config.json` (protect that file;
  it is equivalent to a controller credential).
- Every control, HELLO, PING and TEST datagram is authenticated with
  HMAC-SHA256, truncated to 16 bytes. A wrong key or a modified byte is
  rejected before any pad state is applied.
- The Pico issues a new random session ID on every HELLO. Control packets with
  the wrong session are rejected. A reconnect starts a new session.
- Every control packet carries a 32-bit sequence. The receiver keeps a 64-bit
  sliding window: duplicates and packets older than the window are counted and
  dropped; out-of-order packets are counted and the older state is **not**
  applied.
- The discovery announcements are unauthenticated (name/IP/RSSI only). They
  cannot change pad state; control traffic is always HMAC-authenticated.
- The setup hotspot uses WPA2-PSK. The control plane is intended for a trusted
  LAN only.
- The Pico's flash config record is double-buffered in the last two 4 KB
  sectors, with a magic value, version, sequence and CRC32. It is written only
  when provisioning or resetting, never per frame.

## 7. Failsafe

If no valid authenticated control packet arrives for **250 ms**, the Pico
releases all buttons, centers both sticks on all eight pads, and waits for the
next valid input. This is the same stale-input rule as the UART firmware and is
driven by the main loop, not by the network stack.

If the PC disappears or the Wi-Fi drops, the Switch therefore cannot keep a
stuck button or stick.

## 8. UART compatibility

The UART path is preserved:

| Pico     | Goes to                      |
| -------- | ---------------------------- |
| GP4 (TX) | UART adapter RX              |
| GP5 (RX) | UART adapter TX              |
| GND      | Adapter GND                  |

UART1, 921600 8N1. No VCC. In the launcher choose **Pico → USB Serial**, pick
the CP2102 port, and start s2pipe exactly as before. The same firmware accepts
both UART and Wi-Fi frames; the PC uses one transport at a time.

Backward-compatibility note: this firmware exposes a CDC interface in addition
to the eight HID pads. The Windows HID enumeration is verified. Switch 2
compatibility with the extra CDC interface is part of the pending hardware
test; if the console rejects the composite device, use the UART firmware until
a HID-only normal-mode descriptor is added.

## 9. BLE sleep wake

`firmware/wake_ble.c` is retained. A wake request travels inside the same
84-byte frame, so it works over UART and Wi-Fi. The Wi-Fi firmware starts the
BLE stack **after the STA link is up**, not during provisioning or while the
Wi-Fi connection is being established. This avoids the CYW43439 dropping the
SoftAP/link when BT powers on at the same time.

Known limitation: Wi-Fi STA + BLE advertising coexistence on the CYW43439 has
not yet been validated on hardware in this build. If BLE wake proves unstable
alongside Wi-Fi, the fallback is to keep Wi-Fi control and use a separate
wake-only firmware image, or wake the console with its own controller. The
Wi-Fi control path does not depend on BLE.

## 10. Troubleshooting

| Symptom | Check |
| --- | --- |
| No `S2PIPE-...` setup hotspot | Read the CDC line (`S2PIPE-SETUP`). If it says `mode=ap`, wait a few seconds. If nothing appears, the firmware may not be running; re-flash. |
| Setup page does not open | Use **Configure Wi-Fi via USB** in the launcher instead. The phone AP has no internet; turn off cellular data if you keep using the page. |
| Pico does not join home Wi-Fi | The CYW43439 is 2.4 GHz only. Check the SSID/password, WPA2/WPA3 mixed mode, and whether the router hides the 2.4 GHz SSID. Hold BOOTSEL 5 s to retry setup. |
| Scan finds no Pico | Allow the launcher and `deno` through Windows Firewall for UDP 30101, disable AP/client isolation, or type the IP manually. The PC may be on 5 GHz while the Pico is on 2.4 GHz; both must be bridged on the same LAN. |
| Test controller fails | Verify the IP, port 30100, and the 64-hex pairing key. The key is regenerated by a Wi-Fi reset, so re-pair after resetting. |
| Pico ready but Switch does nothing | Plug the Pico into the Switch dock, not the PC. Confirm the Switch sees the HORI pads (Windows should show eight `HID-compliant game controller` entries plus COM). Check the USB cable is data-capable. |
| Buttons stick | The 250 ms failsafe should release them. If not, check that control packets are reaching the Pico (Pico `rx` counter in the client tooltip) and that the PC has not hung. |
| High latency / jitter | 2.4 GHz is shared. Use a clear channel, keep the Pico away from USB 3 devices, and keep the PC on the same LAN. Power save is disabled in firmware (`CYW43_NONE_PM`). |
| Windows firewall prompts | Allow private networks for the launcher and Deno. UDP 30101 is discovery; UDP 30100 is control. |

## 11. Ports and files

| Port | Transport | Purpose |
| --- | --- | --- |
| 30100 | UDP | Authenticated controller frames, HELLO, PING, TEST |
| 30101 | UDP | Unauthenticated discovery announces/probes |
| 80 | TCP (setup AP only) | Provisioning page at `192.168.4.1` |

| File | Purpose |
| --- | --- |
| `firmware/wifi_config.c` | Flash config, device ID, PSK, setup credentials |
| `firmware/wifi_transport.c` | STA/AP state machine, UDP control, discovery, HMAC/session/sequence |
| `firmware/provisioning.c` | Setup HTTP server and USB CDC setup/status lines |
| `firmware/dhcpserver.c` | MIT-licensed DHCP server for the setup AP |
| `apps/node/src/utils/wifi_protocol.ts` | Node packet/HMAC/session helpers |
| `apps/node/src/services/transport.ts` | Serial and Wi-Fi transports |
| `apps/node/src/testing/fake_pico.ts` | Software Pico for tests and protocol work |
| `launcher/src-tauri/crates/core/src/modules/wifi.rs` | Discovery, USB pairing, authenticated test |

## 12. Developer quick start

Node without the launcher:

```sh
PICO_TRANSPORT=wifi \
PICO_WIFI_HOST=192.168.1.120 \
PICO_WIFI_KEY=<64 hex characters> \
deno run -A apps/node/src/index.ts
```

Fake Pico (no hardware):

```sh
deno run -A apps/node/src/testing/fake_pico.ts --key 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

Point the Node or launcher at `127.0.0.1:30100` with the same key. This
exercises HELLO, HMAC, sequence handling, the 250 ms failsafe and all eight
pads. It does not emulate USB HID or Wi-Fi radio timing.

Launcher build:

```sh
cd launcher
deno task tauri build --no-bundle
```

The executable is `launcher/src-tauri/target/release/s2pipe-gui.exe`.

Do **not** use a plain `cargo build --release` for the GUI: that produces a
dev-mode Tauri webview which tries to load `http://localhost:1420` and shows
"localhost refused to connect" unless the Vite dev server is running. The
Tauri CLI embeds the built `dist` assets into the executable.
