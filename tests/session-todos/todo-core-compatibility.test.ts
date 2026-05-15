import { describe, expect, it, beforeEach } from "vitest";
import { applyTaskMutation } from "../../src/session-todos/state/state-reducer.js";
import {
	__resetState,
	commitState,
	getState,
} from "../../src/session-todos/state/store.js";
import { replayFromBranch } from "../../src/session-todos/state/replay.js";
import {
	selectTasksByStatus,
	selectTodoCounts,
	selectVisibleTasks,
} from "../../src/session-todos/state/selectors.js";
import type { TaskState } from "../../src/session-todos/state/state.js";
import {
	buildToolResult,
	type TodoToolResult,
} from "../../src/session-todos/tool/response-envelope.js";
import {
	TOOL_NAME,
	type Task,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
} from "../../src/session-todos/tool/types.js";
import {
	formatCommandTaskLine,
	renderTodoResult,
} from "../../src/session-todos/view/format.js";
import { makeTheme } from "../support/theme.js";

function runTodo(
	action: TaskAction,
	params: TaskMutationParams,
): TodoToolResult {
	const mutation = applyTaskMutation(getState(), action, params);
	commitState(mutation.state);
	return buildToolResult(action, params, mutation.state, mutation.op);
}

function todoResult(details: TaskDetails): unknown {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: TOOL_NAME,
			details,
		},
	};
}

function replayDetails(...details: TaskDetails[]): TaskState {
	return replayFromBranch({
		sessionManager: {
			getBranch: () => details.map(todoResult),
		},
	});
}

function textOf(component: { render(width: number): string[] }): string {
	return component
		.render(200)
		.map((line) => line.trimEnd())
		.join("\n");
}

function taskById(state: TaskState, id: number): Task {
	const task = state.tasks.find((candidate) => candidate.id === id);
	if (!task) throw new Error(`missing task #${id}`);
	return task;
}

describe("todo core compatibility", () => {
	beforeEach(() => {
		__resetState();
	});

	it("runs a realistic reducer/store/envelope/replay flow across every todo action", () => {
		expect(TOOL_NAME).toBe("todo");

		const plan = runTodo("create", {
			subject: "Read approved tsq spec",
			description: "Confirm todo compatibility behavior",
			owner: "developer",
			metadata: { tsqId: "tsq-349aqgsj.2.5", phase: "test" },
		});
		const implementation = runTodo("create", {
			subject: "Add todo core compatibility tests",
			description: "Cover reducer, replay, selectors, envelope, and formatting",
			blockedBy: [1],
			metadata: {
				tsqId: "tsq-349aqgsj.2.5",
				context: { parent: "tsq-349aqgsj" },
			},
		});
		const cleanup = runTodo("create", {
			subject: "Remove obsolete todo",
		});
		const startPlan = runTodo("update", {
			id: 1,
			status: "in_progress",
			activeForm: "reading spec",
		});
		const completePlan = runTodo("update", { id: 1, status: "completed" });
		const getImplementation = runTodo("get", { id: 2 });
		const deleteCleanup = runTodo("delete", { id: 3 });
		const visibleList = runTodo("list", {});
		const listWithDeleted = runTodo("list", { includeDeleted: true });
		const cleared = runTodo("clear", {});

		const compatibleDetails = implementation.details satisfies TaskDetails;
		expect(Object.keys(compatibleDetails)).toEqual([
			"action",
			"params",
			"tasks",
			"nextId",
		]);
		expect(implementation.content).toEqual([
			{
				type: "text",
				text: "Created #2: Add todo core compatibility tests (pending)",
			},
		]);
		expect(startPlan.content[0]?.text).toBe(
			"Updated #1 (pending → in_progress)",
		);
		expect(completePlan.content[0]?.text).toBe(
			"Updated #1 (in_progress → completed)",
		);
		expect(getImplementation.content[0]?.text).toContain("blockedBy: #1");
		expect(deleteCleanup.content[0]?.text).toBe(
			"Deleted #3: Remove obsolete todo",
		);
		expect(visibleList.content[0]?.text).toBe(
			"[completed] #1 Read approved tsq spec\n[pending] #2 Add todo core compatibility tests ⛓ #1",
		);
		expect(listWithDeleted.content[0]?.text).toContain(
			"[deleted] #3 Remove obsolete todo",
		);

		const replayed = replayDetails(
			plan.details,
			implementation.details,
			cleanup.details,
			startPlan.details,
			completePlan.details,
			getImplementation.details,
			deleteCleanup.details,
			visibleList.details,
			listWithDeleted.details,
		);

		expect(replayed).toEqual({
			tasks: listWithDeleted.details.tasks,
			nextId: listWithDeleted.details.nextId,
		});
		expect(selectVisibleTasks(replayed).map((task) => task.id)).toEqual([1, 2]);
		expect(selectTasksByStatus(replayed)).toMatchObject({
			pending: [{ id: 2 }],
			inProgress: [],
			completed: [{ id: 1 }],
		});
		expect(selectTodoCounts(replayed)).toEqual({
			total: 2,
			pending: 1,
			inProgress: 0,
			completed: 1,
		});
		expect(formatCommandTaskLine(taskById(replayed, 2), "○")).toBe(
			"  ○ #2 Add todo core compatibility tests    ⛓ #1",
		);
		expect(textOf(renderTodoResult(completePlan, makeTheme()))).toBe(
			"● completed",
		);

		expect(cleared.details).toEqual({
			action: "clear",
			params: {},
			tasks: [],
			nextId: 1,
		});
		expect(getState()).toEqual({ tasks: [], nextId: 1 });
	});

	it("keeps deleted tombstones out of visible selectors but available via includeDeleted response text", () => {
		runTodo("create", { subject: "Visible todo" });
		runTodo("create", { subject: "Deleted todo" });
		const deleted = runTodo("delete", { id: 2 });
		const defaultList = runTodo("list", {});
		const withDeleted = runTodo("list", { includeDeleted: true });

		expect(taskById(defaultList.details, 2)).toMatchObject({
			id: 2,
			status: "deleted",
			subject: "Deleted todo",
		});

		const replayed = replayDetails(deleted.details, defaultList.details);

		expect(taskById(replayed, 2)).toMatchObject({
			id: 2,
			status: "deleted",
		});
		expect(selectVisibleTasks(replayed).map((task) => task.id)).toEqual([1]);
		expect(selectVisibleTasks(replayed).map((task) => task.subject)).toEqual([
			"Visible todo",
		]);
		expect(defaultList.content[0]?.text).toBe("[pending] #1 Visible todo");
		expect(defaultList.content[0]?.text).not.toContain("Deleted todo");
		expect(withDeleted.content[0]?.text).toContain("[deleted] #2 Deleted todo");
	});

	it("clones metadata and blockedBy through params, details, store, and replay without mutation leaks", () => {
		const metadata = {
			tsqId: "tsq-349aqgsj.2.5",
			blockedBecause: { source: "dependency" },
			labels: ["compat"],
		};
		const blockedBy = [1];

		runTodo("create", { subject: "Prerequisite" });
		const dependent = runTodo("create", {
			subject: "Dependent todo",
			blockedBy,
			metadata,
		});
		const list = runTodo("list", { includeDeleted: true });

		blockedBy.push(99);
		metadata.blockedBecause.source = "caller-mutated";
		metadata.labels.push("caller-mutated");

		expect(dependent.details.params).toMatchObject({
			blockedBy: [1],
			metadata: {
				tsqId: "tsq-349aqgsj.2.5",
				blockedBecause: { source: "dependency" },
				labels: ["compat"],
			},
		});
		expect(taskById(list.details, 2)).toMatchObject({
			blockedBy: [1],
			metadata: {
				tsqId: "tsq-349aqgsj.2.5",
				blockedBecause: { source: "dependency" },
				labels: ["compat"],
			},
		});

		const replayed = replayDetails(list.details);
		const replayedTask = taskById(replayed, 2);
		replayedTask.blockedBy?.push(100);
		(replayedTask.metadata?.blockedBecause as { source: string }).source =
			"replay-mutated";
		(replayedTask.metadata?.labels as string[]).push("replay-mutated");

		expect(taskById(list.details, 2)).toMatchObject({
			blockedBy: [1],
			metadata: {
				tsqId: "tsq-349aqgsj.2.5",
				blockedBecause: { source: "dependency" },
				labels: ["compat"],
			},
		});
		expect(taskById(getState(), 2)).toMatchObject({
			blockedBy: [1],
			metadata: {
				tsqId: "tsq-349aqgsj.2.5",
				blockedBecause: { source: "dependency" },
				labels: ["compat"],
			},
		});
	});
});
