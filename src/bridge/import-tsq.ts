import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type {
	TsqDependencyRef,
	TsqShowData,
	TsqTask,
	TsqTaskTreeNode,
	TsqTreeData,
	TsqTreeResult,
} from "../durable-tasks/types.js";
import { runTsqJson } from "../durable-tasks/runner.js";
import { selectVisibleTasks } from "../session-todos/state/selectors.js";
import {
	cloneTaskState,
	type TaskState,
} from "../session-todos/state/state.js";
import {
	applyTaskMutation,
	type ApplyResult,
	type Op,
} from "../session-todos/state/state-reducer.js";
import { commitState, getState } from "../session-todos/state/store.js";
import type { Task, TaskStatus } from "../session-todos/tool/types.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";
import type {
	ImportTsqBridgeParams,
	TaskBridgeActionHandler,
	TaskBridgeDetails,
	TaskBridgeLink,
	TaskBridgeTodoSnapshot,
} from "./types.js";

export interface ImportTsqImportedTask {
	readonly tsqId: string;
	readonly title: string;
	readonly todoId: number;
	readonly created: boolean;
	readonly blockedBy: readonly number[];
}

export interface ImportTsqSuccessData {
	readonly [key: string]: unknown;
	readonly action: "import_tsq";
	readonly tsqId: string;
	readonly source: "tree" | "show";
	readonly imported: readonly ImportTsqImportedTask[];
	readonly links: readonly TaskBridgeLink[];
	readonly created: readonly TaskBridgeLink[];
	readonly existing: readonly TaskBridgeLink[];
	readonly todoSnapshot: TaskBridgeTodoSnapshot;
}

interface SelectedTreeTask {
	readonly task: TsqTask;
	readonly node?: TsqTaskTreeNode;
}

interface LocatedImport {
	readonly source: "tree" | "show";
	readonly selected: readonly SelectedTreeTask[];
}

interface PreparedImport {
	readonly state: TaskState;
	readonly createdTodoIds: readonly number[];
	readonly imported: readonly ImportTsqImportedTask[];
	readonly links: readonly TaskBridgeLink[];
	readonly created: readonly TaskBridgeLink[];
	readonly existing: readonly TaskBridgeLink[];
}

const FIND_TREE_ARGV = ["find", "open", "--tree"] as const;
const SHOW_ARGV_PREFIX = ["show"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;

export const importTsqHandler: TaskBridgeActionHandler<
	ImportTsqBridgeParams
> = async (params, ctx) => {
	const tsqId = normalizeOptionalString(params.tsqId);
	if (tsqId === undefined) {
		return validationErrorResult("tsqId is required");
	}

	const owner =
		normalizeOptionalString(params.owner) ??
		normalizeOptionalString(params.assignee);
	const options = buildRunOptions(ctx.signal);

	let located: LocatedImport;
	try {
		located = await locateImportTasks(tsqId, ctx, options);
	} catch (error) {
		return importFailureResult(tsqId, error);
	}

	let prepared: PreparedImport;
	try {
		prepared = prepareImport(getState(), located.selected, owner);
	} catch (error) {
		return importFailureResult(tsqId, error);
	}

	commitState(prepared.state);
	const todoSnapshot = cloneTaskState(prepared.state);

	const data: ImportTsqSuccessData = {
		action: "import_tsq",
		tsqId,
		source: located.source,
		imported: prepared.imported,
		links: prepared.links,
		created: prepared.created,
		existing: prepared.existing,
		todoSnapshot,
	};

	return textToolResult(formatImportResult(data), okToolDetails(data));
};

async function locateImportTasks(
	tsqId: string,
	ctx: Parameters<TaskBridgeActionHandler<ImportTsqBridgeParams>>[1],
	options: { readonly timeout: number; readonly signal?: AbortSignal },
): Promise<LocatedImport> {
	const treeData = await runTsqJson<TsqTreeData | TsqTreeResult>(
		ctx.pi,
		{ cwd: ctx.cwd },
		FIND_TREE_ARGV,
		options,
	);
	const found = findTaskTreeNode(getTreeRoots(treeData), tsqId);
	if (found !== undefined) {
		return {
			source: "tree",
			selected: dedupeSelected([
				{ task: found.task, node: found },
				...found.children.map((child) => ({ task: child.task, node: child })),
			]),
		};
	}

	const showData = await runTsqJson<TsqShowData>(
		ctx.pi,
		{ cwd: ctx.cwd },
		[...SHOW_ARGV_PREFIX, tsqId],
		options,
	);
	const task = requireTask(showData.task, tsqId);
	return {
		source: "show",
		selected: [{ task }],
	};
}

function prepareImport(
	initialState: TaskState,
	selected: readonly SelectedTreeTask[],
	owner: string | undefined,
): PreparedImport {
	if (selected.length === 0) {
		throw new Error("no Tasque tasks selected for import");
	}

	let state = initialState;
	const todoIdByTsqId = new Map<string, number>();
	const createdTodoIds: number[] = [];
	const existingTodoIds = new Set<number>();

	for (const task of selectVisibleTasks(initialState)) {
		const tsqId = getTaskTsqId(task);
		if (tsqId !== undefined && !todoIdByTsqId.has(tsqId)) {
			todoIdByTsqId.set(tsqId, task.id);
		}
	}

	for (const item of selected) {
		if (todoIdByTsqId.has(item.task.id)) {
			const existingId = todoIdByTsqId.get(item.task.id);
			if (existingId !== undefined) existingTodoIds.add(existingId);
			continue;
		}

		const created = applyOrThrow(
			applyTaskMutation(state, "create", {
				subject: formatTodoSubject(item.task),
				metadata: { tsqId: item.task.id },
				...(owner === undefined ? {} : { owner }),
			}),
		);
		state = created.state;
		const todoId = getCreatedTodoId(created.op);
		createdTodoIds.push(todoId);
		todoIdByTsqId.set(item.task.id, todoId);
	}

	const blockedByByTsqId = deriveBlockedByTsqIds(selected);
	for (const item of selected) {
		const blockerTsqIds = blockedByByTsqId.get(item.task.id) ?? [];
		if (blockerTsqIds.length === 0) continue;
		const todoId = todoIdByTsqId.get(item.task.id);
		if (todoId === undefined) continue;
		const blockedBy = blockerTsqIds.flatMap((blockerTsqId) => {
			const blockerTodoId = todoIdByTsqId.get(blockerTsqId);
			return blockerTodoId === undefined ? [] : [blockerTodoId];
		});
		if (blockedBy.length === 0) continue;
		state = applyOrThrow(
			applyTaskMutation(state, "update", {
				id: todoId,
				addBlockedBy: blockedBy,
			}),
		).state;
	}

	const links = selected.map((item) => {
		const todoId = todoIdByTsqId.get(item.task.id);
		if (todoId === undefined) {
			throw new Error(`missing todo for imported Tasque task ${item.task.id}`);
		}
		return taskToLink(requireTodo(state, todoId), item.task.id);
	});
	const createdIdSet = new Set(createdTodoIds);
	const existingIdSet = new Set(existingTodoIds);
	const imported = selected.map((item) => {
		const todoId = todoIdByTsqId.get(item.task.id);
		if (todoId === undefined) {
			throw new Error(`missing todo for imported Tasque task ${item.task.id}`);
		}
		return {
			tsqId: item.task.id,
			title: item.task.title,
			todoId,
			created: createdIdSet.has(todoId),
			blockedBy: requireTodo(state, todoId).blockedBy ?? [],
		};
	});

	return {
		state,
		createdTodoIds,
		imported,
		links,
		created: links.filter((link) => createdIdSet.has(link.todoId)),
		existing: links.filter((link) => existingIdSet.has(link.todoId)),
	};
}

function deriveBlockedByTsqIds(
	selected: readonly SelectedTreeTask[],
): ReadonlyMap<string, readonly string[]> {
	const selectedIds = new Set(selected.map((item) => item.task.id));
	const blockedBy = new Map<string, string[]>();

	function add(blockedTsqId: string, blockerTsqId: string): void {
		if (blockedTsqId === blockerTsqId) return;
		if (!selectedIds.has(blockedTsqId) || !selectedIds.has(blockerTsqId))
			return;
		const current = blockedBy.get(blockedTsqId) ?? [];
		if (!current.includes(blockerTsqId)) current.push(blockerTsqId);
		blockedBy.set(blockedTsqId, current);
	}

	for (const item of selected) {
		const node = item.node;
		if (node === undefined) continue;
		for (const edge of node.blocker_edges.filter(isBlocksEdge)) {
			add(item.task.id, edge.id);
		}
		for (const edge of node.dependent_edges.filter(isBlocksEdge)) {
			add(edge.id, item.task.id);
		}
	}

	return blockedBy;
}

function getTreeRoots(
	data: TsqTreeData | TsqTreeResult,
): readonly TsqTaskTreeNode[] {
	if (Array.isArray(data)) {
		return data.filter(isTaskTreeNode);
	}
	const tree = (data as Partial<TsqTreeResult>).tree;
	return Array.isArray(tree) ? tree.filter(isTaskTreeNode) : [];
}

function findTaskTreeNode(
	roots: readonly TsqTaskTreeNode[],
	tsqId: string,
): TsqTaskTreeNode | undefined {
	for (const root of roots) {
		if (root.task.id === tsqId) return root;
		const child = findTaskTreeNode(root.children, tsqId);
		if (child !== undefined) return child;
	}
	return undefined;
}

function dedupeSelected(
	selected: readonly SelectedTreeTask[],
): readonly SelectedTreeTask[] {
	const seen = new Set<string>();
	const deduped: SelectedTreeTask[] = [];
	for (const item of selected) {
		if (seen.has(item.task.id)) continue;
		seen.add(item.task.id);
		deduped.push(item);
	}
	return deduped;
}

function applyOrThrow(result: ApplyResult): ApplyResult {
	if (result.op.kind === "error") {
		throw new Error(result.op.message);
	}
	return result;
}

function getCreatedTodoId(op: Op): number {
	if (op.kind === "create") {
		return op.taskId;
	}
	const message =
		op.kind === "error" ? op.message : `unexpected todo operation ${op.kind}`;
	throw new Error(`could not create imported todo: ${message}`);
}

function formatTodoSubject(task: TsqTask): string {
	return `Work on ${task.id}: ${task.title}`;
}

function getTaskTsqId(task: Task): string | undefined {
	const value = task.metadata?.tsqId;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function requireTodo(state: TaskState, todoId: number): Task {
	const todo = state.tasks.find((candidate) => candidate.id === todoId);
	if (todo === undefined || todo.status === "deleted") {
		throw new Error(`todo #${todoId} not found`);
	}
	return todo;
}

function taskToLink(task: Task, tsqId: string): TaskBridgeLink {
	return {
		todoId: task.id,
		todoSubject: task.subject,
		todoStatus: task.status as Exclude<TaskStatus, "deleted">,
		tsqId,
	};
}

function requireTask(value: unknown, requestedId: string): TsqTask {
	if (!isTsqTask(value)) {
		throw new Error(`tsq show ${requestedId} did not return task data`);
	}
	return value;
}

function isTaskTreeNode(value: unknown): value is TsqTaskTreeNode {
	return (
		isRecord(value) &&
		isTsqTask(value.task) &&
		Array.isArray(value.children) &&
		Array.isArray(value.blocker_edges) &&
		Array.isArray(value.dependent_edges)
	);
}

function isTsqTask(value: unknown): value is TsqTask {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.title === "string" &&
		typeof value.status === "string" &&
		typeof value.planning_state === "string" &&
		typeof value.priority === "number"
	);
}

function isBlocksEdge(edge: TsqDependencyRef): boolean {
	return edge.dep_type === "blocks";
}

function normalizeOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function buildRunOptions(signal: AbortSignal | undefined): {
	readonly timeout: number;
	readonly signal?: AbortSignal;
} {
	return {
		timeout: DEFAULT_TIMEOUT_MS,
		...(signal === undefined ? {} : { signal }),
	};
}

function validationErrorResult(
	message: string,
): AgentToolResult<TaskBridgeDetails> {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({ code: "validation_error", message }),
	);
}

function importFailureResult(
	tsqId: string,
	error: unknown,
): AgentToolResult<TaskBridgeDetails> {
	const message = getErrorMessage(error);
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({
			code: getErrorCode(error),
			message,
			details: {
				tsqId,
				error: serializeError(error),
			},
		}),
	);
}

function formatImportResult(data: ImportTsqSuccessData): string {
	const lines = [
		`Imported ${data.links.length} Tasque ${data.links.length === 1 ? "task" : "tasks"} from ${data.source}`,
	];
	for (const link of data.created) {
		lines.push(`Created todo #${link.todoId}: ${link.todoSubject}`);
	}
	for (const link of data.existing) {
		lines.push(`Existing todo #${link.todoId}: ${link.todoSubject}`);
	}
	return lines.join("\n");
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function getErrorCode(error: unknown): string {
	const record = asRecord(error);
	if (typeof record?.code === "string") {
		return record.code;
	}
	return "import_error";
}

function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
			...copyKnownErrorFields(error),
		};
	}
	return { value: String(error) };
}

function copyKnownErrorFields(error: Error): Record<string, unknown> {
	const record = error as unknown as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of [
		"code",
		"command",
		"details",
		"stderr",
		"stdout",
		"killed",
		"args",
	] as const) {
		if (record[key] !== undefined) {
			output[key] = record[key];
		}
	}
	return output;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return asRecord(value) !== undefined;
}
