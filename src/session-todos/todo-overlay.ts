/**
 * Persistent above-editor widget showing in-session todos.
 *
 * This class owns only widget lifecycle/rendering. Session lifecycle wiring lives
 * outside this module so callers can decide when to bind UI, update, or hide
 * completed tasks from previous turns.
 */

import type {
	ExtensionUIContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	selectHasActive,
	selectOverlayLayout,
	selectShowTaskIds,
	selectTodoCounts,
} from "./state/selectors.js";
import type { TaskState } from "./state/state.js";
import { getState } from "./state/store.js";
import { formatOverlayTaskLine, formatStatusLabel } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";
const MAX_WIDGET_LINES = 12;
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";

type TaskSnapshot = ReturnType<TodoOverlay["getSnapshot"]>;
type SnapshotTask = TaskSnapshot["tasks"][number];

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx === this.uiCtx) return;
		this.uiCtx = ctx;
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	update(): void {
		if (!this.uiCtx) return;

		const snapshot = this.getSnapshot();
		const visibleTasks = this.selectOverlayTasks(snapshot);

		if (visibleTasks.length === 0) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
			return;
		}

		this.tui?.requestRender();
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.update();
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.resetCompletedDisplayState();
	}

	private getSnapshot(): TaskState {
		const state = getState();
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;

		const completedTaskIds = new Set(
			state.tasks
				.filter((task) => task.status === "completed")
				.map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) {
				this.completedTaskIdsPendingHide.delete(taskId);
			}
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) {
				this.hiddenCompletedTaskIds.delete(taskId);
			}
		}

		return state;
	}

	private selectOverlayTasks(snapshot: TaskSnapshot): SnapshotTask[] {
		return snapshot.tasks.filter(
			(task) =>
				task.status !== "deleted" && !this.shouldHideCompletedTask(task),
		);
	}

	private shouldHideCompletedTask(task: SnapshotTask): boolean {
		return (
			task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id)
		);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) return [];

		const overlayState: TaskState = {
			tasks: overlayTasks,
			nextId: snapshot.nextId,
		};
		const truncate = (line: string): string =>
			truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);
		const showIds = selectShowTaskIds(overlayState);
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const headingText = `${OVERLAY_HEADING} (${counts.completed}/${counts.total})`;
		const heading = truncate(
			`${theme.fg(headingColor, headingIcon)} ${theme.fg(
				headingColor,
				headingText,
			)}`,
		);
		const lines = [heading];
		const layout = selectOverlayLayout(overlayState, MAX_WIDGET_LINES - 1);

		for (const task of layout.visible) {
			lines.push(
				truncate(
					`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(
						task,
						theme,
						showIds,
					)}`,
				),
			);
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.truncatedTail === 0) {
			const lastIndex = lines.length - 1;
			lines[lastIndex] = lines[lastIndex]!.replace("├─", "└─");
			return lines;
		}

		const totalHidden = layout.hiddenCompleted + layout.truncatedTail;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) {
			overflowParts.push(
				`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`,
			);
		}
		if (layout.truncatedTail > 0) {
			overflowParts.push(
				`${layout.truncatedTail} ${formatStatusLabel("pending")}`,
			);
		}
		const summary =
			overflowParts.length > 0
				? `+${totalHidden} ${OVERLAY_MORE} (${overflowParts.join(", ")})`
				: `+${totalHidden} ${OVERLAY_MORE}`;
		lines.push(
			truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`),
		);
		return lines;
	}
}
