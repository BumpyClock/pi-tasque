/**
 * Nested create_tree executor for the `task` tool.
 *
 * Walks a validated `CreateTreeNode` tree depth-first, creating each parent
 * before its children and passing the generated parent id via `--parent`.
 *
 * Fail-fast: on the first creation failure the entire remaining tree is
 * skipped — no orphan children are created. No rollback of already-created
 * nodes.
 */

import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { CreateTreeNode, CreateTreeResult } from "./bulk-contract.js";
import { runQueuedMutation } from "./mutation-queue.js";
import { runTsqJson } from "./runner.js";
import {
	okToolDetails,
	textToolResult,
	type StandardToolDetails,
} from "../shared/tool-result.js";

// ── Types ──────────────────────────────────────────────────────────

interface CreatedEntry {
	readonly id: string;
	readonly title: string;
}

interface FailedEntry {
	readonly title: string;
	readonly error: string;
}

interface SkippedEntry {
	readonly title: string;
}

/** Mutable accumulator threaded through the walk. */
interface TreeWalkState {
	readonly created: CreatedEntry[];
	failed?: FailedEntry;
	readonly skipped: SkippedEntry[];
}

export type CreateTreeDetails = ReturnType<
	typeof okToolDetails<CreateTreeResult>
>;

// ── Public API ─────────────────────────────────────────────────────

export async function executeCreateTree(
	pi: ExtensionAPI,
	root: CreateTreeNode,
	signal: AbortSignal | undefined,
	ctx: Pick<ExtensionContext, "cwd">,
): Promise<AgentToolResult<StandardToolDetails<CreateTreeResult>>> {
	const state: TreeWalkState = { created: [], skipped: [] };

	await walkAndCreate(pi, ctx, signal, root, undefined, state);

	const result: CreateTreeResult = {
		created: state.created,
		...(state.failed ? { failed: state.failed } : {}),
		skipped: state.skipped,
	};

	return textToolResult(formatResultText(result), okToolDetails(result));
}

// ── Tree walk ──────────────────────────────────────────────────────

async function walkAndCreate(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	signal: AbortSignal | undefined,
	node: CreateTreeNode,
	parentId: string | undefined,
	state: TreeWalkState,
): Promise<void> {
	// If a prior node already failed, skip this entire subtree.
	if (state.failed) {
		collectSkipped(node, state.skipped);
		return;
	}

	const argv = buildCreateArgv(node, parentId);

	let createdId: string;
	try {
		const result = await runMutation(pi, ctx, argv, signal);
		const extracted = extractCreatedId(result, node.title);
		createdId = extracted.id;
		state.created.push({ id: extracted.id, title: extracted.title });
	} catch (error) {
		state.failed = { title: node.title, error: getErrorMessage(error) };
		// Skip all children of this failed node
		if (node.children) {
			for (const child of node.children) {
				collectSkipped(child, state.skipped);
			}
		}
		return;
	}

	// Recurse into children with the newly created parent id.
	if (node.children) {
		for (const child of node.children) {
			await walkAndCreate(pi, ctx, signal, child, createdId, state);
		}
	}
}

// ── CLI argv builder ───────────────────────────────────────────────

function buildCreateArgv(
	node: CreateTreeNode,
	parentId: string | undefined,
): string[] {
	const argv = [
		"create",
		`--kind=${node.kind}`,
		"-p",
		String(node.priority),
	];

	if (node.description) {
		argv.push(`--description=${node.description}`);
	}
	if (parentId) {
		argv.push(`--parent=${parentId}`);
	}
	if (node.planned === true) {
		argv.push("--planned");
	} else if (node.needsPlan === true) {
		argv.push("--needs-plan");
	}

	argv.push("--", node.title);
	return argv;
}

// ── Mutation runner ────────────────────────────────────────────────

function runMutation(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "cwd">,
	argv: readonly string[],
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const options = signal === undefined ? {} : { signal };
	return runQueuedMutation(ctx.cwd, () =>
		runTsqJson(pi, { cwd: ctx.cwd }, argv, options),
	);
}

// ── Result extraction ──────────────────────────────────────────────

function extractCreatedId(
	result: unknown,
	fallbackTitle: string,
): { readonly id: string; readonly title: string } {
	const root = asRecord(result);
	const task = asRecord(root?.task) ?? root;

	const id = typeof task?.id === "string" ? task.id : undefined;
	if (!id) {
		throw new Error("tsq create did not return a task id");
	}

	const title =
		typeof task?.title === "string" ? task.title : fallbackTitle;
	return { id, title };
}

// ── Skipped collector ──────────────────────────────────────────────

function collectSkipped(
	node: CreateTreeNode,
	skipped: SkippedEntry[],
): void {
	skipped.push({ title: node.title });
	if (node.children) {
		for (const child of node.children) {
			collectSkipped(child, skipped);
		}
	}
}

// ── Text formatting ────────────────────────────────────────────────

function formatResultText(result: CreateTreeResult): string {
	const lines: string[] = [];

	if (result.created.length > 0) {
		const noun = result.created.length === 1 ? "task" : "tasks";
		lines.push(
			`Created ${result.created.length} ${noun}: ${result.created.map((c) => c.id).join(", ")}`,
		);
	}

	if (result.failed) {
		lines.push(`Failed: "${result.failed.title}" — ${result.failed.error}`);
	}

	if (result.skipped.length > 0) {
		lines.push(`${result.skipped.length} skipped`);
	}

	return lines.join("\n");
}

// ── Utilities ──────────────────────────────────────────────────────

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}
