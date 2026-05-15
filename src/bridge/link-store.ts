import { selectVisibleTasks } from "../session-todos/state/selectors.js";
import { applyTaskMutation } from "../session-todos/state/state-reducer.js";
import type { TaskState } from "../session-todos/state/state.js";
import { commitState, getState } from "../session-todos/state/store.js";
import type { Task } from "../session-todos/tool/types.js";
import type { TaskBridgeLink } from "./types.js";

export type LinkTodoResult =
	| {
			readonly ok: true;
			readonly link: TaskBridgeLink;
			readonly todo: Task;
	  }
	| {
			readonly ok: false;
			readonly message: string;
	  };

export function linkTodoToTsq(todoId: number, tsqId: string): LinkTodoResult {
	if (!Number.isInteger(todoId) || todoId < 1) {
		return { ok: false, message: "todoId is required" };
	}

	const normalizedTsqId = tsqId.trim();
	if (normalizedTsqId.length === 0) {
		return { ok: false, message: "tsqId is required" };
	}

	const state = getState();
	const existing = state.tasks.find((task) => task.id === todoId);
	if (existing === undefined) {
		return { ok: false, message: `todo #${todoId} not found` };
	}
	if (existing.status === "deleted") {
		return { ok: false, message: `todo #${todoId} is deleted` };
	}

	const updated = applyTaskMutation(state, "update", {
		id: todoId,
		metadata: { tsqId: normalizedTsqId },
	});
	if (updated.op.kind === "error") {
		return { ok: false, message: updated.op.message };
	}

	commitState(updated.state);
	const todo = updated.state.tasks.find((task) => task.id === todoId);
	if (todo === undefined || todo.status === "deleted") {
		return { ok: false, message: `todo #${todoId} not found` };
	}

	return {
		ok: true,
		link: taskToLink(todo, normalizedTsqId),
		todo,
	};
}

export function deriveTaskLinks(
	state: TaskState = getState(),
): TaskBridgeLink[] {
	return selectVisibleTasks(state).flatMap((task) => {
		const tsqId = getTaskTsqId(task);
		return tsqId === undefined ? [] : [taskToLink(task, tsqId)];
	});
}

export function getTaskLink(
	todoId: number,
	state: TaskState = getState(),
): TaskBridgeLink | undefined {
	const task = selectVisibleTasks(state).find(
		(candidate) => candidate.id === todoId,
	);
	if (task === undefined) return undefined;
	const tsqId = getTaskTsqId(task);
	return tsqId === undefined ? undefined : taskToLink(task, tsqId);
}

function getTaskTsqId(task: Task): string | undefined {
	const value = task.metadata?.tsqId;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function taskToLink(task: Task, tsqId: string): TaskBridgeLink {
	if (task.status === "deleted") {
		throw new Error("deleted todos cannot be represented as bridge links");
	}
	return {
		todoId: task.id,
		todoSubject: task.subject,
		todoStatus: task.status,
		tsqId,
	};
}
