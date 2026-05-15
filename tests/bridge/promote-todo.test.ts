import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTaskBridgeTool } from "../../src/bridge/bridge-tool.js";
import { promoteTodoHandler } from "../../src/bridge/promote-todo.js";
import {
	commitState,
	getState,
	__resetState,
} from "../../src/session-todos/state/store.js";
import { applyTaskMutation } from "../../src/session-todos/state/state-reducer.js";
import { createMockPi } from "../support/pi-harness.js";

const ctx = { cwd: "/repo" } as ExtensionContext;

function firstText(result: {
	content: readonly { type: string; text?: string }[];
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined) {
		throw new Error("expected text content");
	}
	return first.text;
}

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function errorEnvelope(code: string, message: string) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq",
			ok: false,
			error: { code, message },
		}),
		stderr: "",
		code: 1,
		killed: false,
	};
}

function createTodo(
	subject: string,
	overrides: {
		readonly description?: string;
		readonly metadata?: Record<string, unknown>;
	} = {},
): number {
	const params: Record<string, unknown> = { subject };
	if (overrides.description !== undefined) {
		params.description = overrides.description;
	}
	if (overrides.metadata !== undefined) {
		params.metadata = overrides.metadata;
	}
	const result = applyTaskMutation(getState(), "create", params);
	if (result.op.kind === "error") {
		throw new Error(result.op.message);
	}
	commitState(result.state);
	const todo = getState().tasks.find((task) => task.subject === subject);
	if (!todo) throw new Error("created todo not found");
	return todo.id;
}

function registerTool() {
	const { pi, captured } = createMockPi();
	registerTaskBridgeTool(pi, { promote_todo: promoteTodoHandler });
	const tool = captured.tools.get("task_bridge");
	if (!tool) throw new Error("task_bridge was not registered");
	return { tool, captured };
}

beforeEach(() => {
	__resetState();
});

describe("promoteTodoHandler", () => {
	it("preflights similar tasks, creates a default Tasque task, notes it, and completes the todo", async () => {
		const todoId = createTodo("Promote me", {
			description: "Todo details",
			metadata: { keep: true },
		});
		const { tool, captured } = registerTool();
		const candidates = [{ id: "tsq-old", title: "Existing task" }];
		captured.execHandler = (_command, args) => {
			if (args[0] === "find") return okEnvelope({ candidates });
			if (args[0] === "create") {
				return okEnvelope({ task: { id: "tsq-new", title: "Promote me" } });
			}
			if (args[0] === "note") return okEnvelope({ task_id: "tsq-new" });
			throw new Error(`unexpected args ${args.join(" ")}`);
		};

		const result = await tool.execute(
			"call-1",
			{ action: "promote_todo", todoId },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe("Promoted todo #1 to tsq-new");
		expect(captured.execCalls).toEqual([
			{
				command: "tsq",
				args: ["find", "similar", "Promote me", "--format", "json"],
				options: { cwd: "/repo" },
			},
			{
				command: "tsq",
				args: [
					"create",
					"--kind=task",
					"-p",
					"2",
					"--description=Todo details",
					"--format",
					"json",
					"--",
					"Promote me",
				],
				options: { cwd: "/repo" },
			},
			{
				command: "tsq",
				args: [
					"note",
					"tsq-new",
					"--format",
					"json",
					"--",
					"Promoted from pi-tasque session todo #1",
				],
				options: { cwd: "/repo" },
			},
		]);
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				action: "promote_todo",
				tsqId: "tsq-new",
				similarCandidates: candidates,
				todoSnapshot: {
					nextId: 2,
					tasks: [
						expect.objectContaining({
							id: todoId,
							status: "completed",
							metadata: expect.objectContaining({
								keep: true,
								tsqId: "tsq-new",
								promotedBy: "pi",
							}),
						}),
					],
				},
				argv: {
					similar: ["find", "similar", "Promote me"],
					create: [
						"create",
						"--kind=task",
						"-p",
						"2",
						"--description=Todo details",
						"--",
						"Promote me",
					],
					note: [
						"note",
						"tsq-new",
						"--",
						"Promoted from pi-tasque session todo #1",
					],
				},
			},
		});
		const updated = getState().tasks[0];
		expect(updated).toMatchObject({
			id: todoId,
			status: "completed",
			metadata: {
				keep: true,
				tsqId: "tsq-new",
				promotedBy: "pi",
			},
		});
		expect(typeof updated?.metadata?.promotedAt).toBe("string");
		expect(
			Number.isNaN(Date.parse(updated?.metadata?.promotedAt as string)),
		).toBe(false);
	});

	it("uses explicit create overrides and promotedBy assignee", async () => {
		const todoId = createTodo("Override me", { description: "Original" });
		const { tool, captured } = registerTool();
		captured.execHandler = (_command, args) => {
			if (args[0] === "find") return okEnvelope({ candidates: [] });
			if (args[0] === "create") {
				return okEnvelope({
					task: { id: "tsq-override", title: "Override me" },
				});
			}
			if (args[0] === "note") return okEnvelope({ task_id: "tsq-override" });
			throw new Error(`unexpected args ${args.join(" ")}`);
		};

		const result = await tool.execute(
			"call-1",
			{
				action: "promote_todo",
				todoId,
				kind: "feature",
				priority: 4,
				description: "Override description",
				parent: "tsq-parent",
				planned: true,
				assignee: "developer",
			},
			undefined,
			undefined,
			ctx,
		);

		expect(result.details).toMatchObject({ ok: true });
		expect(captured.execCalls[1]).toEqual({
			command: "tsq",
			args: [
				"create",
				"--kind=feature",
				"-p",
				"4",
				"--description=Override description",
				"--parent=tsq-parent",
				"--planned",
				"--format",
				"json",
				"--",
				"Override me",
			],
			options: { cwd: "/repo" },
		});
		expect(getState().tasks[0]?.metadata).toMatchObject({
			tsqId: "tsq-override",
			promotedBy: "developer",
		});
	});

	it("leaves the todo unchanged when Tasque create rejects a duplicate", async () => {
		const todoId = createTodo("Duplicate me", { metadata: { keep: true } });
		const before = getState();
		const { tool, captured } = registerTool();
		captured.execHandler = (_command, args) => {
			if (args[0] === "find") {
				return okEnvelope({ candidates: [{ id: "tsq-existing" }] });
			}
			if (args[0] === "create") {
				return errorEnvelope("duplicate_task", "possible duplicate task");
			}
			throw new Error(`unexpected args ${args.join(" ")}`);
		};

		const result = await tool.execute(
			"call-1",
			{ action: "promote_todo", todoId },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe("Error: possible duplicate task");
		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "duplicate_task",
				message: "possible duplicate task",
				details: {
					action: "promote_todo",
					similarCandidates: [{ id: "tsq-existing" }],
				},
			},
		});
		expect(getState()).toEqual(before);
		expect(captured.execCalls).toHaveLength(2);
	});

	it("surfaces note failures as warnings without undoing create or todo completion", async () => {
		const todoId = createTodo("Note warning");
		const { tool, captured } = registerTool();
		captured.execHandler = (_command, args) => {
			if (args[0] === "find") return okEnvelope({ candidates: [] });
			if (args[0] === "create") {
				return okEnvelope({ task: { id: "tsq-note", title: "Note warning" } });
			}
			if (args[0] === "note") {
				return errorEnvelope("note_failed", "note permission denied");
			}
			throw new Error(`unexpected args ${args.join(" ")}`);
		};

		const result = await tool.execute(
			"call-1",
			{ action: "promote_todo", todoId },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe(
			"Promoted todo #1 to tsq-note\nWarning: Failed to add promotion note to tsq-note: note permission denied",
		);
		expect(result.details).toMatchObject({
			ok: true,
			warnings: [
				"Failed to add promotion note to tsq-note: note permission denied",
			],
			data: {
				action: "promote_todo",
				tsqId: "tsq-note",
				noteResult: undefined,
			},
		});
		expect(getState().tasks[0]).toMatchObject({
			status: "completed",
			metadata: { tsqId: "tsq-note" },
		});
		expect(captured.execCalls).toHaveLength(3);
	});
});
