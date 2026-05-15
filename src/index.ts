import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTaskBridgeTool } from "./bridge/bridge-tool.js";
import { importTsqHandler } from "./bridge/import-tsq.js";
import { promoteTodoHandler } from "./bridge/promote-todo.js";
import { registerTasqueStatusLifecycle } from "./durable-tasks/status.js";
import { registerTsqChangeTool } from "./durable-tasks/tools-change.js";
import { registerTsqClaimTool } from "./durable-tasks/tools-claim.js";
import { registerTsqQueryTool } from "./durable-tasks/tools-query.js";
import { registerSessionTodoModule } from "./session-todos/todo.js";

export default function piTasqueExtension(pi: ExtensionAPI): void {
	registerSessionTodoModule(pi);
	registerTsqQueryTool(pi);
	registerTsqChangeTool(pi);
	registerTsqClaimTool(pi);
	registerTaskBridgeTool(pi, {
		promote_todo: promoteTodoHandler,
		import_tsq: importTsqHandler,
	});
	registerTasqueStatusLifecycle(pi);
}
