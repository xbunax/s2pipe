import type { AppConfig } from "../types.ts";

type Keys<T> = { [K in keyof AppConfig]: AppConfig[K] extends T ? K : never }[keyof AppConfig];

type Props = {
	config: AppConfig;
	updateConfig: <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => void;
};

/** Encoder, capture format and manual device fields, shown in advanced mode. */
export function VideoAdvanced({ config, updateConfig }: Props) {
	const text = (key: Keys<string>, label: string, placeholder: string, id: string = key) => (
		<div className="field">
			<label>
				<span>{label}</span>

				<input
					id={id}
					type="text"
					value={config[key]}
					onInput={(event) => updateConfig(key, event.currentTarget.value)}
					placeholder={placeholder}
				/>
			</label>
		</div>
	);

	const number = (key: Keys<number>, label: string, min: number, max?: number) => (
		<div className="field">
			<label>
				<span>{label}</span>

				<input
					id={key}
					type="number"
					min={min}
					max={max}
					value={config[key]}
					onInput={(event) => updateConfig(key, Number(event.currentTarget.value))}
				/>
			</label>
		</div>
	);

	const select = (key: Keys<string>, label: string, options: [string, string][]) => (
		<div className="field">
			<label>
				<span>{label}</span>

				<select
					id={key}
					value={config[key]}
					onChange={(event) => updateConfig(key, event.currentTarget.value)}
				>
					{options.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
				</select>
			</label>
		</div>
	);

	return (
		<>
			<div className="fields-grid advanced">
				{select("videoEncoder", "Encoder", [
					["auto", "Auto (use the GPU if there is one)"],
					["cpu", "CPU (x264/x265)"],
					["nvenc", "NVIDIA (NVENC)"],
					["amf", "AMD (AMF)"],
					["custom", "Custom command"],
				])}
				{select("videoCodec", "Codec", [
					["h264", "H.264"],
					["h265", "H.265 (HEVC)"],
				])}
			</div>

			<small>
				{config.videoCodec === "h265"
					? "H.265 halves the bitrate but many browsers cannot play it over WebRTC. Use H.264 if the picture stays black."
					: "H.264 plays everywhere. Auto falls back to the CPU when no GPU encoder answers."}
			</small>

			{config.videoEncoder === "custom" && (
				<>
					<div className="fields-grid advanced">
						{text("videoCustom", "Custom encoder command", "my-encoder {device} {width}x{height} {fps}")}
					</div>

					<small>
						The command must print H.264 Annex-B on stdout. Placeholders: {"{device}"} {"{width}"}{" "}
						{"{height}"} {"{fps}"} {"{bitrate}"} (max kbit/s) {"{gop}"} (frames). The codec setting is
						ignored.
					</small>
				</>
			)}

			<div className="fields-grid advanced">
				{number("captureWidth", "Width", 1)}
				{number("captureHeight", "Height", 1)}
			</div>

			<div className="fields-grid advanced">
				{number("captureFps", "FPS", 1, 120)}
				{select("captureFormat", "Capture format", [
					["yuyv422", "yuyv422"],
					["mjpeg", "mjpeg"],
				])}
			</div>

			<div className="fields-grid advanced">
				{text("videoBitrate", "Max video bitrate", "6M")}
				{number("idleStopSeconds", "Stop encoding after (s)", 0)}
			</div>

			<small>
				Quality is constant and the bitrate only caps busy scenes. Capture and encoding start when someone
				opens the stream and stop this many seconds after the last viewer leaves. 0 keeps them always on.
			</small>

			<div className="fields-grid advanced">
				{text("captureDevice", "Capture device", "/dev/video0")}
				{text("captureAudio", "HDMI audio (ALSA)", "hw:0,0", "captureAudioManual")}
			</div>
		</>
	);
}
