export const TSQ_SCHEMA_VERSION = 1 as const;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface TsqOk<TData = unknown> {
	readonly schema_version: typeof TSQ_SCHEMA_VERSION;
	readonly command: string;
	readonly ok: true;
	readonly data: TData;
}

export interface TsqErr<TDetails = JsonValue> {
	readonly schema_version: typeof TSQ_SCHEMA_VERSION;
	readonly command: string;
	readonly ok: false;
	readonly error: TsqEnvelopeError<TDetails>;
}

export interface TsqEnvelopeError<TDetails = JsonValue> {
	readonly code: string;
	readonly message: string;
	readonly details?: TDetails;
}

export type TsqEnvelope<TData = unknown, TErrorDetails = JsonValue> =
	| TsqOk<TData>
	| TsqErr<TErrorDetails>;

export type TsqTaskKind = "task" | "feature" | "epic" | (string & {});
export type TsqTaskStatus =
	| "open"
	| "in_progress"
	| "blocked"
	| "closed"
	| "canceled"
	| "deferred"
	| (string & {});
export type TsqPlanningState = "needs_planning" | "planned" | (string & {});
export type TsqDependencyType = "blocks" | "starts_after" | (string & {});
export type TsqDependencyDirection = "up" | "down" | "both" | (string & {});

export interface TsqTaskNote {
	readonly event_id: string;
	readonly ts: string;
	readonly actor: string;
	readonly text: string;
	readonly [key: string]: unknown;
}

export interface TsqTask {
	readonly id: string;
	readonly alias?: string;
	readonly title: string;
	readonly description?: string | null;
	readonly kind: TsqTaskKind;
	readonly status: TsqTaskStatus;
	readonly planning_state: TsqPlanningState;
	readonly priority: number;
	readonly parent_id?: string | null;
	readonly assignee?: string | null;
	readonly labels: readonly string[];
	readonly notes: readonly TsqTaskNote[];
	readonly created_at: string;
	readonly updated_at: string;
	readonly closed_at?: string | null;
	readonly spec_path?: string | null;
	readonly spec_fingerprint?: string | null;
	readonly spec_attached_at?: string | null;
	readonly spec_attached_by?: string | null;
	readonly external_ref?: string | null;
	readonly discovered_from?: string | null;
	readonly superseded_by?: string | null;
	readonly duplicate_of?: string | null;
	readonly replies_to?: string | null;
	readonly [key: string]: unknown;
}

export interface TsqDependencyRef {
	readonly id: string;
	readonly dep_type: TsqDependencyType;
	readonly [key: string]: unknown;
}

export interface TsqDependencyEdge {
	readonly blocker: string;
	readonly dep_type: TsqDependencyType;
	readonly [key: string]: unknown;
}

export interface TsqTaskTreeNode {
	readonly task: TsqTask;
	readonly children: readonly TsqTaskTreeNode[];
	readonly blocker_edges: readonly TsqDependencyRef[];
	readonly dependent_edges: readonly TsqDependencyRef[];
	readonly blockers: readonly string[];
	readonly dependents: readonly string[];
	readonly [key: string]: unknown;
}

export interface TsqDepTreeNode {
	readonly id: string;
	readonly task: TsqTask;
	readonly direction: TsqDependencyDirection;
	readonly depth: number;
	readonly dep_type?: TsqDependencyType | null;
	readonly children: readonly TsqDepTreeNode[];
	readonly [key: string]: unknown;
}

export interface TsqDepsData {
	readonly root: TsqDepTreeNode;
	readonly [key: string]: unknown;
}

export interface TsqSpecContent {
	readonly path: string;
	readonly fingerprint: string;
	readonly content: string;
	readonly [key: string]: unknown;
}

export interface TsqEventRecord {
	readonly id?: string;
	readonly event_id?: string;
	readonly ts: string;
	readonly actor: string;
	readonly type: string;
	readonly task_id: string;
	readonly payload: Record<string, unknown>;
	readonly [key: string]: unknown;
}

export interface TsqShowData {
	readonly task: TsqTask;
	readonly blockers: readonly string[];
	readonly dependents: readonly string[];
	readonly blocker_edges: readonly TsqDependencyRef[];
	readonly dependent_edges: readonly TsqDependencyRef[];
	readonly ready?: boolean;
	readonly links?: Readonly<Record<string, readonly string[]>>;
	readonly history?: readonly TsqEventRecord[];
	readonly spec?: TsqSpecContent;
	readonly [key: string]: unknown;
}

export interface TsqDoctorData {
	readonly tasks?: number;
	readonly events?: number;
	readonly snapshot_loaded?: boolean;
	readonly issues?: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface TsqTaskListResult {
	readonly tasks: readonly TsqTask[];
	readonly [key: string]: unknown;
}

export interface TsqTreeResult {
	readonly tree: readonly TsqTaskTreeNode[];
	readonly [key: string]: unknown;
}

export interface TsqSimilarData {
	readonly candidates: readonly unknown[];
	readonly [key: string]: unknown;
}

export interface TsqNotesData {
	readonly task_id: string;
	readonly notes: readonly TsqTaskNote[];
	readonly [key: string]: unknown;
}

export type TsqTaskListData = readonly TsqTask[];
export type TsqTreeData = readonly TsqTaskTreeNode[];

export type TsqQueryData =
	| TsqDoctorData
	| TsqTaskListResult
	| TsqTaskListData
	| TsqShowData
	| TsqDepsData
	| TsqNotesData
	| TsqTreeResult
	| TsqTreeData
	| TsqSimilarData;
