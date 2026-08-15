/** Periodic sync timer wrapper. */

import { Plugin } from 'obsidian';
import { SyncEngine } from './SyncEngine';
import { cloneSettings, S3SyncSettings, SyncResult } from '../types';

export class SyncScheduler {
    private intervalId: number | null = null;
    private isEnabled = false;
    private settings: S3SyncSettings;

    private onSyncStart?: () => void;
    private onSyncComplete?: (result: SyncResult) => void;
    constructor(
        private plugin: Plugin,
        private syncEngine: SyncEngine,
        settings: S3SyncSettings,
    ) {
        this.settings = cloneSettings(settings);
    }

	setCallbacks(callbacks: {
		onSyncStart?: () => void;
		onSyncComplete?: (result: SyncResult) => void;
	}): void {
		this.onSyncStart = callbacks.onSyncStart;
		this.onSyncComplete = callbacks.onSyncComplete;
    }

    /** Only stores the settings; main restarts the scheduler on settings changes. */
    updateSettings(settings: S3SyncSettings): void {
        this.settings = cloneSettings(settings);
    }

    start(): void {
        if (this.isEnabled) return;
        if (!this.settings.syncEnabled || !this.settings.autoSyncEnabled) return;

        this.isEnabled = true;
        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;

        this.intervalId = this.plugin.registerInterval(
            window.setInterval(() => {
                void this.triggerSync();
            }, intervalMs)
        ) as unknown as number;
    }

    stop(): void {
        if (!this.isEnabled) return;
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isEnabled = false;
    }

    async triggerSync(): Promise<SyncResult | null> {
        if (this.syncEngine.isInProgress()) {
            return null;
        }

        this.onSyncStart?.();

		const result = await this.syncEngine.sync();
		this.onSyncComplete?.(result);
		return result;
	}
}
