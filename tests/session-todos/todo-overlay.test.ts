import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	commitState,
	__resetState,
} from "../../src/session-todos/state/store.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
import { TodoOverlay } from "../../src/session-todos/todo-overlay.js";
import type { Task } from "../../src/session-todos/tool/types.js";
import { makeTheme } from "../support/theme.js";

const WIDGET_KEY = "rpiv-todos";

type MockUI = ExtensionUIContext & {
	setWidget: ReturnType<typeof vi.fn>;
};

type OverlayWidget = {
	render(width: number): string[];
	invalidate(): void;
};

type WidgetFactory = (tui: TUI, theme: Theme) => OverlayWidget;

const task = (
	overrides: Partial<Task> & { id: number; subject: string },
): Task => ({
	status: "pending",
	...overrides,
});

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((candidate) => candidate.id)) + 1,
});

function makeUI(): MockUI {
	return { setWidget: vi.fn() } as unknown as MockUI;
}

function setTodos(...tasks: Task[]): void {
	commitState(stateWith(...tasks));
}

function createWidget(overlay: TodoOverlay, ui: MockUI): OverlayWidget {
	const factory = ui.setWidget.mock.calls[0]![1] as WidgetFactory;
	return factory({ requestRender: vi.fn() } as unknown as TUI, makeTheme());
}

describe("TodoOverlay", () => {
	beforeEach(() => {
		__resetState();
	});

	afterEach(() => {
		__resetState();
		vi.restoreAllMocks();
	});

	it("does not register a widget for empty todos", () => {
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();

		expect(ui.setWidget).not.toHaveBeenCalled();
	});

	it("registers a non-empty widget once above the editor", () => {
		setTodos(task({ id: 1, subject: "Draft" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		overlay.update();

		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		expect(ui.setWidget.mock.calls[0]![0]).toBe(WIDGET_KEY);
		expect(typeof ui.setWidget.mock.calls[0]![1]).toBe("function");
		expect(ui.setWidget.mock.calls[0]![2]).toEqual({
			placement: "aboveEditor",
		});
	});

	it("update requests a rerender after registration instead of re-registering", () => {
		setTodos(task({ id: 1, subject: "Draft" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();
		const tui = { requestRender: vi.fn() } as unknown as TUI;

		overlay.setUICtx(ui);
		overlay.update();
		const factory = ui.setWidget.mock.calls[0]![1] as WidgetFactory;
		factory(tui, makeTheme());
		overlay.update();

		expect(ui.setWidget).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("renders live state changes from the store", () => {
		setTodos(task({ id: 1, subject: "First" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		const widget = createWidget(overlay, ui);
		expect(widget.render(200).join("\n")).toContain("First");

		setTodos(
			task({ id: 1, subject: "First" }),
			task({ id: 2, subject: "Second" }),
		);

		const rendered = widget.render(200).join("\n");
		expect(rendered).toContain("First");
		expect(rendered).toContain("Second");
	});

	it("unregisters on transition to empty todos", () => {
		setTodos(task({ id: 1, subject: "Draft" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		commitState({ tasks: [], nextId: 1 });
		overlay.update();

		expect(ui.setWidget).toHaveBeenCalledTimes(2);
		expect(ui.setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
	});

	it("treats all-deleted todos as empty", () => {
		setTodos(task({ id: 1, subject: "Gone", status: "deleted" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();

		expect(ui.setWidget).not.toHaveBeenCalled();
	});

	it("unregisters when hiding previous-turn completed display leaves no visible todos", () => {
		setTodos(task({ id: 1, subject: "Done", status: "completed" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		const widget = createWidget(overlay, ui);

		expect(widget.render(200).join("\n")).toContain("Done");
		overlay.hideCompletedTasksFromPreviousTurn();

		expect(ui.setWidget).toHaveBeenCalledTimes(2);
		expect(ui.setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
		expect(widget.render(200)).toEqual([]);
	});

	it("truncates rendered lines to the available width", () => {
		setTodos(
			task({
				id: 1,
				subject: "Very long todo subject that must not overflow the editor",
			}),
		);
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		const widget = createWidget(overlay, ui);
		const lines = widget.render(20);

		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
		expect(lines.join("\n")).toContain("…");
	});

	it("dispose unregisters the widget and clears overlay state", () => {
		setTodos(task({ id: 1, subject: "Draft" }));
		const overlay = new TodoOverlay();
		const ui = makeUI();

		overlay.setUICtx(ui);
		overlay.update();
		overlay.dispose();
		overlay.update();

		expect(ui.setWidget).toHaveBeenCalledTimes(2);
		expect(ui.setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
	});
});
