import { beforeEach, describe, expect, it } from "vitest";
import type { Task, TaskStatus } from "../../src/session-todos/tool/types.js";
import {
	__resetState,
	commitState,
	getState,
	getTodos,
	replaceState,
} from "../../src/session-todos/state/store.js";
import type { TaskState } from "../../src/session-todos/state/state.js";

function task(
	overrides: Partial<Task> & { id: number; subject: string },
): Task {
	return { status: "pending", ...overrides };
}

function stateWith(...tasks: Task[]): TaskState {
	return { tasks, nextId: Math.max(0, ...tasks.map((item) => item.id)) + 1 };
}

function nestedMetadata(): Record<string, unknown> {
	return {
		tsqId: "tsq-1",
		details: { note: "keep" },
		steps: [{ label: "plan" }],
	};
}

function expectedNestedMetadata(): Record<string, unknown> {
	return nestedMetadata();
}

function mutateTask(taskToMutate: Task): void {
	taskToMutate.subject = "mutated";
	taskToMutate.status = "completed" as TaskStatus;
	taskToMutate.blockedBy?.push(99);
	if (!taskToMutate.metadata) return;
	taskToMutate.metadata.extra = "mutated";
	(taskToMutate.metadata.details as { note: string } | undefined)!.note =
		"mutated";
	(taskToMutate.metadata.steps as { label: string }[] | undefined)![0]!.label =
		"mutated";
}

describe("todo state store", () => {
	beforeEach(() => {
		__resetState();
	});

	it("commitState stores a cloned state instead of caller-owned references", () => {
		const incoming = stateWith(
			task({
				id: 1,
				subject: "source",
				blockedBy: [2],
				metadata: nestedMetadata(),
			}),
		);

		commitState(incoming);
		incoming.nextId = 100;
		mutateTask(incoming.tasks[0]!);
		incoming.tasks.push(task({ id: 2, subject: "extra" }));

		expect(getState()).toEqual({
			tasks: [
				{
					id: 1,
					subject: "source",
					status: "pending",
					blockedBy: [2],
					metadata: expectedNestedMetadata(),
				},
			],
			nextId: 2,
		});
	});

	it("replaceState stores a cloned state instead of caller-owned references", () => {
		const incoming = stateWith(
			task({
				id: 1,
				subject: "source",
				blockedBy: [2],
				metadata: nestedMetadata(),
			}),
		);

		replaceState(incoming);
		incoming.nextId = 100;
		mutateTask(incoming.tasks[0]!);
		incoming.tasks.push(task({ id: 2, subject: "extra" }));

		expect(getState()).toEqual({
			tasks: [
				{
					id: 1,
					subject: "source",
					status: "pending",
					blockedBy: [2],
					metadata: expectedNestedMetadata(),
				},
			],
			nextId: 2,
		});
	});

	it("getState returns cloned snapshots that cannot mutate live state", () => {
		commitState(
			stateWith(
				task({
					id: 1,
					subject: "source",
					blockedBy: [2],
					metadata: nestedMetadata(),
				}),
			),
		);

		const snapshot = getState();
		snapshot.nextId = 100;
		mutateTask(snapshot.tasks[0]!);
		snapshot.tasks.push(task({ id: 2, subject: "extra" }));

		expect(getState()).toEqual({
			tasks: [
				{
					id: 1,
					subject: "source",
					status: "pending",
					blockedBy: [2],
					metadata: expectedNestedMetadata(),
				},
			],
			nextId: 2,
		});
	});

	it("getTodos returns cloned task snapshots that cannot mutate live state", () => {
		commitState(
			stateWith(
				task({
					id: 1,
					subject: "source",
					blockedBy: [2],
					metadata: nestedMetadata(),
				}),
			),
		);

		const todos = getTodos() as Task[];
		mutateTask(todos[0]!);
		todos.push(task({ id: 2, subject: "extra" }));

		expect(getTodos()).toEqual([
			{
				id: 1,
				subject: "source",
				status: "pending",
				blockedBy: [2],
				metadata: expectedNestedMetadata(),
			},
		]);
	});
});
