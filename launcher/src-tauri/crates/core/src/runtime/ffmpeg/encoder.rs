use std::process::Command;

use super::input;
use crate::config::AppConfig;

#[derive(Clone, Copy)]
pub enum Backend {
    Cpu,
    Nvenc,
    Amf,
}

impl Backend {
    fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "cpu" => Some(Self::Cpu),
            "nvenc" => Some(Self::Nvenc),
            "amf" => Some(Self::Amf),
            _ => None,
        }
    }
}

/// Backends to try, in order. "auto" walks the hardware ones first and keeps
/// the CPU as the last resort, since it is the only one always available.
pub fn backends(config: &AppConfig) -> Vec<Backend> {
    match Backend::parse(&config.video_encoder) {
        Some(backend) => vec![backend],
        None => vec![Backend::Nvenc, Backend::Amf, Backend::Cpu],
    }
}

/// The user's own command produces the stream instead of one of FFmpeg's encoders.
pub fn is_custom(config: &AppConfig) -> bool {
    config.video_encoder.trim().eq_ignore_ascii_case("custom")
}

fn is_hevc(config: &AppConfig) -> bool {
    matches!(
        config.video_codec.trim().to_ascii_lowercase().as_str(),
        "h265" | "hevc"
    )
}

/// Bitrate ceiling in kbit/s from "6M", "6000k" or a plain bit/s number.
pub fn bitrate_kbps(config: &AppConfig) -> u32 {
    let value = config.video_bitrate.trim().to_ascii_lowercase();
    let (digits, factor) = if let Some(digits) = value.strip_suffix('m') {
        (digits, 1000.0)
    } else if let Some(digits) = value.strip_suffix('k') {
        (digits, 1.0)
    } else {
        (value.as_str(), 0.001)
    };
    digits
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|number| *number > 0.0)
        .map_or(6000, |number| (number * factor).round().max(1.0) as u32)
}

/// Converts the capture to BT.709 limited range, which is what browsers
/// assume for HD video. Raw capture cards send BT.709; MJPEG is already tagged
/// full range by its decoder and converts from BT.601.
fn color_filter(config: &AppConfig) -> String {
    let raw = !input::is_test(config) && config.capture_format.trim() != "mjpeg";
    let source = if raw { "in_color_matrix=bt709:" } else { "" };
    format!("scale={source}out_color_matrix=bt709:out_range=tv,format=yuv420p")
}

pub fn video(command: &mut Command, config: &AppConfig, backend: Backend) {
    let hevc = is_hevc(config);
    let fps = config.capture_fps.max(1);
    // A key frame every 2 s keeps bitrate peaks rare; a browser joining the
    // stream waits for the next one because MediaMTX cannot ask the publisher.
    let gop = (fps * 2).to_string();
    // Every encoder aims for a constant quality, so a still picture costs almost nothing, and
    // the bitrate setting only caps busy scenes. A fixed target would pad quiet ones and starve busy ones.
    let kbps = bitrate_kbps(config);
    let rate = format!("{kbps}k");
    // About 3 frames of buffer: a key frame cannot burst a whole second of
    // bits onto the link and queue everything behind it.
    let buffer = format!("{}k", (kbps * 3 / fps).max(1));

    command.args(["-an", "-c:v", codec_name(backend, hevc)]);

    match backend {
        Backend::Cpu if hevc => command.args([
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-profile:v",
            "main",
            "-crf",
            "24",
            // libx265 hides the GOP and B-frame knobs behind its own option string.
            "-x265-params",
            &format!("bframes=0:keyint={gop}:min-keyint={gop}:scenecut=0:repeat-headers=1"),
        ]),
        Backend::Cpu => command.args([
            "-preset",
            "ultrafast",
            "-tune",
            "zerolatency",
            "-profile:v",
            "high",
            "-crf",
            "20",
            "-bf",
            "0",
            "-g",
            &gop,
            "-keyint_min",
            &gop,
            "-sc_threshold",
            "0",
        ]),
        Backend::Nvenc => command.args([
            "-preset",
            "p1",
            "-tune",
            "ull",
            "-profile:v",
            if hevc { "main" } else { "high" },
            "-rc",
            "vbr",
            "-cq",
            "22",
            "-b:v",
            "0",
            "-bf",
            "0",
            "-delay",
            "0",
            "-no-scenecut",
            "1",
            "-forced-idr",
            "1",
            "-strict_gop",
            "1",
            "-g",
            &gop,
            "-keyint_min",
            &gop,
        ]),
        Backend::Amf => command.args([
            "-usage",
            "ultralowlatency",
            "-quality",
            "speed",
            "-profile:v",
            if hevc { "main" } else { "high" },
            "-rc",
            "qvbr",
            "-qvbr_quality_level",
            "22",
            "-b:v",
            &rate,
            "-bf",
            "0",
            "-header_insertion_mode",
            "idr",
            "-g",
            &gop,
        ]),
    };

    command.args([
        "-vf",
        &color_filter(config),
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        // Frames leave as they are captured: no forced rate, no duplicated or dropped frames.
        "-fps_mode",
        "passthrough",
        "-maxrate",
        &rate,
        "-bufsize",
        &buffer,
    ]);
}

const LITE_HEIGHT: &str = "540";
const LITE_FPS: u32 = 30;
const LITE_KBPS: u32 = 2000;

/// Smaller, lighter H.264 made from the main stream, whatever codec that one uses.
/// Always libx264: it is the one encoder every machine has.
pub fn lite(command: &mut Command) {
    let gop = (LITE_FPS * 2).to_string();
    let rate = format!("{LITE_KBPS}k");
    let buffer = format!("{}k", LITE_KBPS * 3 / LITE_FPS);

    command.args([
        "-an",
        "-vf",
        &format!("fps={LITE_FPS},scale=-2:{LITE_HEIGHT},format=yuv420p"),
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-tune",
        "zerolatency",
        "-profile:v",
        "high",
        "-bf",
        "0",
        "-g",
        &gop,
        "-keyint_min",
        &gop,
        "-sc_threshold",
        "0",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-color_range",
        "tv",
        "-crf",
        "24",
        "-maxrate",
        &rate,
        "-bufsize",
        &buffer,
    ]);
}

fn codec_name(backend: Backend, hevc: bool) -> &'static str {
    match (backend, hevc) {
        (Backend::Cpu, false) => "libx264",
        (Backend::Cpu, true) => "libx265",
        (Backend::Nvenc, false) => "h264_nvenc",
        (Backend::Nvenc, true) => "hevc_nvenc",
        (Backend::Amf, false) => "h264_amf",
        (Backend::Amf, true) => "hevc_amf",
    }
}

pub fn audio(command: &mut Command) {
    command.args([
        "-vn",
        // A short capture buffer delivers slightly irregular timestamps, which
        // the Opus encoder rejects as going backward in time.
        "-af",
        "aresample=async=1:first_pts=0",
        "-c:a",
        "libopus",
        "-application",
        "lowdelay",
        "-frame_duration",
        "10",
        "-b:a",
        "64k",
        "-ar",
        "48000",
        "-ac",
        "2",
    ]);
}
