import { PAD_CENTER, PadButton } from "@s2pipe/shared/types/pad";

import {
	assignGamepadButton,
	defaultGamepadMapping,
	gamepadButtonLabel,
	parseGamepadMapping,
	sampleGamepadState,
} from "./gamepad.ts";

function pad(buttons: number[], axes: number[] = [0, 0, 0, 0]): {
	buttons: { pressed: boolean; value: number }[];
	axes: number[];
} {
	return {
		buttons: buttons.map((value) => ({ pressed: value >= 0.5, value })),
		axes,
	};
}

Deno.test("default gamepad mapping is the physical Nintendo layout", () => {
	const mapping = defaultGamepadMapping();
	if (mapping.buttons.B !== 0 || mapping.buttons.A !== 1) throw new Error("bottom/right face buttons");
	if (mapping.buttons.Y !== 2 || mapping.buttons.X !== 3) throw new Error("left/top face buttons");
	if (gamepadButtonLabel(1) !== "Right (1)") throw new Error("button label");
});

Deno.test("sampleGamepadState maps buttons, dpad and triggers", () => {
	const mapping = defaultGamepadMapping();
	const state = sampleGamepadState(pad([1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]), mapping);
	if (!(state.buttons & PadButton.B)) throw new Error("button 0 should be B");
	if (!(state.buttons & PadButton.A)) throw new Error("button 1 should be A");
	if (!(state.buttons & PadButton.ZL)) throw new Error("button 6 should be ZL");
	if (!(state.buttons & PadButton.Down)) throw new Error("button 13 should be down");
});

Deno.test("sampleGamepadState applies sticks, deadzone, swap and invert", () => {
	const mapping = defaultGamepadMapping();
	const neutral = sampleGamepadState(pad([], [0.05, -0.05, 0.04, 0.02]), mapping);
	if (neutral.lx !== PAD_CENTER || neutral.ly !== PAD_CENTER) throw new Error("deadzone");

	const full = sampleGamepadState(pad([], [1, 1, -1, -1]), mapping);
	if (full.lx !== 255 || full.ly !== 255 || full.rx !== 0 || full.ry !== 0) throw new Error("axes");

	const swapped = sampleGamepadState(
		pad([], [0, 0, 1, 1]),
		{ ...mapping, swapSticks: true, invertRightY: true },
	);
	if (swapped.lx !== 255 || swapped.ly !== 255) throw new Error("swap sticks");
	if (swapped.rx !== PAD_CENTER || swapped.ry !== PAD_CENTER) throw new Error("swap leaves centered axes");
});

Deno.test("Minus + Plus is the Home fallback", () => {
	const mapping = defaultGamepadMapping();
	const state = sampleGamepadState(pad([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]), mapping);
	if (!(state.buttons & PadButton.Minus) || !(state.buttons & PadButton.Plus)) throw new Error("minus/plus");
	if (!(state.buttons & PadButton.Home)) throw new Error("home fallback");
});

Deno.test("rebinding moves a duplicate button to the new action", () => {
	const mapping = defaultGamepadMapping();
	const next = assignGamepadButton(mapping, "A", 0);
	if (next.buttons.A !== 0) throw new Error("A should use button 0");
	if (next.buttons.B !== null) throw new Error("the old B binding must be cleared");
	if (mapping.buttons.A !== 1 || mapping.buttons.B !== 0) throw new Error("input mapping mutated");
});

Deno.test("parseGamepadMapping sanitizes stored values", () => {
	const parsed = parseGamepadMapping({
		buttons: { B: 4, A: 99, X: null, Y: "3" },
		swapSticks: true,
		deadzone: 10,
	});
	if (parsed.buttons.B !== 4) throw new Error("valid index rejected");
	if (parsed.buttons.A !== null) throw new Error("out-of-range index must clear");
	if (parsed.buttons.X !== null) throw new Error("null must clear");
	if (parsed.buttons.Y !== 3) throw new Error("numeric string should be accepted");
	if (!parsed.swapSticks) throw new Error("swap flag lost");
	if (parsed.deadzone !== 0.35) throw new Error("deadzone must clamp");
});
