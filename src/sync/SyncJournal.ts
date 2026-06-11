/**
 * IndexedDB persistence for per-file sync baselines, conflict records, and
 * plugin metadata. The baseline is what lets three-way reconciliation tell
 * "changed locally since last sync" from "never synced". The DB name uses a
 * vault-local id so vaults with the same display name don't share state.
 */

import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { ConflictRecord, SyncStateRecord } from '../types';

type SyncJournalMetadataValue = string | number | boolean;

const DESTINATION_FINGERPRINT_KEY = 'destinationFingerprint';
const DB_NAME_PREFIX = 'obsidian-s3-sync-journal';
const DB_VERSION = 1;

interface SyncJournalDB extends DBSchema {
	stateRecords: { key: string; value: SyncStateRecord };
	conflicts: { key: string; value: ConflictRecord };
	metadata: { key: string; value: SyncJournalMetadataValue };
}

/**
 * Vault-scoped IndexedDB journal. Call {@link initialize} before use and
 * {@link close} on unload. One instance per plugin lifecycle.
 */
export class SyncJournal {
	private db: IDBPDatabase<SyncJournalDB> | null = null;

	constructor(private journalId: string) {}

	async initialize(): Promise<void> {
		this.db = await openDB<SyncJournalDB>(`${DB_NAME_PREFIX}-${this.journalId}`, DB_VERSION, {
			upgrade(db) {
				db.createObjectStore('stateRecords', { keyPath: 'path' });
				db.createObjectStore('conflicts', { keyPath: 'path' });
				db.createObjectStore('metadata');
			},
		});
	}

	private ensureInitialized(): void {
		if (!this.db) {
			throw new Error('SyncJournal not initialized. Call initialize() first.');
		}
	}

	async setStateRecord(record: SyncStateRecord): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('stateRecords', record);
	}

	async deleteStateRecord(path: string): Promise<void> {
		this.ensureInitialized();
		await this.db!.delete('stateRecords', path);
	}

	async getAllStateRecords(): Promise<SyncStateRecord[]> {
		this.ensureInitialized();
		return await this.db!.getAll('stateRecords');
	}

	async setConflict(record: ConflictRecord): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('conflicts', record);
	}

	async deleteConflict(path: string): Promise<void> {
		this.ensureInitialized();
		await this.db!.delete('conflicts', path);
	}

	async getAllConflicts(): Promise<ConflictRecord[]> {
		this.ensureInitialized();
		return await this.db!.getAll('conflicts');
	}

	async getMetadata(key: string): Promise<SyncJournalMetadataValue | undefined> {
		this.ensureInitialized();
		return await this.db!.get('metadata', key);
	}

	async setMetadata(key: string, value: SyncJournalMetadataValue): Promise<void> {
		this.ensureInitialized();
		await this.db!.put('metadata', value, key);
	}

	/** Atomically wipe all stores and re-stamp the destination fingerprint (journal reset). */
	async resetForDestination(destinationFingerprint: string): Promise<void> {
		this.ensureInitialized();
		const tx = this.db!.transaction(['stateRecords', 'conflicts', 'metadata'], 'readwrite');
		await Promise.all([
			tx.objectStore('stateRecords').clear(),
			tx.objectStore('conflicts').clear(),
			tx.objectStore('metadata').clear(),
			tx.objectStore('metadata').put(destinationFingerprint, DESTINATION_FINGERPRINT_KEY),
		]);
		await tx.done;
	}

	close(): void {
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}
}
