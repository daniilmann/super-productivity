import { inject, Injectable } from '@angular/core';
import { extractEntityFromPayload } from '@sp/sync-core';
import { DBSchema, IDBPDatabase, openDB } from 'idb';
import { ClientIdService } from '../../core/util/client-id.service';
import { PluginLog } from '../../core/log';
import { OpType } from '../../op-log/core/operation.types';
import { isCompactOperation } from '../../op-log/persistence/compact/operation-codec.service';
import {
  decodeStoredEntry,
  StoredOperationLogEntry,
} from '../../op-log/persistence/operation-log-store-rows';
import { ServerClock } from './server-clock';

interface ReceiptCandidate {
  entityId: string;
  clientId: string;
  seq: number;
  encoded: string;
}

export interface Receipt extends Omit<ReceiptCandidate, 'encoded'> {
  encodedSha256: string;
  confirmedAt: number;
  correction: number;
}

interface ReceiptDatabase extends DBSchema {
  receipts: {
    key: [string, string];
    value: Receipt;
    indexes: { byEntity: string };
  };
}

export const sha256 = async (bytes: Uint8Array<ArrayBuffer>): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
};

const collectReceiptCandidate = (
  candidates: ReceiptCandidate[],
  entry: StoredOperationLogEntry,
): void => {
  if (
    entry.source !== 'local' ||
    entry.rejectedAt !== undefined ||
    entry.reducerRejectedAt !== undefined
  ) {
    return;
  }
  try {
    const entityType = isCompactOperation(entry.op) ? entry.op.e : entry.op.entityType;
    if (entityType !== 'PLUGIN_USER_DATA') return;
    const { op } = decodeStoredEntry(entry);
    if (op.opType !== OpType.Update || !op.entityId) return;
    const value = extractEntityFromPayload(op.payload, 'pluginUserData');
    if (value?.['id'] === op.entityId && typeof value['data'] === 'string') {
      candidates.push({
        entityId: op.entityId,
        clientId: op.clientId,
        seq: entry.seq,
        encoded: value['data'],
      });
    }
  } catch {
    // An unreadable legacy row must not interrupt acknowledgement.
  }
};

@Injectable({ providedIn: 'root' })
export class ReceiptStore {
  private readonly _clientId = inject(ClientIdService);
  private readonly _clock = inject(ServerClock);
  private _connection?: Promise<IDBPDatabase<ReceiptDatabase>>;

  async read(entityIds: Iterable<string>): Promise<Map<string, Receipt[]>> {
    try {
      const db = await this._open();
      const tx = db.transaction('receipts');
      const index = tx.store.index('byEntity');
      const queries = [...entityIds].map(
        async (id) => [id, await index.getAll(id)] as const,
      );
      const [entries] = await Promise.all([Promise.all(queries), tx.done]);
      return new Map(entries);
    } catch {
      return new Map();
    }
  }

  async recordAcknowledgement(
    acknowledge: (collect: (entry: StoredOperationLogEntry) => void) => Promise<void>,
  ): Promise<void> {
    const confirmedAt = Date.now();
    const correction = this._clock.correction;
    const candidates: ReceiptCandidate[] = [];
    await acknowledge((entry) => {
      collectReceiptCandidate(candidates, entry);
    });
    await this._record(candidates, confirmedAt, correction);
  }

  private async _record(
    candidates: ReceiptCandidate[],
    confirmedAt: number,
    correction: number,
  ): Promise<void> {
    if (!candidates.length) return;

    try {
      const clientId = await this._clientId.loadCommittedClientId();
      const latest = new Map<string, ReceiptCandidate>();
      for (const candidate of candidates) {
        if (
          candidate.clientId === clientId &&
          candidate.seq > (latest.get(candidate.entityId)?.seq ?? 0)
        ) {
          latest.set(candidate.entityId, candidate);
        }
      }
      if (!latest.size) return;

      const encoder = new TextEncoder();
      const receipts = await Promise.all(
        [...latest.values()].map(
          async ({ encoded, ...identity }): Promise<Receipt> => ({
            ...identity,
            encodedSha256: await sha256(encoder.encode(encoded)),
            confirmedAt,
            correction,
          }),
        ),
      );
      const db = await this._open();
      const tx = db.transaction('receipts', 'readwrite');
      const writes = receipts.map(async (receipt) => {
        const previous = await tx.store.get([receipt.clientId, receipt.entityId]);
        // Hashing can finish out of order, including across tabs.
        if (!previous || previous.seq < receipt.seq) {
          await tx.store.put(receipt);
        }
      });
      await Promise.all([...writes, tx.done]);
    } catch {
      PluginLog.warn('Unable to cache plugin save confirmation');
    }
  }

  private _open(): Promise<IDBPDatabase<ReceiptDatabase>> {
    this._connection ??= openDB<ReceiptDatabase>('SUP_PLUGIN_SAVE_RECEIPTS', 1, {
      upgrade: (db) => {
        db.createObjectStore('receipts', {
          keyPath: ['clientId', 'entityId'],
        }).createIndex('byEntity', 'entityId');
      },
    }).catch((error: unknown) => {
      this._connection = undefined;
      throw error;
    });
    return this._connection;
  }
}
