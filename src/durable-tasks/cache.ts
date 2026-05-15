import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runTsqJson, type TsqRunContext } from "./runner.js";

export interface TasqueStatusCacheState {
	readonly readyCoding: number;
	readonly readyPlanning: number;
	readonly inProgressMine: number;
	readonly refreshedAt: number | undefined;
	readonly error: string | undefined;
}

export interface TasqueStatusCache {
	readonly state: TasqueStatusCacheState;
}

export interface TasqueStatusRefreshOptions {
	readonly now?: () => number;
	readonly timeout?: number;
	readonly signal?: AbortSignal;
}

export interface TasqueStatusFormatOptions {
	readonly now?: () => number;
	readonly staleAfterMs?: number;
}

const DEFAULT_REFRESH_TIMEOUT_MS = 4_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const MAX_ERROR_LENGTH = 80;

export function createTasqueStatusCache(
	state: Partial<TasqueStatusCacheState> = {},
): TasqueStatusCache {
	return {
		state: {
			readyCoding: state.readyCoding ?? 0,
			readyPlanning: state.readyPlanning ?? 0,
			inProgressMine: state.inProgressMine ?? 0,
			refreshedAt: state.refreshedAt,
			error: state.error,
		},
	};
}

export async function refreshTasqueStatusCache(
	pi: ExtensionAPI,
	ctx: TsqRunContext,
	cache: TasqueStatusCache,
	options: TasqueStatusRefreshOptions = {},
): Promise<TasqueStatusCache> {
	const now = options.now ?? Date.now;
	const timeout = options.timeout ?? DEFAULT_REFRESH_TIMEOUT_MS;
	const runOptions = {
		timeout,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	};

	try {
		await runTsqJson<unknown>(pi, ctx, ["doctor"], runOptions);
		const [readyCoding, readyPlanning, inProgressMine] = await Promise.all([
			runTsqJson<unknown>(
				pi,
				ctx,
				["find", "ready", "--lane", "coding"],
				runOptions,
			),
			runTsqJson<unknown>(
				pi,
				ctx,
				["find", "ready", "--lane", "planning"],
				runOptions,
			),
			runTsqJson<unknown>(
				pi,
				ctx,
				["find", "in-progress", "--assignee", "pi"],
				runOptions,
			),
		]);

		return createTasqueStatusCache({
			readyCoding: countTasks(readyCoding),
			readyPlanning: countTasks(readyPlanning),
			inProgressMine: countTasks(inProgressMine),
			refreshedAt: now(),
			error: undefined,
		});
	} catch (error) {
		return createTasqueStatusCache({
			...cache.state,
			error: getErrorMessage(error),
		});
	}
}

export function formatTasqueStatusText(
	state: TasqueStatusCacheState,
	options: TasqueStatusFormatOptions = {},
): string {
	if (state.error !== undefined) {
		return `tsq: stale · ${state.error}`;
	}

	if (state.refreshedAt === undefined) {
		return "tsq: loading";
	}

	const now = options.now ?? Date.now;
	const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
	const ageMs = Math.max(0, now() - state.refreshedAt);
	const counts = formatCounts(state);

	if (ageMs > staleAfterMs) {
		return `tsq: stale ${formatAge(ageMs)} · ${counts}`;
	}

	return `tsq: ${counts} · ${formatAge(ageMs)}`;
}

function formatCounts(state: TasqueStatusCacheState): string {
	return `coding ${state.readyCoding} · planning ${state.readyPlanning} · mine ${state.inProgressMine}`;
}

function countTasks(data: unknown): number {
	if (Array.isArray(data)) {
		return data.length;
	}
	if (!isRecord(data)) {
		return 0;
	}
	if (Array.isArray(data.tasks)) {
		return data.tasks.length;
	}
	if (Array.isArray(data.tree)) {
		return data.tree.length;
	}
	return 0;
}

function formatAge(ageMs: number): string {
	const seconds = Math.floor(ageMs / 1_000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	return `${hours}h`;
}

function getErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return truncateInline(message.replace(/\s+/gu, " ").trim(), MAX_ERROR_LENGTH);
}

function truncateInline(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
