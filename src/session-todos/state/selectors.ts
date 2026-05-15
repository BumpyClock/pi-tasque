import type { Task, TaskStatus } from "../tool/types.js";
import type { TaskState } from "./state.js";

/** Tasks excluding deleted tombstones — canonical visible todo list. */
export function selectVisibleTasks(state: TaskState): readonly Task[] {
	return state.tasks.filter((task) => task.status !== "deleted");
}

export interface TasksByStatus {
	pending: readonly Task[];
	inProgress: readonly Task[];
	completed: readonly Task[];
}

/** Visible tasks grouped by user-facing status buckets. */
export function selectTasksByStatus(state: TaskState): TasksByStatus {
	const visible = selectVisibleTasks(state);
	return {
		pending: visible.filter((task) => task.status === "pending"),
		inProgress: visible.filter((task) => task.status === "in_progress"),
		completed: visible.filter((task) => task.status === "completed"),
	};
}

export interface TodoCounts {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
}

/** Counts used by the overlay heading and /todos command summary. */
export function selectTodoCounts(state: TaskState): TodoCounts {
	const groups = selectTasksByStatus(state);
	return {
		total:
			groups.pending.length +
			groups.inProgress.length +
			groups.completed.length,
		pending: groups.pending.length,
		inProgress: groups.inProgress.length,
		completed: groups.completed.length,
	};
}

/** Show row ids only when dependency suffixes need an id anchor. */
export function selectShowTaskIds(state: TaskState): boolean {
	return selectVisibleTasks(state).some(
		(task) => (task.blockedBy?.length ?? 0) > 0,
	);
}

/** Resolve a task subject by id for tool-call rendering. */
export function selectTaskSubjectById(
	state: TaskState,
	id: number,
): string | undefined {
	return state.tasks.find((task) => task.id === id)?.subject;
}

export interface OverlayLayout {
	visible: readonly Task[];
	hiddenCompleted: number;
	truncatedTail: number;
}

/**
 * Decide which rows fit in the overlay body.
 *
 * When overflowing, one body slot is reserved for a summary row. Completed rows
 * are hidden first; if active rows still overflow, the active tail is truncated.
 */
export function selectOverlayLayout(
	state: TaskState,
	budget: number,
): OverlayLayout {
	const all = selectVisibleTasks(state);
	const normalizedBudget = Number.isFinite(budget)
		? Math.max(0, Math.floor(budget))
		: 0;
	const nonCompleted = all.filter((task) => task.status !== "completed");
	const totalCompleted = all.length - nonCompleted.length;

	if (all.length <= normalizedBudget) {
		return { visible: all, hiddenCompleted: 0, truncatedTail: 0 };
	}

	if (normalizedBudget <= 0) {
		return {
			visible: [],
			hiddenCompleted: totalCompleted,
			truncatedTail: nonCompleted.length,
		};
	}

	const rowBudget = normalizedBudget - 1;
	if (rowBudget <= 0) {
		return {
			visible: [],
			hiddenCompleted: totalCompleted,
			truncatedTail: nonCompleted.length,
		};
	}

	if (nonCompleted.length <= rowBudget) {
		const kept = new Set<Task>(nonCompleted);
		for (const task of all) {
			if (kept.size >= rowBudget) break;
			if (task.status === "completed") kept.add(task);
		}

		const visible = all.filter((task) => kept.has(task));
		const shownCompleted = visible.filter(
			(task) => task.status === "completed",
		).length;
		return {
			visible,
			hiddenCompleted: totalCompleted - shownCompleted,
			truncatedTail: 0,
		};
	}

	return {
		visible: nonCompleted.slice(0, rowBudget),
		hiddenCompleted: totalCompleted,
		truncatedTail: nonCompleted.length - rowBudget,
	};
}

/** Whether any visible task is still actionable. */
export function selectHasActive(state: TaskState): boolean {
	return selectVisibleTasks(state).some((task) =>
		ACTIVE_STATUSES.has(task.status),
	);
}

export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
	"pending",
	"in_progress",
]);
