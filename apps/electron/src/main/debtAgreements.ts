import type Database from 'better-sqlite3-multiple-ciphers';
import { randomUUID } from 'node:crypto';
import { buildAgreementSchedule, requireAgreementDate } from '../shared/debtAgreement';
import { fromCents } from '../shared/money';
import type { Debt, DebtAgreement, DebtAgreementInput, DebtAgreementInstallment } from '../shared/types';
import { requireRecord, requireString } from './ipcValidation';

type Db = Database.Database;

export function listDebtAgreements(db: Db, debtId?: string): DebtAgreement[] {
  const rows = db.prepare(`
    SELECT agreement.id, agreement.debt_id, agreement.agreed_on, agreement.original_balance_cents, agreement.total_amount_cents,
      agreement.down_payment_cents, agreement.installments_total, agreement.notes, agreement.status, d.description, d.creditor
    FROM debt_agreements agreement JOIN debts d ON d.id = agreement.debt_id
    ${debtId ? 'WHERE agreement.debt_id = ?' : ''}
    ORDER BY agreement.created_at DESC, agreement.rowid DESC
  `).all(...(debtId ? [debtId] : [])) as Omit<DebtAgreement, 'installments'>[];
  const installments = db.prepare('SELECT * FROM debt_agreement_installments WHERE agreement_id = ? ORDER BY number');
  return rows.map(row => ({ ...row, installments: installments.all(row.id) as DebtAgreementInstallment[] }));
}

export function currentDebtAgreement(db: Db, debtId: string): { id: string } | undefined {
  return db.prepare("SELECT id FROM debt_agreements WHERE debt_id = ? AND status != 'cancelled'")
    .get(debtId) as { id: string } | undefined;
}

function installmentDescription(description: string, number: number, total: number): string {
  return `${description} — acordo: ${number === 0 ? 'entrada' : `parcela ${number}/${total}`}`;
}

function createInstallmentBill(db: Db, description: string, amount: number, due: string, accountId: string | null = null, categoryId: string | null = null): string {
  const id = randomUUID();
  db.prepare(`INSERT INTO bills (id, description, amount, amount_cents, due_date, status, recurring, account_id, category_id)
    VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`)
    .run(id, description, fromCents(amount), amount, due, accountId, categoryId);
  return id;
}

function refreshAgreementBalance(db: Db, agreementId: string): void {
  const agreement = db.prepare('SELECT debt_id FROM debt_agreements WHERE id = ?').get(agreementId) as { debt_id: string };
  const pending = db.prepare(`SELECT number, amount_cents, due_date FROM debt_agreement_installments
    WHERE agreement_id = ? AND paid_at IS NULL ORDER BY due_date, number`).all(agreementId) as { number: number; amount_cents: number; due_date: string }[];
  const balance = pending.reduce((sum, item) => sum + item.amount_cents, 0);
  const installment = pending.find(item => item.number > 0) ?? pending[0];
  db.prepare(`UPDATE debt_agreements SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(pending.length ? 'active' : 'completed', agreementId);
  db.prepare(`UPDATE debts SET outstanding_balance_cents = ?, installments_remaining = ?,
    installment_amount_cents = ?, next_due_date = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(balance, pending.length, installment?.amount_cents ?? 0, pending[0]?.due_date ?? null,
      pending.length ? 'renegociada' : 'quitada', agreement.debt_id);
}

export function createDebtAgreement(db: Db, value: unknown): DebtAgreement {
  const payload = requireRecord(value);
  const debtId = requireString(payload.debt_id);
  const notes = payload.notes == null ? null : requireString(payload.notes, { allowEmpty: true, maxLength: 4000 }).trim() || null;
  const input = { ...payload, debt_id: debtId, notes } as unknown as DebtAgreementInput;
  const schedule = buildAgreementSchedule(input);
  return db.transaction(() => {
    const debt = db.prepare('SELECT * FROM debts WHERE id = ?').get(debtId) as (Debt & { outstanding_balance_cents: number }) | undefined;
    if (!debt || debt.status === 'quitada' || debt.outstanding_balance_cents <= 0) throw new Error('Selecione uma dívida ativa com saldo devedor.');
    if (currentDebtAgreement(db, debtId)) throw new Error('Esta dívida já possui um acordo registrado.');
    const id = randomUUID();
    db.prepare(`INSERT INTO debt_agreements
      (id, debt_id, agreed_on, original_balance_cents, total_amount_cents, down_payment_cents, installments_total, previous_terms, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, debtId, input.agreed_on, debt.outstanding_balance_cents, schedule.totalCents,
        schedule.downPaymentCents, input.installments, JSON.stringify(debt), notes);
    const insert = db.prepare(`INSERT INTO debt_agreement_installments
      (id, agreement_id, number, amount_cents, due_date, bill_id) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const item of schedule.installments) {
      const billId = createInstallmentBill(db, installmentDescription(debt.description, item.number, input.installments), item.amount_cents, item.due_date);
      insert.run(randomUUID(), id, item.number, item.amount_cents, item.due_date, billId);
    }
    // O total já inclui encargos contratados. Preserva valor original e termos anteriores no histórico.
    db.prepare("UPDATE debts SET interest_rate = 0, installments_total = ? WHERE id = ?")
      .run(schedule.installments.length, debtId);
    refreshAgreementBalance(db, id);
    return listDebtAgreements(db, debtId).find(item => item.id === id)!;
  })();
}

export function cancelDebtAgreement(db: Db, id: string): void {
  requireString(id);
  db.transaction(() => {
    const agreement = db.prepare('SELECT * FROM debt_agreements WHERE id = ?').get(id) as {
      debt_id: string; status: string; previous_terms: string;
    } | undefined;
    if (!agreement) throw new Error('Acordo não encontrado.');
    if (agreement.status === 'cancelled') return;
    const items = db.prepare('SELECT * FROM debt_agreement_installments WHERE agreement_id = ?').all(id) as DebtAgreementInstallment[];
    if (items.some(item => item.paid_at != null)) throw new Error('Estorne os pagamentos do acordo antes de cancelá-lo.');
    for (const item of items) {
      db.prepare("UPDATE debt_agreement_installments SET bill_id = NULL, updated_at = datetime('now') WHERE id = ?").run(item.id);
      if (item.bill_id) db.prepare('DELETE FROM bills WHERE id = ?').run(item.bill_id);
    }
    const previous = JSON.parse(agreement.previous_terms) as Debt & { outstanding_balance_cents: number; installment_amount_cents: number };
    db.prepare(`UPDATE debts SET outstanding_balance_cents = ?, interest_rate = ?, installments_total = ?,
      installments_remaining = ?, installment_amount_cents = ?, next_due_date = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(previous.outstanding_balance_cents, previous.interest_rate, previous.installments_total, previous.installments_remaining,
        previous.installment_amount_cents, previous.next_due_date, previous.status, agreement.debt_id);
    db.prepare("UPDATE debt_agreements SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(id);
  })();
}

export function agreementInstallmentForBill(db: Db, billId: string): DebtAgreementInstallment | undefined {
  return db.prepare('SELECT * FROM debt_agreement_installments WHERE bill_id = ?').get(billId) as DebtAgreementInstallment | undefined;
}

export function assertAgreementBillEditable(db: Db, billId: string): void {
  if (agreementInstallmentForBill(db, billId)) {
    throw new Error('Esta parcela pertence a um acordo. Use Pagar para baixá-la ou consulte o acordo em Dívidas.');
  }
}

/** Chamado dentro da mesma transação que gera a despesa e remove a conta a pagar. */
export function recordAgreementPayment(db: Db, billId: string, transactionId: string, date: string): void {
  const item = agreementInstallmentForBill(db, billId);
  if (!item) return;
  requireAgreementDate(date);
  const agreement = db.prepare('SELECT agreed_on, status FROM debt_agreements WHERE id = ?').get(item.agreement_id) as { agreed_on: string; status: string };
  if (agreement.status !== 'active' || date < agreement.agreed_on || date > new Date().toISOString().slice(0, 10)) {
    throw new Error('Informe uma data de pagamento entre a data do acordo e hoje.');
  }
  const tx = db.prepare('SELECT amount_cents, type, status FROM transactions WHERE id = ?').get(transactionId) as {
    amount_cents: number; type: string; status: string;
  } | undefined;
  if (!tx || tx.amount_cents !== item.amount_cents || tx.type !== 'expense' || tx.status !== 'confirmed') {
    throw new Error('O pagamento deve corresponder ao valor contratado da parcela.');
  }
  db.prepare(`UPDATE debt_agreement_installments SET bill_id = NULL, transaction_id = ?, paid_at = ?,
    updated_at = datetime('now') WHERE id = ?`).run(transactionId, date, item.id);
  refreshAgreementBalance(db, item.agreement_id);
}

export function assertAgreementTransactionEditable(db: Db, transactionId: string): void {
  if (db.prepare('SELECT 1 FROM debt_agreement_installments WHERE transaction_id = ?').get(transactionId)) {
    throw new Error('Para corrigir este pagamento, exclua o lançamento. A parcela do acordo será reaberta automaticamente.');
  }
}

/** A exclusão da despesa estorna também a baixa da parcela, sem perder o contrato. */
export function reopenAgreementPayment(db: Db, transactionId: string): void {
  const item = db.prepare(`SELECT i.*, a.installments_total, d.description, t.account_id, t.category_id
    FROM debt_agreement_installments i JOIN debt_agreements a ON a.id = i.agreement_id
    JOIN debts d ON d.id = a.debt_id JOIN transactions t ON t.id = i.transaction_id
    WHERE i.transaction_id = ?`).get(transactionId) as (DebtAgreementInstallment & {
      installments_total: number; description: string; account_id: string; category_id: string;
    }) | undefined;
  if (!item) return;
  const billId = createInstallmentBill(db, installmentDescription(item.description, item.number, item.installments_total),
    item.amount_cents, item.due_date, item.account_id, item.category_id);
  db.prepare(`INSERT INTO bill_payments (id, bill_id, account_id, amount, amount_cents, is_pix)
    SELECT lower(hex(randomblob(16))), ?, account_id, amount, amount_cents, is_pix FROM transaction_payments WHERE transaction_id = ?`)
    .run(billId, transactionId);
  db.prepare(`INSERT INTO bill_categories (id, bill_id, category_id, amount, amount_cents)
    SELECT lower(hex(randomblob(16))), ?, category_id, amount, amount_cents FROM transaction_categories WHERE transaction_id = ?`)
    .run(billId, transactionId);
  db.prepare(`UPDATE debt_agreement_installments SET bill_id = ?, transaction_id = NULL, paid_at = NULL,
    updated_at = datetime('now') WHERE id = ?`).run(billId, item.id);
  refreshAgreementBalance(db, item.agreement_id);
}
