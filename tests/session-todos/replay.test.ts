import { describe, expect, it } from "vitest";
import type { Task, TaskDetails } from "../../src/session-todos/tool/types.js";
import { replayFromBranch } from "../../src/session-todos/state/replay.js";
import { deriveTaskLinks } from "../../src/bridge/link-store.js";

function task(id: number, subject: string): Task {
	return { id, subject, status: "pending" };
}

function toolResult(toolName: string, details: unknown): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			details,
		},
	};
}

function todoResult(details: unknown): unknown {
	return toolResult("todo", details);
}

function bridgeLinkResult(todoId: number, tsqId: string): unknown {
	return toolResult("task", {
		ok: true,
		data: {
			action: "link",
			link: {
				todoId,
				todoSubject: "Replay link",
				todoStatus: "pending",
				tsqId,
			},
		},
	});
}

function bridgeSnapshotResult(
	action: "promote_todo" | "import_tsq",
	snapshot: Pick<TaskDetails, "tasks" | "nextId">,
): unknown {
	return toolResult("task", {
		ok: true,
		data: {
			action,
			todoSnapshot: snapshot,
		},
	});
}

function claimTodoResult(todo: Task, tsqId = "tsq-claim"): unknown {
	return toolResult("task", {
		ok: true,
		data: {
			id: tsqId,
			assignee: "pi",
			start: true,
			requireSpec: false,
			createTodo: true,
			argv: ["claim", tsqId, "--assignee=pi", "--start"],
			claimResult: { task: { id: tsqId } },
			todo,
		},
	});
}

function replay(branch: Iterable<unknown>) {
	return replayFromBranch({
		sessionManager: {
			getBranch: () => branch,
		},
	});
}

describe("replayFromBranch", () => {
	it("returns empty todo state when the branch has no todo tool results", () => {
		const state = replay([
			{ type: "message", message: { role: "user", content: "hi" } },
			{
				type: "message",
				message: { role: "toolResult", toolName: "other", details: {} },
			},
		]);

		expect(state).toEqual({ tasks: [], nextId: 1 });
	});

	it("uses the last compatible todo snapshot", () => {
		const first: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "old")],
			nextId: 2,
		};
		const last: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "old"), task(2, "new")],
			nextId: 3,
		};

		const state = replay([todoResult(first), todoResult(last)]);

		expect(state.tasks.map((t) => t.subject)).toEqual(["old", "new"]);
		expect(state.nextId).toBe(3);
	});

	it("ignores malformed todo details and keeps the latest compatible snapshot", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};

		const state = replay([
			todoResult({ tasks: "not-an-array", nextId: 99 }),
			todoResult(good),
			todoResult({ tasks: [], nextId: "3" }),
		]);

		expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
	});

	it("skips malformed latest snapshots after a compatible snapshot", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};

		for (const malformed of [
			{ tasks: [], nextId: Number.NaN },
			{ tasks: [], nextId: Number.POSITIVE_INFINITY },
			{ tasks: [], nextId: 0 },
			{
				tasks: [{ id: Number.NaN, subject: "bad", status: "pending" }],
				nextId: 3,
			},
			{ tasks: [{ id: 0, subject: "bad", status: "pending" }], nextId: 3 },
			{ tasks: [{ id: 2, subject: "bad", status: "unknown" }], nextId: 3 },
			{ tasks: [{ id: 2, subject: "", status: "pending" }], nextId: 3 },
			{
				tasks: [
					{
						id: 2,
						subject: "bad",
						status: "pending",
						blockedBy: [1, Number.NaN],
					},
				],
				nextId: 3,
			},
			{
				tasks: [{ id: 2, subject: "bad", status: "pending", metadata: [] }],
				nextId: 3,
			},
		]) {
			const state = replay([todoResult(good), todoResult(malformed)]);

			expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
		}
	});

	it("skips latest snapshots with duplicate task ids after a compatible snapshot", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};
		const duplicateIds = {
			tasks: [task(2, "duplicate A"), task(2, "duplicate B")],
			nextId: 3,
		};

		const state = replay([todoResult(good), todoResult(duplicateIds)]);

		expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
	});

	it("skips latest snapshots with nextId less than or equal to the max task id", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};
		const staleNextId = {
			tasks: [task(1, "old"), task(2, "new")],
			nextId: 2,
		};

		const state = replay([todoResult(good), todoResult(staleNextId)]);

		expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
	});

	it("skips snapshots with missing, deleted, or self blockedBy references", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};

		for (const invalidBlockers of [
			{ tasks: [{ ...task(1, "blocked"), blockedBy: [99] }], nextId: 2 },
			{
				tasks: [
					{ ...task(1, "deleted blocker"), status: "deleted" },
					{ ...task(2, "blocked"), blockedBy: [1] },
				],
				nextId: 3,
			},
			{ tasks: [{ ...task(1, "self blocked"), blockedBy: [1] }], nextId: 2 },
		]) {
			const state = replay([todoResult(good), todoResult(invalidBlockers)]);

			expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
		}
	});

	it("skips snapshots with blockedBy cycles", () => {
		const good: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "kept")],
			nextId: 2,
		};
		const cyclic = {
			tasks: [
				{ ...task(1, "A"), blockedBy: [2] },
				{ ...task(2, "B"), blockedBy: [1] },
			],
			nextId: 3,
		};

		const state = replay([todoResult(good), todoResult(cyclic)]);

		expect(state).toEqual({ tasks: [task(1, "kept")], nextId: 2 });
	});

	it("replays successful task link results onto current todo state", () => {
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Replay link")],
			nextId: 2,
		};

		const state = replay([todoResult(created), bridgeLinkResult(1, "tsq-349")]);

		expect(state.tasks[0]?.metadata).toEqual({ tsqId: "tsq-349" });
		expect(deriveTaskLinks(state)).toEqual([
			{
				todoId: 1,
				todoSubject: "Replay link",
				todoStatus: "pending",
				tsqId: "tsq-349",
			},
		]);
	});

	it("ignores malformed task link replay details", () => {
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Replay link")],
			nextId: 2,
		};

		const state = replay([
			todoResult(created),
			toolResult("task", { ok: false, data: { action: "link" } }),
			toolResult("task", {
				ok: true,
				data: { action: "link", link: { todoId: 1, tsqId: " " } },
			}),
			toolResult("task", {
				ok: true,
				data: { action: "link", link: { todoId: 99, tsqId: "tsq-missing" } },
			}),
		]);

		expect(state).toEqual({ tasks: [task(1, "Replay link")], nextId: 2 });
		expect(deriveTaskLinks(state)).toEqual([]);
	});

	it("replays successful task promote todo snapshots", () => {
		const promotedAt = "2026-05-15T00:00:00.000Z";
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Promote replay")],
			nextId: 2,
		};
		const promoted = {
			tasks: [
				{
					...task(1, "Promote replay"),
					status: "completed" as const,
					metadata: {
						tsqId: "tsq-promoted",
						promotedAt,
						promotedBy: "developer",
					},
				},
			],
			nextId: 2,
		};

		const state = replay([
			todoResult(created),
			bridgeSnapshotResult("promote_todo", promoted),
		]);

		expect(state.tasks[0]).toMatchObject({
			id: 1,
			status: "completed",
			metadata: {
				tsqId: "tsq-promoted",
				promotedAt,
				promotedBy: "developer",
			},
		});
	});

	it("replays successful task import todo snapshots", () => {
		const imported = {
			tasks: [
				{
					...task(1, "Work on tsq-blocker: Blocker"),
					metadata: { tsqId: "tsq-blocker" },
				},
				{
					...task(2, "Work on tsq-imported: Imported"),
					blockedBy: [1],
					metadata: { tsqId: "tsq-imported" },
				},
			],
			nextId: 3,
		};

		const state = replay([bridgeSnapshotResult("import_tsq", imported)]);

		expect(state.tasks.find((todo) => todo.id === 2)).toMatchObject({
			subject: "Work on tsq-imported: Imported",
			blockedBy: [1],
			metadata: { tsqId: "tsq-imported" },
		});
	});

	it("ignores failed or malformed task mutation snapshots", () => {
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Kept")],
			nextId: 2,
		};

		const state = replay([
			todoResult(created),
			toolResult("task", {
				ok: false,
				data: {
					action: "promote_todo",
					todoSnapshot: {
						tasks: [{ ...task(1, "Bad"), status: "completed" }],
						nextId: 2,
					},
				},
			}),
			toolResult("task", {
				ok: true,
				data: {
					action: "import_tsq",
					todoSnapshot: { tasks: [{ ...task(99, "Bad") }], nextId: 2 },
				},
			}),
		]);

		expect(state).toEqual({ tasks: [task(1, "Kept")], nextId: 2 });
	});

	it("replays successful task claim-created todo results onto current todo state", () => {
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Existing")],
			nextId: 2,
		};
		const claimedTodo: Task = {
			id: 2,
			subject: "Work on tsq-claim: Durable work",
			status: "pending",
			metadata: { tsqId: "tsq-claim" },
		};

		const state = replay([todoResult(created), claimTodoResult(claimedTodo)]);

		expect(state).toEqual({
			tasks: [task(1, "Existing"), claimedTodo],
			nextId: 3,
		});
		expect(deriveTaskLinks(state)).toContainEqual({
			todoId: 2,
			todoSubject: "Work on tsq-claim: Durable work",
			todoStatus: "pending",
			tsqId: "tsq-claim",
		});
	});

	it("ignores malformed task claim-created todo replay details", () => {
		const created: TaskDetails = {
			action: "create",
			params: {},
			tasks: [task(1, "Existing")],
			nextId: 2,
		};

		const state = replay([
			todoResult(created),
			toolResult("task", { ok: false, data: { createTodo: true } }),
			toolResult("task", { ok: true, data: { createTodo: false } }),
			toolResult("task", {
				ok: true,
				data: { id: "tsq-bad", createTodo: true, todo: task(1, "Duplicate") },
			}),
			toolResult("task", {
				ok: true,
				data: { id: " ", createTodo: true, todo: task(2, "No tsq id") },
			}),
		]);

		expect(state).toEqual({ tasks: [task(1, "Existing")], nextId: 2 });
		expect(deriveTaskLinks(state)).toEqual([]);
	});

	it("clones replayed tasks instead of returning fixture references", () => {
		const fixture: Task = {
			...task(1, "original"),
			blockedBy: [2],
			metadata: {
				tsqId: "tsq-1",
				nested: { source: "fixture" },
				steps: [{ label: "start" }],
			},
		};
		const details: TaskDetails = {
			action: "create",
			params: {},
			tasks: [fixture, task(2, "blocker")],
			nextId: 3,
		};

		const state = replay([todoResult(details)]);

		expect(state.tasks[0]).toEqual(fixture);
		expect(state.tasks[0]).not.toBe(fixture);
		expect(state.tasks[0]?.blockedBy).not.toBe(fixture.blockedBy);
		expect(state.tasks[0]?.metadata).not.toBe(fixture.metadata);
		expect(state.tasks[0]?.metadata?.nested).not.toBe(fixture.metadata?.nested);
		expect(state.tasks[0]?.metadata?.steps).not.toBe(fixture.metadata?.steps);

		(state.tasks[0]?.metadata?.nested as
			| { source: string }
			| undefined)!.source = "state";
		(state.tasks[0]?.metadata?.steps as
			| { label: string }[]
			| undefined)![0]!.label = "state";
		(fixture.metadata!.nested as { source: string }).source = "fixture-mutated";
		(fixture.metadata!.steps as { label: string }[])[0]!.label =
			"fixture-mutated";

		expect(state.tasks[0]?.metadata).toMatchObject({
			nested: { source: "state" },
			steps: [{ label: "state" }],
		});
		expect(fixture.metadata).toMatchObject({
			nested: { source: "fixture-mutated" },
			steps: [{ label: "fixture-mutated" }],
		});
	});
});
