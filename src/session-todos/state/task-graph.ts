import type { Task } from "../tool/types.js";

/**
 * Checks whether merging `newBlockedBy` into `taskId`'s blockedBy set would
 * introduce any cycle in the todo dependency graph.
 */
export function detectCycle(
	taskList: readonly Task[],
	taskId: number,
	newBlockedBy: readonly number[],
): boolean {
	const edges = new Map<number, number[]>();

	for (const task of taskList) {
		if (task.id === taskId) {
			const merged = new Set([...(task.blockedBy ?? []), ...newBlockedBy]);
			edges.set(task.id, [...merged]);
		} else {
			edges.set(task.id, [...(task.blockedBy ?? [])]);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();

	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;

		visiting.add(node);
		for (const blocker of edges.get(node) ?? []) {
			if (hasCycleFrom(blocker)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

/**
 * Inverts blockedBy edges: blocker id -> task ids blocked by that blocker.
 */
export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const task of taskList) {
		for (const blockerId of task.blockedBy ?? []) {
			const blockedTaskIds = blocks.get(blockerId) ?? [];
			blockedTaskIds.push(task.id);
			blocks.set(blockerId, blockedTaskIds);
		}
	}
	return blocks;
}
