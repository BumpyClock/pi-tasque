import { describe, expect, expectTypeOf, it } from "vitest";
import {
	COMMAND_NAME,
	TodoParamsSchema,
	TOOL_LABEL,
	TOOL_NAME,
	type Task,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
	type TaskStatus,
	type TodoParams,
} from "../../src/session-todos/tool/types.js";

describe("session todo tool types", () => {
	it("keeps pi-tasque todo identity strings stable", () => {
		expect(TOOL_NAME).toBe("todo");
		expect(TOOL_LABEL).toBe("Todo");
		expect(COMMAND_NAME).toBe("todos");
	});

	it("keeps the replay snapshot stable", () => {
		const task: Task = {
			id: 1,
			subject: "Port todo types",
			status: "in_progress",
			blockedBy: [2],
			owner: "agent",
			metadata: { source: "test" },
		};
		const details: TaskDetails = {
			action: "create",
			params: { subject: task.subject },
			tasks: [task],
			nextId: 2,
		};

		expect(details).toEqual({
			action: "create",
			params: { subject: "Port todo types" },
			tasks: [task],
			nextId: 2,
		});
		expectTypeOf<TaskStatus>().toEqualTypeOf<
			"pending" | "in_progress" | "completed" | "deleted"
		>();
		expectTypeOf<TaskAction>().toEqualTypeOf<
			"create" | "update" | "list" | "get" | "delete" | "clear"
		>();
		expectTypeOf<TaskDetails>().toMatchTypeOf<{
			action: TaskAction;
			params: Record<string, unknown>;
			tasks: Task[];
			nextId: number;
			error?: string;
		}>();
	});

	it("keeps reducer params open while preserving known todo fields", () => {
		const mutation: TaskMutationParams = {
			subject: "Add schemas",
			description: "Mirror upstream shape",
			activeForm: "adding schemas",
			status: "pending",
			blockedBy: [1],
			addBlockedBy: [2],
			removeBlockedBy: [3],
			owner: "agent",
			metadata: { priority: "high" },
			id: 4,
			includeDeleted: false,
			extraReplayField: true,
		};

		expect(mutation.extraReplayField).toBe(true);
	});

	it("defines the TypeBox params schema with v1 action and status enums", () => {
		expect(TodoParamsSchema.type).toBe("object");
		expect(TodoParamsSchema.required).toEqual(["action"]);
		expect(Object.keys(TodoParamsSchema.properties)).toEqual([
			"action",
			"subject",
			"description",
			"activeForm",
			"status",
			"blockedBy",
			"addBlockedBy",
			"removeBlockedBy",
			"owner",
			"metadata",
			"id",
			"includeDeleted",
		]);
		expect(TodoParamsSchema.properties.action).toMatchObject({
			type: "string",
			enum: ["create", "update", "list", "get", "delete", "clear"],
		});
		expect(TodoParamsSchema.properties.status).toMatchObject({
			type: "string",
			enum: ["pending", "in_progress", "completed", "deleted"],
			description: "Target status (update) or list filter (list)",
		});

		const params: TodoParams = {
			action: "list",
			status: "completed",
			includeDeleted: true,
		};
		expect(params).toEqual({
			action: "list",
			status: "completed",
			includeDeleted: true,
		});
	});
});
