export const TSQ_CHANGE_ACTIONS = [
	"create",
	"note",
	"done",
	"reopen",
	"defer",
	"start",
	"claim_assign_only",
	"block",
	"unblock",
	"order",
	"unorder",
] as const;

export type TsqChangeAction = (typeof TSQ_CHANGE_ACTIONS)[number];

export type ValidationResult =
	| {
			readonly ok: true;
			readonly action: TsqChangeAction;
			readonly argv: string[];
	  }
	| { readonly ok: false; readonly message: string };

export function buildMutationCommand(
	params: Readonly<Record<string, unknown>>,
): ValidationResult {
	const action = params.action;
	if (!isTsqChangeAction(action)) {
		return {
			ok: false,
			message: "action must be a supported durable task mutation",
		};
	}

	switch (action) {
		case "create":
			return buildCreateArgv(params, action);
		case "note":
			return buildNoteArgv(params, action);
		case "done":
			return buildOptionalNoteArgv(params, action, "done");
		case "reopen":
			return buildIdOnlyArgv(params, action, "reopen");
		case "defer":
			return buildOptionalNoteArgv(params, action, "defer");
		case "start":
			return buildIdOnlyArgv(params, action, "start");
		case "claim_assign_only":
			return buildClaimAssignOnlyArgv(params, action);
		case "block":
			return buildBlockArgv(params, action, "block");
		case "unblock":
			return buildBlockArgv(params, action, "unblock");
		case "order":
			return buildOrderArgv(params, action, "order");
		case "unorder":
			return buildOrderArgv(params, action, "unorder");
	}
}

export function isTsqChangeAction(value: unknown): value is TsqChangeAction {
	return (
		typeof value === "string" &&
		(TSQ_CHANGE_ACTIONS as readonly string[]).includes(value)
	);
}

// --- argv builders ---

function buildCreateArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const title = requireNonEmptyString(params, "title");
	if (!title.ok) {
		return title;
	}
	const kind = requireNonEmptyString(params, "kind");
	if (!kind.ok) {
		return kind;
	}
	const priority = requireInteger(params, "priority");
	if (!priority.ok) {
		return priority;
	}
	const planned = getOptionalBoolean(params, "planned");
	if (!planned.ok) {
		return planned;
	}
	const needsPlan = getOptionalBoolean(params, "needsPlan");
	if (!needsPlan.ok) {
		return needsPlan;
	}
	if (planned.value === true && needsPlan.value === true) {
		return {
			ok: false,
			message: "planned and needsPlan cannot both be true",
		};
	}

	const argv = ["create", `--kind=${kind.value}`, "-p", String(priority.value)];
	const description = appendOptionalStringFlag(
		argv,
		params,
		"description",
		"--description",
	);
	if (description !== undefined) {
		return description;
	}
	const parent = appendOptionalStringFlag(argv, params, "parent", "--parent");
	if (parent !== undefined) {
		return parent;
	}
	if (planned.value === true) {
		argv.push("--planned");
	} else if (needsPlan.value === true) {
		argv.push("--needs-plan");
	}
	argv.push("--", title.value);

	return { ok: true, action, argv };
}

function buildNoteArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const note = requireNonEmptyString(params, "note");
	if (!note.ok) {
		return note;
	}
	return { ok: true, action, argv: ["note", id.value, "--", note.value] };
}

function buildOptionalNoteArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "done" | "defer",
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const argv = [command, id.value];
	const note = getOptionalNonEmptyString(params, "note");
	if (!note.ok) {
		return note;
	}
	if (note.value !== undefined) {
		argv.push(`--note=${note.value}`);
	}
	return { ok: true, action, argv };
}

function buildIdOnlyArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "reopen" | "start",
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	return { ok: true, action, argv: [command, id.value] };
}

function buildClaimAssignOnlyArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
): ValidationResult {
	const id = requireNonEmptyString(params, "id");
	if (!id.ok) {
		return id;
	}
	const assignee = requireNonEmptyString(params, "assignee");
	if (!assignee.ok) {
		return assignee;
	}
	return {
		ok: true,
		action,
		argv: ["claim", id.value, `--assignee=${assignee.value}`],
	};
}

function buildBlockArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "block" | "unblock",
): ValidationResult {
	const child = requireNonEmptyString(params, "child");
	if (!child.ok) {
		return child;
	}
	const blocker = requireNonEmptyString(params, "blocker");
	if (!blocker.ok) {
		return blocker;
	}
	if (child.value === blocker.value) {
		return { ok: false, message: "child and blocker cannot be the same task" };
	}
	return {
		ok: true,
		action,
		argv: [command, child.value, "by", blocker.value],
	};
}

function buildOrderArgv(
	params: Readonly<Record<string, unknown>>,
	action: TsqChangeAction,
	command: "order" | "unorder",
): ValidationResult {
	const later = requireNonEmptyString(params, "later");
	if (!later.ok) {
		return later;
	}
	const earlier = requireNonEmptyString(params, "earlier");
	if (!earlier.ok) {
		return earlier;
	}
	if (later.value === earlier.value) {
		return { ok: false, message: "later and earlier cannot be the same task" };
	}
	return {
		ok: true,
		action,
		argv: [command, later.value, "after", earlier.value],
	};
}

function appendOptionalStringFlag(
	argv: string[],
	params: Readonly<Record<string, unknown>>,
	field: "description" | "parent",
	flag: string,
): ValidationResult | undefined {
	const value = getOptionalNonEmptyString(params, field);
	if (!value.ok) {
		return value;
	}
	if (value.value !== undefined) {
		argv.push(`${flag}=${value.value}`);
	}
	return undefined;
}

// --- validation helpers (params+field pattern, specific to builders) ---

function requireNonEmptyString(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return { ok: false, message: `${field} is required` };
	}
	return { ok: true, value };
}

function getOptionalNonEmptyString(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: string | undefined }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (typeof value !== "string") {
		return { ok: false, message: `${field} must be a string` };
	}
	if (value.trim().length === 0) {
		return { ok: true, value: undefined };
	}
	return { ok: true, value };
}

function requireInteger(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { ok: false, message: `${field} is required` };
	}
	return { ok: true, value };
}

function getOptionalBoolean(
	params: Readonly<Record<string, unknown>>,
	field: string,
):
	| { readonly ok: true; readonly value: boolean | undefined }
	| { readonly ok: false; readonly message: string } {
	const value = params[field];
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (typeof value !== "boolean") {
		return { ok: false, message: `${field} must be a boolean` };
	}
	return { ok: true, value };
}
