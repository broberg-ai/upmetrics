// F025.2 — the one-time switch to auto_vacuum=INCREMENTAL. Run: bun test src/db/vacuum.test.ts
//
// Against a REAL file on disk, because the claim is about the file: a DELETE
// leaves it at its high-water mark, and only a VACUUM gives the bytes back.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureIncrementalAutoVacuum, vacuumState } from './vacuum';

const files: string[] = [];
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) rmSync(f + s, { force: true });
});

// The shape prod had on 24/9: auto_vacuum NONE, most of the file free pages.
function bloatedNoneDb(): { sqlite: Database; path: string } {
  const path = join(tmpdir(), `vacuum-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  files.push(path);
  const sqlite = new Database(path);
  sqlite.exec('PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL;');
  sqlite.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
  const ins = sqlite.prepare('INSERT INTO t (blob) VALUES (?)');
  sqlite.transaction(() => {
    for (let i = 0; i < 2000; i++) ins.run('x'.repeat(3000));
  })();
  sqlite.exec('DELETE FROM t WHERE id % 8 != 0'); // ~87 % free, as measured on prod
  sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  return { sqlite, path };
}

describe('F025.2 — omlægning til auto_vacuum=INCREMENTAL', () => {
  it('en NONE-base med frie sider bliver INCREMENTAL, og FILEN på disken skrumper', () => {
    const { sqlite, path } = bloatedNoneDb();
    const sizeBefore = statSync(path).size;
    const before = vacuumState(sqlite);
    expect(before.autoVacuum).toBe(0);
    expect(before.freelistCount).toBeGreaterThan(0);

    const r = ensureIncrementalAutoVacuum(sqlite);

    expect(r.converted).toBe(true);
    expect(r.after.autoVacuum).toBe(2);
    expect(r.after.freelistCount).toBe(0);
    expect(r.after.pageCount).toBeLessThan(before.pageCount);
    // The file itself, not SQLite's opinion of it.
    expect(statSync(path).size).toBeLessThan(sizeBefore / 2);
    sqlite.close();
  });

  it('anden kørsel er en no-op — en boot efter den første omskriver IKKE basen igen', () => {
    const { sqlite, path } = bloatedNoneDb();
    ensureIncrementalAutoVacuum(sqlite);
    const size = statSync(path).size;

    const again = ensureIncrementalAutoVacuum(sqlite);

    expect(again.converted).toBe(false);
    expect(again.ms).toBe(0);
    expect(statSync(path).size).toBe(size);
    sqlite.close();
  });

  it('data overlever omlægningen — samme rækker og samme indhold', () => {
    const { sqlite } = bloatedNoneDb();
    const rowsBefore = sqlite.query('SELECT id, length(blob) AS n FROM t ORDER BY id').all();
    ensureIncrementalAutoVacuum(sqlite);
    expect(sqlite.query('SELECT id, length(blob) AS n FROM t ORDER BY id').all()).toEqual(rowsBefore);
    sqlite.close();
  });
});
