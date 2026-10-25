import { config } from "@/config.ts";
import {
	type ControllerTransport,
	createTransport,
	transportError,
	type TransportOptions,
} from "@/services/transport.ts";
import { encodePacket, type WakeAddrs } from "@/utils/packet.ts";
import { decodeHexKey } from "@/utils/wifi_protocol.ts";
import { neutralPad, PAD_COUNT, type PadState, samePad, sanitizePad } from "@s2pipe/shared/types/pad";
import type { PicoStatus } from "@s2pipe/shared/types/node";

const FLUSH_MS = 8;
const KEEPALIVE_TICKS = 12;
const WAKE_MS = 10_000;

const pads: PadState[] = Array.from({ length: PAD_COUNT }, () => neutralPad());

let transport: ControllerTransport | null = null;
let picoError: string | null = null;
let lastLoggedError: string | null = null;
let dirty = false;
let flushing = false;
let connecting = false;
let wakeOnce: WakeAddrs | null = null;
let wakeHold = false;
let lastWakeMs = 0;
let ticks = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;

export function setPad(index: number, state: PadState): void {
	const next = sanitizePad(state);
	if (samePad(pads[index]!, next)) return;
	pads[index] = next;
	dirty = true;
	void flush();
}

export function clearPad(index: number): void {
	pads[index] = neutralPad();
	dirty = true;
	void flush();
}

export function picoStatus(): PicoStatus {
	const status = transport?.status() ?? null;
	const kind = status?.kind ?? (config.picoTransport === "wifi" ? "wifi" : "serial");
	return {
		connected: status?.connected ?? false,
		transport: kind,
		path: status?.path ?? null,
		device: status?.deviceName ?? status?.deviceId ?? null,
		ip: status?.host ?? null,
		error: picoError,
		wake: Boolean(config.switchBtMac && config.controllerBtMac),
		latencyMs: status?.latencyMs ?? null,
		rssi: status?.rssi ?? null,
		stats: status?.stats ?? null,
	};
}

function queueWake(): void {
	if (!transport || !config.switchBtMac || !config.controllerBtMac) return;
	wakeOnce = {
		switchMac: config.switchBtMac,
		padMac: config.controllerBtMac,
		pid: config.controllerBtPid,
	};
	lastWakeMs = Date.now();
	dirty = true;
}

export function setWakeHold(on: boolean): void {
	if (on === wakeHold) return;
	wakeHold = on;
	if (!on) {
		wakeOnce = null;
		lastWakeMs = 0;
		return;
	}
	queueWake();
	void flush();
}

function transportOptions(): TransportOptions | null {
	if (config.picoTransport === "wifi") {
		if (!config.picoWifiHost) {
			picoError = "Wi-Fi controller address is empty";
			return null;
		}
		if (!config.picoWifiKey) {
			picoError = "Wi-Fi controller pairing key is empty";
			return null;
		}
		try {
			return {
				kind: "wifi",
				host: config.picoWifiHost,
				port: config.picoWifiPort,
				key: decodeHexKey(config.picoWifiKey),
				deviceId: config.picoWifiDeviceId || undefined,
				autoDiscover: config.picoWifiAutoDiscover,
			};
		} catch (error) {
			picoError = transportError(error);
			return null;
		}
	}

	if (!config.picoSerial) {
		picoError = null;
		return null;
	}
	return { kind: "serial", path: config.picoSerial };
}

async function flush(): Promise<void> {
	const current = transport;
	if (!current || !current.isConnected() || !dirty || flushing) return;
	flushing = true;
	try {
		while (transport && dirty) {
			dirty = false;
			const wake = wakeOnce;
			wakeOnce = null;
			try {
				await transport.send(encodePacket(pads, wake));
			} catch (error) {
				if (wake) wakeOnce = wake;
				throw error;
			}
			picoError = null;
		}
	} catch (error) {
		const message = transportError(error);
		picoError = message;
		if (message !== lastLoggedError) {
			console.error(`pico ${message}`);
			lastLoggedError = message;
		}
		closePico();
	} finally {
		flushing = false;
	}
}

function closePico(): void {
	stopFlush();
	const current = transport;
	transport = null;
	if (current) void current.disconnect();
}

function stopFlush(): void {
	if (flushTimer === null) return;
	clearInterval(flushTimer);
	flushTimer = null;
}

function startFlush(): void {
	if (flushTimer !== null) return;
	ticks = 0;
	flushTimer = setInterval(() => {
		ticks++;
		if (ticks >= KEEPALIVE_TICKS) {
			ticks = 0;
			dirty = true;
		}
		if (wakeHold && Date.now() - lastWakeMs >= WAKE_MS) queueWake();
		void flush();
	}, FLUSH_MS);
}

async function openPico(): Promise<void> {
	if (connecting || transport?.isConnected()) return;

	if (transport && !transport.isConnected()) {
		const stale = transport;
		transport = null;
		try {
			await stale.disconnect();
		} catch {
			// ignore
		}
	}

	const options = transportOptions();
	if (!options) {
		stopFlush();
		return;
	}

	connecting = true;
	try {
		const next = createTransport(options);
		await next.connect();
		transport = next;
		picoError = null;
		lastLoggedError = null;
		console.info(`pico open ${next.describe()}`);
		dirty = true;
		startFlush();
		if (wakeHold) queueWake();
		await flush();
	} catch (error) {
		const message = transportError(error);
		picoError = message;
		if (message !== lastLoggedError) {
			console.error(`pico ${message}`);
			lastLoggedError = message;
		}
		if (transport) {
			const failed = transport;
			transport = null;
			try {
				await failed.disconnect();
			} catch {
				// ignore
			}
		}
		stopFlush();
	} finally {
		connecting = false;
	}
}

export async function startPico(): Promise<void> {
	if (config.picoTransport === "wifi" && (!config.picoWifiHost || !config.picoWifiKey)) {
		transportOptions();
		return;
	}
	if (config.picoTransport !== "wifi" && !config.picoSerial) {
		picoError = null;
		return;
	}

	await openPico();
	if (retryTimer === null) {
		retryTimer = setInterval(() => {
			if (!transport?.isConnected()) void openPico();
		}, 5000);
	}
}
