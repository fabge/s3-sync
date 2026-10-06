import { App, Modal } from 'obsidian';

/** Lists unresolved conflicts and gives the user a direct way to retry sync. */
export class SyncConflictModal extends Modal {
	private conflicts: string[] = [];

	constructor(app: App, private onSyncAgain: () => void) {
		super(app);
	}

	openFor(conflicts: string[]): void {
		this.conflicts = [...conflicts];
		this.open();
	}

	onOpen(): void {
		this.setTitle('S3 sync conflicts');
		this.contentEl.empty();
		this.contentEl.createEl('p', {
			text: `${this.conflicts.length} unresolved conflict(s). Resolve the files below, then sync again.`,
		});

		const shown = this.conflicts.slice(0, 20);
		const more = this.conflicts.length - shown.length;
		const list = this.contentEl.createEl('ul', { cls: 's3-sync-conflict-paths' });
		for (const path of shown) {
			list.createEl('li', { text: path });
		}
		if (more > 0) {
			this.contentEl.createEl('p', { text: `And ${more} more…` });
		}

		this.contentEl.createEl('p', {
			text: 'Each conflict has local and remote copies beside it. Keep the version you want and delete both copies to resolve it.',
		});

		const actions = this.contentEl.createDiv({ cls: 's3-sync-conflict-actions' });
		const syncButton = actions.createEl('button', { cls: 'mod-cta', text: 'Sync again' });
		syncButton.addEventListener('click', () => {
			this.close();
			this.onSyncAgain();
		});
		const closeButton = actions.createEl('button', { text: 'Close' });
		closeButton.addEventListener('click', () => this.close());
	}
}
