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
    `);
  }

  save(job: Job): Job {
    job.updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (id, created_at, updated_at, status, data)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
           status = excluded.status, data = excluded.data`,
      )
      .run(job.id, job.createdAt, job.updatedAt, job.status, JSON.stringify(job));
    return job;
  }

  get(id: string): Job | null {
    const row = this.db.prepare(`SELECT data FROM jobs WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Job) : null;
  }

  list(limit = 50): Job[] {
    const rows = this.db
      .prepare(`SELECT data FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Job);
  }

  byStatus(status: JobStatus, limit = 100): Job[] {
    const rows = this.db
      .prepare(`SELECT data FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?`)
      .all(status, limit) as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Job);
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
