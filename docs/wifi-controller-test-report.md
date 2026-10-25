# Wi-Fi controller — build and test report

Date: 2026-10-25
Host: Windows 11 Pro (10.0.26200), x86_64

## Toolchain

| Tool | Version |
| --- | --- |
| CMake | 4.4.4 |
| Ninja | 1.13.2 |
| Arm GNU Toolchain | 15.2.rel1 (`arm-none-eabi-gcc 15.2.1`) |
| Python | 3.15.1 |
| Pico SDK | 2.3.1 (submodules at the pinned commits) |
| Deno | 2.9.8 |
| Node.js | 26.12.1 |
| Rust / Cargo | 1.99.1 |
| Pico board | `pico2_w` (RP2350, CYW43439) |

The Pico SDK, Arm toolchain, Rust, and Ninja were not present at the start; they
were installed into the user profile (`scoop`) and the SDK was cloned to
`%USERPROFILE%\.pico-sdk`. No system-wide PATH changes are required by the
repository.

## Builds

### Firmware

```powershell
cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
cmake --build firmware/build -j 8
```

Result: **PASS**.

- `firmware/build/s2pipe_pico.elf`
- `firmware/build/s2pipe_pico.uf2` (884,736 bytes)
- `firmware/build/s2pipe-pico2w-wifi.uf2` (884,736 bytes)
- Flash use at link time: ~441 KB; `.bss` ~43 KB; the config reserve is the last
  8 KB of 4 MB flash.
- The existing UART + 8 HID firmware built before the Wi-Fi changes; the Wi-Fi
  build then linked the same USB HID descriptors plus CDC.
- mbedtls uses a project config (`s2pipe_mbedtls_config.h`) with only
  HMAC-SHA256; the default bare-metal entropy configuration does not build on
  the Pico.

### Node

```powershell
deno check apps/node/src/index.ts
deno test -A apps/node/src/utils/wifi_protocol_test.ts apps/node/src/services/wifi_transport_test.ts
```

Result: **PASS**, 9 tests.

Covered:

- 84-byte inner packet encode/decode, 8 pads, wake fields, CRC.
- Wi-Fi packet round trip; HMAC rejection of modified payload, modified MAC,
  truncation, wrong key, bad magic.
- Known cross-language vector:
  `533257310101000044332211050000000403020104000000df66075996c0aa2c76eea4b634134d7fdeadbeef`.
- Sliding-window duplicate, out-of-order and stale detection.
- 64-hex pairing-key parser.
- Discovery announcement parsing.
- `WifiTransport` against `FakePico`: HELLO/HELLO_ACK, 8-pad control, PING/PONG
  RTT and RSSI, reconnect with a new session, duplicate/out-of-order/stale
  packets, bad HMAC, and the 250 ms failsafe.
- Wrong pairing key fails with a clear error.

Deno 2.9.8 no longer provides `Deno.listenDatagram`; the implementation uses
the built-in `node:dgram` module. This is documented in the transport code.

### Launcher / Rust

```powershell
cargo check --workspace --manifest-path launcher/src-tauri/Cargo.toml
cargo test -p s2pipe-core --manifest-path launcher/src-tauri/Cargo.toml
npx -p typescript@5.6.3 tsc --noEmit -p launcher/tsconfig.json
cd launcher; deno task build
```

Result: **PASS**.

- Rust: 5 tests (`protocol_vector_matches_node_and_firmware`,
  packet round trip/tamper, key parser, TEST payload, and a Rust UDP fake-Pico
  client test).
- TypeScript/Preact: tsc reports no errors; Vite builds 19 modules
  (`dist/assets/index-*.js` ~38 KB, CSS ~15 KB).
- `cargo check` succeeds for `s2pipe-core`, the CLI, and the Tauri GUI.
- Release builds:
  - `cargo build --release --manifest-path launcher/src-tauri/Cargo.toml` →
    compiled, but the resulting GUI was a **dev-mode** Tauri webview and showed
    `localhost refused to connect` because it loaded `http://localhost:1420`.
    This is not a code failure; plain Cargo does not pass the Tauri build
    environment that embeds `frontendDist`.
  - `deno task tauri build --no-bundle` → **PASS**; this is the supported GUI
    build. The new `target/release/s2pipe-gui.exe` (6,296,576 bytes) embeds the
    frontend. UI Automation read the loaded page and found the full launcher
    UI (`Controller transport`, `USB Serial`, `Wi-Fi`, `Pico`, etc.), so the
    localhost error is resolved.
  - `cargo build --release -p s2pipe --manifest-path launcher/src-tauri/Cargo.toml` → **PASS**
    (`target/release/s2pipe.exe`, 2,648,064 bytes).
  - The Tauri installer bundle was skipped with `--no-bundle`; the release
    executable is the reviewed deliverable. Packaging can run `deno task tauri
    build` on a machine with the installer tooling.

### Client controller UI

The play page now has physical-gamepad rebinding and a touch controller with
per-orientation layouts.

```powershell
deno check apps/client/src/index.ts
deno lint apps/client/src
deno test -A apps/client/src
```

Result: **PASS**. The client suite is 24 tests, including 13 new tests for the
gamepad mapping and touch controller utilities. Type-checking and linting pass
(28 files checked).

A one-off headless Chrome/Playwright session (system Chrome, not committed as a
test dependency) verified:

- 17 touch controls render and every control is inside the stage in landscape;
- A and the left stick produce the expected `PadButton.A` and `lx` bits in the
  WebSocket pad frames, and release returns to neutral;
- two simultaneous touch points (A + B) produce both bits in one frame;
- dragging A in the layout editor persists only the landscape position and
  leaves the portrait layout untouched;
- the portrait layout is selected at 390 × 844;
- an injected standard gamepad appears in the HUD, sends its B bit, and after
  rebinding A to physical button 0 sends A instead of B;
- with an iPhone user agent and an injected fake Backbone, the first gamepad
  claimed seat P1 without a click and sent pad frames; the PWA standalone meta
  tags were present;
- simulating `webkitendfullscreen` made the page re-assert the seat and resume
  pad frames without closing a healthy WebSocket; a lost play response is
  covered by the five-second timeout;
- removing the fake gamepad and adding it again caused a 2-second watchdog pass
  to remove it, then auto-claim P1 on reconnect and resume pad frames;
- changing the fake gamepad's index (same controller id) kept the P1 seat and
  resumed pad frames, exercising the index-id remap;
- the EyeOff button hid the HUD and touch pad, and tapping the stream or
  pressing Escape restored them;
- a 30-second iPhone-user-agent session with a fake Backbone stayed
  `Connected` with P1 for the whole run and logged no errors;
- no page errors were logged.

These tests exercised the browser UI and WebSocket frames, not a real Xbox
Backbone, a real phone or the Switch's HID input. iPhone native video
fullscreen cannot be exercised in headless Chrome; the page now blocks that
fallback while a web controller is active, closes it on a best-effort basis
when a gamepad connects, and documents Add to Home Screen as the working
fullscreen path.

### IPv6 web access (first phase)

Implemented:

- Node keeps its IPv4 listener and adds a second `Deno.serve` listener on
  `::`; both share routes, auth and WebSocket state.
- The Slick page server keeps its IPv4 listener and adds an IPv6 TCP proxy on
  `::` forwarding to `127.0.0.1`.
- The play page derives the Node URL from the IPv6 page host, so an IPv6 page
  uses `[IPv6]:5050` for health, WebSocket and WHEP.
- IPv4 page, API and WebSocket behavior is unchanged.

Verified:

- `http://127.0.0.1:5000` and `http://[::1]:5000` both return 200.
- `http://127.0.0.1:5050/health` and `http://[::1]:5050/health` both return
  200.
- `0.0.0.0` and `::` listeners coexist on both 5000 and 5050.
- A headless iPhone-UA browser loaded the IPv6 loopback and the PC's global
  IPv6 page, showed `http://[IPv6]:5050` in Settings, connected the WebSocket,
  claimed P1 and sent gamepad frames.
- The same test over IPv4 still passes.
- The global IPv6 page loaded the stream through the existing IPv4 ICE
  candidate in the dual-stack test.

Still IPv4 only:

- Pico control (UDP 30100/30101); the firmware uses `LWIP_IPV4=1`,
  `LWIP_IPV6=0`.
- MediaMTX's WebRTC ICE candidate and `webrtcAdditionalHosts`.
- An IPv6-only phone can load and control, but cannot receive video yet.
- No real iPhone on an IPv6 LAN was tested in this session.

Production builds after these changes:

- `s2pipe.exe` (CLI): 2,716,160 bytes (2026-10-25 23:36:08), including IPv6
  web access. This is the binary currently serving the page. `deno task tauri
  build` only rebuilds the GUI, so the CLI was rebuilt explicitly with
  `cargo build --release -p s2pipe`.
- `s2pipe-gui.exe`: 6,385,152 bytes (2026-10-25 23:42:28), built from the same
  source. The GUI is closed; the stack is running from the CLI. Close the GUI
  before any future rebuild.

## Hardware observed so far

The first Wi-Fi image was flashed to the Pico 2 W (previous MicroPython was
replaced; its filesystem was empty). Windows enumeration:

```text
USB\VID_0F0D&PID_0092\0123456789ABCDEF   (composite, serial = board ID)
8 × HID-compliant game controller       (MI_00..MI_07)
USB 串行设备 (COM6)                     (MI_08, CDC)
```

The CDC line was read at 115200 with DTR asserted:

```text
S2PIPE-SETUP {"id":"0123456789abcdef","ssid":"S2PIPE-xxxxxxxx","pass":"***","psk":"***","fw":"wifi-1.0.0","mode":"ap"}
```

Parsed fields: ID `0123456789abcdef`, SSID `S2PIPE-xxxxxxxx`, firmware
`wifi-1.0.0`, mode `ap`, setup password length 12, pairing key length 64 hex.
This verifies the USB descriptors, CDC, flash config creation, device ID and
provisioning-mode startup.

### SoftAP visibility — PASS after re-flash

With the **first** image, the PC's 2.4 GHz scan (13 networks visible) did **not**
show `S2PIPE-xxxxxxxx`, even though the CDC line reported `mode=ap`. The likely
cause was that the first image started BTstack immediately after the SoftAP,
which can make the CYW43439 drop the AP.

The user re-flashed the image that does not start BLE in provisioning AP mode.
After the re-flash the PC's 2.4 GHz scan showed:

```text
SSID 14 : S2PIPE-xxxxxxxx
    BSSID 1 : 02:00:00:00:00:01
    Signal  : 100%
    Band    : 2.4 GHz
    Channel : 3
```

The CDC setup line is still served (`mode=ap`, `ssid=S2PIPE-xxxxxxxx`, password
length 12, pairing key length 64). This is consistent with the BLE-during-AP-
start hypothesis. It is not a full BLE coexistence proof: BLE is intentionally
off in AP mode and starts only after the STA link is up.

At the same time the home 2.4 GHz networks were visible on the PC:

```text
Example_2.4G        2.4 GHz  channel 9  signal 100%
Example_2.4G_IoT    2.4 GHz  channel 9  signal 100%
```

Use the main `Example_2.4G` network first; an IoT SSID may enable client isolation,
which would block UDP control from the PC.

### DHCP broadcast filter bug found during iPhone setup

Symptom: the iPhone joined/attempted `S2PIPE-xxxxxxxx` and kept spinning; the
Pico still reported `mode=ap`. The setup AP was visible and the launcher had
read the pairing key.

Root cause: `lwipopts.h` sets `IP_SOF_BROADCAST=1` and
`IP_SOF_BROADCAST_RECV=1`, but the bundled DHCP server did not set
`SOF_BROADCAST` on its UDP PCB. lwIP therefore dropped the client's
`255.255.255.255:67` DHCP DISCOVER (and the server could not send broadcast
OFFER/ACK replies). The client associated with the AP but never received an IP
address, producing the endless spinner.

Fix and verification:

- After `dhcp_server_init`, call
  `ip_set_option(s_dhcp.udp, SOF_BROADCAST)`.
- The CDC setup line now includes `ip`, `leases` and `http` counters:
  `S2PIPE-SETUP {...,"ip":"192.168.4.1","leases":N,"http":M}`.
  `leases` proves a client received DHCP; `http` proves a request reached the
  provisioning page.
- The 20:21 UF2 (885,760 bytes) was copied to the Pico through the BOOTSEL
  watcher. After the reflash the CDC line reported:

```text
mode=ap  ip=192.168.4.1  leases=2  http=3
```

This is **PASS at the protocol level**: the iPhone obtained a DHCP lease and
issued HTTP requests to the setup page. The iPhone UI was still showing a
spinner at the time of the reading, likely from a stale page/connection created
before the reflash; the page must be reopened or the network forgotten and
rejoined. The PC Wi-Fi scan intermittently fails to list `S2PIPE-xxxxxxxx`
even while the Pico reports AP mode and the lease/HTTP counters increase; this
is a Windows scan artifact, not an AP failure.

### Wi-Fi STA and Node control link — PASS

After saving `Example_2.4G`, the Pico CDC reported:

```text
S2PIPE-STATUS {"id":"0123456789abcdef","ip":"192.168.1.168","rssi":-42,"fw":"wifi-1.0.0","mode":"sta"}
```

The Node `/health` endpoint reported:

```text
pico.connected = true
pico.transport = "wifi"
pico.ip = "192.168.1.168"
pico.latencyMs = 8
pico.rssi = -47
pico.stats = { tx: 239, rx: 2708, auth: 0, dup: 0, old: 0, oow: 0, bad: 0 }
occupied = [0]
```

This verifies the authenticated Wi-Fi control path, the HELLO/PING RTT
measurement, the seat assignment and the virtual-controller input reaching the
Pico. The observed 8 ms RTT is within the <10 ms target for this sample (not a
30-minute stability result).

At the time of that first STA test the Pico's USB was plugged into the PC, so
its eight HID pads were enumerated on Windows, not on the Switch. To see the
virtual controller drive the console, the Pico must be plugged into the Switch
dock; Wi-Fi control continues independently. `joy.cpl` can confirm HID output
while the Pico is on the PC.

### Final restart observation (2026-10-25 21:37–21:50)

After rebuilding the launcher and restarting the stack, the Pico was reachable
at `192.168.1.168` (RSSI about -53 dBm), but a `/health` poll around 21:40
alternated between `connected: true` and `connected: false` while the Pico's
cumulative `auth` counter stayed at 21. Pico latency samples were 6–24 ms.
A later readiness check at 21:50 reported `connected: true`, 7 ms and -53 dBm,
and the final check after the last rebuild at 22:00 reported `connected: true`,
8 ms and -47 dBm, so the link was usable during the final UI tests but is not
proven stable.
No Pico USB device (`VID_0F0D`) or `COM6` was present on the PC during this
session, so the Pico had been moved off the PC, but the exact USB host (dock or
other power source) was not confirmed. The health payload also reported
`wake: true`, meaning wake MACs are now configured and the firmware's BLE path
is active; BLE/Wi-Fi coexistence is a possible cause of the intermittent link,
but that is not proven. The 30-minute stability target is still unverified, and
the final touch/mapping UI tests used the Node WebSocket only, not the Switch
HID path.

A later 30-second poll at 22:37 returned 30/30 `connected: true` samples,
latency 7–20 ms and RSSI -48 to -50 dBm; the Pico's cumulative `auth` counter
was 0, so the Pico had rebooted since the earlier 21 reading. That is a good
sample but still not a substitute for a 30-minute run.

## Not yet verified on hardware

These items require the Pico on the home 2.4 GHz network and/or a Switch:

| Item | Status |
| --- | --- |
| SoftAP visible after the BLE change | **PASS** (`S2PIPE-xxxxxxxx`, 100%, 2.4 GHz channel 3) |
| Phone connects to setup AP and loads `192.168.4.1` | **PASS at protocol level** (`leases=2`, `http=3` after reflash); page rendering on the iPhone still to confirm |
| DHCP lease + HTTP request counters on the CDC line | **PASS** (`ip=192.168.4.1`, `leases=2`, `http=3`) |
| Launcher **Configure Wi-Fi via USB** UI | **PASS** (UI Automation sees the card and button) |
| USB `S2PIPE-PROV` command error path | **PASS** (`S2PIPE-PROV-ERR invalid` for a bad request; config unchanged) |
| USB `S2PIPE-PROV` valid save → Pico joins `Example_2.4G` | pending (needs the user to enter the Wi-Fi password in the launcher) |
| Pico joins `Example_2.4G` / `Example_2.4G_IoT` (2.4 GHz) | **PASS** (IP `192.168.1.168`, RSSI -42) |
| Launcher Scan sees the Pico (UDP 30101) | pending (manual IP/health path works; Scan still to confirm) |
| Authenticated Test controller (HELLO/PING, real RTT/RSSI) | **PASS** at Node level (8 ms RTT, -47 dBm); launcher button still to confirm |
| Node sends 8-pad control over Wi-Fi; Switch reacts | Node→Pico **PASS** earlier (seat 0, rx 2708); final restart link flapped (see note); Switch HID pending USB host move |
| 250 ms failsafe on real Wi-Fi disconnect | pending (fake test passes) |
| Physical gamepad rebinding with a real Xbox pad | pending (headless fake standard gamepad **PASS**) |
| Touch controller on a physical phone | pending (headless 844×390 and 390×844 **PASS**) |
| IPv6 page/API/WebSocket from a physical iPhone | pending (headless loopback/global **PASS**) |
| IPv6 WebRTC video / IPv6-only phone | pending (media ICE candidate is still IPv4) |
| 30-minute continuous run | pending |
| Virtual controller drives the Pico pads | **PASS** at Node/Pico level (seat 0, tx/rx counters); Switch output pending USB host move |
| Switch 2 accepts the HID+CDC composite USB device | pending; Windows accepts all eight HID interfaces |
| BLE sleep wake with Wi-Fi active | pending; coexistence not yet validated |
| Real RTT < 10 ms and jitter/loss statistics | pending |
| iPhone/iPad remote play over the full path | video path unchanged; Wi-Fi control pending |

Reasons: the remaining steps need a physical BOOTSEL press to install the new
firmware, the home Wi-Fi password (entered by the user on the setup page), and
the Switch 2 dock. The software tests and Windows USB enumeration do not stand
in for those tests.

## Next hardware steps

1. ~~Flash the new image.~~ Done; the setup AP is visible.
2. ~~Re-flash the DHCP-broadcast-fix image.~~ Done; `leases=2`, `http=3`
   confirm DHCP and HTTP are working.
3. On the iPhone, forget `S2PIPE-xxxxxxxx` and rejoin with the launcher's
   current 12-character password, then open `http://192.168.4.1` directly in
   Safari (do not wait for the captive-portal popup).
4. Enter `Example_2.4G` (2.4 GHz) and its password on the setup page.
4. After the Pico reboots: **Scan Wi-Fi → Test controller → Start s2pipe**.
5. Plug the Pico into the Switch dock and verify all eight pads.
6. Disconnect the Pico or stop the Node and verify the 250 ms neutral.
7. Run continuously for 30 minutes and record RTT, RSSI, loss, duplicates and
   authentication failures.
8. Test BLE sleep wake while Wi-Fi is connected.

## Reproducing the software tests

```powershell
# Node
deno check apps/node/src/index.ts
deno test -A apps/node/src

# Rust
cargo test -p s2pipe-core --manifest-path launcher/src-tauri/Cargo.toml

# Launcher frontend and production GUI
npx -p typescript@5.6.3 tsc --noEmit -p launcher/tsconfig.json
cd launcher; deno task tauri build --no-bundle

# Firmware
cmake -S firmware -B firmware/build -G Ninja -DPICO_BOARD=pico2_w -DCMAKE_BUILD_TYPE=Release
cmake --build firmware/build -j 8
```
