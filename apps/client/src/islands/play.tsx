import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import {
	EyeOff,
	Gamepad2,
	Keyboard,
	Maximize,
	Minimize,
	Move,
	Settings,
	Smartphone,
	Volume2,
	VolumeX,
	X,
} from "lucide-preact";

import type { CaptureStatus, ClientMessage, PicoStatus, ServerMessage } from "@s2pipe/shared/types/node";
import { neutralPad, PAD_COUNT, type PadState, samePad } from "@s2pipe/shared/types/pad";

import ControllerDialog from "../components/controller-dialog.tsx";
import GamepadMappingDialog from "../components/gamepad-mapping-dialog.tsx";
import TouchController from "../components/touch-controller.tsx";
import {
	defaultGamepadMapping,
	type GamepadMapping,
	loadGamepadMapping,
	saveGamepadMapping,
} from "../utils/gamepad.ts";
import { createInputTracker, type GamepadOption, isTyping, listGamepads } from "../utils/input.ts";
import { useStream } from "../utils/use-stream.ts";
import { useStreamStats } from "../utils/use-stream-stats.ts";
import { nodePassword } from "../utils/authorization.ts";
import { holdPage } from "../utils/page-session.ts";
import { loadPlayPrefs, type Quality, savePlayPrefs } from "../utils/prefs.ts";
import {
	createTouchState,
	defaultTouchPrefs,
	loadTouchPrefs,
	resetTouchPrefsLayouts,
	saveTouchPrefs,
	type TouchPrefs,
} from "../utils/touch.ts";
import {
	createVirtualPad,
	defaultVirtualPrefs,
	loadVirtualPrefs,
	saveVirtualPrefs,
	VIRTUAL_PREFS_KEY,
	type VirtualPad,
	type VirtualPrefs,
} from "../utils/virtual/mod.ts";

type Props = {
	nodeUrl: string;
};

type Toast = { id: number; text: string };

function wsUrl(nodeUrl: string): string {
	const url = new URL(nodeUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/socket";
	url.search = "";
	const password = nodePassword();
	if (password) url.searchParams.set("authorization", password);
	return url.href;
}

// When the page itself was opened through an IPv6 literal, reach the node on
// the same host over IPv6. IPv4 page access keeps using the configured URL.
function browserNodeUrl(configured: string): string {
	if (typeof location === "undefined") return configured;
	let host = location.hostname;
	if (!host.includes(":")) return configured;
	if (!host.startsWith("[")) host = `[${host}]`;
	try {
		const url = new URL(configured);
		const port = url.port || (url.protocol === "https:" ? "443" : "80");
		return `${url.protocol}//${host}:${port}`;
	} catch {
		return configured;
	}
}

function send(ws: WebSocket | null, message: ClientMessage): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function picoTitle(pico: PicoStatus | null): string | undefined {
	if (!pico) return undefined;
	if (pico.error) return pico.error;
	const parts: string[] = [];
	if (pico.transport === "wifi") {
		parts.push(`${pico.device ?? "Pico 2 W"}${pico.ip ? ` @ ${pico.ip}` : ""}`);
		if (pico.latencyMs !== null) parts.push(`${pico.latencyMs} ms RTT`);
		if (pico.rssi !== null) parts.push(`${pico.rssi} dBm`);
		if (pico.stats) {
			parts.push(
				`rx ${pico.stats.rx}, dup ${pico.stats.dup}, old ${pico.stats.old}, auth ${pico.stats.auth}`,
			);
		}
	} else if (pico.path) {
		parts.push(pico.path);
	}
	if (pico.connected && !pico.wake) parts.push("Sleep wake: set SWITCH_BT_MAC and CONTROLLER_BT_MAC");
	return parts.length ? parts.join("\n") : undefined;
}

function padLabel(id: string): string {
	const name = id.split("(")[0]?.trim();
	return name || id;
}

function padKey(pad: GamepadOption): string {
	return `${pad.index}:${pad.id}`;
}

function isIosLike(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator.userAgent;
	// iPadOS 13+ can identify itself as a Mac, so check touch points as well.
	return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

function formatMs(value: number | null | undefined): string {
	return value == null ? "-" : `${value} ms`;
}

const NEUTRAL = neutralPad();

function sameIds(a: number[], b: number[]): boolean {
	return a.length === b.length && a.every((id, i) => id === b[i]);
}

function selectedPads(pads: GamepadOption[], chosen: number[]): GamepadOption[] {
	return pads.filter((pad) => chosen.includes(pad.index));
}

// Safari can hand the same controller back with a different gamepad index.
// Keep its seat by matching the stable id before falling back to the index.
function remapChosenIndices(
	chosen: number[],
	before: GamepadOption[],
	next: GamepadOption[],
): number[] {
	const out: number[] = [];
	for (const index of chosen) {
		if (next.some((pad) => pad.index === index)) {
			if (!out.includes(index)) out.push(index);
			continue;
		}
		const old = before.find((pad) => pad.index === index);
		if (!old) continue;
		const moved = next.find((pad) => pad.id === old.id);
		if (moved && !out.includes(moved.index)) out.push(moved.index);
	}
	return out;
}

function streamBanner(
	connected: boolean,
	capture: CaptureStatus | null,
	live: boolean,
): { title: string; body: string } | null {
	if (!connected) {
		return { title: "Connecting", body: "Waiting for the node..." };
	}
	if (capture && !capture.running) {
		return {
			title: "Capture is down",
			body: "MediaMTX is unreachable. The capture PC may be restarting.",
		};
	}
	if (!live) {
		return { title: "Waiting for stream", body: "Connecting to the capture card..." };
	}
	return null;
}

export default function Play({ nodeUrl }: Props) {
	const activeNodeUrl = browserNodeUrl(nodeUrl);
	const videoRef = useRef<HTMLVideoElement>(null);
	const stageRef = useRef<HTMLElement>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const inputRef = useRef<ReturnType<typeof createInputTracker> | null>(null);
	const virtualRef = useRef<VirtualPad | null>(null);
	const touchStateRef = useRef<ReturnType<typeof createTouchState> | null>(null);
	if (!touchStateRef.current) touchStateRef.current = createTouchState();
	const touchState = touchStateRef.current;
	const persistVirtual = useRef(false);
	const persistGamepad = useRef(false);
	const persistTouch = useRef(false);
	const toastSeq = useRef(0);
	const pendingPlays = useRef(0);
	const playPendingSince = useRef(0);
	const persistPrefs = useRef(false);

	const connected = useSignal(false);
	const capture = useSignal<CaptureStatus | null>(null);
	const pico = useSignal<PicoStatus | null>(null);
	const pads = useSignal<GamepadOption[]>([]);
	const chosen = useSignal<number[]>([]);
	const seats = useSignal<number[]>([]);
	const occupied = useSignal<number[]>([]);
	const livePads = useSignal<number[]>([]);
	const settings = useSignal(false);
	const uiHidden = useSignal(false);
	const virtualPrefs = useSignal<VirtualPrefs>(defaultVirtualPrefs());
	const touchPrefs = useSignal<TouchPrefs>(defaultTouchPrefs());
	const touchEditing = useSignal(false);
	const localLive = useSignal(false);
	const mapOpen = useSignal(false);
	const gamepadMapOpen = useSignal(false);
	const gamepadMapping = useSignal<GamepadMapping>(defaultGamepadMapping());
	// What the virtual pad reads while the mapping window is open, for its live preview.
	const mapLive = useSignal<PadState>(NEUTRAL);
	const muted = useSignal(false);
	const volume = useSignal(1);
	const fill = useSignal(false);
	const showStats = useSignal(false);
	const quality = useSignal<Quality>("auto");
	// The lite stream is in use. Auto turns it on after a bad network spell and keeps it for the session.
	const lite = useSignal(false);
	const prefsLoaded = useSignal(false);
	const fullscreen = useSignal(false);
	const live = useSignal(false);
	const toasts = useSignal<Toast[]>([]);

	useEffect(() => {
		const prefs = loadPlayPrefs();
		muted.value = prefs.muted;
		volume.value = prefs.volume;
		fill.value = prefs.fill;
		showStats.value = prefs.showStats;
		quality.value = prefs.quality;
		lite.value = prefs.quality === "lite";
		virtualPrefs.value = loadVirtualPrefs();
		touchPrefs.value = loadTouchPrefs();
		gamepadMapping.value = loadGamepadMapping();
		prefsLoaded.value = true;
	}, []);

	useEffect(() => {
		if (!persistPrefs.current) {
			persistPrefs.current = true;
			return;
		}
		savePlayPrefs({
			muted: muted.value,
			volume: volume.value,
			fill: fill.value,
			showStats: showStats.value,
			quality: quality.value,
		});
	}, [muted.value, volume.value, fill.value, showStats.value, quality.value]);

	useEffect(() => {
		if (!persistVirtual.current) {
			persistVirtual.current = true;
			return;
		}
		saveVirtualPrefs(virtualPrefs.value);
	}, [virtualPrefs.value]);

	useEffect(() => {
		if (!persistGamepad.current) {
			persistGamepad.current = true;
			return;
		}
		saveGamepadMapping(gamepadMapping.value);
	}, [gamepadMapping.value]);

	useEffect(() => {
		if (!persistTouch.current) {
			persistTouch.current = true;
			return;
		}
		saveTouchPrefs(touchPrefs.value);
	}, [touchPrefs.value]);

	useEffect(() => {
		if (!touchPrefs.value.enabled) {
			touchEditing.value = false;
			touchState.clear();
		}
	}, [touchPrefs.value.enabled]);

	useEffect(() => {
		if (touchEditing.value) {
			touchState.clear();
			localLive.value = false;
		}
	}, [touchEditing.value]);

	useEffect(() => {
		if (settings.value && touchPrefs.value.enabled) {
			touchState.clear();
			localLive.value = false;
		}
	}, [settings.value, touchPrefs.value.enabled]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if (event.key !== VIRTUAL_PREFS_KEY) return;
			const next = loadVirtualPrefs();
			virtualPrefs.value = { ...next, enabled: virtualPrefs.value.enabled };
		};
		globalThis.addEventListener("storage", onStorage);
		return holdPage(() => globalThis.removeEventListener("storage", onStorage));
	}, []);

	useEffect(() => {
		if (!virtualPrefs.value.enabled && !touchPrefs.value.enabled) return;
		if (!connected.value || seats.value.length > 0 || pendingPlays.current > 0) return;
		syncSeats(1);
	}, [virtualPrefs.value.enabled, touchPrefs.value.enabled, connected.value]);

	// If a physical seat was lost while the page was suspended, take it again.
	useEffect(() => {
		if (!connected.value || chosen.value.length === 0) return;
		if (seats.value.length >= chosen.value.length || pendingPlays.current > 0) return;
		syncSeats(chosen.value.length);
	}, [connected.value, seats.value.length, chosen.value.length]);

	// iOS may suspend the page in native fullscreen or when switching apps.
	// Re-assert the seat on return. If the old socket is dead, its play response
	// never arrives and the five-second play timeout reconnects it.
	useEffect(() => {
		const resume = () => {
			if (document.visibilityState === "hidden" || pendingPlays.current > 0) return;
			const count = virtualPrefs.value.enabled || touchPrefs.value.enabled ? 1 : chosen.value.length;
			if (count > 0) syncSeats(count);
		};
		const onVisibility = () => {
			if (document.visibilityState === "visible") resume();
		};
		const video = videoRef.current;
		const onFullscreenEnd = () => resume();
		document.addEventListener("visibilitychange", onVisibility);
		video?.addEventListener("webkitendfullscreen", onFullscreenEnd);
		return holdPage(() => {
			document.removeEventListener("visibilitychange", onVisibility);
			video?.removeEventListener("webkitendfullscreen", onFullscreenEnd);
		});
	}, []);

	function toast(text: string): void {
		const id = ++toastSeq.current;
		toasts.value = [...toasts.value, { id, text }];
		setTimeout(() => {
			toasts.value = toasts.value.filter((item) => item.id !== id);
		}, 4200);
	}

	const { whepRef, audioRef } = useStream({
		nodeUrl: activeNodeUrl,
		video: videoRef,
		lite: lite.value,
		enabled: prefsLoaded.value,
		live,
		muted,
		volume,
		toast,
	});

	useEffect(() => {
		// deno-lint-ignore no-explicit-any
		const video = videoRef.current as any;
		if (!video) return;
		const onEnd = () => {
			fullscreen.value = false;
		};
		const onBegin = () => {
			fullscreen.value = true;
			settings.value = false;
		};
		video.addEventListener("webkitendfullscreen", onEnd);
		video.addEventListener("webkitbeginfullscreen", onBegin);
		return holdPage(() => {
			video.removeEventListener("webkitendfullscreen", onEnd);
			video.removeEventListener("webkitbeginfullscreen", onBegin);
		});
	}, []);

	// WebSocket (status and commands)
	useEffect(() => {
		let socket: WebSocket | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;
		let lastMessageAt = Date.now();
		let isClosed = false;

		function connectWs() {
			if (isClosed) return;
			socket = new WebSocket(wsUrl(activeNodeUrl));
			wsRef.current = socket;

			socket.addEventListener("open", () => {
				connected.value = true;
				lastMessageAt = Date.now();
				const single = virtualPrefs.value.enabled || touchPrefs.value.enabled;
				const count = single ? 1 : chosen.value.length;
				if (!count) return;
				pendingPlays.current += 1;
				playPendingSince.current = Date.now();
				send(socket, { op: "play", data: { count } });
			});

			socket.addEventListener("message", (event) => {
				lastMessageAt = Date.now();
				if (typeof event.data !== "string") return;
				try {
					const msg = JSON.parse(event.data) as ServerMessage;
					if (msg.op === "play") {
						pendingPlays.current = Math.max(0, pendingPlays.current - 1);
						playPendingSince.current = pendingPlays.current === 0 ? 0 : Date.now();
						const granted = msg.data.seats;
						seats.value = granted;
						if (pendingPlays.current > 0) return;
						if (virtualPrefs.value.enabled || touchPrefs.value.enabled) {
							if (granted.length >= 1) return;
							toast("All remote pads are taken.");
							return;
						}
						const selected = selectedPads(pads.value, chosen.value);
						if (granted.length >= selected.length) return;
						chosen.value = selected.slice(0, granted.length).map((pad) => pad.index);
						toast(granted.length ? "Not enough remote pads." : "All remote pads are taken.");
					} else if (msg.op === "status") {
						capture.value = msg.data.capture;
						if (!msg.data.capture.running) live.value = false;
						pico.value = msg.data.pico;
						occupied.value = msg.data.occupied;
					} else if (msg.op === "ping") {
						send(socket, { op: "pong" });
					}
				} catch {
					// Ignore invalid messages
				}
			});

			socket.addEventListener("close", () => {
				wsRef.current = null;
				pendingPlays.current = 0;
				playPendingSince.current = 0;
				seats.value = [];
				connected.value = false;
				if (!isClosed) {
					retryTimer = globalThis.setTimeout(connectWs, 1500);
				}
			});
		}

		const staleTimer = globalThis.setInterval(() => {
			if (!socket || socket.readyState !== WebSocket.OPEN) return;
			// A play request that never receives its seat response leaves the
			// HUD without P1 and silently blocks later seat claims.
			if (
				pendingPlays.current > 0 && playPendingSince.current > 0 &&
				Date.now() - playPendingSince.current > 5000
			) {
				socket.close(4000, "play timeout");
				return;
			}
			// The node sends a status/ping at least every 30 seconds. A quiet
			// socket after an iOS suspension is usually dead even if it still
			// reports OPEN.
			if (Date.now() - lastMessageAt > 45_000) socket.close(4000, "stale");
		}, 2_000);

		connectWs();

		return holdPage(() => {
			isClosed = true;
			clearTimeout(retryTimer);
			clearInterval(staleTimer);
			socket?.close();
			wsRef.current = null;
			if (document.pointerLockElement) document.exitPointerLock();
			if (document.fullscreenElement) void document.exitFullscreen();
		});
	}, [activeNodeUrl]);

	// Gamepads
	useEffect(() => {
		const tracker = createInputTracker();
		inputRef.current = tracker;
		tracker.attach();
		const knownIds = new Set<string>();

		const updatePads = () => {
			const before = pads.value;
			const next = listGamepads();
			const previous = new Set(knownIds);
			knownIds.clear();
			for (const pad of next) knownIds.add(padKey(pad));
			pads.value = next;

			if (virtualPrefs.value.enabled || touchPrefs.value.enabled) {
				if (next.length > before.length) {
					toast(
						touchPrefs.value.enabled
							? "Controller detected. Turn off Touch controller to use it."
							: "Controller detected. Turn off Virtual controller to use it.",
					);
				}
				return;
			}

			const still = remapChosenIndices(chosen.value, before, next);
			const lost = still.length !== chosen.value.length;
			chosen.value = still;
			if (lost) syncSeats(still.length);

			// A Backbone/controller is plug-and-play on iPhone. Claim one seat for
			// a pad that just appeared, not one the user deliberately released.
			if (isIosLike() && chosen.value.length === 0) {
				const fresh = next.find((pad) => !previous.has(padKey(pad)));
				if (fresh) {
					if (occupied.value.length >= PAD_COUNT) {
						toast("All remote pads are taken.");
						return;
					}
					chosen.value = [fresh.index];
					syncSeats(1);
				}
			}
			if (lost && chosen.value.length === 0 && next.length > 0) {
				toast("Controller seat released. Tap the controller to take a seat again.");
			}
		};

		updatePads();
		globalThis.addEventListener("gamepadconnected", updatePads);
		globalThis.addEventListener("gamepaddisconnected", updatePads);
		const watchdog = globalThis.setInterval(updatePads, 2000);
		const onVisible = () => {
			if (document.visibilityState === "visible") updatePads();
		};
		const video = videoRef.current;
		const onFullscreenEnd = () => updatePads();
		document.addEventListener("visibilitychange", onVisible);
		video?.addEventListener("webkitendfullscreen", onFullscreenEnd);

		return holdPage(() => {
			tracker.detach();
			inputRef.current = null;
			globalThis.clearInterval(watchdog);
			globalThis.removeEventListener("gamepadconnected", updatePads);
			globalThis.removeEventListener("gamepaddisconnected", updatePads);
			document.removeEventListener("visibilitychange", onVisible);
			video?.removeEventListener("webkitendfullscreen", onFullscreenEnd);
		});
	}, []);

	// iPhone native fullscreen hides the page and stops the gamepad loop. If a
	// controller arrives while it is open, return to the page instead of
	// leaving the user with a stream that ignores the controller.
	useEffect(() => {
		const onGamepad = () => {
			// deno-lint-ignore no-explicit-any
			const video = videoRef.current as any;
			if (video?.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === "function") {
				try {
					video.webkitExitFullscreen();
					toast("Controller connected. Native fullscreen pauses web controls, so it was closed.");
				} catch {
					// The system player refused to close; the user can tap Done.
				}
			}
		};
		globalThis.addEventListener("gamepadconnected", onGamepad);
		return holdPage(() => globalThis.removeEventListener("gamepadconnected", onGamepad));
	}, []);

	useEffect(() => {
		if (!virtualPrefs.value.enabled) {
			virtualRef.current?.detach();
			virtualRef.current = null;
			localLive.value = false;
			return;
		}
		const pad = createVirtualPad();
		virtualRef.current = pad;
		pad.attach();
		return holdPage(() => {
			pad.detach();
			if (virtualRef.current === pad) virtualRef.current = null;
		});
	}, [virtualPrefs.value.enabled]);

	// Gamepad input send loop
	useEffect(() => {
		let frame = 0;
		let epoch = 0;
		const lastBySeat = new Map<number, PadState>();
		let lastAssignedKey = "";

		let alive = true;
		const loop = (token: number) => {
			if (!alive || token !== epoch) return;
			frame = requestAnimationFrame(() => loop(token));

			if (virtualPrefs.value.enabled || touchPrefs.value.enabled) {
				const sampled = virtualPrefs.value.enabled
					? virtualRef.current?.sample(virtualPrefs.value) ?? NEUTRAL
					: touchState.sample();
				if (virtualPrefs.value.enabled && mapOpen.value && !samePad(sampled, mapLive.value)) {
					mapLive.value = sampled;
				}
				// Input used to test a mapping or move touch controls must not reach the game.
				const suppressed = mapOpen.value || gamepadMapOpen.value ||
					(touchPrefs.value.enabled && (touchEditing.value || settings.value));
				const state = suppressed ? NEUTRAL : sampled;
				const active = !suppressed && !samePad(state, NEUTRAL);
				if (active !== localLive.value) localLive.value = active;

				const ws = wsRef.current;
				const assigned = seats.value;
				if (!ws || ws.readyState !== WebSocket.OPEN || !assigned.length) {
					if (lastAssignedKey) {
						lastBySeat.clear();
						lastAssignedKey = "";
					}
					return;
				}
				const assignedKey = assigned.join(",");
				if (assignedKey !== lastAssignedKey) {
					lastBySeat.clear();
					lastAssignedKey = assignedKey;
				}
				const seat = assigned[0]!;
				const previous = lastBySeat.get(seat);
				if (previous && samePad(previous, state)) return;
				lastBySeat.set(seat, state);
				send(ws, { op: "pad", data: state, seat });
				return;
			}

			const tracker = inputRef.current;
			if (!tracker) return;

			const sampled = new Map<number, PadState>();
			const active: number[] = [];
			for (const pad of pads.value) {
				const state = tracker.sample(pad.index, false, gamepadMapping.value);
				sampled.set(pad.index, state);
				if (!gamepadMapOpen.value && !samePad(state, NEUTRAL)) active.push(pad.index);
			}
			if (!sameIds(active, livePads.value)) livePads.value = active;

			const ws = wsRef.current;
			const assigned = seats.value;
			const assignedKey = assigned.join(",");
			if (!ws || ws.readyState !== WebSocket.OPEN || !assigned.length) {
				if (lastAssignedKey) {
					lastBySeat.clear();
					lastAssignedKey = "";
				}
				return;
			}

			if (assignedKey !== lastAssignedKey) {
				lastBySeat.clear();
				lastAssignedKey = assignedKey;
			}

			const selected = selectedPads(pads.value, chosen.value);

			for (let i = 0; i < assigned.length; i++) {
				const seat = assigned[i]!;
				const pad = selected[i];
				const sampledState = i === 0
					? tracker.sample(pad ? pad.index : null, true, gamepadMapping.value)
					: pad
					? sampled.get(pad.index) ?? NEUTRAL
					: NEUTRAL;
				const state = gamepadMapOpen.value ? NEUTRAL : sampledState;
				const previous = lastBySeat.get(seat);
				if (previous && samePad(previous, state)) continue;
				lastBySeat.set(seat, state);
				send(ws, { op: "pad", data: state, seat });
			}
		};

		const restart = () => {
			if (!alive) return;
			epoch++;
			const token = epoch;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => loop(token));
		};
		const onVisible = () => {
			if (document.visibilityState === "visible") restart();
		};
		const video = videoRef.current;
		const onFullscreenEnd = () => restart();
		document.addEventListener("visibilitychange", onVisible);
		video?.addEventListener("webkitendfullscreen", onFullscreenEnd);

		frame = requestAnimationFrame(() => loop(epoch));
		return holdPage(() => {
			alive = false;
			cancelAnimationFrame(frame);
			document.removeEventListener("visibilitychange", onVisible);
			video?.removeEventListener("webkitendfullscreen", onFullscreenEnd);
		});
	}, []);

	// Keyboard shortcuts (Escape opens settings, Tab opens the virtual controller mapping)
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (uiHidden.value) {
				if (event.code === "Escape" && !event.repeat) {
					event.preventDefault();
					uiHidden.value = false;
				}
				return;
			}
			if (event.code === "Tab" && virtualPrefs.value.enabled && !isTyping(event.target)) {
				event.preventDefault();
				if (!event.repeat) toggleMap();
				return;
			}
			if (event.code !== "Escape" || event.repeat) return;
			if (touchEditing.value) {
				event.preventDefault();
				touchEditing.value = false;
				return;
			}
			// The mapping windows close themselves on Escape.
			if (document.pointerLockElement || mapOpen.value || gamepadMapOpen.value) return;
			settings.value = !settings.value;
		};
		globalThis.addEventListener("keydown", onKey);
		return holdPage(() => globalThis.removeEventListener("keydown", onKey));
	}, []);

	// Synchro Volume / Mute
	useEffect(() => {
		if (videoRef.current) videoRef.current.muted = true;
		const audio = audioRef.current?.audio;
		if (!audio) return;
		audio.muted = muted.value;
		audio.volume = volume.value;
	}, [muted.value, volume.value, live.value]);

	const stats = useStreamStats({
		whep: whepRef,
		show: showStats.value,
		watchNetwork: quality.value === "auto" && !lite.value,
		onSlow: () => {
			lite.value = true;
			toast("Slow network: switched to the lite stream.");
		},
	});

	// Fullscreen
	useEffect(() => {
		const onFs = () => {
			const on = document.fullscreenElement === stageRef.current;
			fullscreen.value = on;
			if (on) settings.value = false;
		};
		document.addEventListener("fullscreenchange", onFs);
		return holdPage(() => document.removeEventListener("fullscreenchange", onFs));
	}, []);

	function setQuality(value: Quality): void {
		quality.value = value;
		lite.value = value === "lite";
	}

	function syncSeats(count: number): void {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (count > 0) {
			pendingPlays.current += 1;
			playPendingSince.current = Date.now();
			send(ws, { op: "play", data: { count } });
			return;
		}
		pendingPlays.current = 0;
		playPendingSince.current = 0;
		seats.value = [];
		send(ws, { op: "watch" });
	}

	function toggleSeat(index: number): void {
		if (virtualPrefs.value.enabled || touchPrefs.value.enabled) return;
		const claimed = chosen.value.includes(index);
		if (!claimed && occupied.value.length >= PAD_COUNT) return;
		chosen.value = claimed ? chosen.value.filter((item) => item !== index) : [...chosen.value, index];
		syncSeats(chosen.value.length);
	}

	function setVirtualEnabled(enabled: boolean): void {
		if (enabled === virtualPrefs.value.enabled) {
			if (enabled) syncSeats(1);
			return;
		}
		if (enabled) {
			if (occupied.value.length >= PAD_COUNT && seats.value.length === 0) {
				toast("All remote pads are taken.");
				return;
			}
			gamepadMapOpen.value = false;
			touchEditing.value = false;
			touchState.clear();
			if (touchPrefs.value.enabled) {
				touchPrefs.value = { ...touchPrefs.value, enabled: false };
			}
			chosen.value = [];
			virtualPrefs.value = { ...virtualPrefs.value, enabled: true };
			syncSeats(1);
			return;
		}
		mapOpen.value = false;
		virtualPrefs.value = { ...virtualPrefs.value, enabled: false };
		syncSeats(0);
	}

	function setTouchEnabled(enabled: boolean): void {
		if (enabled === touchPrefs.value.enabled) {
			if (enabled) syncSeats(1);
			return;
		}
		if (enabled) {
			if (occupied.value.length >= PAD_COUNT && seats.value.length === 0) {
				toast("All remote pads are taken.");
				return;
			}
			mapOpen.value = false;
			gamepadMapOpen.value = false;
			touchEditing.value = false;
			touchState.clear();
			if (virtualPrefs.value.enabled) {
				virtualPrefs.value = { ...virtualPrefs.value, enabled: false };
			}
			chosen.value = [];
			touchPrefs.value = { ...touchPrefs.value, enabled: true };
			syncSeats(1);
			return;
		}
		touchEditing.value = false;
		touchState.clear();
		touchPrefs.value = { ...touchPrefs.value, enabled: false };
		if (!virtualPrefs.value.enabled) syncSeats(0);
	}

	function editTouchLayout(): void {
		if (!touchPrefs.value.enabled) return;
		settings.value = false;
		touchState.clear();
		touchEditing.value = true;
	}

	function resetTouchLayouts(): void {
		touchPrefs.value = resetTouchPrefsLayouts(touchPrefs.value);
	}

	function hideAllUi(): void {
		if (document.pointerLockElement) document.exitPointerLock();
		settings.value = false;
		mapOpen.value = false;
		gamepadMapOpen.value = false;
		touchEditing.value = false;
		touchState.clear();
		localLive.value = false;
		uiHidden.value = true;
	}

	function toggleMap(): void {
		if (mapOpen.value) {
			mapOpen.value = false;
			return;
		}
		// The cursor is hidden while the mouse is captured.
		if (document.pointerLockElement) document.exitPointerLock();
		settings.value = false;
		gamepadMapOpen.value = false;
		mapOpen.value = true;
	}

	function onStageClick(): void {
		void videoRef.current?.play();
		void audioRef.current?.audio.play();
		if (uiHidden.value) {
			uiHidden.value = false;
			return;
		}
		if (settings.value) return;
		const virtual = virtualRef.current;
		if (!virtual || !virtualPrefs.value.enabled) return;
		if (virtual.usesMouseAxis(virtualPrefs.value) && stageRef.current) {
			virtual.requestPointerLock(stageRef.current);
		}
	}

	function toggleFullscreen(): void {
		// deno-lint-ignore no-explicit-any
		const video = videoRef.current as any;
		if (video?.webkitEnterFullscreen && !document.fullscreenEnabled) {
			// Native video fullscreen hands the page to the system player: the HUD
			// and touch overlay disappear and the page's input loop is suspended.
			if (
				virtualPrefs.value.enabled || touchPrefs.value.enabled || pads.value.length > 0 ||
				seats.value.length > 0
			) {
				toast(
					"Native video fullscreen pauses web controller input. Use Add to Home Screen for controller play.",
				);
				return;
			}
			video.webkitEnterFullscreen();
			return;
		}
		if (document.fullscreenElement) {
			void document.exitFullscreen();
		} else {
			void stageRef.current?.requestFullscreen();
		}
	}

	const hideHud = fullscreen.value && !touchPrefs.value.enabled;
	const banner = streamBanner(connected.value, capture.value, live.value);
	const selected = selectedPads(pads.value, chosen.value);
	const mappingPad = selected[0] ?? pads.value[0] ?? null;
	const seatByIndex = new Map(selected.map((pad, i) => [pad.index, seats.value[i]] as const));

	return (
		<section
			id="play"
			ref={stageRef}
			data-fill={fill.value ? "true" : undefined}
			data-idle={hideHud ? "true" : undefined}
			data-ui-hidden={uiHidden.value ? "true" : undefined}
			data-touch={touchPrefs.value.enabled ? "true" : undefined}
			data-touch-edit={touchEditing.value ? "true" : undefined}
			onClick={onStageClick}
			onContextMenu={(event) => {
				if (virtualPrefs.value.enabled || touchPrefs.value.enabled) event.preventDefault();
			}}
			onDblClick={(event) => {
				if (uiHidden.value) {
					event.preventDefault();
					uiHidden.value = false;
					return;
				}
				// Left click is a game button with a local controller: a double click must not resize the window.
				if (virtualPrefs.value.enabled || touchPrefs.value.enabled) return;
				event.preventDefault();
				toggleFullscreen();
			}}
		>
			<video
				ref={videoRef}
				autoplay
				muted
				playsInline
				onPlaying={() => {
					live.value = true;
				}}
			/>

			{banner && (
				<div>
					<h2>{banner.title}</h2>
					<p>{banner.body}</p>
				</div>
			)}

			{showStats.value && (
				<dl>
					<div>
						<dt>Bitrate</dt>
						<dd>{stats.value ? `${stats.value.bitrateKbps} kb/s` : "-"}</dd>
					</div>
					<div>
						<dt>FPS</dt>
						<dd>{stats.value ? Math.round(stats.value.fps) : "-"}</dd>
					</div>
					<div>
						<dt>Lost</dt>
						<dd>{stats.value ? stats.value.packetsLost : "-"}</dd>
					</div>
					<div>
						<dt>RTT</dt>
						<dd>{formatMs(stats.value?.rttMs)}</dd>
					</div>
					<div>
						<dt>Jitter buffer</dt>
						<dd>{formatMs(stats.value?.jitterBufferMs)}</dd>
					</div>
					<div>
						<dt>Decode</dt>
						<dd>{formatMs(stats.value?.decodeMs)}</dd>
					</div>
					<div>
						<dt>Dropped</dt>
						<dd>{stats.value?.framesDropped ?? "-"}</dd>
					</div>
				</dl>
			)}

			{virtualPrefs.value.enabled && mapOpen.value && (
				<ControllerDialog
					prefs={virtualPrefs}
					live={mapLive}
					pad={virtualRef}
					onClose={() => mapOpen.value = false}
				/>
			)}

			{!virtualPrefs.value.enabled && !touchPrefs.value.enabled && gamepadMapOpen.value && (
				<GamepadMappingDialog
					mapping={gamepadMapping}
					gamepadIndex={mappingPad?.index ?? null}
					gamepadName={mappingPad ? padLabel(mappingPad.id) : null}
					onClose={() => gamepadMapOpen.value = false}
				/>
			)}

			<div id="hud" onClick={(event) => event.stopPropagation()}>
				<div>
					<span className="brand">
						<span>s2</span>pipe
					</span>
					<span>
						<Gamepad2 size={13} aria-hidden="true" />
						<span>
							<strong>{occupied.value.length}</strong>
							<span>/{PAD_COUNT} playing</span>
						</span>
					</span>
					<div>
						<span className="pill" data-ok={capture.value?.running ? "true" : "false"}>
							Capture {capture.value?.running ? "live" : "down"}
						</span>
						<span
							className="pill"
							data-ok={pico.value?.connected ? "true" : "false"}
							title={picoTitle(pico.value)}
						>
							Pico {pico.value?.transport === "wifi" ? "Wi-Fi" : ""}{" "}
							{pico.value?.connected ? "ready" : "off"}
						</span>
						<span className="pill" data-ok={connected.value ? "true" : "false"}>
							{connected.value ? "Connected" : "Connecting"}
						</span>
					</div>
				</div>

				<div>
					{virtualPrefs.value.enabled
						? (
							<div className="pad-list">
								<button
									type="button"
									data-state={seats.value[0] !== undefined ? "live" : "ready"}
									data-active={localLive.value ? "true" : undefined}
									disabled={!connected.value}
									onClick={() => setVirtualEnabled(false)}
								>
									<span>Virtual controller</span>
									<span>{seats.value[0] !== undefined ? `P${seats.value[0] + 1}` : "..."}</span>
								</button>
							</div>
						)
						: touchPrefs.value.enabled
						? null
						: pads.value.length > 0
						? (
							<div className="pad-list">
								{pads.value.map((pad) => {
									const seat = seatByIndex.get(pad.index);
									const claimed = chosen.value.includes(pad.index);
									const full = occupied.value.length >= PAD_COUNT && !claimed;
									const state = seat !== undefined ? "live" : claimed ? "ready" : "off";
									const status = seat !== undefined
										? `P${seat + 1}`
										: claimed
										? "..."
										: full
										? "Full"
										: "Play";
									return (
										<button
											type="button"
											key={pad.index}
											data-state={state}
											data-active={livePads.value.includes(pad.index) ? "true" : undefined}
											disabled={full || !connected.value}
											onClick={() => toggleSeat(pad.index)}
										>
											<span>{padLabel(pad.id)}</span>
											<span>{status}</span>
										</button>
									);
								})}
							</div>
						)
						: (
							<>
								<p>Connect a gamepad, then click it to play.</p>
								<button
									type="button"
									className="btn"
									disabled={!connected.value || occupied.value.length >= PAD_COUNT}
									onClick={() => setVirtualEnabled(true)}
								>
									Use virtual controller
								</button>
								<button
									type="button"
									className="btn"
									disabled={!connected.value || occupied.value.length >= PAD_COUNT}
									onClick={() => setTouchEnabled(true)}
								>
									Use touch controller
								</button>
							</>
						)}
					<div>
						{virtualPrefs.value.enabled && (
							<button
								type="button"
								className="btn btn-icon"
								aria-label="Map the virtual controller"
								title="Map the virtual controller (Tab)"
								onClick={toggleMap}
							>
								<Keyboard size={16} />
							</button>
						)}
						{!virtualPrefs.value.enabled && !touchPrefs.value.enabled && pads.value.length > 0 && (
							<button
								type="button"
								className="btn btn-icon"
								aria-label="Map controller buttons"
								title="Map controller buttons"
								onClick={() => {
									settings.value = false;
									mapOpen.value = false;
									gamepadMapOpen.value = true;
								}}
							>
								<Gamepad2 size={16} />
							</button>
						)}
						<button
							type="button"
							className="btn btn-icon"
							data-active={touchPrefs.value.enabled ? "true" : undefined}
							data-live={localLive.value && touchPrefs.value.enabled ? "true" : undefined}
							aria-label="Touch controller"
							aria-pressed={touchPrefs.value.enabled}
							title={touchPrefs.value.enabled
								? `Touch controller${
									seats.value[0] !== undefined ? ` (P${seats.value[0] + 1})` : " is starting..."
								} — tap to turn off`
								: "Turn on the touch controller"}
							onClick={() => setTouchEnabled(!touchPrefs.value.enabled)}
						>
							<Smartphone size={16} />
						</button>
						{touchPrefs.value.enabled && (
							<button
								type="button"
								className="btn btn-icon"
								aria-label="Edit touch layout"
								title="Edit touch layout"
								onClick={editTouchLayout}
							>
								<Move size={16} />
							</button>
						)}
						<button
							type="button"
							className="btn btn-icon"
							aria-label="Hide all UI"
							title="Hide all UI (tap the stream to show)"
							onClick={hideAllUi}
						>
							<EyeOff size={16} />
						</button>
						<button
							type="button"
							className="btn btn-icon"
							aria-label={muted.value ? "Unmute" : "Mute"}
							onClick={() => muted.value = !muted.value}
						>
							{muted.value ? <VolumeX size={16} /> : <Volume2 size={16} />}
						</button>
						<button
							type="button"
							className="btn btn-icon"
							aria-label={fullscreen.value ? "Exit fullscreen" : "Fullscreen"}
							onClick={toggleFullscreen}
						>
							{fullscreen.value ? <Minimize size={16} /> : <Maximize size={16} />}
						</button>
						<button
							type="button"
							className="btn btn-icon"
							aria-label="Settings"
							onClick={() => settings.value = !settings.value}
						>
							<Settings size={16} />
						</button>
					</div>
				</div>
			</div>

			{touchPrefs.value.enabled && !uiHidden.value && (
				<TouchController
					prefs={touchPrefs}
					state={touchState}
					editing={touchEditing.value}
					onDone={() => touchEditing.value = false}
				/>
			)}

			{settings.value && (
				<aside onClick={(event) => event.stopPropagation()}>
					<div>
						<h2>Settings</h2>
						<button
							type="button"
							className="btn btn-icon"
							aria-label="Close settings"
							onClick={() => settings.value = false}
						>
							<X size={16} />
						</button>
					</div>

					<div className="field">
						<span>Node</span>
						<div>
							<p>{activeNodeUrl}</p>
						</div>
					</div>

					<label className="field">
						<span>Volume</span>
						<input
							type="range"
							min="0"
							max="1"
							step="0.05"
							value={volume.value}
							onInput={(event) => {
								volume.value = Number((event.target as HTMLInputElement).value);
								if (volume.value > 0) muted.value = false;
							}}
						/>
					</label>

					<label className="field">
						<span>Quality</span>
						<select
							value={quality.value}
							onChange={(event) => setQuality((event.target as HTMLSelectElement).value as Quality)}
						>
							<option value="auto">
								{lite.value && quality.value === "auto"
									? "Auto (using lite)"
									: "Auto (lite on a slow network)"}
							</option>
							<option value="full">Full</option>
							<option value="lite">Lite (540p, light on bandwidth)</option>
						</select>
					</label>

					<label>
						<input
							type="checkbox"
							checked={fill.value}
							onChange={(event) => fill.value = (event.target as HTMLInputElement).checked}
						/>
						Fill (crop) instead of letterbox
					</label>

					<label>
						<input
							type="checkbox"
							checked={showStats.value}
							onChange={(event) => showStats.value = (event.target as HTMLInputElement).checked}
						/>
						Overlay WebRTC stats
					</label>

					<section>
						<h3>Virtual controller</h3>
						<label>
							<input
								type="checkbox"
								checked={virtualPrefs.value.enabled}
								onChange={(event) => setVirtualEnabled((event.target as HTMLInputElement).checked)}
							/>
							Enable virtual controller
						</label>
						<p>
							Keyboard and mouse drive one Pico seat. Physical gamepads on this browser are ignored while
							this is on. It stays off after a reload.
						</p>
						<button
							type="button"
							className="btn btn-block"
							disabled={!virtualPrefs.value.enabled}
							onClick={toggleMap}
						>
							Map buttons (Tab)
						</button>
					</section>

					<section>
						<h3>Touch controller</h3>
						<label>
							<input
								type="checkbox"
								checked={touchPrefs.value.enabled}
								onChange={(event) => setTouchEnabled((event.target as HTMLInputElement).checked)}
							/>
							Enable touch controller
						</label>
						<p>
							On-screen buttons and two sticks for a phone or tablet. It uses one Pico seat; the keyboard
							virtual controller and physical gamepads are paused while it is on.
						</p>
						<label className="field">
							<span>Control size</span>
							<input
								type="range"
								min="0.7"
								max="1.25"
								step="0.05"
								value={touchPrefs.value.scale}
								onInput={(event) => {
									touchPrefs.value = {
										...touchPrefs.value,
										scale: Number((event.target as HTMLInputElement).value),
									};
								}}
							/>
						</label>
						<div className="touch-settings-actions">
							<button
								type="button"
								className="btn"
								disabled={!touchPrefs.value.enabled}
								onClick={editTouchLayout}
							>
								Edit layout
							</button>
							<button
								type="button"
								className="btn"
								disabled={!touchPrefs.value.enabled}
								onClick={resetTouchLayouts}
							>
								Reset layout
							</button>
						</div>
						<p>
							In edit mode, drag every control where you want it. Landscape and portrait positions are
							saved separately in this browser.
						</p>
					</section>

					<section>
						<h3>iPhone fullscreen</h3>
						<p>
							iPhone Safari's native video fullscreen pauses web controller input. To play fullscreen with
							a Backbone or touch controller, open the page, use Share → Add to Home Screen, and launch
							s2pipe from the Home Screen. Native fullscreen remains available when no controller is
							connected, for watching.
						</p>
					</section>

					<section>
						<h3>Hide UI</h3>
						<p>
							The eye button in the HUD hides the HUD, touch pad, stats and toasts. Tap the stream or
							press Esc to show them again. Physical gamepad and keyboard input keep working while the UI
							is hidden.
						</p>
					</section>

					<section>
						<h3>Controller mapping</h3>
						<p>
							Remap a physical gamepad's buttons, swap or invert sticks, and adjust the deadzone. The
							mapping is stored in this browser.
						</p>
						{(virtualPrefs.value.enabled || touchPrefs.value.enabled) && (
							<p>
								Turn off the {virtualPrefs.value.enabled ? "virtual" : "touch"}{" "}
								controller to use a physical gamepad.
							</p>
						)}
						<button
							type="button"
							className="btn btn-block"
							disabled={pads.value.length === 0 || virtualPrefs.value.enabled || touchPrefs.value.enabled}
							onClick={() => {
								if (virtualPrefs.value.enabled || touchPrefs.value.enabled) return;
								settings.value = false;
								gamepadMapOpen.value = true;
							}}
						>
							Map controller buttons
						</button>
						{pads.value.length === 0 && <p>Connect a gamepad and press a button to make it available.</p>}
					</section>

					<section>
						<h3>Home</h3>
						<p>
							Home on the Switch is the Xbox Guide / PS button. Capture / Share is Capture. Windows and
							Steam often steal Guide before the browser can send Home.
						</p>
						<p>
							Game Bar: Windows Settings, Gaming, Xbox Game Bar. Turn off "Open Xbox Game Bar using this
							button on a controller".
						</p>
						<p>
							Steam: Steam Settings, Controller. Turn off "Guide button focuses Steam". If a Steam menu
							still opens, disable Steam Input for this pad or quit Steam while you play.
						</p>
						<p>
							Last resort: hold Minus and Plus together (View + Menu, Select + Start, or - and +). That
							sends Home without using Guide.
						</p>
					</section>
				</aside>
			)}

			<ul aria-live="polite">
				{toasts.value.map((item) => <li key={item.id}>{item.text}</li>)}
			</ul>
		</section>
	);
}
