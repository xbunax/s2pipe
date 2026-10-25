import { type Signal, useSignal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Check, FlipHorizontal2, Move, RotateCcw } from "lucide-preact";

import {
	defaultTouchLayout,
	mirrorTouchLayout,
	TOUCH_BUTTONS,
	TOUCH_LABELS,
	TOUCH_SIZE,
	type TouchButtonId,
	type TouchControlId,
	type TouchDpadState,
	type TouchLayout,
	type TouchPoint,
	type TouchPrefs,
	type TouchState,
} from "../utils/touch.ts";

type Props = {
	prefs: Signal<TouchPrefs>;
	state: TouchState;
	editing: boolean;
	onDone: () => void;
};

type Drag = {
	pointerId: number;
	stage: DOMRect;
	origin: TouchPoint;
	startX: number;
	startY: number;
	halfWidth: number;
	halfHeight: number;
};

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function TouchItem(
	{ id, point, scale, editing, onMove, onMoveEnd, children }: {
		id: TouchControlId;
		point: TouchPoint;
		scale: number;
		editing: boolean;
		onMove: (id: TouchControlId, point: TouchPoint) => void;
		onMoveEnd: () => void;
		children: ComponentChildren;
	},
) {
	const drag = useRef<Drag | null>(null);
	const size = TOUCH_SIZE[id] * scale;

	function start(event: PointerEvent) {
		if (!editing) return;
		const target = event.currentTarget as HTMLElement;
		const stage = target.closest("#touch-pad") as HTMLElement | null;
		if (!stage) return;
		event.preventDefault();
		event.stopPropagation();
		target.setPointerCapture(event.pointerId);
		const itemRect = target.getBoundingClientRect();
		drag.current = {
			pointerId: event.pointerId,
			stage: stage.getBoundingClientRect(),
			origin: { ...point },
			startX: event.clientX,
			startY: event.clientY,
			halfWidth: itemRect.width / 2,
			halfHeight: itemRect.height / 2,
		};
		target.dataset.dragging = "true";
	}

	function move(event: PointerEvent) {
		const current = drag.current;
		if (!current || event.pointerId !== current.pointerId) return;
		event.preventDefault();
		const minX = Math.min(0.49, current.halfWidth / current.stage.width);
		const maxX = Math.max(0.51, 1 - minX);
		const minY = Math.min(0.49, current.halfHeight / current.stage.height);
		const maxY = Math.max(0.51, 1 - minY);
		const x = clamp(
			current.origin.x + (event.clientX - current.startX) / current.stage.width,
			minX,
			maxX,
		);
		const y = clamp(
			current.origin.y + (event.clientY - current.startY) / current.stage.height,
			minY,
			maxY,
		);
		onMove(id, { x, y });
	}

	function end(event: PointerEvent) {
		const current = drag.current;
		if (!current || event.pointerId !== current.pointerId) return;
		drag.current = null;
		const target = event.currentTarget as HTMLElement;
		delete target.dataset.dragging;
		if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
		onMoveEnd();
	}

	return (
		<div
			className="touch-item"
			data-control={id}
			style={{
				left: `${point.x * 100}%`,
				top: `${point.y * 100}%`,
				width: `calc(var(--touch-unit) * ${size})`,
				height: `calc(var(--touch-unit) * ${size})`,
			}}
			onPointerDown={start}
			onPointerMove={move}
			onPointerUp={end}
			onPointerCancel={end}
			onLostPointerCapture={end}
			onClick={(event) => event.stopPropagation()}
			onDblClick={(event) => event.stopPropagation()}
		>
			{children}
		</div>
	);
}

function TouchButton(
	{ id, label, editing, state }: {
		id: TouchButtonId;
		label: string;
		editing: boolean;
		state: TouchState;
	},
) {
	const pressed = useSignal(false);
	const pointer = useRef<number | null>(null);

	function release(): void {
		pointer.current = null;
		state.setButton(id, false);
		pressed.value = false;
	}

	function down(event: PointerEvent): void {
		if (editing) return;
		event.preventDefault();
		event.stopPropagation();
		if (pointer.current !== null) return;
		pointer.current = event.pointerId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		state.setButton(id, true);
		pressed.value = true;
	}

	function up(event: PointerEvent): void {
		if (pointer.current !== event.pointerId) return;
		const target = event.currentTarget as HTMLElement;
		if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
		release();
	}

	return (
		<button
			type="button"
			className="touch-button"
			data-pressed={pressed.value ? "true" : undefined}
			aria-label={TOUCH_LABELS[id]}
			onPointerDown={down}
			onPointerUp={up}
			onPointerCancel={up}
			onLostPointerCapture={release}
			onContextMenu={(event) => event.preventDefault()}
		>
			{label}
		</button>
	);
}

function TouchStick(
	{ side, editing, state }: {
		side: "left" | "right";
		editing: boolean;
		state: TouchState;
	},
) {
	const baseRef = useRef<HTMLDivElement>(null);
	const knobRef = useRef<HTMLDivElement>(null);
	const pointer = useRef<number | null>(null);
	const active = useSignal(false);

	function centerKnob(): void {
		knobRef.current?.style.setProperty("transform", "translate(-50%, -50%)");
	}

	function release(): void {
		pointer.current = null;
		state.setStick(side, 0, 0);
		active.value = false;
		centerKnob();
	}

	function update(event: PointerEvent): void {
		const base = baseRef.current;
		if (editing || !base || pointer.current !== event.pointerId) return;
		const rect = base.getBoundingClientRect();
		const cx = rect.left + rect.width / 2;
		const cy = rect.top + rect.height / 2;
		const radius = rect.width * 0.34;
		let dx = event.clientX - cx;
		let dy = event.clientY - cy;
		const magnitude = Math.hypot(dx, dy);
		if (magnitude > radius) {
			dx = (dx / magnitude) * radius;
			dy = (dy / magnitude) * radius;
		}
		state.setStick(side, dx / radius, dy / radius);
		knobRef.current?.style.setProperty(
			"transform",
			`translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`,
		);
	}

	function down(event: PointerEvent): void {
		if (editing || pointer.current !== null) return;
		event.preventDefault();
		event.stopPropagation();
		const base = event.currentTarget as HTMLElement;
		pointer.current = event.pointerId;
		base.setPointerCapture(event.pointerId);
		active.value = true;
		update(event);
	}

	function up(event: PointerEvent): void {
		if (pointer.current !== event.pointerId) return;
		const base = event.currentTarget as HTMLElement;
		if (base.hasPointerCapture(event.pointerId)) base.releasePointerCapture(event.pointerId);
		release();
	}

	useEffect(() => {
		if (editing) release();
	}, [editing]);

	return (
		<div
			ref={baseRef}
			className="touch-stick"
			data-active={active.value ? "true" : undefined}
			role="group"
			aria-label={TOUCH_LABELS[side === "left" ? "leftStick" : "rightStick"]}
			onPointerDown={down}
			onPointerMove={update}
			onPointerUp={up}
			onPointerCancel={up}
			onLostPointerCapture={up}
		>
			<div ref={knobRef} className="touch-stick-knob" />
		</div>
	);
}

const DPAD_EMPTY: TouchDpadState = { up: false, down: false, left: false, right: false };

function TouchDpad(
	{ editing, state }: {
		editing: boolean;
		state: TouchState;
	},
) {
	const dirs = useSignal<TouchDpadState>(DPAD_EMPTY);
	const pointer = useRef<number | null>(null);

	function release(): void {
		pointer.current = null;
		state.setDpad(DPAD_EMPTY);
		dirs.value = DPAD_EMPTY;
	}

	function update(event: PointerEvent): void {
		if (editing || pointer.current !== event.pointerId) return;
		const target = event.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const dx = event.clientX - (rect.left + rect.width / 2);
		const dy = event.clientY - (rect.top + rect.height / 2);
		const dead = Math.max(5, rect.width * 0.12);
		const next = {
			up: dy < -dead,
			down: dy > dead,
			left: dx < -dead,
			right: dx > dead,
		};
		if (
			next.up !== dirs.value.up || next.down !== dirs.value.down ||
			next.left !== dirs.value.left || next.right !== dirs.value.right
		) {
			dirs.value = next;
		}
		state.setDpad(next);
	}

	function down(event: PointerEvent): void {
		if (editing || pointer.current !== null) return;
		event.preventDefault();
		event.stopPropagation();
		pointer.current = event.pointerId;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		update(event);
	}

	function up(event: PointerEvent): void {
		if (pointer.current !== event.pointerId) return;
		const target = event.currentTarget as HTMLElement;
		if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
		release();
	}

	useEffect(() => {
		if (editing) release();
	}, [editing]);

	return (
		<div
			className="touch-dpad"
			role="group"
			aria-label={TOUCH_LABELS.dpad}
			onPointerDown={down}
			onPointerMove={update}
			onPointerUp={up}
			onPointerCancel={up}
			onLostPointerCapture={up}
		>
			<span className="touch-dpad-arrow" data-dir="up" data-on={dirs.value.up ? "true" : undefined} />
			<span className="touch-dpad-arrow" data-dir="down" data-on={dirs.value.down ? "true" : undefined} />
			<span className="touch-dpad-arrow" data-dir="left" data-on={dirs.value.left ? "true" : undefined} />
			<span className="touch-dpad-arrow" data-dir="right" data-on={dirs.value.right ? "true" : undefined} />
			<span className="touch-dpad-hub" />
		</div>
	);
}

export default function TouchController({ prefs, state, editing, onDone }: Props) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [wide, setWide] = useState(true);
	const [generation, setGeneration] = useState(0);
	const [draft, setDraft] = useState<TouchLayout | null>(null);
	const draftRef = useRef<TouchLayout | null>(null);
	const key = wide ? "wide" : "tall";
	const layout = draft ?? prefs.value.layouts[key];

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const update = () => {
			const rect = root.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) setWide(rect.width >= rect.height);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	// Do not leave a held touch stuck when the tab loses focus.
	useEffect(() => {
		const clear = () => {
			state.clear();
			setGeneration((value) => value + 1);
		};
		const onVisibility = () => {
			if (document.visibilityState === "hidden") clear();
		};
		globalThis.addEventListener("blur", clear);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			globalThis.removeEventListener("blur", clear);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [state]);

	useEffect(() => {
		draftRef.current = null;
		setDraft(null);
		state.clear();
	}, [wide]);

	// Commit a drag even if edit mode was left with Escape or the settings.
	useEffect(() => {
		if (editing) {
			state.clear();
			return;
		}
		const next = draftRef.current;
		if (next) {
			draftRef.current = null;
			setDraft(null);
			prefs.value = {
				...prefs.value,
				layouts: { ...prefs.value.layouts, [key]: next },
			};
		}
		state.clear();
	}, [editing]);

	function move(id: TouchControlId, point: TouchPoint): void {
		const next = { ...(draftRef.current ?? prefs.value.layouts[key]), [id]: point };
		draftRef.current = next;
		setDraft(next);
	}

	function commitDraft(): void {
		const next = draftRef.current;
		if (!next) return;
		draftRef.current = null;
		setDraft(null);
		prefs.value = {
			...prefs.value,
			layouts: { ...prefs.value.layouts, [key]: next },
		};
	}

	function reset(): void {
		draftRef.current = null;
		setDraft(null);
		prefs.value = {
			...prefs.value,
			layouts: { ...prefs.value.layouts, [key]: defaultTouchLayout(wide) },
		};
	}

	function mirror(): void {
		const next = mirrorTouchLayout(draftRef.current ?? prefs.value.layouts[key]);
		draftRef.current = null;
		setDraft(null);
		prefs.value = {
			...prefs.value,
			layouts: { ...prefs.value.layouts, [key]: next },
		};
	}

	function done(): void {
		commitDraft();
		onDone();
	}

	return (
		<div
			id="touch-pad"
			ref={rootRef}
			data-editing={editing ? "true" : undefined}
			onContextMenu={(event) => event.preventDefault()}
			onClick={(event) => event.stopPropagation()}
			onDblClick={(event) => event.stopPropagation()}
		>
			<div className="touch-controls" key={`${wide}-${editing}-${generation}`}>
				<TouchItem
					id="leftStick"
					point={layout.leftStick}
					scale={prefs.value.scale}
					editing={editing}
					onMove={move}
					onMoveEnd={commitDraft}
				>
					<TouchStick side="left" editing={editing} state={state} />
				</TouchItem>
				<TouchItem
					id="rightStick"
					point={layout.rightStick}
					scale={prefs.value.scale}
					editing={editing}
					onMove={move}
					onMoveEnd={commitDraft}
				>
					<TouchStick side="right" editing={editing} state={state} />
				</TouchItem>
				<TouchItem
					id="dpad"
					point={layout.dpad}
					scale={prefs.value.scale}
					editing={editing}
					onMove={move}
					onMoveEnd={commitDraft}
				>
					<TouchDpad editing={editing} state={state} />
				</TouchItem>
				{TOUCH_BUTTONS.map(({ id, label }) => (
					<TouchItem
						key={id}
						id={id}
						point={layout[id]}
						scale={prefs.value.scale}
						editing={editing}
						onMove={move}
						onMoveEnd={commitDraft}
					>
						<TouchButton id={id} label={label} editing={editing} state={state} />
					</TouchItem>
				))}
			</div>

			{editing && (
				<div className="touch-edit-bar" onClick={(event) => event.stopPropagation()}>
					<span>
						<Move size={14} aria-hidden="true" /> Drag controls
					</span>
					<button type="button" className="btn" onClick={mirror}>
						<FlipHorizontal2 size={14} aria-hidden="true" /> Mirror
					</button>
					<button type="button" className="btn" onClick={reset}>
						<RotateCcw size={14} aria-hidden="true" /> Reset
					</button>
					<button type="button" className="btn btn-primary" onClick={done}>
						<Check size={14} aria-hidden="true" /> Done
					</button>
				</div>
			)}
		</div>
	);
}
