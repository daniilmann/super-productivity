import { inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import type { SaveState } from '@super-productivity/plugin-api';
import { combineLatest, firstValueFrom } from 'rxjs';
import { ClientIdService } from '../../core/util/client-id.service';
import { SyncWrapperService } from '../../imex/sync/sync-wrapper.service';
import { OperationCaptureService } from '../../op-log/capture/operation-capture.service';
import { LOCK_NAMES } from '../../op-log/core/operation-log.const';
import { LockService } from '../../op-log/sync/lock.service';
import { IS_ONLINE$ } from '../../util/is-online.token';
import { PluginUserPersistenceService } from '../plugin-user-persistence.service';
import { selectPluginUserDataFeatureState } from '../store/plugin-user-data.reducer';
import { decodePersistedGzipBytes, SENTINEL } from '../util/plugin-data-codec';
import {
  assertPluginPersistenceKey,
  composeId,
} from '../util/plugin-persistence-key.util';
import { Receipt, ReceiptStore, sha256 } from './receipt-store';

type KeyState = SaveState['keys'][string];
const MAX_CACHED_VALUES = 8;

@Injectable({ providedIn: 'root' })
export class SaveStateService {
  private readonly _receipts = inject(ReceiptStore);
  private readonly _clientId = inject(ClientIdService);
  private readonly _capture = inject(OperationCaptureService);
  private readonly _persistence = inject(PluginUserPersistenceService);
  private readonly _applied = inject(Store).selectSignal(
    selectPluginUserDataFeatureState,
  );
  private readonly _lock = inject(LockService);
  private readonly _syncState = inject(SyncWrapperService).syncState$;
  private readonly _online = inject(IS_ONLINE$);
  private readonly _encoder = new TextEncoder();
  private readonly _utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private readonly _hashes = new Map<
    string,
    { raw: string; encoded: string; value: string }
  >();

  async getSyncedDataSaveState(
    pluginId: string,
    keys: unknown,
    respond?: (state: SaveState) => void,
  ): Promise<SaveState> {
    const requested = this._requestedKeys(pluginId, keys);
    const receipts = await this._receipts.read(requested.values());
    const entityIds = new Set(requested.values());
    const snapshot = await this._lock.request(LOCK_NAMES.OPERATION_LOG, async () => {
      const clientId = await this._clientId.loadCommittedClientId();
      // No yield between the flags and values: persistence can dispatch without this lock.
      const failed = this._capture.hasUnrecoveredPersistFailure();
      const values = new Map<string, string>();
      for (const item of this._applied()) {
        if (entityIds.has(item.id)) values.set(item.id, item.data);
      }
      const pending = new Set(
        [...entityIds].filter((id) => this._persistence.hasPendingWrite(id)),
      );
      return { clientId, failed, values, pending };
    });
    const [online, status] = await firstValueFrom(
      combineLatest([this._online, this._syncState]),
    );
    const states = await Promise.all(
      [...requested].map(async ([key, id]): Promise<[string, KeyState]> => {
        if (snapshot.failed) return [key, { state: 'failed' }];
        if (snapshot.pending.has(id)) return [key, { state: 'pending' }];
        const receipt = receipts
          .get(id)
          ?.find((item) => item.clientId === snapshot.clientId);
        return [key, await this._confirm(snapshot.values.get(id), receipt)];
      }),
    );
    const result: SaveState = {
      sync: !online ? 'offline' : status === 'ERROR' ? 'error' : 'ok',
      keys: Object.fromEntries(states),
    };
    const deliver = (): SaveState => {
      respond?.(result);
      return result;
    };
    const saved = states.filter(([, state]) => state.state === 'saved');
    if (!saved.length) return deliver();

    return this._lock.request(LOCK_NAMES.OPERATION_LOG, async () => {
      if ((await this._clientId.loadCommittedClientId()) !== snapshot.clientId) {
        for (const [key] of saved) result.keys[key] = { state: 'unknown' };
      }
      return deliver();
    });
  }

  private _requestedKeys(pluginId: string, keys: unknown): Map<string, string> {
    if (!Array.isArray(keys)) throw new Error('Plugin persistence keys must be an array');
    const requested = new Map<string, string>();
    for (const key of keys as unknown[]) {
      if (typeof key !== 'string')
        throw new Error('Plugin persistence key must be a string');
      assertPluginPersistenceKey(key);
      requested.set(key, composeId(pluginId, key));
    }
    return requested;
  }

  private async _confirm(raw: string | undefined, receipt?: Receipt): Promise<KeyState> {
    if (raw === undefined || !receipt) return { state: 'unknown' };
    try {
      const valueSha256 = await this._verifiedValueHash(raw, receipt);
      if (valueSha256 === undefined) return { state: 'unknown' };
      const savedAt = new Date(receipt.confirmedAt + receipt.correction).getTime();
      if (!Number.isSafeInteger(savedAt)) return { state: 'unknown' };
      return { state: 'saved', savedAt, valueSha256 };
    } catch {
      return { state: 'unknown' };
    }
  }

  private async _verifiedValueHash(
    raw: string,
    { entityId, encodedSha256 }: Receipt,
  ): Promise<string | undefined> {
    const cached = this._hashes.get(entityId);
    if (cached?.raw === raw) {
      return cached.encoded === encodedSha256 ? cached.value : undefined;
    }

    const encodedBytes = this._encoder.encode(raw);
    const encoded = await sha256(encodedBytes);
    if (encoded !== encodedSha256) return undefined;

    const value = await this._hashValue(raw, encodedBytes);
    const oldest = this._hashes.keys().next().value;
    if (
      !this._hashes.has(entityId) &&
      this._hashes.size >= MAX_CACHED_VALUES &&
      oldest !== undefined
    ) {
      this._hashes.delete(oldest);
    }
    this._hashes.set(entityId, { raw, encoded, value });
    return value;
  }

  private async _hashValue(
    raw: string,
    encodedBytes: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    if (!raw.startsWith(SENTINEL)) return sha256(encodedBytes);
    const bytes = await decodePersistedGzipBytes(raw);
    this._utf8.decode(bytes);
    return sha256(bytes);
  }
}
