import { clampAxis, PAD_CENTER, PadButton, type PadState } from "@s2pipe/shared/types/pad";

/**
 * On-screen controller for touch devices. The layout is stored twice, once for
 * landscape and once for portrait, so rotating a phone does not squeeze the
 * button clusters into each other.
 */

export const TOUCH_CONTROLS = [
	"leftStick",
	"rightStick",
	"dpad",
	"a",
	"b",
	"x",
	"y",
	"l",
	"r",
	"zl",
	"zr",
	"minus",
	"plus",
	"home",
	"capture",
	"lstick",
	"rstick",
] as const;

export type TouchControlId = typeof TOUCH_CONTROLS[number];
export type TouchButtonId = Exclude<TouchControlId, "leftStick" | "rightStick" | "dpad">;
export type TouchPoint = { x: number; y: number };
export type TouchLayout = Record<TouchControlId, TouchPoint>;

export type TouchPrefs = {
	version: 1;
	enabled: boolean;
	scale: number;
	layouts: { wide: TouchLayout; tall: TouchLayout };
};

export type TouchDpadState = { up: boolean; down: boolean; left: boolean; right: boolean };

/** Size in `--touch-unit` multiples. The CSS unit is a clamped vmin. */
export const TOUCH_SIZE: Record<TouchControlId, number> = {
	leftStick: 2.65,
	rightStick: 2.65,
	dpad: 2.9,
	a: 1.15,
	b: 1.15,
	x: 1.15,
	y: 1.15,
	l: 1.15,
	r: 1.15,
	zl: 1.15,
	zr: 1.15,
	minus: 0.95,
	plus: 0.95,
	home: 1.0,
	capture: 1.0,
	lstick: 0.9,
	rstick: 0.9,
};

export const TOUCH_LABELS: Record<TouchControlId, string> = {
	leftStick: "Left stick",
	rightStick: "Right stick",
	dpad: "D-pad",
	a: "A",
	b: "B",
	x: "X",
	y: "Y",
	l: "L",
	r: "R",
	zl: "ZL",
	zr: "ZR",
	minus: "Minus",
	plus: "Plus",
	home: "Home",
	capture: "Capture",
	lstick: "L stick click",
	rstick: "R stick click",
};

const BUTTON_BITS: Record<TouchButtonId, number> = {
	a: PadButton.A,
	b: PadButton.B,
	x: PadButton.X,
	y: PadButton.Y,
	l: PadButton.L,
	r: PadButton.R,
	zl: PadButton.ZL,
	zr: PadButton.ZR,
	minus: PadButton.Minus,
	plus: PadButton.Plus,
	home: PadButton.Home,
	capture: PadButton.Capture,
	lstick: PadButton.LStick,
	rstick: PadButton.RStick,
};

const FACE_BUTTONS: { id: TouchButtonId; label: string }[] = [
	{ id: "a", label: "A" },
	{ id: "b", label: "B" },
	{ id: "x", label: "X" },
	{ id: "y", label: "Y" },
	{ id: "l", label: "L" },
	{ id: "r", label: "R" },
	{ id: "zl", label: "ZL" },
	{ id: "zr", label: "ZR" },
	{ id: "minus", label: "−" },
	{ id: "plus", label: "+" },
	{ id: "home", label: "Home" },
	{ id: "capture", label: "Cap" },
	{ id: "lstick", label: "L3" },
	{ id: "rstick", label: "R3" },
];

export const TOUCH_BUTTONS = FACE_BUTTONS;

const WIDE_LAYOUT: TouchLayout = {
	leftStick: { x: 0.15, y: 0.82 },
	rightStick: { x: 0.85, y: 0.82 },
	dpad: { x: 0.15, y: 0.52 },
	a: { x: 0.90, y: 0.52 },
	b: { x: 0.85, y: 0.61 },
	x: { x: 0.85, y: 0.43 },
	y: { x: 0.80, y: 0.52 },
	l: { x: 0.12, y: 0.30 },
	r: { x: 0.88, y: 0.30 },
	zl: { x: 0.04, y: 0.21 },
	zr: { x: 0.96, y: 0.21 },
	minus: { x: 0.44, y: 0.94 },
	plus: { x: 0.56, y: 0.94 },
	capture: { x: 0.44, y: 0.85 },
	home: { x: 0.56, y: 0.85 },
	lstick: { x: 0.30, y: 0.92 },
	rstick: { x: 0.70, y: 0.92 },
};

const TALL_LAYOUT: TouchLayout = {
	leftStick: { x: 0.18, y: 0.82 },
	rightStick: { x: 0.82, y: 0.82 },
	dpad: { x: 0.18, y: 0.52 },
	a: { x: 0.92, y: 0.52 },
	b: { x: 0.82, y: 0.62 },
	x: { x: 0.82, y: 0.42 },
	y: { x: 0.72, y: 0.52 },
	l: { x: 0.13, y: 0.30 },
	r: { x: 0.87, y: 0.30 },
	zl: { x: 0.04, y: 0.20 },
	zr: { x: 0.96, y: 0.20 },
	minus: { x: 0.44, y: 0.94 },
	plus: { x: 0.56, y: 0.94 },
	capture: { x: 0.44, y: 0.85 },
	home: { x: 0.56, y: 0.85 },
	lstick: { x: 0.30, y: 0.92 },
	rstick: { x: 0.70, y: 0.92 },
};

const STORAGE_KEY = "s2pipe.touch.v1";
const MIN_SCALE = 0.7;
const MAX_SCALE = 1.25;

function copyLayout(source: TouchLayout): TouchLayout {
	const out = {} as TouchLayout;
	for (const id of TOUCH_CONTROLS) out[id] = { ...source[id] };
	return out;
}

export function defaultTouchLayout(wide: boolean): TouchLayout {
	return copyLayout(wide ? WIDE_LAYOUT : TALL_LAYOUT);
}

export function defaultTouchPrefs(): TouchPrefs {
	return {
		version: 1,
		enabled: false,
		scale: 1,
		layouts: { wide: defaultTouchLayout(true), tall: defaultTouchLayout(false) },
	};
}

function clampCoordinate(value: unknown, fallback: number): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(0.97, Math.max(0.03, number));
}

function clampScale(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return 1;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, number));
}

export function parseTouchLayout(raw: unknown, fallback: TouchLayout): TouchLayout {
	const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out = {} as TouchLayout;
	for (const id of TOUCH_CONTROLS) {
		const item = source[id];
		const point = item && typeof item === "object" ? item as Partial<TouchPoint> : null;
		out[id] = point
			? {
				x: clampCoordinate(point.x, fallback[id].x),
				y: clampCoordinate(point.y, fallback[id].y),
			}
			: { ...fallback[id] };
	}
	return out;
}

export function parseTouchPrefs(raw: unknown): TouchPrefs {
	const source = (raw && typeof raw === "object" ? raw : {}) as Partial<TouchPrefs>;
	const layouts = (source.layouts && typeof source.layouts === "object" ? source.layouts : {}) as Partial<
		TouchPrefs["layouts"]
	>;
	const wide = defaultTouchLayout(true);
	const tall = defaultTouchLayout(false);
	return {
		version: 1,
		enabled: source.enabled === true,
		scale: clampScale(source.scale),
		layouts: {
			wide: parseTouchLayout(layouts.wide, wide),
			tall: parseTouchLayout(layouts.tall, tall),
		},
	};
}

export function loadTouchPrefs(): TouchPrefs {
	try {
		return parseTouchPrefs(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
	} catch {
		return defaultTouchPrefs();
	}
}

export function saveTouchPrefs(prefs: TouchPrefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(parseTouchPrefs(prefs)));
	} catch {
		// Quota or private mode.
	}
}

export function resetTouchLayout(prefs: TouchPrefs, wide: boolean): TouchPrefs {
	return {
		...prefs,
		layouts: { ...prefs.layouts, [wide ? "wide" : "tall"]: defaultTouchLayout(wide) },
	};
}

export function resetTouchPrefsLayouts(prefs: TouchPrefs): TouchPrefs {
	return {
		...prefs,
		layouts: { wide: defaultTouchLayout(true), tall: defaultTouchLayout(false) },
	};
}

export function mirrorTouchLayout(layout: TouchLayout): TouchLayout {
	const out = {} as TouchLayout;
	for (const id of TOUCH_CONTROLS) {
		out[id] = { x: Math.min(0.97, Math.max(0.03, 1 - layout[id].x)), y: layout[id].y };
	}
	return out;
}

const DEADZONE = 0.12;

function axisToByte(value: number): number {
	if (!Number.isFinite(value) || Math.abs(value) < DEADZONE) return PAD_CENTER;
	return clampAxis((value + 1) * 127.5);
}

function clampStick(x: number, y: number): TouchPoint {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
	const magnitude = Math.hypot(x, y);
	if (magnitude <= 1) return { x, y };
	return { x: x / magnitude, y: y / magnitude };
}

export type TouchState = {
	setButton(id: TouchButtonId, down: boolean): void;
	setDpad(state: TouchDpadState): void;
	setStick(side: "left" | "right", x: number, y: number): void;
	clear(): void;
	sample(): PadState;
};

/**
 * Mutable controller state fed by the touch controls and read by the play
 * loop. Pointer handlers update it without triggering a Preact render.
 */
export function createTouchState(): TouchState {
	const held = new Map<TouchControlId, number>();
	let left: TouchPoint = { x: 0, y: 0 };
	let right: TouchPoint = { x: 0, y: 0 };

	return {
		setButton(id, down) {
			if (down) held.set(id, BUTTON_BITS[id]);
			else held.delete(id);
		},

		setDpad(dpad) {
			let bits = 0;
			if (dpad.up) bits |= PadButton.Up;
			if (dpad.down) bits |= PadButton.Down;
			if (dpad.left) bits |= PadButton.Left;
			if (dpad.right) bits |= PadButton.Right;
			if (bits) held.set("dpad", bits);
			else held.delete("dpad");
		},

		setStick(side, x, y) {
			if (side === "left") left = clampStick(x, y);
			else right = clampStick(x, y);
		},

		clear() {
			held.clear();
			left = { x: 0, y: 0 };
			right = { x: 0, y: 0 };
		},

		sample() {
			let buttons = 0;
			for (const bits of held.values()) buttons |= bits;
			// Minus + Plus is the common Switch fallback for Home.
			if ((buttons & PadButton.Minus) !== 0 && (buttons & PadButton.Plus) !== 0) {
				buttons |= PadButton.Home;
			}
			return {
				buttons,
				lx: axisToByte(left.x),
				ly: axisToByte(left.y),
				rx: axisToByte(right.x),
				ry: axisToByte(right.y),
			};
		},
	};
}
