import { showError, showSuccess, Toasters, useToasters } from "./components/Toast.tsx";
import { DevicePicker } from "./components/DevicePicker.tsx";
import { VideoAdvanced } from "./components/VideoAdvanced.tsx";
import type { AppConfig } from "./types.ts";
import { useEffect, useState } from "preact/hooks";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

enum Status {
	OFFLINE = "offline",
	CONNECTING = "connecting",
	ONLINE = "online",
	STOPPING = "stopping",
	ERROR = "error",
}

interface Device {
	path: string;
	label: string;
}

interface WakeScanResult {
	switchBtMac: string;
	controllerBtMac: string;
	controllerBtPid: string;
}

interface WifiDevice {
	id: string;
	name: string;
	ip: string;
	port: number;
	disc: number;
	fw: string;
	rssi: number;
	session: number;
	boot: number;
	latencyMs: number | null;
	lastSeenMs: number;
}

interface WifiTestResult {
	id: string;
	name: string;
	ip: string;
	port: number;
	latencyMs: number;
	rssi: number;
	firmware: string;
	pulsed: boolean;
}

interface PicoSetup {
	port: string;
	id: string;
	ssid: string;
	password: string;
	psk: string;
	fw: string;
	mode: string;
}


/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG: AppConfig = {
	nodePort: "5050",
	nodeBaseUrl: "http://localhost:5050",
	nodePassword: "",
	clientPort: "5000",
	exposure: "local",

	mediaIceIp: "127.0.0.1",
	mediaIcePort: "8189",

	captureSource: "test",
	captureDevice: "",
	captureAudio: "",
	captureFormat: "yuyv422",
	captureWidth: 1920,
	captureHeight: 1080,
	captureFps: 60,

	videoEncoder: "auto",
	videoCodec: "h264",
	videoBitrate: "6M",
	videoCustom: "",
	idleStopSeconds: 15,

	picoSerial: "",
	controllerMode: "serial",
	picoWifiHost: "",
	picoWifiPort: "30100",
	picoWifiKey: "",
	picoWifiDeviceId: "",
	picoWifiDeviceName: "",
	picoWifiAutoDiscover: true,

	switchBtMac: "",
	controllerBtMac: "",
	controllerBtPid: "",

	launchAtStartup: false,
};

const RESOLUTION_PRESETS = [
	{ key: "4k", label: "4K", width: 3840, height: 2160 },
	{ key: "1080p", label: "1080p", width: 1920, height: 1080 },
	{ key: "720p", label: "720p", width: 1280, height: 720 },
	{ key: "480p", label: "480p", width: 854, height: 480 },
];

const FPS_PRESETS = [120, 60, 30];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function nodeAddress(ip: string, port: string): string {
	const host = ip === "127.0.0.1" ? "localhost" : ip;
	const trimmed = port.trim();
	return trimmed ? `http://${host}:${trimmed}` : `http://${host}`;
}

function isGeneratedNodeAddress(url: string, ip: string, port: string): boolean {
	const normalized = url.trim().replace(/\/+$/, "");
	if (normalized === nodeAddress(ip, port)) {
		return true;
	}

	if (ip !== "127.0.0.1") {
		return false;
	}

	const trimmed = port.trim();
	return normalized === (trimmed ? `http://127.0.0.1:${trimmed}` : "http://127.0.0.1");
}

function mergeConfig(config: Partial<AppConfig> | null | undefined): AppConfig {
	return {
		...DEFAULT_CONFIG,
		...(config ?? {}),
	};
}

function isValidPort(value: string): boolean {
	const port = Number(value.trim());
	return Number.isInteger(port) && port > 0 && port <= 65535;
}

function maskMac(mac: string): string {
	const parts = mac.trim().split(":");

	if (parts.length !== 6) {
		return mac;
	}

	return `--:--:${parts[4]}:${parts[5]}`;
}

/* -------------------------------------------------------------------------- */
/* App                                                                        */
/* -------------------------------------------------------------------------- */

function App() {
	const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);

	const [status, setStatus] = useState<Status>(Status.OFFLINE);
	const [advancedMode, setAdvancedMode] = useState(false);
	const [loading, setLoading] = useState(true);

	const [captureDevices, setCaptureDevices] = useState<Device[]>([]);
	const [audioDevices, setAudioDevices] = useState<Device[]>([]);
	const [serialPorts, setSerialPorts] = useState<Device[]>([]);

	const [detectingCapture, setDetectingCapture] = useState(false);
	const [detectingAudio, setDetectingAudio] = useState(false);
	const [detectingSerial, setDetectingSerial] = useState(false);

	const [scanning, setScanning] = useState(false);
	const [bluetoothError, setBluetoothError] = useState(false);

	const [wifiDevices, setWifiDevices] = useState<WifiDevice[]>([]);
	const [scanningWifi, setScanningWifi] = useState(false);
	const [testingWifi, setTestingWifi] = useState(false);
	const [pairingPico, setPairingPico] = useState(false);
	const [wifiTest, setWifiTest] = useState<WifiTestResult | null>(null);
	const [picoSetup, setPicoSetup] = useState<PicoSetup | null>(null);
	const [showWifiKey, setShowWifiKey] = useState(false);
	const [wifiProvisionSsid, setWifiProvisionSsid] = useState("");
	const [wifiProvisionPass, setWifiProvisionPass] = useState("");
	const [showProvisionPass, setShowProvisionPass] = useState(false);
	const [provisioningWifi, setProvisioningWifi] = useState(false);

	const toasters = useToasters();

	/* ---------------------------------------------------------------------- */
	/* Derived values                                                         */
	/* ---------------------------------------------------------------------- */

	const bluetoothConfigured = config.switchBtMac.trim() !== "" &&
		config.controllerBtMac.trim() !== "" &&
		config.controllerBtPid.trim() !== "";

	const wifiKeyValid = /^[0-9a-fA-F]{64}$/.test(config.picoWifiKey.trim().replace(/[\s:-]/g, ""));

	const isResolutionActive = (width: number, height: number) =>
		config.captureWidth === width &&
		config.captureHeight === height;

	const isFpsActive = (fps: number) => config.captureFps === fps;

	const captureSelectValue = config.captureSource === "test" ? "test" : config.captureDevice;

	/* ---------------------------------------------------------------------- */
	/* Config                                                                  */
	/* ---------------------------------------------------------------------- */

	function updateConfig<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
		setConfig((current) => {
			const next = {
				...current,
				[key]: value,
			};
			void persistConfig(next);
			return next;
		});
	}

	function applyHost(exposure: string, ip: string) {
		setConfig((current) => {
			const next = {
				...current,
				exposure,
				nodeBaseUrl: nodeAddress(ip, current.nodePort),
				mediaIceIp: ip,
			};
			void persistConfig(next);
			return next;
		});
	}

	function updateNodePort(port: string) {
		setConfig((current) => {
			const generated = isGeneratedNodeAddress(
				current.nodeBaseUrl,
				current.mediaIceIp,
				current.nodePort,
			);

			const next = {
				...current,
				nodePort: port,
				nodeBaseUrl: generated ? nodeAddress(current.mediaIceIp, port) : current.nodeBaseUrl,
			};
			void persistConfig(next);
			return next;
		});
	}

	async function applyExposure(value: string) {
		if (value === "local") {
			applyHost("local", "127.0.0.1");
			return;
		}

		try {
			const ip = await invoke<string>(value === "lan" ? "local_ip" : "public_ip");
			applyHost(value, ip);
		} catch (error) {
			setConfig((current) => {
				const next = { ...current, exposure: value };
				void persistConfig(next);
				return next;
			});
			showError(
				value === "lan" ? "Could not detect the LAN IP." : "Could not detect the public IP.",
				{ description: getErrorMessage(error) },
			);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Initial load                                                            */
	/* ---------------------------------------------------------------------- */

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		let cancelled = false;

		void (async () => {
			unlisten = await listen<string>("stack-status", (event) => {
				if (cancelled) return;
				if (event.payload.startsWith("error:")) {
					setStatus(Status.ERROR);
					showError("Could not start s2pipe.", {
						description: event.payload.slice("error:".length),
					});
				}
			});

			await loadInitialState();
		})();

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	async function loadInitialState() {
		setLoading(true);

		try {
			const lastConfig = await invoke<Partial<AppConfig> | null>("load_last_config");
			const merged = mergeConfig(lastConfig);
			setConfig(merged);

			const running = await invoke<boolean>("is_stack_running");
			if (running) {
				setStatus(Status.ONLINE);
			}
		} catch (error) {
			console.error("load_last_config failed:", error);
		} finally {
			setLoading(false);
			void refreshCaptureDevices(true);
			void refreshAudioDevices(true);
			void refreshSerialPorts();
		}
	}

	async function persistConfig(next: AppConfig) {
		try {
			await invoke("save_app_config", { config: next });
		} catch (error) {
			console.error("save_app_config failed:", error);
			showError("Could not save launcher settings.", {
				description: getErrorMessage(error),
			});
		}
	}

	function setLaunchAtStartup(enabled: boolean) {
		setConfig((current) => {
			const next = { ...current, launchAtStartup: enabled };
			void persistConfig(next);
			return next;
		});
	}

	/* ---------------------------------------------------------------------- */
	/* Capture devices                                                        */
	/* ---------------------------------------------------------------------- */

	async function refreshCaptureDevices(silent = false) {
		setDetectingCapture(true);

		try {
			const devices = await invoke<Device[]>("list_capture_devices");
			setCaptureDevices(devices);

			if (
				config.captureSource !== "test" &&
				devices.length > 0 &&
				!devices.some(
					(device) => device.path === config.captureDevice,
				)
			) {
				// UI-only fallback: do not overwrite the saved CLI/GUI preference.
				setConfig((current) => ({
					...current,
					captureDevice: devices[0].path,
				}));
			}

			if (!silent && devices.length === 0 && config.captureSource !== "test") {
				showError("No capture card detected.");
			}
		} catch (error) {
			console.error("list_capture_devices failed:", error);
			if (!silent) {
				showError("Capture device detection is unavailable.");
			}
		} finally {
			setDetectingCapture(false);
		}
	}

	async function refreshAudioDevices(silent = false) {
		setDetectingAudio(true);

		try {
			const devices = await invoke<Device[]>("list_audio_devices");
			setAudioDevices(devices);

			if (
				config.captureAudio &&
				devices.length > 0 &&
				!devices.some(
					(device) => device.path === config.captureAudio,
				)
			) {
				// UI-only fallback: do not overwrite the saved CLI/GUI preference.
				setConfig((current) => ({
					...current,
					captureAudio: devices[0].path,
				}));
			}
		} catch (error) {
			console.error("list_audio_devices failed:", error);
			if (!silent) {
				showError("Audio device detection is unavailable.");
			}
		} finally {
			setDetectingAudio(false);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Serial ports                                                            */
	/* ---------------------------------------------------------------------- */

	async function refreshSerialPorts() {
		setDetectingSerial(true);

		try {
			const ports = await invoke<Device[]>("list_serial_ports");
			setSerialPorts(ports);
		} catch (error) {
			console.error("list_serial_ports failed:", error);
			showError("Serial port detection is unavailable.");
		} finally {
			setDetectingSerial(false);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Wi-Fi controller                                                        */
	/* ---------------------------------------------------------------------- */

	function selectWifiDevice(device: WifiDevice) {
		setConfig((current) => {
			const next = {
				...current,
				controllerMode: "wifi" as const,
				picoWifiHost: device.ip,
				picoWifiPort: String(device.port),
				picoWifiDeviceId: device.id,
				picoWifiDeviceName: device.name,
			};
			void persistConfig(next);
			return next;
		});
	}

	async function scanWifi() {
		if (scanningWifi) return;
		setScanningWifi(true);
		setWifiTest(null);
		try {
			const devices = await invoke<WifiDevice[]>("discover_wifi_devices", { timeoutMs: 3000 });
			setWifiDevices(devices);
			if (devices.length === 0) {
				showError("No Wi-Fi controller found.", {
					description:
						"Check that the Pico is on the 2.4 GHz Wi-Fi, allow UDP 30101 in the firewall, or type its IP below.",
				});
				return;
			}
			if (devices.length === 1) selectWifiDevice(devices[0]);
		} catch (error) {
			console.error("discover_wifi_devices failed:", error);
			showError("Wi-Fi scan failed.", { description: getErrorMessage(error) });
		} finally {
			setScanningWifi(false);
		}
	}

	async function pairPico() {
		if (pairingPico) return;
		setPairingPico(true);
		try {
			const setup = await invoke<PicoSetup>("read_pico_setup");
			setPicoSetup(setup);
			setConfig((current) => {
				const next = {
					...current,
					controllerMode: "wifi" as const,
					picoWifiKey: setup.psk,
					picoWifiDeviceId: setup.id,
					picoWifiDeviceName: "Pico 2 W",
				};
				void persistConfig(next);
				return next;
			});
			showSuccess("Pico paired.", {
				description:
					`Join ${setup.ssid} from your phone, open http://192.168.4.1, and enter the home 2.4 GHz Wi-Fi.`,
			});
		} catch (error) {
			console.error("read_pico_setup failed:", error);
			showError("Could not read the Pico setup.", { description: getErrorMessage(error) });
		} finally {
			setPairingPico(false);
		}
	}

	async function saveWifiToPico() {
		if (provisioningWifi) return;
		const ssid = wifiProvisionSsid.trim();
		if (!ssid) {
			showError("Enter the 2.4 GHz Wi-Fi name.");
			return;
		}
		if (wifiProvisionPass.length !== 0 && (wifiProvisionPass.length < 8 || wifiProvisionPass.length > 63)) {
			showError("Wi-Fi password must be 8-63 characters, or empty for an open network.");
			return;
		}

		setProvisioningWifi(true);
		try {
			const port = await invoke<string>("provision_pico_wifi", {
				ssid,
				password: wifiProvisionPass,
			});
			showSuccess("Wi-Fi saved to the Pico.", {
				description:
					`Pico is rebooting and will join ${ssid}. USB port: ${port}. After it gets an IP, click Scan Wi-Fi.`,
			});
			setWifiProvisionPass("");
		} catch (error) {
			console.error("provision_pico_wifi failed:", error);
			showError("Could not save Wi-Fi to the Pico.", { description: getErrorMessage(error) });
		} finally {
			setProvisioningWifi(false);
		}
	}

	async function testWifi() {
		if (testingWifi) return;
		if (!isValidPort(config.picoWifiPort)) {
			showError("Pico control port is invalid.");
			return;
		}
		const host = config.picoWifiHost.trim();
		if (!host) {
			showError("Enter the Pico IP address or scan first.");
			return;
		}
		if (!wifiKeyValid) {
			showError("Paste the 64-character pairing key, or use Pair from USB.");
			return;
		}
		setTestingWifi(true);
		try {
			const result = await invoke<WifiTestResult>("test_wifi_device", {
				host,
				port: Number(config.picoWifiPort.trim()),
				keyHex: config.picoWifiKey.trim(),
				pulse: true,
			});
			setWifiTest(result);
			setConfig((current) => {
				const next = {
					...current,
					controllerMode: "wifi" as const,
					picoWifiHost: result.ip,
					picoWifiPort: String(result.port),
					picoWifiDeviceId: result.id || current.picoWifiDeviceId,
					picoWifiDeviceName: result.name || current.picoWifiDeviceName,
				};
				void persistConfig(next);
				return next;
			});
			showSuccess("Controller test passed.", {
				description: `RTT ${result.latencyMs} ms, ${result.rssi} dBm. A was pulsed on pad 1.`,
			});
		} catch (error) {
			console.error("test_wifi_device failed:", error);
			setWifiTest(null);
			showError("Controller test failed.", { description: getErrorMessage(error) });
		} finally {
			setTestingWifi(false);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Capture source                                                          */
	/* ---------------------------------------------------------------------- */

	function handleCaptureSourceChange(value: string) {
		if (value === "test") {
			updateConfig("captureSource", "test");
			return;
		}

		updateConfig("captureSource", "v4l2");
		updateConfig("captureDevice", value);
	}

	/* ---------------------------------------------------------------------- */
	/* Bluetooth                                                               */
	/* ---------------------------------------------------------------------- */

	async function handleScanPad() {
		if (scanning) {
			return;
		}

		setScanning(true);
		setBluetoothError(false);

		try {
			const result = await invoke<WakeScanResult | null>("scan_bluetooth_pad", { timeoutMs: 20000 });
			if (!result) {
				setBluetoothError(true);
				showError("No controller found.", {
					description: "Put the Switch 2 to sleep and press a button on the paired controller.",
				});
				return;
			}

			updateConfig("switchBtMac", result.switchBtMac);
			updateConfig("controllerBtMac", result.controllerBtMac);
			updateConfig("controllerBtPid", result.controllerBtPid);
			setBluetoothError(false);

			showSuccess("Bluetooth controller detected.");
		} catch (error) {
			console.error("scan_bluetooth_pad failed:", error);
			setBluetoothError(true);

			showError("Bluetooth scan failed.", { description: getErrorMessage(error) });
		} finally {
			setScanning(false);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Validation                                                              */
	/* ---------------------------------------------------------------------- */

	function validateConfig(): boolean {
		if (!isValidPort(config.nodePort)) {
			showError("Node port is invalid.");
			return false;
		}

		if (!isValidPort(config.clientPort)) {
			showError("Client port is invalid.");
			return false;
		}

		if (!isValidPort(config.mediaIcePort)) {
			showError("ICE port is invalid.");
			return false;
		}

		if (config.captureWidth <= 0 || config.captureHeight <= 0) {
			showError("Capture resolution is invalid.");
			return false;
		}

		if (config.captureFps <= 0 || config.captureFps > 120) {
			showError("FPS must be between 1 and 120.");
			return false;
		}

		if (config.captureSource !== "test" && !config.captureDevice.trim()) {
			showError("Select a capture device, or use the test source.");
			return false;
		}

		const bluetoothPartiallyConfigured = config.switchBtMac.trim() !== "" ||
			config.controllerBtMac.trim() !== "" ||
			config.controllerBtPid.trim() !== "";

		if (bluetoothPartiallyConfigured && !bluetoothConfigured) {
			showError("Bluetooth configuration is incomplete.");
			return false;
		}

		if (config.controllerMode === "wifi") {
			if (!config.picoWifiHost.trim()) {
				showError("Pico Wi-Fi address is empty.", {
					description: "Click Scan, pick a device, or type the Pico IP address.",
				});
				return false;
			}
			if (!isValidPort(config.picoWifiPort)) {
				showError("Pico Wi-Fi control port is invalid.");
				return false;
			}
			if (!wifiKeyValid) {
				showError("Pico Wi-Fi pairing key is missing or invalid.", {
					description: "Use Pair from USB or paste the 64-character key.",
				});
				return false;
			}
		}

		return true;
	}

	/* ---------------------------------------------------------------------- */
	/* Start                                                                   */
	/* ---------------------------------------------------------------------- */

	async function handleSubmit(event: SubmitEvent) {
		event.preventDefault();

		if (status === Status.ONLINE || status === Status.CONNECTING || status === Status.STOPPING) {
			return;
		}

		if (!validateConfig()) {
			return;
		}

		setStatus(Status.CONNECTING);

		try {
			await invoke("start_s2pipe", { config });
			setStatus(Status.ONLINE);

			showSuccess("s2pipe started.");
		} catch (error) {
			console.error("start_s2pipe failed:", error);
			setStatus(Status.ERROR);

			showError("Could not start s2pipe.", { description: getErrorMessage(error) });
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Stop                                                                    */
	/* ---------------------------------------------------------------------- */

	async function stopS2Pipe() {
		if (status !== Status.ONLINE) {
			return;
		}

		setStatus(Status.STOPPING);

		try {
			await invoke("stop_s2pipe");
			setStatus(Status.OFFLINE);

			showSuccess("s2pipe stopped.");
		} catch (error) {
			console.error("stop_s2pipe failed:", error);
			setStatus(Status.ERROR);

			showError(
				"Could not stop s2pipe.",
				{
					description: getErrorMessage(error),
				},
			);
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Status                                                                  */
	/* ---------------------------------------------------------------------- */

	function renderStatus() {
		switch (status) {
			case Status.CONNECTING:
				return "Connecting...";

			case Status.ONLINE:
				return "Online";

			case Status.STOPPING:
				return "Stopping...";

			case Status.ERROR:
				return "Error";

			case Status.OFFLINE:
			default:
				return "Offline";
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Loading                                                                 */
	/* ---------------------------------------------------------------------- */

	if (loading) {
		return (
			<main>
				<header>
					<h1 className="brand">
						<span>s2</span>pipe
					</h1>

					<p className="pill">
						Loading...
					</p>
				</header>

				<div>
					Loading configuration...
				</div>

				<Toasters toasters={toasters} />
			</main>
		);
	}

	/* ---------------------------------------------------------------------- */
	/* Render                                                                  */
	/* ---------------------------------------------------------------------- */

	return (
		<main>
			<header>
				<h1 className="brand">
					<span>s2</span>pipe
				</h1>

				<p
					className="pill"
					data-ok={status === Status.ONLINE ? "true" : status === Status.ERROR ? "false" : undefined}
					data-busy={status === Status.CONNECTING || status === Status.STOPPING ? "true" : undefined}
				>
					{renderStatus()}
				</p>
			</header>

			<form onSubmit={handleSubmit}>
				<div className="form-body">
					{/* ---------------------------------------------------------------- */}
					{/* Node & Client                                                     */}
					{/* ---------------------------------------------------------------- */}

					<fieldset>
						<section>
							<h2>Node & Client</h2>
							<p>
								HTTP/WebSocket node and browser client ports.
							</p>
						</section>

						<label>
							<span>
								Where do you want to be able to access it
							</span>

							<select
								id="exposure"
								value={config.exposure}
								onChange={(event) =>
									void applyExposure(
										(event.currentTarget as HTMLSelectElement).value,
									)}
							>
								<option value="local">
									This PC only
								</option>

								<option value="lan">
									LAN (my local network)
								</option>

								<option value="wan">
									Accessible from the internet
								</option>
							</select>

							<small>
								{config.exposure === "local" &&
									"Everything runs on this machine. Keep the default values."}

								{config.exposure === "lan" &&
									"Filled with this PC's LAN address so other devices on the network can reach it."}

								{config.exposure === "wan" &&
									"Filled with this PC's public IP. Set a node password below so browsers must authenticate."}
							</small>
						</label>

						{config.exposure !== "local" && (
							<label>
								<span>Node address</span>

								<input
									id="nodeBaseUrl"
									type="url"
									value={config.nodeBaseUrl}
									onInput={(event) =>
										updateConfig(
											"nodeBaseUrl",
											(
												event.currentTarget as HTMLInputElement
											).value,
										)}
									placeholder="http://192.168.1.20:5050"
								/>

								<small>
									This is the address browsers will use to connect.
								</small>
							</label>
						)}

						<label>
							<span>Node password</span>

							<input
								id="nodePassword"
								type="password"
								value={config.nodePassword}
								onInput={(event) =>
									updateConfig(
										"nodePassword",
										(event.currentTarget as HTMLInputElement).value,
									)}
								placeholder="Leave empty to skip authentication"
								autocomplete="new-password"
							/>

							<small>
								Browsers are asked for it only when the node refuses the connection. It is sent as Authorization on every node request.
							</small>
						</label>

						{advancedMode && (
							<div className="fields-grid advanced">
								<div className="field">
									<label>
										<span>Node port</span>

										<input
											id="nodePort"
											type="text"
											value={config.nodePort}
											onInput={(event) =>
												updateNodePort(
													(
														event.currentTarget as HTMLInputElement
													).value,
												)}
											placeholder="5050"
										/>
									</label>
								</div>

								<div className="field">
									<label>
										<span>Client port</span>

										<input
											id="clientPort"
											type="text"
											value={config.clientPort}
											onInput={(event) =>
												updateConfig(
													"clientPort",
													(
														event.currentTarget as HTMLInputElement
													).value,
												)}
											placeholder="5000"
										/>
									</label>
								</div>
							</div>
						)}
					</fieldset>

					{/* ---------------------------------------------------------------- */}
					{/* Media / ICE                                                       */}
					{/* ---------------------------------------------------------------- */}

					{advancedMode && (
						<fieldset className="advanced">
							<section>
								<h2>Media / ICE</h2>

								<p>
									WebRTC ICE endpoint used for the video/audio stream.
								</p>
							</section>

							<div className="fields-grid advanced">
								<div className="field">
									<label>
										<span>ICE IP</span>

										<input
											id="mediaIceIp"
											type="text"
											value={config.mediaIceIp}
											onInput={(event) =>
												updateConfig(
													"mediaIceIp",
													(
														event.currentTarget as HTMLInputElement
													).value,
												)}
											placeholder="127.0.0.1"
										/>
									</label>
								</div>

								<div className="field">
									<label>
										<span>ICE port (UDP)</span>

										<input
											id="mediaIcePort"
											type="text"
											value={config.mediaIcePort}
											onInput={(event) =>
												updateConfig(
													"mediaIcePort",
													(
														event.currentTarget as HTMLInputElement
													).value,
												)}
											placeholder="8189"
										/>
									</label>
								</div>
							</div>
						</fieldset>
					)}

					{/* ---------------------------------------------------------------- */}
					{/* Capture                                                            */}
					{/* ---------------------------------------------------------------- */}

					<fieldset>
						<section>
							<h2>Capture</h2>

							<p>
								HDMI capture source and encode settings.
							</p>
						</section>

						<label>
							<span>Video source</span>

							<DevicePicker
								id="captureSource"
								value={captureSelectValue}
								placeholder={{
									value: "test",
									label: "Test (color bars, no hardware needed)",
								}}
								options={captureDevices}
								detecting={detectingCapture}
								onChange={handleCaptureSourceChange}
								onRefresh={() => void refreshCaptureDevices()}
							/>

							<small>
								Choose your HDMI capture card or use Test without hardware.
							</small>
						</label>

						<div className="field">
							<label>
								<span>
									Audio source
								</span>

								<DevicePicker
									id="captureAudio"
									value={config.captureAudio}
									placeholder={{ value: "", label: "None" }}
									options={audioDevices}
									detecting={detectingAudio}
									onChange={(value) => updateConfig("captureAudio", value)}
									onRefresh={() => void refreshAudioDevices()}
								/>

								<small>
									Choose the audio input from your HDMI capture device.
								</small>
							</label>
						</div>

						<div className="presets-block">
							<span>Resolution</span>

							<div className="presets">
								{RESOLUTION_PRESETS.map((preset) => (
									<button
										type="button"
										key={preset.key}
										className={`preset-btn${
											isResolutionActive(
													preset.width,
													preset.height,
												)
												? " active"
												: ""
										}`}
										onClick={() => {
											updateConfig(
												"captureWidth",
												preset.width,
											);

											updateConfig(
												"captureHeight",
												preset.height,
											);
										}}
									>
										{preset.label}
									</button>
								))}
							</div>
						</div>

						<div className="presets-block">
							<span>FPS</span>

							<div className="presets">
								{FPS_PRESETS.map((fps) => (
									<button
										type="button"
										key={fps}
										className={`preset-btn${isFpsActive(fps) ? " active" : ""}`}
										onClick={() =>
											updateConfig(
												"captureFps",
												fps,
											)}
									>
										{fps}
									</button>
								))}
							</div>
						</div>

						{advancedMode && <VideoAdvanced config={config} updateConfig={updateConfig} />}
					</fieldset>

					{/* ---------------------------------------------------------------- */}
					{/* Pico                                                               */}
					{/* ---------------------------------------------------------------- */}

					<fieldset>
						<section>
							<h2>Pico</h2>

							<p>
								USB UART or Wi-Fi link to the Pico that drives the USB pads.
							</p>
						</section>

						<div className="presets-block">
							<span>Controller transport</span>

							<div className="presets">
								<button
									type="button"
									className={`preset-btn${config.controllerMode === "serial" ? " active" : ""}`}
									onClick={() => updateConfig("controllerMode", "serial")}
								>
									USB Serial
								</button>

								<button
									type="button"
									className={`preset-btn${config.controllerMode === "wifi" ? " active" : ""}`}
									onClick={() => updateConfig("controllerMode", "wifi")}
								>
									Wi-Fi
								</button>
							</div>
						</div>

						{config.controllerMode === "serial"
							? (
								<>
									<label>
										<span>Pico port</span>

										<DevicePicker
											id="picoSerial"
											value={config.picoSerial}
											placeholder={{ value: "", label: "None (video only)" }}
											options={serialPorts}
											detecting={detectingSerial}
											onChange={(value) => updateConfig("picoSerial", value)}
											onRefresh={() => void refreshSerialPorts()}
										/>

										<small>
											Choose None if you only need video.
										</small>
									</label>

									{advancedMode && (
										<div className="fields-grid advanced">
											<div className="field">
												<label>
													<span>Manual port</span>

													<input
														id="picoSerialManual"
														type="text"
														value={config.picoSerial}
														onInput={(event) =>
															updateConfig(
																"picoSerial",
																(
																	event.currentTarget as HTMLInputElement
																).value,
															)}
														placeholder="/dev/ttyUSB0 or COM3"
													/>
												</label>
											</div>
										</div>
									)}
								</>
							)
							: (
								<div className="wifi-controller">
									<div className="select-with-button">
										<button
											type="button"
											onClick={() => void scanWifi()}
											disabled={scanningWifi}
										>
											{scanningWifi ? "Scanning..." : "Scan Wi-Fi"}
										</button>

										<button
											type="button"
											onClick={() => void pairPico()}
											disabled={pairingPico}
										>
											{pairingPico ? "Reading USB..." : "Pair from USB"}
										</button>
									</div>

									<div className="wifi-setup">
										<strong>Configure Wi-Fi via USB</strong>
										<p>
											Connect the Pico to this PC with a data USB cable. The password is
											sent only over USB and is not stored by the launcher.
										</p>

										<div className="field">
											<label>
												<span>Wi-Fi name (2.4 GHz)</span>

												<input
													id="wifiProvisionSsid"
													type="text"
													value={wifiProvisionSsid}
													onInput={(event) =>
														setWifiProvisionSsid(
															(event.currentTarget as HTMLInputElement).value,
														)}
													placeholder="Example_2.4G"
													autocomplete="off"
													autocapitalize="off"
												/>
											</label>
										</div>

										<div className="field">
											<label htmlFor="wifiProvisionPass">
												<span>Wi-Fi password</span>
											</label>

											<div className="key-row">
												<input
													id="wifiProvisionPass"
													type={showProvisionPass ? "text" : "password"}
													value={wifiProvisionPass}
													onInput={(event) =>
														setWifiProvisionPass(
															(event.currentTarget as HTMLInputElement).value,
														)}
													placeholder="8-63 characters, empty for open"
													autocomplete="new-password"
												/>

												<button
													type="button"
													onClick={() => setShowProvisionPass((value) => !value)}
												>
													{showProvisionPass ? "Hide" : "Show"}
												</button>
											</div>
										</div>

										<button
											type="button"
											className="wifi-save-button"
											onClick={() => void saveWifiToPico()}
											disabled={provisioningWifi}
										>
											{provisioningWifi ? "Saving..." : "Save Wi-Fi to Pico"}
										</button>
									</div>

									{wifiDevices.length > 0 && (
										<div className="wifi-devices">
											{wifiDevices.map((device) => (
												<button
													type="button"
													key={device.id}
													className={`wifi-device${
														device.ip === config.picoWifiHost ? " active" : ""
													}`}
													onClick={() => selectWifiDevice(device)}
												>
													<strong>{device.name}</strong>
													<span>{device.ip}:{device.port}</span>
													<span>
														{device.rssi} dBm{device.fw ? ` · ${device.fw}` : ""}
													</span>
												</button>
											))}
										</div>
									)}

									{picoSetup && (
										<div className="wifi-setup">
											<strong>Pico setup hotspot</strong>
											<p>
												On your phone join <code>{picoSetup.ssid}</code>{" "}
												with password <code>{picoSetup.password}</code>, then open{" "}
												<code>http://192.168.4.1</code> and enter the 2.4 GHz Wi-Fi
												name and password.
											</p>
											<p>The pairing key was read over USB and saved.</p>
										</div>
									)}

									<div className="fields-grid">
										<div className="field">
											<label>
												<span>Pico IP</span>

												<input
													id="picoWifiHost"
													type="text"
													value={config.picoWifiHost}
													onInput={(event) =>
														updateConfig(
															"picoWifiHost",
															(event.currentTarget as HTMLInputElement).value,
														)}
													placeholder="192.168.1.120"
												/>
											</label>
										</div>

										<div className="field">
											<label>
												<span>Control port</span>

												<input
													id="picoWifiPort"
													type="text"
													value={config.picoWifiPort}
													onInput={(event) =>
														updateConfig(
															"picoWifiPort",
															(event.currentTarget as HTMLInputElement).value,
														)}
													placeholder="30100"
												/>
											</label>
										</div>
									</div>

									<div className="field">
										<label htmlFor="picoWifiKey">
											<span>Pairing key</span>
										</label>

										<div className="key-row">
											<input
												id="picoWifiKey"
												type={showWifiKey ? "text" : "password"}
												value={config.picoWifiKey}
												onInput={(event) =>
													updateConfig(
														"picoWifiKey",
														(event.currentTarget as HTMLInputElement).value,
													)}
												placeholder="64 hex characters"
												autocomplete="off"
											/>

											<button
												type="button"
												onClick={() => setShowWifiKey((value) => !value)}
											>
												{showWifiKey ? "Hide" : "Show"}
											</button>
										</div>

										<small>
											Read automatically by Pair from USB, or paste the key shown on the
											Pico setup page.
										</small>
									</div>

									<div className="select-with-button">
										<button
											type="button"
											onClick={() => void testWifi()}
											disabled={testingWifi}
										>
											{testingWifi ? "Testing..." : "Test controller"}
										</button>

										<button
											type="button"
											onClick={() => void scanWifi()}
											disabled={scanningWifi}
										>
											{scanningWifi ? "Scanning..." : "Scan again"}
										</button>
									</div>

									{wifiTest
										? (
											<p className="wifi-status">
												<strong>Connected</strong> · {wifiTest.name} · {wifiTest.ip}:
												{wifiTest.port} · RTT {wifiTest.latencyMs} ms · {wifiTest.rssi}{" "}
												dBm{wifiTest.pulsed ? " · A pulsed on pad 1" : ""}
											</p>
										)
										: (
											<p className="wifi-status muted">
												Status: not tested. The Pico must be on the same LAN.
											</p>
										)}

									<small>
										Pico 2 W supports 2.4 GHz Wi-Fi only. If Scan cannot see it, type
										the IP manually (AP isolation or firewall can block UDP 30101).
									</small>
								</div>
							)}
					</fieldset>

					{/* ---------------------------------------------------------------- */}
					{/* Bluetooth                                                          */}
					{/* ---------------------------------------------------------------- */}

					<fieldset>
						<section>
							<h2>Sleep wake (Bluetooth)</h2>

							<p>
								Optional: wake the Switch 2 from sleep using a paired controller.
							</p>
						</section>

						<div className="select-with-button">
							<button
								type="button"
								onClick={() => void handleScanPad()}
								disabled={scanning}
								id="scan-pad-button"
								className={bluetoothError ? "button-error" : ""}
							>
								{scanning
									? "Listening..."
									: bluetoothConfigured
									? "Bluetooth configured"
									: "Listen for controller"}
							</button>
						</div>

						<small>
							{bluetoothConfigured
								? `Controller ${maskMac(config.controllerBtMac)} configured.`
								: "Pair the controller with the Switch normally first, put the console to sleep, then press a button."}
						</small>

						{advancedMode && (
							<>
								<div className="fields-grid advanced">
									<div className="field">
										<label>
											<span>
												Switch Bluetooth MAC
											</span>

											<input
												id="switchBtMac"
												type="text"
												value={config.switchBtMac}
												onInput={(event) =>
													updateConfig(
														"switchBtMac",
														(
															event.currentTarget as HTMLInputElement
														).value,
													)}
												placeholder="AA:BB:CC:DD:EE:FF"
											/>
										</label>
									</div>

									<div className="field">
										<label>
											<span>
												Controller Bluetooth MAC
											</span>

											<input
												id="controllerBtMac"
												type="text"
												value={config.controllerBtMac}
												onInput={(event) =>
													updateConfig(
														"controllerBtMac",
														(
															event.currentTarget as HTMLInputElement
														).value,
													)}
												placeholder="AA:BB:CC:DD:EE:FF"
											/>
										</label>
									</div>
								</div>

								<div className="fields-grid advanced">
									<div className="field">
										<label>
											<span>
												Controller Bluetooth PID
											</span>

											<input
												id="controllerBtPid"
												type="text"
												value={config.controllerBtPid}
												onInput={(event) =>
													updateConfig(
														"controllerBtPid",
														(
															event.currentTarget as HTMLInputElement
														).value,
													)}
												placeholder="0x2069"
											/>
										</label>
									</div>
								</div>
							</>
						)}
					</fieldset>

					{/* ---------------------------------------------------------------- */}
					{/* Launcher                                                           */}
					{/* ---------------------------------------------------------------- */}

					<fieldset>
						<section>
							<h2>Launcher</h2>

							<p>
								Behavior of this launcher app, separate from s2pipe itself.
							</p>
						</section>

						<div className="toggles">
							<label className="toggle">
								<input
									type="checkbox"
									checked={config.launchAtStartup}
									onChange={(event) =>
										setLaunchAtStartup(
											(
												event.currentTarget as HTMLInputElement
											).checked,
										)}
								/>

								<span className="toggle-ui" />

								<div>
									<strong>
										Launch at startup
									</strong>

									<small>
										Start s2pipe in the background, without a window (at boot on Linux, on login on Windows).
									</small>
								</div>
							</label>
						</div>
					</fieldset>
				</div>

				{/* ---------------------------------------------------------------- */}
				{/* Bottom controls                                                    */}
				{/* ---------------------------------------------------------------- */}

				<div className="mode-row">
					<label className="switch">
						<input
							type="checkbox"
							checked={advancedMode}
							onChange={(event) =>
								setAdvancedMode(
									(
										event.currentTarget as HTMLInputElement
									).checked,
								)}
						/>

						<span className="switch-ui" />

						<span className="switch-label">
							Advanced settings
						</span>
					</label>

					<div className="actions">
						<button
							type="button"
							className="stop"
							disabled={status !== Status.ONLINE}
							onClick={() => void stopS2Pipe()}
						>
							Stop
						</button>

						<button
							type="submit"
							className={status === Status.CONNECTING ? "start starting" : "start"}
							disabled={status === Status.ONLINE || status === Status.STOPPING}
							aria-busy={status === Status.CONNECTING ? "true" : undefined}
						>
							{status === Status.CONNECTING ? "Starting..." : "Start s2pipe"}
						</button>
					</div>
				</div>
			</form>

			<Toasters toasters={toasters} />
		</main>
	);
}

export default App;
