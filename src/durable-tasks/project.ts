import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_GIT_TIMEOUT_MS = 5_000;

export interface ProjectResolutionOptions {
	readonly signal?: AbortSignal;
	readonly timeout?: number;
}

export class ProjectResolutionError extends Error {
	override readonly name = "ProjectResolutionError";
	readonly cwd: string;
	readonly code: number;
	readonly stderr: string;
	readonly stdout: string;
	readonly killed: boolean;

	constructor(
		cwd: string,
		result: {
			readonly code: number;
			readonly stderr: string;
			readonly stdout: string;
			readonly killed: boolean;
		},
	) {
		super(buildProjectResolutionMessage(cwd, result));
		this.cwd = cwd;
		this.code = result.code;
		this.stderr = result.stderr;
		this.stdout = result.stdout;
		this.killed = result.killed;
	}
}

export async function resolveProjectRoot(
	pi: ExtensionAPI,
	cwd: string,
	options: ProjectResolutionOptions = {},
): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		timeout: options.timeout ?? DEFAULT_GIT_TIMEOUT_MS,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});

	const projectRoot = result.stdout.trim();
	if (result.code !== 0 || result.killed || projectRoot.length === 0) {
		throw new ProjectResolutionError(cwd, result);
	}

	return projectRoot;
}

function buildProjectResolutionMessage(
	cwd: string,
	result: {
		readonly code: number;
		readonly stderr: string;
		readonly stdout: string;
		readonly killed: boolean;
	},
): string {
	if (result.killed) {
		return `Unable to resolve Tasque project root from ${cwd}: git rev-parse timed out`;
	}
	const detail = (result.stderr || result.stdout).replace(/\s+/gu, " ").trim();
	return detail.length === 0
		? `Unable to resolve Tasque project root from ${cwd}`
		: `Unable to resolve Tasque project root from ${cwd}: ${detail}`;
}
