import { Plugin, setIcon, setTooltip } from 'obsidian';
import { SyncState, SyncStatus } from './types';

interface StatusIndicatorSpec {
	icon: string;
	label: string;
}

const SYNC_STATUS_SPEC: Record<SyncStatus, StatusIndicatorSpec> = {
	idle: { icon: 'cloud', label: 'Ready' },
	synced: { icon: 'check', label: 'Synced' },
	syncing: { icon: 'refresh-cw', label: 'Syncing' },
	error: { icon: 'x', label: 'Error' },
	conflicts: { icon: 'alert-triangle', label: 'Conflict' },
	disabled: { icon: 'circle-off', label: 'Off' },
};

export class StatusBar {
	private statusBarEl: HTMLElement | null = null;
	private iconEl: HTMLElement | null = null;
	private textEl: HTMLElement | null = null;
	private renderedStatus: SyncStatus | null = null;
	private renderFrameId: number | null = null;

	private syncState: SyncState = {
		status: 'disabled',
		lastSyncTime: null,
		conflictCount: 0,
		lastError: null,
		progress: null,
	};

	constructor(private plugin: Plugin, private actionHandler: () => void) {}

	init(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClasses(['s3-sync-status', 'mod-clickable']);
		this.statusBarEl.tabIndex = 0;
		this.statusBarEl.setAttr('role', 'button');
		// Created once so progress renders don't restart the spinner animation.
		this.iconEl = this.statusBarEl.createSpan({ cls: 's3-sync-icon' });
		this.textEl = this.statusBarEl.createSpan({ cls: 's3-sync-text' });
		this.plugin.registerDomEvent(this.statusBarEl, 'click', this.actionHandler);
		this.plugin.registerDomEvent(this.statusBarEl, 'keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.actionHandler();
			}
		});
		this.update();
	}

	updateSyncState(state: Partial<SyncState>): void {
		this.syncState = { ...this.syncState, ...state };
		this.scheduleUpdate();
	}

	destroy(): void {
		if (this.renderFrameId !== null) {
			window.cancelAnimationFrame(this.renderFrameId);
			this.renderFrameId = null;
		}
		this.statusBarEl?.remove();
		this.statusBarEl = null;
		this.iconEl = null;
		this.textEl = null;
		this.renderedStatus = null;
	}

	private scheduleUpdate(): void {
		if (this.renderFrameId !== null) return;

		this.renderFrameId = window.requestAnimationFrame(() => {
			this.renderFrameId = null;
			this.update();
		});
	}

	private update(): void {
		const { statusBarEl, iconEl, textEl } = this;
		if (!statusBarEl || !iconEl || !textEl) return;

		const status = this.syncState.status;
		const spec = SYNC_STATUS_SPEC[status];
		if (status !== this.renderedStatus) {
			if (this.renderedStatus) statusBarEl.removeClass(`is-${this.renderedStatus}`);
			statusBarEl.addClass(`is-${status}`);
			setIcon(iconEl, spec.icon);
			this.renderedStatus = status;
		}
		const count = status === 'conflicts' ? ` ${this.syncState.conflictCount}` : '';
		textEl.setText(` ${this.getStatusText(spec.label)}${count}`);
		setTooltip(statusBarEl, this.getTooltipContent());
	}

	private getStatusText(defaultLabel: string): string {
		const progress = this.syncState.progress;
		if (this.syncState.status !== 'syncing' || !progress) {
			return defaultLabel;
		}

		return `Syncing ${progress.completed}/${progress.total}`;
	}

	private getTooltipContent(): string {
		const lines = [
			this.syncState.status === 'conflicts' ? 'Click to list conflicts' : 'Click to sync',
		];
		lines.push(`Status: ${SYNC_STATUS_SPEC[this.syncState.status].label}`);

		if (this.syncState.lastSyncTime) {
			lines.push(`Last sync: ${new Date(this.syncState.lastSyncTime).toLocaleString()}`);
		}

		if (this.syncState.lastError) {
			lines.push(`Error: ${this.syncState.lastError}`);
		}

		if (this.syncState.conflictCount > 0) {
			lines.push(`Conflicts: ${this.syncState.conflictCount}`);
		}

		return lines.join('\n');
	}
}
