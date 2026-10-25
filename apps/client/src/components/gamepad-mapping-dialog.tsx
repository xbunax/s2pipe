import { type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";

import {
	assignGamepadButton,
	defaultGamepadMapping,
	GAMEPAD_ACTION_LABELS,
	GAMEPAD_ACTIONS,
	type GamepadAction,
	gamepadButtonLabel,
	type GamepadMapping,
} from "../utils/gamepad.ts";

type Props = {
	mapping: Signal<GamepadMapping>;
	gamepadIndex: number | null;
	gamepadName: string | null;
	onClose: () => void;
};

export default function GamepadMappingDialog({ mapping, gamepadIndex, gamepadName, onClose }: Props) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const listening = useSignal<GamepadAction | null>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		dialog.showModal();
		dialog.focus();
	}, []);

	// Listen for a physical gamepad button edge while a row is armed. The play
	// page suppresses gamepad input while this dialog is open, so the presses
	// used to learn a binding do not reach the Switch.
	useEffect(() => {
		const action = listening.value;
		if (action === null || gamepadIndex === null) return;

		let previous = new Set<number>();
		let armed = false;

		const bind = (button: number) => {
			mapping.value = assignGamepadButton(mapping.value, action, button);
			listening.value = null;
		};

		const timer = setInterval(() => {
			const pad = navigator.getGamepads()[gamepadIndex];
			if (!pad) return;

			const pressed = new Set<number>();
			pad.buttons.forEach((button, index) => {
				if (button.pressed || button.value >= 0.5) pressed.add(index);
			});

			if (!armed) {
				// Wait for every button to be released, so a button held while
				// clicking Rebind is not captured immediately.
				if (pressed.size === 0) armed = true;
				previous = pressed;
				return;
			}

			for (const index of pressed) {
				if (!previous.has(index)) {
					bind(index);
					return;
				}
			}
			previous = pressed;
		}, 40);

		return () => clearInterval(timer);
	}, [listening.value, gamepadIndex]);

	function clear(action: GamepadAction): void {
		listening.value = null;
		const buttons = { ...mapping.value.buttons, [action]: null };
		mapping.value = { ...mapping.value, buttons };
	}

	function reset(): void {
		listening.value = null;
		mapping.value = defaultGamepadMapping();
	}

	function update(patch: Partial<GamepadMapping>): void {
		mapping.value = { ...mapping.value, ...patch };
	}

	return (
		<dialog
			id="controller"
			ref={dialogRef}
			tabIndex={-1}
			onClick={(event) => event.stopPropagation()}
			onCancel={(event) => {
				if (listening.value) {
					event.preventDefault();
					listening.value = null;
				}
			}}
			onClose={onClose}
		>
			<header>
				<h2>Controller mapping</h2>
				<button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
					<X size={16} />
				</button>
			</header>

			<section className="map-summary">
				<strong>{gamepadName ?? "No gamepad connected"}</strong>
				<span>
					{gamepadIndex === null
						? "Connect a gamepad and press a button, then reopen this window."
						: "Buttons are learned from this controller. The mapping applies to every standard gamepad in this browser."}
				</span>
			</section>

			<section className="map-options">
				<label>
					<input
						type="checkbox"
						checked={mapping.value.swapSticks}
						onChange={(event) => update({ swapSticks: (event.currentTarget as HTMLInputElement).checked })}
					/>
					Swap left and right sticks
				</label>
				<label>
					<input
						type="checkbox"
						checked={mapping.value.invertLeftY}
						onChange={(event) => update({ invertLeftY: (event.currentTarget as HTMLInputElement).checked })}
					/>
					Invert left stick Y
				</label>
				<label>
					<input
						type="checkbox"
						checked={mapping.value.invertRightY}
						onChange={(event) =>
							update({ invertRightY: (event.currentTarget as HTMLInputElement).checked })}
					/>
					Invert right stick Y
				</label>
				<label className="field">
					<span>Stick deadzone</span>
					<input
						type="range"
						min="0.05"
						max="0.35"
						step="0.01"
						value={mapping.value.deadzone}
						onInput={(event) =>
							update({ deadzone: Number((event.currentTarget as HTMLInputElement).value) })}
					/>
				</label>
			</section>

			<section className="map-list">
				{GAMEPAD_ACTIONS.map((action) => (
					<div
						className="map-row"
						key={action}
						data-listening={listening.value === action ? "true" : undefined}
					>
						<span>{GAMEPAD_ACTION_LABELS[action]}</span>
						<code>{gamepadButtonLabel(mapping.value.buttons[action])}</code>
						<button
							type="button"
							className="btn"
							disabled={gamepadIndex === null}
							onClick={() => {
								listening.value = action;
							}}
						>
							{listening.value === action ? "Press a button..." : "Rebind"}
						</button>
						<button type="button" className="btn" onClick={() => clear(action)}>
							Clear
						</button>
					</div>
				))}
			</section>

			<p>
				{listening.value
					? `Press a button on ${gamepadName ?? "the controller"} for ${
						GAMEPAD_ACTION_LABELS[listening.value]
					}. Esc cancels.`
					: "Click Rebind, then press a button on the controller. Controller input is paused while this window is open."}
			</p>

			<div>
				<button type="button" className="btn" onClick={reset}>
					Reset to default
				</button>
				<button type="button" className="btn btn-primary" onClick={onClose}>
					Done
				</button>
			</div>
		</dialog>
	);
}
