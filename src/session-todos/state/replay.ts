import {
	TOOL_NAME,
	type Task,
	type TaskDetails,
	type TaskStatus,
} from "../tool/types.js";
import {
	cloneTask,
	cloneTaskState,
	EMPTY_STATE,
	type TaskState,
} from "./state.js";

interface BranchContext {
	sessionManager: {
		getBranch(): Iterable<unknown>;
	};
}

interface BranchMessageEntry {
	type?: string;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
}

const VALID_STATUSES = new Set<TaskStatus>([
	"pending",
	"in_progress",
	"completed",
	"deleted",
]);

const DURABLE_TASK_REPLAY_TOOL_NAME = "task";
const TASK_BRIDGE_MUTATION_ACTIONS = new Set(["promote_todo", "import_tsq"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isTask(value: unknown): value is Task {
	if (!isPlainObject(value)) return false;
	return (
		isSafePositiveInteger(value.id) &&
		typeof value.subject === "string" &&
		value.subject.trim().length > 0 &&
		typeof value.status === "string" &&
		VALID_STATUSES.has(value.status as TaskStatus) &&
		isOptionalString(value.description) &&
		isOptionalString(value.activeForm) &&
		isOptionalString(value.owner) &&
		(value.blockedBy === undefined ||
			(Array.isArray(value.blockedBy) &&
				value.blockedBy.every(isSafePositiveInteger))) &&
		(value.metadata === undefined || isPlainObject(value.metadata))
	);
}

function hasBlockedByCycle(tasks: readonly Task[]): boolean {
	const edges = new Map<number, readonly number[]>();
	for (const task of tasks) edges.set(task.id, task.blockedBy ?? []);

	const visiting = new Set<number>();
	const visited = new Set<number>();

	const visit = (taskId: number): boolean => {
		if (visiting.has(taskId)) return true;
		if (visited.has(taskId)) return false;

		visiting.add(taskId);
		for (const blockerId of edges.get(taskId) ?? []) {
			if (visit(blockerId)) return true;
		}
		visiting.delete(taskId);
		visited.add(taskId);
		return false;
	};

	for (const taskId of edges.keys()) {
		if (visit(taskId)) return true;
	}
	return false;
}

function hasValidTaskSnapshot(tasks: readonly Task[], nextId: number): boolean {
	const tasksById = new Map<number, Task>();
	let maxTaskId = 0;

	for (const task of tasks) {
		if (tasksById.has(task.id)) return false;
		tasksById.set(task.id, task);
		maxTaskId = Math.max(maxTaskId, task.id);
	}

	if (tasks.length > 0 && nextId <= maxTaskId) return false;

	for (const task of tasks) {
		for (const blockerId of task.blockedBy ?? []) {
			if (blockerId === task.id) return false;
			const blocker = tasksById.get(blockerId);
			if (!blocker || blocker.status === "deleted") return false;
		}
	}

	return !hasBlockedByCycle(tasks);
}

/**
 * Defensive snapshot guard. Replay only needs the persisted task list and next
 * id; older compatible todo results may include extra fields.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!isPlainObject(value)) return false;
	const tasks = value.tasks;
	return (
		Array.isArray(tasks) &&
		tasks.every(isTask) &&
		isSafePositiveInteger(value.nextId) &&
		hasValidTaskSnapshot(tasks, value.nextId)
	);
}

function emptyState(): TaskState {
	return cloneTaskState(EMPTY_STATE);
}

interface BridgeLinkReplayDetails {
	readonly todoId: number;
	readonly tsqId: string;
}

function getReplayableBridgeLink(
	details: unknown,
): BridgeLinkReplayDetails | undefined {
	if (!isPlainObject(details) || details.ok !== true) return undefined;
	const data = details.data;
	if (!isPlainObject(data) || data.action !== "link") return undefined;
	const link = data.link;
	if (!isPlainObject(link)) return undefined;
	if (!isSafePositiveInteger(link.todoId)) return undefined;
	if (typeof link.tsqId !== "string") return undefined;

	const tsqId = link.tsqId.trim();
	if (tsqId.length === 0) return undefined;
	return { todoId: link.todoId, tsqId };
}

function applyReplayableBridgeLink(
	state: TaskState,
	link: BridgeLinkReplayDetails,
): TaskState {
	const taskIndex = state.tasks.findIndex((task) => task.id === link.todoId);
	const task = state.tasks[taskIndex];
	if (task === undefined || task.status === "deleted") return state;

	const metadata = { ...(task.metadata ?? {}), tsqId: link.tsqId };
	const tasks = [...state.tasks];
	tasks[taskIndex] = { ...task, metadata };
	return { tasks, nextId: state.nextId };
}

function getReplayableBridgeTodoSnapshot(
	details: unknown,
): TaskState | undefined {
	if (!isPlainObject(details) || details.ok !== true) return undefined;
	const data = details.data;
	if (!isPlainObject(data)) return undefined;
	if (
		typeof data.action !== "string" ||
		!TASK_BRIDGE_MUTATION_ACTIONS.has(data.action)
	) {
		return undefined;
	}

	const snapshot = data.todoSnapshot;
	if (!isTaskDetails(snapshot)) return undefined;
	return cloneTaskState(snapshot);
}

function getReplayableClaimTodo(details: unknown): Task | undefined {
	if (!isPlainObject(details) || details.ok !== true) return undefined;
	const data = details.data;
	if (!isPlainObject(data) || data.createTodo !== true) return undefined;
	const todo = data.todo;
	if (!isTask(todo)) return undefined;

	const tsqId = getClaimTodoTsqId(data, todo);
	if (tsqId === undefined) return undefined;
	return cloneTask({ ...todo, metadata: { ...(todo.metadata ?? {}), tsqId } });
}

function getClaimTodoTsqId(
	data: Record<string, unknown>,
	todo: Task,
): string | undefined {
	const id = data.id;
	if (typeof id === "string" && id.trim().length > 0) return id.trim();
	const metadataId = todo.metadata?.tsqId;
	if (typeof metadataId === "string" && metadataId.trim().length > 0) {
		return metadataId.trim();
	}
	return undefined;
}

function applyReplayableClaimTodo(state: TaskState, todo: Task): TaskState {
	if (state.tasks.some((task) => task.id === todo.id)) return state;

	const tasks = [...state.tasks, todo];
	const nextId = Math.max(state.nextId, todo.id + 1);
	if (!hasValidTaskSnapshot(tasks, nextId)) return state;
	return { tasks, nextId };
}

/**
 * Rebuild todo state from the current session branch. The latest compatible
 * `todo` tool result wins; malformed snapshots are skipped. Successful durable
 * `task` results replay todo snapshots, links, and claim-created todos so
 * bridge metadata, imports/promotions, and claim-created todos survive
 * reload/branch replay.
 */
export function replayFromBranch(ctx: BranchContext): TaskState {
	let result = emptyState();

	for (const entry of ctx.sessionManager.getBranch()) {
		const branchEntry = entry as BranchMessageEntry;
		if (branchEntry.type !== "message") continue;

		const message = branchEntry.message;
		if (!message || message.role !== "toolResult") continue;

		if (message.toolName === TOOL_NAME) {
			if (!isTaskDetails(message.details)) continue;
			result = cloneTaskState(message.details);
			continue;
		}

		if (message.toolName === DURABLE_TASK_REPLAY_TOOL_NAME) {
			const snapshot = getReplayableBridgeTodoSnapshot(message.details);
			if (snapshot !== undefined) {
				result = snapshot;
				continue;
			}

			const link = getReplayableBridgeLink(message.details);
			if (link !== undefined) {
				result = applyReplayableBridgeLink(result, link);
				continue;
			}

			const todo = getReplayableClaimTodo(message.details);
			if (todo === undefined) continue;
			result = applyReplayableClaimTodo(result, todo);
		}
	}

	return result;
}
