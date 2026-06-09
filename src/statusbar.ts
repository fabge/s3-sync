import { Plugin, setIcon, setTooltip } from 'obsidian';
import { SyncState, SyncStatus } from './types';
import { formatRelativeTime } from './utils/time';

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
	private segmentEl: HTMLElement | null = null;
	private iconEl: HTMLElement | null = null;
	private textEl: HTMLElement | null = null;
	private actionHandler?: () => void;

	private syncState: SyncState = {
		status: 'disabled',
		lastSyncTime: null,
		conflictCount: 0,
		isSyncing: false,
		lastError: null,
	};

	constructor(private plugin: Plugin) {}

	setActionHandler(handler: () => void): void {
		this.actionHandler = handler;
	}

	init(): void {
		this.statusBarEl = this.plugin.addStatusBarItem();
		this.statusBarEl.addClasses(['s3-sync-status', 'mod-clickable']);
		this.statusBarEl.empty();
		this.segmentEl = this.createSegment();
		this.update();
	}

	updateSyncState(state: Partial<SyncState>): void {
		this.syncState = { ...this.syncState, ...state };
		this.update();
	}

	destroy(): void {
		this.statusBarEl?.remove();
		this.statusBarEl = null;
		this.segmentEl = null;
		this.iconEl = null;
		this.textEl = null;
	}

	private createSegment(): HTMLElement {
		const segment = this.statusBarEl!.createSpan({ cls: 's3-sync-segment' });
		segment.tabIndex = 0;
		segment.setAttr('role', 'button');

		this.iconEl = segment.createSpan({ cls: 's3-sync-icon' });
		this.textEl = segment.createSpan({ cls: 's3-sync-text' });

		segment.addEventListener('click', () => {
			this.actionHandler?.();
		});
		segment.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				this.actionHandler?.();
			}
		});

		return segment;
	}

	private update(): void {
		if (!this.statusBarEl || !this.segmentEl || !this.iconEl || !this.textEl) {
			return;
		}

		this.renderSync();
		setTooltip(this.statusBarEl, this.getTooltipContent());
	}

	private renderSync(): void {
		const statusBarEl = this.statusBarEl;
		if (!statusBarEl || !this.segmentEl || !this.iconEl || !this.textEl) {
			return;
		}

		const spec = SYNC_STATUS_SPEC[this.syncState.status];
		statusBarEl.className =
			`status-bar-item plugin-s3-sync mod-clickable s3-sync-status is-${this.syncState.status}`;
		this.renderIcon(this.iconEl, spec);

		const suffix =
			this.syncState.status === 'conflicts'
				? ` ${this.syncState.conflictCount}`
				: this.syncState.lastSyncTime
					? ` ${formatRelativeTime(this.syncState.lastSyncTime)}`
					: '';
		this.textEl.setText(` ${spec.label}${suffix}`);
	}

	private renderIcon(target: HTMLElement, spec: StatusIndicatorSpec): void {
		target.empty();
		setIcon(target, spec.icon);
	}

	private getTooltipContent(): string {
		const lines = ['Sync'];
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
