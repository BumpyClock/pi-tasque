export const READ_TASKS_PROMPT_SNIPPET = "Read durable task state.";

export const READ_TASKS_PROMPT_GUIDELINES = [
	"Use task read actions for fresh durable task state; read actions do not mutate tasks.",
	"Include spec content only when needed; regular task details are more concise.",
];

export const CHANGE_TASKS_PROMPT_SNIPPET = "Mutate durable tasks.";

export const CHANGE_TASKS_PROMPT_GUIDELINES = [
	"Use task mutations for explicit durable task changes; use `todo` for current-session checklist steps.",
	"Use block/unblock for hard blockers and order/unorder for task sequencing.",
	"Inspect task details or dependencies before and after graph changes when the relationship is not obvious.",
];

export const CLAIM_TASK_PROMPT_SNIPPET = "Claim durable task ownership.";

export const CLAIM_TASK_PROMPT_GUIDELINES = [
	"Pass your own role/name as assignee when available, e.g. developer, worker, oracle.",
	"Create a linked todo only when you want one session todo for the claimed task.",
	"Completing a linked todo does not mark the durable task done; durable completion must be explicit.",
];

export const TASK_TODO_BRIDGE_PROMPT_SNIPPET =
	"Link session todos and durable tasks.";

export const TASK_TODO_BRIDGE_PROMPT_GUIDELINES = [
	"Use link to associate an existing todo with an existing durable task via todo metadata.",
	"Use list links to inspect current todo ↔ durable task associations.",
	"Use promote to create a durable task from a todo and link the promoted todo explicitly.",
	"Use import to create or reuse session todos from durable task state and link them explicitly.",
	"Todo completion does not mark a durable task done; durable completion stays explicit.",
];
