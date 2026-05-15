import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { makeTheme } from "../support/theme.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
import {
	ACTION_GLYPH,
	formatCommandTaskLine,
	formatOverlayTaskLine,
	formatStatusLabel,
	overlayStatusGlyph,
	renderTodoCall,
	renderTodoResult,
	STATUS_COLOR,
	STATUS_GLYPH,
} from "../../src/session-todos/view/format.js";
import type { Task, TaskDetails } from "../../src/session-todos/tool/types.js";

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

const renderText = (component: { render(width: number): string[] }) =>
	component
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");

const themeRejectingMissingColors = (): Theme =>
	({
		...makeTheme(),
		fg: (color: string | undefined, text: string) => {
			if (!color) throw new Error("missing theme color");
			return text;
		},
	}) as Theme;

describe("todo format tables", () => {
	it("keeps action and status glyph mappings stable", () => {
		expect(ACTION_GLYPH).toEqual({
			create: "+",
			update: "→",
			delete: "×",
			get: "›",
			list: "☰",
			clear: "∅",
		});
		expect(STATUS_GLYPH).toEqual({
			pending: "○",
			in_progress: "◐",
			completed: "●",
			deleted: "⊘",
		});
		expect(STATUS_COLOR).toMatchObject({
			pending: "dim",
			in_progress: "warning",
			completed: "success",
			deleted: "muted",
		});
	});

	it("formats English status labels", () => {
		expect(formatStatusLabel("pending")).toBe("pending");
		expect(formatStatusLabel("in_progress")).toBe("in progress");
		expect(formatStatusLabel("completed")).toBe("completed");
		expect(formatStatusLabel("deleted")).toBe("deleted");
	});
});

describe("overlay and command task lines", () => {
	it("formats overlay rows with status glyph, optional id, active form, and blockers", () => {
		const theme = makeTheme();
		const line = formatOverlayTaskLine(
			task({
				id: 2,
				subject: "Build UI",
				status: "in_progress",
				activeForm: "Building UI",
				blockedBy: [1],
			}),
			theme,
			true,
		);

		expect(line).toBe("◐ #2 Build UI (Building UI) ⛓ #1");
	});

	it("strikes through completed and deleted overlay subjects through the theme", () => {
		const theme = {
			...makeTheme(),
			strikethrough: (text: string) => `~~${text}~~`,
		} as Theme;

		expect(
			formatOverlayTaskLine(
				task({ id: 1, subject: "Done", status: "completed" }),
				theme,
				false,
			),
		).toBe("✓ ~~Done~~");
		expect(overlayStatusGlyph("deleted", theme)).toBe("✗");
	});

	it("formats slash-command rows with glyph, id, active form, and blockers", () => {
		expect(
			formatCommandTaskLine(
				task({
					id: 3,
					subject: "Ship",
					status: "in_progress",
					activeForm: "Shipping",
					blockedBy: [1, 2],
				}),
				"◐",
			),
		).toBe("  ◐ #3 Ship (Shipping)    ⛓ #1,#2");
	});
});

describe("todo tool render hooks", () => {
	it("renders create, id-based, and filtered list tool calls", () => {
		const theme = makeTheme();
		const state = stateWith(task({ id: 1, subject: "Known subject" }));

		expect(
			renderText(
				renderTodoCall({ action: "create", subject: "New task" }, theme, state),
			),
		).toBe("todo  + New task");
		expect(
			renderText(renderTodoCall({ action: "update", id: 1 }, theme, state)),
		).toBe("todo  → Known subject");
		expect(
			renderText(renderTodoCall({ action: "get", id: 99 }, theme, state)),
		).toBe("todo  › #99");
		expect(
			renderText(
				renderTodoCall({ action: "list", status: "in_progress" }, theme, state),
			),
		).toBe("todo  ☰ in progress");
	});

	it("renders result status from compatible details", () => {
		const theme = makeTheme();
		const taskOne = task({ id: 1, subject: "Known", status: "completed" });
		const createDetails: TaskDetails = {
			action: "create",
			params: {},
			tasks: [taskOne],
			nextId: 2,
		};
		const updateDetails: TaskDetails = {
			action: "update",
			params: { id: 1, status: "in_progress" },
			tasks: [taskOne],
			nextId: 2,
		};
		const deleteDetails: TaskDetails = {
			action: "delete",
			params: { id: 1 },
			tasks: [{ ...taskOne, status: "deleted" }],
			nextId: 2,
		};
		const listDetails: TaskDetails = {
			action: "list",
			params: {},
			tasks: [taskOne],
			nextId: 2,
		};

		expect(
			renderText(
				renderTodoResult(
					{
						content: [],
						details: createDetails,
					} as AgentToolResult<TaskDetails>,
					theme,
				),
			),
		).toBe("● completed");
		expect(
			renderText(
				renderTodoResult(
					{
						content: [],
						details: updateDetails,
					} as AgentToolResult<TaskDetails>,
					theme,
				),
			),
		).toBe("◐ in progress");
		expect(
			renderText(
				renderTodoResult(
					{
						content: [],
						details: deleteDetails,
					} as AgentToolResult<TaskDetails>,
					theme,
				),
			),
		).toBe("⊘ deleted");
		expect(
			renderText(
				renderTodoResult(
					{ content: [], details: listDetails } as AgentToolResult<TaskDetails>,
					theme,
				),
			),
		).toBe("✓");
	});

	it("falls back to success for malformed create, update, and delete details", () => {
		const theme = makeTheme();
		const malformedResults = [
			{ details: { action: "create", params: {} } },
			{ details: { action: "update", params: null, tasks: [] } },
			{ details: { action: "delete", params: { id: 1 }, tasks: "deleted" } },
		];

		for (const result of malformedResults) {
			expect(() => renderTodoResult(result, theme)).not.toThrow();
			expect(renderText(renderTodoResult(result, theme))).toBe("✓");
		}
	});

	it("falls back to success for invalid result statuses", () => {
		const theme = themeRejectingMissingColors();
		const malformedResults = [
			{
				details: {
					action: "create",
					params: {},
					tasks: [{ id: 1, subject: "Known", status: "archived" }],
				},
			},
			{
				details: {
					action: "update",
					params: { id: 1, status: "archived" },
					tasks: [task({ id: 1, subject: "Known", status: "completed" })],
				},
			},
			{
				details: {
					action: "update",
					params: { id: 1 },
					tasks: [{ id: 1, subject: "Known", status: "archived" }],
				},
			},
			{
				details: {
					action: "delete",
					params: { id: 1 },
					tasks: [{ id: 1, subject: "Known", status: "archived" }],
				},
			},
		];

		for (const result of malformedResults) {
			expect(() => renderTodoResult(result, theme)).not.toThrow();
			expect(renderText(renderTodoResult(result, theme))).toBe("✓");
		}
	});
});
