import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { executeBulk } from "../../src/durable-tasks/tools-bulk.js";
import { createMockPi } from "../support/pi-harness.js";
import type { BulkItem, BulkResult } from "../../src/durable-tasks/bulk-contract.js";

const ctx = (cwd = "/repo") => ({ cwd }) as ExtensionContext;

function okEnvelope(data: unknown) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq mutation",
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function errEnvelope(code: string, message: string) {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command: "tsq mutation",
			ok: false,
			error: { code, message },
		}),
		stderr: "",
		code: 1,
		killed: false,
	};
}

function firstText(result: {
	content: readonly { type: string; text?: string }[];
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || first.text === undefined) {
		throw new Error("expected text content");
	}
	return first.text;
}

function resultData(result: { details: unknown }): BulkResult {
	const d = result.details as { ok: boolean; data: BulkResult };
	if (!d.ok) throw new Error("expected ok details");
	return d.data;
}

function withoutJsonFormat(args: readonly string[]): string[] {
	const output: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--format" && args[index + 1] === "json") {
			index += 1;
			continue;
		}
		if (arg !== undefined) {
			output.push(arg);
		}
	}
	return output;
}

describe("executeBulk", () => {
	function setup() {
		const { pi, captured } = createMockPi();
		captured.execHandler = () =>
			okEnvelope({ task: { id: "tsq-1", title: "Task" } });
		return { pi, captured };
	}

	describe("all items succeed", () => {
		it("returns all task ids in completed with empty skipped", async () => {
			const { pi } = setup();
			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2" },
				{ action: "note", task: "tsq-3", because: "context" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());
			const data = resultData(result);

			expect(data.completed).toEqual(["tsq-1", "tsq-2", "tsq-3"]);
			expect(data.failed).toBeUndefined();
			expect(data.skipped).toEqual([]);
		});

		it("wraps result in okToolDetails", async () => {
			const { pi } = setup();
			const items: BulkItem[] = [{ action: "start", task: "tsq-1" }];

			const result = await executeBulk(pi, items, undefined, ctx());

			expect(result.details).toMatchObject({ ok: true });
		});
	});

	describe("fail-fast on error", () => {
		it("stops at first failure and skips remaining items", async () => {
			const { pi, captured } = createMockPi();
			let callCount = 0;
			captured.execHandler = () => {
				callCount++;
				if (callCount === 2) {
					return errEnvelope("not_found", "Task not found");
				}
				return okEnvelope({ task: { id: "tsq-x" } });
			};

			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2" },
				{ action: "reopen", task: "tsq-3" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());
			const data = resultData(result);

			expect(data.completed).toEqual(["tsq-1"]);
			expect(data.failed).toEqual({
				task: "tsq-2",
				error: "Task not found",
			});
			expect(data.skipped).toEqual(["tsq-3"]);
		});

		it("skips all when first item fails", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				errEnvelope("invalid_status", "Cannot start");

			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "start", task: "tsq-2" },
				{ action: "start", task: "tsq-3" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());
			const data = resultData(result);

			expect(data.completed).toEqual([]);
			expect(data.failed).toEqual({
				task: "tsq-1",
				error: "Cannot start",
			});
			expect(data.skipped).toEqual(["tsq-2", "tsq-3"]);
		});

		it("does not execute tsq commands after failure", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				errEnvelope("not_found", "Task not found");

			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "start", task: "tsq-2" },
			];

			await executeBulk(pi, items, undefined, ctx());

			expect(captured.execCalls).toHaveLength(1);
		});
	});

	describe("action mapping", () => {
		it.each([
			["start", "start"],
			["finish", "done"],
			["reopen", "reopen"],
			["defer", "defer"],
		] as const)(
			"maps bulk %s to tsq %s id-based command",
			async (bulkAction, tsqCommand) => {
				const { pi, captured } = setup();
				const items: BulkItem[] = [
					{ action: bulkAction, task: "tsq-42" },
				];

				await executeBulk(pi, items, undefined, ctx());

				const args = withoutJsonFormat(captured.execCalls[0]!.args);
				expect(args[0]).toBe(tsqCommand);
				expect(args[1]).toBe("tsq-42");
			},
		);

		it("maps note to tsq note with because as text", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [
				{ action: "note", task: "tsq-5", because: "Added context" },
			];

			await executeBulk(pi, items, undefined, ctx());

			const args = withoutJsonFormat(captured.execCalls[0]!.args);
			expect(args).toEqual(["note", "tsq-5", "--", "Added context"]);
		});

		it("maps mark_planned to planned command", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [
				{ action: "mark_planned", task: "tsq-7" },
			];

			await executeBulk(pi, items, undefined, ctx());

			const args = withoutJsonFormat(captured.execCalls[0]!.args);
			expect(args).toEqual(["planned", "tsq-7"]);
		});
	});

	describe("because text forwarding", () => {
		it("forwards because as --note= for finish", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [
				{ action: "finish", task: "tsq-1", because: "Verified" },
			];

			await executeBulk(pi, items, undefined, ctx());

			const args = withoutJsonFormat(captured.execCalls[0]!.args);
			expect(args).toContain("--note=Verified");
		});

		it("forwards because as --note= for defer", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [
				{ action: "defer", task: "tsq-1", because: "Blocked" },
			];

			await executeBulk(pi, items, undefined, ctx());

			const args = withoutJsonFormat(captured.execCalls[0]!.args);
			expect(args).toContain("--note=Blocked");
		});

		it("omits note flag when because is absent for finish", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [{ action: "finish", task: "tsq-1" }];

			await executeBulk(pi, items, undefined, ctx());

			const args = withoutJsonFormat(captured.execCalls[0]!.args);
			expect(args).toEqual(["done", "tsq-1"]);
		});
	});

	describe("text formatting", () => {
		it("formats all-success summary", async () => {
			const { pi } = setup();
			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());

			expect(firstText(result)).toBe("Bulk: 2/2 completed");
		});

		it("formats partial-failure summary with error", async () => {
			const { pi, captured } = createMockPi();
			let callCount = 0;
			captured.execHandler = () => {
				callCount++;
				if (callCount === 2) {
					return errEnvelope("not_found", "Task not found");
				}
				return okEnvelope({ task: { id: "tsq-x" } });
			};

			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2" },
				{ action: "reopen", task: "tsq-3" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());
			const text = firstText(result);

			expect(text).toContain("1/3 completed");
			expect(text).toContain("1 failed");
			expect(text).toContain("1 skipped");
			expect(text).toContain("tsq-2");
			expect(text).toContain("Task not found");
		});

		it("formats single-item success", async () => {
			const { pi } = setup();
			const items: BulkItem[] = [{ action: "start", task: "tsq-1" }];

			const result = await executeBulk(pi, items, undefined, ctx());

			expect(firstText(result)).toBe("Bulk: 1/1 completed");
		});
	});

	describe("result details shape", () => {
		it("wraps partial failure in okToolDetails (not errorToolDetails)", async () => {
			const { pi, captured } = createMockPi();
			captured.execHandler = () =>
				errEnvelope("not_found", "Task not found");

			const items: BulkItem[] = [{ action: "start", task: "tsq-1" }];

			const result = await executeBulk(pi, items, undefined, ctx());

			// Outer details is ok:true — failure info is inside BulkResult
			expect(result.details).toMatchObject({
				ok: true,
				data: {
					completed: [],
					failed: { task: "tsq-1", error: "Task not found" },
					skipped: [],
				},
			});
		});
	});

	describe("sequential execution", () => {
		it("runs items sequentially through mutation queue", async () => {
			const { pi, captured } = createMockPi();
			const startedArgs: string[][] = [];
			let releaseFirst: (() => void) | undefined;
			const firstStarted = new Promise<void>((resolve) => {
				captured.execHandler = async (_command, args) => {
					startedArgs.push(withoutJsonFormat(args));
					if (startedArgs.length === 1) {
						resolve();
						await new Promise<void>((release) => {
							releaseFirst = release;
						});
					}
					return okEnvelope({ task: { id: "tsq-x" } });
				};
			});

			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2" },
			];

			const bulkPromise = executeBulk(pi, items, undefined, ctx());
			await firstStarted;

			// Only first item should have started
			expect(startedArgs).toEqual([["start", "tsq-1"]]);

			releaseFirst?.();
			await bulkPromise;

			// Both should have completed
			expect(startedArgs).toEqual([
				["start", "tsq-1"],
				["done", "tsq-2"],
			]);
		});
	});

	describe("signal forwarding", () => {
		it("passes abort signal to underlying executors", async () => {
			const { pi, captured } = setup();
			const controller = new AbortController();
			const items: BulkItem[] = [{ action: "start", task: "tsq-1" }];

			await executeBulk(pi, items, controller.signal, ctx());

			expect(captured.execCalls[0]?.options).toMatchObject({
				signal: controller.signal,
			});
		});
	});

	describe("mixed action types", () => {
		it("handles all 6 bulk actions in one call", async () => {
			const { pi, captured } = setup();
			const items: BulkItem[] = [
				{ action: "start", task: "tsq-1" },
				{ action: "finish", task: "tsq-2", because: "Done" },
				{ action: "reopen", task: "tsq-3" },
				{ action: "defer", task: "tsq-4", because: "Later" },
				{ action: "note", task: "tsq-5", because: "Info" },
				{ action: "mark_planned", task: "tsq-6" },
			];

			const result = await executeBulk(pi, items, undefined, ctx());
			const data = resultData(result);

			expect(data.completed).toEqual([
				"tsq-1",
				"tsq-2",
				"tsq-3",
				"tsq-4",
				"tsq-5",
				"tsq-6",
			]);
			expect(data.skipped).toEqual([]);
			expect(captured.execCalls).toHaveLength(6);
		});
	});
});
