import { describe, expect, it } from "vitest";
import type { Task } from "../../src/session-todos/tool/types.js";
import {
	deriveBlocks,
	detectCycle,
} from "../../src/session-todos/state/task-graph.js";

const task = (
	overrides: Partial<Task> & { id: number; subject: string },
): Task => ({
	status: "pending",
	...overrides,
});

describe("detectCycle", () => {
	it("detects direct cycles", () => {
		const tasks = [
			task({ id: 1, subject: "A" }),
			task({ id: 2, subject: "B", blockedBy: [1] }),
		];
		expect(detectCycle(tasks, 1, [2])).toBe(true);
	});

	it("detects indirect cycles", () => {
		const tasks = [
			task({ id: 1, subject: "A", blockedBy: [2] }),
			task({ id: 2, subject: "B", blockedBy: [3] }),
			task({ id: 3, subject: "C" }),
		];
		expect(detectCycle(tasks, 3, [1])).toBe(true);
	});

	it("returns false for acyclic blockedBy graph updates", () => {
		const tasks = [
			task({ id: 1, subject: "Design" }),
			task({ id: 2, subject: "Build", blockedBy: [1] }),
			task({ id: 3, subject: "Test" }),
		];
		expect(detectCycle(tasks, 3, [2])).toBe(false);
	});

	it("merges proposed blockers with existing blockers", () => {
		const tasks = [
			task({ id: 1, subject: "A", blockedBy: [2] }),
			task({ id: 2, subject: "B" }),
		];
		expect(detectCycle(tasks, 2, [1])).toBe(true);
	});

	it("does not mutate task blockedBy arrays while checking", () => {
		const originalBlockedBy = [1];
		const tasks = [
			task({ id: 1, subject: "A" }),
			task({ id: 2, subject: "B", blockedBy: originalBlockedBy }),
		];
		detectCycle(tasks, 2, [1]);
		expect(originalBlockedBy).toEqual([1]);
	});
});

describe("deriveBlocks", () => {
	it("returns an empty map when no tasks are blocked", () => {
		expect(deriveBlocks([task({ id: 1, subject: "A" })]).size).toBe(0);
	});

	it("inverts blockedBy references into blocked task ids", () => {
		const blocks = deriveBlocks([
			task({ id: 1, subject: "Blocker" }),
			task({ id: 2, subject: "Blocked", blockedBy: [1] }),
			task({ id: 3, subject: "Also blocked", blockedBy: [1, 2] }),
		]);

		expect(blocks.get(1)).toEqual([2, 3]);
		expect(blocks.get(2)).toEqual([3]);
		expect(blocks.get(3)).toBeUndefined();
	});
});
