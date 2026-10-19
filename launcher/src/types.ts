export interface AppConfig {
	nodePort: string;
	nodeBaseUrl: string;
	nodePassword: string;
	clientPort: string;
	exposure: string;

	mediaIceIp: string;
	mediaIcePort: string;

	captureSource: string;
	captureDevice: string;
	captureAudio: string;
	captureFormat: string;
	captureWidth: number;
	captureHeight: number;
	captureFps: number;

	videoEncoder: string;
	videoCodec: string;
	videoBitrate: string;
	videoCustom: string;
	idleStopSeconds: number;

	picoSerial: string;

	switchBtMac: string;
	controllerBtMac: string;
	controllerBtPid: string;

	launchAtStartup: boolean;
}
