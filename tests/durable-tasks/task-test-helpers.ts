import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockPi } from "../support/pi-harness.js";

export const ctx = { cwd: "/repo/packages/app" } as ExtensionContext;

export function okEnvelope(data: unknown) {
	return JSON.stringify({
		schema_version: 1,
		command: "tsq",
		ok: true,
		data,
	});
}

export function makePi() {
	const { pi, captured } = createMockPi();
	captured.execHandler = (command, _args) => {
		if (command === "git") {
			return { stdout: "/repo\n", stderr: "", code: 0, killed: false };
		}
		return {
			stdout: okEnvelope({ tasks: [] }),
			stderr: "",
			code: 0,
			killed: false,
		};
	};
	return { pi, captured };
}
