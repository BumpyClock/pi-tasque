import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { selectTaskSubjectById } from "../state/selectors.js";
import type { TaskState } from "../state/state.js";
import type {
	Task,
	TaskAction,
	TaskMutationParams,
	TaskStatus,
} from "../tool/types.js";

export const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

export const STATUS_COLOR: Record<
	TaskStatus,
	"dim" | "warning" | "success" | "muted"
> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

export const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

type RenderableTaskDetails = {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: unknown[];
	error?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isTaskAction(value: unknown): value is TaskAction {
	return typeof value === "string" && Object.hasOwn(ACTION_GLYPH, value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && Object.hasOwn(STATUS_GLYPH, value);
}

function statusFromTask(value: unknown): TaskStatus | undefined {
	if (!isPlainObject(value)) return undefined;
	return isTaskStatus(value.status) ? value.status : undefined;
}

function isRenderableTaskDetails(
	value: unknown,
): value is RenderableTaskDetails {
	return (
		isPlainObject(value) &&
		isTaskAction(value.action) &&
		Array.isArray(value.tasks) &&
		isPlainObject(value.params) &&
		(value.error === undefined || typeof value.error === "string")
	);
}

function firstContentText(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const textContent = value.find(
		(candidate) =>
			isPlainObject(candidate) &&
			candidate.type === "text" &&
			typeof candidate.text === "string",
	);
	return isPlainObject(textContent) && typeof textContent.text === "string"
		? textContent.text
		: undefined;
}

function errorMessageFromResult(result: {
	details?: unknown;
	content?: unknown;
}): string | undefined {
	if (
		!isPlainObject(result.details) ||
		!Object.hasOwn(result.details, "error")
	) {
		return undefined;
	}

	if (
		typeof result.details.error === "string" &&
		result.details.error.length > 0
	) {
		return result.details.error;
	}

	return firstContentText(result.content) ?? "Error";
}

export function formatStatusLabel(status: TaskStatus): string {
	switch (status) {
		case "pending":
			return "pending";
		case "in_progress":
			return "in progress";
		case "completed":
			return "completed";
		case "deleted":
			return "deleted";
	}
}

export function overlayStatusGlyph(status: TaskStatus, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg("dim", "○");
		case "in_progress":
			return theme.fg("warning", "◐");
		case "completed":
			return theme.fg("success", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

/** Format a single task row for the above-editor todo overlay. */
export function formatOverlayTaskLine(
	task: Task,
	theme: Theme,
	showId: boolean,
): string {
	const glyph = overlayStatusGlyph(task.status, theme);
	const subjectColor =
		task.status === "completed" || task.status === "deleted" ? "dim" : "text";
	let subject = theme.fg(subjectColor, task.subject);
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(subject);
	}

	let line = glyph;
	if (showId) line += ` ${theme.fg("accent", `#${task.id}`)}`;
	line += ` ${subject}`;
	if (task.status === "in_progress" && task.activeForm) {
		line += ` ${theme.fg("dim", `(${task.activeForm})`)}`;
	}
	if (task.blockedBy?.length) {
		line += ` ${theme.fg(
			"dim",
			`⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`,
		)}`;
	}
	return line;
}

/** Format a single task row for the `/todos` command body. */
export function formatCommandTaskLine(task: Task, glyph: string): string {
	const activeForm =
		task.status === "in_progress" && task.activeForm
			? ` (${task.activeForm})`
			: "";
	const blockedBy = task.blockedBy?.length
		? `    ⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`
		: "";
	return `  ${glyph} #${task.id} ${task.subject}${activeForm}${blockedBy}`;
}

/** Render the compact todo tool-call label shown in chat. */
export function renderTodoCall(
	args: TaskMutationParams & { action: TaskAction },
	theme: Theme,
	state: TaskState,
): Text {
	const glyph = ACTION_GLYPH[args.action];
	let text = `${theme.fg("toolTitle", theme.bold("todo "))} ${theme.fg(
		"muted",
		glyph,
	)}`;

	if (args.action === "create" && args.subject) {
		text += ` ${theme.fg("dim", args.subject)}`;
	} else if (
		(args.action === "update" ||
			args.action === "get" ||
			args.action === "delete") &&
		args.id !== undefined
	) {
		const subject = selectTaskSubjectById(state, args.id);
		text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
	} else if (args.action === "list" && args.status) {
		text += ` ${theme.fg("muted", formatStatusLabel(args.status))}`;
	}

	return new Text(text, 0, 0);
}

/** Render the compact todo result status shown in chat. */
export function renderTodoResult(
	result: { details?: unknown; content?: unknown },
	theme: Theme,
): Text {
	const errorMessage = errorMessageFromResult(result);
	if (errorMessage) {
		return new Text(theme.fg("error", `✗ ${errorMessage}`), 0, 0);
	}

	const details = isRenderableTaskDetails(result.details)
		? result.details
		: undefined;
	let status: TaskStatus | undefined;

	if (details) {
		switch (details.action) {
			case "create":
				status = statusFromTask(details.tasks.at(-1));
				break;
			case "update":
				if (details.params.status !== undefined) {
					status = isTaskStatus(details.params.status)
						? details.params.status
						: undefined;
				} else {
					status = statusFromTask(
						details.tasks.find(
							(candidate) =>
								isPlainObject(candidate) && candidate.id === details.params.id,
						),
					);
				}
				break;
			case "delete":
				status = statusFromTask(
					details.tasks.find(
						(candidate) =>
							isPlainObject(candidate) && candidate.id === details.params.id,
					),
				);
				break;
			case "list":
			case "get":
			case "clear":
				break;
		}
	}

	if (!status) return new Text(theme.fg("success", "✓"), 0, 0);
	return new Text(
		theme.fg(
			STATUS_COLOR[status],
			`${STATUS_GLYPH[status]} ${formatStatusLabel(status)}`,
		),
		0,
		0,
	);
}
