import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	TASK_TODO_BRIDGE_PROMPT_GUIDELINES,
	TASK_TODO_BRIDGE_PROMPT_SNIPPET,
} from "../guidelines/internal-tools.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";
import { deriveTaskLinks, linkTodoToTsq } from "./link-store.js";
import {
	TASK_BRIDGE_TOOL_NAME,
	TaskBridgeParamsSchema,
	type ImportTsqBridgeParams,
	type LinkBridgeParams,
	type ListLinksBridgeParams,
	type PromoteTodoBridgeParams,
	type TaskBridgeAction,
	type TaskBridgeDetails,
	type TaskBridgeHandlerContext,
	type TaskBridgeHandlers,
	type TaskBridgeLink,
	type TaskBridgeParams,
} from "./types.js";

export function registerTaskBridgeTool(
	pi: ExtensionAPI,
	handlers: TaskBridgeHandlers = {},
): void {
	pi.registerTool(
		defineTool({
			name: TASK_BRIDGE_TOOL_NAME,
			label: "Task Todo Bridge",
			description:
				"Link session todos and durable tasks. No automatic lifecycle sync.",
			promptSnippet: TASK_TODO_BRIDGE_PROMPT_SNIPPET,
			promptGuidelines: TASK_TODO_BRIDGE_PROMPT_GUIDELINES,
			parameters: TaskBridgeParamsSchema,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeTaskBridge(pi, params, signal, ctx, handlers);
			},
		}),
	);
}

export async function executeTaskBridge(
	pi: ExtensionAPI,
	params: TaskBridgeParams,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	handlers: TaskBridgeHandlers = {},
): Promise<AgentToolResult<TaskBridgeDetails>> {
	switch (params.action) {
		case "link":
			return executeLink(params as LinkBridgeParams);
		case "list_links":
			return executeListLinks(params as ListLinksBridgeParams);
		case "promote_todo":
			return executeInjectedHandler(
				"promote_todo",
				handlers.promote_todo,
				params as PromoteTodoBridgeParams,
				buildHandlerContext(pi, ctx, signal),
			);
		case "import_tsq":
			return executeInjectedHandler(
				"import_tsq",
				handlers.import_tsq,
				params as ImportTsqBridgeParams,
				buildHandlerContext(pi, ctx, signal),
			);
		default:
			return errorResult(
				"validation_error",
				"action must be a supported task/todo bridge action",
			);
	}
}

function executeLink(
	params: LinkBridgeParams,
): AgentToolResult<TaskBridgeDetails> {
	if (typeof params.todoId !== "number" || !Number.isInteger(params.todoId)) {
		return errorResult("validation_error", "todoId is required");
	}
	if (typeof params.tsqId !== "string") {
		return errorResult("validation_error", "tsqId is required");
	}

	const result = linkTodoToTsq(params.todoId, params.tsqId);
	if (!result.ok) {
		return errorResult("validation_error", result.message);
	}

	return textToolResult(
		`Linked todo #${result.link.todoId} to ${result.link.tsqId}`,
		okToolDetails({
			action: "link",
			link: result.link,
			todo: result.todo,
		}),
	);
}

function executeListLinks(
	_params: ListLinksBridgeParams,
): AgentToolResult<TaskBridgeDetails> {
	const links = deriveTaskLinks();
	return textToolResult(
		formatLinks(links),
		okToolDetails({ action: "list_links", links }),
	);
}

async function executeInjectedHandler<TParams extends TaskBridgeParams>(
	action: TaskBridgeAction,
	handler:
		| ((
				params: TParams,
				ctx: TaskBridgeHandlerContext,
		  ) =>
				| AgentToolResult<TaskBridgeDetails>
				| Promise<AgentToolResult<TaskBridgeDetails>>)
		| undefined,
	params: TParams,
	ctx: TaskBridgeHandlerContext,
): Promise<AgentToolResult<TaskBridgeDetails>> {
	if (handler === undefined) {
		return notImplementedResult(action);
	}
	return handler(params, ctx);
}

function buildHandlerContext(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
): TaskBridgeHandlerContext {
	return {
		pi,
		cwd: ctx.cwd,
		extensionContext: ctx,
		...(signal === undefined ? {} : { signal }),
	};
}

function notImplementedResult(
	action: "promote_todo" | "import_tsq" | TaskBridgeAction,
): AgentToolResult<TaskBridgeDetails> {
	return errorResult(
		"not_implemented",
		`task/todo bridge action ${action} handler is not configured`,
	);
}

function errorResult(
	code: "validation_error" | "not_implemented",
	message: string,
): AgentToolResult<TaskBridgeDetails> {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({ code, message }),
	);
}

function formatLinks(links: readonly TaskBridgeLink[]): string {
	if (links.length === 0) return "No linked todos";
	return [
		`${links.length} linked ${links.length === 1 ? "todo" : "todos"}`,
		...links.map(
			(link) => `#${link.todoId} ${link.todoSubject} ↔ ${link.tsqId}`,
		),
	].join("\n");
}
