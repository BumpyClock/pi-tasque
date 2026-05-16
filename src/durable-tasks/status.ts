import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "../shared/error-utils.js";
import {
	createTasqueStatusCache,
	formatTasqueStatusText,
	refreshTasqueStatusCache,
	type TasqueStatusCache,
} from "./cache.js";
import { resolveProjectRoot } from "./project.js";

export const TASQUE_STATUS_KEY = "pi-tasque";

const MUTATING_TOOL_NAMES = new Set(["task"]);
const DEFAULT_INTERVAL_MS = 60_000;

export interface TasqueStatusLifecycleOptions {
	readonly intervalMs?: number;
	readonly refreshTimeoutMs?: number;
	readonly now?: () => number;
	readonly staleAfterMs?: number;
}

interface ToolExecutionEndLike {
	readonly isError: boolean;
	readonly toolName: string;
	readonly result: unknown;
}

export function registerTasqueStatusLifecycle(
	pi: ExtensionAPI,
	options: TasqueStatusLifecycleOptions = {},
): void {
	let cache: TasqueStatusCache = createTasqueStatusCache();
	let interval: ReturnType<typeof setInterval> | undefined;
	let latestContext: ExtensionContext | undefined;
	let refreshInFlight: Promise<void> | undefined;
	let refreshInFlightGeneration: number | undefined;
	let queuedRefreshContext: ExtensionContext | undefined;
	let lifecycleGeneration = 0;
	let statusActive = true;

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (!statusActive || !hasStatusUi(ctx)) {
			return;
		}

		latestContext = ctx;
		const generation = lifecycleGeneration;
		if (
			refreshInFlight !== undefined &&
			refreshInFlightGeneration === generation
		) {
			queuedRefreshContext = ctx;
			return refreshInFlight;
		}

		let refreshPromise: Promise<void>;
		refreshPromise = resolveProjectRoot(pi, ctx.cwd, {
			...(options.refreshTimeoutMs === undefined
				? {}
				: { timeout: options.refreshTimeoutMs }),
		})
			.then((projectRoot) =>
				refreshTasqueStatusCache(pi, { cwd: projectRoot }, cache, {
					...(options.now === undefined ? {} : { now: options.now }),
					...(options.refreshTimeoutMs === undefined
						? {}
						: { timeout: options.refreshTimeoutMs }),
				}),
			)
			.catch((error) =>
				createTasqueStatusCache({
					...cache.state,
					error: getErrorMessage(error),
				}),
			)
			.then((nextCache) => {
				if (!statusActive || generation !== lifecycleGeneration) {
					return;
				}
				cache = nextCache;
				ctx.ui.setStatus(
					TASQUE_STATUS_KEY,
					formatTasqueStatusText(cache.state, {
						...(options.now === undefined ? {} : { now: options.now }),
						...(options.staleAfterMs === undefined
							? {}
							: { staleAfterMs: options.staleAfterMs }),
					}),
				);
			})
			.finally(async () => {
				const isCurrentRefresh =
					refreshInFlight === refreshPromise &&
					refreshInFlightGeneration === generation;
				if (isCurrentRefresh) {
					refreshInFlight = undefined;
					refreshInFlightGeneration = undefined;
				}
				if (
					!isCurrentRefresh ||
					!statusActive ||
					generation !== lifecycleGeneration
				) {
					return;
				}
				const nextContext = queuedRefreshContext;
				queuedRefreshContext = undefined;
				if (nextContext === undefined) {
					return;
				}
				await refresh(nextContext);
			});

		refreshInFlight = refreshPromise;
		refreshInFlightGeneration = generation;
		return refreshPromise;
	}

	function clearRefreshInterval(): void {
		if (interval !== undefined) {
			clearInterval(interval);
			interval = undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		clearRefreshInterval();
		if (!hasStatusUi(ctx)) {
			return;
		}
		lifecycleGeneration += 1;
		refreshInFlight = undefined;
		refreshInFlightGeneration = undefined;
		queuedRefreshContext = undefined;
		statusActive = true;
		latestContext = ctx;
		interval = setInterval(() => {
			const ctxForRefresh = latestContext;
			if (ctxForRefresh !== undefined) {
				void refresh(ctxForRefresh);
			}
		}, options.intervalMs ?? DEFAULT_INTERVAL_MS);
		await refresh(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (!shouldRefreshAfterTool(event) || !hasStatusUi(ctx)) {
			return;
		}
		await refresh(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearRefreshInterval();
		lifecycleGeneration += 1;
		latestContext = undefined;
		refreshInFlight = undefined;
		refreshInFlightGeneration = undefined;
		queuedRefreshContext = undefined;
		statusActive = false;
		if (hasStatusUi(ctx)) {
			ctx.ui.setStatus(TASQUE_STATUS_KEY, undefined);
		}
	});
}

function shouldRefreshAfterTool(event: ToolExecutionEndLike): boolean {
	if (event.isError || !MUTATING_TOOL_NAMES.has(event.toolName)) {
		return false;
	}
	return getDetailsOk(event.result) !== false;
}

function getDetailsOk(result: unknown): boolean | undefined {
	if (!isRecord(result)) {
		return undefined;
	}
	const details = result.details;
	if (!isRecord(details)) {
		return undefined;
	}
	return typeof details.ok === "boolean" ? details.ok : undefined;
}

function hasStatusUi(ctx: ExtensionContext): boolean {
	return (
		ctx.hasUI === true &&
		isRecord(ctx.ui) &&
		typeof ctx.ui.setStatus === "function"
	);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
