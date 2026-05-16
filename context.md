# Code Context

## Files Retrieved
1. `src/index.ts` (lines 1-10) – extension registration entrypoint; confirms what tools/handlers are actually wired.
2. `src/durable-tasks/status.ts` (lines 1-168) – `registerTasqueStatusLifecycle`, `session_start`, `tool_execution_end`, `session_shutdown`, and status refresh trigger logic.
3. `src/durable-tasks/cache.ts` (lines 45-118) – `refreshTasqueStatusCache` read-only tsq query sequence (`doctor`, `find ready`, `find in-progress`) and stale/error formatting.
4. `src/durable-tasks/task-tool.ts` (lines 23-55, 173-205, 465-467, 516-523) – `task` tool schema/actions, `actionUsesTasque`, execute flow, root resolution, and dispatch.
5. `src/durable-tasks/project.ts` (lines 36-53, 55-71) – `resolveProjectRoot` using `git rev-parse --show-toplevel`.
6. `src/bridge/bridge-tool.ts` (lines 32-86) – bridge action dispatch (`link`, `list_links`, `promote_todo`, `import_tsq`) invoked via `task` action.
7. `src/bridge/promote-todo.ts` (lines 35-163, 67-71) – explicit `promote` bridge flow; mutates Tasque via `tsq create` + `tsq note`.
8. `src/bridge/import-tsq.ts` (lines 79-121, 128-155) – explicit `import` bridge flow; mutates no Tasque, reads Tasque tree/show and mutates session todo state.
9. `src/durable-tasks/tools-change.ts` (lines 144-194, 19-20, 125-141) – durable mutation command mapping + `runQueuedMutation` wrapper + `runTsqJson` invocation.
10. `src/durable-tasks/tools-claim.ts` (lines 121-139, 135-137, 221-247) – durable claim mutation + optional linked todo creation.
11. `src/durable-tasks/tools-query.ts` (lines 125-151, 153-197) – read-only Tasque commands via `runTsqJson`.
12. `src/durable-tasks/runner.ts` (lines 63-95, 160-205) – shared tsq executor and JSON envelope enforcement.
13. `src/session-todos/todo.ts` (lines 161-217, 202-206) – session todo lifecycle and `session_start` replay/update behavior.
14. `src/session-todos/state/replay.ts` (lines 233-269) – branch replay reconstructing todos from prior `todo` + `task` results, including bridge snapshots.
15. `src/durable-tasks/mutation-queue.ts` (lines 3-21) – mutation serialization keyed by `cwd`.
16. `tests/integration/pi-tasque.register.test.ts` (lines 22-33, 47-83) – asserted registered tool set is only `task` + `todo`.
17. `tests/durable-tasks/task-tool.test.ts` (lines 57-74, 144-158, 161-183) – validates project-root resolution and that bridge-only actions validate before tsq.
18. `tests/durable-tasks/status.test.ts` (lines 182-245, 310-392) – asserts startup status footer refresh and refresh-after-`task` behavior.
19. `README.md` (lines 12, 42-47, 94-97, 148-176, 235-246) – docs mirror code: no automatic lifecycle sync; status refresh timing.

## Key Code
- `src/index.ts` only wires:
  - `registerSessionTodoModule(pi)`
  - `registerTaskTool(pi)`
  - `registerTasqueStatusLifecycle(pi)`
  So active user tools/commands are `todo` + `task` + `/todos` (`todo` command).

- `src/durable-tasks/status.ts`
  - `MUTATING_TOOL_NAMES = new Set(["task"])`.
  - `pi.on("session_start")`:
    - clears existing interval
    - sets interval (default 60s)
    - `await refresh(ctx)` immediately if UI exists.
  - `refresh(ctx)`:
    - resolves project root with `resolveProjectRoot(pi, ctx.cwd)`
    - calls `refreshTasqueStatusCache`.
  - `pi.on("tool_execution_end")`: refresh only if tool is `"task"`, no error, and details.ok is not false.
  - `pi.on("session_shutdown")`: clear interval and clear status.

- `src/durable-tasks/cache.ts`
  - `refreshTasqueStatusCache(...)` performs only read commands:
    - `doctor`
    - `find ready --lane coding`
    - `find ready --lane planning`
    - `find in-progress --assignee pi`
  - errors keep prior counts + add error message (stale/error text).

- `src/durable-tasks/task-tool.ts`
  - `actionUsesTasque(action)` is false only for `link`, `list_links`; true otherwise.
  - `executeTaskTool` resolves project root unless those 2 bridge-only actions.
  - dispatch routes to:
    - `executeTsqQuery` (`doctor/find/show/deps/notes/similar`)
    - `executeTsqChange` (`create/note/finish/.../unorder`)
    - `executeTsqClaim` (`claim`)
    - `executeTaskBridge` (`link/list_links/promote/import`).
  - Adds `projectRoot` to tool result metadata.

- `src/durable-tasks/project.ts`
  - root resolution is hardcoded to `pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd })`.

- `src/bridge/bridge-tool.ts` + handlers (`src/bridge/promote-todo.ts`, `src/bridge/import-tsq.ts`)
  - `promote` calls `tsq similar`, `tsq create`, then optional `tsq note` (mutating).
  - `import` calls `tsq find open --tree`/`tsq show` (read), then mutates only session todos.
  - `link` and `list_links` are local-state only.

- `src/durable-tasks/tools-change.ts` / `tools-claim.ts` / `tools-query.ts`
  - explicit wrappers to tsq via `runTsqJson`.
  - changes/claim use `runQueuedMutation`.

- `src/session-todos/state/replay.ts`
  - `replayFromBranch` rebuilds todo state at `session_start` from prior `todo` and `task` tool results (including durable bridge snapshots/links/claim-created todos).

## Architecture
- Startup path: `piTasqueExtension` -> registers `todo` and `task` tools and status lifecycle.
- On each session start in UI mode: status lifecycle resolves root for `session` cwd and schedules periodic `tsq` reads; todo overlay/state is reconstructed from branch replay.
- Lifecycle: user actions on `task` run explicit `tsq` commands (query/change/claim/bridge) and on successful `task` completions status cache is refreshed.
- Project root for all durable actions is resolved from git at execution time (except local-only actions).
- No external tsq commands are executed outside:
  - status lifecycle auto-refresh logic,
  - explicit `task` tool handlers,
  - internal mutation helpers called by `task` actions.
- Other files define tsq sub-tools (`tsq_query`, `tsq_change`, `tsq_claim`, `task_bridge`) but they are not registered in extension entry; registration test confirms only `task` and `todo` tools are exposed.

## Start Here
Open `src/index.ts` first (lines 1-10) to confirm extension wiring and which handlers/tools are real entry points, then `src/durable-tasks/status.ts` for startup lifecycle behavior.

## Supervisor coordination
- Scope scan complete; no blocked tasks.
- Decision: a fresh session does **not** create durable Tasque tasks on its own.
- Startup side effect is status polling with read-only tsq commands (`doctor`/`find...`), not create/mutation.