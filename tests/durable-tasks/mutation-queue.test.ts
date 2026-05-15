import { describe, expect, it } from "vitest";
import {
	getQueuedMutationCwdCount,
	runQueuedMutation,
} from "../../src/durable-tasks/mutation-queue.js";

function deferred<T = void>() {
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

describe("runQueuedMutation", () => {
	it("runs operations for the same cwd sequentially in call order", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const events: string[] = [];

		const firstResult = runQueuedMutation("/repo", async () => {
			events.push("first:start");
			return first.promise;
		});
		const secondResult = runQueuedMutation("/repo", async () => {
			events.push("second:start");
			return second.promise;
		});

		await flushMicrotasks();

		expect(events).toEqual(["first:start"]);

		first.resolve("first done");
		await expect(firstResult).resolves.toBe("first done");
		await flushMicrotasks();

		expect(events).toEqual(["first:start", "second:start"]);

		second.resolve("second done");
		await expect(secondResult).resolves.toBe("second done");
	});

	it("allows operations for different cwd values to run independently", async () => {
		const repoA = deferred<string>();
		const repoB = deferred<string>();
		const events: string[] = [];

		const repoAResult = runQueuedMutation("/repo-a", async () => {
			events.push("a:start");
			return repoA.promise;
		});
		const repoBResult = runQueuedMutation("/repo-b", async () => {
			events.push("b:start");
			return repoB.promise;
		});

		await flushMicrotasks();

		expect(events).toEqual(["a:start", "b:start"]);

		repoB.resolve("b done");
		repoA.resolve("a done");

		await expect(repoBResult).resolves.toBe("b done");
		await expect(repoAResult).resolves.toBe("a done");
	});

	it("continues running later same-cwd operations after a rejection", async () => {
		const first = deferred<string>();
		const second = deferred<string>();
		const events: string[] = [];

		const firstResult = runQueuedMutation("/repo-failure", async () => {
			events.push("first:start");
			return first.promise;
		});
		const secondResult = runQueuedMutation("/repo-failure", async () => {
			events.push("second:start");
			return second.promise;
		});

		await flushMicrotasks();
		first.reject(new Error("boom"));
		await expect(firstResult).rejects.toThrow("boom");
		await flushMicrotasks();

		expect(events).toEqual(["first:start", "second:start"]);

		second.resolve("recovered");
		await expect(secondResult).resolves.toBe("recovered");
		await flushMicrotasks();

		expect(getQueuedMutationCwdCount()).toBe(0);
	});

	it("cleans up idle queue entries after operations finish", async () => {
		const done = deferred<string>();

		const result = runQueuedMutation("/repo-cleanup", async () => done.promise);

		await flushMicrotasks();
		expect(getQueuedMutationCwdCount()).toBeGreaterThanOrEqual(1);

		done.resolve("done");
		await expect(result).resolves.toBe("done");
		await flushMicrotasks();

		expect(getQueuedMutationCwdCount()).toBe(0);
	});
});
