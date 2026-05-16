/**
 * Public contract types and validation for `bulk` and `create_tree` task actions.
 *
 * Defines the input shapes, validates them eagerly, and exports result type
 * scaffolds used by the separate bulk and create-tree executors. Dispatch
 * happens in the unified task tool.
 */

// ── Bulk item contract ─────────────────────────────────────────────

export const BULK_ITEM_ACTIONS = [
	"start",
	"finish",
	"reopen",
	"defer",
	"note",
	"mark_planned",
] as const;

export type BulkItemAction = (typeof BULK_ITEM_ACTIONS)[number];

/** A single lifecycle/note mutation inside a `bulk` call. */
export interface BulkItem {
	/** Lifecycle or note action to run on the target task. */
	readonly action: BulkItemAction;
	/** Durable task id (e.g. "tsq-3"). */
	readonly task: string;
	/** Note/reason text — required for `note`, optional for `finish`/`defer`. */
	readonly because?: string;
}

/** Result shape bulk executors will produce (tsq-6.2). */
export interface BulkResult {
	readonly completed: readonly string[];
	readonly failed?: { readonly task: string; readonly error: string };
	readonly skipped: readonly string[];
}

// ── Create-tree node contract ──────────────────────────────────────

/** A node in the `create_tree` input. Recursive via `children`. */
export interface CreateTreeNode {
	readonly title: string;
	readonly kind: string;
	readonly priority: number;
	readonly description?: string;
	/** Mark this node as already planned. Contradicts `needsPlan`. */
	readonly planned?: boolean;
	/** Mark this node as needing planning. Contradicts `planned`. */
	readonly needsPlan?: boolean;
	readonly children?: readonly CreateTreeNode[];
}

/** Result shape tree executors will produce (tsq-6.3). */
export interface CreateTreeResult {
	readonly created: readonly { readonly id: string; readonly title: string }[];
	readonly failed?: { readonly title: string; readonly error: string };
	readonly skipped: readonly { readonly title: string }[];
}

// ── Validation ─────────────────────────────────────────────────────

type Ok = { readonly ok: true };
type Fail = { readonly ok: false; readonly message: string };
type ValidationResult = Ok | Fail;

const OK: Ok = { ok: true } as const;

function fail(message: string): Fail {
	return { ok: false, message };
}

/**
 * Validate a `bulk` action's `items` array.
 *
 * Rejects: missing/empty array, missing action/task on any item,
 * unsupported action values, missing `because` when action is `note`.
 */
export function validateBulkItems(items: unknown): ValidationResult {
	if (!Array.isArray(items) || items.length === 0) {
		return fail("items must be a non-empty array");
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i] as Record<string, unknown>;
		const prefix = `items[${i}]`;

		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return fail(`${prefix} must be an object`);
		}

		const action = item.action;
		if (typeof action !== "string" || action.trim().length === 0) {
			return fail(`${prefix}.action is required`);
		}
		if (!(BULK_ITEM_ACTIONS as readonly string[]).includes(action)) {
			return fail(
				`${prefix}.action "${action}" is not supported; use one of: ${BULK_ITEM_ACTIONS.join(", ")}`,
			);
		}

		const task = item.task;
		if (typeof task !== "string" || task.trim().length === 0) {
			return fail(`${prefix}.task is required`);
		}

		// `note` requires `because`
		if (action === "note") {
			const because = item.because;
			if (typeof because !== "string" || because.trim().length === 0) {
				return fail(`${prefix}.because is required when action is "note"`);
			}
		}
	}

	return OK;
}

/**
 * Validate a `create_tree` action's `root` node, recursively.
 *
 * Rejects: missing title/kind/priority, contradictory planned+needsPlan,
 * empty children arrays.
 */
export function validateCreateTreeNode(
	node: unknown,
	path = "root",
): ValidationResult {
	if (typeof node !== "object" || node === null || Array.isArray(node)) {
		return fail(`${path} must be an object`);
	}

	const n = node as Record<string, unknown>;

	// Required fields
	if (typeof n.title !== "string" || n.title.trim().length === 0) {
		return fail(`${path}.title is required`);
	}
	if (typeof n.kind !== "string" || n.kind.trim().length === 0) {
		return fail(`${path}.kind is required`);
	}
	if (typeof n.priority !== "number" || !Number.isInteger(n.priority)) {
		return fail(`${path}.priority is required`);
	}

	if (n.description !== undefined && typeof n.description !== "string") {
		return fail(`${path}.description must be a string`);
	}
	if (n.planned !== undefined && typeof n.planned !== "boolean") {
		return fail(`${path}.planned must be a boolean`);
	}
	if (n.needsPlan !== undefined && typeof n.needsPlan !== "boolean") {
		return fail(`${path}.needsPlan must be a boolean`);
	}

	// Contradictory planning flags
	if (n.planned === true && n.needsPlan === true) {
		return fail(`${path}: planned and needsPlan cannot both be true`);
	}

	// Recursive children validation
	if (n.children !== undefined) {
		if (!Array.isArray(n.children) || n.children.length === 0) {
			return fail(`${path}.children must be a non-empty array when provided`);
		}
		for (let i = 0; i < n.children.length; i++) {
			const childResult = validateCreateTreeNode(
				n.children[i],
				`${path}.children[${i}]`,
			);
			if (!childResult.ok) return childResult;
		}
	}

	return OK;
}
