import { clampAxis, PAD_CENTER, type PadState } from "@s2pipe/shared/types/pad";

import { isTyping } from "../input.ts";
import { type StickBinding, usesMouseAxis } from "./bindings.ts";
import { activeBindings } from "./presets.ts";
import type { VirtualPrefs } from "./store.ts";
import { PAD_BUTTON_BITS, PAD_BUTTON_NAMES } from "./targets.ts";

const DEADZONE = 0.12;

type Axes = { x: number; y: number };

function axisToByte(value: number): number {
	if (!Number.isFinite(value) || Math.abs(value) < DEADZONE) return PAD_CENTER;
	return clampAxis((value + 1) * 127.5);
}

function clampStick(x: number, y: number): Axes {
	const mag = Math.hypot(x, y);
	if (mag <= 1) return { x, y };
	return { x: x / mag, y: y / mag };
}

function stickAxes(binding: StickBinding, keys: Set<string>, mouse: Axes): Axes {
	if (binding.kind === "mouse") return mouse;
	if (binding.kind === "none") return { x: 0, y: 0 };
	const x = (keys.has(binding.right) ? 1 : 0) + (keys.has(binding.left) ? -1 : 0);
	const y = (keys.has(binding.down) ? 1 : 0) + (keys.has(binding.up) ? -1 : 0);
	return clampStick(x, y);
}

export function createVirtualPad() {
	const keys = new Set<string>();
	const mouseButtons = new Set<number>();
	const boundCodes = new Set<string>();
	let mx = 0;
	let my = 0;
	let lastT = 0;
	let locked = false;
	let held = false;

	function resetMotion(): void {
		keys.clear();
		mouseButtons.clear();
		mx = 0;
		my = 0;
	}

	function onKeyDown(event: KeyboardEvent): void {
		if (held) {
			event.preventDefault();
			return;
		}
		if (event.repeat || event.code === "Escape" || isTyping(event.target)) return;
		keys.add(event.code);
		if (boundCodes.has(event.code)) event.preventDefault();
	}

	function onKeyUp(event: KeyboardEvent): void {
		keys.delete(event.code);
	}

	function onMouseDown(event: MouseEvent): void {
		if (held) {
			event.preventDefault();
			return;
		}
		if (isTyping(event.target)) return;
		if (!locked) {
			const target = event.target;
			if (target instanceof Element && target.closest("aside, dialog, button, a, input, select, label, ul")) {
				return;
			}
			const play = document.getElementById("play");
			if (play && (!(target instanceof Node) || !play.contains(target))) return;
		}
		mouseButtons.add(event.button);
	}

	function onMouseUp(event: MouseEvent): void {
		mouseButtons.delete(event.button);
	}

	function onMouseMove(event: MouseEvent): void {
		if (!locked) return;
		mx += event.movementX;
		my += event.movementY;
	}

	function onPointerLockChange(): void {
		locked = document.pointerLockElement != null;
		if (!locked) {
			mouseButtons.clear();
			mx = 0;
			my = 0;
		}
	}

	function onContextMenu(event: Event): void {
		if (held || locked) event.preventDefault();
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === "hidden") resetMotion();
	}

	return {
		attach() {
			lastT = performance.now();
			globalThis.addEventListener("keydown", onKeyDown, { capture: true });
			globalThis.addEventListener("keyup", onKeyUp);
			globalThis.addEventListener("mousedown", onMouseDown);
			globalThis.addEventListener("mouseup", onMouseUp);
			globalThis.addEventListener("mousemove", onMouseMove);
			globalThis.addEventListener("blur", resetMotion);
			document.addEventListener("pointerlockchange", onPointerLockChange);
			document.addEventListener("visibilitychange", onVisibilityChange);
			document.addEventListener("contextmenu", onContextMenu);
		},

		detach() {
			globalThis.removeEventListener("keydown", onKeyDown, { capture: true });
			globalThis.removeEventListener("keyup", onKeyUp);
			globalThis.removeEventListener("mousedown", onMouseDown);
			globalThis.removeEventListener("mouseup", onMouseUp);
			globalThis.removeEventListener("mousemove", onMouseMove);
			globalThis.removeEventListener("blur", resetMotion);
			document.removeEventListener("pointerlockchange", onPointerLockChange);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			document.removeEventListener("contextmenu", onContextMenu);
			if (document.pointerLockElement) document.exitPointerLock();
			resetMotion();
			locked = false;
		},

		// Swallows every key and click, so the next one can be picked as a binding.
		hold(active: boolean) {
			held = active;
			if (active) resetMotion();
		},

		usesMouseAxis(prefs: VirtualPrefs): boolean {
			return usesMouseAxis(activeBindings(prefs.presets, prefs.activeId));
		},

		requestPointerLock(target: Element) {
			void target.requestPointerLock?.();
		},

		sample(prefs: VirtualPrefs): PadState {
			const bindings = activeBindings(prefs.presets, prefs.activeId);

			boundCodes.clear();
			for (const name of PAD_BUTTON_NAMES) {
				const input = bindings.buttons[name];
				if (input?.kind === "key") boundCodes.add(input.code);
			}
			for (const stick of [bindings.sticks.left, bindings.sticks.right]) {
				if (stick.kind !== "keys") continue;
				for (const code of [stick.up, stick.down, stick.left, stick.right]) {
					if (code) boundCodes.add(code);
				}
			}

			const now = performance.now();
			const dt = Math.min(0.05, Math.max(0.001, (now - lastT) / 1000));
			lastT = now;

			const decay = Math.exp(-10 * dt);
			mx *= decay;
			my *= decay;

			let buttons = 0;
			for (const name of PAD_BUTTON_NAMES) {
				const input = bindings.buttons[name];
				if (!input) continue;
				const down = input.kind === "key" ? keys.has(input.code) : mouseButtons.has(input.button);
				if (down) buttons |= PAD_BUTTON_BITS[name];
			}

			const scale = 0.018 * prefs.mouseSensitivity;
			const mouse = clampStick(mx * scale, my * scale);
			const left = stickAxes(bindings.sticks.left, keys, mouse);
			const right = stickAxes(bindings.sticks.right, keys, mouse);

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

export type VirtualPad = ReturnType<typeof createVirtualPad>;
