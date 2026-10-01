import { asCents, splitCents, toExactCents } from './money';
import type { DebtAgreementInput } from './types';

export function requireAgreementDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || value < '1900-01-01' || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new Error('Informe uma data válida para o acordo.');
  }
  return value;
}

function monthlyDate(first: string, offset: number): string {
  const [year, month, day] = first.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return requireAgreementDate(date.toISOString().slice(0, 10));
}

/** Total contratado, já com juros/tarifas: nunca capitalizar esses encargos outra vez. */
export function buildAgreementSchedule(input: DebtAgreementInput): {
  totalCents: number;
  downPaymentCents: number;
  installments: { number: number; amount_cents: number; due_date: string }[];
} {
  const agreedOn = requireAgreementDate(input.agreed_on);
  let totalCents: number;
  let downPaymentCents: number;
  try {
    totalCents = toExactCents(input.total_amount);
    downPaymentCents = toExactCents(input.down_payment);
  } catch {
    throw new Error('Informe valores válidos com no máximo duas casas decimais.');
  }
  if (totalCents <= 0 || downPaymentCents < 0 || downPaymentCents > totalCents) {
    throw new Error('O total deve ser positivo e a entrada não pode superar o total do acordo.');
  }
  if (!Number.isInteger(input.installments) || input.installments < 0 || input.installments > 600) {
    throw new Error('Informe de 0 a 600 parcelas, sem contar a entrada.');
  }
  const remaining = totalCents - downPaymentCents;
  if (remaining === 0 ? input.installments !== 0 : input.installments < 1 || remaining < input.installments) {
    throw new Error('A quantidade de parcelas deve corresponder ao valor restante, com pelo menos R$ 0,01 por parcela.');
  }
  const installments: { number: number; amount_cents: number; due_date: string }[] = [];
  if (downPaymentCents > 0) {
    const due = requireAgreementDate(input.down_payment_date);
    if (due < agreedOn) throw new Error('A entrada não pode vencer antes da data do acordo.');
    installments.push({ number: 0, amount_cents: downPaymentCents, due_date: due });
  }
  if (remaining > 0) {
    const first = requireAgreementDate(input.first_due_date);
    if (first < agreedOn || (downPaymentCents > 0 && first < input.down_payment_date!)) {
      throw new Error('A primeira parcela não pode vencer antes do acordo ou da entrada.');
    }
    splitCents(asCents(remaining), input.installments).forEach((amount_cents, index) => {
      installments.push({ number: index + 1, amount_cents, due_date: monthlyDate(first, index) });
    });
  }
  return { totalCents, downPaymentCents, installments };
}
