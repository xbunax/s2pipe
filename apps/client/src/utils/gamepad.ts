import { clampAxis, PAD_CENTER, PadButton, type PadState } from "@s2pipe/shared/types/pad";

export const GAMEPAD_ACTIONS = [
	"B",
	"A",
	"Y",
	"X",
	"L",
	"R",
	"ZL",
	"ZR",
	"Minus",
	"Plus",
	"LStick",
	"RStick",
	"Up",
	"Down",
	"Left",
	"Right",
	"Home",
	"Capture",
] as const;

export type GamepadAction = typeof GAMEPAD_ACTIONS[number];

export const GAMEPAD_ACTION_LABELS: Record<GamepadAction, string> = {
	B: "B (bottom)",
	A: "A (right)",
	Y: "Y (left)",
	X: "X (top)",
	L: "L",
	R: "R",
	ZL: "ZL",
	ZR: "ZR",
	Minus: "Minus / Select",
	Plus: "Plus / Start",
	LStick: "L stick click",
	RStick: "R stick click",
	Up: "D-pad up",
	Down: "D-pad down",
	Left: "D-pad left",
	Right: "D-pad right",
	Home: "Home / Guide",
	Capture: "Capture / Share",
};

const ACTION_BITS: Record<GamepadAction, number> = {
	B: PadButton.B,
	A: PadButton.A,
	Y: PadButton.Y,
	X: PadButton.X,
	L: PadButton.L,
	R: PadButton.R,
	ZL: PadButton.ZL,
	ZR: PadButton.ZR,
	Minus: PadButton.Minus,
	Plus: PadButton.Plus,
	LStick: PadButton.LStick,
	RStick: PadButton.RStick,
	Up: PadButton.Up,
	Down: PadButton.Down,
	Left: PadButton.Left,
	Right: PadButton.Right,
	Home: PadButton.Home,
	Capture: PadButton.Capture,
};

const BUTTON_NAMES = [
	"Bottom",
	"Right",
	"Left",
	"Top",
	"L1",
	"R1",
	"L2",
	"R2",
	"Select",
	"Start",
	"L3",
	"R3",
	"D-Up",
	"D-Down",
	"D-Left",
	"D-Right",
	"Guide",
	"Share",
];

export type GamepadMapping = {
	version: 1;
	buttons: Record<GamepadAction, number | null>;
	swapSticks: boolean;
	invertLeftY: boolean;
	invertRightY: boolean;
	deadzone: number;
};

const STORAGE_KEY = "s2pipe.gamepadMapping.v1";
const MIN_DEADZONE = 0.05;
const MAX_DEADZONE = 0.35;
const DEFAULT_DEADZONE = 0.12;

function defaultButtons(): Record<GamepadAction, number | null> {
	return {
		B: 0,
		A: 1,
		Y: 2,
		X: 3,
		L: 4,
		R: 5,
		ZL: 6,
		ZR: 7,
		Minus: 8,
		Plus: 9,
		LStick: 10,
		RStick: 11,
		Up: 12,
		Down: 13,
		Left: 14,
		Right: 15,
		Home: 16,
		Capture: 17,
	};
}

export function defaultGamepadMapping(): GamepadMapping {
	return {
		version: 1,
		buttons: defaultButtons(),
		swapSticks: false,
		invertLeftY: false,
		invertRightY: false,
		deadzone: DEFAULT_DEADZONE,
	};
}

function buttonIndex(value: unknown): number | null {
	if (value === null) return null;
	const index = Number(value);
	if (!Number.isInteger(index) || index < 0 || index > 31) return null;
	return index;
}

function clampDeadzone(value: unknown): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULT_DEADZONE;
	return Math.min(MAX_DEADZONE, Math.max(MIN_DEADZONE, number));
}

export function parseGamepadMapping(raw: unknown): GamepadMapping {
	const source = (raw && typeof raw === "object" ? raw : {}) as Partial<GamepadMapping>;
	const rawButtons = (source.buttons && typeof source.buttons === "object" ? source.buttons : {}) as Record<
		string,
		unknown
	>;
	const buttons = defaultButtons();
	for (const action of GAMEPAD_ACTIONS) {
		const value = rawButtons[action];
		if (value === undefined) continue;
		buttons[action] = buttonIndex(value);
	}
	return {
		version: 1,
		buttons,
		swapSticks: Boolean(source.swapSticks),
		invertLeftY: Boolean(source.invertLeftY),
		invertRightY: Boolean(source.invertRightY),
		deadzone: clampDeadzone(source.deadzone),
	};
}

export function loadGamepadMapping(): GamepadMapping {
	try {
		return parseGamepadMapping(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
	} catch {
		return defaultGamepadMapping();
	}
}

export function saveGamepadMapping(mapping: GamepadMapping): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(parseGamepadMapping(mapping)));
	} catch {
		// Quota or private mode.
	}
}

export function gamepadButtonLabel(index: number | null): string {
	if (index === null) return "—";
	const name = BUTTON_NAMES[index] ?? "Button";
	return `${name} (${index})`;
}

export function assignGamepadButton(
	mapping: GamepadMapping,
	action: GamepadAction,
	button: number,
): GamepadMapping {
	const buttons = { ...mapping.buttons };
	for (const other of GAMEPAD_ACTIONS) {
		if (other !== action && buttons[other] === button) buttons[other] = null;
	}
	buttons[action] = button;
	return { ...mapping, buttons };
}

type SampleButton = { pressed?: boolean; value?: number };

function buttonDown(button: SampleButton | undefined): boolean {
	return Boolean(button?.pressed || (button?.value ?? 0) >= 0.5);
}

function axisToByte(value: number, deadzone: number): number {
	if (!Number.isFinite(value) || Math.abs(value) < deadzone) return PAD_CENTER;
	return clampAxis((value + 1) * 127.5);
}

export type SamplePad = {
	connected?: boolean;
	buttons: ArrayLike<{ pressed?: boolean; value?: number }>;
	axes: ArrayLike<number>;
};

/**
 * Sample a standard Gamepad API controller through the user mapping. The
 * default mapping is the physical layout: bottom=B, right=A, left=Y, top=X.
 * Xbox A (bottom) therefore becomes Switch B, and so on.
 */
export function sampleGamepadState(pad: SamplePad, mapping: GamepadMapping): PadState {
	let buttons = 0;
	for (const action of GAMEPAD_ACTIONS) {
		const button = mapping.buttons[action];
		if (button !== null && buttonDown(pad.buttons[button])) {
			buttons |= ACTION_BITS[action];
		}
	}

	// Minus + Plus together is the common Switch fallback for Home.
	if ((buttons & PadButton.Minus) !== 0 && (buttons & PadButton.Plus) !== 0) {
		buttons |= PadButton.Home;
	}

	let lx = pad.axes[0] ?? 0;
	let ly = pad.axes[1] ?? 0;
	let rx = pad.axes[2] ?? 0;
	let ry = pad.axes[3] ?? 0;
	if (mapping.swapSticks) {
		[lx, ly, rx, ry] = [rx, ry, lx, ly];
	}
	if (mapping.invertLeftY) ly = -ly;
	if (mapping.invertRightY) ry = -ry;

	return {
		buttons,
		lx: axisToByte(lx, mapping.deadzone),
		ly: axisToByte(ly, mapping.deadzone),
		rx: axisToByte(rx, mapping.deadzone),
		ry: axisToByte(ry, mapping.deadzone),
	};
}

type GamepadNavigator = Navigator & {
	getGamepads?: () => ArrayLike<SamplePad | null>;
};

function navigatorGamepads(): ArrayLike<SamplePad | null> {
	if (typeof navigator === "undefined") return [];
	return (navigator as GamepadNavigator).getGamepads?.() ?? [];
}

export function sampleGamepad(index: number, mapping: GamepadMapping): PadState | null {
	const pad = navigatorGamepads()[index];
	return pad && pad.connected !== false ? sampleGamepadState(pad, mapping) : null;
}
