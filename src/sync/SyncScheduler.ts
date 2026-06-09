/**
 * Drives periodic sync by wrapping `window.setInterval` in Obsidian's
 * `registerInterval` (auto-cleared on unload) and delegating each tick to
 * {@link SyncEngine.sync}. Responsible only for timing/lifecycle.
 */

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

    /** Adopt new settings and restart the timer if the interval may have changed. */
    updateSettings(settings: S3SyncSettings): void {
        this.settings = settings;
        if (this.isEnabled && this.settings.autoSyncEnabled) {
            this.stop();
            this.start();
        }
    }

    /** Start the periodic timer. No-op if already running or sync/auto-sync is disabled. */
    start(): void {
        if (this.isEnabled) return;
        if (!this.settings.syncEnabled || !this.settings.autoSyncEnabled) return;

        this.isEnabled = true;
        const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;

        // registerInterval returns the raw numeric id; cast guards against envs
        // where TS types setInterval as returning NodeJS.Timeout.
        this.intervalId = this.plugin.registerInterval(
            window.setInterval(() => {
                void this.triggerSync();
            }, intervalMs)
        ) as unknown as number;
    }

    /** Stop the periodic timer. Safe to call when already stopped. */
    stop(): void {
        if (!this.isEnabled) return;
        if (this.intervalId !== null) {
            window.clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isEnabled = false;
    }

    /**
     * Run a single sync, forwarding lifecycle events to the registered callbacks.
     * Returns `null` if a sync is already in progress or the engine throws.
     */
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
