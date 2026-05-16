import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { executeTaskBridge } from "../bridge/bridge-tool.js";
import type { TaskBridgeHandlers } from "../bridge/types.js";
import {
	TASK_PROMPT_GUIDELINES,
	TASK_PROMPT_SNIPPET,
} from "../guidelines/task.js";
import { isRecord } from "../shared/error-utils.js";
import { errorToolDetails, textToolResult } from "../shared/tool-result.js";
import { importTsqHandler } from "../bridge/import-tsq.js";
import { promoteTodoHandler } from "../bridge/promote-todo.js";
import type { BulkItem, CreateTreeNode } from "./bulk-contract.js";
import { resolveProjectRoot } from "./project.js";
import {
	TASK_TOOL_NAME,
	TaskParamsSchema,
	type TaskAction,
	type TaskParams,
} from "./task-schema.js";
import { actionUsesTasque, validateTaskParams } from "./task-validation.js";
import {
	toBridgeParams,
	toChangeParams,
	toClaimParams,
	toQueryParams,
} from "./task-mappers.js";
import { executeBulk } from "./tools-bulk.js";
import { executeTsqChange, executeTsqMarkPlanned } from "./tools-change.js";
import { executeTsqClaim } from "./tools-claim.js";
import { executeHandoffCheck } from "./tools-handoff.js";
import { executeTsqQuery } from "./tools-query.js";
import { executeTsqSpec, type SpecMode } from "./tools-spec.js";
import { executeCreateTree } from "./tools-tree-create.js";

// --- Re-exports for backward compatibility ---
export { TASK_TOOL_NAME, TaskParamsSchema, type TaskParams, type TaskAction } from "./task-schema.js";

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
