import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { runQueuedMutation } from "../durable-tasks/mutation-queue.js";
import { runTsqJson } from "../durable-tasks/runner.js";
import { cloneTaskState } from "../session-todos/state/state.js";
import { applyTaskMutation } from "../session-todos/state/state-reducer.js";
import { commitState, getState } from "../session-todos/state/store.js";
import type { Task } from "../session-todos/tool/types.js";
import { isRecord } from "../shared/error-utils.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";
import type {
	PromoteTodoBridgeParams,
	TaskBridgeDetails,
	TaskBridgeHandlerContext,
} from "./types.js";

const DEFAULT_KIND = "task";
const DEFAULT_PRIORITY = 2;
const DEFAULT_PROMOTED_BY = "pi";
const PROMOTION_NOTE_PREFIX = "Promoted from pi-tasque session todo #";

interface ValidPromotionParams {
	readonly todoId: number;
	readonly kind: string;
	readonly priority: number;
	readonly description?: string;
	readonly parent?: string;
	readonly planned?: boolean;
	readonly needsPlan?: boolean;
	readonly promotedBy: string;
}

export async function promoteTodoHandler(
	params: PromoteTodoBridgeParams,
	ctx: TaskBridgeHandlerContext,
): Promise<AgentToolResult<TaskBridgeDetails>> {
	const validation = validateParams(params);
	if (!validation.ok) {
		return errorResult("validation_error", validation.message);
	}

	const todo = findPromotableTodo(validation.value.todoId);
	if (!todo.ok) {
		return errorResult("validation_error", todo.message);
	}

	const similarArgv = ["find", "similar", todo.value.subject];
	let similarResult: unknown;
	try {
		similarResult = await runTsqJson(ctx.pi, { cwd: ctx.cwd }, similarArgv, {
			...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
		});
	} catch (error) {
		return errorResult(getErrorCode(error), getErrorMessage(error), {
			action: "promote_todo",
			argv: { similar: similarArgv },
			error: serializeError(error),
		});
	}
	const similarCandidates = extractSimilarCandidates(similarResult);

	const createArgv = buildCreateArgv(todo.value, validation.value);
	let createResult: unknown;
	try {
		createResult = await runQueuedMutation(ctx.cwd, () =>
			runTsqJson(ctx.pi, { cwd: ctx.cwd }, createArgv, {
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			}),
		);
	} catch (error) {
		return errorResult(getErrorCode(error), getErrorMessage(error), {
			action: "promote_todo",
			similarCandidates,
			argv: { similar: similarArgv, create: createArgv },
			error: serializeError(error),
		});
	}

	const tsqId = extractCreatedTaskId(createResult);
	if (tsqId === undefined) {
		return errorResult(
			"invalid_tsq_response",
			"tsq create response did not include a task id",
			{
				action: "promote_todo",
				similarCandidates,
				argv: { similar: similarArgv, create: createArgv },
				result: createResult,
			},
		);
	}

	const noteText = `${PROMOTION_NOTE_PREFIX}${validation.value.todoId}`;
	const noteArgv = ["note", tsqId, "--", noteText];
	let noteResult: unknown;
	const warnings: string[] = [];
	try {
		noteResult = await runQueuedMutation(ctx.cwd, () =>
			runTsqJson(ctx.pi, { cwd: ctx.cwd }, noteArgv, {
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			}),
		);
	} catch (error) {
		warnings.push(
			`Failed to add promotion note to ${tsqId}: ${getErrorMessage(error)}`,
		);
	}

	const promotedAt = new Date().toISOString();
	const updateResult = applyTaskMutation(getState(), "update", {
		id: validation.value.todoId,
		status: "completed",
		metadata: {
			tsqId,
			promotedAt,
			promotedBy: validation.value.promotedBy,
		},
	});
	if (updateResult.op.kind === "error") {
		return errorResult("todo_update_failed", updateResult.op.message, {
			action: "promote_todo",
			tsqId,
			similarCandidates,
			argv: { similar: similarArgv, create: createArgv, note: noteArgv },
			createResult,
			noteResult,
			warnings,
		});
	}
	commitState(updateResult.state);
	const todoSnapshot = cloneTaskState(updateResult.state);
	const updatedTodo = todoSnapshot.tasks.find(
		(task) => task.id === validation.value.todoId,
	);

	const content = [`Promoted todo #${validation.value.todoId} to ${tsqId}`];
	if (warnings.length > 0) {
		content.push(...warnings.map((warning) => `Warning: ${warning}`));
	}

	return textToolResult(
		content.join("\n"),
		okToolDetails(
			{
				action: "promote_todo" as const,
				todo: updatedTodo,
				tsqId,
				todoSnapshot,
				similarCandidates,
				createResult,
				noteResult,
				argv: {
					similar: similarArgv,
					create: createArgv,
					note: noteArgv,
				},
			},
			warnings.length === 0 ? {} : { warnings },
		),
	);
}

function validateParams(
	params: PromoteTodoBridgeParams,
):
	| { readonly ok: true; readonly value: ValidPromotionParams }
	| { readonly ok: false; readonly message: string } {
	const todoId = params.todoId;
	if (typeof todoId !== "number" || !Number.isInteger(todoId) || todoId < 1) {
		return { ok: false, message: "todoId is required" };
	}

	const kind = params.kind === undefined ? DEFAULT_KIND : params.kind.trim();
	if (kind.length === 0) {
		return { ok: false, message: "kind must be a non-empty string" };
	}

	const priority = params.priority ?? DEFAULT_PRIORITY;
	if (!Number.isInteger(priority)) {
		return { ok: false, message: "priority must be an integer" };
	}

	const planned = params.planned;
	const needsPlan = params.needsPlan;
	if (planned === true && needsPlan === true) {
		return {
			ok: false,
			message: "planned and needsPlan cannot both be true",
		};
	}

	const promotedBy =
		normalizeOptionalString(params.assignee) ?? DEFAULT_PROMOTED_BY;
	const description = normalizeOptionalString(params.description);
	const parent = normalizeOptionalString(params.parent);

	return {
		ok: true,
		value: {
			todoId,
			kind,
			priority,
			promotedBy,
			...(description === undefined ? {} : { description }),
			...(parent === undefined ? {} : { parent }),
			...(planned === undefined ? {} : { planned }),
			...(needsPlan === undefined ? {} : { needsPlan }),
		},
	};
}

function findPromotableTodo(
	todoId: number,
):
	| { readonly ok: true; readonly value: Task }
	| { readonly ok: false; readonly message: string } {
	const todo = getState().tasks.find((task) => task.id === todoId);
	if (todo === undefined) {
		return { ok: false, message: `todo #${todoId} not found` };
	}
	if (todo.status === "deleted") {
		return { ok: false, message: `todo #${todoId} is deleted` };
	}
	return { ok: true, value: todo };
}

function buildCreateArgv(todo: Task, params: ValidPromotionParams): string[] {
	const argv = [
		"create",
		`--kind=${params.kind}`,
		"-p",
		String(params.priority),
	];
	const description =
		params.description ?? normalizeOptionalString(todo.description);
	if (description !== undefined) {
		argv.push(`--description=${description}`);
	}
	if (params.parent !== undefined) {
		argv.push(`--parent=${params.parent}`);
	}
	if (params.planned === true) {
		argv.push("--planned");
	} else if (params.needsPlan === true) {
		argv.push("--needs-plan");
	}
	argv.push("--", todo.subject);
	return argv;
}

function normalizeOptionalString(
	value: string | undefined,
): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function extractSimilarCandidates(result: unknown): readonly unknown[] {
	if (Array.isArray(result)) return result;
	if (isRecord(result) && Array.isArray(result.candidates)) {
		return result.candidates;
	}
	return [];
}

function extractCreatedTaskId(result: unknown): string | undefined {
	if (!isRecord(result)) return undefined;
	const directId =
		readNonEmptyString(result.id) ?? readNonEmptyString(result.task_id);
	if (directId !== undefined) return directId;
	if (isRecord(result.task)) {
		return (
			readNonEmptyString(result.task.id) ??
			readNonEmptyString(result.task.task_id)
		);
	}
	return undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function errorResult(
	code: string,
	message: string,
	details?: unknown,
): AgentToolResult<TaskBridgeDetails> {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({
			code,
			message,
			...(details === undefined ? {} : { details }),
		}),
	);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function getErrorCode(error: unknown): string {
	if (isRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	return "tsq_error";
}

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			...(isRecord(error) && typeof error.code === "string"
				? { code: error.code }
				: {}),
		};
	}
	return error;
}
