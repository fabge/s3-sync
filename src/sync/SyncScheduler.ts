/** Periodic sync timer wrapper. */

import { Plugin } from 'obsidian';
import { SyncEngine } from './SyncEngine';
import { S3SyncSettings, SyncResult } from '../types';

export class SyncScheduler {
    private intervalId: number | null = null;
    private isEnabled = false;

    private onSyncStart?: () => void;
    private onSyncComplete?: (result: SyncResult) => void;
    private onSyncError?: (error: string) => void;

    constructor(
        private plugin: Plugin,
        private syncEngine: SyncEngine,
        private settings: S3SyncSettings,
    ) {}

    setCallbacks(callbacks: {
        onSyncStart?: () => void;
        onSyncComplete?: (result: SyncResult) => void;
        onSyncError?: (error: string) => void;
    }): void {
        this.onSyncStart = callbacks.onSyncStart;
        this.onSyncComplete = callbacks.onSyncComplete;
        this.onSyncError = callbacks.onSyncError;
    }

    updateSettings(settings: S3SyncSettings): void {
        this.settings = settings;
        if (this.isEnabled && this.settings.autoSyncEnabled) {
            this.stop();
            this.start();
        }
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

        try {
            const result = await this.syncEngine.sync();
            this.onSyncComplete?.(result);
            return result;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.onSyncError?.(errorMessage);
            console.error('[S3 Sync] Sync failed:', error);
            return null;
        }
    }
}
