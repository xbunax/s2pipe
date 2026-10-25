function env(name: string, fallback = ""): string {
	return Deno.env.get(name) || fallback;
}

function envInt(name: string, fallback: number): number {
	const raw = Deno.env.get(name);
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

function parseMac(raw: string): Uint8Array | null {
	const parts = raw.trim().split(/[:\-]/);
	if (parts.length !== 6) return null;
	const out = new Uint8Array(6);
	for (let i = 0; i < 6; i++) {
		if (!/^[0-9a-fA-F]{2}$/.test(parts[i]!)) return null;
		out[i] = Number.parseInt(parts[i]!, 16);
	}
	if (out.every((b) => b === 0)) return null;
	return out;
}

function parsePid(raw: string, fallback: number): number {
	const text = raw.trim();
	if (!text) return fallback;
	const value = Number.parseInt(text, /^0x/i.test(text) ? 16 : 10);
	if (!Number.isFinite(value) || value <= 0 || value > 0xffff) return fallback;
	return value;
}

export const config = {
	nodePort: envInt("NODE_PORT", 5050),
	mediaHost: env("MEDIA_HOST", "127.0.0.1"),
	mediaPort: 8889,
	captureSource: env("CAPTURE_SOURCE", "test"),
	nodePassword: env("NODE_PASSWORD").trim(),
	picoTransport: env("PICO_TRANSPORT", "serial").trim().toLowerCase() === "wifi" ? "wifi" : "serial",
	picoSerial: env("PICO_SERIAL").trim(),
	picoWifiHost: env("PICO_WIFI_HOST").trim(),
	picoWifiPort: envInt("PICO_WIFI_PORT", 30100),
	picoWifiKey: env("PICO_WIFI_KEY").trim(),
	picoWifiDeviceId: env("PICO_WIFI_DEVICE_ID").trim(),
	picoWifiAutoDiscover: env("PICO_WIFI_AUTO_DISCOVER", "1") !== "0",
	switchBtMac: parseMac(env("SWITCH_BT_MAC")),
	controllerBtMac: parseMac(env("CONTROLLER_BT_MAC")),
	controllerBtPid: parsePid(env("CONTROLLER_BT_PID"), 0x2069),
} as const;
