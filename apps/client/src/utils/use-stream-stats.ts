import { type Signal, useSignal } from "@preact/signals";
import { type RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { holdPage } from "./page-session.ts";
import { readStreamStats, type StatsSample, type StreamStats, type WhepHandle } from "./whep.ts";

// Moving to the lite stream takes this many seconds of heavy packet loss in a row, after a short warm-up.
// Low frame rate alone does not count: it points at a busy machine, which a second encode would worsen.
const WARMUP_SECONDS = 5;
const BAD_SECONDS = 3;
const BAD_LOSS_PER_SECOND = 10;

type Options = {
	whep: RefObject<WhepHandle | null>;
	/** Keep `stats` up to date for the overlay. */
	show: boolean;
	/** Call `onSlow` once the network cannot keep up. */
	watchNetwork: boolean;
	onSlow: () => void;
};

/** Reads the stream stats every second, for the overlay and to spot a connection that loses packets. */
export function useStreamStats({ whep, show, watchNetwork, onSlow }: Options): Signal<StreamStats | null> {
	const stats = useSignal<StreamStats | null>(null);
	const previous = useRef<StatsSample | null>(null);

	useEffect(() => {
		if (!show) stats.value = null;
		if (!show && !watchNetwork) return;

		let current: RTCPeerConnection | null = null;
		let age = 0;
		let lastLost = 0;
		let badSeconds = 0;
		let slow = false;

		const timer = globalThis.setInterval(() => {
			const pc = whep.current?.pc;
			if (!pc) return;
			if (pc !== current) {
				current = pc;
				previous.current = null;
				age = 0;
				lastLost = 0;
				badSeconds = 0;
			}
			readStreamStats(pc, previous.current).then((result) => {
				previous.current = result.prev;
				if (show) stats.value = result.stats;
				if (!watchNetwork) return;

				const lost = Math.max(0, result.stats.packetsLost - lastLost);
				lastLost = result.stats.packetsLost;
				// The first seconds of a stream are not representative.
				if (++age <= WARMUP_SECONDS) return;

				badSeconds = lost >= BAD_LOSS_PER_SECOND ? badSeconds + 1 : 0;
				if (badSeconds < BAD_SECONDS || slow) return;
				slow = true;
				onSlow();
			}).catch(() => {});
		}, 1000);
		return holdPage(() => clearInterval(timer));
	}, [show, watchNetwork]);

	return stats;
}
