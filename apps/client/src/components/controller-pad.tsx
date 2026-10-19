import { Camera, House, Minus, Plus } from "lucide-preact";
import type { ComponentChildren } from "preact";

import { PAD_CENTER, type PadState } from "@s2pipe/shared/types/pad";

import {
	type Bindings,
	describeInput,
	describeStickDir,
	PAD_BUTTON_BITS,
	PAD_BUTTON_LABELS,
	type PadButtonName,
	STICK_LABELS,
	type StickBinding,
	type StickDir,
	type StickId,
	type StickListen,
} from "../utils/virtual/mod.ts";

type Listening = PadButtonName | StickListen | null;

type Props = {
	bindings: Bindings;
	live: PadState;
	listening: Listening;
	onButton: (name: PadButtonName) => void;
	onStickDir: (id: StickId, dir: StickDir) => void;
	onStickMode: (id: StickId, mode: "mouse" | "none") => void;
};

type Point = readonly [number, number];

type Legend = { name: PadButtonName; y: number; to: Point };

const ICONS = { Minus, Plus, Home: House, Capture: Camera } as const;

const LEGEND_X = { left: 16, right: 748 } as const;
const LEGEND_WIDTH = 196;
const LEGEND_HEIGHT = 40;

// Each legend points at the edge of its part that faces the legend, so the line never ends under a stick.
const LEGENDS: Record<"left" | "right", Legend[]> = {
	left: [
		{ name: "ZL", y: 52, to: [280, 78] },
		{ name: "L", y: 100, to: [262, 108] },
		{ name: "Minus", y: 148, to: [424, 148] },
		{ name: "Capture", y: 196, to: [428, 184] },
		{ name: "LStick", y: 310, to: [285, 282] },
	],
	right: [
		{ name: "ZR", y: 52, to: [680, 78] },
		{ name: "R", y: 100, to: [698, 108] },
		{ name: "Plus", y: 148, to: [536, 148] },
		{ name: "Home", y: 196, to: [532, 184] },
		{ name: "RStick", y: 310, to: [572, 325] },
	],
};

const STICKS = { left: [318, 250], right: [540, 292] } as const;
const STICK_OUT = 46;
const STICK_IN = 15;
const WEDGE_MID = { up: -90, right: 0, down: 90, left: 180 } as const;

const DPAD_CENTER = [420, 292] as const;
const DPAD_ARM = 32;
const DPAD_STEP = { Up: [0, -1], Down: [0, 1], Left: [-1, 0], Right: [1, 0] } as const;

const FACE_CENTER = [642, 250] as const;
const FACE_STEP = { X: [0, -1], Y: [-1, 0], A: [1, 0], B: [0, 1] } as const;
const FACE_SPACING = 36;

const BODY = "M 320 130 Q 480 108 640 130 C 690 140 712 210 722 300 C 734 390 720 470 676 482 " +
	"C 636 492 612 440 598 392 C 588 358 572 346 540 346 L 420 346 C 388 346 372 358 362 392 " +
	"C 348 440 324 492 284 482 C 240 470 226 390 238 300 C 248 210 270 140 320 130 Z";

const ARROWS: Record<string, string> = { Up: "↑", Down: "↓", Left: "←", Right: "→" };

// Part labels are tiny: arrows and "L"/"R" prefixes keep the usual keys readable, the rest is cut.
function short(label: string, max: number): string {
	const text = ARROWS[label] ?? label.replace(/^(Left|Right) /, (side) => `${side[0]} `);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function polar([cx, cy]: Point, radius: number, degrees: number): string {
	const angle = degrees * Math.PI / 180;
	return `${(cx + radius * Math.cos(angle)).toFixed(1)} ${(cy + radius * Math.sin(angle)).toFixed(1)}`;
}

function wedge(center: Point, mid: number): string {
	const [from, to] = [mid - 45, mid + 45];
	return `M ${polar(center, STICK_OUT, from)} A ${STICK_OUT} ${STICK_OUT} 0 0 1 ${polar(center, STICK_OUT, to)} ` +
		`L ${polar(center, STICK_IN, to)} A ${STICK_IN} ${STICK_IN} 0 0 0 ${polar(center, STICK_IN, from)} Z`;
}

function dirPushed(binding: StickBinding, dir: StickDir, x: number, y: number): boolean {
	if (binding.kind === "none") return false;
	if (dir === "left") return x < PAD_CENTER - 10;
	if (dir === "right") return x > PAD_CENTER + 10;
	if (dir === "up") return y < PAD_CENTER - 10;
	return y > PAD_CENTER + 10;
}

function Hit({ label, active, pressed, onClick, className, children }: {
	label: string;
	active: boolean;
	pressed: boolean;
	onClick: () => void;
	className?: string;
	children: ComponentChildren;
}) {
	return (
		<g
			role="button"
			tabIndex={0}
			className={className}
			aria-label={label}
			aria-pressed={pressed}
			data-active={active ? "true" : undefined}
			onClick={onClick}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onClick();
			}}
		>
			{children}
		</g>
	);
}

export default function ControllerPad(props: Props) {
	const { bindings, live, listening, onButton, onStickDir, onStickMode } = props;

	const bound = (name: PadButtonName) => describeInput(bindings.buttons[name]);
	const down = (name: PadButtonName) => (live.buttons & PAD_BUTTON_BITS[name]) !== 0;

	// A part of the pad that rebinds one button when clicked.
	const part = (name: PadButtonName, children: ComponentChildren) => (
		<Hit
			label={`${PAD_BUTTON_LABELS[name]}: ${bound(name)}`}
			active={down(name)}
			pressed={listening === name}
			onClick={() => onButton(name)}
		>
			{children}
		</Hit>
	);

	const stick = (id: StickId) => {
		const center = STICKS[id];
		const binding = bindings.sticks[id];
		const [x, y] = id === "left" ? [live.lx, live.ly] : [live.rx, live.ry];
		const click: PadButtonName = id === "left" ? "LStick" : "RStick";
		return (
			<>
				{(Object.keys(WEDGE_MID) as StickDir[]).map((dir) => {
					const text = describeStickDir(binding, dir);
					const [tx, ty] = polar(center, 31, WEDGE_MID[dir]).split(" ");
					return (
						<Hit
							key={dir}
							label={`${STICK_LABELS[id]} ${dir}: ${text}`}
							active={dirPushed(binding, dir, x, y)}
							pressed={typeof listening === "object" && listening !== null && listening.id === id &&
								listening.dir === dir}
							onClick={() => onStickDir(id, dir)}
						>
							<path d={wedge(center, WEDGE_MID[dir])} />
							<text x={tx} y={ty}>{short(text, 5)}</text>
						</Hit>
					);
				})}
				{part(
					click,
					<>
						<circle cx={center[0]} cy={center[1]} r={STICK_IN} />
						<text x={center[0]} y={center[1]}>{click === "LStick" ? "L3" : "R3"}</text>
					</>,
				)}
			</>
		);
	};

	const trigger = (name: PadButtonName, x: number, y: number, width: number, height: number) =>
		part(
			name,
			<>
				<rect x={x} y={y} width={width} height={height} rx={height / 2} />
				<text x={x + width / 2} y={y + height / 2}>{name}</text>
			</>,
		);

	const system = (name: "Minus" | "Plus" | "Home" | "Capture", x: number, y: number) => {
		const Icon = ICONS[name];
		const size = 26;
		return part(
			name,
			<>
				{name === "Capture"
					? <rect x={x - size / 2} y={y - size / 2} width={size} height={size} rx={6} />
					: <circle cx={x} cy={y} r={size / 2} />}
				<Icon x={x - 7} y={y - 7} size={14} aria-hidden="true" />
			</>,
		);
	};

	return (
		<figure>
			<svg viewBox="0 0 960 500" role="group" aria-label="Controller">
				<path d={BODY} />
				<rect
					x={DPAD_CENTER[0] - DPAD_ARM / 2}
					y={DPAD_CENTER[1] - DPAD_ARM / 2}
					width={DPAD_ARM}
					height={DPAD_ARM}
				/>
				<g aria-hidden="true">
					{(["left", "right"] as const).flatMap((side) =>
						LEGENDS[side].map(({ name, y, to }) => {
							const fromX = side === "left" ? LEGEND_X.left + LEGEND_WIDTH : LEGEND_X.right;
							return (
								<g key={name}>
									<line x1={fromX} y1={y} x2={to[0]} y2={to[1]} />
									<circle cx={to[0]} cy={to[1]} r={3} />
								</g>
							);
						})
					)}
				</g>

				{trigger("ZL", 280, 62, 120, 32)}
				{trigger("ZR", 560, 62, 120, 32)}
				{trigger("L", 262, 98, 148, 20)}
				{trigger("R", 550, 98, 148, 20)}

				{system("Minus", 436, 148)}
				{system("Plus", 524, 148)}
				{system("Capture", 440, 184)}
				{system("Home", 520, 184)}

				{stick("left")}
				{stick("right")}

				{(Object.keys(DPAD_STEP) as (keyof typeof DPAD_STEP)[]).map((name) => {
					const [dx, dy] = DPAD_STEP[name];
					const x = DPAD_CENTER[0] - DPAD_ARM / 2 + dx * DPAD_ARM;
					const y = DPAD_CENTER[1] - DPAD_ARM / 2 + dy * DPAD_ARM;
					return (
						<Hit
							key={name}
							label={`${PAD_BUTTON_LABELS[name]}: ${bound(name)}`}
							active={down(name)}
							pressed={listening === name}
							onClick={() => onButton(name)}
						>
							<rect x={x} y={y} width={DPAD_ARM} height={DPAD_ARM} rx={5} />
							<text x={x + DPAD_ARM / 2} y={y + DPAD_ARM / 2}>{short(bound(name), 5)}</text>
						</Hit>
					);
				})}

				{(Object.keys(FACE_STEP) as (keyof typeof FACE_STEP)[]).map((name) => {
					const [dx, dy] = FACE_STEP[name];
					const x = FACE_CENTER[0] + dx * FACE_SPACING;
					const y = FACE_CENTER[1] + dy * FACE_SPACING;
					return (
						<Hit
							key={name}
							label={`${PAD_BUTTON_LABELS[name]}: ${bound(name)}`}
							active={down(name)}
							pressed={listening === name}
							onClick={() => onButton(name)}
						>
							<circle cx={x} cy={y} r={18} />
							<text x={x} y={y - 5}>{name}</text>
							<text x={x} y={y + 8}>{short(bound(name), 6)}</text>
						</Hit>
					);
				})}

				{(["left", "right"] as const).flatMap((side) =>
					LEGENDS[side].map(({ name, y }) => (
						<Hit
							key={name}
							className="pad-legend"
							label={`${PAD_BUTTON_LABELS[name]}: ${bound(name)}`}
							active={down(name)}
							pressed={listening === name}
							onClick={() => onButton(name)}
						>
							<rect
								x={LEGEND_X[side]}
								y={y - LEGEND_HEIGHT / 2}
								width={LEGEND_WIDTH}
								height={LEGEND_HEIGHT}
								rx={8}
							/>
							<text x={LEGEND_X[side] + 14} y={y}>{PAD_BUTTON_LABELS[name]}</text>
							<text x={LEGEND_X[side] + LEGEND_WIDTH - 14} y={y}>{short(bound(name), 12)}</text>
						</Hit>
					))
				)}
			</svg>
			<div>
				{(["left", "right"] as const).map((id) => (
					<div key={id}>
						<span>{STICK_LABELS[id]}</span>
						{([["mouse", "Mouse"], ["none", "Off"]] as const).map(([mode, text]) => (
							<button
								key={mode}
								type="button"
								className="btn"
								aria-pressed={bindings.sticks[id].kind === mode}
								onClick={() => onStickMode(id, mode)}
							>
								{text}
							</button>
						))}
					</div>
				))}
			</div>
		</figure>
	);
}
