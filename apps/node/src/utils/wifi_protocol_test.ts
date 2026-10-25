import { decodePacket, encodePacket } from "@/utils/packet.ts";
import {
	buildWifiPacket,
	decodeHexKey,
	encodeHex,
	parseAnnouncement,
	parseWifiPacket,
	SequenceWindow,
	WifiType,
} from "@/utils/wifi_protocol.ts";
import { neutralPad, PAD_COUNT, PadButton, type PadState } from "@s2pipe/shared/types/pad";

const key = Uint8Array.from({ length: 32 }, (_, index) => index);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pads(): PadState[] {
	return Array.from({ length: PAD_COUNT }, (_, index) => ({
		...neutralPad(),
		buttons: index === 0 ? PadButton.A | PadButton.Right : 0,
		lx: index,
		ly: 255 - index,
	}));
}

Deno.test("wifi packet round trip preserves header and payload", async () => {
	const payload = encodePacket(pads());
	const packet = await buildWifiPacket(key, WifiType.Control, 0x12345678, 42, payload);
	const parsed = await parseWifiPacket(key, packet);
	assert(parsed, "packet must parse");
	assert(parsed.type === WifiType.Control, "type");
	assert(parsed.session === 0x12345678, "session");
	assert(parsed.seq === 42, "sequence");
	const decoded = decodePacket(parsed.payload);
	assert(decoded, "inner packet must decode");
	assert(decoded.pads[0]!.buttons === (PadButton.A | PadButton.Right), "pad 0 buttons");
	assert(decoded.pads[7]!.lx === 7, "pad 7 axis");
	return;
});

Deno.test("known protocol vector matches the firmware and launcher layout", async () => {
	const vector = await buildWifiPacket(
		key,
		WifiType.Hello,
		0x11223344,
		5,
		Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
		0x01020304,
	);
	const expected = "533257310101000044332211050000000403020104000000df66075996c0aa2c76eea4b634134d7fdeadbeef";
	assert(encodeHex(vector) === expected, `protocol vector drifted: ${encodeHex(vector)}`);
});

Deno.test("wifi packet rejects corruption, truncation and the wrong key", async () => {
	const payload = encodePacket(pads());
	const packet = await buildWifiPacket(key, WifiType.Control, 1, 1, payload);

	const corrupted = packet.slice();
	corrupted[45] ^= 0x01;
	assert((await parseWifiPacket(key, corrupted)) === null, "corrupted payload must fail HMAC");

	const badMac = packet.slice();
	badMac[24] ^= 0x01;
	assert((await parseWifiPacket(key, badMac)) === null, "bad MAC must fail");

	const truncated = packet.slice(0, packet.length - 1);
	assert((await parseWifiPacket(key, truncated)) === null, "truncated packet must fail");

	const otherKey = new Uint8Array(32).fill(0xaa);
	assert((await parseWifiPacket(otherKey, packet)) === null, "wrong key must fail");

	const badMagic = packet.slice();
	badMagic[0] ^= 0xff;
	assert((await parseWifiPacket(key, badMagic)) === null, "bad magic must fail");
});

Deno.test("sequence window detects duplicates, reordering and stale packets", () => {
	const window = new SequenceWindow();
	assert(window.accept(1) === "accepted", "1 accepted");
	assert(window.accept(2) === "accepted", "2 accepted");
	assert(window.accept(2) === "duplicate", "2 duplicate");
	assert(window.accept(1) === "duplicate", "1 duplicate");
	assert(window.accept(5) === "accepted", "5 accepted");
	assert(window.accept(4) === "out-of-order", "4 out-of-order");
	assert(window.accept(4) === "duplicate", "4 duplicate");
	assert(window.accept(100) === "accepted", "100 accepted");
	assert(window.accept(1) === "old", "1 is stale after a large jump");
	assert(window.duplicates === 3, `duplicates=${window.duplicates}`);
	assert(window.outOfOrder === 1, `outOfOrder=${window.outOfOrder}`);
	assert(window.old === 1, `old=${window.old}`);
});

Deno.test("pairing key parser accepts hex and rejects malformed input", () => {
	const bytes = decodeHexKey(
		"00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff",
	);
	assert(bytes.length === 32, "key length");
	assert(bytes[0] === 0 && bytes[31] === 0xff, "key contents");
	assert(encodeHex(Uint8Array.from([0, 1, 0xab, 0xff])) === "0001abff", "hex encoding");

	for (const bad of ["", "00", "zz".repeat(32), "00".repeat(31)]) {
		let failed = false;
		try {
			decodeHexKey(bad);
		} catch {
			failed = true;
		}
		assert(failed, `bad key must fail: ${bad}`);
	}
});

Deno.test("discovery announcements are parsed and spoofed types are rejected", () => {
	const raw = JSON.stringify({
		s2pipe: 1,
		type: "announce",
		id: "0123456789abcdef",
		name: "Pico 2 W",
		ip: "192.168.1.120",
		port: 30100,
		disc: 30101,
		fw: "wifi-1.0.0",
		rssi: -44,
		session: 7,
		boot: 9,
	});
	const announcement = parseAnnouncement(raw);
	assert(announcement, "announcement parses");
	assert(announcement.id === "0123456789abcdef", "id");
	assert(announcement.ip === "192.168.1.120", "ip");
	assert(announcement.rssi === -44, "rssi");
	assert(parseAnnouncement('{"s2pipe":1,"type":"discover"}') === null, "probe is not an announcement");
});
