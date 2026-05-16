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
import { resolveProjectRoot } from "./project.js";
import { executeTsqChange, type TsqChangeParams } from "./tools-change.js";
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
	"link",
	"list_links",
	"promote",
	"import",
] as const;

const FIND_TARGETS = ["ready", "open"] as const;
const VIEW_MODES = ["list", "tree"] as const;
const BRIDGE_DESTINATIONS = ["todo"] as const;

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
		to: Type.Optional(
			StringEnum(BRIDGE_DESTINATIONS, {
				description: "Bridge destination for import.",
			}),
		),
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
				"Manage durable project tasks: find, show, create, claim, update lifecycle, dependencies, and todo links.",
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
	return addProjectDetails(result, projectRoot);
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
		case "doctor":
		case "list_links":
			return { ok: true };
	}
}

function actionUsesTasque(action: TaskAction): boolean {
	return action !== "link" && action !== "list_links";
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
