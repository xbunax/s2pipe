import { authorization, nodePassword } from "./authorization.ts";

export type WhepHandle = {
	pc: RTCPeerConnection;
	close: () => Promise<void>;
};

export type AudioWhepHandle = {
	pc: RTCPeerConnection;
	audio: HTMLAudioElement;
	close: () => Promise<void>;
};

// No STUN: the node is reachable, so the browser's peer-reflexive candidates are enough,
// and gathering never waits on a STUN server that some networks block.
const ice: RTCConfiguration = { iceServers: [] };

function preferLowJitter(receiver: RTCRtpReceiver): void {
	try {
		// Hint in ms. Chrome clamps; 50 would *add* delay. 0 is invalid (must be > 0).
		receiver.jitterBufferTarget = 1;
	} catch {
		const legacy = receiver as RTCRtpReceiver & { playoutDelayHint?: number };
		if ("playoutDelayHint" in legacy) legacy.playoutDelayHint = 0.001;
	}
}

function waitIceGathering(pc: RTCPeerConnection): Promise<void> {
	if (pc.iceGatheringState === "complete") return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			pc.removeEventListener("icegatheringstatechange", onChange);
			resolve();
		};
		const onChange = () => {
			if (pc.iceGatheringState === "complete") done();
		};
		const timer = setTimeout(done, 300);
		pc.addEventListener("icegatheringstatechange", onChange);
	});
}

async function postWhep(
	nodeUrl: string,
	route: string,
	pc: RTCPeerConnection,
): Promise<string | null> {
	const offer = await pc.createOffer();
	await pc.setLocalDescription(offer);
	await waitIceGathering(pc);

	const response = await fetch(`${nodeUrl}${route}`, {
		method: "POST",
		headers: { "content-type": "application/sdp", ...authorization(nodePassword()) },
		body: pc.localDescription?.sdp ?? offer.sdp,
	});

	if (!response.ok) {
		pc.close();
		return null;
	}

	const answer = await response.text();
	const location = response.headers.get("location");
	await pc.setRemoteDescription({ type: "answer", sdp: answer });
	return location;
}

function closeWhep(pc: RTCPeerConnection, nodeUrl: string, location: string | null): () => Promise<void> {
	return async () => {
		pc.close();
		if (!location) return;
		const resource = new URL(location, `${nodeUrl}/`).href;
		await fetch(resource, { method: "DELETE", headers: authorization(nodePassword()) }).catch(() => {});
	};
}

/** Fires once when the peer dies. `hadMedia` is true if it was connected before. */
export function onWhepDead(pc: RTCPeerConnection, fn: (hadMedia: boolean) => void): () => void {
	let hadMedia = false;
	let fired = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const fire = () => {
		if (fired) return;
		fired = true;
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		fn(hadMedia);
	};

	const onState = () => {
		const state = pc.connectionState;
		if (state === "connected") {
			hadMedia = true;
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
			return;
		}
		if (state === "failed") fire();
		if (state !== "disconnected" || timer) return;
		timer = setTimeout(() => {
			timer = null;
			if (pc.connectionState === "disconnected" || pc.connectionState === "failed") fire();
		}, 1500);
	};

	pc.addEventListener("connectionstatechange", onState);
	return () => {
		fired = true;
		if (timer) clearTimeout(timer);
		pc.removeEventListener("connectionstatechange", onState);
	};
}

export async function startWhep(nodeUrl: string, video: HTMLVideoElement, lite: boolean): Promise<WhepHandle> {
	const pc = new RTCPeerConnection(ice);
	pc.addTransceiver("video", { direction: "recvonly" });
	video.muted = true;

	pc.addEventListener("track", (event) => {
		if (event.track.kind !== "video") return;
		if (event.receiver) preferLowJitter(event.receiver);
		video.srcObject = new MediaStream([event.track]);
		void video.play().catch(() => {});
	});

	const location = await postWhep(nodeUrl, lite ? "/switch-lite/whep" : "/switch/whep", pc);
	if (!pc.remoteDescription) throw new Error("whep");

	const close = closeWhep(pc, nodeUrl, location);
	return {
		pc,
		close: async () => {
			video.srcObject = null;
			await close();
		},
	};
}

export async function startAudioWhep(nodeUrl: string): Promise<AudioWhepHandle | null> {
	const pc = new RTCPeerConnection(ice);
	const audio = new Audio();
	audio.autoplay = true;
	pc.addTransceiver("audio", { direction: "recvonly" });
	pc.addEventListener("track", (event) => {
		if (event.track.kind !== "audio") return;
		if (event.receiver) preferLowJitter(event.receiver);
		audio.srcObject = new MediaStream([event.track]);
		void audio.play().catch(() => {});
	});

	const location = await postWhep(nodeUrl, "/switch-audio/whep", pc);
	if (!pc.remoteDescription) {
		audio.pause();
		return null;
	}

	const close = closeWhep(pc, nodeUrl, location);
	return {
		pc,
		audio,
		close: async () => {
			audio.pause();
			audio.srcObject = null;
			await close();
		},
	};
}

export type StreamStats = {
	bitrateKbps: number;
	fps: number;
	packetsLost: number;
	rttMs: number | null;
	jitterBufferMs: number | null;
	decodeMs: number | null;
	framesDropped: number | null;
};

export type StatsSample = {
	bytes: number;
	at: number;
	bufferDelay: number;
	bufferCount: number;
	decodeTime: number;
	framesDecoded: number;
};

/** Average of a cumulative `total / count` pair over the last sample, in ms. */
function windowMs(total: number, count: number, prevTotal: number, prevCount: number): number | null {
	const frames = count - prevCount;
	if (frames <= 0) return null;
	return Math.round(((total - prevTotal) / frames) * 1000);
}

export async function readStreamStats(
	pc: RTCPeerConnection,
	prev: StatsSample | null,
): Promise<{ stats: StreamStats; prev: StatsSample }> {
	const report = await pc.getStats();
	let rttMs: number | null = null;
	let framesDropped: number | null = null;
	let fps = 0;
	let packetsLost = 0;
	const sample: StatsSample = {
		bytes: 0,
		at: performance.now(),
		bufferDelay: 0,
		bufferCount: 0,
		decodeTime: 0,
		framesDecoded: 0,
	};

	for (const item of report.values()) {
		if (item.type === "inbound-rtp" && item.kind === "video") {
			sample.bytes = item.bytesReceived ?? 0;
			sample.at = item.timestamp ?? sample.at;
			sample.bufferDelay = item.jitterBufferDelay ?? 0;
			sample.bufferCount = item.jitterBufferEmittedCount ?? 0;
			sample.decodeTime = item.totalDecodeTime ?? 0;
			sample.framesDecoded = item.framesDecoded ?? 0;
			fps = item.framesPerSecond ?? 0;
			packetsLost = item.packetsLost ?? 0;
			framesDropped = item.framesDropped ?? null;
		} else if (item.type === "candidate-pair" && item.state === "succeeded" && item.nominated) {
			if (typeof item.currentRoundTripTime === "number") rttMs = Math.round(item.currentRoundTripTime * 1000);
		}
	}

	const elapsed = prev ? Math.max(1, sample.at - prev.at) : 1000;
	const delta = prev ? Math.max(0, sample.bytes - prev.bytes) : 0;
	const bitrateKbps = Math.round((delta * 8) / elapsed);

	const jitterBufferMs = prev
		? windowMs(sample.bufferDelay, sample.bufferCount, prev.bufferDelay, prev.bufferCount)
		: null;
	const decodeMs = prev
		? windowMs(sample.decodeTime, sample.framesDecoded, prev.decodeTime, prev.framesDecoded)
		: null;

	return {
		stats: { bitrateKbps, fps, packetsLost, rttMs, jitterBufferMs, decodeMs, framesDropped },
		prev: sample,
	};
}
