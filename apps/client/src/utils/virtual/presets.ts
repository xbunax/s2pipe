import { type Bindings, cloneBindings, emptyBindings, STICK_PRESETS } from "./bindings.ts";
import type { PadButtonName } from "./targets.ts";

export const BUILTIN_IDS = ["standard", "racing", "keyboard"] as const;

export type BuiltinId = typeof BUILTIN_IDS[number];

// Presets from earlier versions that were merged into the three above.
const RETIRED_IDS = ["fps", "platformer", "fighter", "retro"] as const;

export const BUILTIN_LABELS: Record<BuiltinId, string> = {
	standard: "Standard (3D, FPS)",
	racing: "Racing (Mario Kart)",
	keyboard: "Keyboard (2D, fighting, retro)",
};

export const BUILTIN_HINTS: Record<BuiltinId, string> = {
	standard:
		"Zelda, Mario Odyssey, Splatoon, Metroid Prime, Doom. The mouse aims: left click is ZR, right click is ZL.",
	racing:
		"Mario Kart 8. Left click uses items, right click drifts. Hold W or S with an item to throw it forward or back. The mouse is not captured.",
	keyboard:
		"Mario Wonder, Celeste, Smash, Street Fighter, Switch Online. No mouse: the right hand sits on IJKL like the face buttons.",
};

export type ControllerPreset = {
	id: string;
	name: string;
	bindings: Bindings;
	builtin: BuiltinId | null;
};

type ButtonMap = Partial<Record<PadButtonName, Bindings["buttons"][PadButtonName]>>;

function key(code: string) {
	return { kind: "key", code } as const;
}

function click(button: number) {
	return { kind: "mouse", button } as const;
}

const LEFT_CLICK = click(0);
const RIGHT_CLICK = click(2);

function build(map: ButtonMap, left: Bindings["sticks"]["left"], right: Bindings["sticks"]["right"]): Bindings {
	const next = emptyBindings();
	next.buttons = { ...map };
	next.sticks.left = { ...left };
	next.sticks.right = { ...right };
	return next;
}

// Same keys in every preset, and no gameplay binding uses them:
// Plus on Enter, Minus on the * key (above Enter), Home on H, Capture on P.
const SYSTEM: ButtonMap = {
	Plus: key("Enter"),
	Minus: key("Backslash"),
	Home: key("KeyH"),
	Capture: key("KeyP"),
};

// 1 up, 2 right, 3 down, 4 left: quick items and weapons under the left hand.
const DPAD_DIGITS: ButtonMap = {
	Up: key("Digit1"),
	Right: key("Digit2"),
	Down: key("Digit3"),
	Left: key("Digit4"),
};

// Menus, and digital steering in Mario Kart.
const DPAD_ARROWS: ButtonMap = {
	Up: key("ArrowUp"),
	Down: key("ArrowDown"),
	Left: key("ArrowLeft"),
	Right: key("ArrowRight"),
};

// Ctrl and Alt are never used: Ctrl+W closes the tab and a lone Alt opens the browser menu.
// Every button of the pad has a key, and every preset works without mouse side buttons.
const PRESETS: Record<BuiltinId, Bindings> = {
	// Left hand keeps WASD; thumb on Space and C, pinky on Shift, index reaches R, F and V.
	standard: build(
		{
			...SYSTEM,
			...DPAD_DIGITS,
			A: key("Space"),
			B: key("KeyC"),
			X: key("KeyR"),
			Y: key("KeyF"),
			L: key("KeyQ"),
			R: key("KeyE"),
			ZL: RIGHT_CLICK,
			ZR: LEFT_CLICK,
			LStick: key("ShiftLeft"),
			RStick: key("KeyV"),
		},
		STICK_PRESETS.wasd,
		STICK_PRESETS.mouse,
	),
	// Steer with the left hand, items and drift on the mouse. The stick up and down aim thrown items.
	racing: build(
		{
			...SYSTEM,
			...DPAD_ARROWS,
			A: key("Space"),
			B: key("KeyC"),
			X: key("KeyR"),
			Y: key("KeyF"),
			L: LEFT_CLICK,
			R: RIGHT_CLICK,
			ZL: key("KeyQ"),
			ZR: key("ShiftLeft"),
			LStick: key("KeyE"),
			RStick: key("KeyV"),
		},
		STICK_PRESETS.wasd,
		STICK_PRESETS.none,
	),
	// Two thumbs like a real pad: left hand moves, right hand on IJKL has the face buttons.
	keyboard: build(
		{
			...SYSTEM,
			...DPAD_ARROWS,
			X: key("KeyI"),
			Y: key("KeyJ"),
			A: key("KeyL"),
			B: key("KeyK"),
			L: key("KeyU"),
			R: key("KeyO"),
			ZL: key("ShiftLeft"),
			ZR: key("Space"),
			LStick: key("KeyQ"),
			RStick: key("KeyE"),
		},
		STICK_PRESETS.wasd,
		STICK_PRESETS.none,
	),
};

export function isBuiltinId(id: string): id is BuiltinId {
	return (BUILTIN_IDS as readonly string[]).includes(id);
}

export function isRetiredId(id: string): boolean {
	return (RETIRED_IDS as readonly string[]).includes(id);
}

export function presetBindings(id: BuiltinId): Bindings {
	return cloneBindings(PRESETS[id]);
}

export function factoryPresets(): ControllerPreset[] {
	return BUILTIN_IDS.map((id) => ({
		id,
		name: BUILTIN_LABELS[id],
		bindings: presetBindings(id),
		builtin: id,
	}));
}

export function activeBindings(presets: ControllerPreset[], activeId: string): Bindings {
	const found = presets.find((preset) => preset.id === activeId);
	if (!found) return presetBindings("standard");
	return found.bindings;
}
