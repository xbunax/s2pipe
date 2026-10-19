const KEY = "s2pipe.play";

export type Quality = "auto" | "full" | "lite";

export type PlayPrefs = {
	volume: number;
	muted: boolean;
	fill: boolean;
	showStats: boolean;
	quality: Quality;
};

const defaults: PlayPrefs = {
	volume: 1,
	muted: false,
	fill: false,
	showStats: false,
	quality: "auto",
};

function storage(): Storage | null {
	try {
		if (typeof document === "undefined") return null;
		return globalThis.localStorage;
	} catch {
		return null;
	}
}

function clampVolume(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return defaults.volume;
	return Math.min(1, Math.max(0, n));
}

function parseQuality(value: unknown): Quality {
	return value === "full" || value === "lite" ? value : defaults.quality;
}

export function loadPlayPrefs(): PlayPrefs {
	try {
		const raw = storage()?.getItem(KEY);
		if (!raw) return { ...defaults };
		const parsed = JSON.parse(raw) as Partial<PlayPrefs>;
		return {
			volume: clampVolume(parsed.volume),
			muted: Boolean(parsed.muted),
			fill: Boolean(parsed.fill),
			showStats: Boolean(parsed.showStats),
			quality: parseQuality(parsed.quality),
		};
	} catch {
		return { ...defaults };
	}
}

export function savePlayPrefs(prefs: PlayPrefs): void {
	try {
		storage()?.setItem(
			KEY,
			JSON.stringify({
				volume: clampVolume(prefs.volume),
				muted: Boolean(prefs.muted),
				fill: Boolean(prefs.fill),
				showStats: Boolean(prefs.showStats),
				quality: parseQuality(prefs.quality),
			}),
		);
	} catch {
		// ignore quota / private mode
	}
}
