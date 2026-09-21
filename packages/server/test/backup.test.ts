import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTempDir } from './harness.ts';
import { createBackup, verifyBackup } from '../../../scripts/backup.mjs';

test('在线备份包含 WAL 数据和原文，校验可发现损坏', async () => {
  const dir = makeTempDir('backup'); const dbPath = path.join(dir, 'kb.db');
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE documents (storage_path TEXT); INSERT INTO documents VALUES ('uploads/1/1/source.txt')");
  mkdirSync(path.join(dir, 'uploads/1/1'), { recursive: true });
  writeFileSync(path.join(dir, 'uploads/1/1/source.txt'), 'backup fixture');
  try {
    const result = await createBackup({ dbPath, dataDir: dir, outputDir: path.join(dir, 'backups') });
    assert.equal(verifyBackup(result), 2);
    const copy = new DatabaseSync(path.join(result, 'kb.db'), { readOnly: true });
    try { assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n, 1); } finally { copy.close(); }
    assert.equal(readFileSync(path.join(result, 'uploads/1/1/source.txt'), 'utf8'), 'backup fixture');
    writeFileSync(path.join(result, 'uploads/1/1/source.txt'), 'corrupt');
    assert.throws(() => verifyBackup(result), /校验失败/);
  } finally { db.close(); }
});
