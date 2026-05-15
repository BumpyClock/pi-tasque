import type { Task } from "../tool/types.js";
import {
	cloneTask,
	cloneTaskState,
	EMPTY_STATE,
	type TaskState,
} from "./state.js";

let state: TaskState = cloneTaskState(EMPTY_STATE);

/** Task snapshot accessor for UI/command readers. */
export function getTodos(): readonly Task[] {
	return state.tasks.map(cloneTask);
}

export function getNextId(): number {
	return state.nextId;
}

/** State snapshot accessor for reducer callers. */
export function getState(): TaskState {
	return cloneTaskState(state);
}

/** Replace live state from branch replay. */
export function replaceState(next: TaskState): void {
	state = cloneTaskState(next);
}

/** Commit reducer output as live state. */
export function commitState(next: TaskState): void {
	state = cloneTaskState(next);
}

export function __resetState(): void {
	state = cloneTaskState(EMPTY_STATE);
}
