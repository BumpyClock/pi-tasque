import type {
	ExtensionContext,
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetState,
	commitState,
	getState,
	registerSessionTodoModule,
	type Task,
	type TaskDetails,
} from "../../src/session-todos/todo.js";
import { createMockPi, emitPiEvent } from "../support/pi-harness.js";
import { makeTheme } from "../support/theme.js";

const WIDGET_KEY = "pi-tasque-todos";

type MockUI = ExtensionUIContext & {
	setWidget: ReturnType<typeof vi.fn>;
};

type OverlayWidget = {
	render(width: number): string[];
	invalidate(): void;
};

type WidgetFactory = (tui: TUI, theme: Theme) => OverlayWidget;

function task(
	overrides: Partial<Task> & { id: number; subject: string },
): Task {
	return {
		status: "pending",
		...overrides,
	};
}

function todoDetails(tasks: readonly Task[]): TaskDetails {
	return {
		action: "list",
		params: {},
		tasks: [...tasks],
		nextId: Math.max(0, ...tasks.map((candidate) => candidate.id)) + 1,
	};
}

function toolResult(toolName: string, details: unknown): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			details,
		},
	};
}

function todoBranch(tasks: readonly Task[]): Iterable<unknown> {
	return [toolResult("todo", todoDetails(tasks))];
}

function makeUI(): MockUI {
	return { setWidget: vi.fn() } as unknown as MockUI;
}

function makeContext(branch: Iterable<unknown>, ui?: MockUI): ExtensionContext {
	return {
		cwd: "/repo",
		hasUI: ui !== undefined,
		...(ui === undefined ? {} : { ui }),
		sessionManager: {
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

function createWidget(
	ui: MockUI,
	tui: TUI = { requestRender: vi.fn() } as unknown as TUI,
): OverlayWidget {
	const factory = ui.setWidget.mock.calls[0]?.[1] as WidgetFactory | undefined;
	if (factory === undefined) throw new Error("widget was not registered");
	return factory(tui, makeTheme());
}

async function startWithVisibleTodo() {
	const { pi, captured } = createMockPi();
	registerSessionTodoModule(pi);
	const ui = makeUI();
	const ctx = makeContext(todoBranch([task({ id: 1, subject: "Seed" })]), ui);

	await emitPiEvent(captured, "session_start", { type: "session_start" }, ctx);
	const tui = { requestRender: vi.fn() } as unknown as TUI & {
		requestRender: ReturnType<typeof vi.fn>;
	};
	createWidget(ui, tui);
	return { captured, ctx, ui, tui };
}

beforeEach(() => {
	__resetState();
});

describe("session todo lifecycle", () => {
	it("registers todo lifecycle handlers with the todo registrar", () => {
		const { pi, captured } = createMockPi();

		registerSessionTodoModule(pi);

		expect([...captured.tools.keys()]).toEqual(["todo"]);
		expect([...captured.commands.keys()]).toEqual(["todos"]);
		for (const eventName of [
			"session_start",
			"session_compact",
			"session_tree",
			"tool_execution_end",
			"turn_start",
			"session_shutdown",
		]) {
			expect(captured.handlers.get(eventName)?.length).toBe(1);
		}
	});

	it.each([
		"session_start",
		"session_compact",
		"session_tree",
	] as const)("replays todo state on %s", async (eventName) => {
		const { pi, captured } = createMockPi();
		registerSessionTodoModule(pi);
		const ctx = makeContext(
			todoBranch([task({ id: 1, subject: `${eventName} replayed` })]),
		);

		await emitPiEvent(captured, eventName, { type: eventName }, ctx);

		expect(getState()).toEqual({
			tasks: [task({ id: 1, subject: `${eventName} replayed` })],
			nextId: 2,
		});
	});

	it("updates the overlay after successful todo and task results only", async () => {
		const { captured, ctx, tui } = await startWithVisibleTodo();

		for (const [toolName, result] of [
			["todo", { details: { error: "#99 not found" } }],
			["task", { details: { ok: false } }],
		] as const) {
			await emitPiEvent(
				captured,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: `failed-${toolName}`,
					toolName,
					result,
					isError: false,
				},
				ctx,
			);
		}
		await emitPiEvent(
			captured,
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: "thrown",
				toolName: "todo",
				result: {},
				isError: true,
			},
			ctx,
		);

		expect(tui.requestRender).not.toHaveBeenCalled();

		for (const [toolName, result] of [
			["todo", { details: todoDetails([task({ id: 1, subject: "Seed" })]) }],
			["task", { details: { ok: true } }],
		] as const) {
			await emitPiEvent(
				captured,
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: `ok-${toolName}`,
					toolName,
					result,
					isError: false,
				},
				ctx,
			);
		}

		expect(tui.requestRender).toHaveBeenCalledTimes(2);
	});

	it("hides previous-turn completed todos on turn_start", async () => {
		const { pi, captured } = createMockPi();
		registerSessionTodoModule(pi);
		const ui = makeUI();
		const ctx = makeContext(
			todoBranch([task({ id: 1, subject: "Done", status: "completed" })]),
			ui,
		);

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		const widget = createWidget(ui);
		expect(widget.render(200).join("\n")).toContain("Done");

		await emitPiEvent(captured, "turn_start", { type: "turn_start" }, ctx);

		expect(ui.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
		expect(widget.render(200)).toEqual([]);
	});

	it("keeps previous-turn completed todos hidden through session_compact replay", async () => {
		const { pi, captured } = createMockPi();
		registerSessionTodoModule(pi);
		const ui = makeUI();
		const ctx = makeContext(
			todoBranch([task({ id: 1, subject: "Done", status: "completed" })]),
			ui,
		);

		await emitPiEvent(
			captured,
			"session_start",
			{ type: "session_start" },
			ctx,
		);
		const widget = createWidget(ui);
		widget.render(200);
		await emitPiEvent(captured, "turn_start", { type: "turn_start" }, ctx);
		ui.setWidget.mockClear();

		await emitPiEvent(
			captured,
			"session_compact",
			{ type: "session_compact" },
			ctx,
		);

		expect(ui.setWidget).not.toHaveBeenCalled();
		expect(widget.render(200)).toEqual([]);
	});

	it("disposes the overlay on session_shutdown", async () => {
		const { captured, ctx, ui } = await startWithVisibleTodo();

		await emitPiEvent(
			captured,
			"session_shutdown",
			{ type: "session_shutdown" },
			ctx,
		);

		expect(ui.setWidget).toHaveBeenLastCalledWith(WIDGET_KEY, undefined);
	});

	it("does not register duplicate tools or commands through the package entrypoint registrar", () => {
		const { pi } = createMockPi();

		expect(() => registerSessionTodoModule(pi)).not.toThrow();
	});

	it("turn_start uses current store state when hiding completed todos", async () => {
		const { captured, ctx, ui } = await startWithVisibleTodo();
		commitState({
			tasks: [task({ id: 1, subject: "Done", status: "completed" })],
			nextId: 2,
		});
		const widget = createWidget(ui);
		expect(widget.render(200).join("\n")).toContain("Done");

		await emitPiEvent(captured, "turn_start", { type: "turn_start" }, ctx);

		expect(widget.render(200)).toEqual([]);
	});
});
