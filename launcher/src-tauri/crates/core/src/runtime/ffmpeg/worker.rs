use std::time::{Duration, Instant};

use crate::config::{load_runtime_config, AppConfig};
use crate::utils::paths::log_path;
use crate::utils::process::{kill_child, Ffmpeg};

use super::{start_audio, start_lite, start_video, RTSP_ADDRESS};

const STALL: Duration = Duration::from_secs(10);

#[derive(Clone, Copy)]
enum Kind {
    Video,
    Audio,
    Lite,
}

impl Kind {
    fn parse(name: &str) -> Option<Self> {
        match name {
            "video" => Some(Self::Video),
            "audio" => Some(Self::Audio),
            "lite" => Some(Self::Lite),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Video => "FFmpeg video",
            Self::Audio => "FFmpeg audio",
            Self::Lite => "FFmpeg lite",
        }
    }

    fn log(self) -> &'static str {
        match self {
            Self::Video => "ffmpeg-video",
            Self::Audio => "ffmpeg-audio",
            Self::Lite => "ffmpeg-lite",
        }
    }

    async fn start(self, config: &AppConfig) -> Result<Ffmpeg, String> {
        match self {
            Self::Video => start_video(config).await,
            Self::Audio => start_audio(config).await,
            Self::Lite => start_lite().await,
        }
    }
}

/// Runs one FFmpeg stream for MediaMTX, which launches this when the first viewer
/// arrives and stops it a while after the last one leaves. Stopping the worker, by
/// signal, by a dead MediaMTX or by being killed, always takes FFmpeg with it.
pub async fn run(name: &str) -> Result<(), String> {
    let kind = Kind::parse(name).ok_or_else(|| format!("Unknown encode worker: {name}"))?;
    let config = load_runtime_config()?;

    // The log is read back on failure, so it starts clean for this run.
    let _ = std::fs::write(log_path(kind.log())?, "");

    let ffmpeg = kind.start(&config).await?;

    tokio::select! {
        _ = keep_alive(kind, &config, ffmpeg) => {}
        _ = terminated() => {}
        _ = mediamtx_gone() => {}
    }
    Ok(())
}

async fn keep_alive(kind: Kind, config: &AppConfig, mut ffmpeg: Ffmpeg) {
    loop {
        let mut last = 0;
        let mut changed = Instant::now();
        while ffmpeg.alive() {
            let time = ffmpeg.out_time_us();
            if time > last {
                last = time;
                changed = Instant::now();
            } else if changed.elapsed() >= STALL {
                eprintln!(
                    "WORKER: {} frozen, killing PID {}",
                    kind.label(),
                    ffmpeg.child.id()
                );
                kill_child(&mut ffmpeg.child);
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        ffmpeg = restart(kind, config).await;
    }
}

async fn restart(kind: Kind, config: &AppConfig) -> Ffmpeg {
    loop {
        match kind.start(config).await {
            Ok(ffmpeg) => return ffmpeg,
            Err(error) => {
                eprintln!("{} restart failed: {error}", kind.label());
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// A worker whose MediaMTX died would restart FFmpeg forever against a closed port. RTSP
/// refusing connections for 3 seconds in a row, after it once accepted one, means it is gone.
async fn mediamtx_gone() {
    let mut seen = false;
    let mut misses = 0;
    while misses < 3 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if tokio::net::TcpStream::connect(RTSP_ADDRESS).await.is_ok() {
            seen = true;
            misses = 0;
        } else if seen {
            misses += 1;
        }
    }
}

#[cfg(unix)]
async fn terminated() {
    use tokio::signal::unix::{signal, SignalKind};

    let (Ok(mut interrupt), Ok(mut terminate)) = (
        signal(SignalKind::interrupt()),
        signal(SignalKind::terminate()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = interrupt.recv() => {}
        _ = terminate.recv() => {}
    }
}

/// MediaMTX kills a Windows worker outright: FFmpeg then goes with the job it lives in.
#[cfg(not(unix))]
async fn terminated() {
    std::future::pending::<()>().await
}
