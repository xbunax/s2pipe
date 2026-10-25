<h1 align="center">
	s2pipe
</h1>

<p align="center">
	<strong>Self-hosted Switch 2 cloud play</strong><br>
	Stream the dock over WebRTC and play from any browser on the LAN, up to eight pads through a Pico 2 W.
</p>

<p align="center">
	<a href="https://github.com/xbunax/s2pipe"><img src="https://img.shields.io/badge/status-beta-3ee6a0?labelColor=07080a" alt="Beta"></a>
	<a href="LICENCE"><img src="https://img.shields.io/badge/license-MIT-3ee6a0?labelColor=07080a" alt="MIT"></a>
	<img src="https://img.shields.io/badge/Windows%20%7C%20Linux-3ee6a0?labelColor=07080a&label=platform" alt="Windows and Linux">
	<br>
	<a href="https://github.com/xbunax/s2pipe/stargazers"><img src="https://img.shields.io/github/stars/xbunax/s2pipe?color=3ee6a0&labelColor=07080a" alt="Stars"></a>
	<a href="https://github.com/xbunax/s2pipe/forks"><img src="https://img.shields.io/github/forks/xbunax/s2pipe?color=3ee6a0&labelColor=07080a" alt="Forks"></a>
</p>

<p align="center">
	<img src="assets/result.png" alt="s2pipe in the browser" width="920">
</p>

The console stays on the capture PC. Browsers see the picture over WebRTC. One browser can drive several gamepads at
once. Inputs go to a Raspberry Pi Pico 2 W, which shows up on the Switch as eight USB pads. The Pico can use
**USB Serial (UART)** or **Wi-Fi UDP**; one `pico2_w` image supports both. After the one-time USB provisioning,
Wi-Fi mode removes the CP2102 adapter and jumper wires, leaving one data USB cable from the Pico to the Switch dock.
Non-W Pico boards build UART-only firmware.

The **s2pipe launcher** (Windows and Linux) downloads FFmpeg, MediaMTX and Deno, starts Node and the browser UI, reads
and configures the Pico over USB, and discovers/tests it over Wi-Fi. The Node password is optional; with no password
the page and WebSocket are open to the LAN. **Trusted LAN only. Do not expose this on the Internet.**

This fork is maintained at [xbunax/s2pipe](https://github.com/xbunax/s2pipe). It builds on the upstream project by
Borane at [8borane8/s2pipe](https://github.com/8borane8/s2pipe).

## What this fork adds

- **Pico 2 W Wi-Fi control**: authenticated UDP control frames, discovery, 250 ms neutral failsafe, and the
  original UART transport kept as a fallback.
- **First-time provisioning** from a phone SoftAP page at `http://192.168.4.1`, or over USB CDC from the launcher.
  The setup AP is password-protected and the pairing key is generated per Pico.
- **Launcher Wi-Fi tools**: discovery, Pair from USB, Configure Wi-Fi via USB, status, latency/RSSI and Test
  controller. The Node reconnects the Wi-Fi transport automatically.
- **Controller choices**: physical gamepad rebinding, the keyboard/mouse virtual controller, and a phone touch
  controller with a customizable, per-orientation layout.
- **Quality-of-life controls**: Hide-all-UI, seat recovery, iPhone controller auto-claim, and an iPhone fullscreen
  workaround via Add to Home Screen.
- **IPv6 web access** for the page, Node API and WebSocket. Pico control and WebRTC media remain IPv4 for now.

Details: [Wi-Fi controller](docs/wifi-controller.md), [controllers](docs/controllers.md),
[IPv6](docs/ipv6.md), [test report](docs/wifi-controller-test-report.md).

```
Switch 2 --HDMI--> capture --USB--> launcher (FFmpeg + MediaMTX + node + client)
                                         |-- ICE (IPv4) --> browsers
Browsers --WHEP + WebSocket (IPv4/IPv6)--> node --UART or Wi-Fi UDP (IPv4)--> Pico --USB--> Switch 2
```

| Piece        | Path          | Role                                      |
| ------------ | ------------- | ----------------------------------------- |
| **Launcher** | `launcher`    | GUI / CLI: configure and run the stack    |
| **Node**     | `apps/node`   | HTTP, WebSocket, Pico transport, WHEP proxy |
| **Client**   | `apps/client` | Browser UI                                |
| **Firmware** | `firmware`    | Pico: UART/Wi-Fi in, 8 USB pads + CDC out |

## 1. Requirements and tested hardware

Equivalents are fine.

- [Raspberry Pi Pico 2 W](https://amzn.eu/d/09YZSwVw), board `pico2_w`.
- **Wi-Fi mode:** a 2.4 GHz network; no CP2102 or jumper wires. **UART mode (optional):** a
  [CP2102 UART adapter HW-598](https://amzn.eu/d/0catDsov), jumper on **3.3 V**, **no VCC** to the Pico
  (TX / RX / GND only).
- [XIIXMASK HDMI USB 3.0 capture](https://amzn.eu/d/09Xc9GcE), UVC webcam, HDMI in + loop.
- Switch 2 + dock, and a Windows or Linux PC.
- A standard browser gamepad (Xbox, PlayStation, Backbone, etc.), a keyboard and mouse, or a phone/tablet for the
  touch controller.

## 2. Build and install

This fork has **no prebuilt releases yet**, and upstream releases do not include these changes. Build from source:

```sh
git clone https://github.com/xbunax/s2pipe.git
cd s2pipe/launcher
deno task tauri build --no-bundle
```

The launcher needs Rust, Deno and the usual Tauri 2 platform dependencies. The first start downloads FFmpeg, MediaMTX
and Deno into `~/.s2pipe/bins/`.

A CLI-only build is also available:

```sh
cargo build --release -p s2pipe --manifest-path launcher/src-tauri/Cargo.toml
```

On **Windows**, install the CP2102 UART driver only if you use the optional UART path:
[Silicon Labs VCP drivers](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers).

## 3. Flash the Pico

1. Build the firmware:

   ```sh
   cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
   cmake --build firmware/build -j
   ```

2. Hold **BOOTSEL**, plug the Pico into the PC, and copy the UF2 from `firmware/build/` (the Wi-Fi build is
   `s2pipe-pico2w-wifi.uf2`).
3. Provision Wi-Fi (next section), then move the Pico's USB cable to the Switch dock. For UART, also wire GP4/GP5/GND
   to the CP2102.

Firmware details and local build notes: [firmware/README.md](firmware/README.md).

## 4. First-time Wi-Fi setup

The Pico starts a protected setup hotspot when it has no saved network, or after a network reset:

- SSID: `S2PIPE-xxxxxxxx` (last 8 hex digits of the board ID)
- WPA2 password: random 12 characters
- Pairing key: random 32 bytes (64 hex)

Two ways to provision:

**Launcher over USB (recommended on a PC):**

1. Connect the Pico to the PC with a data cable.
2. Open the launcher, choose **Pico → Wi-Fi → Pair from USB** and read the setup details/pairing key.
3. Use **Configure Wi-Fi via USB**, enter the **2.4 GHz** SSID and password, and save.
4. The Pico reboots and joins the network.

**Phone SoftAP:**

1. Connect the Pico to the PC once and use **Pair from USB** to read the setup password and pairing key.
2. On the phone, join `S2PIPE-xxxxxxxx` and open `http://192.168.4.1`.
3. Enter the home **2.4 GHz** SSID and password. Save. The Pico reboots and joins the network.

The setup page and logs do not display the home Wi-Fi password. The launcher does not store it either; it is sent
only over USB. The password is stored only in the Pico's flash config. The pairing key is required by the Node; use
**Pair from USB** or the launcher to store it.

**Pair from USB** only reads setup material while the Pico is in setup AP mode. If it reports `S2PIPE-STATUS`, the
Pico is already configured. To clear the saved network and pairing key, hold **BOOTSEL** for 5 seconds while the Pico
is powered, then re-pair.

The CYW43439 is **2.4 GHz only**, and the PC and Pico must be on the same LAN. Use the main home SSID first; an IoT
SSID with client isolation can block UDP control. Hidden SSIDs and AP isolation also break discovery. Allow UDP
30100/30101 through Windows Firewall, and use a DHCP reservation or the manual IP field if the Pico address changes.
See [docs/wifi-controller.md](docs/wifi-controller.md) for troubleshooting, DHCP/SoftAP details and the security
model.

## 5. Wiring

The Pico's single USB connection is used for flashing/provisioning on the PC, then for the eight HID pads on the
Switch dock. Wi-Fi firmware also exposes a CDC interface for setup/status; the optional controller UART is GP4/GP5
through the CP2102, **not** the Pico's USB CDC port.

**Wi-Fi (no extra hardware):**

```
Node --UDP 30100--> Pico 2 W --USB--> Switch dock
```

**UART (optional, still supported):**

```
Node --UART 921600--> Pico GP5 RX / GP4 TX
Switch dock USB --> Pico USB
```

| Pico     | Goes to                            |
| -------- | ---------------------------------- |
| USB      | Switch 2 dock (USB-A or USB-C OTG) |
| GP4 (TX) | UART adapter **RX** (optional)     |
| GP5 (RX) | UART adapter **TX** (optional)     |
| GND      | GND (optional)                     |

Power comes from the Switch USB. **Leave adapter VCC disconnected** (5 V on a GPIO kills the Pico). CP2102 jumper on
**3.3 V**. UART is **921600 8N1**.

## 6. Run

Open the launcher.

1. Pick the HDMI capture card, or **Test** (color bars, no hardware).
2. Pick HDMI audio if you want sound.
3. Pick the Pico transport: **USB Serial** (the optional CP2102 COM port, not the Pico's CDC port) or **Wi-Fi**.
   In Wi-Fi mode, use **Configure Wi-Fi via USB** or the phone setup page, then **Scan Wi-Fi** and **Test
   controller**. For video only, choose **USB Serial** and set Pico port to **None (video only)**.
4. Choose **This PC only**, **LAN**, or **Accessible from the internet**. The WAN option only fills the public
   address fields; it does not configure NAT or a firewall. LAN is recommended.
5. Optionally set a **Node password**. With a password, the play page and Node routes ask for it; without one, the
   page and WebSocket are open to the LAN.
6. Click **Start s2pipe**.

Open [http://localhost:5000](http://localhost:5000) on the PC. On another LAN device use
`http://<PC-LAN-IP>:5000` — that is the **client** port, not the Node port 5050; the page uses the configured Node
address itself. For IPv6, open `http://[IPv6-address]:5000`; the page derives the Node IPv6 URL automatically. See
[docs/ipv6.md](docs/ipv6.md).

Optional: **Launch at startup** starts s2pipe in the background (no window): at machine boot on Linux, on login on
Windows. Closing the launcher does not stop the stack; use Stop or `s2pipe stop`.

No window: use the **CLI**. Flags overlay `~/.s2pipe/config.json` for that run (defaults if there is no saved file).

```sh
s2pipe start
s2pipe start --capture-source test --pico-serial COM3
s2pipe start --controller-mode wifi --pico-wifi-host 192.168.1.120 --pico-wifi-key <64 hex>
s2pipe start --node-password <secret>
s2pipe stop
s2pipe start --help
```

## 7. Play

Click a gamepad at the bottom to take a Pico seat (max 8 in total, several per browser). Click again to release it.
Esc opens settings. The HUD fades in fullscreen; with touch controls enabled it stays visible.

| Input | How it works |
| --- | --- |
| **Physical gamepad** | Connect a standard gamepad and press a button; turn off the virtual/touch controllers, then click its HUD entry to take a seat. On iPhone/iPad the first gamepad claims one seat automatically. Use the **Gamepad2** button or **Settings → Controller mapping** to rebind buttons, clear bindings, reset, swap/invert sticks, or change the deadzone; the dialog sends neutral input while learning. The default follows physical positions (Xbox A at the bottom sends Switch B). The mapping is stored in this browser and applies to every standard gamepad. |
| **Virtual controller** | **Use virtual controller** for keyboard and mouse. Presets: Standard (3D/FPS), Racing, Keyboard. Press **Tab** (or the keyboard button in the HUD) to rebind keys and create profiles. System keys: Plus = Enter, Minus = the `\` key above Enter (shown as `*` in the UI), Home = H, Capture = P. |
| **Touch controller** | Click the phone icon in the HUD or **Use touch controller**. Two sticks, D-pad, A/B/X/Y, L/R/ZL/ZR and system buttons. It takes one Pico seat and pauses the keyboard virtual controller and physical gamepads. No gyro, rumble, amiibo or NFC. |
| **Touch layout** | Open **Settings → Touch controller** for the size slider, or click **Move** in the HUD to edit the layout. Drag every control, use Mirror/Reset/Done; landscape and portrait layouts are saved separately in this browser. |
| **Hide UI** | The eye icon hides the HUD, touch pad, stats, toasts, settings and mapping dialogs. Tap the stream or press Esc to restore. Physical gamepad and keyboard input continue; touch input stops while the pad is hidden. |

`n/8 playing` is Pico seats taken, not Switch player numbers. Pills show capture, Pico and WebSocket status.

**Home / Capture:** Home is Xbox Guide / PS. Turn off Windows Game Bar's controller shortcut (Settings → Gaming →
Xbox Game Bar) and Steam's "Guide button focuses Steam". If Guide is unavailable, hold Minus and Plus together
(View + Menu).

**iPhone fullscreen:** Safari's native video fullscreen pauses web controller input and hides the HTML overlay. Use
**Share → Add to Home Screen** and launch s2pipe from the Home Screen for fullscreen play with a Backbone or touch
controller.

Complete mapping table, touch details and troubleshooting: [docs/controllers.md](docs/controllers.md).

After updating s2pipe, **reflash the Pico**: the node and firmware must agree on the packet format. In Wi-Fi mode the
Node also needs the pairing key stored from that Pico. `S2PIPE-BOOT` over the CDC port reboots into BOOTSEL without
unplugging; see [firmware/README.md](firmware/README.md).

## 8. Sleep wake

The Pico 2 W firmware can pull the Switch 2 out of **sleep** (not a full power-off) while a browser is on the play
page. Switch 1 Joy-Con / Pro Controller cannot wake a Switch 2. You need a **Joy-Con 2 / Pro 2 / NSO GameCube**
already paired with that console. The console does not show its BT MAC in settings; the pad broadcasts it.

1. Pair the pad with the Switch 2 once (normal Nintendo pairing).
2. Put the Switch to **Sleep**. Detach the Joy-Con, or press a button on the Pro 2.
3. In the launcher, click **Listen for controller**.
4. Flash a **`pico2_w`** build. Open the play page (Watch is enough).

If the scan finds no Switch MAC, the pad was not advertising the console address. Sleep the Switch, detach the pad,
stand closer, retry.

The Pico LED stays on and goes dark for a second each time a wake advert fires. Wi-Fi/BLE coexistence is still being
validated; see the test report for the current hardware status.

## Ports

| Port     | What                                |
| -------- | ----------------------------------- |
| 5000 TCP | Client page (IPv4 and IPv6)         |
| 5050 TCP | Node: health, WebSocket, WHEP proxy (IPv4 and IPv6) |
| 8189 UDP | WebRTC ICE / RTP (IPv4 candidate)   |
| 8189 TCP | WebRTC over TCP (for Wi-Fi that blocks UDP) |
| 30100 UDP | Wi-Fi controller: authenticated HELLO/CONTROL/PING/TEST (LAN only) |
| 30101 UDP | Wi-Fi controller: discovery announces/probes (LAN only) |
| 80 TCP   | Pico setup AP only, `http://192.168.4.1` |

For LAN players, allow **TCP 5000** (page), **TCP 5050** (Node/WebSocket/WHEP), and **UDP/TCP 8189** (WebRTC media,
with the TCP fallback). UDP **30100/30101** only need to be reachable between Node and the Pico; both are IPv4-only.
MediaMTX also uses internal RTSP 8554 (127.0.0.1) and WHEP HTTP 8889 (proxied by Node); do not expose those.

**IPv6:** the page and Node API/WebSocket also listen on IPv6. Pico control and the WebRTC ICE candidate are still
IPv4, so an IPv6-only phone can load/control but cannot receive video yet. Keep IPv6 on a trusted LAN, set a Node
password and do not forward the ports. See [docs/ipv6.md](docs/ipv6.md).

## Security

- The Pico setup hotspot is WPA2 with a random 12-character password. The 32-byte pairing key is random per device;
  there is no universal pairing key.
- The pairing key is effectively a controller credential. It is stored in `~/.s2pipe/config.json` (and the running
  stack's `runtime.json`) and in the Pico's flash; treat those files as sensitive. Resetting Wi-Fi regenerates it and
  requires re-pairing.
- CONTROL, HELLO, PING and TEST datagrams are authenticated with HMAC-SHA256. Discovery announcements are
  unauthenticated but carry no pad state. The home Wi-Fi password is stored only in the Pico's flash config and is
  never logged.
- The **Node password** is optional and protects the Node routes, WebSocket and WHEP proxy. It is separate from the
  Pico pairing key. Set it before allowing untrusted devices or IPv6 access.
- The page, WebSocket and WHEP are plain HTTP, without TLS. Use this on a trusted LAN or through your own VPN.
- The launcher's **Accessible from the internet** option only fills the public address fields; it does not configure
  NAT, port forwarding or a firewall. WAN exposure is not recommended.
- Keep the page, Node, MediaMTX and Pico control ports on the LAN. Do not expose UDP 30100/30101 or the setup AP to
  the Internet.
- IPv6 global addresses are globally routable; use the router/Windows firewall to block WAN access and never
  port-forward 5000/5050.

## Current status and limits

Software tests currently pass: **24 client tests, 9 Node tests and 6 Rust tests**, plus IPv4/IPv6 page and IPv6
WebSocket checks. The Pico SoftAP/DHCP/HTTP setup page, home-Wi-Fi join and Node UDP control path were verified on
Windows. The USB provisioning UI and its error path were exercised; a valid USB SSID save should still be confirmed
on the target Pico.

Still requiring device verification before treating them as finished:

- Switch 2 accepting the HID+CDC composite device, and Switch HID output from Wi-Fi-driven pads. If the composite is
  rejected, the UART firmware remains the fallback.
- The real 250 ms failsafe, 30-minute continuous stability, and BLE sleep wake with Wi-Fi active. The Wi-Fi link had
  an intermittent `connected=false` sample during development; the longer stability run is still pending.
- The launcher's **Scan Wi-Fi** and **Test controller** buttons on the target network, and the phone setup page
  rendering on the iPhone.
- A real Xbox/Backbone mapping run, a physical-phone touch run, a physical iPhone IPv6 page/control run, and
  IPv6-only video (MediaMTX ICE is still IPv4).
- Wi-Fi hardware validation is currently Windows-only; Linux Wi-Fi behavior has not been verified.

See [docs/wifi-controller-test-report.md](docs/wifi-controller-test-report.md) for the detailed test record.

## Development

Deno workspace: `apps/node`, `apps/client`, `shared`. Firmware is CMake. Launcher is Tauri 2 (`launcher/`).

```sh
deno fmt
deno check apps/node/src/index.ts
deno check apps/client/src/index.ts
deno test -A apps/node/src
deno test -A apps/client/src
```

**Launcher:** `cd launcher && deno task dev` for development. Production GUI:
`cd launcher && deno task tauri build --no-bundle` (plain `cargo build --release` produces a dev-mode webview that
expects `localhost:1420`). Rust tests:
`cargo test -p s2pipe-core --manifest-path launcher/src-tauri/Cargo.toml`.

**Node:** `cd apps/node && deno task dev` (5050). `PICO_SERIAL=/dev/ttyUSB0` or `COM3`. Wi-Fi:
`PICO_TRANSPORT=wifi PICO_WIFI_HOST=192.168.1.120 PICO_WIFI_KEY=<64 hex> deno task dev`.

**Firmware:** `cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w` then
`cmake --build firmware/build -j`. A fake Pico for protocol work:
`deno run -A apps/node/src/testing/fake_pico.ts --key <64 hex>`.

**Client:** `cd apps/client && deno task dev` (5000). `NODE_BASE_URL` is the node address. `/password` opens only
when the node returns 401.

Firmware and packet: keep `apps/node/src/utils/packet.ts` in sync with `firmware/packet.h`, and
`apps/node/src/utils/wifi_protocol.ts` in sync with `firmware/wifi_protocol.h`.

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

When a Node password is configured, HTTP requests use the `Authorization` header; the page stores it in the
`nodePassword` cookie. Browsers cannot set an Authorization header on a WebSocket handshake, so `/socket` also accepts
`?authorization=<password>`. `/health` includes Wi-Fi fields under `pico` (`transport`, `ip`, `latencyMs`, `rssi`,
`stats`).

## Documentation

| Document | Contents |
| --- | --- |
| [launcher/README.md](launcher/README.md) | Launcher/CLI flags, `~/.s2pipe`, encoders, ports, Node password |
| [firmware/README.md](firmware/README.md) | Firmware build, pins, USB interfaces, provisioning, sleep wake |
| [docs/wifi-controller.md](docs/wifi-controller.md) | Wi-Fi hardware, setup, protocol/security, UART compatibility, troubleshooting |
| [docs/controllers.md](docs/controllers.md) | Gamepad mapping, virtual/touch controllers, iPhone fullscreen, Hide UI |
| [docs/ipv6.md](docs/ipv6.md) | IPv6 page/API/WebSocket scope, security, remaining IPv4 pieces |
| [docs/wifi-controller-test-report.md](docs/wifi-controller-test-report.md) | Build/test evidence and pending hardware verification |

## License

[MIT](LICENCE) Copyright (c) 2026-present, Borane. Fork changes are maintained at
[xbunax/s2pipe](https://github.com/xbunax/s2pipe).
