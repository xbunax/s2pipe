import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

import { buildWifiPacket, decodeHexKey, parseWifiPacket, SequenceWindow, WifiType } from "@/utils/wifi_protocol.ts";
import { decodePacket } from "@/utils/packet.ts";
import { neutralPad, PAD_COUNT, type PadState } from "@s2pipe/shared/types/pad";

export type FakePicoOptions = {
	key: Uint8Array;
	deviceId?: string;
	name?: string;
	hostname?: string;
	port?: number;
	rssi?: number;
};

export type FakePicoStats = {
	rx: number;
	auth: number;
	dup: number;
	old: number;
	oow: number;
	bad: number;
	hello: number;
	ping: number;
	test: number;
};

/**
 * Software stand-in for the Pico Wi-Fi control endpoint. It implements the
 * same session, HMAC, sequence-window, failsafe and 8-pad rules as the
 * firmware, so the Node transport and the protocol can be tested without a
 * board.
 */
export class FakePico {
	readonly key: Uint8Array;
	readonly deviceId: string;
	readonly name: string;
	readonly pads: PadState[] = Array.from({ length: PAD_COUNT }, () => neutralPad());
	readonly stats: FakePicoStats = {
		rx: 0,
		auth: 0,
		dup: 0,
		old: 0,
		oow: 0,
		bad: 0,
		hello: 0,
		ping: 0,
		test: 0,
	};

	session = 0;
	lastValidAt = 0;
	neutralized = 0;
	lastAppliedSeq = 0;

	private readonly sequence = new SequenceWindow();
	private readonly hostname: string;
	private readonly requestedPort: number;
	private readonly rssi: number;
	private socket: Socket | null = null;
	private boundPort = 0;
	private txSeq = 1;
	private closed = false;

	constructor(options: FakePicoOptions) {
		this.key = options.key;
		this.deviceId = options.deviceId ?? "fake0001fake0001";
		this.name = options.name ?? "Fake Pico 2 W";
		this.hostname = options.hostname ?? "127.0.0.1";
		this.requestedPort = options.port ?? 0;
		this.rssi = options.rssi ?? -42;
	}

	get port(): number {
		return this.boundPort;
	}

	async start(): Promise<number> {
		if (this.socket) return this.boundPort;
		this.closed = false;
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				socket.close();
				reject(error);
			};
			socket.once("error", onError);
			socket.bind(this.requestedPort, this.hostname, () => {
				socket.removeListener("error", onError);
				resolve();
			});
		});
		this.socket = socket;
		this.boundPort = socket.address().port;
		socket.on("message", (message, info) => {
			void this.handle(new Uint8Array(message), info).catch((error) => {
				console.error("fake pico handler:", error);
			});
		});
		socket.on("error", (error) => {
			if (!this.closed) console.error("fake pico socket:", error);
		});
		return this.boundPort;
	}

	stop(): Promise<void> {
		this.closed = true;
		const socket = this.socket;
		this.socket = null;
		if (socket) {
			try {
				socket.close();
			} catch {
				// ignore
			}
		}
		return Promise.resolve();
	}

	/** Apply the firmware's 250 ms stale-input failsafe using a supplied clock. */
	tick(now = performance.now()): void {
		if (!this.lastValidAt) return;
		if (now - this.lastValidAt < 250) return;
		for (let i = 0; i < this.pads.length; i++) this.pads[i] = neutralPad();
		this.lastValidAt = 0;
		this.neutralized++;
	}

	private async handle(data: Uint8Array, info: RemoteInfo): Promise<void> {
		const packet = await parseWifiPacket(this.key, data);
		if (!packet) {
			this.stats.auth++;
			return;
		}

		if (packet.type === WifiType.Hello) {
			if (packet.payload.length !== 4) {
				this.stats.bad++;
				return;
			}
			const nonce = readU32(packet.payload);
			this.session = (crypto.getRandomValues(new Uint32Array(1))[0]! || 1) >>> 0;
			this.sequence.reset();
			this.lastAppliedSeq = 0;
			this.stats.hello++;
			const reply = {
				nonce,
				session: this.session,
				id: this.deviceId,
				name: this.name,
				ip: this.hostname,
				port: this.boundPort,
				fw: "fake-1.0.0",
				rssi: this.rssi,
			};
			await this.reply(WifiType.HelloAck, encodeJson(reply), info);
			return;
		}

		if (packet.session !== this.session) {
			this.stats.auth++;
			return;
		}

		if (packet.type === WifiType.Control) {
			if (packet.payload.length !== 84) {
				this.stats.bad++;
				return;
			}
			const result = this.sequence.accept(packet.seq);
			if (result === "duplicate") {
				this.stats.dup++;
				return;
			}
			if (result === "old") {
				this.stats.old++;
				return;
			}
			if (result === "out-of-order") {
				this.stats.oow++;
				return;
			}
			const decoded = decodePacket(packet.payload);
			if (!decoded) {
				this.stats.bad++;
				return;
			}
			for (let i = 0; i < PAD_COUNT; i++) this.pads[i] = decoded.pads[i]!;
			this.lastAppliedSeq = packet.seq;
			this.lastValidAt = performance.now();
			this.stats.rx++;
			return;
		}

		if (packet.type === WifiType.Ping) {
			if (packet.payload.length !== 4) {
				this.stats.bad++;
				return;
			}
			this.stats.ping++;
			const reply = {
				nonce: readU32(packet.payload),
				rssi: this.rssi,
				rx: this.stats.rx,
				auth: this.stats.auth,
				dup: this.stats.dup,
				old: this.stats.old,
				oow: this.stats.oow,
				bad: this.stats.bad,
				up: Math.floor(performance.now() / 1000),
			};
			await this.reply(WifiType.Pong, encodeJson(reply), info);
			return;
		}

		if (packet.type === WifiType.Test) {
			if (packet.payload.length !== 5) {
				this.stats.bad++;
				return;
			}
			const index = packet.payload[0]!;
			if (index >= PAD_COUNT) return;
			const buttons = readU16(packet.payload, 1);
			this.pads[index] = { ...neutralPad(), buttons: buttons & 0x3fff };
			this.lastValidAt = performance.now();
			this.stats.test++;
		}
	}

	private async reply(type: number, payload: Uint8Array, info: RemoteInfo): Promise<void> {
		const socket = this.socket;
		if (!socket) return;
		const packet = await buildWifiPacket(this.key, type, this.session, this.txSeq++, payload);
		await new Promise<void>((resolve, reject) => {
			socket.send(packet, info.port, info.address, (error) => error ? reject(error) : resolve());
		});
	}
}

function readU16(data: Uint8Array, offset: number): number {
	return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array): number {
	return (data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24)) >>> 0;
}

function encodeJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

if (import.meta.main) {
	const args = Deno.args;
	let key = "";
	let port = 30100;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--key") key = args[++i] ?? "";
		else if (args[i] === "--port") port = Number(args[++i] ?? 30100);
	}
	if (!key) {
		console.error("usage: deno run -A apps/node/src/testing/fake_pico.ts --key <64 hex> [--port 30100]");
		Deno.exit(2);
	}
	const fake = new FakePico({ key: decodeHexKey(key), port });
	await fake.start();
	console.log(`fake pico listening on 127.0.0.1:${fake.port} (id ${fake.deviceId})`);
	setInterval(() => fake.tick(), 50);
}
