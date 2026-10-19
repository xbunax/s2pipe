import { PadButton } from "@s2pipe/shared/types/pad";

import { type ButtonInput, cloneBindings, describeInput, sanitizeBindings } from "./bindings.ts";
import { activeBindings, BUILTIN_IDS, BUILTIN_LABELS, factoryPresets, isBuiltinId, presetBindings } from "./presets.ts";
import { createUserPreset, parseStoredPrefs } from "./store.ts";
import { PAD_BUTTON_NAMES } from "./targets.ts";

function code(input: ButtonInput | undefined): string | null {
	return input?.kind === "key" ? input.code : null;
}

function isMouse(input: ButtonInput | undefined, button: number): boolean {
	return input?.kind === "mouse" && input.button === button;
}

Deno.test("sanitizeBindings drops Escape, Tab and a second mouse stick", () => {
	const clean = sanitizeBindings({
		buttons: {
			A: { kind: "key", code: "Escape" },
			Y: { kind: "key", code: "Tab" },
			B: { kind: "key", code: "Space" },
			X: { kind: "nope" },
		},
		sticks: {
			left: { kind: "mouse" },
			right: { kind: "mouse" },
		},
	});
	if (clean.buttons.A) throw new Error("Escape must not bind");
	if (clean.buttons.Y) throw new Error("Tab must not bind");
	if (clean.buttons.B?.kind !== "key" || clean.buttons.B.code !== "Space") throw new Error("Space bind lost");
	if (clean.buttons.X) throw new Error("invalid bind kept");
	if (clean.sticks.left.kind !== "mouse") throw new Error("left mouse lost");
	if (clean.sticks.right.kind !== "none") throw new Error("second mouse stick must be cleared");
});

Deno.test("cloneBindings does not alias nested objects", () => {
	const source = presetBindings("standard");
	const copy = cloneBindings(source);
	copy.buttons.A = { kind: "key", code: "KeyZ" };
	copy.sticks.left = { kind: "none" };
	if (code(source.buttons.A) !== "Space") throw new Error("clone mutated source buttons");
	if (source.sticks.left.kind !== "keys") throw new Error("clone mutated source stick");
});

Deno.test("activeBindings reads the selected preset", () => {
	const presets = factoryPresets();
	const keyboard = activeBindings(presets, "keyboard");
	if (code(keyboard.buttons.A) !== "KeyL") throw new Error("keyboard A should be L");
	const extra = createUserPreset("Mine", presetBindings("racing"));
	const resolved = activeBindings([...presets, extra], extra.id);
	if (resolved.sticks.left.kind !== "keys") throw new Error("user preset should keep racing steer stick");
	if (activeBindings(presets, "missing").buttons.A?.kind !== "key") throw new Error("fallback standard");
});

Deno.test("parseStoredPrefs keeps builtin edits and ignores enabled", () => {
	const standard = presetBindings("standard");
	standard.buttons.A = { kind: "key", code: "KeyZ" };
	const parsed = parseStoredPrefs({
		version: 4,
		enabled: true,
		activeId: "standard",
		mouseSensitivity: 1,
		presets: [
			{ id: "standard", name: "Mario", bindings: standard, builtin: "standard" },
			{ id: "nope", name: "", bindings: {} },
		],
	});
	if (parsed.enabled) throw new Error("enabled must not persist");
	if (parsed.activeId !== "standard") throw new Error("active preset lost");
	if (parsed.presets[0]?.name !== BUILTIN_LABELS.standard) throw new Error("builtin name must stay fixed");
	if (code(parsed.presets[0]?.bindings.buttons.A) !== "KeyZ") throw new Error("builtin edit lost");
	for (const id of BUILTIN_IDS) {
		if (!parsed.presets.some((preset) => preset.id === id)) throw new Error(`missing builtin ${id} not restored`);
	}
	const user = parsed.presets.find((preset) => preset.id === "nope");
	if (!user || user.builtin !== null || user.name !== "Profil") throw new Error("user preset sanitize");
});

Deno.test("parseStoredPrefs refreshes old builtins, drops merged presets, keeps profiles", () => {
	const old = presetBindings("standard");
	old.buttons.A = { kind: "key", code: "KeyZ" };
	const parsed = parseStoredPrefs({
		version: 3,
		activeId: "mine",
		presets: [
			{ id: "standard", name: "Standard", bindings: old, builtin: "standard" },
			{ id: "fps", name: "FPS", bindings: presetBindings("standard"), builtin: "fps" },
			{ id: "fighter", name: "Fighter", bindings: presetBindings("standard"), builtin: "fighter" },
			{ id: "mine", name: "Mine", bindings: presetBindings("keyboard") },
		],
	});
	if (code(parsed.presets.find((preset) => preset.id === "standard")?.bindings.buttons.A) !== "Space") {
		throw new Error("old builtin must refresh");
	}
	if (parsed.presets.some((preset) => preset.id === "fps" || preset.id === "fighter")) {
		throw new Error("merged presets must not come back as profiles");
	}
	if (parsed.activeId !== "mine") throw new Error("profile lost");
	const fallback = parseStoredPrefs({ version: 3, activeId: "fps", presets: [] });
	if (fallback.activeId !== "standard") throw new Error("active merged preset must fall back to standard");
});

Deno.test("standard: WASD, mouse aim, ZR left click, ZL right click, B and X/Y under the left hand", () => {
	const standard = presetBindings("standard");
	if (
		standard.sticks.left.kind !== "keys" || standard.sticks.left.up !== "KeyW" ||
		standard.sticks.left.left !== "KeyA" || standard.sticks.left.down !== "KeyS" ||
		standard.sticks.left.right !== "KeyD"
	) throw new Error("standard left stick is WASD");
	if (standard.sticks.right.kind !== "mouse") throw new Error("standard right stick is mouse");
	if (!isMouse(standard.buttons.ZR, 0)) throw new Error("ZR is left click");
	if (!isMouse(standard.buttons.ZL, 2)) throw new Error("ZL is right click");
	if (describeInput(standard.buttons.ZR) !== "Left click") throw new Error(describeInput(standard.buttons.ZR));
	if (code(standard.buttons.A) !== "Space") throw new Error("A on Space");
	if (code(standard.buttons.B) !== "KeyC") throw new Error("B on C, under the thumb");
	if (code(standard.buttons.X) !== "KeyR" || code(standard.buttons.Y) !== "KeyF") {
		throw new Error("X and Y on R and F");
	}
	if (code(standard.buttons.L) !== "KeyQ" || code(standard.buttons.R) !== "KeyE") {
		throw new Error("L and R on Q and E");
	}
	if (code(standard.buttons.LStick) !== "ShiftLeft") throw new Error("sprint on Shift");
});

Deno.test("racing: right click drifts, left click uses items, no mouse capture", () => {
	const racing = presetBindings("racing");
	if (code(racing.buttons.A) !== "Space") throw new Error("A is the gas on Space");
	if (code(racing.buttons.B) !== "KeyC") throw new Error("B brakes on C");
	if (!isMouse(racing.buttons.R, 2)) throw new Error("R drifts on right click");
	if (!isMouse(racing.buttons.L, 0)) throw new Error("L uses items on left click");
	if (code(racing.buttons.ZR) !== "ShiftLeft") throw new Error("ZR drifts on Shift without a mouse");
	if (code(racing.buttons.ZL) !== "KeyQ") throw new Error("ZL uses items on Q without a mouse");
	if (
		racing.sticks.left.kind !== "keys" || racing.sticks.left.left !== "KeyA" ||
		racing.sticks.left.right !== "KeyD" ||
		racing.sticks.left.up !== "KeyW" || racing.sticks.left.down !== "KeyS"
	) throw new Error("racing steers on WASD");
	if (racing.sticks.right.kind !== "none") throw new Error("racing must not capture the mouse");
	if (code(racing.buttons.Left) !== "ArrowLeft") throw new Error("D-pad steers too");
});

Deno.test("keyboard: right hand on IJKL like the face buttons, no mouse at all", () => {
	const keyboard = presetBindings("keyboard");
	if (
		code(keyboard.buttons.X) !== "KeyI" || code(keyboard.buttons.Y) !== "KeyJ" ||
		code(keyboard.buttons.A) !== "KeyL" || code(keyboard.buttons.B) !== "KeyK"
	) throw new Error("face diamond on IJKL");
	if (keyboard.sticks.left.kind !== "keys" || keyboard.sticks.right.kind !== "none") throw new Error("sticks");
	for (const name of PAD_BUTTON_NAMES) {
		if (keyboard.buttons[name]?.kind === "mouse") throw new Error("keyboard preset binds a mouse button");
	}
});

Deno.test("every preset binds all 18 buttons once, avoids reserved keys and shares the system keys", () => {
	for (const id of BUILTIN_IDS) {
		const bindings = presetBindings(id);
		const used: string[] = [];
		for (const name of PAD_BUTTON_NAMES) {
			const input = bindings.buttons[name];
			if (!input) throw new Error(`${id} leaves ${name} unbound`);
			used.push(input.kind === "key" ? input.code : `mouse${input.button}`);
		}
		for (const stick of [bindings.sticks.left, bindings.sticks.right]) {
			if (stick.kind === "keys") used.push(stick.up, stick.down, stick.left, stick.right);
		}
		if (used.some((item) => /^(Control|Alt|Escape|Tab)/.test(item))) {
			throw new Error(`${id} binds Ctrl, Alt, Escape or Tab`);
		}
		if (new Set(used).size !== used.length) throw new Error(`${id} binds one input twice`);
		if (code(bindings.buttons.Plus) !== "Enter") throw new Error(`${id} Plus`);
		if (code(bindings.buttons.Minus) !== "Backslash") throw new Error(`${id} Minus`);
		if (code(bindings.buttons.Home) !== "KeyH") throw new Error(`${id} Home`);
		if (code(bindings.buttons.Capture) !== "KeyP") throw new Error(`${id} Capture`);
	}
});

Deno.test("isBuiltinId", () => {
	if (!isBuiltinId("standard") || isBuiltinId("custom") || isBuiltinId("fps")) {
		throw new Error("preset id guard");
	}
});

Deno.test("pad bits never overlap", () => {
	if ((PadButton.A & PadButton.B) !== 0) throw new Error("bits overlap");
});
