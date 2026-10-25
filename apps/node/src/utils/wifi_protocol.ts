// Keep in sync with firmware/wifi_protocol.h and firmware/wifi_transport.c.
export const WIFI_MAGIC = 0x31573253;
export const WIFI_VERSION = 1;
export const WIFI_CONTROL_PORT = 30100;
export const WIFI_DISCOVERY_PORT = 30101;

export const WIFI_PREFIX_LEN = 24;
export const WIFI_HMAC_OFF = 24;
export const WIFI_HMAC_LEN = 16;
export const WIFI_PAYLOAD_OFF = 40;
export const WIFI_PAYLOAD_MAX = 200;
export const WIFI_PACKET_MAX = WIFI_PAYLOAD_OFF + WIFI_PAYLOAD_MAX;

export const WifiType = {
	Hello: 1,
	HelloAck: 2,
	Control: 3,
	Ping: 4,
	Pong: 5,
	Test: 6,
} as const;

export type WifiTypeValue = typeof WifiType[keyof typeof WifiType];

export type WifiPacket = {
	type: number;
	session: number;
	seq: number;
	timestamp: number;
	payload: Uint8Array;
};

export type WifiAnnouncement = {
	id: string;
	name: string;
	ip: string;
	port: number;
	disc: number;
	fw: string;
	rssi: number;
	session: number;
	boot: number;
};

const keyCache = new Map<string, Promise<CryptoKey>>();

export function encodeHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function decodeHexKey(value: string): Uint8Array {
	const compact = value.trim().replace(/[\s:-]/g, "");
	if (!/^[0-9a-fA-F]{64}$/.test(compact)) {
		throw new Error("pairing key must be 64 hex characters (32 bytes)");
	}
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i++) out[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function importKey(key: Uint8Array): Promise<CryptoKey> {
	if (key.length !== 32) throw new Error("pairing key must be 32 bytes");
	const id = encodeHex(key);
	let pending = keyCache.get(id);
	if (!pending) {
		const copy = key.slice();
		pending = crypto.subtle.importKey("raw", copy, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		keyCache.set(id, pending);
	}
	return pending;
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const cryptoKey = await importKey(key);
	return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, data.slice()));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

function hmacInput(prefix: Uint8Array, payload: Uint8Array): Uint8Array {
	const data = new Uint8Array(prefix.length + payload.length);
	data.set(prefix, 0);
	data.set(payload, prefix.length);
	return data;
}

export async function buildWifiPacket(
	key: Uint8Array,
	type: number,
	session: number,
	seq: number,
	payload: Uint8Array,
	timestamp = Date.now() >>> 0,
): Promise<Uint8Array> {
	if (payload.length > WIFI_PAYLOAD_MAX) throw new Error("Wi-Fi payload too large");

	const packet = new Uint8Array(WIFI_PAYLOAD_OFF + payload.length);
	const view = new DataView(packet.buffer);
	view.setUint32(0, WIFI_MAGIC, true);
	view.setUint8(4, WIFI_VERSION);
	view.setUint8(5, type);
	view.setUint8(6, 0);
	view.setUint8(7, 0);
	view.setUint32(8, session >>> 0, true);
	view.setUint32(12, seq >>> 0, true);
	view.setUint32(16, timestamp >>> 0, true);
	view.setUint16(20, payload.length, true);
	view.setUint16(22, 0, true);
	packet.set(payload, WIFI_PAYLOAD_OFF);

	const mac = await hmacSha256(key, hmacInput(packet.subarray(0, WIFI_PREFIX_LEN), payload));
	packet.set(mac.subarray(0, WIFI_HMAC_LEN), WIFI_HMAC_OFF);
	return packet;
}

export async function parseWifiPacket(key: Uint8Array, packet: Uint8Array): Promise<WifiPacket | null> {
	if (packet.length < WIFI_PAYLOAD_OFF || packet.length > WIFI_PACKET_MAX) return null;
	const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
	if (view.getUint32(0, true) !== WIFI_MAGIC) return null;
	if (view.getUint8(4) !== WIFI_VERSION) return null;

	const payloadLen = view.getUint16(20, true);
	if (payloadLen > WIFI_PAYLOAD_MAX || WIFI_PAYLOAD_OFF + payloadLen !== packet.length) return null;

	const payload = packet.slice(WIFI_PAYLOAD_OFF);
	const mac = await hmacSha256(
		key,
		hmacInput(packet.subarray(0, WIFI_PREFIX_LEN), payload),
	);
	if (
		!timingSafeEqual(mac.subarray(0, WIFI_HMAC_LEN), packet.subarray(WIFI_HMAC_OFF, WIFI_HMAC_OFF + WIFI_HMAC_LEN))
	) {
		return null;
	}

	return {
		type: view.getUint8(5),
		session: view.getUint32(8, true),
		seq: view.getUint32(12, true),
		timestamp: view.getUint32(16, true),
		payload,
	};
}

export function helloPayload(nonce: number): Uint8Array {
	const payload = new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, nonce >>> 0, true);
	return payload;
}

export function pingPayload(nonce: number): Uint8Array {
	return helloPayload(nonce);
}

export function testPayload(pad: number, buttons: number, durationMs: number): Uint8Array {
	const payload = new Uint8Array(5);
	payload[0] = pad & 0xff;
	new DataView(payload.buffer).setUint16(1, buttons & 0x3fff, true);
	new DataView(payload.buffer).setUint16(3, Math.max(1, Math.min(250, durationMs)), true);
	return payload;
}

export function parseJsonPayload<T>(payload: Uint8Array): T | null {
	try {
		return JSON.parse(new TextDecoder().decode(payload)) as T;
	} catch {
		return null;
	}
}

export function parseAnnouncement(raw: Uint8Array | string): WifiAnnouncement | null {
	let value: unknown;
	try {
		value = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (record.s2pipe !== 1 || record.type !== "announce") return null;
	if (typeof record.id !== "string" || typeof record.ip !== "string") return null;
	return {
		id: record.id,
		name: typeof record.name === "string" ? record.name : "Pico 2 W",
		ip: record.ip,
		port: typeof record.port === "number" ? record.port : WIFI_CONTROL_PORT,
		disc: typeof record.disc === "number" ? record.disc : WIFI_DISCOVERY_PORT,
		fw: typeof record.fw === "string" ? record.fw : "",
		rssi: typeof record.rssi === "number" ? record.rssi : 0,
		session: typeof record.session === "number" ? record.session : 0,
		boot: typeof record.boot === "number" ? record.boot : 0,
	};
}

export type SequenceResult = "accepted" | "out-of-order" | "duplicate" | "old";

/** The receiver-side sliding window implemented by firmware/wifi_transport.c. */
export class SequenceWindow {
	last = 0;
	window = 0n;
	accepted = 0;
	outOfOrder = 0;
	duplicates = 0;
	old = 0;

	reset(): void {
		this.last = 0;
		this.window = 0n;
	}

	accept(seq: number): SequenceResult {
		if (seq === 0) return "old";
		if (this.last === 0 || seq > this.last) {
			const diff = this.last === 0 ? 64 : seq - this.last;
			this.window = diff >= 64 ? 0n : (this.window << BigInt(diff)) & 0xffffffffffffffffn;
			this.window |= 1n;
			this.last = seq;
			this.accepted++;
			return "accepted";
		}

		const diff = this.last - seq;
		if (diff >= 64) {
			this.old++;
			return "old";
		}
		const bit = 1n << BigInt(diff);
		if (this.window & bit) {
			this.duplicates++;
			return "duplicate";
		}
		this.window |= bit;
		this.outOfOrder++;
		return "out-of-order";
	}
}
