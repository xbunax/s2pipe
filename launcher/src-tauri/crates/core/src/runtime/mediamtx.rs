use std::path::Path;
use std::process::Command;

use super::ffmpeg::has_audio;
use crate::config::AppConfig;
use crate::utils::bin::{bin_path, ensure_downloaded};
use crate::utils::paths::{app_directory, log_path};
use crate::utils::process::spawn_logged;

const MEDIAMTX_VERSION: &str = "1.20.1";

pub async fn ensure() -> Result<(), String> {
    let (url, archive) = if cfg!(target_os = "windows") {
        (
            format!(
                "https://github.com/bluenviron/mediamtx/releases/download/v{MEDIAMTX_VERSION}/\
                 mediamtx_v{MEDIAMTX_VERSION}_windows_amd64.zip"
            ),
            format!("mediamtx-{MEDIAMTX_VERSION}.zip"),
        )
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        (
            format!(
                "https://github.com/bluenviron/mediamtx/releases/download/v{MEDIAMTX_VERSION}/\
                 mediamtx_v{MEDIAMTX_VERSION}_linux_amd64.tar.gz"
            ),
            format!("mediamtx-{MEDIAMTX_VERSION}.tar.gz"),
        )
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        (
            format!(
                "https://github.com/bluenviron/mediamtx/releases/download/v{MEDIAMTX_VERSION}/\
                 mediamtx_v{MEDIAMTX_VERSION}_linux_arm64.tar.gz"
            ),
            format!("mediamtx-{MEDIAMTX_VERSION}.tar.gz"),
        )
    } else {
        return Err("Unsupported operating system".into());
    };

    ensure_downloaded("mediamtx", &url, &archive)
        .await
        .map(|_| ())
}

/// A published path whose encoder is an `--encode` worker of the launcher. MediaMTX starts it
/// when the first viewer asks for the path and stops it `idle_stop_seconds` after the last one
/// leaves. With `always_on` the worker runs from the start and is restarted if it exits.
fn worker_path(name: &str, kind: &str, launcher: &Path, always_on: bool, idle: u32) -> String {
    let launcher = launcher.display().to_string().replace('\'', "''");
    let command = format!("'\"{launcher}\" --encode {kind}'");
    if always_on {
        format!(
            "  {name}:\n    source: publisher\n    runOnInit: {command}\n    runOnInitRestart: yes\n"
        )
    } else {
        format!(
            "  {name}:\n    source: publisher\n    runOnDemand: {command}\n    \
             runOnDemandRestart: no\n    runOnDemandStartTimeout: 30s\n    \
             runOnDemandCloseAfter: {idle}s\n"
        )
    }
}

pub fn write_config(config: &AppConfig, launcher: &Path) -> Result<(), String> {
    let always_on = config.idle_stop_seconds == 0;
    // The lite stream is always on demand: it is a second encode nobody asks for by default.
    let lite_idle = if always_on { 15 } else { config.idle_stop_seconds };

    let mut paths = worker_path("switch", "video", launcher, always_on, config.idle_stop_seconds);
    if has_audio(config) {
        paths += &worker_path("switch-audio", "audio", launcher, always_on, config.idle_stop_seconds);
    } else {
        paths += "  switch-audio:\n    source: publisher\n";
    }
    paths += &worker_path("switch-lite", "lite", launcher, false, lite_idle);

    let yaml = format!(
        r#"logLevel: warn
rtsp: true
rtspAddress: 127.0.0.1:8554
hls: false
webrtc: true
webrtcAddress: :8889
webrtcEncryption: no
webrtcAllowOrigins: ['*']
webrtcLocalUDPAddress: :{}
webrtcLocalTCPAddress: :{}
webrtcIPsFromInterfaces: no
webrtcAdditionalHosts: ["{}"]
rtmp: false
srt: false
playback: false
api: false
metrics: false

writeQueueSize: 8192
writeTimeout: 10s
readTimeout: 10s

paths:
{}"#,
        config.media_ice_port, config.media_ice_port, config.media_ice_ip, paths,
    );

    std::fs::write(config_path()?, yaml)
        .map_err(|e| format!("Failed to write MediaMTX config: {e}"))
}

pub fn start() -> Result<u32, String> {
    let binary = bin_path("mediamtx")?;
    let config = config_path()?;

    if !binary.exists() {
        return Err(format!("MediaMTX binary not found: {}", binary.display()));
    }
    if !config.exists() {
        return Err(format!("MediaMTX config not found: {}", config.display()));
    }

    let mut command = Command::new(binary);
    command.arg(&config);
    command.current_dir(app_directory()?);
    spawn_logged(command, "MediaMTX", &log_path("mediamtx")?)
}

fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(app_directory()?.join("mediamtx.yml"))
}
