// 数据库备份机制测试（0.1.55）
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupDatabase } from '../web/memory.mjs'

describe('memory backup', () => {
  test('backupDatabase creates timestamped backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'))
    const dbFile = join(dir, 'test.sqlite')
    writeFileSync(dbFile, 'test data')
    
    const backup = backupDatabase(dbFile, { dir, keep: 3 })
    assert.ok(backup)
    assert.ok(existsSync(backup))
    assert.ok(backup.includes('memory_'))
    assert.ok(backup.endsWith('.sqlite'))
    
    rmSync(dir, { recursive: true, force: true })
  })

  test('backupDatabase keeps only N most recent backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'))
    const dbFile = join(dir, 'test.sqlite')
    writeFileSync(dbFile, 'test data')
    
    // Create 5 backups with keep=3
    for (let i = 0; i < 5; i++) {
      backupDatabase(dbFile, { dir, keep: 3 })
      // Small delay to ensure different timestamps
      const start = Date.now()
      while (Date.now() - start < 10) { /* wait */ }
    }
    
    const backups = readdirSync(dir).filter((f) => f.startsWith('memory_') && f.endsWith('.sqlite'))
    assert.equal(backups.length, 3, 'should keep only 3 backups')
    
    rmSync(dir, { recursive: true, force: true })
  })

  test('backupDatabase returns null if source does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'))
    const dbFile = join(dir, 'nonexistent.sqlite')
    
    const backup = backupDatabase(dbFile, { dir })
    assert.equal(backup, null)
    
    rmSync(dir, { recursive: true, force: true })
  })

  test('backupDatabase handles missing source gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'))
    const dbFile = join(dir, 'test.sqlite')
    writeFileSync(dbFile, 'test data')
    
    // Backup should work even if backup dir doesn't exist yet
    const backupDir = join(dir, 'backups')
    assert.ok(!existsSync(backupDir))
    
    const backup = backupDatabase(dbFile, { dir: backupDir, keep: 3 })
    assert.ok(backup)
    assert.ok(existsSync(backupDir))
    assert.ok(existsSync(backup))
    
    rmSync(dir, { recursive: true, force: true })
  })

  test('backup files are sorted by timestamp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-backup-'))
    const dbFile = join(dir, 'test.sqlite')
    writeFileSync(dbFile, 'test data')
    
    const backups = []
    for (let i = 0; i < 3; i++) {
      const backup = backupDatabase(dbFile, { dir, keep: 5 })
      backups.push(backup)
      const start = Date.now()
      while (Date.now() - start < 15) { /* wait */ }
    }
    
    const files = readdirSync(dir)
      .filter((f) => f.startsWith('memory_') && f.endsWith('.sqlite'))
      .sort()
    
    assert.equal(files.length, 3)
    // Files should be in chronological order (oldest first)
    for (let i = 0; i < files.length - 1; i++) {
      const t1 = statSync(join(dir, files[i])).mtimeMs
      const t2 = statSync(join(dir, files[i + 1])).mtimeMs
      assert.ok(t1 <= t2, 'backups should be in chronological order')
    }
    
    rmSync(dir, { recursive: true, force: true })
  })
})
