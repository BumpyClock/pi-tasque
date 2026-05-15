import type {
	ExecOptions,
	ExecResult,
	ExtensionAPI,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type EventHandler = (...args: unknown[]) => unknown;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

type ExecHandler = (
	command: string,
	args: string[],
	options: ExecOptions | undefined,
) => ExecResult | Promise<ExecResult>;

export interface ExecCall {
	command: string;
	args: string[];
	options: ExecOptions | undefined;
}

export interface CapturedPi {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, CommandOptions>;
	handlers: Map<string, EventHandler[]>;
	execCalls: ExecCall[];
	activeTools: string[];
	execHandler?: ExecHandler;
}

export function createMockPi(overrides: Partial<ExtensionAPI> = {}): {
	pi: ExtensionAPI;
	captured: CapturedPi;
} {
	const captured: CapturedPi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		execCalls: [],
		activeTools: [],
	};

	const pi = {
		on(event: string, handler: EventHandler): void {
			const handlers = captured.handlers.get(event) ?? [];
			handlers.push(handler);
			captured.handlers.set(event, handlers);
		},

		registerTool(tool: ToolDefinition): void {
			if (captured.tools.has(tool.name)) {
				throw new Error(`Duplicate tool registration: ${tool.name}`);
			}
			captured.tools.set(tool.name, tool);
		},

		registerCommand(name: string, options: CommandOptions): void {
			if (captured.commands.has(name)) {
				throw new Error(`Duplicate command registration: ${name}`);
			}
			captured.commands.set(name, options);
		},

		async exec(
			command: string,
			args: string[],
			options?: ExecOptions,
		): Promise<ExecResult> {
			const call = { command, args: [...args], options };
			captured.execCalls.push(call);
			if (captured.execHandler) {
				return captured.execHandler(command, [...args], options);
			}
			return { stdout: "", stderr: "", code: 0, killed: false };
		},

		getActiveTools(): string[] {
			return [...captured.activeTools];
		},

		getAllTools(): ReturnType<ExtensionAPI["getAllTools"]> {
			return Array.from(captured.tools.values()).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})) as ReturnType<ExtensionAPI["getAllTools"]>;
		},

		setActiveTools(toolNames: string[]): void {
			captured.activeTools = [...toolNames];
		},

		...overrides,
	} as unknown as ExtensionAPI;

	return { pi, captured };
}

export async function emitPiEvent(
	captured: CapturedPi,
	event: string,
	...args: unknown[]
): Promise<unknown[]> {
	const handlers = captured.handlers.get(event) ?? [];
	return Promise.all(handlers.map((handler) => handler(...args)));
}
