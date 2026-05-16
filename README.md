# pi-tasque

Pi extension package for Tasque durable tasks plus branch-replayed in-session todos.

## What this package provides

`pi-tasque` gives agents two task layers:

- **Session todos**: current-session execution checklist for inspect/edit/verify/handoff steps.
- **Durable Tasque tasks**: repo-local backlog, specs, dependencies, notes, and ownership through `tsq --format json`.

The bridge between the layers is explicit. `pi-tasque` can link, promote, or import tasks, but it does **not** automatically sync lifecycle state between todos and Tasque.

## Install

Install with Pi:

```bash
pi install npm:pi-tasque
```

For local development, install the local package path once:

```bash
pi install /Users/adityasharma/Projects/pi-tasque
```

Then use this edit loop:

```text
edit TypeScript files -> /reload -> test behavior
```

Pi loads the extension entrypoint from the installed package path, so TypeScript source edits do not require reinstalling the local package. Use `/reload` in the Pi session after changing files under `src/`.

### Remove `@juicesharp/rpiv-todo`

Remove or disable `@juicesharp/rpiv-todo` before enabling `pi-tasque`:

```bash
pi remove npm:@juicesharp/rpiv-todo
```

`pi-tasque` owns the same user-facing session todo surface:

- `todo` tool
- `/todos` command
- above-editor todo overlay

Running both packages together can register duplicate tools, commands, or widgets.

## Agent guidance

Use the smallest task layer that matches the work:

- Use `todo` for tactical steps inside the current session: inspect, edit, verify, and handoff.
- Use `tsq_query` for fresh read-only Tasque state.
- Use `tsq_change` for explicit durable Tasque mutations, including lifecycle changes and block/order edges.
- Use `block`/`unblock` for hard dependency edges and `order`/`unorder` for sequencing edges via `tsq_change`.
- Use `tsq_claim` when taking ownership of a named durable Tasque task.
- Pass an explicit `assignee` when the agent has a role/name, such as `developer`, `oracle`, or a worker name.
- If no `assignee` is provided, `tsq_claim` defaults to `pi`.
- `tsq_claim` defaults `start` to true. Use `requireSpec` when the durable task must have an attached spec before work begins.
- Use `tsq_claim` with `createTodo: true` when claiming durable work should also create one linked session todo.
- Use `task_bridge promote_todo` when a session todo should become durable Tasque work.
- Use `task_bridge import_tsq` when a durable Tasque task should become current-session todo work.
- Do not create durable Tasque tasks for every session todo.
- Do not mark a Tasque task done just because linked todos are completed; durable completion requires explicit verification and an explicit Tasque mutation.

## Lifecycle boundaries

There is no automatic lifecycle sync between session todos and Tasque:

- Completing a `todo` does not mark a Tasque task done.
- Marking a Tasque task done does not complete linked todos.
- `task_bridge link` records a relationship only.
- `task_bridge promote_todo` creates a Tasque task, links it, and completes the source todo as part of the explicit promotion flow.
- `task_bridge import_tsq` creates or reuses session todos for Tasque tasks, but later status changes remain explicit.

## Example workflow

```json
{
  "action": "create",
  "subject": "Investigate failing release check",
  "owner": "developer"
}
```

```json
{ "id": "tsq-349aqgsj.12", "assignee": "developer", "createTodo": true }
```

```json
{ "action": "list_links" }
```

```json
{
  "action": "done",
  "id": "tsq-349aqgsj.12",
  "note": "Verified docs and package checks."
}
```

## v1 tool and command reference

| Surface              | Purpose                                       | Notes                                                           |
| -------------------- | --------------------------------------------- | --------------------------------------------------------------- |
| `todo`               | Manage current-session tactical todos.        | Session-local; branch-replayed from successful tool results.    |
| `/todos`             | Show grouped current-session todos.           | Interactive UI only.                                            |
| `tsq_query`          | Read fresh Tasque state.                      | Read-only; does not mutate Tasque.                              |
| `tsq_change`         | Run explicit durable Tasque mutations.        | Mutations are queued per cwd.                                   |
| `tsq_claim`          | Claim a named durable Tasque task.            | `id` required; `assignee` defaults `pi`; `start` defaults true. |
| `task_bridge`        | Link/promote/import between todos and Tasque. | Explicit bridge only; no automatic lifecycle sync.              |
| Todo overlay         | Show active session todos above the editor.   | Completed todos hide on next turn.                              |
| Tasque status footer | Show cached durable-task status.              | Display-only; agents should call `tsq_query` for fresh data.    |

### `todo`

Manage current-session tactical todos. Todos are branch-replayed from previous successful `todo` results in the current session branch.

Actions:

- `create`: add a todo.
- `update`: change status, text, owner, metadata, or dependencies.
- `list`: list visible todos; deleted tombstones are hidden unless `includeDeleted` is true.
- `get`: fetch one todo by id.
- `delete`: tombstone one todo.
- `clear`: clear current todo state.

Examples:

```json
{
  "action": "create",
  "subject": "Run README verification",
  "owner": "developer"
}
```

```json
{
  "action": "update",
  "id": 1,
  "status": "in_progress",
  "activeForm": "verifying docs"
}
```

### `/todos`

Show current-session todos grouped by status in interactive Pi UI. It reports pending, in-progress, and completed groups and requires interactive mode.

Example:

```text
/todos
```

### Above-editor todo overlay

Shows active session todos above the editor. The overlay rebuilds from branch replay on session lifecycle events and updates after successful `todo`, `task_bridge`, and `tsq_claim` executions that affect todo state.

Completed todos remain visible until the next turn, then hide from the overlay.

### `tsq_query`

Run read-only Tasque queries through `tsq --format json`. Use this for fresh durable task state without mutating Tasque.

Actions:

- `doctor`
- `find_ready`
- `find_open`
- `show`
- `show_with_spec`
- `deps`
- `notes`
- `find_tree`
- `similar`

Examples:

```json
{ "action": "find_ready", "lane": "coding", "assignee": "developer" }
```

```json
{ "action": "show_with_spec", "id": "tsq-349aqgsj.12" }
```

### `tsq_change`

Run approved durable Tasque mutations. Mutations are queued per working directory so concurrent agents do not race `tsq` writes.

Actions:

- `create`
- `note`
- `done`
- `reopen`
- `defer`
- `start`
- `claim_assign_only`
- `block`: make `child` blocked by `blocker`.
- `unblock`: remove a block edge between `child` and `blocker`.
- `order`: make `later` start after `earlier`.
- `unorder`: remove an order edge between `later` and `earlier`.

Use `block` for hard blockers and `order` for sequencing. Use `tsq_query` with `deps` or `show` to inspect durable graph state. Edge actions cannot create self-edges.

Examples:

```json
{
  "action": "note",
  "id": "tsq-349aqgsj.12",
  "note": "README docs updated; running verification."
}
```

```json
{
  "action": "done",
  "id": "tsq-349aqgsj.12",
  "note": "Docs and typecheck/test verification passed."
}
```

```json
{ "action": "block", "child": "tsq-abc123.2", "blocker": "tsq-abc123.1" }
```

```json
{ "action": "order", "later": "tsq-abc123.3", "earlier": "tsq-abc123.2" }
```

### `tsq_claim`

Claim a named durable Tasque task. This never auto-selects work; callers must provide the task id. `start` defaults to true, `assignee` defaults to `pi`, and `createTodo` optionally creates one linked session todo for the claimed task.

Example:

```json
{
  "id": "tsq-349aqgsj.12",
  "assignee": "developer",
  "requireSpec": true,
  "createTodo": true
}
```

### `task_bridge`

Explicitly connect session todos and durable Tasque tasks. Bridge actions do not create implicit lifecycle sync.

Actions:

- `link`: associate an existing todo with an existing Tasque task via todo metadata.
- `list_links`: inspect current session todo ↔ Tasque associations.
- `promote_todo`: create a Tasque task from an existing todo, add a promotion note, link metadata, and complete the source todo.
- `import_tsq`: import a Tasque task, or an open-tree task plus children when available, into session todos with `tsqId` metadata links.

Link example:

```json
{ "action": "link", "todoId": 3, "tsqId": "tsq-349aqgsj.12" }
```

Promote example:

```json
{
  "action": "promote_todo",
  "todoId": 4,
  "kind": "task",
  "priority": 2,
  "assignee": "developer",
  "parent": "tsq-349aqgsj"
}
```

Import example:

```json
{ "action": "import_tsq", "tsqId": "tsq-349aqgsj.12", "owner": "developer" }
```

List links example:

```json
{ "action": "list_links" }
```

### Tasque status footer

The status footer shows cached Tasque status in interactive UI:

- ready coding count
- ready planning count
- `mine` count for tasks assigned to `pi`
- loading, stale, and error states

It refreshes on session start, periodically, and after successful durable mutations from `tsq_change`, `tsq_claim`, or `task_bridge`.

The footer is display-only. Refreshed status is not injected into the model context; agents should use `tsq_query` for fresh durable task data. If agents claim with a non-`pi` assignee, those tasks may not appear in the footer's `mine` count.

## Verification

Run full local verification before handoff:

```bash
npm run typecheck && npm test
```
