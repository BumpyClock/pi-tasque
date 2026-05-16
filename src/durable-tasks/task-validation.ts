import {
	fieldRequired,
	requireStringField,
} from "../shared/validation.js";
import {
	validateBulkItems,
	validateCreateTreeNode,
} from "./bulk-contract.js";
import type { TaskAction, TaskParams } from "./task-schema.js";

export function validateTaskParams(
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

export function actionUsesTasque(action: TaskAction): boolean {
	return (
		action !== "link" && action !== "list_links" && action !== "handoff_check"
	);
}

export function hasWith(params: TaskParams, value: string): boolean {
	return Array.isArray(params.with) && params.with.includes(value);
}

export function getTodoId(
	value: boolean | number | undefined,
): number | undefined {
	return typeof value === "number" ? value : undefined;
}

export function requireTodoId(
	value: boolean | number | undefined,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
		? { ok: true }
		: fieldRequired("todo");
}
