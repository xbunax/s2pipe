import type { PadState } from "./pad.ts";

export type CaptureStatus = {
	running: boolean;
	source: string;
	error: string | null;
};

export type PicoTransportKind = "serial" | "wifi";

export type PicoStats = {
	tx: number;
	rx: number;
	auth: number;
	dup: number;
	old: number;
	oow: number;
	bad: number;
};

export type PicoStatus = {
	connected: boolean;
	transport: PicoTransportKind;
	path: string | null;
	device: string | null;
	ip: string | null;
	error: string | null;
	wake: boolean;
	latencyMs: number | null;
	rssi: number | null;
	stats: PicoStats | null;
};

export type StatusData = {
	capture: CaptureStatus;
	pico: PicoStatus;
	occupied: number[];
};

export type NodeStatus = {
	service: "s2pipe-node";
	uptimeSec: number;
} & StatusData;

export type ClientMessage =
	| { op: "play"; data: { count: number } }
	| { op: "watch" }
	| { op: "pad"; data: PadState; seat: number }
	| { op: "pong" };

export type ServerMessage =
	| { op: "status"; data: StatusData }
	| { op: "play"; data: { seats: number[] } }
	| { op: "ping" };
