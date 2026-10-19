import type { Signal } from "@preact/signals";
import { type RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { holdPage } from "./page-session.ts";
import { type AudioWhepHandle, onWhepDead, startAudioWhep, startWhep, type WhepHandle } from "./whep.ts";

const HIDDEN_PAUSE_MS = 15_000;

type Options = {
	nodeUrl: string;
	video: RefObject<HTMLVideoElement>;
	lite: boolean;
	/** Nothing connects before the saved quality is known, or a lite user would start on full first. */
	enabled: boolean;
	live: Signal<boolean>;
	muted: Signal<boolean>;
	volume: Signal<number>;
	toast: (text: string) => void;
};

/** Keeps the video and audio WHEP connections up, and reconnects when they die or `lite` changes. */
export function useStream({ nodeUrl, video: videoRef, lite, enabled, live, muted, volume, toast }: Options) {
	const whepRef = useRef<WhepHandle | null>(null);
	const audioRef = useRef<AudioWhepHandle | null>(null);

	useEffect(() => {
		const video = videoRef.current;
		if (!video || !enabled) return;
		let cancelled = false;
		let paused = false;
		let videoHandle: WhepHandle | null = null;
		let audioHandle: AudioWhepHandle | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let hiddenTimer: ReturnType<typeof setTimeout> | undefined;
		let iceHinted = false;

		const cleanup = () => {
			void videoHandle?.close();
			void audioHandle?.close();
			videoHandle = null;
			audioHandle = null;
			whepRef.current = null;
			audioRef.current = null;
		};

		const connect = async () => {
			// Both streams are requested together: a cold start launches one encoder per stream,
			// and asking one after the other would add their start-up times.
			// Audio can fail without blocking video.
			const audioPending = startAudioWhep(nodeUrl).catch(() => null);
			try {
				videoHandle = await startWhep(nodeUrl, video, lite);
				if (cancelled) {
					void videoHandle.close();
					videoHandle = null;
					void audioPending.then((handle) => handle?.close());
					return;
				}
				whepRef.current = videoHandle;
				live.value = true;

				onWhepDead(videoHandle.pc, (hadMedia) => {
					if (!hadMedia && !iceHinted) {
						iceHinted = true;
						toast("ICE failed. Set MEDIA_ICE_IP to this machine's LAN address, not 127.0.0.1.");
					}
					if (!cancelled && !paused) {
						live.value = false;
						cleanup();
						retryTimer = globalThis.setTimeout(connect, hadMedia ? 1500 : 2000);
					}
				});
			} catch {
				void audioPending.then((handle) => handle?.close());
				if (!cancelled && !paused) {
					retryTimer = globalThis.setTimeout(connect, 2000);
				}
				return;
			}

			audioHandle = await audioPending;
			if (cancelled || paused || !videoHandle) {
				void audioHandle?.close();
				audioHandle = null;
				return;
			}
			if (audioHandle) {
				audioRef.current = audioHandle;
				audioHandle.audio.muted = muted.value;
				audioHandle.audio.volume = volume.value;
			}
		};

		// A tab hidden for a while stops pulling the stream, which lets the server stop encoding
		// when nobody is looking (a phone in a pocket). The WebSocket stays open.
		const onVisibility = () => {
			clearTimeout(hiddenTimer);
			if (!document.hidden) {
				if (!paused) return;
				paused = false;
				void connect();
				return;
			}
			hiddenTimer = globalThis.setTimeout(() => {
				if (cancelled || paused || !document.hidden) return;
				paused = true;
				clearTimeout(retryTimer);
				cleanup();
				live.value = false;
			}, HIDDEN_PAUSE_MS);
		};
		document.addEventListener("visibilitychange", onVisibility);

		void connect();

		return holdPage(() => {
			cancelled = true;
			clearTimeout(retryTimer);
			clearTimeout(hiddenTimer);
			document.removeEventListener("visibilitychange", onVisibility);
			cleanup();
			video.pause();
			video.srcObject = null;
		});
	}, [nodeUrl, lite, enabled]);

	return { whepRef, audioRef };
}
