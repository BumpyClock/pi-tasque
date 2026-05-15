import { describe, expect, it } from "vitest";
import type { TsqTask } from "../../src/durable-tasks/types.js";

const minimalTask = {
	id: "tsq-1",
	title: "Minimal task",
	kind: "task",
	status: "open",
	planning_state: "needs_planning",
	priority: 0,
	labels: [],
	notes: [],
	created_at: "2026-05-15T00:00:00.000Z",
	updated_at: "2026-05-15T00:00:00.000Z",
} satisfies TsqTask;

// @ts-expect-error planning_state is required by the durable task contract.
const taskWithoutPlanningState: TsqTask = {
	id: "tsq-1",
	title: "Minimal task",
	kind: "task",
	status: "open",
	priority: 0,
	labels: [],
	notes: [],
	created_at: "2026-05-15T00:00:00.000Z",
	updated_at: "2026-05-15T00:00:00.000Z",
};

void taskWithoutPlanningState;

describe("TsqTask type", () => {
	it("accepts planning_state in the minimal task shape", () => {
		expect(minimalTask.planning_state).toBe("needs_planning");
	});
});
