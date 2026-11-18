import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ServerClock {
  private _correction = 0;

  get correction(): number {
    return this._correction;
  }

  observe(serverTime: number | undefined): void {
    if (serverTime !== undefined && Number.isFinite(serverTime)) {
      this._correction = serverTime - Date.now();
    }
  }
}
