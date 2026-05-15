import { cloneTaskState, type TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import type {
	Task,
	TaskAction,
	TaskDetails,
	TaskMutationParams,
} from "./types.js";

export interface TodoToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: TaskDetails;
}

function formatListLine(task: Task): string {
	const activeForm =
		task.status === "in_progress" && task.activeForm
			? ` (${task.activeForm})`
			: "";
	const blockedBy = task.blockedBy?.length
		? ` ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`
		: "";
	return `[${task.status}] #${task.id} ${task.subject}${activeForm}${blockedBy}`;
}

function formatGetLines(task: Task, state: TaskState): string {
	const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
	const lines = [`#${task.id} [${task.status}] ${task.subject}`];
	if (task.description) lines.push(`  description: ${task.description}`);
	if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
	if (task.blockedBy?.length) {
		lines.push(
			`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
		);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${task.owner}`);
	return lines.join("\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function cloneDetailValue(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;

	if (typeof globalThis.structuredClone === "function") {
		try {
			return globalThis.structuredClone(value);
		} catch {
			// Fall back for values structuredClone cannot copy, like functions.
		}
	}

	if (Array.isArray(value)) return value.map(cloneDetailValue);

	if (isPlainObject(value)) {
		const cloned: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value)) {
			cloned[key] = cloneDetailValue(nestedValue);
		}
		return cloned;
	}

	return value;
}

function cloneParams(params: TaskMutationParams): Record<string, unknown> {
	const cloned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		cloned[key] = cloneDetailValue(value);
	}
	return cloned;
}

/** LLM-facing text for todo reducer operations. */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const task = state.tasks.find((candidate) => candidate.id === op.taskId);
			if (!task) return `Created #${op.taskId}`;
			return `Created #${task.id}: ${task.subject} (pending)`;
		}
		case "update": {
			const transition =
				op.fromStatus === op.toStatus
					? ""
					: ` (${op.fromStatus} → ${op.toStatus})`;
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${op.subject}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			let tasks = state.tasks;
			if (!op.includeDeleted) {
				tasks = tasks.filter((task) => task.status !== "deleted");
			}
			if (op.statusFilter) {
				tasks = tasks.filter((task) => task.status === op.statusFilter);
			}
			return tasks.length === 0
				? "No tasks"
				: tasks.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Compatible `todo` result envelope. `details` is the replay snapshot consumed
 * by session branch replay, so keep field names stable.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): TodoToolResult {
	const snapshot = cloneTaskState(state);
	const details: TaskDetails = {
		action,
		params: cloneParams(params),
		tasks: snapshot.tasks,
		nextId: snapshot.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};

	return {
		content: [{ type: "text", text: formatContent(op, state) }],
		details,
	};
}
