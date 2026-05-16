import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	CHANGE_TASKS_PROMPT_GUIDELINES,
	CHANGE_TASKS_PROMPT_SNIPPET,
} from "../guidelines/internal-tools.js";
import {
	asRecord,
	copyKnownErrorFields,
} from "../shared/error-utils.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";
import {
	buildMutationCommand,
	TSQ_CHANGE_ACTIONS,
	type TsqChangeAction,
} from "./change-command-builder.js";
import { runQueuedMutation } from "./mutation-queue.js";
import { runTsqJson } from "./runner.js";

export const TSQ_CHANGE_TOOL_NAME = "tsq_change";

export type { TsqChangeAction } from "./change-command-builder.js";

export const TsqChangeParamsSchema = Type.Object(
	{
		action: StringEnum(TSQ_CHANGE_ACTIONS, {
			description: "Durable task mutation to run",
		}),
		title: Type.Optional(
			Type.String({ description: "Task title (required for create)" }),
		),
		id: Type.Optional(
			Type.String({
				description: "Durable task id for lifecycle/note/claim actions",
			}),
		),
		kind: Type.Optional(
			Type.String({ description: "Durable task kind (required for create)" }),
		),
		priority: Type.Optional(
			Type.Integer({
				description: "Durable task priority (required for create)",
			}),
		),
		description: Type.Optional(
			Type.String({ description: "Task description (create only)" }),
		),
		parent: Type.Optional(
			Type.String({ description: "Parent durable task id (create only)" }),
		),
		planned: Type.Optional(
			Type.Boolean({ description: "Mark created task planned" }),
		),
		needsPlan: Type.Optional(
			Type.Boolean({ description: "Mark created task as needing planning" }),
		),
		assignee: Type.Optional(
			Type.String({
				description: "Assignee for claim_assign_only",
			}),
		),
		note: Type.Optional(
			Type.String({
				description: "Note text for note, done, and defer actions",
			}),
		),
		child: Type.Optional(
			Type.String({
				description: "Task id of the blocked task for block/unblock actions",
			}),
		),
		blocker: Type.Optional(
			Type.String({
				description: "Task id blocking child for block/unblock actions",
			}),
		),
		later: Type.Optional(
			Type.String({
				description: "Task id ordered after earlier for order/unorder actions",
			}),
		),
		earlier: Type.Optional(
			Type.String({
				description:
					"Task id that must happen before later for order/unorder actions",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TsqChangeParams = Static<typeof TsqChangeParamsSchema>;

export interface TsqChangeSuccessData {
	readonly action: TsqChangeAction;
	readonly argv: readonly string[];
	readonly result: unknown;
}

export type TsqChangeDetails = ReturnType<
	typeof okToolDetails<TsqChangeSuccessData>
>;

export function registerTsqChangeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: TSQ_CHANGE_TOOL_NAME,
			label: "Task Change",
			description:
				"Mutate durable tasks: lifecycle, notes, ownership, dependencies, and sequencing.",
			promptSnippet: CHANGE_TASKS_PROMPT_SNIPPET,
			promptGuidelines: CHANGE_TASKS_PROMPT_GUIDELINES,
			parameters: TsqChangeParamsSchema,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeTsqChange(pi, params as TsqChangeParams, signal, ctx);
			},
		}),
	);
}

export async function executeTsqChange(
	pi: ExtensionAPI,
	params: TsqChangeParams,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<TsqChangeDetails>> {
	const command = buildMutationCommand(
		params as Readonly<Record<string, unknown>>,
	);
	if (!command.ok) {
		return validationErrorResult(command.message);
	}

	try {
		const result = await runMutation(pi, ctx, command.argv, signal);
		return textToolResult(
			formatSuccess(command.action, params, result),
			okToolDetails({
				action: command.action,
				argv: command.argv,
				result,
			}),
		);
	} catch (error) {
		const message = getErrorMessage(error);
		return textToolResult(
			`Error: ${message}`,
			errorToolDetails({
				code: getErrorCode(error),
				message,
				details: {
					action: command.action,
					argv: command.argv,
					error: serializeError(error),
				},
			}),
		);
	}
}

// --- mark_planned helper (tsq-5.2) ---

export interface TsqMarkPlannedSuccessData {
	readonly argv: readonly string[];
	readonly result: unknown;
}

export type TsqMarkPlannedDetails = ReturnType<
	typeof okToolDetails<TsqMarkPlannedSuccessData>
>;

export async function executeTsqMarkPlanned(
	pi: ExtensionAPI,
	taskId: string,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<TsqMarkPlannedDetails>> {
	const trimmed = taskId.trim();
	if (trimmed.length === 0) {
		return validationErrorResult("task id is required");
	}

	const argv = ["planned", trimmed];

	try {
		const result = await runMutation(pi, ctx, argv, signal);
		return textToolResult(
			`Marked ${trimmed} as planned`,
			okToolDetails({ argv, result }),
		);
	} catch (error) {
		const message = getErrorMessage(error);
		return textToolResult(
			`Error: ${message}`,
			errorToolDetails({
				code: getErrorCode(error),
				message,
				details: {
					argv,
					error: serializeError(error),
				},
			}),
		);
	}
}

function runMutation(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	argv: readonly string[],
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const options = signal === undefined ? {} : { signal };
	return runQueuedMutation(ctx.cwd, () =>
		runTsqJson(pi, { cwd: ctx.cwd }, argv, options),
	);
}

function validationErrorResult(message: string) {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({
			code: "validation_error",
			message,
		}),
	);
}

function formatSuccess(
	action: TsqChangeAction,
	params: TsqChangeParams,
	result: unknown,
): string {
	const task = extractTaskLike(result);
	const id = task.id ?? params.id;
	const title = task.title ?? params.title;

	switch (action) {
		case "create":
			return formatCreated(id, title);
		case "note":
			return `Added note to ${id ?? "task"}`;
		case "done":
			return `Marked done ${id ?? "task"}`;
		case "reopen":
			return `Reopened ${id ?? "task"}`;
		case "defer":
			return `Deferred ${id ?? "task"}`;
		case "start":
			return `Started ${id ?? "task"}`;
		case "claim_assign_only":
			return `Assigned ${id ?? "task"} to ${params.assignee ?? "assignee"}`;
		case "block":
			return `Added block edge: ${params.child ?? "child"} blocked by ${params.blocker ?? "blocker"}`;
		case "unblock":
			return `Removed block edge: ${params.child ?? "child"} no longer blocked by ${params.blocker ?? "blocker"}`;
		case "order":
			return `Added order edge: ${params.later ?? "later"} after ${params.earlier ?? "earlier"}`;
		case "unorder":
			return `Removed order edge: ${params.later ?? "later"} no longer ordered after ${params.earlier ?? "earlier"}`;
	}
}

function formatCreated(
	id: string | undefined,
	title: string | undefined,
): string {
	if (id !== undefined && title !== undefined) {
		return `Created ${id}: ${title}`;
	}
	if (id !== undefined) {
		return `Created ${id}`;
	}
	if (title !== undefined) {
		return `Created task: ${title}`;
	}
	return "Created task";
}

function extractTaskLike(result: unknown): {
	readonly id: string | undefined;
	readonly title: string | undefined;
} {
	const root = asRecord(result);
	const candidate = asRecord(root?.task) ?? root;
	return {
		id: typeof candidate?.id === "string" ? candidate.id : undefined,
		title: typeof candidate?.title === "string" ? candidate.title : undefined,
	};
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
	return "tsq_error";
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
