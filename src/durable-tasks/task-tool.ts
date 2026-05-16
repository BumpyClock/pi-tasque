import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { executeTaskBridge } from "../bridge/bridge-tool.js";
import type { TaskBridgeHandlers, TaskBridgeParams } from "../bridge/types.js";
import {
	TASK_PROMPT_GUIDELINES,
	TASK_PROMPT_SNIPPET,
} from "../guidelines/task.js";
import { errorToolDetails, textToolResult } from "../shared/tool-result.js";
import { importTsqHandler } from "../bridge/import-tsq.js";
import { promoteTodoHandler } from "../bridge/promote-todo.js";
import {
	collectHandoffStatus,
	type HandoffCheckResult,
} from "./handoff-guard.js";
import { resolveProjectRoot } from "./project.js";
import {
	executeTsqChange,
	executeTsqMarkPlanned,
	type TsqChangeParams,
} from "./tools-change.js";
import { executeTsqSpec, type SpecMode } from "./tools-spec.js";
import {
	BULK_ITEM_ACTIONS,
	validateBulkItems,
	validateCreateTreeNode,
	type BulkItem,
	type CreateTreeNode,
} from "./bulk-contract.js";
import { executeBulk } from "./tools-bulk.js";
import { executeCreateTree } from "./tools-tree-create.js";
import { executeTsqClaim } from "./tools-claim.js";
import { executeTsqQuery, type TsqQueryParams } from "./tools-query.js";

export const TASK_TOOL_NAME = "task";

const TASK_ACTIONS = [
	"doctor",
	"find",
	"show",
	"deps",
	"notes",
	"similar",
	"create",
	"note",
	"finish",
	"reopen",
	"defer",
	"start",
	"claim",
	"block",
	"unblock",
	"order",
	"unorder",
	"spec",
	"mark_planned",
	"bulk",
	"create_tree",
	"handoff_check",
	"link",
	"list_links",
	"promote",
	"import",
] as const;

const FIND_TARGETS = ["ready", "open"] as const;
const VIEW_MODES = ["list", "tree"] as const;
const SPEC_MODES = ["show", "check", "set", "update"] as const;
const BRIDGE_DESTINATIONS = ["todo"] as const;

const BulkItemParamsSchema = Type.Object({
	action: StringEnum(BULK_ITEM_ACTIONS, {
		description:
			"Bulk item action: start, finish, reopen, defer, note, or mark_planned.",
	}),
	task: Type.String({ description: "Durable task id for this bulk item." }),
	because: Type.Optional(
		Type.String({
			description:
				"Note/reason text. Required for note; optional for finish/defer.",
		}),
	),
});

const CreateTreeNodeParamsSchema = Type.Object({
	title: Type.String({ description: "Durable task title for this node." }),
	kind: Type.String({ description: "Durable task kind for this node." }),
	priority: Type.Integer({
		description: "Durable task priority for this node.",
	}),
	description: Type.Optional(
		Type.String({ description: "Task description for this node." }),
	),
	planned: Type.Optional(
		Type.Boolean({ description: "Mark this node planned." }),
	),
	needsPlan: Type.Optional(
		Type.Boolean({ description: "Mark this node as needing planning." }),
	),
	children: Type.Optional(
		Type.Array(
			Type.Unknown({
				description:
					"Child create-tree nodes with the same shape: { title, kind, priority, description?, planned?, needsPlan?, children? }.",
			}),
			{ description: "Nested child task nodes." },
		),
	),
});

export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TaskParamsSchema = Type.Object(
	{
		action: StringEnum(TASK_ACTIONS, {
			description: "Durable task action to run.",
		}),
		task: Type.Optional(
			Type.String({
				description: "Durable task id for existing tasks, or title for create.",
			}),
		),
		tasks: Type.Optional(
			StringEnum(FIND_TARGETS, {
				description: "Task set for find actions.",
			}),
		),
		view: Type.Optional(
			StringEnum(VIEW_MODES, {
				description: "Find output view.",
			}),
		),
		lane: Type.Optional(
			Type.String({ description: "Ready-task lane, e.g. planning or coding." }),
		),
		for: Type.Optional(
			Type.String({ description: "Assignee or owner for claim/find/import." }),
		),
		query: Type.Optional(
			Type.String({ description: "Search text for similar task lookup." }),
		),
		with: Type.Optional(
			Type.Array(
				Type.String({ description: "Extra context to include, e.g. spec." }),
			),
		),
		kind: Type.Optional(Type.String({ description: "Durable task kind." })),
		priority: Type.Optional(
			Type.Integer({ description: "Durable task priority." }),
		),
		description: Type.Optional(
			Type.String({ description: "Task description for create/promote." }),
		),
		under: Type.Optional(
			Type.String({
				description: "Parent durable task id for create/promote.",
			}),
		),
		planned: Type.Optional(
			Type.Boolean({ description: "Mark created/promoted task planned." }),
		),
		needsPlan: Type.Optional(
			Type.Boolean({
				description: "Mark created/promoted task as needing planning.",
			}),
		),
		because: Type.Optional(
			Type.String({
				description: "Note or reason text for lifecycle actions.",
			}),
		),
		by: Type.Optional(
			Type.String({
				description: "Blocking durable task id for block/unblock.",
			}),
		),
		after: Type.Optional(
			Type.String({
				description: "Earlier durable task id for order/unorder.",
			}),
		),
		start: Type.Optional(
			Type.Boolean({
				description: "Start task while claiming. Defaults true.",
			}),
		),
		requireSpec: Type.Optional(
			Type.Boolean({ description: "Require an attached spec before claim." }),
		),
		todo: Type.Optional(
			Type.Union([
				Type.Boolean({ description: "Create a linked todo for claim." }),
				Type.Integer({ description: "Session todo id for link/promote." }),
			]),
		),
		mode: Type.Optional(
			StringEnum(SPEC_MODES, {
				description: "Spec operation mode for spec action.",
			}),
		),
		text: Type.Optional(
			Type.String({
				description: "Spec text content for spec set/update.",
			}),
		),
		to: Type.Optional(
			StringEnum(BRIDGE_DESTINATIONS, {
				description: "Bridge destination for import.",
			}),
		),
		items: Type.Optional(
			Type.Array(BulkItemParamsSchema, {
				description:
					"Bulk lifecycle items. Each item has { action, task, because? }.",
				minItems: 1,
			}),
		),
		root: Type.Optional(CreateTreeNodeParamsSchema),
	},
	{ additionalProperties: false },
);

export type TaskParams = Static<typeof TaskParamsSchema>;

const DEFAULT_HANDLERS: TaskBridgeHandlers = {
	promote_todo: promoteTodoHandler,
	import_tsq: importTsqHandler,
};

export function registerTaskTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: TASK_TOOL_NAME,
			label: "Task",
			description:
				"Manage durable project tasks: find, show, create, claim, specs, bulk changes, handoff checks, lifecycle, dependencies, and todo links.",
			promptSnippet: TASK_PROMPT_SNIPPET,
			promptGuidelines: TASK_PROMPT_GUIDELINES,
			parameters: TaskParamsSchema,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeTaskTool(pi, params as TaskParams, signal, ctx);
			},
		}),
	);
}

export async function executeTaskTool(
	pi: ExtensionAPI,
	params: TaskParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const validation = validateTaskParams(params);
	if (!validation.ok) {
		return validationErrorResult(validation.message);
	}

	const needsProject = actionUsesTasque(params.action);
	let projectRoot = ctx.cwd;
	if (needsProject) {
		try {
			projectRoot = await resolveProjectRoot(
				pi,
				ctx.cwd,
				signal === undefined ? {} : { signal },
			);
		} catch (error) {
			return errorResult("project_root_error", getErrorMessage(error), {
				action: params.action,
				cwd: ctx.cwd,
				error: serializeError(error),
			});
		}
	}

	const taskCtx = { ...ctx, cwd: projectRoot };
	const result = await dispatchTaskAction(pi, params, signal, taskCtx);
	return params.action === "handoff_check"
		? result
		: addProjectDetails(result, projectRoot);
}

async function dispatchTaskAction(
	pi: ExtensionAPI,
	params: TaskParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	switch (params.action) {
		case "doctor":
		case "find":
		case "show":
		case "deps":
		case "notes":
		case "similar":
			return executeTsqQuery(pi, toQueryParams(params), signal, ctx);
		case "create":
		case "note":
		case "finish":
		case "reopen":
		case "defer":
		case "start":
		case "block":
		case "unblock":
		case "order":
		case "unorder":
			return executeTsqChange(pi, toChangeParams(params), signal, ctx);
		case "claim":
			return executeTsqClaim(pi, toClaimParams(params), signal, ctx);
		case "spec":
			return executeTsqSpec(
				pi,
				{ id: params.task, mode: params.mode as SpecMode, text: params.text },
				signal,
				ctx,
			);
		case "mark_planned":
			return executeTsqMarkPlanned(pi, params.task!, signal, ctx);
		case "bulk":
			return executeBulk(pi, params.items as BulkItem[], signal, ctx);
		case "create_tree":
			return executeCreateTree(pi, params.root as CreateTreeNode, signal, ctx);
		case "handoff_check":
			return executeHandoffCheck(pi, signal, ctx);
		case "link":
		case "list_links":
		case "promote":
		case "import":
			return executeTaskBridge(
				pi,
				toBridgeParams(params),
				signal,
				ctx,
				DEFAULT_HANDLERS,
			);
	}
}

async function executeHandoffCheck(
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<unknown>> {
	const result = await collectHandoffStatus({
		pi,
		cwd: ctx.cwd,
		...(signal != null ? { signal } : {}),
	});

	if (!result.ok) {
		return textToolResult(
			`Error: ${result.message}`,
			errorToolDetails({ code: result.code, message: result.message }),
		);
	}

	return textToolResult(formatHandoffText(result), {
		ok: true,
		ready: result.ready,
		...formatHandoffDetails(result),
	});
}

function formatHandoffText(result: HandoffCheckResult & { ok: true }): string {
	const lines: string[] = [
		result.ready
			? "Handoff ready: all session todos complete and linked tasks resolved."
			: "Handoff not ready.",
	];

	if ("todoBlockers" in result && result.todoBlockers?.length) {
		lines.push("", "Todo blockers:");
		for (const b of result.todoBlockers) {
			lines.push(`- #${b.todoId} "${b.subject}" — ${b.reason}`);
		}
	}

	if ("linkedBlockers" in result && result.linkedBlockers?.length) {
		lines.push("", "Linked task blockers:");
		for (const b of result.linkedBlockers) {
			lines.push(`- ${b.tsqId} (todo #${b.todoId}) — ${b.status}`);
		}
	}

	if ("linkedWarnings" in result && result.linkedWarnings?.length) {
		lines.push("", "Warnings:");
		for (const w of result.linkedWarnings) {
			lines.push(`- ${w.tsqId} (todo #${w.todoId}) — ${w.status}`);
		}
	}

	if ("readErrors" in result && result.readErrors?.length) {
		lines.push("", "Read errors:");
		for (const e of result.readErrors) {
			lines.push(`- ${e.tsqId} — ${e.code}: ${e.message}`);
		}
	}

	return lines.join("\n");
}

function formatHandoffDetails(
	result: HandoffCheckResult & { ok: true },
): Record<string, unknown> {
	const details: Record<string, unknown> = {};
	if (result.projectRoot !== undefined) {
		details.projectRoot = result.projectRoot;
	}
	if ("todoBlockers" in result && result.todoBlockers?.length) {
		details.todoBlockers = result.todoBlockers;
	}
	if ("linkedBlockers" in result && result.linkedBlockers?.length) {
		details.linkedBlockers = result.linkedBlockers;
	}
	if ("linkedWarnings" in result && result.linkedWarnings?.length) {
		details.linkedWarnings = result.linkedWarnings;
	}
	if ("readErrors" in result && result.readErrors?.length) {
		details.readErrors = result.readErrors;
	}
	return details;
}

function toQueryParams(params: TaskParams): TsqQueryParams {
	switch (params.action) {
		case "doctor":
			return { action: "doctor" };
		case "find":
			if (params.view === "tree") {
				return definedParams<TsqQueryParams>({
					action: "find_tree",
					id: params.task,
				});
			}
			return params.tasks === "open"
				? definedParams<TsqQueryParams>({
						action: "find_open",
						assignee: params.for,
					})
				: definedParams<TsqQueryParams>({
						action: "find_ready",
						lane: params.lane,
						assignee: params.for,
					});
		case "show":
			return definedParams<TsqQueryParams>({
				action: hasWith(params, "spec") ? "show_with_spec" : "show",
				id: params.task,
			});
		case "deps":
			return definedParams<TsqQueryParams>({ action: "deps", id: params.task });
		case "notes":
			return definedParams<TsqQueryParams>({
				action: "notes",
				id: params.task,
			});
		case "similar":
			return definedParams<TsqQueryParams>({
				action: "similar",
				query: params.query,
			});
		default:
			throw new Error(`Unsupported query action: ${params.action}`);
	}
}

function toChangeParams(params: TaskParams): TsqChangeParams {
	switch (params.action) {
		case "create":
			return definedParams<TsqChangeParams>({
				action: "create",
				title: params.task,
				kind: params.kind,
				priority: params.priority,
				description: params.description,
				parent: params.under,
				planned: params.planned,
				needsPlan: params.needsPlan,
			});
		case "note":
			return definedParams<TsqChangeParams>({
				action: "note",
				id: params.task,
				note: params.because,
			});
		case "finish":
			return definedParams<TsqChangeParams>({
				action: "done",
				id: params.task,
				note: params.because,
			});
		case "reopen":
		case "start":
			return definedParams<TsqChangeParams>({
				action: params.action,
				id: params.task,
			});
		case "defer":
			return definedParams<TsqChangeParams>({
				action: "defer",
				id: params.task,
				note: params.because,
			});
		case "block":
			return definedParams<TsqChangeParams>({
				action: "block",
				child: params.task,
				blocker: params.by,
			});
		case "unblock":
			return definedParams<TsqChangeParams>({
				action: "unblock",
				child: params.task,
				blocker: params.by,
			});
		case "order":
			return definedParams<TsqChangeParams>({
				action: "order",
				later: params.task,
				earlier: params.after,
			});
		case "unorder":
			return definedParams<TsqChangeParams>({
				action: "unorder",
				later: params.task,
				earlier: params.after,
			});
		default:
			throw new Error(`Unsupported change action: ${params.action}`);
	}
}

function toClaimParams(params: TaskParams): Readonly<Record<string, unknown>> {
	return definedParams<Readonly<Record<string, unknown>>>({
		id: params.task,
		assignee: params.for,
		start: params.start,
		requireSpec: params.requireSpec,
		createTodo: params.todo === true,
	});
}

function toBridgeParams(params: TaskParams): TaskBridgeParams {
	switch (params.action) {
		case "link":
			return definedParams<TaskBridgeParams>({
				action: "link",
				todoId: getTodoId(params.todo),
				tsqId: params.task,
			});
		case "list_links":
			return { action: "list_links" };
		case "promote":
			return definedParams<TaskBridgeParams>({
				action: "promote_todo",
				todoId: getTodoId(params.todo),
				assignee: params.for,
				kind: params.kind,
				priority: params.priority,
				description: params.description,
				parent: params.under,
				planned: params.planned,
				needsPlan: params.needsPlan,
			});
		case "import":
			return definedParams<TaskBridgeParams>({
				action: "import_tsq",
				tsqId: params.task,
				owner: params.for,
			});
		default:
			throw new Error(`Unsupported bridge action: ${params.action}`);
	}
}

function definedParams<T>(params: Record<string, unknown>): T {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output as T;
}

function validateTaskParams(
	params: TaskParams,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	switch (params.action) {
		case "find":
			if (params.view === "tree") return { ok: true };
			if (params.tasks === undefined) return fieldRequired("tasks");
			return { ok: true };
		case "show":
		case "deps":
		case "notes":
		case "note":
		case "finish":
		case "reopen":
		case "defer":
		case "start":
		case "claim":
		case "import":
			return requireStringField(params.task, "task");
		case "create": {
			const task = requireStringField(params.task, "task");
			if (!task.ok) return task;
			const kind = requireStringField(params.kind, "kind");
			if (!kind.ok) return kind;
			return typeof params.priority === "number"
				? { ok: true }
				: fieldRequired("priority");
		}
		case "similar":
			return requireStringField(params.query, "query");
		case "block":
		case "unblock": {
			const task = requireStringField(params.task, "task");
			if (!task.ok) return task;
			return requireStringField(params.by, "by");
		}
		case "order":
		case "unorder": {
			const task = requireStringField(params.task, "task");
			if (!task.ok) return task;
			return requireStringField(params.after, "after");
		}
		case "link": {
			const todo = requireTodoId(params.todo);
			if (!todo.ok) return todo;
			return requireStringField(params.task, "task");
		}
		case "promote":
			return requireTodoId(params.todo);
		case "mark_planned":
			return requireStringField(params.task, "task");
		case "spec": {
			const task = requireStringField(params.task, "task");
			if (!task.ok) return task;
			const mode = params.mode as string | undefined;
			if (mode === undefined || mode.trim().length === 0)
				return fieldRequired("mode");
			const isRead = mode === "show" || mode === "check";
			const isWrite = mode === "set" || mode === "update";
			if (!isRead && !isWrite)
				return {
					ok: false,
					message: "mode must be show, check, set, or update",
				};
			if (isRead && params.text !== undefined)
				return {
					ok: false,
					message: `spec ${mode} does not accept text`,
				};
			if (isWrite) {
				const text = params.text?.trim();
				if (text === undefined || text.length === 0)
					return {
						ok: false,
						message: `spec ${mode} requires text`,
					};
			}
			return { ok: true };
		}
		case "bulk":
			return validateBulkItems(params.items);
		case "create_tree":
			return validateCreateTreeNode(params.root);
		case "handoff_check":
		case "doctor":
		case "list_links":
			return { ok: true };
	}
}

function actionUsesTasque(action: TaskAction): boolean {
	return (
		action !== "link" && action !== "list_links" && action !== "handoff_check"
	);
}

function hasWith(params: TaskParams, value: string): boolean {
	return Array.isArray(params.with) && params.with.includes(value);
}

function getTodoId(value: boolean | number | undefined): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function requireTodoId(
	value: boolean | number | undefined,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? { ok: true }
		: fieldRequired("todo");
}

function requireStringField(
	value: string | undefined,
	field: string,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	return typeof value === "string" && value.trim().length > 0
		? { ok: true }
		: fieldRequired(field);
}

function fieldRequired(field: string): {
	readonly ok: false;
	readonly message: string;
} {
	return { ok: false, message: `${field} is required` };
}

function validationErrorResult(message: string): AgentToolResult<unknown> {
	return errorResult("validation_error", message);
}

function errorResult(
	code: string,
	message: string,
	details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({ code, message, details }),
	);
}

function addProjectDetails(
	result: AgentToolResult<unknown>,
	projectRoot: string,
): AgentToolResult<unknown> {
	const details = isRecord(result.details)
		? { ...result.details, projectRoot }
		: { projectRoot };
	return { ...result, details };
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serializeError(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(error.stack === undefined ? {} : { stack: error.stack }),
		};
	}
	return { value: String(error) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
