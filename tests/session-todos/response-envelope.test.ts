import { describe, expect, it } from "vitest";
import type { Op } from "../../src/session-todos/state/state-reducer.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
import {
	buildToolResult,
	formatContent,
} from "../../src/session-todos/tool/response-envelope.js";
import type { Task } from "../../src/session-todos/tool/types.js";

const task = (
	overrides: Partial<Task> & { id: number; subject: string },
): Task => ({
	status: "pending",
	...overrides,
});

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((candidate) => candidate.id)) + 1,
});

describe("formatContent", () => {
	it("formats create, update, delete, clear, and error operations", () => {
		const state = stateWith(
			task({ id: 1, subject: "alpha" }),
			task({ id: 2, subject: "beta", status: "in_progress" }),
		);

		expect(formatContent({ kind: "create", taskId: 1 }, state)).toBe(
			"Created #1: alpha (pending)",
		);
		expect(
			formatContent(
				{
					kind: "update",
					id: 2,
					fromStatus: "pending",
					toStatus: "in_progress",
				},
				state,
			),
		).toBe("Updated #2 (pending → in_progress)");
		expect(
			formatContent(
				{ kind: "update", id: 1, fromStatus: "pending", toStatus: "pending" },
				state,
			),
		).toBe("Updated #1");
		expect(
			formatContent({ kind: "delete", id: 1, subject: "alpha" }, state),
		).toBe("Deleted #1: alpha");
		expect(formatContent({ kind: "clear", count: 2 }, state)).toBe(
			"Cleared 2 tasks",
		);
		expect(formatContent({ kind: "error", message: "bad input" }, state)).toBe(
			"Error: bad input",
		);
	});

	it("formats list output with filters, deleted visibility, active forms, and blockers", () => {
		const state = stateWith(
			task({ id: 1, subject: "base" }),
			task({
				id: 2,
				subject: "work",
				status: "in_progress",
				activeForm: "Working",
				blockedBy: [1],
			}),
			task({ id: 3, subject: "done", status: "completed" }),
			task({ id: 4, subject: "gone", status: "deleted" }),
		);

		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe(
			"[pending] #1 base\n[in_progress] #2 work (Working) ⛓ #1\n[completed] #3 done",
		);
		expect(
			formatContent(
				{ kind: "list", includeDeleted: false, statusFilter: "in_progress" },
				state,
			),
		).toBe("[in_progress] #2 work (Working) ⛓ #1");
		expect(
			formatContent({ kind: "list", includeDeleted: true }, state),
		).toContain("[deleted] #4 gone");
		expect(
			formatContent(
				{ kind: "list", includeDeleted: false, statusFilter: "deleted" },
				state,
			),
		).toBe("No tasks");
	});

	it("formats get output with details and reverse blockers", () => {
		const state = stateWith(
			task({ id: 1, subject: "root", blockedBy: [2] }),
			task({
				id: 2,
				subject: "leaf",
				description: "details",
				activeForm: "Working",
				status: "in_progress",
				blockedBy: [3],
				owner: "developer",
			}),
			task({ id: 3, subject: "prep" }),
		);

		const op: Op = { kind: "get", task: state.tasks[1]! };

		expect(formatContent(op, state)).toBe(
			"#2 [in_progress] leaf\n  description: details\n  activeForm: Working\n  blockedBy: #3\n  blocks: #1\n  owner: developer",
		);
	});

	it("uses defensive create fallback when task id is missing from state", () => {
		expect(formatContent({ kind: "create", taskId: 99 }, stateWith())).toBe(
			"Created #99",
		);
	});
});

describe("buildToolResult", () => {
	it("builds content and preserves compatible details on success", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const params = { subject: "alpha", metadata: { tsqId: "tsq-1" } };

		expect(
			buildToolResult("create", params, state, { kind: "create", taskId: 1 }),
		).toEqual({
			content: [{ type: "text", text: "Created #1: alpha (pending)" }],
			details: {
				action: "create",
				params,
				tasks: state.tasks,
				nextId: state.nextId,
			},
		});
	});

	it("snapshots params and task state without leaking caller-owned references", () => {
		const state = stateWith(
			task({
				id: 1,
				subject: "alpha",
				blockedBy: [2],
				metadata: { nested: { count: 1 }, labels: ["before"] },
			}),
		);
		const params = {
			subject: "alpha",
			blockedBy: [2],
			metadata: { nested: { count: 1 }, labels: ["before"] },
		};

		const result = buildToolResult("create", params, state, {
			kind: "create",
			taskId: 1,
		});

		state.tasks[0]!.subject = "mutated";
		state.tasks[0]!.blockedBy!.push(99);
		(state.tasks[0]!.metadata!.nested as { count: number }).count = 2;
		(state.tasks[0]!.metadata!.labels as string[]).push("after");
		state.tasks.push(task({ id: 3, subject: "late" }));
		state.nextId = 99;
		params.blockedBy.push(99);
		params.metadata.nested.count = 2;
		params.metadata.labels.push("after");

		expect(result.details).toEqual({
			action: "create",
			params: {
				subject: "alpha",
				blockedBy: [2],
				metadata: { nested: { count: 1 }, labels: ["before"] },
			},
			tasks: [
				{
					id: 1,
					subject: "alpha",
					status: "pending",
					blockedBy: [2],
					metadata: { nested: { count: 1 }, labels: ["before"] },
				},
			],
			nextId: 2,
		});
		expect(result.details.params).not.toBe(params);
		expect(result.details.tasks).not.toBe(state.tasks);
		expect(result.details.tasks[0]).not.toBe(state.tasks[0]);
	});

	it("includes error in details while preserving action, params, tasks, and nextId", () => {
		const state = stateWith();
		const params = { subject: "" };
		const result = buildToolResult("create", params, state, {
			kind: "error",
			message: "subject required for create",
		});

		expect(result).toEqual({
			content: [{ type: "text", text: "Error: subject required for create" }],
			details: {
				action: "create",
				params,
				tasks: [],
				nextId: 1,
				error: "subject required for create",
			},
		});
	});

	it("covers list, get, update, delete, and clear actions in details", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const cases = [
			{
				action: "list" as const,
				params: { status: "pending" as const },
				op: {
					kind: "list" as const,
					includeDeleted: false,
					statusFilter: "pending" as const,
				},
			},
			{
				action: "get" as const,
				params: { id: 1 },
				op: { kind: "get" as const, task: state.tasks[0]! },
			},
			{
				action: "update" as const,
				params: { id: 1, status: "completed" as const },
				op: {
					kind: "update" as const,
					id: 1,
					fromStatus: "pending" as const,
					toStatus: "completed" as const,
				},
			},
			{
				action: "delete" as const,
				params: { id: 1 },
				op: { kind: "delete" as const, id: 1, subject: "alpha" },
			},
			{
				action: "clear" as const,
				params: {},
				op: { kind: "clear" as const, count: 1 },
			},
		];

		for (const item of cases) {
			const result = buildToolResult(item.action, item.params, state, item.op);
			expect(result.details).toMatchObject({
				action: item.action,
				params: item.params,
				tasks: state.tasks,
				nextId: state.nextId,
			});
			expect(result.content[0]?.type).toBe("text");
			expect(result.content[0]?.text.length).toBeGreaterThan(0);
		}
	});
});
