import { StringEnum } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { runQueuedMutation } from "./mutation-queue.js";
import { runTsqJson } from "./runner.js";
import {
	errorToolDetails,
	okToolDetails,
	textToolResult,
} from "../shared/tool-result.js";

export const TSQ_CHANGE_TOOL_NAME = "tsq_change";

const TSQ_CHANGE_ACTIONS = [
	"create",
	"note",
	"done",
	"reopen",
	"defer",
	"start",
	"claim_assign_only",
	"block",
	"unblock",
	"order",
	"unorder",
] as const;

export type TsqChangeAction = (typeof TSQ_CHANGE_ACTIONS)[number];

export const TsqChangeParamsSchema = Type.Object(
	{
		action: StringEnum(TSQ_CHANGE_ACTIONS, {
			description: "Durable Tasque mutation to run",
		}),
		title: Type.Optional(
			Type.String({ description: "Task title (required for create)" }),
		),
		id: Type.Optional(
			Type.String({
				description: "Tasque task id for lifecycle/note/claim actions",
			}),
		),
		kind: Type.Optional(
			Type.String({ description: "Tasque task kind (required for create)" }),
		),
		priority: Type.Optional(
			Type.Integer({ description: "Tasque priority (required for create)" }),
		),
		description: Type.Optional(
			Type.String({ description: "Task description (create only)" }),
		),
		parent: Type.Optional(
			Type.String({ description: "Parent Tasque task id (create only)" }),
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

type ValidationResult =
	| {
			readonly ok: true;
			readonly action: TsqChangeAction;
			readonly argv: string[];
	  }
	| { readonly ok: false; readonly message: string };

export function registerTsqChangeTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: TSQ_CHANGE_TOOL_NAME,
			label: "Tasque Change",
			description:
				"Run minimal durable Tasque mutations. Supports create, note, done, reopen, defer, start, assignment-only claim, and block/order edge changes. No raw tsq passthrough.",
			promptSnippet:
				"tsq_change: mutate durable Tasque tasks only through approved lifecycle/note/edge actions.",
			promptGuidelines: [
				"Use tsq_change only for explicit durable Tasque mutations; do not use it as a raw tsq passthrough.",
				"Use todo for current-session checklist steps; use tsq_change when durable Tasque state must change.",
				"Use block/unblock for hard blockers and order/unorder for sequencing where one task should happen after another.",
				"Use tsq_query with action deps or show to inspect durable graph state before or after edge changes.",
			],
			parameters: TsqChangeParamsSchema,
			executionMode: "sequential",

			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
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
			},
		}),
	);
}

function runMutation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	argv: readonly string[],
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const options = signal === undefined ? {} : { signal };
	return runQueuedMutation(ctx.cwd, () =>
		runTsqJson(pi, { cwd: ctx.cwd }, argv, options),
	);
}

function buildMutationCommand(
	params: Readonly<Record<string, unknown>>,
): ValidationResult {
	const action = params.action;
	if (!isTsqChangeAction(action)) {
		return {
			ok: false,
			message: "action must be a supported tsq_change action",
		};
	}

	switch (action) {
		case "create":
			return buildCreateArgv(params, action);
		case "note":
			return buildNoteArgv(params, action);
		case "done":
			return buildOptionalNoteArgv(params, action, "done");
		case "reopen":
			return buildIdOnlyArgv(params, action, "reopen");
		case "defer":
			return buildOptionalNoteArgv(params, action, "defer");
		case "start":
			return buildIdOnlyArgv(params, action, "start");
		case "claim_assign_only":
			return buildClaimAssignOnlyArgv(params, action);
		case "block":
			return buildBlockArgv(params, action, "block");
		case "unblock":
			return buildBlockArgv(params, action, "unblock");
		case "order":
			return buildOrderArgv(params, action, "order");
		case "unorder":
			return buildOrderArgv(params, action, "unorder");
	}
}

function buildCreateArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const title = requireNonEmptyString(params, "title");
	if (!title.ok) {
		return title;
	}
	const kind = requireNonEmptyString(params, "kind");
	if (!kind.ok) {
		return kind;
	}
	const priority = requireInteger(params, "priority");
	if (!priority.ok) {
		return priority;
	}
	const planned = getOptionalBoolean(params, "planned");
	if (!planned.ok) {
		return planned;
	}
	const needsPlan = getOptionalBoolean(params, "needsPlan");
	if (!needsPlan.ok) {
		return needsPlan;
	}
	if (planned.value === true && needsPlan.value === true) {
		return {
			ok: false,
			message: "planned and needsPlan cannot both be true",
		};
	}

	const argv = ["create", `--kind=${kind.value}`, "-p", String(priority.value)];
	const description = appendOptionalStringFlag(
		argv,
		params,
		"description",
		"--description",
	);
	if (description !== undefined) {
		return description;
	}
	const parent = appendOptionalStringFlag(argv, params, "parent", "--parent");
	if (parent !== undefined) {
		return parent;
	}
	if (planned.value === true) {
		argv.push("--planned");
	} else if (needsPlan.value === true) {
		argv.push("--needs-plan");
	}
	argv.push("--", title.value);

	return { ok: true, action, argv };
}

function buildNoteArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const note = requireNonEmptyString(params, "note");
	if (!note.ok) {
		return note;
	}
	return { ok: true, action, argv: ["note", id.value, "--", note.value] };
}

function buildOptionalNoteArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "done" | "defer",
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const argv = [command, id.value];
	const note = getOptionalNonEmptyString(params, "note");
	if (!note.ok) {
		return note;
	}
	if (note.value !== undefined) {
		argv.push(`--note=${note.value}`);
	}
	return { ok: true, action, argv };
}

function buildIdOnlyArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "reopen" | "start",
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	return { ok: true, action, argv: [command, id.value] };
}

function buildClaimAssignOnlyArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const assignee = requireNonEmptyString(params, "assignee");
	if (!assignee.ok) {
		return assignee;
	}
	return {
		ok: true,
		action,
		argv: ["claim", id.value, `--assignee=${assignee.value}`],
	};
}

function buildBlockArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "block" | "unblock",
): ValidationResult {
	const child = requireNonEmptyString(params, "child");
	if (!child.ok) {
		return child;
	}
	const blocker = requireNonEmptyString(params, "blocker");
	if (!blocker.ok) {
		return blocker;
	}
	if (child.value === blocker.value) {
		return { ok: false, message: "child and blocker cannot be the same task" };
	}
	return {
		ok: true,
		action,
		argv: [command, child.value, "by", blocker.value],
	};
}

function buildOrderArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "order" | "unorder",
): ValidationResult {
	const later = requireNonEmptyString(params, "later");
	if (!later.ok) {
		return later;
	}
	const earlier = requireNonEmptyString(params, "earlier");
	if (!earlier.ok) {
		return earlier;
	}
	if (later.value === earlier.value) {
		return { ok: false, message: "later and earlier cannot be the same task" };
	}
	return {
		ok: true,
		action,
		argv: [command, later.value, "after", earlier.value],
	};
}

function appendOptionalStringFlag(
	argv: string[],
	params: Readonly<Record<string, unknown>>,
	field: "description" | "parent",
	flag: string,
): ValidationResult | undefined {
	const value = getOptionalNonEmptyString(params, field);
	if (!value.ok) {
		return value;
	}
	if (value.value !== undefined) {
		argv.push(`${flag}=${value.value}`);
	}
	return undefined;
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
	return { ok: true, value };
}

function getOptionalNonEmptyString(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: string | undefined }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (typeof value !== "string") {
		return { ok: false, message: `${field} must be a string` };
	}
	if (value.trim().length === 0) {
		return { ok: true, value: undefined };
	}
	return { ok: true, value };
}

function requireInteger(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { ok: false, message: `${field} is required` };
	}
	return { ok: true, value };
}

function getOptionalBoolean(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: boolean | undefined }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (typeof value !== "boolean") {
		return { ok: false, message: `${field} must be a boolean` };
	}
	return { ok: true, value };
}

function isTsqChangeAction(value: unknown): value is TsqChangeAction {
	return (
		typeof value === "string" &&
		(TSQ_CHANGE_ACTIONS as readonly string[]).includes(value)
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
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
