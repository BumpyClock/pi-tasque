import { describe, expect, it } from "vitest";
import {
	ACTIVE_STATUSES,
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTaskSubjectById,
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "../../src/session-todos/state/selectors.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
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

describe("todo selectors", () => {
	it("selects visible tasks by excluding deleted tombstones", () => {
		const visible = task({ id: 1, subject: "visible" });
		const deleted = task({ id: 2, subject: "gone", status: "deleted" });
		const state = stateWith(visible, deleted);

		expect(selectVisibleTasks(state)).toEqual([visible]);
	});

	it("groups visible tasks by status and counts them", () => {
		const state = stateWith(
			task({ id: 1, subject: "pending" }),
			task({ id: 2, subject: "working", status: "in_progress" }),
			task({ id: 3, subject: "done", status: "completed" }),
			task({ id: 4, subject: "gone", status: "deleted" }),
		);

		expect(selectTasksByStatus(state)).toEqual({
			pending: [state.tasks[0]],
			inProgress: [state.tasks[1]],
			completed: [state.tasks[2]],
		});
		expect(selectTodoCounts(state)).toEqual({
			total: 3,
			pending: 1,
			inProgress: 1,
			completed: 1,
		});
	});

	it("shows task ids only when visible tasks include blockedBy references", () => {
		const deletedBlock = stateWith(
			task({ id: 1, subject: "base" }),
			task({
				id: 2,
				subject: "deleted blocked",
				status: "deleted",
				blockedBy: [1],
			}),
		);
		const visibleBlock = stateWith(
			task({ id: 1, subject: "base" }),
			task({ id: 2, subject: "visible blocked", blockedBy: [1] }),
		);

		expect(selectShowTaskIds(deletedBlock)).toBe(false);
		expect(selectShowTaskIds(visibleBlock)).toBe(true);
	});

	it("looks up a task subject by id", () => {
		const state = stateWith(
			task({ id: 1, subject: "alpha" }),
			task({ id: 2, subject: "deleted subject", status: "deleted" }),
		);

		expect(selectTaskSubjectById(state, 1)).toBe("alpha");
		expect(selectTaskSubjectById(state, 2)).toBe("deleted subject");
		expect(selectTaskSubjectById(state, 99)).toBeUndefined();
	});

	it("detects active pending and in_progress tasks", () => {
		expect(
			selectHasActive(
				stateWith(task({ id: 1, subject: "done", status: "completed" })),
			),
		).toBe(false);
		expect(
			selectHasActive(
				stateWith(task({ id: 1, subject: "pending", status: "pending" })),
			),
		).toBe(true);
		expect(ACTIVE_STATUSES.has("pending")).toBe(true);
		expect(ACTIVE_STATUSES.has("in_progress")).toBe(true);
		expect(ACTIVE_STATUSES.has("completed")).toBe(false);
	});
});

describe("selectOverlayLayout", () => {
	it("returns all visible tasks when they fit in the budget", () => {
		const state = stateWith(
			task({ id: 1, subject: "a" }),
			task({ id: 2, subject: "b", status: "completed" }),
			task({ id: 3, subject: "gone", status: "deleted" }),
		);

		expect(selectOverlayLayout(state, 2)).toEqual({
			visible: [state.tasks[0], state.tasks[1]],
			hiddenCompleted: 0,
			truncatedTail: 0,
		});
	});

	it("drops completed tasks first and keeps natural order for displayed tasks", () => {
		const state = stateWith(
			task({ id: 1, subject: "p1" }),
			task({ id: 2, subject: "c2", status: "completed" }),
			task({ id: 3, subject: "p3" }),
			task({ id: 4, subject: "c4", status: "completed" }),
			task({ id: 5, subject: "p5" }),
		);

		expect(selectOverlayLayout(state, 4)).toEqual({
			visible: [state.tasks[0], state.tasks[2], state.tasks[4]],
			hiddenCompleted: 2,
			truncatedTail: 0,
		});
	});

	it("fills spare rows with completed tasks when active tasks fit", () => {
		const state = stateWith(
			task({ id: 1, subject: "p1" }),
			task({ id: 2, subject: "c2", status: "completed" }),
			task({ id: 3, subject: "c3", status: "completed" }),
			task({ id: 4, subject: "p4" }),
			task({ id: 5, subject: "c5", status: "completed" }),
		);

		expect(selectOverlayLayout(state, 4)).toEqual({
			visible: [state.tasks[0], state.tasks[1], state.tasks[3]],
			hiddenCompleted: 2,
			truncatedTail: 0,
		});
	});

	it("truncates the non-completed tail when completed dropping is not enough", () => {
		const state = stateWith(
			task({ id: 1, subject: "p1" }),
			task({ id: 2, subject: "p2" }),
			task({ id: 3, subject: "p3" }),
			task({ id: 4, subject: "done", status: "completed" }),
		);

		expect(selectOverlayLayout(state, 3)).toEqual({
			visible: [state.tasks[0], state.tasks[1]],
			hiddenCompleted: 1,
			truncatedTail: 1,
		});
	});

	it("handles zero or negative budgets without throwing", () => {
		const state = stateWith(
			task({ id: 1, subject: "p1" }),
			task({ id: 2, subject: "done", status: "completed" }),
		);

		expect(selectOverlayLayout(state, 0)).toEqual({
			visible: [],
			hiddenCompleted: 1,
			truncatedTail: 1,
		});
		expect(selectOverlayLayout(state, -1)).toEqual({
			visible: [],
			hiddenCompleted: 1,
			truncatedTail: 1,
		});
	});
});
