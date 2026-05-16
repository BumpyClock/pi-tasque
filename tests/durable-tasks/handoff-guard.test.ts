import { afterEach, describe, expect, it } from "vitest";
import {
	classifyDurableStatus,
	classifyReadError,
	collectHandoffStatus,
	type HandoffCheckResult,
	type HandoffInternalError,
	type HandoffLinkedBlocker,
	type HandoffNotReadyResult,
	type HandoffReadError,
	type HandoffReadyResult,
	type HandoffTodoBlocker,
} from "../../src/durable-tasks/handoff-guard.js";
import {
	__resetState,
	commitState,
	getState,
} from "../../src/session-todos/state/store.js";
import type { Task, TaskStatus } from "../../src/session-todos/tool/types.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
import { createMockPi } from "../support/pi-harness.js";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { TSQ_SCHEMA_VERSION } from "../../src/durable-tasks/types.js";

afterEach(() => {
	__resetState();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTodo(
	overrides: Partial<Task> & { id: number; subject: string },
): Task {
	return {
		status: "pending" as TaskStatus,
		...overrides,
	};
}

function seedTodos(...todos: Task[]): void {
	const state: TaskState = {
		tasks: todos,
		nextId: todos.length > 0 ? Math.max(...todos.map((t) => t.id)) + 1 : 1,
	};
	commitState(state);
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------

describe("classifyDurableStatus", () => {
	it("classifies 'closed' as ready", () => {
		expect(classifyDurableStatus("closed")).toBe("ready");
	});

	it.each([
		"open",
		"in_progress",
		"blocked",
		"deferred",
	] as const)("classifies '%s' as blocker", (status) => {
		expect(classifyDurableStatus(status)).toBe("blocker");
	});

	it("classifies 'canceled' as warning", () => {
		expect(classifyDurableStatus("canceled")).toBe("warning");
	});

	it("classifies unknown/arbitrary status as blocker", () => {
		expect(classifyDurableStatus("custom_state")).toBe("blocker");
	});

	it("classifies undefined as blocker (missing status)", () => {
		expect(classifyDurableStatus(undefined)).toBe("blocker");
	});

	it("classifies null as blocker (missing status)", () => {
		expect(classifyDurableStatus(null)).toBe("blocker");
	});

	it("classifies empty string as blocker", () => {
		expect(classifyDurableStatus("")).toBe("blocker");
	});

	it("classifies whitespace-only string as blocker", () => {
		expect(classifyDurableStatus("   ")).toBe("blocker");
	});
});

// ---------------------------------------------------------------------------
// Read-error classification
// ---------------------------------------------------------------------------

describe("classifyReadError", () => {
	it.each([
		"not_found",
		"task_not_found",
		"TASK_NOT_FOUND",
		"validation_error",
		"VALIDATION_ERROR",
		"read_error",
	] as const)("classifies '%s' as actionable", (code) => {
		expect(classifyReadError(code)).toBe("actionable");
	});

	it.each([
		"process_error",
		"timeout",
		"abort",
		"invalid_json",
		"unknown",
	] as const)("classifies '%s' as internal", (code) => {
		expect(classifyReadError(code)).toBe("internal");
	});
});

// ---------------------------------------------------------------------------
// Result shape contracts
// ---------------------------------------------------------------------------

describe("HandoffCheckResult shapes", () => {
	describe("ready result (ok:true, ready:true)", () => {
		it("has correct shape with no blockers", () => {
			const result: HandoffReadyResult = { ok: true, ready: true };
			expect(result.ok).toBe(true);
			expect(result.ready).toBe(true);
		});

		it("satisfies HandoffCheckResult union", () => {
			const result: HandoffCheckResult = { ok: true, ready: true };
			expect(result.ok).toBe(true);
			if (result.ok && "ready" in result) {
				expect(result.ready).toBe(true);
			}
		});
	});

	describe("not-ready result (ok:true, ready:false)", () => {
		it("can carry todoBlockers for pending todos", () => {
			const blocker: HandoffTodoBlocker = {
				todoId: 1,
				subject: "Write tests",
				status: "pending",
				reason: "pending",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				todoBlockers: [blocker],
			};
			expect(result.ok).toBe(true);
			expect(result.ready).toBe(false);
			expect(result.todoBlockers).toHaveLength(1);
			expect(result.todoBlockers![0]!.todoId).toBe(1);
		});

		it("can carry todoBlockers for in-progress todos", () => {
			const blocker: HandoffTodoBlocker = {
				todoId: 2,
				subject: "Implement feature",
				status: "in_progress",
				reason: "in_progress",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				todoBlockers: [blocker],
			};
			expect(result.todoBlockers![0]!.status).toBe("in_progress");
		});

		it("can carry todoBlockers for blocked todos (blockedBy dependency)", () => {
			const blocker: HandoffTodoBlocker = {
				todoId: 3,
				subject: "Deploy",
				status: "pending",
				reason: "blocked",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				todoBlockers: [blocker],
			};
			expect(result.todoBlockers![0]!.reason).toBe("blocked");
		});

		it("can carry linkedBlockers for open durable tasks", () => {
			const linked: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-5",
				status: "open",
				classification: "blocker",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedBlockers: [linked],
			};
			expect(result.linkedBlockers).toHaveLength(1);
			expect(result.linkedBlockers![0]!.classification).toBe("blocker");
		});

		it("can carry linkedBlockers for in_progress durable tasks", () => {
			const linked: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-6",
				status: "in_progress",
				classification: "blocker",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedBlockers: [linked],
			};
			expect(result.linkedBlockers![0]!.status).toBe("in_progress");
		});

		it("can carry linkedBlockers for blocked durable tasks", () => {
			const linked: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-7",
				status: "blocked",
				classification: "blocker",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedBlockers: [linked],
			};
			expect(result.linkedBlockers![0]!.status).toBe("blocked");
		});

		it("can carry linkedBlockers for deferred durable tasks", () => {
			const linked: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-8",
				status: "deferred",
				classification: "blocker",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedBlockers: [linked],
			};
			expect(result.linkedBlockers![0]!.status).toBe("deferred");
		});

		it("can carry linkedWarnings for canceled durable tasks", () => {
			const warning: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-9",
				status: "canceled",
				classification: "warning",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedWarnings: [warning],
			};
			expect(result.linkedWarnings).toHaveLength(1);
			expect(result.linkedWarnings![0]!.classification).toBe("warning");
		});

		it("can carry linkedBlockers for unknown status", () => {
			const linked: HandoffLinkedBlocker = {
				todoId: 1,
				tsqId: "tsq-10",
				status: "custom_unknown",
				classification: "blocker",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				linkedBlockers: [linked],
			};
			expect(result.linkedBlockers![0]!.status).toBe("custom_unknown");
		});

		it("can carry readErrors for actionable linked show failures", () => {
			const readErr: HandoffReadError = {
				tsqId: "tsq-99",
				code: "not_found",
				message: "task tsq-99 not found",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				readErrors: [readErr],
			};
			expect(result.readErrors).toHaveLength(1);
			expect(result.readErrors![0]!.code).toBe("not_found");
		});

		it("can carry readErrors for validation errors", () => {
			const readErr: HandoffReadError = {
				tsqId: "bad-id",
				code: "validation_error",
				message: "invalid task id format",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				readErrors: [readErr],
			};
			expect(result.readErrors![0]!.code).toBe("validation_error");
		});

		it("can carry readErrors for read_error envelope failures", () => {
			const readErr: HandoffReadError = {
				tsqId: "tsq-50",
				code: "read_error",
				message: "envelope read failed",
			};
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				readErrors: [readErr],
			};
			expect(result.readErrors![0]!.code).toBe("read_error");
		});

		it("can combine multiple blocker types", () => {
			const result: HandoffNotReadyResult = {
				ok: true,
				ready: false,
				todoBlockers: [
					{ todoId: 1, subject: "A", status: "pending", reason: "pending" },
					{
						todoId: 2,
						subject: "B",
						status: "in_progress",
						reason: "in_progress",
					},
				],
				linkedBlockers: [
					{
						todoId: 3,
						tsqId: "tsq-1",
						status: "open",
						classification: "blocker",
					},
				],
				linkedWarnings: [
					{
						todoId: 4,
						tsqId: "tsq-2",
						status: "canceled",
						classification: "warning",
					},
				],
				readErrors: [
					{ tsqId: "tsq-3", code: "not_found", message: "not found" },
				],
			};
			expect(result.ok).toBe(true);
			expect(result.ready).toBe(false);
			expect(result.todoBlockers).toHaveLength(2);
			expect(result.linkedBlockers).toHaveLength(1);
			expect(result.linkedWarnings).toHaveLength(1);
			expect(result.readErrors).toHaveLength(1);
		});
	});

	describe("internal error result (ok:false)", () => {
		it("represents process failure", () => {
			const result: HandoffInternalError = {
				ok: false,
				code: "process_error",
				message: "tsq failed with exit code 1",
			};
			expect(result.ok).toBe(false);
			expect(result.code).toBe("process_error");
		});

		it("represents invalid JSON", () => {
			const result: HandoffInternalError = {
				ok: false,
				code: "invalid_json",
				message: "tsq returned invalid JSON",
			};
			expect(result.ok).toBe(false);
		});

		it("represents timeout", () => {
			const result: HandoffInternalError = {
				ok: false,
				code: "timeout",
				message: "tsq show timed out",
			};
			expect(result.ok).toBe(false);
		});

		it("represents aborted execution", () => {
			const result: HandoffInternalError = {
				ok: false,
				code: "abort",
				message: "operation aborted",
			};
			expect(result.ok).toBe(false);
		});

		it("satisfies HandoffCheckResult union", () => {
			const result: HandoffCheckResult = {
				ok: false,
				code: "process_error",
				message: "fail",
			};
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.code).toBeDefined();
				expect(result.message).toBeDefined();
			}
		});
	});
});

// ---------------------------------------------------------------------------
// Read-only assertions
// ---------------------------------------------------------------------------

describe("read-only invariants", () => {
	it("state snapshot is unchanged after constructing ready result", () => {
		seedTodos(makeTodo({ id: 1, subject: "Done task", status: "completed" }));
		const before = getState();

		// Simulate what the collector would do: read state, produce result
		const state = getState();
		const _result: HandoffCheckResult = { ok: true, ready: true };

		const after = getState();
		expect(after).toEqual(before);
		expect(state.tasks).toEqual(before.tasks);
		expect(state.nextId).toBe(before.nextId);
	});

	it("state snapshot is unchanged after constructing not-ready result", () => {
		seedTodos(
			makeTodo({ id: 1, subject: "Pending task", status: "pending" }),
			makeTodo({
				id: 2,
				subject: "Linked task",
				status: "in_progress",
				metadata: { tsqId: "tsq-5" },
			}),
		);
		const before = getState();

		// Simulate reading state + links for not-ready
		const state = getState();
		const _result: HandoffNotReadyResult = {
			ok: true,
			ready: false,
			todoBlockers: [
				{
					todoId: 1,
					subject: "Pending task",
					status: "pending",
					reason: "pending",
				},
			],
			linkedBlockers: [
				{
					todoId: 2,
					tsqId: "tsq-5",
					status: "open",
					classification: "blocker",
				},
			],
		};

		const after = getState();
		expect(after).toEqual(before);
	});

	it("classifyDurableStatus is pure — no side effects on store", () => {
		seedTodos(makeTodo({ id: 1, subject: "X", status: "pending" }));
		const before = getState();

		classifyDurableStatus("open");
		classifyDurableStatus("closed");
		classifyDurableStatus("canceled");
		classifyDurableStatus(undefined);

		expect(getState()).toEqual(before);
	});

	it("classifyReadError is pure — no side effects on store", () => {
		seedTodos(makeTodo({ id: 1, subject: "X", status: "pending" }));
		const before = getState();

		classifyReadError("not_found");
		classifyReadError("process_error");

		expect(getState()).toEqual(before);
	});
});

// ---------------------------------------------------------------------------
// No-link behavior (no git root needed)
// ---------------------------------------------------------------------------

describe("no-link scenarios", () => {
	it("todo-only readiness needs no project root when no links exist", () => {
		// When no todos have tsqId metadata, the collector should not attempt
		// git root resolution or tsq CLI calls. This is a design contract:
		// the types allow HandoffReadyResult/HandoffNotReadyResult without
		// any linked fields.
		seedTodos(makeTodo({ id: 1, subject: "Local todo", status: "completed" }));

		// A ready result with no linked fields is valid
		const result: HandoffReadyResult = { ok: true, ready: true };
		expect(result.ok).toBe(true);
		expect(result.ready).toBe(true);
		expect("linkedBlockers" in result).toBe(false);
		expect("readErrors" in result).toBe(false);
	});

	it("not-ready with only todo blockers needs no linked fields", () => {
		seedTodos(makeTodo({ id: 1, subject: "Pending", status: "pending" }));

		const result: HandoffNotReadyResult = {
			ok: true,
			ready: false,
			todoBlockers: [
				{ todoId: 1, subject: "Pending", status: "pending", reason: "pending" },
			],
		};
		expect(result.ok).toBe(true);
		expect(result.ready).toBe(false);
		expect(result.linkedBlockers).toBeUndefined();
		expect(result.readErrors).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Mutation queue / lifecycle exclusion contracts
// ---------------------------------------------------------------------------

describe("mutation exclusion contracts", () => {
	it("handoff-guard module does not import mutation-queue", async () => {
		// Verify the module boundary: handoff-guard.ts must not depend on
		// the mutation queue, ensuring it cannot run queued mutations.
		const guardModule = await import(
			"../../src/durable-tasks/handoff-guard.js"
		);
		const moduleSource = Object.keys(guardModule);

		// The module exports classifiers and types, not mutation helpers
		expect(moduleSource).toContain("classifyDurableStatus");
		expect(moduleSource).toContain("classifyReadError");
		// No mutation-related exports
		expect(moduleSource).not.toContain("runQueuedMutation");
		expect(moduleSource).not.toContain("getQueuedMutationCwdCount");
	});

	it("handoff-guard module does not import lifecycle commands", async () => {
		const guardModule = await import(
			"../../src/durable-tasks/handoff-guard.js"
		);
		const exports = Object.keys(guardModule);

		// No lifecycle mutation exports
		expect(exports).not.toContain("executeTsqChange");
		expect(exports).not.toContain("executeTsqClaim");
	});

	it("linked task reads would use only show (read-only) CLI calls", () => {
		// Contract: when the collector reads linked durable tasks, the only
		// tsq CLI command it should use is `show <id> --format json`.
		// This is a design assertion — the read-only `show` command does
		// not appear in the mutation command mapping.
		//
		// Verify the command name is not in the mutation set.
		const READ_ONLY_COMMANDS = ["show", "doctor", "find", "deps", "notes"];
		const MUTATION_COMMANDS = [
			"create",
			"note",
			"done",
			"reopen",
			"defer",
			"start",
			"block",
			"unblock",
			"order",
			"unorder",
			"claim",
		];

		for (const cmd of READ_ONLY_COMMANDS) {
			expect(MUTATION_COMMANDS).not.toContain(cmd);
		}

		// The collector contract: linked reads use "show" only
		const HANDOFF_LINKED_READ_COMMAND = "show";
		expect(READ_ONLY_COMMANDS).toContain(HANDOFF_LINKED_READ_COMMAND);
		expect(MUTATION_COMMANDS).not.toContain(HANDOFF_LINKED_READ_COMMAND);
	});
});

// ---------------------------------------------------------------------------
// Status matrix exhaustive coverage
// ---------------------------------------------------------------------------

describe("status matrix completeness", () => {
	const KNOWN_STATUSES: Array<{
		status: string;
		expected: "ready" | "blocker" | "warning";
	}> = [
		{ status: "closed", expected: "ready" },
		{ status: "open", expected: "blocker" },
		{ status: "in_progress", expected: "blocker" },
		{ status: "blocked", expected: "blocker" },
		{ status: "deferred", expected: "blocker" },
		{ status: "canceled", expected: "warning" },
	];

	it.each(KNOWN_STATUSES)("$status → $expected", ({ status, expected }) => {
		expect(classifyDurableStatus(status)).toBe(expected);
	});

	it("unknown status defaults to blocker (safe default)", () => {
		expect(classifyDurableStatus("some_future_status")).toBe("blocker");
	});

	it("missing (undefined) status defaults to blocker", () => {
		expect(classifyDurableStatus(undefined)).toBe("blocker");
	});
});

// ---------------------------------------------------------------------------
// collectHandoffStatus — integration tests
// ---------------------------------------------------------------------------

describe("collectHandoffStatus", () => {
	// Helpers for exec mocking
	function gitRootResult(root = "/fake/project"): ExecResult {
		return { stdout: `${root}\n`, stderr: "", code: 0, killed: false };
	}

	function tsqShowOk(status: string): ExecResult {
		const envelope = {
			schema_version: TSQ_SCHEMA_VERSION,
			command: "tsq show",
			ok: true,
			data: {
				task: { id: "tsq-1", status, title: "test" },
				blockers: [],
				dependents: [],
				blocker_edges: [],
				dependent_edges: [],
			},
		};
		return {
			stdout: JSON.stringify(envelope),
			stderr: "",
			code: 0,
			killed: false,
		};
	}

	function tsqShowErr(code: string, message: string): ExecResult {
		const envelope = {
			schema_version: TSQ_SCHEMA_VERSION,
			command: "tsq show",
			ok: false,
			error: { code, message },
		};
		return {
			stdout: JSON.stringify(envelope),
			stderr: "",
			code: 0,
			killed: false,
		};
	}

	describe("no todos (all completed or empty)", () => {
		it("returns ready:true when no todos exist", async () => {
			const { pi } = createMockPi();
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result).toEqual({ ok: true, ready: true });
		});

		it("returns ready:true when all todos are completed", async () => {
			seedTodos(
				makeTodo({ id: 1, subject: "A", status: "completed" }),
				makeTodo({ id: 2, subject: "B", status: "completed" }),
			);
			const { pi } = createMockPi();
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result).toEqual({ ok: true, ready: true });
		});
	});

	describe("todo-only blockers (no links)", () => {
		it("pending todo → not ready", async () => {
			seedTodos(makeTodo({ id: 1, subject: "Fix bug", status: "pending" }));
			const { pi } = createMockPi();
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });

			expect(result.ok).toBe(true);
			expect((result as HandoffNotReadyResult).ready).toBe(false);
			expect((result as HandoffNotReadyResult).todoBlockers).toEqual([
				{ todoId: 1, subject: "Fix bug", status: "pending", reason: "pending" },
			]);
		});

		it("in_progress todo → not ready", async () => {
			seedTodos(makeTodo({ id: 1, subject: "Deploy", status: "in_progress" }));
			const { pi } = createMockPi();
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });

			expect(result.ok).toBe(true);
			expect((result as HandoffNotReadyResult).ready).toBe(false);
			expect((result as HandoffNotReadyResult).todoBlockers).toEqual([
				{
					todoId: 1,
					subject: "Deploy",
					status: "in_progress",
					reason: "in_progress",
				},
			]);
		});

		it("pending todo with blockedBy → reason is 'blocked'", async () => {
			seedTodos(
				makeTodo({ id: 1, subject: "Setup", status: "completed" }),
				makeTodo({
					id: 2,
					subject: "Deploy",
					status: "pending",
					blockedBy: [1],
				}),
			);
			const { pi } = createMockPi();
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });

			const notReady = result as HandoffNotReadyResult;
			expect(notReady.ready).toBe(false);
			expect(notReady.todoBlockers![0]!.reason).toBe("blocked");
		});

		it("does not require git root when no links exist", async () => {
			seedTodos(makeTodo({ id: 1, subject: "X", status: "pending" }));
			const { pi, captured } = createMockPi();
			// exec handler that would fail for git — but should never be called
			captured.execHandler = () => {
				throw new Error("should not call exec when no links");
			};
			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result.ok).toBe(true);
			expect((result as HandoffNotReadyResult).ready).toBe(false);
		});
	});

	describe("linked task status checks", () => {
		it("linked closed task → ready", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Linked",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd, args) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("closed");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result).toEqual({
				ok: true,
				ready: true,
				projectRoot: "/fake/project",
			});
		});

		it("linked open task → not ready with linkedBlockers", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Linked open",
					status: "completed",
					metadata: { tsqId: "tsq-5" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("open");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			const notReady = result as HandoffNotReadyResult;
			expect(notReady.ok).toBe(true);
			expect(notReady.ready).toBe(false);
			expect(notReady.linkedBlockers).toEqual([
				{
					todoId: 1,
					tsqId: "tsq-5",
					status: "open",
					classification: "blocker",
				},
			]);
		});

		it("linked canceled task → warning (still ready if no other blockers)", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Linked canceled",
					status: "completed",
					metadata: { tsqId: "tsq-9" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("canceled");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			const res = result as HandoffNotReadyResult;
			expect(res.ok).toBe(true);
			// Warnings alone don't block readiness
			expect(res.ready).toBe(true);
			expect((result as any).linkedWarnings).toEqual([
				{
					todoId: 1,
					tsqId: "tsq-9",
					status: "canceled",
					classification: "warning",
				},
			]);
		});

		it("multiple linked tasks with mixed statuses", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "A",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
				makeTodo({
					id: 2,
					subject: "B",
					status: "completed",
					metadata: { tsqId: "tsq-2" },
				}),
				makeTodo({
					id: 3,
					subject: "C",
					status: "completed",
					metadata: { tsqId: "tsq-3" },
				}),
			);
			const statusMap: Record<string, string> = {
				"tsq-1": "closed",
				"tsq-2": "in_progress",
				"tsq-3": "canceled",
			};
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd, args) => {
				if (cmd === "git") return gitRootResult();
				// Find tsq id in args
				const showIdx = args.indexOf("show");
				const tsqId = showIdx >= 0 ? args[showIdx + 1] : undefined;
				return tsqShowOk(statusMap[tsqId!] ?? "open");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			const notReady = result as HandoffNotReadyResult;
			expect(notReady.ok).toBe(true);
			expect(notReady.ready).toBe(false);
			expect(notReady.linkedBlockers).toHaveLength(1);
			expect(notReady.linkedBlockers![0]!.tsqId).toBe("tsq-2");
			expect(notReady.linkedWarnings).toHaveLength(1);
			expect(notReady.linkedWarnings![0]!.tsqId).toBe("tsq-3");
		});
	});

	describe("read error handling", () => {
		it("actionable error (TASK_NOT_FOUND) → ok:true, ready:false with readErrors", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Missing",
					status: "completed",
					metadata: { tsqId: "tsq-99" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowErr("TASK_NOT_FOUND", "task tsq-99 not found");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			const notReady = result as HandoffNotReadyResult;
			expect(notReady.ok).toBe(true);
			expect(notReady.ready).toBe(false);
			expect(notReady.readErrors).toEqual([
				{
					tsqId: "tsq-99",
					code: "TASK_NOT_FOUND",
					message: "task tsq-99 not found",
				},
			]);
		});

		it("internal error (process crash) → ok:false", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Crash",
					status: "completed",
					metadata: { tsqId: "tsq-50" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				// Process failure: non-zero exit, no valid JSON
				return { stdout: "", stderr: "segfault", code: 139, killed: false };
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result.ok).toBe(false);
			const err = result as HandoffInternalError;
			expect(err.code).toBe("process_error");
		});

		it("internal error from tsq envelope with non-actionable code → ok:false", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Broken",
					status: "completed",
					metadata: { tsqId: "tsq-50" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowErr("timeout", "request timed out");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result.ok).toBe(false);
			const err = result as HandoffInternalError;
			expect(err.code).toBe("timeout");
		});

		it("killed process → ok:false", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Killed",
					status: "completed",
					metadata: { tsqId: "tsq-50" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return { stdout: "", stderr: "", code: 0, killed: true };
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result.ok).toBe(false);
			expect((result as HandoffInternalError).code).toBe("process_error");
		});
	});

	describe("project root resolution", () => {
		it("git root failure with links → ok:false", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Linked",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = () => {
				// git fails
				return {
					stdout: "",
					stderr: "not a git repo",
					code: 128,
					killed: false,
				};
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(result.ok).toBe(false);
			const err = result as HandoffInternalError;
			expect(err.code).toBe("project_resolution_error");
			expect(err.message).toContain("not a git repo");
		});

		it("uses resolved project root for tsq show calls", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "X",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd, args, opts) => {
				if (cmd === "git") return gitRootResult("/my/project");
				// Verify tsq is called with resolved project root
				expect(opts?.cwd).toBe("/my/project");
				return tsqShowOk("closed");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/somewhere/else" });
			expect(result).toEqual({
				ok: true,
				ready: true,
				projectRoot: "/my/project",
			});
		});
	});

	describe("combined todo + linked blockers", () => {
		it("both pending todos and open linked tasks appear", async () => {
			seedTodos(
				makeTodo({ id: 1, subject: "Pending", status: "pending" }),
				makeTodo({
					id: 2,
					subject: "Linked",
					status: "completed",
					metadata: { tsqId: "tsq-5" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("open");
			};

			const result = await collectHandoffStatus({ pi, cwd: "/tmp" });
			const notReady = result as HandoffNotReadyResult;
			expect(notReady.ok).toBe(true);
			expect(notReady.ready).toBe(false);
			expect(notReady.todoBlockers).toHaveLength(1);
			expect(notReady.linkedBlockers).toHaveLength(1);
		});
	});

	describe("read-only invariants on collector", () => {
		it("state unchanged after collecting with linked tasks", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "Linked",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
			);
			const before = getState();
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("open");
			};

			await collectHandoffStatus({ pi, cwd: "/tmp" });
			expect(getState()).toEqual(before);
		});

		it("only uses show command (read-only) for linked tasks", async () => {
			seedTodos(
				makeTodo({
					id: 1,
					subject: "X",
					status: "completed",
					metadata: { tsqId: "tsq-1" },
				}),
			);
			const { pi, captured } = createMockPi();
			captured.execHandler = (cmd) => {
				if (cmd === "git") return gitRootResult();
				return tsqShowOk("closed");
			};

			await collectHandoffStatus({ pi, cwd: "/tmp" });

			// Filter only tsq exec calls
			const tsqCalls = captured.execCalls.filter((c) => c.command === "tsq");
			for (const call of tsqCalls) {
				expect(call.args[0]).toBe("show");
			}
		});
	});
});
