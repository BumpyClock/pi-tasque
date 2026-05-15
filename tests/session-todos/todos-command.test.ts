import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetState,
	registerTodosCommand,
	registerTodoTool,
	TOOL_NAME,
} from "../../src/session-todos/todo.js";
import { createMockPi } from "../support/pi-harness.js";

type RegisteredTool = NonNullable<
	ReturnType<typeof createMockPi>["captured"]["tools"] extends Map<
		string,
		infer T
	>
		? T
		: never
>;

type RegisteredCommand = NonNullable<
	ReturnType<typeof createMockPi>["captured"]["commands"] extends Map<
		string,
		infer T
	>
		? T
		: never
>;

function commandCtx(hasUI: boolean): ExtensionCommandContext {
	return {
		hasUI,
		ui: {
			notify: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
}

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	registerTodosCommand(pi);
	const tool = captured.tools.get(TOOL_NAME);
	const command = captured.commands.get("todos");
	if (!tool) throw new Error("todo tool not registered");
	if (!command) throw new Error("todos command not registered");
	return { tool, command };
}

async function call(tool: RegisteredTool, params: Record<string, unknown>) {
	return tool.execute("tc", params as never, undefined, undefined, {} as never);
}

async function seed(
	tool: RegisteredTool,
	actions: Array<Record<string, unknown>>,
): Promise<void> {
	for (const action of actions) await call(tool, action);
}

async function runCommand(
	command: RegisteredCommand,
	ctx: ExtensionCommandContext,
) {
	await command.handler("", ctx);
	const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
	expect(notify).toHaveBeenCalledTimes(1);
	return notify.mock.calls[0] as [string, string];
}

beforeEach(() => {
	__resetState();
});

afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("/todos command registration", () => {
	it("registers the todos command with a useful description", () => {
		const { command } = setup();

		expect(command.description).toContain("todos");
	});
});

describe("/todos command guards", () => {
	it("notifies an error when UI is unavailable", async () => {
		const { command } = setup();
		const [text, level] = await runCommand(command, commandCtx(false));

		expect(level).toBe("error");
		expect(text).toContain("requires interactive mode");
	});

	it("notifies no-todos info when there are no visible tasks", async () => {
		const { command } = setup();
		const [text, level] = await runCommand(command, commandCtx(true));

		expect(level).toBe("info");
		expect(text).toContain("No todos");
	});

	it("treats deleted tombstones as no visible tasks", async () => {
		const { tool, command } = setup();
		await seed(tool, [
			{ action: "create", subject: "Drop me" },
			{ action: "delete", id: 1 },
		]);

		const [text, level] = await runCommand(command, commandCtx(true));

		expect(level).toBe("info");
		expect(text).toContain("No todos");
	});
});

describe("/todos command grouped output", () => {
	it("groups visible tasks by pending, in_progress, and completed", async () => {
		const { tool, command } = setup();
		await seed(tool, [
			{ action: "create", subject: "Pending task" },
			{ action: "create", subject: "Active task", activeForm: "Building" },
			{ action: "update", id: 2, status: "in_progress" },
			{ action: "create", subject: "Completed task" },
			{ action: "update", id: 3, status: "completed" },
			{ action: "create", subject: "Blocked task", blockedBy: [1] },
		]);

		const [text, level] = await runCommand(command, commandCtx(true));

		expect(level).toBe("info");
		expect(text.split("\n")[0]).toBe(
			"1/4 completed · 1 in progress · 2 pending",
		);
		expect(text).toContain("── Pending ──");
		expect(text).toContain("  ○ #1 Pending task");
		expect(text).toContain("  ○ #4 Blocked task    ⛓ #1");
		expect(text).toContain("── In Progress ──");
		expect(text).toContain("  ◐ #2 Active task (Building)");
		expect(text).toContain("── Completed ──");
		expect(text).toContain("  ✓ #3 Completed task");
	});

	it("omits empty groups and deleted tasks", async () => {
		const { tool, command } = setup();
		await seed(tool, [
			{ action: "create", subject: "Keep" },
			{ action: "create", subject: "Remove" },
			{ action: "delete", id: 2 },
		]);

		const [text] = await runCommand(command, commandCtx(true));

		expect(text).toContain("── Pending ──");
		expect(text).not.toContain("── In Progress ──");
		expect(text).not.toContain("── Completed ──");
		expect(text).toContain("Keep");
		expect(text).not.toContain("Remove");
	});
});
