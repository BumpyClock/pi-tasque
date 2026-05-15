import { beforeEach, describe, expect, it } from "vitest";
import {
	deriveTaskLinks,
	getTaskLink,
	linkTodoToTsq,
} from "../../src/bridge/link-store.js";
import {
	commitState,
	getState,
	__resetState,
} from "../../src/session-todos/state/store.js";
import { applyTaskMutation } from "../../src/session-todos/state/state-reducer.js";
import type { Task } from "../../src/session-todos/tool/types.js";

function createTodo(
	subject: string,
	overrides: Partial<Omit<Task, "id" | "subject" | "status">> &
		Pick<Partial<Task>, "status"> = {},
): Task {
	const params: Record<string, unknown> = { subject };
	if (overrides.metadata !== undefined) params.metadata = overrides.metadata;
	if (overrides.owner !== undefined) params.owner = overrides.owner;
	if (overrides.description !== undefined)
		params.description = overrides.description;

	const result = applyTaskMutation(getState(), "create", params);
	if (result.op.kind === "error") {
		throw new Error(result.op.message);
	}
	commitState(result.state);

	const created = getState().tasks.find((task) => task.subject === subject);
	if (!created) throw new Error("created todo not found");

	if (overrides.status !== undefined && overrides.status !== "pending") {
		const updated = applyTaskMutation(getState(), "update", {
			id: created.id,
			status: overrides.status,
		});
		if (updated.op.kind === "error") {
			throw new Error(updated.op.message);
		}
		commitState(updated.state);
		const transitioned = getState().tasks.find(
			(task) => task.id === created.id,
		);
		if (!transitioned) throw new Error("updated todo not found");
		return transitioned;
	}

	return created;
}

beforeEach(() => {
	__resetState();
});

describe("linkTodoToTsq", () => {
	it("stores the Tasque id in todo metadata as tsqId", () => {
		const todo = createTodo("Bridge todo");

		const result = linkTodoToTsq(todo.id, "tsq-123");

		expect(result.ok).toBe(true);
		expect(getTaskLink(todo.id)).toEqual({
			todoId: todo.id,
			todoSubject: "Bridge todo",
			todoStatus: "pending",
			tsqId: "tsq-123",
		});
		expect(getState().tasks[0]?.metadata).toEqual({ tsqId: "tsq-123" });
	});

	it("preserves existing todo metadata keys", () => {
		const todo = createTodo("Preserve metadata", {
			metadata: { source: "manual", count: 2 },
		});

		const result = linkTodoToTsq(todo.id, "tsq-456");

		expect(result.ok).toBe(true);
		expect(getState().tasks[0]?.metadata).toEqual({
			source: "manual",
			count: 2,
			tsqId: "tsq-456",
		});
	});

	it("does not change todo status", () => {
		const todo = createTodo("Already started");
		const started = applyTaskMutation(getState(), "update", {
			id: todo.id,
			status: "in_progress",
		});
		if (started.op.kind === "error") throw new Error(started.op.message);
		commitState(started.state);

		const result = linkTodoToTsq(todo.id, "tsq-789");

		expect(result.ok).toBe(true);
		expect(getState().tasks[0]?.status).toBe("in_progress");
	});

	it("rejects missing todos and empty Tasque ids without mutating state", () => {
		createTodo("Keep me");
		const before = getState();

		expect(linkTodoToTsq(99, "tsq-1")).toEqual({
			ok: false,
			message: "todo #99 not found",
		});
		expect(linkTodoToTsq(1, "   ")).toEqual({
			ok: false,
			message: "tsqId is required",
		});
		expect(getState()).toEqual(before);
	});
});

describe("deriveTaskLinks", () => {
	it("returns links derivable from current visible and completed todos", () => {
		const pending = createTodo("Pending link", {
			metadata: { tsqId: "tsq-p" },
		});
		const inProgress = createTodo("Started link", {
			metadata: { tsqId: "tsq-i" },
		});
		const completed = createTodo("Done link", { metadata: { tsqId: "tsq-c" } });
		createTodo("No link");
		const deleted = createTodo("Deleted link", {
			metadata: { tsqId: "tsq-d" },
		});

		let state = getState();
		for (const [id, status] of [
			[inProgress.id, "in_progress"],
			[completed.id, "in_progress"],
			[completed.id, "completed"],
			[deleted.id, "deleted"],
		] as const) {
			const updated = applyTaskMutation(state, "update", { id, status });
			if (updated.op.kind === "error") throw new Error(updated.op.message);
			state = updated.state;
		}
		commitState(state);

		expect(deriveTaskLinks(getState())).toEqual([
			{
				todoId: pending.id,
				todoSubject: "Pending link",
				todoStatus: "pending",
				tsqId: "tsq-p",
			},
			{
				todoId: inProgress.id,
				todoSubject: "Started link",
				todoStatus: "in_progress",
				tsqId: "tsq-i",
			},
			{
				todoId: completed.id,
				todoSubject: "Done link",
				todoStatus: "completed",
				tsqId: "tsq-c",
			},
		]);
	});
});
