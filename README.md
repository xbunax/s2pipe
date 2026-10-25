<h1 align="center">
	s2pipe
</h1>

<p align="center">
	<strong>Self-hosted Switch 2 cloud play</strong><br>
	Stream the dock over WebRTC and play from any browser on the LAN, up to eight pads through a Pico.
</p>

<p align="center">
	<a href="https://github.com/8borane8/s2pipe/releases"><img src="https://img.shields.io/github/v/release/8borane8/s2pipe?color=3ee6a0&labelColor=07080a" alt="Release"></a>
	<a href="LICENCE"><img src="https://img.shields.io/badge/license-MIT-3ee6a0?labelColor=07080a" alt="MIT"></a>
	<img src="https://img.shields.io/badge/Windows%20%7C%20Linux-3ee6a0?labelColor=07080a&label=platform" alt="Windows and Linux">
	<br>
	<a href="https://github.com/8borane8/s2pipe/stargazers"><img src="https://img.shields.io/github/stars/8borane8/s2pipe?color=3ee6a0&labelColor=07080a" alt="Stars"></a>
	<a href="https://github.com/8borane8/s2pipe/forks"><img src="https://img.shields.io/github/forks/8borane8/s2pipe?color=3ee6a0&labelColor=07080a" alt="Forks"></a>
</p>

<p align="center">
	<img src="assets/result.png" alt="s2pipe in the browser" width="920">
</p>

The console stays on the capture PC. Browsers see the picture over WebRTC. One browser can drive several gamepads at
once. Inputs go to a Raspberry Pico that shows up on the Switch as 8 USB pads.

The **s2pipe launcher** (Windows and Linux) downloads FFmpeg and MediaMTX, starts Node and the browser UI, and talks to
the Pico. **No auth.** Trusted LAN only. Do not expose this on the Internet.

The Pico 2 W can receive controller frames over **USB Serial (UART)** or **Wi-Fi UDP**. Wi-Fi mode removes the CP2102
adapter and jumper wires; one data USB cable from the Pico to the Switch dock is enough. See
[docs/wifi-controller.md](docs/wifi-controller.md).

```
Switch 2 --HDMI--> capture --USB--> launcher (FFmpeg + MediaMTX + node + client)
                                         |-- ICE --> browsers
Browsers --WHEP + WebSocket--> node --UART or Wi-Fi UDP--> Pico --USB--> Switch 2
```

| Piece        | Path          | Role                                     |
| ------------ | ------------- | ---------------------------------------- |
| **Launcher** | `launcher`    | GUI / CLI: configure and run the stack   |
| **Node**     | `apps/node`   | HTTP, WebSocket, Pico serial, WHEP proxy |
| **Client**   | `apps/client` | Browser UI                               |
| **Firmware** | `firmware`    | Pico: UART in, 8 USB pads out            |

## 1. Tested hardware

Equivalents are fine.

- [Raspberry Pico 2 W](https://amzn.eu/d/09YZSwVw), board `pico2_w`
- **Wi-Fi mode:** 2.4 GHz Wi-Fi only, no CP2102 or jumper wires. **UART mode (optional):** [CP2102 UART adapter
  HW-598](https://amzn.eu/d/0catDsov), jumper **3.3 V**, **no VCC** on the Pico (TX / RX / GND only).
- [XIIXMASK HDMI USB 3.0 capture](https://amzn.eu/d/09Xc9GcE), UVC webcam, HDMI in + loop
- Switch 2 + dock, a Windows or Linux PC

## 2. Install the launcher

Download the Windows or Linux build (x86_64 or aarch64) from [Releases](https://github.com/8borane8/s2pipe/releases). Run it. First start
fetches FFmpeg, MediaMTX, and Deno into `~/.s2pipe/bins/`.

On **Windows**, install the CP2102 UART driver first or the Pico port never appears:
[Silicon Labs VCP drivers](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

## 3. Flash the Pico

1. Download `s2pipe-pico-<version>.uf2` or `s2pipe-pico2w-wifi.uf2` from
   [Releases](https://github.com/8borane8/s2pipe/releases) (no SDK needed).
2. Hold **BOOTSEL**, plug the Pico into the PC, drop the `.uf2`.
3. For Wi-Fi: pair and configure the 2.4 GHz network (launcher **Pair from USB**), then unplug and connect the Pico
   USB to the Switch dock. For UART: also wire GP4/GP5/GND to the CP2102.

Local build: [firmware/README.md](firmware/README.md). Wi-Fi guide:
[docs/wifi-controller.md](docs/wifi-controller.md).

## 4. Wiring

One native USB: flash from the PC, then plug into the dock. The same USB port cannot be a COM port and the pads at the
same time.

**Wi-Fi (no extra hardware):**

```
Node --UDP 30100--> Pico 2 W --USB--> Switch dock
```

**UART (optional, still supported):**

```
Node --UART 921600--> Pico GP5 RX / GP4 TX
Switch dock USB  --> Pico USB
```

| Pico     | Goes to                            |
| -------- | ---------------------------------- |
| USB      | Switch 2 dock (USB-A or USB-C OTG) |
| GP4 (TX) | UART adapter **RX** (optional)     |
| GP5 (RX) | UART adapter **TX** (optional)     |
| GND      | GND (optional)                     |

Power from Switch USB. **Leave adapter VCC disconnected** (5 V on a GPIO kills the Pico). CP2102 jumper on **3.3 V**.
UART **921600 8N1**.

## 5. Run

Open the launcher.

1. Pick the HDMI capture card, or **Test** (color bars, no hardware).
2. Pick HDMI audio if you want sound.
3. Pick the Pico transport: **USB Serial** and a COM port, or **Wi-Fi**. In Wi-Fi mode, use **Configure Wi-Fi via USB**
   to send the 2.4 GHz SSID/password to the Pico from the launcher (no phone needed), then Scan/Test. Leave serial
   **None** for video only.
4. **This PC only** or **LAN** (set this PC's address so other devices can reach it).
5. Click **Start s2pipe**.

Open [http://localhost:5000](http://localhost:5000). On another LAN device, use the node address you set.

Optional: **Launch at startup** starts s2pipe in the background (no window): at machine boot on Linux, on login on Windows. Closing the launcher does not stop
the stack; use Stop or `s2pipe stop`.

No window: use the **CLI**. Flags overlay `~/.s2pipe/config.json` for that run (defaults if there is no saved file).

```sh
s2pipe start
s2pipe start --capture-source test --pico-serial COM3
s2pipe stop
s2pipe start --help
```

## 6. Play

Click a gamepad at the bottom to take a Pico seat (max 8 in total, several per browser). Click again to release it. Esc
= settings. The HUD stays on until fullscreen.

No gamepad: **Use virtual controller** (keyboard and mouse). Presets: Standard (3D, FPS), Racing (Mario Kart), Keyboard (2D, fighting, retro). Press **Tab** (or the keyboard button in the HUD) to open the mapping window over the stream: switch preset, rebind keys, create profiles. Tab or Esc closes it. System buttons are the same in every preset: Plus on Enter, Minus on `*`, Home on H, Capture on P. Double click does not toggle fullscreen while it is on.

**Physical gamepad mapping:** take a seat, then click the Gamepad2 icon (or **Settings → Controller mapping**) to rebind any Switch button, clear a binding, reset to the physical layout, swap or invert sticks, or change the deadzone. The default follows physical positions: Xbox A (bottom) sends Switch B, Xbox B (right) sends Switch A, and so on. The mapping is stored in this browser and applies to every standard gamepad. On iPhone/iPad the first connected gamepad claims one seat automatically; elsewhere click the pad chip in the HUD.

**Touch controller:** click the phone icon in the HUD (or **Use touch controller**) to show two sticks, D-pad, A/B/X/Y, L/R/ZL/ZR and the system buttons over the stream. It takes one Pico seat and pauses the keyboard virtual controller and physical gamepads. Open **Settings → Touch controller** for the size slider, or click the Move icon in the HUD for **Edit layout**: drag every control, use Mirror/Reset/Done, and the landscape and portrait layouts are saved separately in this browser. On iPhone Safari, native video fullscreen pauses web controller input, so the fullscreen button stays on the page while a controller is in use. For fullscreen play with a Backbone or touch controller, use Safari **Share → Add to Home Screen** and launch s2pipe from the Home Screen.

**Hide UI:** the eye icon in the HUD hides the HUD, touch pad, stats and toasts. Tap the stream or press Esc to bring them back. Physical gamepad and keyboard input continue while the UI is hidden.

`n/8 playing` is Pico seats taken, not Switch player numbers. Pills: capture, Pico, WebSocket.

Home is Xbox Guide / PS. Turn off Windows Game Bar's controller shortcut (Settings, Gaming, Xbox Game Bar) and Steam's
"Guide button focuses Steam". Last resort: hold Minus and Plus together (View + Menu).

See [docs/controllers.md](docs/controllers.md) for the complete mapping table, touch layout details and troubleshooting.

After updating s2pipe, **reflash the Pico**: the node and the firmware must agree on the same packet format.

## 7. Sleep wake

The Pico 2 W can pull the Switch 2 out of **sleep** (not a full power-off) while a browser is on the play page. Switch 1
Joy-Con / Pro Controller cannot wake a Switch 2. You need a **Joy-Con 2 / Pro 2 / NSO GameCube** already paired with
that console. The console does **not** show its BT MAC in settings; the pad broadcasts it.

1. Pair the pad with the Switch 2 once (normal Nintendo pairing).
2. Put the Switch to **Sleep**. Detach the Joy-Con, or press a button on the Pro 2.
3. In the launcher, click **Listen for controller**.
4. Flash a **`pico2_w`** build. Open the play page (Watch is enough).

If the scan finds no Switch MAC, the pad was not advertising the console address. Sleep the Switch, detach the pad,
stand closer, retry.

The Pico LED stays on, and goes dark for a second each time a wake advert fires.

## Ports

| Port     | What                                |
| -------- | ----------------------------------- |
| 5000     | Client                              |
| 5050     | Node: health, WebSocket, WHEP proxy |
| 8189 UDP | WebRTC ICE / RTP                    |
| 8189 TCP | WebRTC over TCP (for Wi-Fi that blocks UDP) |
| 30100 UDP | Wi-Fi controller: authenticated HELLO/CONTROL/PING/TEST (LAN only) |
| 30101 UDP | Wi-Fi controller: discovery announces/probes (LAN only) |
| 80 TCP   | Pico setup AP only, `http://192.168.4.1` |

**IPv6:** the page on 5000 and the Node API/WebSocket on 5050 also listen on IPv6. Open
`http://[IPv6-address]:5000`; the page derives the IPv6 Node URL automatically. Pico control and the WebRTC ICE
candidate are still IPv4, so an IPv6-only phone can load/control but cannot receive video yet. Keep IPv6 access on a
trusted LAN, set a Node password and do not forward the ports. See [docs/ipv6.md](docs/ipv6.md).

## Development

Deno workspace: `apps/node`, `apps/client`, `shared`. Firmware is CMake. Launcher is Tauri 2 (`launcher/`).

```sh
deno fmt
deno check apps/node/src/index.ts
deno check apps/client/src/index.ts
deno test -A apps/node/src
```

**Launcher:** `cd launcher && deno task dev` for development. Production GUI:
`cd launcher && deno task tauri build --no-bundle` (plain `cargo build
--release` produces a dev-mode webview that expects `localhost:1420`).

**Node:** `cd apps/node && deno task dev` (5050). `PICO_SERIAL=/dev/ttyUSB0` or `COM3`. Wi-Fi:
`PICO_TRANSPORT=wifi PICO_WIFI_HOST=192.168.1.120 PICO_WIFI_KEY=<64 hex> deno task dev`.

**Firmware:** `cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w` then
`cmake --build firmware/build -j`. A fake Pico for protocol work:
`deno run -A apps/node/src/testing/fake_pico.ts --key <64 hex>`.

**Client:** `cd apps/client && deno task dev` (5000). `NODE_BASE_URL` is the node address. `/password` opens only when the node returns 401.

Firmware and packet: keep `apps/node/src/utils/packet.ts` in sync with `firmware/packet.h`.

## Node API

| Route                     | What                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `GET /health`             | Capture, Pico, `occupied` seats                              |
| `GET /socket`             | WebSocket                                                    |
| `POST /switch/whep`       | Video WHEP; `PATCH` / `DELETE` `/switch/whep/:session`       |
| `POST /switch-lite/whep`  | Lite video WHEP (540p, slow networks); same `PATCH` / `DELETE` |
| `POST /switch-audio/whep` | Audio WHEP; `PATCH` / `DELETE` `/switch-audio/whep/:session` |

- Client: `{ op: "play", data: { count } }` / `{ op: "watch" }` / `{ op: "pad", data: PadState, seat }`
- Server: `{ op: "status", data: { capture, pico, occupied } }` on join and when seats change
- Server: `{ op: "play", data: { seats: number[] } }` after a `play` (empty if none left)

A socket starts with no seat. `play` claims `count` seats on that socket (or fewer if the lobby is full), so clicking a
gamepad sends the new total. `watch` or closing the socket releases every seat held by that browser.

## License

[MIT](LICENCE) Copyright (c) 2026-present, Borane
