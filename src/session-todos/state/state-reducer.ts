import type {
	Task,
	TaskAction,
	TaskMutationParams,
	TaskStatus,
} from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

export { EMPTY_STATE } from "./state.js";
export type { TaskState } from "./state.js";

export type Op =
	| { kind: "create"; taskId: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function isValidId(id: unknown): id is number {
	return typeof id === "number" && Number.isFinite(id);
}

function findTask(tasks: readonly Task[], id: number): Task | undefined {
	return tasks.find((task) => task.id === id);
}

function dedupeIds(ids: readonly number[]): number[] {
	return [...new Set(ids)];
}

function validateBlockers(
	state: TaskState,
	taskId: number,
	blockerIds: readonly number[],
	fieldName: "blockedBy" | "addBlockedBy",
): string | undefined {
	for (const blockerId of blockerIds) {
		if (blockerId === taskId) return `cannot block #${taskId} on itself`;
		const blocker = findTask(state.tasks, blockerId);
		if (!blocker) return `${fieldName}: #${blockerId} not found`;
		if (blocker.status === "deleted")
			return `${fieldName}: #${blockerId} is deleted`;
	}
	return undefined;
}

function validateRemovals(
	state: TaskState,
	blockerIds: readonly number[],
): string | undefined {
	for (const blockerId of blockerIds) {
		if (!findTask(state.tasks, blockerId))
			return `removeBlockedBy: #${blockerId} not found`;
	}
	return undefined;
}

function mergeMetadata(
	current: Readonly<Record<string, unknown>> | undefined,
	patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
	const merged: Record<string, unknown> = { ...(current ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function assignOptionalTaskFields(
	task: Task,
	params: TaskMutationParams,
): void {
	if (params.description !== undefined) task.description = params.description;
	if (params.activeForm !== undefined) task.activeForm = params.activeForm;
	if (params.owner !== undefined) task.owner = params.owner;
}

/**
 * Pure reducer: (state, action, params) -> { state, op }.
 *
 * The reducer owns validation and returns failures as in-band error ops so tool
 * response code can preserve the same replay snapshot shape for success/error.
 */
export function applyTaskMutation(
	state: TaskState,
	action: TaskAction,
	params: TaskMutationParams,
): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) {
				return errorResult(state, "subject required for create");
			}

			const blockedBy = dedupeIds(params.blockedBy ?? []);
			const blockerError = validateBlockers(
				state,
				state.nextId,
				blockedBy,
				"blockedBy",
			);
			if (blockerError) return errorResult(state, blockerError);

			const task: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			assignOptionalTaskFields(task, params);
			if (blockedBy.length > 0) task.blockedBy = blockedBy;
			if (params.metadata !== undefined) task.metadata = { ...params.metadata };

			const tasks = [...state.tasks, task];
			if (detectCycle(tasks, task.id, blockedBy)) {
				return errorResult(
					state,
					"blockedBy would create a cycle in the blockedBy graph",
				);
			}

			return {
				state: { tasks, nextId: state.nextId + 1 },
				op: { kind: "create", taskId: task.id },
			};
		}

		case "update": {
			if (!isValidId(params.id))
				return errorResult(state, "id required for update");
			const index = state.tasks.findIndex((task) => task.id === params.id);
			if (index === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[index];
			if (!current) return errorResult(state, `#${params.id} not found`);

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.blockedBy !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy !== undefined && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy !== undefined &&
					params.removeBlockedBy.length > 0);
			if (!hasMutation) {
				return errorResult(state, "update requires at least one mutable field");
			}

			let nextStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(
						state,
						`illegal transition ${current.status} → ${params.status}`,
					);
				}
				nextStatus = params.status;
			}

			let nextBlockedBy = [...(current.blockedBy ?? [])];
			if (params.blockedBy !== undefined) {
				nextBlockedBy = dedupeIds(params.blockedBy);
				const blockerError = validateBlockers(
					state,
					current.id,
					nextBlockedBy,
					"blockedBy",
				);
				if (blockerError) return errorResult(state, blockerError);
			}

			if (params.removeBlockedBy?.length) {
				const removalIds = dedupeIds(params.removeBlockedBy);
				const removalError = validateRemovals(state, removalIds);
				if (removalError) return errorResult(state, removalError);
				const removals = new Set(removalIds);
				nextBlockedBy = nextBlockedBy.filter(
					(blockerId) => !removals.has(blockerId),
				);
			}

			if (params.addBlockedBy?.length) {
				const additions = dedupeIds(params.addBlockedBy);
				const blockerError = validateBlockers(
					state,
					current.id,
					additions,
					"addBlockedBy",
				);
				if (blockerError) return errorResult(state, blockerError);
				for (const blockerId of additions) {
					if (!nextBlockedBy.includes(blockerId)) nextBlockedBy.push(blockerId);
				}
			}

			const cycleCheckTasks = state.tasks.map((task) =>
				task.id === current.id ? { ...task, blockedBy: [] } : task,
			);
			if (detectCycle(cycleCheckTasks, current.id, nextBlockedBy)) {
				return errorResult(
					state,
					"addBlockedBy would create a cycle in the blockedBy graph",
				);
			}

			const updated: Task = { ...current, status: nextStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			assignOptionalTaskFields(updated, params);
			if (nextBlockedBy.length > 0) updated.blockedBy = nextBlockedBy;
			else delete updated.blockedBy;

			if (params.metadata !== undefined) {
				const nextMetadata = mergeMetadata(current.metadata, params.metadata);
				if (nextMetadata) updated.metadata = nextMetadata;
				else delete updated.metadata;
			}

			const tasks = [...state.tasks];
			tasks[index] = updated;

			return {
				state: { tasks, nextId: state.nextId },
				op: {
					kind: "update",
					id: updated.id,
					fromStatus: current.status,
					toStatus: nextStatus,
				},
			};
		}

		case "list":
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					...(params.status !== undefined
						? { statusFilter: params.status }
						: {}),
				},
			};

		case "get": {
			if (!isValidId(params.id))
				return errorResult(state, "id required for get");
			const task = findTask(state.tasks, params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (!isValidId(params.id))
				return errorResult(state, "id required for delete");
			const index = state.tasks.findIndex((task) => task.id === params.id);
			if (index === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[index];
			if (!current) return errorResult(state, `#${params.id} not found`);
			if (current.status === "deleted")
				return errorResult(state, `#${params.id} is already deleted`);

			const updated: Task = { ...current, status: "deleted" };
			const tasks = [...state.tasks];
			tasks[index] = updated;
			return {
				state: { tasks, nextId: state.nextId },
				op: { kind: "delete", id: updated.id, subject: updated.subject },
			};
		}

		case "clear":
			return {
				state: { tasks: [], nextId: 1 },
				op: { kind: "clear", count: state.tasks.length },
			};
	}
}
