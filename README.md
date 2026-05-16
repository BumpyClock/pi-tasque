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

Manage durable project tasks. Every durable task operation runs from the current git project root.

Read actions:

- `doctor`: check task-system health.
- `find`: find `ready` or `open` tasks. `lane` applies only to `ready`; use `view: "tree"` for an open-task tree.
- `show`: show one task. Use `with: ["spec"]` to include spec content.
- `deps`: show dependency tree for one task.
- `notes`: show notes for one task.
- `similar`: search for similar tasks by text.

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
