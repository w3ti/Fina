import { before, beforeEach, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3-multiple-ciphers';
import { buildAgreementSchedule } from '../src/shared/debtAgreement';
import type { Debt, DebtAgreement, DebtAgreementInput } from '../src/shared/types';

const handlers = new Map<string, (_event: unknown, payload?: any) => any>();
let db: Database.Database;
let database: typeof import('../src/main/database');
let backup: typeof import('../src/main/incrementalBackup');
const directory = mkdtempSync(join(tmpdir(), 'fina-agreements-'));
const input: DebtAgreementInput = {
  debt_id: '', agreed_on: '2026-01-01', total_amount: 1000, down_payment: 100,
  down_payment_date: '2026-01-05', installments: 3, first_due_date: '2026-01-31', notes: 'Contrato 123',
};
const call = (channel: string, payload?: unknown): any => handlers.get(channel)!({}, payload);
const debt = (): Debt => call('debts:list')[0];
const agreements = (): DebtAgreement[] => call('debts:listAgreements');
const create = (changes: Partial<DebtAgreementInput> = {}): DebtAgreement =>
  call('debts:createAgreement', { ...input, debt_id: debt().id, ...changes });
const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
const balance = (): number => (db.prepare("SELECT balance_cents FROM accounts WHERE id = 'account'").get() as { balance_cents: number }).balance_cents;

before(async () => {
  // Exercita os handlers reais e suas transações SQL, substituindo só o transporte Electron.
  const require = createRequire(__filename);
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { exports: {
    ipcMain: { handle: (channel: string, handler: (_event: unknown, payload?: any) => any) => handlers.set(channel, handler) },
    app: { getPath: () => directory, getLocale: () => 'pt-BR' },
  } } as NodeJS.Module;
  process.env.FINA_DB_PATH = ':memory:';
  database = await import('../src/main/database');
  (await import('../src/main/ipc/debts')).registerDebtHandlers();
  (await import('../src/main/ipc/bills')).registerBillHandlers();
  (await import('../src/main/ipc/transactions')).registerTransactionHandlers();
  backup = await import('../src/main/incrementalBackup');
});

beforeEach(() => {
  database.closeDatabase();
  database.openDatabase();
  database.finalizePragmas();
  db = database.getDb();
  const migrations = join(process.cwd(), 'src/main/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, file), 'utf8'));
  db.prepare("INSERT INTO accounts (id, name, type, balance, opening_balance_brl) VALUES ('account', 'Conta', 'checking', 10000, 10000)").run();
  call('debts:create', {
    description: 'Dívida de teste', type: 'emprestimo', creditor: 'Credor', original_amount: 1500,
    outstanding_balance: 1200, interest_rate: 2, installments_total: 12, installments_remaining: 10,
    installment_amount: 120, next_due_date: '2026-01-15', status: 'em_atraso',
  });
});

after(() => { database?.closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

test('gera entrada e parcelas exatas, preservando fim de mês e centavos', () => {
  const schedule = buildAgreementSchedule({ ...input, total_amount: 100, down_payment: 0 });
  assert.deepEqual(schedule.installments.map(item => item.amount_cents), [3334, 3333, 3333]);
  assert.deepEqual(schedule.installments.map(item => item.due_date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(buildAgreementSchedule({ ...input, down_payment: 1000, installments: 0 }).installments.length, 1);
});

test('rejeita valores, datas e parcelamentos inválidos', () => {
  for (const changes of [
    { total_amount: 0 }, { total_amount: 10.001 }, { total_amount: Infinity }, { down_payment: -1 },
    { down_payment: 1001 }, { installments: 0 }, { installments: 601 }, { installments: 1.5 },
    { total_amount: 0.02, down_payment: 0, installments: 3 }, { agreed_on: '2026-02-30' },
    { first_due_date: '2025-12-31' }, { down_payment_date: '2025-12-31' }, { first_due_date: '2026-01-02' },
  ]) assert.throws(() => create(changes));
  assert.equal(count('debt_agreements'), 0);
  assert.equal(count('bills'), 0);
  assert.equal(debt().outstanding_balance, 1200);
});

test('registra contrato, desconto e cronograma sem lançar despesas antecipadas', () => {
  const agreement = create();
  assert.equal(agreement.original_balance_cents, 120000);
  assert.equal(agreement.total_amount_cents, 100000);
  assert.equal(agreement.notes, 'Contrato 123');
  assert.deepEqual(agreement.installments.map(item => item.amount_cents), [10000, 30000, 30000, 30000]);
  assert.equal(count('bills'), 4);
  assert.equal(count('transactions'), 0);
  assert.equal(balance(), 1000000);
  assert.equal(debt().status, 'renegociada');
  assert.equal(debt().outstanding_balance, 1000);
  assert.equal(debt().installment_amount, 300);
  assert.equal(debt().original_amount, 1500);
  assert.equal(debt().interest_rate, 0);
  assert.throws(() => create(), /já possui/);
  assert.equal(count('bills'), 4);
});

test('pagamento pela Agenda atualiza dívida e caixa uma única vez; quita a última parcela', () => {
  const agreement = create();
  for (const item of agreement.installments) {
    const payment = { id: item.bill_id, category_id: 'cat-3', date: '2026-01-10', payments: [{ account_id: 'account', amount: item.amount_cents / 100 }] };
    call('bills:markAsPaid', payment);
    call('bills:markAsPaid', payment);
  }
  assert.equal(count('transactions'), 4);
  assert.equal(count('bills'), 0);
  assert.equal(balance(), 900000);
  assert.equal(debt().outstanding_balance, 0);
  assert.equal(debt().installments_remaining, 0);
  assert.equal(debt().next_due_date, null);
  assert.equal(debt().status, 'quitada');
  assert.equal(agreements()[0].status, 'completed');
  assert.ok(agreements()[0].installments.every(item => item.paid_at === '2026-01-10' && item.transaction_id));
});

test('pagamento inválido reverte lançamento, saldo e baixa da parcela juntos', () => {
  const agreement = create();
  assert.throws(() => call('bills:markAsPaid', {
    id: agreement.installments[0].bill_id, category_id: 'cat-3', date: '2025-12-31',
    payments: [{ account_id: 'account', amount: 100 }],
  }), /data de pagamento/);
  assert.equal(count('transactions'), 0);
  assert.equal(count('bills'), 4);
  assert.equal(balance(), 1000000);
  assert.equal(debt().outstanding_balance, 1000);
});

test('excluir despesa reabre parcela, inclusive após quitação, e permite pagar novamente', () => {
  const agreement = create({ total_amount: 100, down_payment: 0, installments: 1 });
  call('bills:markAsPaid', { id: agreement.installments[0].bill_id, category_id: 'cat-3', date: '2026-01-10', payments: [{ account_id: 'account', amount: 100 }] });
  const tx = agreements()[0].installments[0].transaction_id!;
  assert.throws(() => call('transactions:update', { id: tx, amount: 80 }), /exclua o lançamento/);
  call('transactions:delete', tx);
  const reopened = agreements()[0];
  assert.equal(reopened.status, 'active');
  assert.equal(reopened.installments[0].paid_at, null);
  assert.equal(debt().outstanding_balance, 100);
  assert.equal(debt().status, 'renegociada');
  assert.equal(balance(), 1000000);
  assert.equal(count('transactions'), 0);
  assert.equal(count('bills'), 1);
  assert.notEqual(reopened.installments[0].bill_id, agreement.installments[0].bill_id);
  call('bills:markAsPaid', { id: reopened.installments[0].bill_id, date: '2026-01-11' });
  assert.equal(debt().status, 'quitada');
  assert.equal(balance(), 990000);
});

test('protege contrato contra alteração, duplicação e exclusão pelas telas genéricas', () => {
  const agreement = create();
  const billId = agreement.installments[0].bill_id;
  assert.throws(() => call('bills:update', { id: billId, amount: 1 }), /pertence a um acordo/);
  assert.throws(() => call('bills:delete', billId), /pertence a um acordo/);
  assert.throws(() => call('bills:duplicate', { id: billId, times: 1, interval: 'monthly' }), /pertence a um acordo/);
  assert.throws(() => call('debts:update', { id: debt().id, outstanding_balance: 1 }), /controlados pelo acordo/);
  assert.throws(() => call('debts:delete', debt().id), /histórico de acordos/);
  assert.throws(() => call('debts:createBill', debt().id), /já estão/);
  assert.equal(count('bills'), 4);
});

test('pagamento dividido preserva contas e categorias ao estornar e pagar novamente', () => {
  db.prepare("INSERT INTO accounts (id, name, type, balance, opening_balance_brl) VALUES ('wallet', 'Carteira', 'wallet', 100, 100)").run();
  const agreement = create({ total_amount: 100, down_payment: 0, installments: 1 });
  call('bills:markAsPaid', {
    id: agreement.installments[0].bill_id, date: '2026-01-10',
    payments: [{ account_id: 'account', amount: 70 }, { account_id: 'wallet', amount: 30 }],
    categories: [{ category_id: 'cat-3', amount: 40 }, { category_id: 'cat-4', amount: 60 }],
  });
  assert.equal(balance(), 993000);
  call('transactions:delete', agreements()[0].installments[0].transaction_id);
  assert.equal(balance(), 1000000);
  const billId = agreements()[0].installments[0].bill_id;
  assert.equal(count('bill_payments'), 2);
  assert.equal(count('bill_categories'), 2);
  call('bills:markAsPaid', { id: billId, date: '2026-01-11' });
  assert.equal(balance(), 993000);
  assert.equal((db.prepare("SELECT balance_cents FROM accounts WHERE id = 'wallet'").get() as { balance_cents: number }).balance_cents, 7000);
  assert.equal(debt().outstanding_balance, 0);
  assert.equal(count('transaction_categories'), 2);
});

test('cancelamento sem pagamentos restaura condições anteriores e preserva histórico', () => {
  const original = debt();
  const agreement = create();
  call('debts:cancelAgreement', agreement.id);
  call('debts:cancelAgreement', agreement.id);
  assert.equal(count('bills'), 0);
  assert.equal(agreements()[0].status, 'cancelled');
  for (const field of ['outstanding_balance', 'interest_rate', 'installments_total', 'installments_remaining', 'installment_amount', 'next_due_date', 'status'] as const) {
    assert.equal(debt()[field], original[field]);
  }
  const replacement = create();
  call('bills:markAsPaid', { id: replacement.installments[0].bill_id, category_id: 'cat-3', date: '2026-01-10', payments: [{ account_id: 'account', amount: 100 }] });
  assert.throws(() => call('debts:cancelAgreement', replacement.id), /Estorne os pagamentos/);
  assert.equal(agreements().length, 2);
  assert.equal(debt().outstanding_balance, 900);
});

test('backup incremental preserva contratos, parcelas pagas e vínculos ao restaurar', () => {
  const agreement = create();
  call('bills:markAsPaid', { id: agreement.installments[0].bill_id, category_id: 'cat-3', date: '2026-01-10', payments: [{ account_id: 'account', amount: 100 }] });
  const saved = agreements();
  const file = join(directory, 'agreements.finpatch');
  backup.exportPortableIncrementalBackup('2000-01-01', file, 'test-password');
  database.closeDatabase();
  database.openDatabase();
  database.finalizePragmas();
  db = database.getDb();
  const migrations = join(process.cwd(), 'src/main/migrations');
  for (const file of readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(join(migrations, file), 'utf8'));
  backup.importIncrementalPatch(file, 'test-password');
  backup.importIncrementalPatch(file, 'test-password');
  assert.deepEqual(agreements(), saved);
  assert.equal(debt().outstanding_balance, 900);
  assert.equal(count('bills'), 3);
  assert.equal(count('transactions'), 1);
  assert.equal(balance(), 990000);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
