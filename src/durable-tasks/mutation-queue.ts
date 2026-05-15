type MutationFunction<T> = () => T | Promise<T>;

const queueTailsByCwd = new Map<string, Promise<void>>();

export function runQueuedMutation<T>(
	cwd: string,
	fn: MutationFunction<T>,
): Promise<T> {
	const previousTail = queueTailsByCwd.get(cwd) ?? Promise.resolve();
	const operation = previousTail.then(fn, fn);
	const tail = operation.then(
		() => undefined,
		() => undefined,
	);

	queueTailsByCwd.set(cwd, tail);

	void tail.finally(() => {
		if (queueTailsByCwd.get(cwd) === tail) {
			queueTailsByCwd.delete(cwd);
		}
	});

	return operation;
}

/** @internal Exposed for queue cleanup tests. */
export function getQueuedMutationCwdCount(): number {
	return queueTailsByCwd.size;
}
