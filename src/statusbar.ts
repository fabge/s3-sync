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

	private syncState: SyncState = {
		status: 'disabled',
		lastSyncTime: null,
		conflictCount: 0,
		lastError: null,
	};

	constructor(private plugin: Plugin, private actionHandler: () => void) {}

	init(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClasses(['s3-sync-status', 'mod-clickable']);
		this.statusBarEl.tabIndex = 0;
		this.statusBarEl.setAttr('role', 'button');
		this.statusBarEl.addEventListener('click', this.actionHandler);
		this.statusBarEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.actionHandler();
			}
		});
		this.update();
	}

	updateSyncState(state: Partial<SyncState>): void {
		this.syncState = { ...this.syncState, ...state };
		this.update();
	}

	destroy(): void {
		this.statusBarEl?.remove();
		this.statusBarEl = null;
	}

	private update(): void {
		const statusBarEl = this.statusBarEl;
		if (!statusBarEl) return;

		const spec = SYNC_STATUS_SPEC[this.syncState.status];
		statusBarEl.className =
			`status-bar-item plugin-s3-sync mod-clickable s3-sync-status is-${this.syncState.status}`;
		statusBarEl.empty();
		setIcon(statusBarEl.createSpan({ cls: 's3-sync-icon' }), spec.icon);
		const count = this.syncState.status === 'conflicts' ? ` ${this.syncState.conflictCount}` : '';
		statusBarEl.createSpan({ cls: 's3-sync-text', text: ` ${spec.label}${count}` });
		setTooltip(statusBarEl, this.getTooltipContent());
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
