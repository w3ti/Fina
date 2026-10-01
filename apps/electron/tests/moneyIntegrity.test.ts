import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import BetterSqlite from 'better-sqlite3-multiple-ciphers';
import type Database from 'better-sqlite3-multiple-ciphers';
import { auditMoneyShadowConsistency, MONEY_COLUMNS, type MoneyAuditDatabase } from '../src/main/moneyMigrationAudit';
import { encodeMoneyWireTables, normalizeMoneyWireTables } from '../src/main/moneyWireFormat';

// Gate 2 do ADR 001: o diagnóstico de integridade precisa retornar zero
// divergências após operações normais, restore completo e aplicação de patch.

const handlers = new Map<string, (_event: unknown, payload?: any) => any>();
let db: Database.Database;
let database: typeof import('../src/main/database');
let backup: typeof import('../src/main/incrementalBackup');
const directory = mkdtempSync(join(tmpdir(), 'fina-money-integrity-'));
const call = (channel: string, payload?: unknown): any => handlers.get(channel)!({}, payload);

function freshDatabase(): void {
  database.closeDatabase();
  database.openDatabase();
  database.finalizePragmas();
  db = database.getDb();
  const migrations = join(process.cwd(), 'src/main/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, file), 'utf8'));
}

function assertNoDivergence(target: Database.Database): void {
  const diagnostic = auditMoneyShadowConsistency(target as unknown as MoneyAuditDatabase);
  assert.deepEqual(diagnostic.violations, []);
  assert.equal(diagnostic.divergentRows, 0);
  assert.ok(diagnostic.checkedRows > 0);
}

function centsTotals(target: Database.Database): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const { table, column } of MONEY_COLUMNS) {
    const row = target.prepare(`SELECT COALESCE(SUM("${column}_cents"), 0) AS total, COUNT(*) AS rows FROM "${table}"`)
      .get() as { total: number; rows: number };
    totals[`${table}.${column}`] = row.total;
    totals[`${table}.#rows`] = row.rows;
  }
  return totals;
}

function seedOperations(): void {
  db.prepare("INSERT INTO accounts (id, name, type, balance, opening_balance_brl) VALUES ('checking', 'Conta', 'checking', 1000.01, 1000.01)").run();
  db.prepare("INSERT INTO accounts (id, name, type, balance, opening_balance_brl) VALUES ('wallet', 'Carteira', 'wallet', 0, 0)").run();
  db.prepare("INSERT INTO accounts (id, name, type, balance, credit_limit) VALUES ('card', 'Cartão', 'credit_card', 0, 5000.5)").run();
  const base = { to_account_id: null, notes: null, recurring: 0, owner: null, status: 'confirmed' };
  call('transactions:create', {
    ...base, account_id: 'checking', category_id: 'cat-3', description: 'Mercado', amount: 10.01, type: 'expense', date: '2026-01-05',
    payments: [{ account_id: 'checking', amount: 3.34 }, { account_id: 'wallet', amount: 6.67 }],
    categories: [{ category_id: 'cat-3', amount: 5 }, { category_id: 'cat-4', amount: 5.01 }],
  });
  call('transactions:create', {
    ...base, account_id: 'checking', to_account_id: 'wallet', category_id: 'cat-3', description: 'Saque', amount: 0.01, type: 'transfer', date: '2026-01-06',
  });
  call('transactions:createInstallments', {
    ...base, account_id: 'card', category_id: 'cat-3', description: 'Parcelado', amount: 10, type: 'expense', date: '2026-01-07', installments: 3,
  });
  call('debts:create', {
    description: 'Dívida', type: 'emprestimo', creditor: 'Credor', original_amount: 1500.5,
    outstanding_balance: 1200.33, interest_rate: 2, installments_total: 12, installments_remaining: 10,
    installment_amount: 120.03, next_due_date: '2026-01-15', status: 'em_atraso',
  });
  const debtId = call('debts:list')[0].id;
  const agreement = call('debts:createAgreement', {
    debt_id: debtId, agreed_on: '2026-01-01', total_amount: 1000, down_payment: 100,
    down_payment_date: '2026-01-05', installments: 3, first_due_date: '2026-01-31', notes: null,
  });
  call('bills:markAsPaid', {
    id: agreement.installments[1].bill_id, date: '2026-01-31', category_id: 'cat-3',
    payments: [{ account_id: 'checking', amount: 200 }, { account_id: 'wallet', amount: 100 }],
  });
}

before(async () => {
  const require = createRequire(__filename);
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { exports: {
    ipcMain: { handle: (channel: string, handler: (_event: unknown, payload?: any) => any) => handlers.set(channel, handler) },
    app: { getPath: () => directory, getLocale: () => 'pt-BR' },
    // Identidade em vez de cifra: basta para exercitar o envelope local legado.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8'),
    },
  } } as NodeJS.Module;
  process.env.FINA_DB_PATH = ':memory:';
  database = await import('../src/main/database');
  (await import('../src/main/ipc/debts')).registerDebtHandlers();
  (await import('../src/main/ipc/bills')).registerBillHandlers();
  (await import('../src/main/ipc/transactions')).registerTransactionHandlers();
  backup = await import('../src/main/incrementalBackup');
});

beforeEach(() => {
  freshDatabase();
  seedOperations();
});

after(() => { database?.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

test('operações normais não deixam divergência entre legado e centavos', () => {
  assertNoDivergence(db);
});

test('patch cents-v1 aplicado em banco novo preserva totais sem divergência', () => {
  const expected = centsTotals(db);
  const file = join(directory, 'cents.finpatch');
  backup.exportPortableIncrementalBackup('2000-01-01', file, 'test-password');
  freshDatabase();
  backup.importIncrementalPatch(file, 'test-password');
  assertNoDivergence(db);
  assert.deepEqual(centsTotals(db), expected);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('patch decimal-v1 legado aplicado em banco novo preserva totais sem divergência', () => {
  const expected = centsTotals(db);
  const file = join(directory, 'decimal.finpatch');
  backup.exportIncrementalBackup('2000-01-01', file);
  const envelope = JSON.parse(readFileSync(file, 'utf8')) as { payload: string };
  const patch = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  assert.equal(patch.money_format, 'cents-v1');
  // Patches anteriores ao versionamento não tinham money_format e usavam decimais.
  patch.tables = encodeMoneyWireTables(normalizeMoneyWireTables(patch.tables, 'cents-v1'), 'decimal-v1');
  delete patch.money_format;
  envelope.payload = Buffer.from(JSON.stringify(patch), 'utf8').toString('base64');
  writeFileSync(file, JSON.stringify(envelope));

  freshDatabase();
  backup.importIncrementalPatch(file);
  assertNoDivergence(db);
  assert.deepEqual(centsTotals(db), expected);
});

test('restore completo do arquivo de banco preserva totais sem divergência', () => {
  const expected = centsTotals(db);
  const file = join(directory, 'restore.fin');
  db.prepare('VACUUM INTO ?').run(file);
  const restored = new BetterSqlite(file, { readonly: true });
  try {
    assertNoDivergence(restored);
    assert.deepEqual(centsTotals(restored), expected);
    assert.deepEqual(restored.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  } finally {
    restored.close();
  }
});
