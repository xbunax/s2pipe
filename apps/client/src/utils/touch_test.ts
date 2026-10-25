import { PAD_CENTER, PadButton } from "@s2pipe/shared/types/pad";

import {
	createTouchState,
	defaultTouchLayout,
	defaultTouchPrefs,
	mirrorTouchLayout,
	parseTouchLayout,
	parseTouchPrefs,
	resetTouchLayout,
	resetTouchPrefsLayouts,
	TOUCH_CONTROLS,
} from "./touch.ts";

Deno.test("default touch layouts keep every control on screen", () => {
	for (const wide of [true, false]) {
		const layout = defaultTouchLayout(wide);
		for (const id of TOUCH_CONTROLS) {
			const point = layout[id];
			if (point.x < 0.03 || point.x > 0.97 || point.y < 0.03 || point.y > 0.97) {
				throw new Error(`${id} is outside the stage`);
			}
		}
		if (layout.leftStick.x === defaultTouchLayout(!wide).leftStick.x) {
			throw new Error("landscape and portrait defaults should differ");
		}
	}
});

Deno.test("defaultTouchLayout returns a fresh copy", () => {
	const first = defaultTouchLayout(true);
	first.a.x = 0;
	const second = defaultTouchLayout(true);
	if (second.a.x === 0) throw new Error("default layout was mutated");
});

Deno.test("parseTouchLayout fills missing controls and clamps points", () => {
	const fallback = defaultTouchLayout(true);
	const parsed = parseTouchLayout({ a: { x: 2, y: -1 }, b: { x: "0.4", y: "0.6" }, dpad: 7 }, fallback);
	if (parsed.a.x !== 0.97 || parsed.a.y !== 0.03) throw new Error("clamp");
	if (parsed.b.x !== 0.4 || parsed.b.y !== 0.6) throw new Error("numeric strings");
	if (parsed.dpad.x !== fallback.dpad.x || parsed.dpad.y !== fallback.dpad.y) throw new Error("fallback");
	if (parsed.leftStick.x !== fallback.leftStick.x) throw new Error("missing control fallback");
});

Deno.test("parseTouchPrefs sanitizes enabled and scale", () => {
	const parsed = parseTouchPrefs({ enabled: "true", scale: 9, layouts: { wide: { a: { x: 0.2, y: 0.3 } } } });
	if (parsed.enabled) throw new Error("only boolean true enables");
	if (parsed.scale !== 1.25) throw new Error("scale must clamp");
	if (parsed.layouts.wide.a.x !== 0.2) throw new Error("wide layout lost");
	if (parsed.layouts.tall.a.x !== defaultTouchLayout(false).a.x) throw new Error("tall fallback lost");

	const defaults = defaultTouchPrefs();
	if (defaults.enabled || defaults.scale !== 1) throw new Error("defaults");
});

Deno.test("mirror and reset only touch the requested layout", () => {
	const prefs = defaultTouchPrefs();
	const mirrored = mirrorTouchLayout(prefs.layouts.wide);
	if (Math.abs(mirrored.leftStick.x - (1 - prefs.layouts.wide.leftStick.x)) > 1e-9) {
		throw new Error("x should mirror");
	}
	if (mirrored.leftStick.y !== prefs.layouts.wide.leftStick.y) throw new Error("y must stay");

	const edited = {
		...prefs,
		layouts: {
			...prefs.layouts,
			wide: { ...prefs.layouts.wide, a: { x: 0.5, y: 0.5 } },
		},
	};
	const resetWide = resetTouchLayout(edited, true);
	if (resetWide.layouts.wide.a.x === 0.5) throw new Error("wide not reset");
	if (resetWide.layouts.tall !== edited.layouts.tall) throw new Error("tall changed");

	const resetAll = resetTouchPrefsLayouts(edited);
	if (resetAll.layouts.wide.a.x === 0.5) throw new Error("wide not reset");
	if (resetAll.layouts.tall.a.x !== defaultTouchLayout(false).a.x) throw new Error("tall not reset");
});

Deno.test("touch state combines buttons, dpad and both sticks", () => {
	const state = createTouchState();
	state.setButton("a", true);
	state.setButton("b", true);
	state.setDpad({ up: true, down: false, left: true, right: false });
	state.setStick("left", 1, 0);
	state.setStick("right", 0, -1);

	let sample = state.sample();
	if (!(sample.buttons & PadButton.A) || !(sample.buttons & PadButton.B)) throw new Error("buttons");
	if (!(sample.buttons & PadButton.Up) || !(sample.buttons & PadButton.Left)) throw new Error("dpad");
	if (sample.buttons & PadButton.Down || sample.buttons & PadButton.Right) throw new Error("extra dpad");
	if (sample.lx !== 255 || sample.ly !== PAD_CENTER) throw new Error("left stick");
	if (sample.rx !== PAD_CENTER || sample.ry !== 0) throw new Error("right stick");

	state.setButton("a", false);
	state.setDpad({ up: false, down: false, left: false, right: false });
	state.setStick("left", 0, 0);
	state.setStick("right", 0, 0);
	sample = state.sample();
	if (sample.buttons & PadButton.A) throw new Error("button release");
	if (sample.buttons & PadButton.Up) throw new Error("dpad release");
	if (sample.lx !== PAD_CENTER || sample.rx !== PAD_CENTER) throw new Error("stick release");
});

Deno.test("touch state has a deadzone, clamps diagonals and the Home fallback", () => {
	const state = createTouchState();
	state.setStick("left", 0.05, -0.05);
	let sample = state.sample();
	if (sample.lx !== PAD_CENTER || sample.ly !== PAD_CENTER) throw new Error("deadzone");

	state.setStick("left", 1, 1);
	sample = state.sample();
	if (sample.lx !== 218 || sample.ly !== 218) {
		throw new Error("diagonal must be clamped to the unit circle");
	}

	state.setButton("minus", true);
	state.setButton("plus", true);
	sample = state.sample();
	if (!(sample.buttons & PadButton.Home)) throw new Error("Home fallback");

	state.clear();
	sample = state.sample();
	if (sample.buttons !== 0 || sample.lx !== PAD_CENTER) throw new Error("clear");
});
