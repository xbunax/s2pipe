use std::path::Path;
use std::process::{Child, Command};

use super::encoder::bitrate_kbps;
use crate::config::AppConfig;
use crate::utils::process::spawn_source;

/// Starts the user's encoder: a shell command that captures and prints H.264 Annex-B on stdout.
/// This is the hook for hardware FFmpeg cannot drive, such as an SoC video engine through GStreamer.
pub fn spawn(config: &AppConfig, log: &Path) -> Result<Child, String> {
    let template = config.video_custom.trim();
    if template.is_empty() {
        return Err("Video encoder is \"custom\" but no custom command is set".into());
    }
    spawn_source(&expand(template, config), log)
}

fn expand(template: &str, config: &AppConfig) -> String {
    let fps = config.capture_fps.max(1);
    template
        .replace("{device}", &config.capture_device)
        .replace("{width}", &config.capture_width.to_string())
        .replace("{height}", &config.capture_height.to_string())
        .replace("{fps}", &fps.to_string())
        .replace("{bitrate}", &bitrate_kbps(config).to_string())
        .replace("{gop}", &(fps * 2).to_string())
}

/// FFmpeg only repackages the stream: it tags the colors browsers must assume
/// and republishes it to MediaMTX without touching the pixels.
pub fn repackage(command: &mut Command, config: &AppConfig) {
    command.args([
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-probesize",
        "200000",
        "-f",
        "h264",
        "-framerate",
        &config.capture_fps.max(1).to_string(),
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0",
    ]);
}
