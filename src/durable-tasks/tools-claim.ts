import {
	defineTool,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	CLAIM_TASK_PROMPT_GUIDELINES,
	CLAIM_TASK_PROMPT_SNIPPET,
} from "../guidelines/internal-tools.js";
import {
	applyTaskMutation,
	type Op,
} from "../session-todos/state/state-reducer.js";
import { commitState, getState } from "../session-todos/state/store.js";
import type { Task } from "../session-todos/tool/types.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";
import { runQueuedMutation } from "./mutation-queue.js";
import { runTsqJson } from "./runner.js";
import type { TsqShowData, TsqTask } from "./types.js";

export const TSQ_CLAIM_TOOL_NAME = "tsq_claim";

export const TsqClaimParamsSchema = Type.Object(
	{
		id: Type.String({ description: "Named durable task id to claim." }),
		assignee: Type.Optional(
			Type.String({
				description: "Agent or role claiming the task. Defaults to pi.",
			}),
		),
		start: Type.Optional(
			Type.Boolean({
				description:
					"Start the task after claiming. Defaults to true because claim means work has begun.",
			}),
		),
		requireSpec: Type.Optional(
			Type.Boolean({
				description: "Require an attached task spec before the claim succeeds.",
			}),
		),
		createTodo: Type.Optional(
			Type.Boolean({
				description:
					"After a successful claim, create one linked session todo for the claimed task.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TsqClaimParams = Static<typeof TsqClaimParamsSchema>;

export interface TsqClaimTodoError {
	readonly code: string;
	readonly message: string;
	readonly error: Record<string, unknown>;
}

export interface TsqClaimSuccessData {
	readonly id: string;
	readonly assignee: string;
	readonly start: boolean;
	readonly requireSpec: boolean;
	readonly createTodo: boolean;
	readonly argv: readonly string[];
	readonly claimResult: unknown;
	readonly task?: TsqTask;
	readonly todo?: Task;
	readonly todoError?: TsqClaimTodoError;
}

export type TsqClaimDetails = ReturnType<
	typeof okToolDetails<TsqClaimSuccessData>
>;

type ValidationResult =
	| {
			readonly ok: true;
			readonly id: string;
			readonly assignee: string;
			readonly start: boolean;
			readonly requireSpec: boolean;
			readonly createTodo: boolean;
			readonly argv: string[];
	  }
	| { readonly ok: false; readonly message: string };

const DEFAULT_ASSIGNEE = "pi";

export function registerTsqClaimTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: TSQ_CLAIM_TOOL_NAME,
			label: "Task Claim",
			description: "Claim named durable task ownership.",
			promptSnippet: CLAIM_TASK_PROMPT_SNIPPET,
			promptGuidelines: CLAIM_TASK_PROMPT_GUIDELINES,
			parameters: TsqClaimParamsSchema,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return executeTsqClaim(
					pi,
					params as Readonly<Record<string, unknown>>,
					signal,
					ctx,
				);
			},
		}),
	);
}

export async function executeTsqClaim(
	pi: ExtensionAPI,
	params: Readonly<Record<string, unknown>>,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<TsqClaimDetails>> {
	const command = buildClaimCommand(params);
	if (!command.ok) {
		return validationErrorResult(command.message);
	}

	const options = buildRunOptions(signal);
	let claimResult: unknown;
	try {
		claimResult = await runQueuedMutation(ctx.cwd, () =>
			runTsqJson(pi, { cwd: ctx.cwd }, command.argv, options),
		);
	} catch (error) {
		return claimFailureResult(command, error);
	}

	let linked: { readonly task: TsqTask; readonly todo: Task } | undefined;
	let todoError: TsqClaimTodoError | undefined;
	if (command.createTodo) {
		try {
			linked = await createLinkedTodoForClaim(pi, ctx, command.id, options);
		} catch (error) {
			todoError = {
				code: getErrorCode(error),
				message: getErrorMessage(error),
				error: serializeError(error),
			};
		}
	}

	const data: TsqClaimSuccessData = {
		id: command.id,
		assignee: command.assignee,
		start: command.start,
		requireSpec: command.requireSpec,
		createTodo: command.createTodo,
		argv: command.argv,
		claimResult,
		...(linked === undefined ? {} : linked),
		...(todoError === undefined ? {} : { todoError }),
	};
	const warnings =
		todoError === undefined
			? undefined
			: [`Linked todo creation failed: ${todoError.message}`];

	return textToolResult(
		formatSuccess(data),
		okToolDetails(data, warnings === undefined ? {} : { warnings }),
	);
}

function buildClaimCommand(
	params: Readonly<Record<string, unknown>>,
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const assignee = optionalNonEmptyString(params, "assignee", DEFAULT_ASSIGNEE);
	if (!assignee.ok) {
		return assignee;
	}
	const start = optionalBoolean(params, "start", true);
	if (!start.ok) {
		return start;
	}
	const requireSpec = optionalBoolean(params, "requireSpec", false);
	if (!requireSpec.ok) {
		return requireSpec;
	}
	const createTodo = optionalBoolean(params, "createTodo", false);
	if (!createTodo.ok) {
		return createTodo;
	}

	const argv = ["claim", id.value, `--assignee=${assignee.value}`];
	if (start.value) {
		argv.push("--start");
	}
	if (requireSpec.value) {
		argv.push("--require-spec");
	}

	return {
		ok: true,
		id: id.value,
		assignee: assignee.value,
		start: start.value,
		requireSpec: requireSpec.value,
		createTodo: createTodo.value,
		argv,
	};
}

async function createLinkedTodoForClaim(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	id: string,
	options: { readonly signal?: AbortSignal },
): Promise<{ readonly task: TsqTask; readonly todo: Task }> {
	const show = await runTsqJson<TsqShowData>(
		pi,
		{ cwd: ctx.cwd },
		["show", id],
		options,
	);
	const task = requireTaskWithTitle(show, id);
	const subject = `Work on ${id}: ${task.title}`;
	const mutation = applyTaskMutation(getState(), "create", {
		subject,
		metadata: { tsqId: id },
	});
	const taskId = getCreatedTodoId(mutation.op);
	commitState(mutation.state);
	const todo = mutation.state.tasks.find(
		(candidate) => candidate.id === taskId,
	);
	if (todo === undefined) {
		throw new Error("could not create linked todo: created task missing");
	}
	return { task, todo };
}

function getCreatedTodoId(op: Op): number {
	if (op.kind === "create") {
		return op.taskId;
	}
	const message =
		op.kind === "error" ? op.message : `unexpected todo operation ${op.kind}`;
	throw new Error(`could not create linked todo: ${message}`);
}

function requireTaskWithTitle(show: TsqShowData, id: string): TsqTask {
	const task = show.task;
	if (!isRecord(task) || typeof task.title !== "string") {
		throw new Error(`tsq show ${id} did not return task title`);
	}
	return task as TsqTask;
}

function buildRunOptions(signal: AbortSignal | undefined): {
	readonly signal?: AbortSignal;
} {
	return signal === undefined ? {} : { signal };
}

function requireNonEmptyString(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false, message: `${field} is required` };
	}
	return { ok: true, value: value.trim() };
}

function optionalNonEmptyString(
	params: Readonly<Record<string, unknown>>,
	field: string,
	fallback: string,
):
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: fallback };
	}
	if (typeof value !== "string") {
		return { ok: false, message: `${field} must be a string` };
	}
	const trimmed = value.trim();
	return { ok: true, value: trimmed.length === 0 ? fallback : trimmed };
}

function optionalBoolean(
	params: Readonly<Record<string, unknown>>,
	field: string,
	fallback: boolean,
):
	| { readonly ok: true; readonly value: boolean }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: fallback };
	}
	if (typeof value !== "boolean") {
		return { ok: false, message: `${field} must be a boolean` };
	}
	return { ok: true, value };
}

function validationErrorResult(
	message: string,
): AgentToolResult<TsqClaimDetails> {
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({
			code: "validation_error",
			message,
		}),
	);
}

function claimFailureResult(
	command: Extract<ValidationResult, { readonly ok: true }>,
	error: unknown,
): AgentToolResult<TsqClaimDetails> {
	const message = getErrorMessage(error);
	return textToolResult(
		`Error: ${message}`,
		errorToolDetails({
			code: getErrorCode(error),
			message,
			details: {
				id: command.id,
				assignee: command.assignee,
				argv: command.argv,
				error: serializeError(error),
			},
		}),
	);
}

function formatSuccess(data: TsqClaimSuccessData): string {
	const lines = [
		`Claimed ${data.id} as ${data.assignee}${data.start ? " and started" : ""}`,
	];
	if (data.requireSpec) {
		lines.push("Spec required");
	}
	if (data.todo !== undefined) {
		lines.push(`Created todo #${data.todo.id}: ${data.todo.subject}`);
	}
	if (data.todoError !== undefined) {
		lines.push(`Linked todo creation failed: ${data.todoError.message}`);
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
