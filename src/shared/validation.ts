export function definedParams<T>(params: Record<string, unknown>): T {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			output[key] = value;
		}
	}
	return output as T;
}

export function fieldRequired(field: string): {
	readonly ok: false;
	readonly message: string;
} {
	return { ok: false, message: `${field} is required` };
}

export function requireStringField(
	value: string | undefined,
	field: string,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
	return typeof value === "string" && value.trim().length > 0
		? { ok: true }
		: fieldRequired(field);
}
