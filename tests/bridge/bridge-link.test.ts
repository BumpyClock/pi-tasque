import { beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerTaskBridgeTool } from "../../src/bridge/bridge-tool.js";
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

function createTodo(
	subject: string,
	metadata?: Record<string, unknown>,
): number {
	const params: Record<string, unknown> = { subject };
	if (metadata !== undefined) params.metadata = metadata;
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
	registerTaskBridgeTool(pi);
	const tool = captured.tools.get("task_bridge");
	if (!tool) throw new Error("task_bridge was not registered");
	return { tool, captured };
}

beforeEach(() => {
	__resetState();
});

describe("registerTaskBridgeTool", () => {
	it("registers task_bridge schema with link/list/promote/import actions", () => {
		const { tool } = registerTool();

		expect(tool.name).toBe("task_bridge");
		expect(tool.parameters).toMatchObject({
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["link", "list_links", "promote_todo", "import_tsq"],
				},
			},
			required: ["action"],
		});
	});

	it("links a todo to a Tasque task through metadata without changing lifecycle", async () => {
		const { tool, captured } = registerTool();
		const todoId = createTodo("Bridge me", { keep: true });
		const started = applyTaskMutation(getState(), "update", {
			id: todoId,
			status: "in_progress",
		});
		if (started.op.kind === "error") throw new Error(started.op.message);
		commitState(started.state);

		const result = await tool.execute(
			"call-1",
			{ action: "link", todoId, tsqId: "tsq-123" },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe("Linked todo #1 to tsq-123");
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				action: "link",
				link: {
					todoId,
					todoSubject: "Bridge me",
					todoStatus: "in_progress",
					tsqId: "tsq-123",
				},
			},
		});
		expect(getState().tasks[0]).toMatchObject({
			id: todoId,
			status: "in_progress",
			metadata: { keep: true, tsqId: "tsq-123" },
		});
		expect(captured.execCalls).toEqual([]);
	});

	it("lists links from current session todos", async () => {
		const { tool } = registerTool();
		const first = createTodo("First", { tsqId: "tsq-1" });
		createTodo("Unlinked");
		const second = createTodo("Second", { tsqId: "tsq-2" });

		const result = await tool.execute(
			"call-1",
			{ action: "list_links" },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe(
			"2 linked todos\n#1 First ↔ tsq-1\n#3 Second ↔ tsq-2",
		);
		expect(result.details).toMatchObject({
			ok: true,
			data: {
				action: "list_links",
				links: [
					{
						todoId: first,
						todoSubject: "First",
						todoStatus: "pending",
						tsqId: "tsq-1",
					},
					{
						todoId: second,
						todoSubject: "Second",
						todoStatus: "pending",
						tsqId: "tsq-2",
					},
				],
			},
		});
	});

	it("validates link todo and Tasque ids before mutating", async () => {
		const { tool } = registerTool();
		const todoId = createTodo("Stay unlinked");

		const missing = await tool.execute(
			"call-1",
			{ action: "link", todoId: 99, tsqId: "tsq-1" },
			undefined,
			undefined,
			ctx,
		);
		const empty = await tool.execute(
			"call-2",
			{ action: "link", todoId, tsqId: " " },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(missing)).toBe("Error: todo #99 not found");
		expect(missing.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "todo #99 not found" },
		});
		expect(firstText(empty)).toBe("Error: tsqId is required");
		expect(empty.details).toMatchObject({
			ok: false,
			error: { code: "validation_error", message: "tsqId is required" },
		});
		expect(getState().tasks[0]?.metadata).toBeUndefined();
	});

	it.each([
		"promote_todo",
		"import_tsq",
	] as const)("returns a clear handler configuration error for %s until a handler is injected", async (action) => {
		const { tool } = registerTool();

		const result = await tool.execute(
			"call-1",
			{ action, todoId: 1, tsqId: "tsq-1" },
			undefined,
			undefined,
			ctx,
		);

		expect(firstText(result)).toBe(
			`Error: task/todo bridge action ${action} handler is not configured`,
		);
		expect(result.details).toMatchObject({
			ok: false,
			error: {
				code: "not_implemented",
				message: `task/todo bridge action ${action} handler is not configured`,
			},
		});
	});

	it("dispatches promote/import through injected handlers", async () => {
		const { pi, captured } = createMockPi();
		registerTaskBridgeTool(pi, {
			promote_todo: (params) => ({
				content: [{ type: "text", text: `promoted ${params.todoId}` }],
				details: { ok: true, data: { action: "promote_todo" } },
			}),
			import_tsq: (params) => ({
				content: [{ type: "text", text: `imported ${params.tsqId}` }],
				details: { ok: true, data: { action: "import_tsq" } },
			}),
		});
		const tool = captured.tools.get("task_bridge");
		if (!tool) throw new Error("task_bridge was not registered");

		await expect(
			tool.execute(
				"call-1",
				{ action: "promote_todo", todoId: 7 },
				undefined,
				undefined,
				ctx,
			),
		).resolves.toMatchObject({ content: [{ text: "promoted 7" }] });
		await expect(
			tool.execute(
				"call-2",
				{ action: "import_tsq", tsqId: "tsq-7" },
				undefined,
				undefined,
				ctx,
			),
		).resolves.toMatchObject({ content: [{ text: "imported tsq-7" }] });
	});
});
