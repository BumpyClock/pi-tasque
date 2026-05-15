import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { runQueuedMutation } from "../../src/durable-tasks/mutation-queue.js";
import { runTsqJson, TsqCommandError } from "../../src/durable-tasks/runner.js";
import { createMockPi } from "../support/pi-harness.js";

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});

	return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function okResult(command: string, data: unknown): ExecResult {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command,
			ok: true,
			data,
		}),
		stderr: "",
		code: 0,
		killed: false,
	};
}

function commandErrorResult(command: string): ExecResult {
	return {
		stdout: JSON.stringify({
			schema_version: 1,
			command,
			ok: false,
			error: {
				code: "conflict",
				message: "task is locked",
			},
		}),
		stderr: "",
		code: 1,
		killed: false,
	};
}

describe("runQueuedMutation + runTsqJson integration", () => {
	it("serializes same-cwd mutating tsq JSON calls in queue order", async () => {
		const { pi, captured } = createMockPi();
		const firstExec = deferred<ExecResult>();
		const secondExec = deferred<ExecResult>();
		captured.execHandler = (_command, args) => {
			if (args[0] === "start") {
				return firstExec.promise;
			}
			if (args[0] === "done") {
				return secondExec.promise;
			}
			throw new Error(`unexpected tsq args: ${args.join(" ")}`);
		};

		const firstResult = runQueuedMutation("/repo", () =>
			runTsqJson<{ id: string }>(pi, { cwd: "/repo" }, ["start", "tsq-1"]),
		);
		const secondResult = runQueuedMutation("/repo", () =>
			runTsqJson<{ id: string }>(pi, { cwd: "/repo" }, ["done", "tsq-1"]),
		);

		await flushMicrotasks();

		expect(captured.execCalls).toHaveLength(1);
		expect(captured.execCalls[0]).toMatchObject({
			command: "tsq",
			args: ["start", "tsq-1", "--format", "json"],
			options: { cwd: "/repo" },
		});

		firstExec.resolve(okResult("tsq start tsq-1", { id: "tsq-1" }));
		await expect(firstResult).resolves.toEqual({ id: "tsq-1" });
		await flushMicrotasks();

		expect(captured.execCalls).toHaveLength(2);
		expect(captured.execCalls[1]).toMatchObject({
			command: "tsq",
			args: ["done", "tsq-1", "--format", "json"],
			options: { cwd: "/repo" },
		});

		secondExec.resolve(okResult("tsq done tsq-1", { id: "tsq-1" }));
		await expect(secondResult).resolves.toEqual({ id: "tsq-1" });
	});

	it("lets different-cwd tsq JSON calls proceed independently through the queue", async () => {
		const { pi, captured } = createMockPi();
		const repoAExec = deferred<ExecResult>();
		const repoBExec = deferred<ExecResult>();
		captured.execHandler = (_command, _args, options) => {
			if (options?.cwd === "/repo-a") {
				return repoAExec.promise;
			}
			if (options?.cwd === "/repo-b") {
				return repoBExec.promise;
			}
			throw new Error(`unexpected cwd: ${String(options?.cwd)}`);
		};

		const repoAResult = runQueuedMutation("/repo-a", () =>
			runTsqJson<{ id: string }>(pi, { cwd: "/repo-a" }, ["start", "tsq-a"]),
		);
		const repoBResult = runQueuedMutation("/repo-b", () =>
			runTsqJson<{ id: string }>(pi, { cwd: "/repo-b" }, ["start", "tsq-b"]),
		);

		await flushMicrotasks();

		expect(captured.execCalls).toHaveLength(2);
		expect(captured.execCalls.map((call) => call.options?.cwd)).toEqual([
			"/repo-a",
			"/repo-b",
		]);

		repoBExec.resolve(okResult("tsq start tsq-b", { id: "tsq-b" }));
		await expect(repoBResult).resolves.toEqual({ id: "tsq-b" });

		repoAExec.resolve(okResult("tsq start tsq-a", { id: "tsq-a" }));
		await expect(repoAResult).resolves.toEqual({ id: "tsq-a" });
	});

	it("does not poison later same-cwd queued tsq JSON mutations after a failed mutation", async () => {
		const { pi, captured } = createMockPi();
		const firstExec = deferred<ExecResult>();
		const secondExec = deferred<ExecResult>();
		captured.execHandler = (_command, args) => {
			if (args[0] === "claim") {
				return firstExec.promise;
			}
			if (args[0] === "note") {
				return secondExec.promise;
			}
			throw new Error(`unexpected tsq args: ${args.join(" ")}`);
		};

		const failedResult = runQueuedMutation("/repo", () =>
			runTsqJson(pi, { cwd: "/repo" }, ["claim", "tsq-1"]),
		);
		const laterResult = runQueuedMutation("/repo", () =>
			runTsqJson<{ id: string }>(pi, { cwd: "/repo" }, [
				"note",
				"tsq-2",
				"still runs",
			]),
		);

		await flushMicrotasks();
		expect(captured.execCalls).toHaveLength(1);

		firstExec.resolve(commandErrorResult("tsq claim tsq-1"));
		await expect(failedResult).rejects.toBeInstanceOf(TsqCommandError);
		await flushMicrotasks();

		expect(captured.execCalls).toHaveLength(2);
		expect(captured.execCalls[1]).toMatchObject({
			command: "tsq",
			args: ["note", "tsq-2", "still runs", "--format", "json"],
			options: { cwd: "/repo" },
		});

		secondExec.resolve(okResult("tsq note tsq-2", { id: "tsq-2" }));
		await expect(laterResult).resolves.toEqual({ id: "tsq-2" });
	});
});
