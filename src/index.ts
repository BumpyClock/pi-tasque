import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskTool } from "./durable-tasks/task-tool.js";
import { registerTasqueStatusLifecycle } from "./durable-tasks/status.js";
import { registerSessionTodoModule } from "./session-todos/todo.js";

export default function piTasqueExtension(pi: ExtensionAPI): void {
	registerSessionTodoModule(pi);
	registerTaskTool(pi);
	registerTasqueStatusLifecycle(pi);
}
