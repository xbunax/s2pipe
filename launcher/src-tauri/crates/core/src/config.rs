use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub node_port: String,
    pub node_base_url: String,
    #[serde(default)]
    pub node_password: String,
    pub client_port: String,
    pub exposure: String,

    pub media_ice_ip: String,
    pub media_ice_port: String,

    pub capture_source: String,
    pub capture_device: String,
    pub capture_audio: String,
    pub capture_format: String,
    pub capture_width: u32,
    pub capture_height: u32,
    pub capture_fps: u32,

    /// auto, cpu, nvenc, amf, or custom to run `video_custom` instead of FFmpeg's encoders.
    pub video_encoder: String,
    pub video_codec: String,
    /// Ceiling for busy scenes, not a target: quality is constant and quiet scenes cost less.
    pub video_bitrate: String,
    /// Shell command printing H.264 Annex-B on stdout.
    /// Placeholders: {device} {width} {height} {fps} {bitrate} (kbit/s) {gop} (frames).
    pub video_custom: String,
    /// Seconds without a viewer before capture and encoding stop. 0 keeps them always on.
    pub idle_stop_seconds: u32,

    pub pico_serial: String,

    pub switch_bt_mac: String,
    pub controller_bt_mac: String,
    pub controller_bt_pid: String,

    pub launch_at_startup: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            node_port: "5050".into(),
            node_base_url: "http://localhost:5050".into(),
            node_password: String::new(),
            client_port: "5000".into(),
            exposure: "local".into(),
            media_ice_ip: "127.0.0.1".into(),
            media_ice_port: "8189".into(),
            capture_source: "test".into(),
            capture_device: String::new(),
            capture_audio: String::new(),
            capture_format: "yuyv422".into(),
            capture_width: 1920,
            capture_height: 1080,
            capture_fps: 60,
            video_encoder: "auto".into(),
            video_codec: "h264".into(),
            video_bitrate: "6M".into(),
            video_custom: String::new(),
            idle_stop_seconds: 15,
            pico_serial: String::new(),
            switch_bt_mac: String::new(),
            controller_bt_mac: String::new(),
            controller_bt_pid: String::new(),
            launch_at_startup: false,
        }
    }
}

pub fn load_config() -> Result<Option<AppConfig>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let json = std::fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {e}"))?;
    let config = serde_json::from_str(&json).map_err(|e| format!("Failed to parse config: {e}"))?;
    Ok(Some(config))
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    crate::utils::paths::ensure_app_directory()?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {e}"))?;
    std::fs::write(config_path()?, json).map_err(|e| format!("Failed to write config: {e}"))?;
    Ok(())
}

fn config_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::utils::paths::app_directory()?.join("config.json"))
}

/// The configuration the running stack was started with, which can differ from
/// `config.json` (CLI flags). MediaMTX launches the encode workers long after the
/// start, and they read it from here.
pub fn save_runtime_config(config: &AppConfig) -> Result<(), String> {
    let json = serde_json::to_string(config)
        .map_err(|e| format!("Failed to serialize runtime config: {e}"))?;
    std::fs::write(runtime_config_path()?, json)
        .map_err(|e| format!("Failed to write runtime config: {e}"))
}

pub fn load_runtime_config() -> Result<AppConfig, String> {
    let json = std::fs::read_to_string(runtime_config_path()?)
        .map_err(|e| format!("Failed to read runtime config: {e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("Invalid runtime config: {e}"))
}

fn runtime_config_path() -> Result<std::path::PathBuf, String> {
    Ok(crate::utils::paths::app_directory()?.join("runtime.json"))
}
