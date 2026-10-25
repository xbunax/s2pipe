import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import {
	buildWifiPacket,
	helloPayload,
	parseAnnouncement,
	parseJsonPayload,
	parseWifiPacket,
	pingPayload,
	WIFI_CONTROL_PORT,
	WIFI_DISCOVERY_PORT,
	WifiType,
} from "@/utils/wifi_protocol.ts";

export type ControllerTransportStatus = {
	kind: "serial" | "wifi";
	connected: boolean;
	path: string | null;
	host: string | null;
	port: number | null;
	deviceId: string | null;
	deviceName: string | null;
	latencyMs: number | null;
	rssi: number | null;
	stats: {
		tx: number;
		rx: number;
		auth: number;
		dup: number;
		old: number;
		oow: number;
		bad: number;
	} | null;
};

export interface ControllerTransport {
	connect(): Promise<void>;
	send(data: Uint8Array): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	status(): ControllerTransportStatus;
	describe(): string;
}

const SERIAL_BAUD = 921600;
const WRITE_TIMEOUT_MS = 250;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function transportError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (Deno.build.os === "linux" && /permission denied/i.test(message)) {
		return `${message} (add your user to dialout, then replug)`;
	}
	return message;
}

function windowsComPort(path: string): string | null {
	const match = path.trim().match(/COM\d+/i);
	return match ? match[0].toUpperCase() : null;
}

function serialPath(path: string): string {
	if (Deno.build.os !== "windows") return path;
	const com = windowsComPort(path);
	return com ? `\\\\.\\${com}` : path;
}

async function setSerialBaud(path: string): Promise<void> {
	let command: Deno.Command;
	if (Deno.build.os === "windows") {
		const com = windowsComPort(path);
		if (!com) throw new Error(`invalid COM port: ${path}`);
		command = new Deno.Command("mode", {
			args: [`${com}:`, `BAUD=${SERIAL_BAUD}`, "PARITY=N", "DATA=8", "STOP=1", "XON=OFF", "OCTS=OFF", "RTS=OFF"],
			stdout: "piped",
			stderr: "piped",
		});
	} else {
		command = new Deno.Command("stty", {
			args: [
				"-F",
				path,
				String(SERIAL_BAUD),
				"raw",
				"-echo",
				"cs8",
				"-parenb",
				"-cstopb",
				"-crtscts",
				"-ixon",
				"-ixoff",
				"clocal",
				"-hupcl",
			],
			stdout: "piped",
			stderr: "piped",
		});
	}

	const result = await command.output();
	if (!result.success) {
		const detail = new TextDecoder().decode(result.stderr).trim() ||
			new TextDecoder().decode(result.stdout).trim() ||
			`exit ${result.code}`;
		throw new Error(`serial baud ${SERIAL_BAUD} failed: ${detail}`);
	}

	if (Deno.build.os === "windows") {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function writeAll(handle: Deno.FsFile, data: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < data.length) {
		const n = await handle.write(data.subarray(offset));
		if (n === 0) throw new Error("serial write stalled");
		offset += n;
	}
}

export class SerialTransport implements ControllerTransport {
	private file: Deno.FsFile | null = null;

	constructor(private readonly path: string) {}

	async connect(): Promise<void> {
		await this.disconnect();
		await setSerialBaud(this.path);
		this.file = await Deno.open(serialPath(this.path), { read: true, write: true });
	}

	async send(data: Uint8Array): Promise<void> {
		const file = this.file;
		if (!file) throw new Error("serial port is not open");
		await withTimeout(writeAll(file, data), WRITE_TIMEOUT_MS, "serial write timeout");
	}

	disconnect(): Promise<void> {
		try {
			this.file?.close();
		} catch {
			// ignore
		}
		this.file = null;
		return Promise.resolve();
	}

	isConnected(): boolean {
		return this.file !== null;
	}

	describe(): string {
		return this.path;
	}

	status(): ControllerTransportStatus {
		return {
			kind: "serial",
			connected: this.file !== null,
			path: this.path,
			host: null,
			port: null,
			deviceId: null,
			deviceName: null,
			latencyMs: null,
			rssi: null,
			stats: null,
		};
	}
}

type HelloAck = {
	nonce?: number;
	session?: number;
	id?: string;
	name?: string;
	ip?: string;
	port?: number;
	fw?: string;
	rssi?: number;
};

type Pong = {
	nonce?: number;
	rssi?: number;
	rx?: number;
	auth?: number;
	dup?: number;
	old?: number;
	oow?: number;
	bad?: number;
	up?: number;
};

type PendingHello = {
	nonce: number;
	timer: ReturnType<typeof setTimeout>;
	resolve: () => void;
	reject: (error: unknown) => void;
};

type PendingPing = {
	nonce: number;
	sentAt: number;
};

const HELLO_TIMEOUT_MS = 2000;
const PING_INTERVAL_MS = 1000;
const PING_TIMEOUT_MS = 3500;

function openUdp(): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		const onError = (error: Error) => {
			socket.close();
			reject(error);
		};
		socket.once("error", onError);
		socket.bind(0, "0.0.0.0", () => {
			socket.removeListener("error", onError);
			resolve(socket);
		});
	});
}

function sendUdp(socket: Socket, data: Uint8Array, port: number, host: string): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.send(data, port, host, (error) => error ? reject(error) : resolve());
	});
}

export type WifiTransportOptions = {
	host: string;
	port?: number;
	key: Uint8Array;
	deviceId?: string;
	autoDiscover?: boolean;
};

export class WifiTransport implements ControllerTransport {
	private socket: Socket | null = null;
	private discoverySocket: Socket | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;
	private connecting = false;

	private host: string;
	private readonly port: number;
	private readonly key: Uint8Array;
	private readonly autoDiscover: boolean;
	private deviceId: string | null;
	private deviceName: string | null = null;
	private session = 0;
	private seq = 1;
	private connected = false;
	private error: string | null = null;
	private lastReplyAt = 0;
	private latencyMs: number | null = null;
	private rssi: number | null = null;
	private pendingHello: PendingHello | null = null;
	private pendingPing: PendingPing | null = null;
	private stats = { tx: 0, rx: 0, auth: 0, dup: 0, old: 0, oow: 0, bad: 0 };

	constructor(options: WifiTransportOptions) {
		this.host = options.host.trim();
		this.port = options.port ?? WIFI_CONTROL_PORT;
		this.key = options.key;
		this.deviceId = options.deviceId?.trim() || null;
		this.autoDiscover = options.autoDiscover ?? false;
		if (!this.host) throw new Error("Wi-Fi controller address is empty");
	}

	async connect(): Promise<void> {
		if (this.connecting) throw new Error("Wi-Fi controller is already connecting");
		this.connecting = true;
		this.error = null;

		try {
			await this.disconnect();
			this.closed = false;
			this.session = 0;
			this.seq = 1;
			this.connected = false;
			this.lastReplyAt = 0;

			const socket = await openUdp();
			this.socket = socket;
			socket.on("message", (message, info) => {
				void this.handlePacket(new Uint8Array(message), info).catch((error) => this.fail(error));
			});
			socket.on("error", (error) => {
				if (!this.closed) this.fail(error);
			});
			await this.startDiscovery();

			const nonce = randomNonce();
			const ready = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pendingHello = null;
					reject(new Error("Wi-Fi controller did not answer (check address, pairing key and 2.4 GHz Wi-Fi)"));
				}, HELLO_TIMEOUT_MS);
				this.pendingHello = { nonce, timer, resolve, reject };
			});

			const hello = await buildWifiPacket(this.key, WifiType.Hello, 0, 1, helloPayload(nonce));
			await sendUdp(socket, hello, this.port, this.host);
			await ready;

			this.connected = true;
			this.lastReplyAt = Date.now();
			this.startPing();
		} catch (error) {
			this.fail(error);
			throw error;
		} finally {
			this.connecting = false;
		}
	}

	async send(data: Uint8Array): Promise<void> {
		const socket = this.socket;
		if (!socket || !this.connected || !this.session) {
			throw new Error("Wi-Fi controller is not connected");
		}
		const packet = await buildWifiPacket(this.key, WifiType.Control, this.session, this.seq++, data);
		try {
			await sendUdp(socket, packet, this.port, this.host);
			this.stats.tx++;
		} catch (error) {
			this.fail(error);
			throw error;
		}
	}

	disconnect(): Promise<void> {
		this.closed = true;
		this.connected = false;
		this.session = 0;
		this.stopPing();
		if (this.pendingHello) {
			clearTimeout(this.pendingHello.timer);
			this.pendingHello.reject(new Error("Wi-Fi controller disconnected"));
			this.pendingHello = null;
		}
		this.pendingPing = null;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore
			}
		}
		this.stopDiscovery();
		return Promise.resolve();
	}

	isConnected(): boolean {
		return this.connected && this.error === null && Date.now() - this.lastReplyAt <= PING_TIMEOUT_MS;
	}

	describe(): string {
		return `${this.deviceName ?? "Pico 2 W"} ${this.host}:${this.port}`;
	}

	status(): ControllerTransportStatus {
		return {
			kind: "wifi",
			connected: this.isConnected(),
			path: null,
			host: this.host,
			port: this.port,
			deviceId: this.deviceId,
			deviceName: this.deviceName,
			latencyMs: this.latencyMs,
			rssi: this.rssi,
			stats: { ...this.stats },
		};
	}

	private async handlePacket(data: Uint8Array, info: RemoteInfo): Promise<void> {
		const packet = await parseWifiPacket(this.key, data);
		if (!packet) {
			this.stats.auth++;
			return;
		}

		if (packet.type === WifiType.HelloAck) {
			const ack = parseJsonPayload<HelloAck>(packet.payload);
			const pending = this.pendingHello;
			if (!ack || typeof ack.nonce !== "number" || !pending || ack.nonce !== pending.nonce) return;
			clearTimeout(pending.timer);
			this.pendingHello = null;
			this.session = packet.session;
			if (ack.id) this.deviceId = ack.id;
			if (ack.name) this.deviceName = ack.name;
			if (typeof ack.rssi === "number") this.rssi = ack.rssi;
			if (info.address) this.host = info.address;
			pending.resolve();
			return;
		}

		if (packet.type !== WifiType.Pong) return;

		const pong = parseJsonPayload<Pong>(packet.payload);
		if (!pong) return;
		this.lastReplyAt = Date.now();
		if (typeof pong.rssi === "number") this.rssi = pong.rssi;
		if (typeof pong.rx === "number") this.stats.rx = pong.rx;
		if (typeof pong.auth === "number") this.stats.auth = pong.auth;
		if (typeof pong.dup === "number") this.stats.dup = pong.dup;
		if (typeof pong.old === "number") this.stats.old = pong.old;
		if (typeof pong.oow === "number") this.stats.oow = pong.oow;
		if (typeof pong.bad === "number") this.stats.bad = pong.bad;

		const pending = this.pendingPing;
		if (pending && typeof pong.nonce === "number" && pong.nonce === pending.nonce) {
			this.latencyMs = Math.max(0, Math.round(performance.now() - pending.sentAt));
			this.pendingPing = null;
		}
	}

	private async startDiscovery(): Promise<void> {
		if (!this.autoDiscover || !this.deviceId) return;
		try {
			const socket = createSocket({ type: "udp4", reuseAddr: true });
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					socket.close();
					reject(error);
				};
				socket.once("error", onError);
				socket.bind(WIFI_DISCOVERY_PORT, "0.0.0.0", () => {
					socket.removeListener("error", onError);
					resolve();
				});
			});
			this.discoverySocket = socket;
			socket.on("message", (message) => {
				const announcement = parseAnnouncement(new Uint8Array(message));
				if (!announcement || announcement.id !== this.deviceId) return;
				if (announcement.name) this.deviceName = announcement.name;
				this.rssi = announcement.rssi;
				if (announcement.ip && announcement.ip !== this.host) this.host = announcement.ip;
			});
			socket.on("error", () => {
				// Discovery is best-effort; control traffic is still authenticated.
			});
		} catch {
			// Another process owns UDP 30101, or broadcasts are blocked. The
			// configured host remains usable.
		}
	}

	private stopDiscovery(): void {
		const socket = this.discoverySocket;
		this.discoverySocket = null;
		if (!socket) return;
		try {
			socket.close();
		} catch {
			// ignore
		}
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = setInterval(() => void this.ping(), PING_INTERVAL_MS);
		void this.ping();
	}

	private stopPing(): void {
		if (this.pingTimer === null) return;
		clearInterval(this.pingTimer);
		this.pingTimer = null;
	}

	private async ping(): Promise<void> {
		const socket = this.socket;
		if (!socket || !this.connected || !this.session) return;

		const now = performance.now();
		if (this.pendingPing && now - this.pendingPing.sentAt > PING_TIMEOUT_MS) {
			this.fail(new Error("Wi-Fi controller stopped responding"));
			return;
		}
		if (this.pendingPing) return;

		const nonce = randomNonce();
		try {
			const packet = await buildWifiPacket(this.key, WifiType.Ping, this.session, this.seq++, pingPayload(nonce));
			await sendUdp(socket, packet, this.port, this.host);
			this.pendingPing = { nonce, sentAt: now };
		} catch (error) {
			this.fail(error);
		}
	}

	private fail(error: unknown): void {
		const message = transportError(error);
		this.error = message;
		void this.disconnect();
		this.error = message;
	}
}

function randomNonce(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

export type TransportOptions =
	| { kind: "serial"; path: string }
	| { kind: "wifi"; host: string; port?: number; key: Uint8Array; deviceId?: string; autoDiscover?: boolean };

export function createTransport(options: TransportOptions): ControllerTransport {
	if (options.kind === "serial") return new SerialTransport(options.path);
	return new WifiTransport(options);
}

export const DISCOVERY_PORT = 30101;
export const DISCOVERY_PROBE = new TextEncoder().encode('{"s2pipe":1,"type":"discover"}');
