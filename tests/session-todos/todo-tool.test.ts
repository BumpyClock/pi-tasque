import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__resetState,
	registerSessionTodoModule,
	registerTodoTool,
	type TaskDetails,
	TOOL_NAME,
} from "../../src/session-todos/todo.js";
import { createMockPi } from "../support/pi-harness.js";
import { makeTheme } from "../support/theme.js";

const theme = makeTheme() as Theme;

type RegisteredTool = NonNullable<
	ReturnType<typeof createMockPi>["captured"]["tools"] extends Map<
		string,
		infer T
	>
		? T
		: never
>;

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("todo tool not registered");
	return { tool, captured };
}

async function call(tool: RegisteredTool, params: Record<string, unknown>) {
	return tool.execute("tc", params as never, undefined, undefined, {} as never);
}

function resultText(result: Awaited<ReturnType<typeof call>>): string {
	const first = result.content[0];
	if (!first || first.type !== "text") throw new Error("missing text result");
	return first.text;
}

beforeEach(() => {
	__resetState();
});

afterEach(() => {
	__resetState();
});

describe("registerTodoTool", () => {
	it("registers the compatible todo tool shape", () => {
		const { tool } = setup();

		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.description).toContain("current-session");
		expect(tool.promptSnippet).toContain("Current-session checklist");
		expect(tool.promptGuidelines).toEqual([
			"Use `todo` for current-session checklist steps; use `task` for durable project work.",
		]);

		const schemaText = JSON.stringify(tool.parameters);
		for (const action of [
			"create",
			"update",
			"list",
			"get",
			"delete",
			"clear",
		]) {
			expect(schemaText).toContain(action);
		}
	});

	it("registerSessionTodoModule registers one todo tool and one todos command", () => {
		const { pi, captured } = createMockPi();

		registerSessionTodoModule(pi);

		expect([...captured.tools.keys()]).toEqual(["todo"]);
		expect([...captured.commands.keys()]).toEqual(["todos"]);
	});
});

describe("todo tool execute", () => {
	it("creates, lists, and updates tasks through the store-backed reducer", async () => {
		const { tool } = setup();

		const created = await call(tool, {
			action: "create",
			subject: "Read spec",
			description: "Confirm compatible behavior",
		});
		expect(resultText(created)).toBe("Created #1: Read spec (pending)");
		expect(created.details).toMatchObject({
			action: "create",
			params: { subject: "Read spec" },
			tasks: [{ id: 1, subject: "Read spec", status: "pending" }],
			nextId: 2,
		});

		const listed = await call(tool, { action: "list" });
		expect(resultText(listed)).toContain("[pending] #1 Read spec");
		expect((listed.details as TaskDetails).tasks).toHaveLength(1);

		const updated = await call(tool, {
			action: "update",
			id: 1,
			status: "in_progress",
			activeForm: "Reading spec",
		});
		expect(resultText(updated)).toBe("Updated #1 (pending → in_progress)");
		expect(updated.details).toMatchObject({
			action: "update",
			params: { id: 1, status: "in_progress", activeForm: "Reading spec" },
			tasks: [
				{
					id: 1,
					subject: "Read spec",
					status: "in_progress",
					activeForm: "Reading spec",
				},
			],
			nextId: 2,
		});
	});

	it("commits reducer errors to a compatible response without corrupting state", async () => {
		const { tool } = setup();

		const result = await call(tool, {
			action: "update",
			id: 99,
			status: "completed",
		});

		expect(resultText(result)).toBe("Error: #99 not found");
		expect(result.details).toEqual({
			action: "update",
			params: { id: 99, status: "completed" },
			tasks: [],
			nextId: 1,
			error: "#99 not found",
		});
	});
});

describe("todo tool render hooks", () => {
	it("renders call rows from current state", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "Seed task" });

		const createNode = tool.renderCall?.(
			{ action: "create", subject: "Next task" } as never,
			theme,
			{} as never,
		) as Text;
		const updateNode = tool.renderCall?.(
			{ action: "update", id: 1 } as never,
			theme,
			{} as never,
		) as Text;

		expect(createNode).toBeInstanceOf(Text);
		expect(createNode.render(200).join("\n")).toContain("+ Next task");
		expect(updateNode.render(200).join("\n")).toContain("Seed task");
	});

	it("renders result rows from compatible details", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "Seed task" });
		const result = await call(tool, {
			action: "update",
			id: 1,
			status: "completed",
		});

		const node = tool.renderResult?.(
			result as never,
			{} as never,
			theme,
			{} as never,
		) as Text;

		expect(node).toBeInstanceOf(Text);
		expect(node.render(200).join("\n")).toContain("completed");
	});

	it("renders failed update results as errors instead of requested success status", async () => {
		const { tool } = setup();
		const result = await call(tool, {
			action: "update",
			id: 99,
			status: "completed",
		});

		const node = tool.renderResult?.(
			result as never,
			{} as never,
			theme,
			{} as never,
		) as Text;
		const rendered = node.render(200).join("\n");

		expect(node).toBeInstanceOf(Text);
		expect((result.details as TaskDetails).error).toBe("#99 not found");
		expect(rendered).toContain("#99 not found");
		expect(rendered).toMatch(/Error|✗/);
		expect(rendered).not.toContain("completed");
		expect(rendered).not.toContain("✓");
	});
});
