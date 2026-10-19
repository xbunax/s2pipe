import { type ReadonlySignal, type Signal, useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { X } from "lucide-preact";

import type { PadState } from "@s2pipe/shared/types/pad";

import ControllerPad from "./controller-pad.tsx";
import { holdPage } from "../utils/page-session.ts";
import {
	BUILTIN_HINTS,
	BUILTIN_LABELS,
	type ButtonInput,
	clampPresetName,
	cloneBindings,
	type ControllerPreset,
	createUserPreset,
	isReservedCode,
	MAX_PRESETS,
	PAD_BUTTON_LABELS,
	type PadButtonName,
	presetBindings,
	STICK_LABELS,
	type StickBinding,
	type StickDir,
	type StickId,
	type StickListen,
	type VirtualPad,
	type VirtualPrefs,
	watchKeyLayout,
} from "../utils/virtual/mod.ts";

type Props = {
	prefs: Signal<VirtualPrefs>;
	live: ReadonlySignal<PadState>;
	pad: { current: VirtualPad | null };
	onClose: () => void;
};

function activePreset(prefs: VirtualPrefs): ControllerPreset {
	return prefs.presets.find((preset) => preset.id === prefs.activeId) ?? prefs.presets[0];
}

export default function ControllerDialog({ prefs, live, pad, onClose }: Props) {
	const listening = useSignal<PadButtonName | StickListen | null>(null);
	const draftName = useSignal("");
	const dialogRef = useRef<HTMLDialogElement>(null);
	const createRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		dialog.showModal();
		// A focused button would be pressed by the Space key of the virtual pad.
		dialog.focus();
		return holdPage(watchKeyLayout());
	}, []);

	useEffect(() => {
		const target = listening.value;
		if (!target) return;
		pad.current?.hold(true);

		// Stopping propagation keeps Tab and Escape away from the play page shortcuts while a key is being picked.
		const onKey = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.repeat || event.type === "keyup") return;
			if (event.code === "Escape") {
				if (typeof target === "object") unbindStickDir(target.id, target.dir);
				else unbindButton(target);
			} else if (isReservedCode(event.code)) {
				return;
			} else if (typeof target === "object") {
				bindStickDir(target.id, target.dir, event.code);
			} else {
				bindButton(target, { kind: "key", code: event.code });
			}
			listening.value = null;
		};

		const block = (event: Event) => {
			event.preventDefault();
		};

		const onMouse = (event: MouseEvent) => {
			const element = event.target instanceof Element ? event.target : null;
			const control = element?.closest("button, a, select, input, textarea");
			const selected = element?.closest(".pad-cell[aria-pressed='true']");
			if (event.button === 0 && control && !selected) return;
			event.preventDefault();
			if (event.button !== 0) {
				globalThis.addEventListener("contextmenu", block, { capture: true, once: true });
			}
			if (typeof target === "object" || event.button > 4) return;
			bindButton(target, { kind: "mouse", button: event.button });
			listening.value = null;
		};

		globalThis.addEventListener("keydown", onKey, { capture: true });
		globalThis.addEventListener("keyup", onKey, { capture: true });
		globalThis.addEventListener("mousedown", onMouse, { capture: true });
		globalThis.addEventListener("contextmenu", block, { capture: true });
		return holdPage(() => {
			pad.current?.hold(false);
			globalThis.removeEventListener("keydown", onKey, { capture: true });
			globalThis.removeEventListener("keyup", onKey, { capture: true });
			globalThis.removeEventListener("mousedown", onMouse, { capture: true });
			globalThis.removeEventListener("contextmenu", block, { capture: true });
		});
	}, [listening.value]);

	function replaceActive(next: ControllerPreset): void {
		prefs.value = {
			...prefs.value,
			presets: prefs.value.presets.map((preset) => preset.id === next.id ? next : preset),
		};
	}

	function unbindButton(name: PadButtonName): void {
		const preset = activePreset(prefs.value);
		const bindings = cloneBindings(preset.bindings);
		delete bindings.buttons[name];
		replaceActive({ ...preset, bindings });
	}

	function unbindStickDir(id: StickId, dir: StickDir): void {
		const preset = activePreset(prefs.value);
		const bindings = cloneBindings(preset.bindings);
		const current = bindings.sticks[id];
		if (current.kind !== "keys") {
			bindings.sticks[id] = { kind: "none" };
		} else {
			const next = { ...current, [dir]: "" };
			bindings.sticks[id] = next.up || next.down || next.left || next.right ? next : { kind: "none" };
		}
		replaceActive({ ...preset, bindings });
	}

	function bindButton(name: PadButtonName, input: ButtonInput): void {
		const preset = activePreset(prefs.value);
		const bindings = cloneBindings(preset.bindings);
		bindings.buttons[name] = input;
		replaceActive({ ...preset, bindings });
	}

	function bindStickDir(id: StickId, dir: StickDir, code: string): void {
		const preset = activePreset(prefs.value);
		const bindings = cloneBindings(preset.bindings);
		const current = bindings.sticks[id];
		const next = current.kind === "keys"
			? { ...current }
			: { kind: "keys" as const, up: "", down: "", left: "", right: "" };
		next[dir] = code;
		bindings.sticks[id] = next;
		replaceActive({ ...preset, bindings });
	}

	function bindStick(id: StickId, stick: StickBinding): void {
		const preset = activePreset(prefs.value);
		const bindings = cloneBindings(preset.bindings);
		bindings.sticks[id] = stick;
		if (stick.kind === "mouse") {
			const other: StickId = id === "left" ? "right" : "left";
			if (bindings.sticks[other].kind === "mouse") bindings.sticks[other] = { kind: "none" };
		}
		replaceActive({ ...preset, bindings });
		listening.value = null;
	}

	function onPreset(id: string): void {
		listening.value = null;
		if (!prefs.value.presets.some((item) => item.id === id)) return;
		prefs.value = { ...prefs.value, activeId: id };
	}

	function rename(name: string): void {
		const preset = activePreset(prefs.value);
		if (preset.builtin) return;
		replaceActive({ ...preset, name: name.slice(0, 32) });
	}

	function commitName(): void {
		const preset = activePreset(prefs.value);
		if (preset.builtin) return;
		replaceActive({ ...preset, name: clampPresetName(preset.name) });
	}

	function reset(): void {
		const preset = activePreset(prefs.value);
		if (!preset.builtin) return;
		listening.value = null;
		replaceActive({
			...preset,
			name: BUILTIN_LABELS[preset.builtin],
			bindings: presetBindings(preset.builtin),
		});
	}

	function remove(): void {
		const preset = activePreset(prefs.value);
		if (preset.builtin) return;
		listening.value = null;
		const presets = prefs.value.presets.filter((item) => item.id !== preset.id);
		prefs.value = { ...prefs.value, presets, activeId: presets[0]?.id ?? "standard" };
	}

	function openCreate(): void {
		listening.value = null;
		draftName.value = "";
		createRef.current?.showModal();
	}

	function create(event: Event): void {
		event.preventDefault();
		if (prefs.value.presets.length >= MAX_PRESETS) return;
		const source = activePreset(prefs.value);
		const preset = createUserPreset(draftName.value || `${source.name} copy`, source.bindings);
		prefs.value = {
			...prefs.value,
			activeId: preset.id,
			presets: [...prefs.value.presets, preset],
		};
		createRef.current?.close();
	}

	const preset = activePreset(prefs.value);
	const full = prefs.value.presets.length >= MAX_PRESETS;
	const builtins = prefs.value.presets.filter((item) => item.builtin);
	const profiles = prefs.value.presets.filter((item) => !item.builtin);

	return (
		<dialog
			id="controller"
			ref={dialogRef}
			tabIndex={-1}
			onClick={(event) => event.stopPropagation()}
			onCancel={(event) => {
				if (listening.value) event.preventDefault();
			}}
			onClose={onClose}
		>
			<header>
				<h2>Virtual controller</h2>
				<button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
					<X size={16} />
				</button>
			</header>

			<div>
				<label className="field">
					<span>Layout</span>
					<select
						value={preset.id}
						onChange={(event) => onPreset((event.target as HTMLSelectElement).value)}
					>
						<optgroup label="Presets">
							{builtins.map((item) => (
								<option key={item.id} value={item.id}>
									{item.builtin ? BUILTIN_LABELS[item.builtin] : item.name}
								</option>
							))}
						</optgroup>
						{profiles.length > 0 && (
							<optgroup label="Profiles">
								{profiles.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</optgroup>
						)}
					</select>
				</label>
				{!preset.builtin && (
					<label className="field">
						<span>Name</span>
						<input
							type="text"
							maxLength={32}
							value={preset.name}
							placeholder="My profile"
							onInput={(event) => rename((event.target as HTMLInputElement).value)}
							onBlur={commitName}
						/>
					</label>
				)}
				<label className="field">
					<span>Mouse sensitivity</span>
					<input
						type="range"
						min="0.05"
						max="2"
						step="0.05"
						value={prefs.value.mouseSensitivity}
						onInput={(event) =>
							prefs.value = {
								...prefs.value,
								mouseSensitivity: Number((event.target as HTMLInputElement).value),
							}}
					/>
				</label>
				<div>
					<button type="button" className="btn" disabled={full} onClick={openCreate}>
						New profile
					</button>
					{preset.builtin
						? (
							<button type="button" className="btn" onClick={reset}>
								Reset
							</button>
						)
						: (
							<button type="button" className="btn" onClick={remove}>
								Delete
							</button>
						)}
				</div>
				{preset.builtin && <p>{BUILTIN_HINTS[preset.builtin]}</p>}
			</div>

			<p>
				{listening.value
					? typeof listening.value === "object"
						? `Press a key for ${STICK_LABELS[listening.value.id]} ${listening.value.dir}. Esc clears it.`
						: `Press a key or any mouse button for ${PAD_BUTTON_LABELS[listening.value]}. Esc clears it.`
					: "Click a face, or one stick direction, then press the key you want. The center of a stick is the stick click. Tab closes this window."}
			</p>

			<ControllerPad
				bindings={preset.bindings}
				live={live.value}
				listening={listening.value}
				onButton={(name) => {
					listening.value = name;
				}}
				onStickDir={(id, dir) => {
					listening.value = { id, dir };
				}}
				onStickMode={(id, mode) => {
					listening.value = null;
					bindStick(id, mode === "mouse" ? { kind: "mouse" } : { kind: "none" });
				}}
			/>

			<dialog ref={createRef}>
				<form onSubmit={create}>
					<header>
						<h2>New profile</h2>
					</header>
					<label className="field">
						<span>Name</span>
						<input
							type="text"
							maxLength={32}
							placeholder="My profile"
							value={draftName.value}
							onInput={(event) => draftName.value = (event.target as HTMLInputElement).value}
						/>
					</label>
					<footer>
						<button type="button" className="btn" onClick={() => createRef.current?.close()}>
							Cancel
						</button>
						<button type="submit" className="btn btn-primary">Create</button>
					</footer>
				</form>
			</dialog>
		</dialog>
	);
}
