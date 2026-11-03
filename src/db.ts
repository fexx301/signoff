import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, JobStatus } from "./types.js";

export class JobStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS events_job_idx ON events(job_id);
      CREATE TABLE IF NOT EXISTS payment_claims (payment_id TEXT PRIMARY KEY, job_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nonce_claims (
        network TEXT NOT NULL, account TEXT NOT NULL, job_id TEXT NOT NULL, nonce INTEGER NOT NULL,
        PRIMARY KEY(network, account, job_id), UNIQUE(network, account, nonce)
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === "revision")) this.db.exec("ALTER TABLE jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  }

  save(job: Job): Job {
    const previous = job.revision;
    const next = { ...job, updatedAt: new Date().toISOString(), revision: previous === undefined ? 0 : previous + 1 };
    if (previous === undefined) {
      this.db.prepare("INSERT INTO jobs (id, created_at, updated_at, status, data, revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run(next.id, next.createdAt, next.updatedAt, next.status, JSON.stringify(next), next.revision);
    } else {
      const result = this.db.prepare("UPDATE jobs SET updated_at=?, status=?, data=?, revision=? WHERE id=? AND revision=?")
        .run(next.updatedAt, next.status, JSON.stringify(next), next.revision, next.id, previous);
      if (result.changes !== 1) throw new Error(`Concurrent update rejected for ${job.id}`);
    }
    Object.assign(job, next);
    return job;
  }

  claimPayment(paymentId: string, jobId: string): string {
    this.db.prepare("INSERT OR IGNORE INTO payment_claims (payment_id, job_id) VALUES (?, ?)").run(paymentId, jobId);
    return (this.db.prepare("SELECT job_id FROM payment_claims WHERE payment_id=?").get(paymentId) as { job_id: string }).job_id;
  }

  reserveNonce(network: string, account: string, jobId: string, pending: number): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT nonce FROM nonce_claims WHERE network=? AND account=? AND job_id=?").get(network, account, jobId) as { nonce: number } | undefined;
      if (existing) { this.db.exec("COMMIT"); return existing.nonce; }
      const row = this.db.prepare("SELECT MAX(nonce) AS last FROM nonce_claims WHERE network=? AND account=?").get(network, account) as { last: number | null };
      const nonce = Math.max(pending, (row.last ?? -1) + 1);
      this.db.prepare("INSERT INTO nonce_claims (network, account, job_id, nonce) VALUES (?, ?, ?, ?)").run(network, account, jobId, nonce);
      this.db.exec("COMMIT");
      return nonce;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  get(id: string): Job | null {
    const row = this.db.prepare(`SELECT data, revision FROM jobs WHERE id = ?`).get(id) as
      | { data: string; revision: number }
      | undefined;
    return row ? ({ ...JSON.parse(row.data), revision: row.revision } as Job) : null;
  }

  list(limit = 50): Job[] {
    const rows = this.db
      .prepare(`SELECT data, revision FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<{ data: string; revision: number }>;
    return rows.map((row) => ({ ...JSON.parse(row.data), revision: row.revision } as Job));
  }

  byStatus(status: JobStatus, limit = 100): Job[] {
    const rows = this.db
      .prepare(`SELECT data, revision FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?`)
      .all(status, limit) as Array<{ data: string; revision: number }>;
    return rows.map((row) => ({ ...JSON.parse(row.data), revision: row.revision } as Job));
  }

  event(jobId: string, type: string, detail?: unknown): void {
    this.db
      .prepare(`INSERT INTO events (job_id, at, type, detail) VALUES (?, ?, ?, ?)`)
      .run(jobId, new Date().toISOString(), type, detail === undefined ? null : JSON.stringify(detail));
  }

  events(jobId: string): Array<{ at: string; type: string; detail: unknown }> {
    const rows = this.db
      .prepare(`SELECT at, type, detail FROM events WHERE job_id = ? ORDER BY id ASC`)
      .all(jobId) as Array<{ at: string; type: string; detail: string | null }>;
    return rows.map((row) => ({
      at: row.at,
      type: row.type,
      detail: row.detail ? JSON.parse(row.detail) : null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
