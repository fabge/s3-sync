/**
 * Unit tests for SyncJournal.
 *
 * Covers schema creation, CRUD operations for each store, metadata,
 * transaction-based clearing, and initialization/close lifecycle behavior.
 */

import { openDB } from 'idb';
import { SyncJournal } from '../../src/sync/SyncJournal';
import type { ConflictRecord, SyncStateRecord } from '../../src/types';

jest.mock('idb', () => ({
	openDB: jest.fn(),
}));

type MetadataValue = string | number | boolean;
type StoreName = 'stateRecords' | 'conflicts' | 'metadata';

interface MockJournalDatabase {
	get: jest.Mock<Promise<ConflictRecord | MetadataValue | SyncStateRecord | undefined>, [StoreName, string]>;
	put: jest.Mock<Promise<void>, [StoreName, ConflictRecord | MetadataValue | SyncStateRecord, string?]>;
	delete: jest.Mock<Promise<void>, [StoreName, string]>;
	getAll: jest.Mock<Promise<Array<ConflictRecord | SyncStateRecord>>, ['stateRecords' | 'conflicts']>;
	transaction: jest.Mock<MockTransaction, [StoreName[], 'readwrite']>;
	close: jest.Mock<void, []>;
	createObjectStore: jest.Mock<void, [StoreName, { keyPath: 'path' }?]>;
}

interface MockTransaction {
	objectStore: jest.Mock<MockObjectStore, [StoreName]>;
	done: Promise<void>;
}

interface MockObjectStore {
	clear: jest.Mock<Promise<void>, []>;
	put: jest.Mock<Promise<void>, [MetadataValue, string?]>;
}

interface MockDatabaseContext {
	db: MockJournalDatabase;
	stateRecords: Map<string, SyncStateRecord>;
	conflicts: Map<string, ConflictRecord>;
	metadata: Map<string, MetadataValue>;
	tx: MockTransaction;
	storeHandles: Record<StoreName, MockObjectStore>;
}

function createStateRecord(overrides: Partial<SyncStateRecord> = {}): SyncStateRecord {
	return {
		path: 'notes/example.md',
		remoteKey: 'vault/notes/example.md',
		contentFingerprint: 'sha256:abc123',
		localMtime: 100,
		localSize: 200,
		remoteObjectSize: 400,
		remoteEtag: 'etag-1',
		remoteLastModified: 500,
		lastSyncedAt: 600,
		...overrides,
	};
}

function createConflictRecord(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
	return {
		path: 'notes/conflict.md',
		mode: 'both',
		localArtifactPath: 'notes/LOCAL_conflict.md',
		remoteArtifactPath: 'notes/REMOTE_conflict.md',
		baselineFingerprint: 'sha256:baseline',
		detectedAt: 700,
		...overrides,
	};
}

function createMockDatabase(): MockDatabaseContext {
	const stateRecords = new Map<string, SyncStateRecord>();
	const conflicts = new Map<string, ConflictRecord>();
	const metadata = new Map<string, MetadataValue>();

	const storeHandles: Record<StoreName, MockObjectStore> = {
		stateRecords: {
			clear: jest.fn(async () => {
				stateRecords.clear();
			}),
			put: jest.fn(async (_value: MetadataValue, _key?: string) => undefined),
		},
		conflicts: {
			clear: jest.fn(async () => {
				conflicts.clear();
			}),
			put: jest.fn(async (_value: MetadataValue, _key?: string) => undefined),
		},
		metadata: {
			clear: jest.fn(async () => {
				metadata.clear();
			}),
			put: jest.fn(async (value: MetadataValue, key?: string) => {
				metadata.set(key ?? '', value);
			}),
		},
	};

	const tx: MockTransaction = {
		objectStore: jest.fn((storeName: StoreName) => storeHandles[storeName]),
		done: Promise.resolve(),
	};

	const db: MockJournalDatabase = {
		get: jest.fn(async (storeName: StoreName, key: string) => {
			if (storeName === 'stateRecords') {
				return stateRecords.get(key);
			}

			if (storeName === 'conflicts') {
				return conflicts.get(key);
			}

			return metadata.get(key);
		}),
		put: jest.fn(async (storeName: StoreName, value: ConflictRecord | MetadataValue | SyncStateRecord, key?: string) => {
			if (storeName === 'stateRecords') {
				stateRecords.set((value as SyncStateRecord).path, value as SyncStateRecord);
				return;
			}

			if (storeName === 'conflicts') {
				conflicts.set((value as ConflictRecord).path, value as ConflictRecord);
				return;
			}

			metadata.set(key ?? '', value as MetadataValue);
		}),
		delete: jest.fn(async (storeName: StoreName, key: string) => {
			if (storeName === 'stateRecords') {
				stateRecords.delete(key);
				return;
			}

			if (storeName === 'conflicts') {
				conflicts.delete(key);
				return;
			}

			metadata.delete(key);
		}),
		getAll: jest.fn(async (storeName: 'stateRecords' | 'conflicts') => {
			return storeName === 'stateRecords'
				? Array.from(stateRecords.values())
				: Array.from(conflicts.values());
		}),
		transaction: jest.fn((_storeNames: StoreName[], _mode: 'readwrite') => tx),
		close: jest.fn(),
		createObjectStore: jest.fn(),
	};

	return {
		db,
		stateRecords,
		conflicts,
		metadata,
		tx,
		storeHandles,
	};
}

async function initializeJournal(vaultName = 'test-vault'): Promise<{ journal: SyncJournal } & MockDatabaseContext> {
	const context = createMockDatabase();
	jest.mocked(openDB).mockResolvedValue(context.db as never);

	const journal = new SyncJournal(vaultName);
	await journal.initialize();

	return {
		journal,
		...context,
	};
}

describe('SyncJournal', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('initialize', () => {
		it('opens the journal database using the vault-specific name', async () => {
			const { db } = createMockDatabase();
			jest.mocked(openDB).mockResolvedValue(db as never);

			const journal = new SyncJournal('MyVault');
			await journal.initialize();

			expect(openDB).toHaveBeenCalledWith(
				'obsidian-s3-sync-journal-MyVault',
				1,
				expect.objectContaining({
					upgrade: expect.any(Function),
				}),
			);
		});

		it('creates all journal stores during upgrade', async () => {
			const { db } = createMockDatabase();
			jest.mocked(openDB).mockResolvedValue(db as never);

			const journal = new SyncJournal('UpgradeVault');
			await journal.initialize();

			const options = jest.mocked(openDB).mock.calls[0]?.[2];
			const upgradeDb = {
				createObjectStore: jest.fn(),
			};

			options?.upgrade?.(upgradeDb as never, 0, 1, {} as never, {} as never);
			expect(upgradeDb.createObjectStore).toHaveBeenNthCalledWith(1, 'stateRecords', { keyPath: 'path' });
			expect(upgradeDb.createObjectStore).toHaveBeenNthCalledWith(2, 'conflicts', { keyPath: 'path' });
			expect(upgradeDb.createObjectStore).toHaveBeenNthCalledWith(3, 'metadata');
		});
	});

	describe('initialization guard', () => {
		it('throws for every async public method before initialize is called', async () => {
			const journal = new SyncJournal('guard-vault');
			const stateRecord = createStateRecord();
			const conflictRecord = createConflictRecord();

			await expect(journal.getStateRecord('notes/example.md')).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.setStateRecord(stateRecord)).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.deleteStateRecord('notes/example.md')).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.getAllStateRecords()).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.getConflict('notes/conflict.md')).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.setConflict(conflictRecord)).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.deleteConflict('notes/conflict.md')).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.getAllConflicts()).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.getMetadata('engineVersion')).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.setMetadata('engineVersion', 2)).rejects.toThrow(/SyncJournal not initialized/);
			await expect(journal.resetForDestination('destination')).rejects.toThrow(/SyncJournal not initialized/);
		});

		it('allows close to be called safely before initialization', () => {
			const journal = new SyncJournal('guard-vault');

			expect(() => journal.close()).not.toThrow();
		});
	});

	describe('state record methods', () => {
		it('stores, reads, lists, and deletes state records', async () => {
			const { journal, stateRecords, db } = await initializeJournal();
			const firstRecord = createStateRecord();
			const secondRecord = createStateRecord({
				path: 'notes/second.md',
				remoteKey: 'vault/notes/second.md',
				contentFingerprint: 'sha256:def456',
			});

			await journal.setStateRecord(firstRecord);
			await journal.setStateRecord(secondRecord);

			expect(db.put).toHaveBeenNthCalledWith(1, 'stateRecords', firstRecord);
			expect(db.put).toHaveBeenNthCalledWith(2, 'stateRecords', secondRecord);
			expect(await journal.getStateRecord(firstRecord.path)).toEqual(firstRecord);
			expect(db.get).toHaveBeenCalledWith('stateRecords', firstRecord.path);
			expect(await journal.getAllStateRecords()).toEqual([firstRecord, secondRecord]);
			expect(db.getAll).toHaveBeenCalledWith('stateRecords');

			await journal.deleteStateRecord(firstRecord.path);

			expect(db.delete).toHaveBeenCalledWith('stateRecords', firstRecord.path);
			expect(stateRecords.has(firstRecord.path)).toBe(false);
			expect(await journal.getAllStateRecords()).toEqual([secondRecord]);
		});
	});

	describe('conflict methods', () => {
		it('stores, reads, lists, and deletes conflict records', async () => {
			const { journal, conflicts, db } = await initializeJournal();
			const firstConflict = createConflictRecord();
			const secondConflict = createConflictRecord({
				path: 'notes/deleted.md',
				mode: 'remote-only',
				localArtifactPath: undefined,
				remoteArtifactPath: 'notes/REMOTE_deleted.md',
			});

			await journal.setConflict(firstConflict);
			await journal.setConflict(secondConflict);

			expect(db.put).toHaveBeenNthCalledWith(1, 'conflicts', firstConflict);
			expect(db.put).toHaveBeenNthCalledWith(2, 'conflicts', secondConflict);
			expect(await journal.getConflict(firstConflict.path)).toEqual(firstConflict);
			expect(db.get).toHaveBeenCalledWith('conflicts', firstConflict.path);
			expect(await journal.getAllConflicts()).toEqual([firstConflict, secondConflict]);
			expect(db.getAll).toHaveBeenCalledWith('conflicts');

			await journal.deleteConflict(firstConflict.path);

			expect(db.delete).toHaveBeenCalledWith('conflicts', firstConflict.path);
			expect(conflicts.has(firstConflict.path)).toBe(false);
			expect(await journal.getAllConflicts()).toEqual([secondConflict]);
		});
	});

	describe('metadata methods', () => {
		it('stores and reads metadata values by explicit key', async () => {
			const { journal, metadata, db } = await initializeJournal();

			await journal.setMetadata('engineVersion', 2);
			await journal.setMetadata('syncEnabled', true);
			await journal.setMetadata('deviceName', 'Laptop');

			expect(db.put).toHaveBeenNthCalledWith(1, 'metadata', 2, 'engineVersion');
			expect(db.put).toHaveBeenNthCalledWith(2, 'metadata', true, 'syncEnabled');
			expect(db.put).toHaveBeenNthCalledWith(3, 'metadata', 'Laptop', 'deviceName');
			expect(await journal.getMetadata('engineVersion')).toBe(2);
			expect(await journal.getMetadata('syncEnabled')).toBe(true);
			expect(await journal.getMetadata('deviceName')).toBe('Laptop');
			expect(await journal.getMetadata('missingKey')).toBeUndefined();
			expect(metadata.get('engineVersion')).toBe(2);
			expect(metadata.get('syncEnabled')).toBe(true);
			expect(metadata.get('deviceName')).toBe('Laptop');
		});
	});

	describe('resetForDestination', () => {
		it('clears state and conflict stores, then records the new destination fingerprint', async () => {
			const { journal, stateRecords, conflicts, metadata, tx, storeHandles } = await initializeJournal();
			stateRecords.set('notes/example.md', createStateRecord());
			conflicts.set('notes/conflict.md', createConflictRecord());
			metadata.set('lastSuccessfulSyncAt', 123);

			await journal.resetForDestination('bucket:region');

			expect(tx.objectStore).toHaveBeenNthCalledWith(1, 'stateRecords');
			expect(tx.objectStore).toHaveBeenNthCalledWith(2, 'conflicts');
			expect(tx.objectStore).toHaveBeenNthCalledWith(3, 'metadata');
			expect(tx.objectStore).toHaveBeenNthCalledWith(4, 'metadata');
			expect(storeHandles.stateRecords.clear).toHaveBeenCalledTimes(1);
			expect(storeHandles.conflicts.clear).toHaveBeenCalledTimes(1);
			expect(storeHandles.metadata.clear).toHaveBeenCalledTimes(1);
			expect(storeHandles.metadata.put).toHaveBeenCalledWith('bucket:region', 'destinationFingerprint');
			expect(stateRecords.size).toBe(0);
			expect(conflicts.size).toBe(0);
			expect(metadata.size).toBe(1);
			expect(metadata.get('destinationFingerprint')).toBe('bucket:region');
		});
	});

	describe('close', () => {
		it('closes the database handle and resets the journal to an uninitialized state', async () => {
			const { journal, db } = await initializeJournal();

			journal.close();

			expect(db.close).toHaveBeenCalledTimes(1);
			await expect(journal.getAllStateRecords()).rejects.toThrow(/SyncJournal not initialized/);
		});
	});
});
