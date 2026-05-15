import type { Task } from "../tool/types.js";

/**
 * Canonical in-session todo state. Reducers and replay produce this shape;
 * store.ts is the only module-level live state cell.
 */
export interface TaskState {
	tasks: Task[];
	nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cloneMetadataValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;

	if (typeof globalThis.structuredClone === "function") {
		try {
			return globalThis.structuredClone(value);
		} catch {
			// Fall through for values structuredClone cannot copy, like functions.
		}
	}

	if (Array.isArray(value)) return value.map(cloneMetadataValue);

	if (isPlainObject(value)) {
		const cloned: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			cloned[key] = cloneMetadataValue(nestedValue);
		}
		return cloned;
	}

	return value;
}

function cloneMetadata(
	metadata: Record<string, unknown>,
): Record<string, unknown> {
	const cloned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metadata)) {
		cloned[key] = cloneMetadataValue(value);
	}
	return cloned;
}

export function cloneTask(task: Task): Task {
	const cloned: Task = { ...task };
	if (task.blockedBy !== undefined) cloned.blockedBy = [...task.blockedBy];
	else delete cloned.blockedBy;
	if (task.metadata !== undefined)
		cloned.metadata = cloneMetadata(task.metadata);
	else delete cloned.metadata;
	return cloned;
}

export function cloneTaskState(state: TaskState): TaskState {
	return {
		tasks: state.tasks.map(cloneTask),
		nextId: state.nextId,
	};
}
