import { createSocket } from "node:dgram";

import { FakePico } from "@/testing/fake_pico.ts";
import { WifiTransport } from "@/services/transport.ts";
import { encodePacket } from "@/utils/packet.ts";
import { buildWifiPacket, WifiType } from "@/utils/wifi_protocol.ts";
import { neutralPad, PAD_COUNT, PadButton, type PadState } from "@s2pipe/shared/types/pad";

const key = Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) & 0xff);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition timed out");
}

function testPads(): PadState[] {
	return Array.from({ length: PAD_COUNT }, (_, index) => ({
		...neutralPad(),
		buttons: index === 0 ? PadButton.A : index === 1 ? PadButton.B : index === 7 ? PadButton.ZR : 0,
		lx: 10 + index,
		ly: 20 + index,
		rx: 30 + index,
		ry: 40 + index,
	}));
}

Deno.test("wifi transport sends 8 pads, measures RTT and reconnects", async () => {
	const fake = new FakePico({ key });
	const port = await fake.start();
	const transport = new WifiTransport({ host: "127.0.0.1", port, key });

	try {
		await transport.connect();
		assert(transport.isConnected(), "transport connected");

		await transport.send(encodePacket(testPads()));
		await waitFor(() => fake.stats.rx === 1);
		assert(fake.pads[0]!.buttons === PadButton.A, "pad 0 A");
		assert(fake.pads[1]!.buttons === PadButton.B, "pad 1 B");
		assert(fake.pads[7]!.buttons === PadButton.ZR, "pad 7 ZR");
		assert(fake.pads[3]!.lx === 13 && fake.pads[3]!.ry === 43, "axes preserved");

		await waitFor(() => transport.status().latencyMs !== null);
		await waitFor(() => transport.status().stats?.rx === 1);
		const status = transport.status();
		assert(status.connected, "status connected");
		assert(status.latencyMs !== null && status.latencyMs >= 0, "real RTT");
		assert(status.rssi === -42, "Pico-reported RSSI");
		assert(status.stats?.rx === 1, "Pico rx counter");

		fake.tick(performance.now() + 300);
		assert(fake.neutralized === 1, "failsafe fired");
		assert(fake.pads.every((pad) => pad.buttons === 0 && pad.lx === 128), "failsafe neutralized all pads");

		await transport.disconnect();
		assert(!transport.isConnected(), "disconnected");
		await transport.connect();
		assert(transport.isConnected(), "reconnected");
		assert(fake.stats.hello >= 2, "new HELLO after reconnect");
	} finally {
		await transport.disconnect();
		await fake.stop();
	}
});

Deno.test("firmware sequence window rejects duplicates, reordering and bad MACs", async () => {
	const fake = new FakePico({ key });
	const port = await fake.start();
	const transport = new WifiTransport({ host: "127.0.0.1", port, key });
	const raw = createSocket({ type: "udp4" });
	await new Promise<void>((resolve) => raw.bind(0, "127.0.0.1", resolve));

	const send = (packet: Uint8Array) =>
		new Promise<void>((resolve, reject) => {
			raw.send(packet, port, "127.0.0.1", (error) => error ? reject(error) : resolve());
		});

	try {
		await transport.connect();
		await transport.send(encodePacket(testPads()));
		await waitFor(() => fake.stats.rx === 1);

		const state = encodePacket(testPads());
		await send(await buildWifiPacket(key, WifiType.Control, fake.session, 100, state));
		await send(await buildWifiPacket(key, WifiType.Control, fake.session, 100, state));
		await send(await buildWifiPacket(key, WifiType.Control, fake.session, 99, state));
		await send(await buildWifiPacket(key, WifiType.Control, fake.session, 1, state));

		const wrongKey = new Uint8Array(32).fill(0x5a);
		await send(await buildWifiPacket(wrongKey, WifiType.Control, fake.session, 200, state));
		await new Promise((resolve) => setTimeout(resolve, 120));

		assert(fake.stats.dup >= 1, `duplicate counted (${fake.stats.dup})`);
		assert(fake.stats.oow >= 1, `out-of-order counted (${fake.stats.oow})`);
		assert(fake.stats.old >= 1, `stale counted (${fake.stats.old})`);
		assert(fake.stats.auth >= 1, `bad HMAC counted (${fake.stats.auth})`);
		assert(fake.lastAppliedSeq === 100, `only newest state applied (${fake.lastAppliedSeq})`);
	} finally {
		raw.close();
		await transport.disconnect();
		await fake.stop();
	}
});

Deno.test("wifi transport fails clearly with the wrong pairing key", async () => {
	const fake = new FakePico({ key });
	const port = await fake.start();
	const transport = new WifiTransport({ host: "127.0.0.1", port, key: new Uint8Array(32).fill(0x11) });
	try {
		let message = "";
		try {
			await transport.connect();
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		assert(message.includes("did not answer"), `unexpected error: ${message}`);
		assert(!transport.isConnected(), "not connected");
	} finally {
		await transport.disconnect();
		await fake.stop();
	}
});
