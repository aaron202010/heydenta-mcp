// Local idempotency store for create_booking. A model that retries a tool call (timeout,
// lost response) sends the same idempotency_key; we answer from this store instead of
// posting again. The server has its own guard (same patient, same slot) as a second layer.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type StoredBooking = { event_id: number; scheduled_at_human: string; stored_at: string };

export interface BookingStore {
  get(key: string): StoredBooking | undefined;
  set(key: string, value: StoredBooking): void;
}

export class MemoryStore implements BookingStore {
  private readonly map = new Map<string, StoredBooking>();
  get(key: string) { return this.map.get(key); }
  set(key: string, value: StoredBooking) { this.map.set(key, value); }
}

export class FileStore implements BookingStore {
  private data: Record<string, StoredBooking> = {};
  constructor(private readonly path: string = defaultStatePath()) {
    try { this.data = JSON.parse(readFileSync(this.path, "utf8")); } catch { this.data = {}; }
  }
  get(key: string) { return this.data[key]; }
  set(key: string, value: StoredBooking) {
    this.data[key] = value;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 1));
  }
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEYDENTA_MCP_STATE || join(homedir(), ".heydenta-mcp", "bookings.json");
}
