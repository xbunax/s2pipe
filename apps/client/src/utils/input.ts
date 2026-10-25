import { neutralPad, PadButton, type PadState } from "@s2pipe/shared/types/pad";

import { defaultGamepadMapping, type GamepadMapping, sampleGamepad } from "./gamepad.ts";

export type GamepadOption = {
	index: number;
	id: string;
};

const KEY_BUTTONS: Record<string, number> = {
	KeyH: PadButton.Home,
	KeyG: PadButton.Capture,
};

export function isTyping(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLElement &&
		Boolean(target.closest("input, select, textarea"))
	);
}

export function listGamepads(): GamepadOption[] {
	return [...navigator.getGamepads()].flatMap((pad) =>
		pad && pad.connected !== false ? [{ index: pad.index, id: pad.id }] : []
	);
}

export function createInputTracker() {
	const keys = new Set<string>();

	function onKeyDown(event: KeyboardEvent): void {
		if (
			event.repeat ||
			event.code === "Escape" ||
			isTyping(event.target)
		) {
			return;
		}

		const button = KEY_BUTTONS[event.code];
		if (button === undefined) return;

		keys.add(event.code);
		event.preventDefault();
	}

	function onKeyUp(event: KeyboardEvent): void {
		keys.delete(event.code);
	}

	function clearKeys(): void {
		keys.clear();
	}

	function onVisibilityChange(): void {
		if (document.visibilityState === "hidden") {
			clearKeys();
		}
	}

	return {
		attach() {
			globalThis.addEventListener("keydown", onKeyDown);
			globalThis.addEventListener("keyup", onKeyUp);
			globalThis.addEventListener("blur", clearKeys);
			document.addEventListener("visibilitychange", onVisibilityChange);
		},

		detach() {
			globalThis.removeEventListener("keydown", onKeyDown);
			globalThis.removeEventListener("keyup", onKeyUp);
			globalThis.removeEventListener("blur", clearKeys);
			document.removeEventListener("visibilitychange", onVisibilityChange);

			clearKeys();
		},

		sample(index: number | null, extraKeys = false, mapping?: GamepadMapping): PadState {
			const pad = index === null
				? neutralPad()
				: sampleGamepad(index, mapping ?? defaultGamepadMapping()) ?? neutralPad();

			if (!extraKeys) {
				return pad;
			}

			let extraButtons = 0;

			for (const code of keys) {
				extraButtons |= KEY_BUTTONS[code] ?? 0;
			}

			if (!extraButtons) {
				return pad;
			}

			return {
				...pad,
				buttons: pad.buttons | extraButtons,
			};
		},
	};
}
