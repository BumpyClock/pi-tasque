import { describe, expect, it, vi, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createTasqueStatusCache,
	formatTasqueStatusText,
	refreshTasqueStatusCache,
} from "../../src/durable-tasks/cache.js";
import { registerTasqueStatusLifecycle } from "../../src/durable-tasks/status.js";
import { createMockPi, emitPiEvent } from "../support/pi-harness.js";

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function errorEnvelope(message: string) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq",
			ok: false,
			error: { code: "boom", message },
		}),
		stderr: "",
		code: 1,
		killed: false,
	};
}

function task(id: string) {
	return {
		id,
		title: `Task ${id}`,
		kind: "task",
		status: "open",
		planning_state: "planned",
		priority: 2,
		labels: [],
		notes: [],
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const TASQUE_REFRESH_CALL_ARGS = [
	["doctor", "--format", "json"],
	["find", "ready", "--lane", "coding", "--format", "json"],
	["find", "ready", "--lane", "planning", "--format", "json"],
	["find", "in-progress", "--assignee", "pi", "--format", "json"],
] as const;

function uiContext(overrides: Partial<ExtensionContext> = {}) {
	return {
		cwd: "/repo",
		hasUI: true,
		ui: { setStatus: vi.fn() },
		...overrides,
	} as unknown as ExtensionContext & {
		ui: { setStatus: ReturnType<typeof vi.fn> };
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Tasque status cache", () => {
	it("refreshes doctor, ready coding, ready planning, and in-progress mine counts", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = (_command, args) => {
			const command = args.slice(0, -2).join(" ");
			switch (command) {
				case "doctor":
					return okEnvelope({ tasks: 8, issues: [] });
				case "find ready --lane coding":
					return okEnvelope({
						tasks: [task("tsq-code-1"), task("tsq-code-2")],
					});
				case "find ready --lane planning":
					return okEnvelope({ tasks: [task("tsq-plan-1")] });
				case "find in-progress --assignee pi":
					return okEnvelope({
						tasks: [task("tsq-mine-1"), task("tsq-mine-2"), task("tsq-mine-3")],
					});
				default:
					throw new Error(`unexpected tsq args: ${args.join(" ")}`);
			}
		};

		const cache = createTasqueStatusCache();
		const next = await refreshTasqueStatusCache(pi, { cwd: "/repo" }, cache, {
			now: () => 1_000,
		});

		expect(next.state).toMatchObject({
			readyCoding: 2,
			readyPlanning: 1,
			inProgressMine: 3,
			refreshedAt: 1_000,
			error: undefined,
		});
		expect(captured.execCalls.map((call) => call.args)).toEqual(
			TASQUE_REFRESH_CALL_ARGS,
		);
		expect(formatTasqueStatusText(next.state, { now: () => 19_000 })).toBe(
			"tsq: coding 2 · planning 1 · mine 3 · 18s",
		);
	});

	it("keeps last good counts and formats stale error state on refresh failure", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () =>
			errorEnvelope("database locked while refreshing durable tasks");
		const cache = {
			state: {
				readyCoding: 4,
				readyPlanning: 2,
				inProgressMine: 1,
				refreshedAt: 10_000,
				error: undefined,
			},
		};

		const next = await refreshTasqueStatusCache(pi, { cwd: "/repo" }, cache, {
			now: () => 70_000,
		});

		expect(next.state).toMatchObject({
			readyCoding: 4,
			readyPlanning: 2,
			inProgressMine: 1,
			refreshedAt: 10_000,
		});
		expect(next.state.error).toContain("database locked");
		expect(formatTasqueStatusText(next.state, { now: () => 70_000 })).toBe(
			"tsq: stale · database locked while refreshing durable tasks",
		);
	});

	it("formats stale state when last success is older than the stale threshold", () => {
		const text = formatTasqueStatusText(
			{
				readyCoding: 1,
				readyPlanning: 0,
				inProgressMine: 2,
				refreshedAt: 1_000,
				error: undefined,
			},
			{ now: () => 181_000, staleAfterMs: 120_000 },
		);

		expect(text).toBe("tsq: stale 3m · coding 1 · planning 0 · mine 2");
	});
});

describe("registerTasqueStatusLifecycle", () => {
	it("sets footer status on session_start when UI is available", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = (_command, args) => {
			const command = args.slice(0, -2).join(" ");
			if (command === "find ready --lane coding") {
				return okEnvelope({ tasks: [task("tsq-code-1")] });
			}
			if (command === "find ready --lane planning") {
				return okEnvelope({ tasks: [] });
			}
			if (command === "find in-progress --assignee pi") {
				return okEnvelope({ tasks: [task("tsq-mine-1")] });
			}
			return okEnvelope({});
		};
		registerTasqueStatusLifecycle(pi, {
			intervalMs: 60_000,
			now: () => 5_000,
		});
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);

		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"pi-tasque",
			"tsq: coding 1 · planning 0 · mine 1 · 0s",
		);
	});

	it.each([
		"tsq_change",
		"tsq_claim",
		"task_bridge",
	] as const)("refreshes after successful %s execution", async (toolName) => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => okEnvelope({ tasks: [] });
		registerTasqueStatusLifecycle(pi, { now: () => 1_000 });
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName,
				result: { details: { ok: true } },
				isError: false,
			},
			ctx,
		);

		expect(captured.execCalls).toHaveLength(4);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"pi-tasque",
			"tsq: coding 0 · planning 0 · mine 0 · 0s",
		);
	});

	it("does not refresh after failed or unrelated tool execution", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => okEnvelope({ tasks: [] });
		registerTasqueStatusLifecycle(pi);
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "tsq_change",
				result: { details: { ok: false } },
				isError: false,
			},
			ctx,
		);
		await emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-2",
				toolName: "todo",
				result: { details: { ok: true } },
				isError: false,
			},
			ctx,
		);

		expect(captured.execCalls).toEqual([]);
		expect(ctx.ui.setStatus).not.toHaveBeenCalled();
	});

	it("guards no-UI contexts", async () => {
		const { pi, captured } = createMockPi();
		captured.execHandler = () => okEnvelope({ tasks: [] });
		registerTasqueStatusLifecycle(pi);
		const ctx = { cwd: "/repo", hasUI: false } as unknown as ExtensionContext;

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		await emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "tsq_change",
				result: { details: { ok: true } },
				isError: false,
			},
			ctx,
		);

		expect(captured.execCalls).toEqual([]);
	});

	it("queues one post-mutation refresh when a tool update lands during interval refresh", async () => {
		vi.useFakeTimers();
		let refreshRun = 0;
		const intervalDoctor = deferred<ReturnType<typeof okEnvelope>>();
		const { pi, captured } = createMockPi();
		captured.execHandler = (_command, args) => {
			const command = args.slice(0, -2).join(" ");
			if (command === "doctor") {
				refreshRun += 1;
				if (refreshRun === 2) {
					return intervalDoctor.promise;
				}
				return okEnvelope({ tasks: [] });
			}
			if (command === "find ready --lane coding") {
				return okEnvelope({
					tasks:
						refreshRun === 3
							? [task("tsq-code-1"), task("tsq-code-2")]
							: refreshRun === 2
								? [task("tsq-code-1")]
								: [],
				});
			}
			if (command === "find ready --lane planning") {
				return okEnvelope({
					tasks: refreshRun === 3 ? [task("tsq-plan-1")] : [],
				});
			}
			if (command === "find in-progress --assignee pi") {
				return okEnvelope({
					tasks: refreshRun === 3 ? [task("tsq-mine-1")] : [],
				});
			}
			throw new Error(`unexpected tsq args: ${args.join(" ")}`);
		};
		registerTasqueStatusLifecycle(pi, {
			intervalMs: 1_000,
			now: () => 1_000,
		});
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		captured.execCalls.length = 0;
		ctx.ui.setStatus.mockClear();

		await vi.advanceTimersByTimeAsync(1_000);
		expect(captured.execCalls.map((call) => call.args)).toEqual([
			["doctor", "--format", "json"],
		]);

		const toolPromise = emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "tsq_change",
				result: { details: { ok: true } },
				isError: false,
			},
			ctx,
		);
		expect(captured.execCalls).toHaveLength(1);

		intervalDoctor.resolve(okEnvelope({ tasks: [] }));
		await toolPromise;

		expect(captured.execCalls.map((call) => call.args)).toEqual([
			...TASQUE_REFRESH_CALL_ARGS,
			...TASQUE_REFRESH_CALL_ARGS,
		]);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"pi-tasque",
			"tsq: coding 2 · planning 1 · mine 1 · 0s",
		);
	});

	it("drops queued refreshes after session_shutdown", async () => {
		vi.useFakeTimers();
		let refreshRun = 0;
		const intervalDoctor = deferred<ReturnType<typeof okEnvelope>>();
		const { pi, captured } = createMockPi();
		captured.execHandler = (_command, args) => {
			const command = args.slice(0, -2).join(" ");
			if (command === "doctor") {
				refreshRun += 1;
				if (refreshRun === 2) {
					return intervalDoctor.promise;
				}
			}
			return okEnvelope({ tasks: [] });
		};
		registerTasqueStatusLifecycle(pi, {
			intervalMs: 1_000,
			now: () => 1_000,
		});
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		captured.execCalls.length = 0;
		ctx.ui.setStatus.mockClear();
		await vi.advanceTimersByTimeAsync(1_000);

		const toolPromise = emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "tsq_change",
				result: { details: { ok: true } },
				isError: false,
			},
			ctx,
		);
		await emitPiEvent(
			captured,
			"session_shutdown",
			{ type: "session_shutdown" },
			ctx,
		);

		intervalDoctor.resolve(okEnvelope({ tasks: [] }));
		await toolPromise;

		expect(captured.execCalls.map((call) => call.args)).toEqual(
			TASQUE_REFRESH_CALL_ARGS,
		);
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(1);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tasque", undefined);
	});

	it("clears interval and footer status on session_shutdown", async () => {
		vi.useFakeTimers();
		const { pi, captured } = createMockPi();
		captured.execHandler = () => okEnvelope({ tasks: [] });
		registerTasqueStatusLifecycle(pi, {
			intervalMs: 1_000,
			now: () => 1_000,
		});
		const ctx = uiContext();

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		captured.execCalls.length = 0;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(captured.execCalls).toHaveLength(4);
		captured.execCalls.length = 0;

		await emitPiEvent(
			captured,
			"session_shutdown",
			{ type: "session_shutdown" },
			ctx,
		);
		await vi.advanceTimersByTimeAsync(5_000);

		expect(captured.execCalls).toEqual([]);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-tasque", undefined);
	});
});
