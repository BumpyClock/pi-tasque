import { describe, expect, it } from "vitest";
import type { Task } from "../../src/session-todos/tool/types.js";
import { isTransitionValid } from "../../src/session-todos/state/invariants.js";
import {
	applyTaskMutation,
	type TaskState,
} from "../../src/session-todos/state/state-reducer.js";

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

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

const expectError = (
	result: ReturnType<typeof applyTaskMutation>,
	message: string,
) => {
	expect(result.op).toEqual({ kind: "error", message });
};

describe("applyTaskMutation", () => {
	it("creates pending tasks, increments nextId, and leaves the input state untouched", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "create", {
			subject: "Port reducer",
			description: "Mirror compatible todo behavior",
			owner: "developer",
			metadata: { tsqId: "tsq-1" },
		});

		expect(result.op).toEqual({ kind: "create", taskId: 1 });
		expect(result.state).toEqual({
			tasks: [
				{
					id: 1,
					subject: "Port reducer",
					description: "Mirror compatible todo behavior",
					status: "pending",
					owner: "developer",
					metadata: { tsqId: "tsq-1" },
				},
			],
			nextId: 2,
		});
		expect(state).toEqual(emptyState());
		expect(result.state.tasks).not.toBe(state.tasks);
	});

	it("rejects creates with missing subject", () => {
		expectError(
			applyTaskMutation(emptyState(), "create", {}),
			"subject required for create",
		);
		expectError(
			applyTaskMutation(emptyState(), "create", { subject: "   " }),
			"subject required for create",
		);
	});

	it("allows pending → in_progress → completed and rejects completed → in_progress", () => {
		const pending = stateWith(task({ id: 1, subject: "Reducer" }));
		const started = applyTaskMutation(pending, "update", {
			id: 1,
			status: "in_progress",
		});
		expect(started.op).toEqual({
			kind: "update",
			id: 1,
			fromStatus: "pending",
			toStatus: "in_progress",
		});
		expect(started.state.tasks[0]?.status).toBe("in_progress");

		const completed = applyTaskMutation(started.state, "update", {
			id: 1,
			status: "completed",
		});
		expect(completed.op).toEqual({
			kind: "update",
			id: 1,
			fromStatus: "in_progress",
			toStatus: "completed",
		});
		expect(completed.state.tasks[0]?.status).toBe("completed");

		const illegal = applyTaskMutation(completed.state, "update", {
			id: 1,
			status: "in_progress",
		});
		expectError(illegal, "illegal transition completed → in_progress");
		expect(illegal.state).toBe(completed.state);
	});

	it("validates missing ids for update, get, and delete", () => {
		const state = stateWith(task({ id: 1, subject: "Existing" }));
		expectError(
			applyTaskMutation(state, "update", { id: 99, status: "completed" }),
			"#99 not found",
		);
		expectError(applyTaskMutation(state, "get", { id: 99 }), "#99 not found");
		expectError(
			applyTaskMutation(state, "delete", { id: 99 }),
			"#99 not found",
		);
	});

	it("validates blockedBy on create for missing, deleted, and self blockers", () => {
		const deleted = stateWith(
			task({ id: 1, subject: "Gone", status: "deleted" }),
		);
		expectError(
			applyTaskMutation(emptyState(), "create", {
				subject: "Blocked",
				blockedBy: [99],
			}),
			"blockedBy: #99 not found",
		);
		expectError(
			applyTaskMutation(deleted, "create", {
				subject: "Blocked",
				blockedBy: [1],
			}),
			"blockedBy: #1 is deleted",
		);
		expectError(
			applyTaskMutation(emptyState(), "create", {
				subject: "Self",
				blockedBy: [1],
			}),
			"cannot block #1 on itself",
		);
	});

	it("validates addBlockedBy for missing, deleted, self blockers, and cycles", () => {
		const state = stateWith(
			task({ id: 1, subject: "A", blockedBy: [2] }),
			task({ id: 2, subject: "B" }),
			task({ id: 3, subject: "Deleted", status: "deleted" }),
		);

		expectError(
			applyTaskMutation(state, "update", { id: 1, addBlockedBy: [99] }),
			"addBlockedBy: #99 not found",
		);
		expectError(
			applyTaskMutation(state, "update", { id: 1, addBlockedBy: [3] }),
			"addBlockedBy: #3 is deleted",
		);
		expectError(
			applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] }),
			"cannot block #1 on itself",
		);
		expectError(
			applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] }),
			"addBlockedBy would create a cycle in the blockedBy graph",
		);
	});

	it("validates removeBlockedBy ids and removes blocker references without mutation", () => {
		const blocker = task({ id: 1, subject: "Blocker" });
		const blocked = task({ id: 2, subject: "Blocked", blockedBy: [1] });
		const state = stateWith(blocker, blocked);

		expectError(
			applyTaskMutation(state, "update", { id: 2, removeBlockedBy: [99] }),
			"removeBlockedBy: #99 not found",
		);

		const result = applyTaskMutation(state, "update", {
			id: 2,
			removeBlockedBy: [1],
		});
		expect(result.op).toEqual({
			kind: "update",
			id: 2,
			fromStatus: "pending",
			toStatus: "pending",
		});
		expect(result.state.tasks[1]).toEqual({
			id: 2,
			subject: "Blocked",
			status: "pending",
		});
		expect(state.tasks[1]).toBe(blocked);
		expect(blocked.blockedBy).toEqual([1]);
	});

	it("deletes metadata keys when update metadata values are null", () => {
		const state = stateWith(
			task({ id: 1, subject: "Meta", metadata: { keep: true, drop: "x" } }),
		);
		const result = applyTaskMutation(state, "update", {
			id: 1,
			metadata: { drop: null, add: 2 },
		});
		expect(result.state.tasks[0]?.metadata).toEqual({ keep: true, add: 2 });
		expect(state.tasks[0]?.metadata).toEqual({ keep: true, drop: "x" });
	});

	it("lists and gets without mutating state", () => {
		const taskOne = task({ id: 1, subject: "One", status: "completed" });
		const taskTwo = task({ id: 2, subject: "Two", status: "deleted" });
		const state = stateWith(taskOne, taskTwo);

		const list = applyTaskMutation(state, "list", {
			includeDeleted: true,
			status: "deleted",
		});
		expect(list.op).toEqual({
			kind: "list",
			includeDeleted: true,
			statusFilter: "deleted",
		});
		expect(list.state).toBe(state);

		const get = applyTaskMutation(state, "get", { id: 1 });
		expect(get.op).toEqual({ kind: "get", task: taskOne });
		expect(get.state).toBe(state);
	});

	it("delete tombstones a task and clear resets tasks with nextId", () => {
		const state = stateWith(
			task({ id: 7, subject: "Remove me", status: "completed" }),
		);
		const deleted = applyTaskMutation(state, "delete", { id: 7 });
		expect(deleted.op).toEqual({ kind: "delete", id: 7, subject: "Remove me" });
		expect(deleted.state.tasks[0]).toEqual({
			id: 7,
			subject: "Remove me",
			status: "deleted",
		});
		expect(state.tasks[0]?.status).toBe("completed");

		const cleared = applyTaskMutation(deleted.state, "clear", {});
		expect(cleared.op).toEqual({ kind: "clear", count: 1 });
		expect(cleared.state).toEqual({ tasks: [], nextId: 1 });
	});
});

describe("status invariants", () => {
	it("keeps same-status updates idempotent", () => {
		expect(isTransitionValid("pending", "pending")).toBe(true);
		expect(isTransitionValid("completed", "completed")).toBe(true);
	});

	it("allows only approved transitions from completed and deleted", () => {
		expect(isTransitionValid("completed", "deleted")).toBe(true);
		expect(isTransitionValid("completed", "pending")).toBe(false);
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
		expect(isTransitionValid("deleted", "pending")).toBe(false);
		expect(isTransitionValid("deleted", "completed")).toBe(false);
	});
});
