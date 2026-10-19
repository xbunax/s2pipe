# Launcher

Desktop app (Tauri 2 + Preact) and `s2pipe` CLI. Both wrap the same core: fetch FFmpeg, MediaMTX and Deno, then run the
whole stack detached.

## Install

Download from [Releases](https://github.com/8borane8/s2pipe/releases):

| File                                | What it is                              |
| ----------------------------------- | --------------------------------------- |
| `s2pipe-<version>.exe`              | Portable GUI (Windows, no install)      |
| `s2pipe-<version>.msi`              | GUI installer (Windows)                 |
| `s2pipe-<version>-x86_64.AppImage`  | Portable GUI (Linux x86_64)             |
| `s2pipe-<version>-aarch64.AppImage` | Portable GUI (Linux aarch64)            |
| `s2pipe-<version>-x86_64.deb`       | GUI installer (Debian / Ubuntu x86_64)  |
| `s2pipe-<version>-aarch64.deb`      | GUI installer (Debian / Ubuntu aarch64) |
| `s2pipe-cli-<version>.exe`          | CLI (Windows)                           |
| `s2pipe-cli-<version>-x86_64`       | CLI (Linux x86_64)                      |
| `s2pipe-cli-<version>-aarch64`      | CLI (Linux aarch64)                     |

Nothing else is required. The Deno apps (`apps/`, `shared/`, `deno.json`) are baked into the binary at compile time with
`include_dir`, so a bare `.exe` carries the full stack.

## Run

Pick a capture card and a Pico port in the GUI, then press **Start s2pipe**.

Or headless:

```sh
s2pipe start
s2pipe stop
```

`start` relaunches if the stack is already up. Any config field can be overridden for one run:

```sh
s2pipe start --capture-source dshow --capture-device "USB Video" --capture-fps 60
```

Flags overlay `~/.s2pipe/config.json`, they are not written back. The GUI writes that file.

## What start does

1. Unpacks the embedded workspace to `~/.s2pipe/app` (rewritten every start, so it always matches the binary).
2. Downloads FFmpeg, MediaMTX and Deno into `~/.s2pipe/bins` if missing.
3. Copies this GUI or CLI onto `~/.s2pipe/launcher` and saves the run's config to `~/.s2pipe/runtime.json`.
4. Writes `~/.s2pipe/mediamtx.yml` from the config (ICE IP and port, encode workers).
5. Starts MediaMTX, the Deno node and client, then waits for RTSP `:8554` and both ports to accept a connection.

PIDs land in `~/.s2pipe/stack.json` as each process starts, so a crash mid-launch does not leave orphans holding ports.
Every child is spawned detached in its own process group, so closing the launcher leaves the stack running and
`s2pipe stop` kills it from any process. If any step fails, everything already started is killed and the error is
surfaced. Logs go to `~/.s2pipe/logs` (`node.log`, `client.log`, `mediamtx.log`, `ffmpeg-video.log`,
`ffmpeg-audio.log`, `ffmpeg-lite.log`). When a process dies at start, the last log lines are included in the error.

### Encoding on demand

Nothing captures or encodes while nobody watches. MediaMTX starts an encode worker (`launcher --encode video`, `audio` or
`lite`) when the first viewer opens a path, and stops it `idle_stop_seconds` (default 15) after the last one leaves.
The first viewer after an idle spell waits for the capture and encoder to come up, usually a second or two. Set
`idle_stop_seconds` to 0 to keep video and audio always on. The capture device is not opened at launch, so a wrong
device shows up in `ffmpeg-video.log` and `mediamtx.log` when someone first connects.

The worker is the same GUI or CLI binary, copied to `~/.s2pipe/launcher` on launch. It reads `~/.s2pipe/runtime.json`,
and FFmpeg's `-progress pipe:2` in memory (stderr, not a file), and every second checks that `out_time_us` still grows.
Ten seconds without growth, kill and restart. A worker also exits when MediaMTX goes away, and takes FFmpeg with it
(a Job Object on Windows), so a crash never leaves the capture device busy.

FFmpeg is the fragile part, so every launch is a list of attempts: the first process whose `out_time_us` goes above zero
wins, since a missing GPU runtime can keep the process alive for a couple of seconds without muxing anything. Video
walks the encoder backends, then retries them with size, framerate and pixel format dropped. Audio asks for a short
capture buffer first and falls back to the device default. FFmpeg warnings land in `~/.s2pipe/logs`; the last 30 lines
are included in the error message.

Autostart points at `~/.s2pipe/launcher` with `--autostart`: the Windows Run key
(on login), or on Linux a systemd user service (`~/.config/systemd/user/s2pipe.service`) with lingering enabled
(`loginctl enable-linger`), so it starts at machine boot, without SSH, remote desktop or any login, and without a
display. If lingering is refused, run `sudo loginctl enable-linger $USER` once.

## Encoders

| Setting | Encoder                     |
| ------- | --------------------------- |
| Auto    | NVENC, then AMF, then CPU   |
| CPU     | `libx264` / `libx265`       |
| NVIDIA  | `h264_nvenc` / `hevc_nvenc` |
| AMD     | `h264_amf` / `hevc_amf`     |
| Custom  | Your own command (below)    |

Auto costs about 100 ms on a machine with no GPU encoder: the driver refuses immediately and the next backend is tried.
H.265 halves the bitrate, but browser support for it over WebRTC is patchy, so H.264 stays the default.

All backends are configured for low latency: no B-frames, one keyframe every 2 s, no lookahead, and frames sent as
captured (no forced frame rate). Colors are converted to BT.709 limited range and tagged as such, which is what browsers
assume for HD video.

The bitrate setting is a **ceiling**, not a target. Quality stays constant (CRF on the CPU, constant-quality VBR on
NVIDIA), so a still picture costs almost nothing, and a busy scene is capped at the ceiling with a buffer of about
3 frames so a burst never queues behind itself on the link. AMD (AMF) has no such mode: it runs QVBR and treats the
setting as its target. This is untested on an AMD card.

### Lite stream

Next to the main stream, a second path `switch-lite` carries a 540p30, 2 Mbit/s H.264 re-encode of it (libx264, always
available). The player picks it in Auto quality after a few seconds of heavy packet loss, or when the user chooses Lite.
It only runs while someone watches it.

Lite helps a slow link, not a slow machine: it is made from the main stream, so while it plays the main encoder keeps
running next to it. The first viewer on a cold start waits for both encoders, up to 30 s.

### Custom encoder

For hardware FFmpeg cannot drive (an SoC video engine through GStreamer, for example), set the encoder to `custom` and
`videoCustom` (`--video-custom`) to a shell command (`sh -c` on Linux, `cmd /C` on Windows). It must capture, encode, and
print **H.264 Annex-B** (with SPS/PPS before every key frame) on stdout. Placeholders:

| Placeholder | Value                                   |
| ----------- | --------------------------------------- |
| `{device}`  | Capture device                          |
| `{width}`   | Capture width                           |
| `{height}`  | Capture height                          |
| `{fps}`     | Capture frame rate                      |
| `{bitrate}` | Max video bitrate in kbit/s             |
| `{gop}`     | Key frame interval in frames (2 s)      |

A path with spaces needs its own quotes in the command, for example "{device}" (the placeholders are pasted as they
are).

FFmpeg then only tags the colors (BT.709 limited) and republishes the stream without re-encoding. The command's errors
go to `ffmpeg-video.log`, and it is stopped with the stream. Audio is unaffected.

```sh
# FFmpeg with a machine-specific encoder
s2pipe start --video-encoder custom --video-custom \
  "ffmpeg -f v4l2 -video_size {width}x{height} -framerate {fps} -i {device} -c:v h264_v4l2m2m -b:v {bitrate}k -g {gop} -bf 0 -f h264 -"

# GStreamer with a V4L2 hardware encoder (SoC video engine)
s2pipe start --video-encoder custom --video-custom \
  "gst-launch-1.0 -q v4l2src device={device} ! video/x-raw,width={width},height={height},framerate={fps}/1 ! videoconvert ! v4l2h264enc ! h264parse config-interval=-1 ! video/x-h264,stream-format=byte-stream ! fdsink fd=1"
```

Which encoder elements exist, and how to set their bitrate and key frame interval, depends on the board and its
GStreamer plugins: check with `gst-inspect-1.0` and test the command in a terminal first.

## Files

Everything lives in `~/.s2pipe`:

| Path           | Contents                                              |
| -------------- | ----------------------------------------------------- |
| `launcher`     | Last GUI or CLI used (encode workers + autostart)     |
| `config.json`  | Saved GUI settings                                    |
| `runtime.json` | Config of the running stack, read by the encode workers |
| `stack.json`   | PIDs of the running processes                         |
| `mediamtx.yml` | Generated on every start, do not edit                 |
| `bins/`        | Downloaded FFmpeg, MediaMTX, Deno                     |
| `app/`         | Deno workspace extracted from the binary              |
| `logs/`        | `node.log`, `client.log`, `mediamtx.log`, FFmpeg logs |

## Ports

| Port   | Who                          |
| ------ | ---------------------------- |
| `5000` | Client (browser)             |
| `5050` | Node (HTTP + WebSocket)      |
| `8554` | MediaMTX RTSP, loopback only |
| `8889` | MediaMTX WHEP                |
| `8189` | WebRTC ICE (UDP and TCP)     |

Only `8189` needs to be reachable by players, over UDP and over TCP: the TCP side is what lets a phone on a restrictive
public Wi-Fi (UDP blocked) still connect. Behind a router, forward both. Setting `mediaIcePort` to `443` makes that TCP
side pass almost every network, but binding it needs privileges on Linux
(`sudo setcap cap_net_bind_service=+ep ~/.s2pipe/bins/mediamtx`). The rest follows from the exposure choice in the GUI. A node password in
the GUI (or `--node-password`) makes the node require that value in the `Authorization` header on every route. Leave it
empty for no authentication.

## Development

```sh
cd launcher
deno task dev          # Tauri + Vite, hot reload
deno task build        # tsc + vite build
cargo run -p s2pipe -- start
```

The Rust side is a Cargo workspace under `src-tauri`:

| Crate         | Role                                                                     |
| ------------- | ------------------------------------------------------------------------ |
| `s2pipe-core` | Everything real: config, runtime downloads, spawning, device enumeration |
| `s2pipe-gui`  | Tauri shell, commands                                                    |
| `s2pipe`      | CLI                                                                      |

`core` has no Tauri dependency, which is what lets the CLI exist. Device enumeration is per-OS: nokhwa and WASAPI on
Windows, V4L2 capture nodes (metadata nodes skipped) and `/proc/asound/pcm` on Linux (no `alsa-utils` needed). Capture
itself always goes through DirectShow on Windows (FFmpeg has no WASAPI demuxer) and PulseAudio on Linux (the bundled
FFmpeg has no ALSA demuxer): at start, the chosen `hw:card,device` is mapped to its Pulse source with `pactl`, and
loaded into the server (`module-alsa-source`) if the server did not detect the card.

`runtime/ffmpeg` is split by concern: `input.rs` builds the capture arguments, `encoder.rs` the codec arguments,
`custom.rs` the user-command encoder, `mod.rs` runs the attempt list and spawns FFmpeg, and `worker.rs` is the on-demand
encode worker that supervises `out_time_us` and restarts on freeze.

Releases are cut by pushing a `v*` tag; `.github/workflows/launcher.yml` builds both binaries on Windows and on Linux
x86_64 and aarch64.
