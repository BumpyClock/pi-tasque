export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function copyKnownErrorFields(error: Error): Record<string, unknown> {
	const record = error as unknown as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of [
		"code",
		"command",
		"details",
		"stderr",
		"stdout",
		"killed",
		"args",
	] as const) {
		if (record[key] !== undefined) {
			output[key] = record[key];
		}
	}
	return output;
}
