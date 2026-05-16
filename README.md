# pi-tasque

Pi extension for durable project tasks plus in-session todos.

## What this package provides

`pi-tasque` gives agents two task layers:

- **Session todos**: current-session execution checklist for inspect, edit, verify, and handoff steps.
- **Durable tasks**: repo-local backlog, specs, dependencies, notes, and ownership.

The bridge between the layers is explicit. `pi-tasque` can link, promote, or import tasks, but it does **not** automatically sync lifecycle state between todos and durable tasks.

## Install

Install with Pi:

```bash
pi install npm:@bumpyclock/pi-tasque
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

## Agent guidance

Use `todo` for current-session checklists; use `task` for durable project work, ownership, notes, specs, dependencies, and explicit todo links.

## Lifecycle boundaries

There is no automatic lifecycle sync between session todos and durable tasks:

- Completing a `todo` does not mark a durable task done.
- Marking a durable task done does not complete linked todos.
- `task` link actions record relationships only.
- `task` promote/import actions are explicit bridge operations.

## Example workflow

Create a session todo:

```json
{
  "action": "create",
  "subject": "Investigate failing release check",
  "owner": "developer"
}
```

Claim durable work and create one linked todo:

```json
{
  "action": "claim",
  "task": "task-123",
  "for": "developer",
  "todo": true
}
```

List links:

```json
{ "action": "list_links" }
```

Finish durable work after verification:

```json
{
  "action": "finish",
  "task": "task-123",
  "because": "Docs and package checks passed."
}
```

## Tool and command reference

| Surface            | Purpose                                      | Notes                                                              |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------ |
| `todo`             | Manage current-session tactical todos.       | Session-local; replayed from successful `todo` and `task` results. |
| `/todos`           | Show grouped current-session todos.          | Interactive UI only.                                               |
| `task`             | Manage durable project tasks and todo links. | Resolves operations to the current git project root.               |
| Todo overlay       | Show active session todos above the editor.  | Completed todos hide on the next turn.                             |
| Task status footer | Show cached durable-task status.             | Display-only; agents should call `task` for fresh data.            |

### `todo`

Manage current-session todos. Todos are branch-replayed from previous successful `todo` results in the current session branch.

Actions:

- `create`: add a todo, with optional description, owner, metadata, and blockers.
- `update`: change status, text, owner, metadata, or dependencies with `blockedBy`, `addBlockedBy`, and `removeBlockedBy`.
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

Shows active session todos above the editor. The overlay rebuilds on session start, compaction, and tree switches, then updates after successful `todo` and `task` executions that affect todo state.

Completed todos remain visible until the next turn, then hide from the overlay.

### `task`

Manage durable project tasks. Most durable task operations run from the current git project root; `handoff_check` resolves the root only when linked todos exist.

Read actions:

- `doctor`: check task-system health.
- `find`: find `ready` or `open` tasks. `lane` applies only to `ready`; use `view: "tree"` for an open-task tree. With `view: "tree"`, `task` filters the tree to a parent task.
- `show`: show one task. Use `with: ["spec"]` to include spec content in the display.
- `deps`: show dependency tree for one task.
- `notes`: show notes for one task.
- `similar`: search for similar tasks by text.
- `handoff_check`: check whether current-session todos and linked durable tasks are ready for final handoff. Not-ready returns `ok: true, ready: false`; internal failures return `ok: false`.
- `spec`: operate on the spec attached to a task. `mode` is required and must be `show`, `check`, `set`, or `update`.
  - `show` returns the attached spec content.
  - `check` validates the attached spec against the task. Returns `ok: true` when validation passes; returns `ok: false` with `error.code: "spec_check_failed"` and diagnostics when validation fails.
  - `set` attaches a new spec using the `text` field. Overwrites any existing spec.
  - `update` updates the existing spec using the `text` field.
  - `text` is required for `set` and `update`; rejected for `show` and `check`.
  - `show` and `check` are read-only. `set` and `update` are mutations serialized through the per-project queue.

**`show` with `with:["spec"]` vs `spec` action:** `show` with `with:["spec"]` includes spec content as extra context in the task display — useful for reading the spec alongside other task fields. The `spec` action with `mode:"show"` returns spec content alone; `spec` action with `mode:"check"` validates the attached spec and reports pass/fail with diagnostics. Use `show` for display context, `spec check` for validation.

**Failed check semantics:** When `spec check` reports validation failures, the tool result has `details.ok: false`, `error.code: "spec_check_failed"`, and a `details.diagnostics` object with the issues. The CLI process exits successfully (no thrown error); the failure is reported in structured details so agents can inspect and react to individual check failures without catching exceptions.

**Handoff check semantics:** `handoff_check` is read-only. It checks pending/in-progress/blocked todos plus linked durable task status. `closed` linked tasks are ready; `open`, `in_progress`, `blocked`, `deferred`, and unknown statuses block handoff; `canceled` is a warning. Missing/invalid linked tasks are reported as `readErrors` with `ready:false`.

Mutation actions:

- `create`: create a durable task, with optional `description`, `under`, `planned`, or `needsPlan`.
- `note`: add a note.
- `finish`: mark done.
- `reopen`: reopen a task.
- `defer`: defer a task.
- `start`: mark started.
- `claim`: assign ownership; `start` defaults to true, `requireSpec` enforces an attached spec, and `todo: true` creates one linked session todo.
- `block` / `unblock`: manage hard blocker edges.
- `order` / `unorder`: manage sequencing edges.

Lifecycle mutation actions:

- `mark_planned`: mark an existing task as planned. Requires `task` (non-empty id). Runs through the mutation queue.

Batch actions:

- `bulk`: run multiple lifecycle/note mutations sequentially with fail-fast semantics. Requires `items` — an array of `{ action, task, because? }` objects. Supported item actions: `start`, `finish`, `reopen`, `defer`, `note`, `mark_planned`. `because` is required for `note`, optional for `finish`/`defer`. On first failure, remaining items are skipped. No rollback of completed mutations. Result details contain `completed` (task ids), optional `failed` (task + error), and `skipped` (task ids).
- `create_tree`: create a nested tree of durable tasks in one call. Requires `root` — a node object `{ title, kind, priority, description?, planned?, needsPlan?, children? }`. Children are recursive nodes. Creates parent before children, wiring generated parent ids. On first failure, remaining subtree is skipped — no orphan children are created. No rollback. Result details contain `created` (id + title), optional `failed` (title + error), and `skipped` (titles).

Bridge actions:

- `link`: associate an existing todo with an existing durable task via todo metadata.
- `list_links`: inspect current todo ↔ durable task associations.
- `promote`: create a durable task from an existing todo, add a promotion note, link metadata, and complete the source todo.
- `import`: import a durable task, or an open-tree task plus children when available, into session todos with metadata links. `to` currently accepts only `"todo"`.

Examples:

```json
{ "action": "find", "tasks": "ready", "lane": "coding", "for": "developer" }
```

```json
{ "action": "find", "view": "tree", "task": "task-parent" }
```

```json
{ "action": "show", "task": "task-123", "with": ["spec"] }
```

```json
{ "action": "spec", "task": "task-123", "mode": "show" }
```

```json
{ "action": "spec", "task": "task-123", "mode": "check" }
```

```json
{
  "action": "spec",
  "task": "task-123",
  "mode": "set",
  "text": "# Spec\n\nAcceptance criteria..."
}
```

```json
{
  "action": "spec",
  "task": "task-123",
  "mode": "update",
  "text": "## Updated section\n\nRevised details..."
}
```

```json
{ "action": "mark_planned", "task": "task-456" }
```

```json
{
  "action": "bulk",
  "items": [
    { "action": "finish", "task": "task-1", "because": "Verified" },
    { "action": "start", "task": "task-2" },
    { "action": "mark_planned", "task": "task-3" }
  ]
}
```

```json
{
  "action": "create_tree",
  "root": {
    "title": "Add auth module",
    "kind": "task",
    "priority": 2,
    "planned": true,
    "children": [
      {
        "title": "Design auth API",
        "kind": "task",
        "priority": 2,
        "needsPlan": true
      },
      { "title": "Implement token refresh", "kind": "task", "priority": 3 }
    ]
  }
}
```

```json
{ "action": "handoff_check" }
```

```json
{
  "action": "create",
  "task": "Add cwd guard tests",
  "kind": "task",
  "priority": 2,
  "under": "task-parent",
  "planned": true
}
```

```json
{ "action": "block", "task": "task-child", "by": "task-blocker" }
```

```json
{ "action": "order", "task": "task-later", "after": "task-earlier" }
```

```json
{ "action": "link", "todo": 3, "task": "task-123" }
```

```json
{
  "action": "promote",
  "todo": 4,
  "kind": "task",
  "priority": 2,
  "under": "task-parent",
  "for": "developer"
}
```

```json
{
  "action": "import",
  "task": "task-123",
  "to": "todo",
  "for": "developer"
}
```

### Task status footer

The status footer shows cached durable-task status in interactive UI:

- ready coding count
- ready planning count
- `mine` count for in-progress tasks assigned to `pi`
- loading, stale, and error states

It refreshes on session start, periodically, and after successful durable mutations from `task`.

The footer is display-only. Refreshed status is not injected into the model context; agents should use `task` for fresh durable task data. If agents claim with a non-`pi` assignee, those tasks may not appear in the footer's `mine` count.

## Verification

Run full local verification before handoff:

```bash
npm run typecheck && npm test
```
