import { type Bindings, cloneBindings, sanitizeBindings } from "./bindings.ts";
import {
	BUILTIN_LABELS,
	type BuiltinId,
	type ControllerPreset,
	factoryPresets,
	isBuiltinId,
	isRetiredId,
} from "./presets.ts";

// Bump it to reset the built-in presets of every browser. Profiles are kept.
const LAYOUT_VERSION = 4;
const DEFAULT_SENSITIVITY = 0.45;
const MAX_NAME = 32;

export const VIRTUAL_PREFS_KEY = "s2pipe.virtual";
export const MAX_PRESETS = 16;

export type VirtualPrefs = {
	version: number;
	// Never stored: the virtual controller is off after a reload.
	enabled: boolean;
	activeId: string;
	presets: ControllerPreset[];
	mouseSensitivity: number;
};

function clampSensitivity(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_SENSITIVITY;
	return Math.min(2, Math.max(0.05, n));
}

export function clampPresetName(value: unknown, fallback = "Profil"): string {
	const name = typeof value === "string" ? value.trim() : "";
	return (name || fallback).slice(0, MAX_NAME);
}

function readPreset(raw: unknown): ControllerPreset | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Partial<ControllerPreset>;
	if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 80) return null;
	const builtin: BuiltinId | null = isBuiltinId(item.id) ? item.id : null;
	return {
		id: item.id,
		name: builtin ? BUILTIN_LABELS[builtin] : clampPresetName(item.name),
		bindings: sanitizeBindings(item.bindings),
		builtin,
	};
}

// Built-ins always come first, each one edited or not, then the profiles up to the limit.
function withBuiltins(presets: ControllerPreset[]): ControllerPreset[] {
	const builtins = factoryPresets().map((factory) => presets.find((item) => item.id === factory.id) ?? factory);
	const profiles = presets.filter((item, i) =>
		!item.builtin && presets.findIndex((other) => other.id === item.id) === i
	);
	return [...builtins, ...profiles].slice(0, MAX_PRESETS);
}

export function parseStoredPrefs(raw: unknown): VirtualPrefs {
	const source = (raw && typeof raw === "object" ? raw : {}) as Partial<VirtualPrefs>;
	const stale = source.version !== LAYOUT_VERSION;
	const items = (Array.isArray(source.presets) ? source.presets : []).flatMap((item) => {
		const preset = readPreset(item);
		return preset && !isRetiredId(preset.id) && !(stale && preset.builtin) ? [preset] : [];
	});
	const presets = withBuiltins(items);
	return {
		version: LAYOUT_VERSION,
		enabled: false,
		activeId: presets.find((preset) => preset.id === source.activeId)?.id ?? "standard",
		presets,
		mouseSensitivity: clampSensitivity(source.mouseSensitivity),
	};
}

export function defaultVirtualPrefs(): VirtualPrefs {
	return parseStoredPrefs(null);
}

export function loadVirtualPrefs(): VirtualPrefs {
	try {
		return parseStoredPrefs(JSON.parse(localStorage.getItem(VIRTUAL_PREFS_KEY) ?? "null"));
	} catch {
		return defaultVirtualPrefs();
	}
}

export function saveVirtualPrefs(prefs: VirtualPrefs): void {
	try {
		localStorage.setItem(VIRTUAL_PREFS_KEY, JSON.stringify(parseStoredPrefs(prefs)));
	} catch {
		// Quota or private mode.
	}
}

export function createUserPreset(name: string, bindings: Bindings): ControllerPreset {
	// randomUUID needs a secure context, and the node may be served over plain http on the LAN.
	const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `preset-${Date.now()}`;
	return {
		id,
		name: clampPresetName(name),
		bindings: cloneBindings(sanitizeBindings(bindings)),
		builtin: null,
	};
}
