import { invoke } from '../api';
import { openModal } from './modal';
import { showAlert, showConfirm } from './alertDialog';
import { attachMoneyMask, formatMoneyValue, moneyInputValue } from './moneyMask';
import { buildAgreementSchedule } from '../../shared/debtAgreement';
import { fromCents, toExactCents } from '../../shared/money';
import { td } from '../i18n';
import { formatCurrency, formatDate } from '../../shared/utils';
import type { Debt, DebtAgreement, DebtAgreementInput } from '../../shared/types';
import { openBillPayment } from '../pages/agenda';

const esc = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (cents: number): string => formatCurrency(fromCents(cents));
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Não foi possível salvar o acordo.';
type OnChanged = () => void | Promise<void>;

export function agreementStatusLabel(status: DebtAgreement['status']): string {
  return status === 'completed' ? 'Quitado' : status === 'cancelled' ? 'Cancelado' : 'Em andamento';
}

export function openDebtAgreementForm(debt: Debt, onChanged: OnChanged): void {
  const today = new Date().toISOString().slice(0, 10);
  let saving = false;
  const overlay = openModal({
    title: 'Registrar acordo de dívida',
    saveLabel: 'Registrar acordo',
    body: `
      <p><strong>${esc(debt.description)}</strong> · ${esc(debt.creditor ?? 'Credor não informado')}</p>
      <p style="color:var(--text-2);margin:8px 0 16px">${esc(td('Saldo antes do acordo: {value}', [formatCurrency(debt.outstanding_balance)]))}</p>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="agreement-date">Data do acordo</label>
          <input class="form-ctrl" id="agreement-date" type="date" value="${today}"></div>
        <div class="form-group"><label class="form-label" for="agreement-total">Total negociado</label>
          <input class="form-ctrl" id="agreement-total" type="text" inputmode="decimal" value="${formatMoneyValue(debt.outstanding_balance)}"></div>
      </div>
      <p style="color:var(--text-2);margin:8px 0 16px">Informe o valor total fechado, incluindo entrada, parcelas, juros e tarifas.</p>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="agreement-down">Entrada</label>
          <input class="form-ctrl" id="agreement-down" type="text" inputmode="decimal" value="${formatMoneyValue(0)}"></div>
        <div class="form-group"><label class="form-label" for="agreement-down-date">Vencimento da entrada</label>
          <input class="form-ctrl" id="agreement-down-date" type="date" value="${today}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label" for="agreement-count">Parcelas mensais (sem a entrada)</label>
          <input class="form-ctrl" id="agreement-count" type="number" min="0" max="600" step="1" value="1"></div>
        <div class="form-group"><label class="form-label" for="agreement-first">Primeira parcela</label>
          <input class="form-ctrl" id="agreement-first" type="date" value="${debt.next_due_date && debt.next_due_date >= today ? esc(debt.next_due_date) : today}"></div>
      </div>
      <p style="color:var(--text-2);margin:8px 0 16px">Para quitação à vista, use uma parcela ou informe o total como entrada e zero parcelas.</p>
      <div class="form-group"><label class="form-label" for="agreement-notes">Observações ou referência do contrato</label>
        <textarea class="form-ctrl" id="agreement-notes" maxlength="4000" rows="2"></textarea></div>
      <div id="agreement-preview" role="status" aria-live="polite" style="margin-top:16px;padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;line-height:1.6"></div>
      <p style="color:var(--text-2);margin-top:12px">A entrada e as parcelas serão adicionadas a Contas a pagar. Registre cada pagamento pelo botão Pagar.</p>`,
    onSave: async () => {
      if (saving) return false;
      const save = overlay.querySelector<HTMLButtonElement>('[data-save]')!;
      try {
        const input = readInput();
        buildAgreementSchedule(input);
        saving = true;
        save.disabled = true;
        await invoke('debts:createAgreement', input);
        await onChanged();
      } catch (error) {
        await showAlert(errorMessage(error));
        return false;
      } finally {
        saving = false;
        save.disabled = false;
      }
    },
  });
  overlay.querySelector<HTMLElement>('.modal')!.style.maxWidth = '680px';
  const field = (id: string): HTMLInputElement => overlay.querySelector<HTMLInputElement>(`#${id}`)!;
  function readInput(): DebtAgreementInput {
    return {
      debt_id: debt.id,
      agreed_on: field('agreement-date').value,
      total_amount: moneyInputValue(field('agreement-total')),
      down_payment: moneyInputValue(field('agreement-down')),
      down_payment_date: field('agreement-down-date').value || null,
      installments: field('agreement-count').value === '' ? NaN : Number(field('agreement-count').value),
      first_due_date: field('agreement-first').value || null,
      notes: overlay.querySelector<HTMLTextAreaElement>('#agreement-notes')!.value.trim() || null,
    };
  }
  function preview(): void {
    const target = overlay.querySelector<HTMLElement>('#agreement-preview')!;
    const input = readInput();
    field('agreement-down-date').disabled = input.down_payment === 0;
    field('agreement-first').disabled = input.installments === 0;
    try {
      const schedule = buildAgreementSchedule(input);
      const difference = toExactCents(debt.outstanding_balance) - schedule.totalCents;
      const payments = schedule.installments.filter(item => item.number > 0);
      const paymentRange = payments.length
        ? payments[0].amount_cents === payments[payments.length - 1].amount_cents
          ? money(payments[0].amount_cents)
          : td('De {value} a {value}', [money(payments[payments.length - 1].amount_cents), money(payments[0].amount_cents)])
        : '';
      target.innerHTML = `<strong>${difference >= 0 ? 'Desconto' : 'Acréscimo'}: ${money(Math.abs(difference))}</strong>
        <div>${esc(td('Entrada: {value}', [money(schedule.downPaymentCents)]))}</div>
        ${payments.length ? `<div>${esc(td('{value} parcela(s): {value}', [payments.length, paymentRange]))}</div>
        <div>${esc(td('Último vencimento: {value}', [formatDate(payments[payments.length - 1].due_date)]))}</div>` : ''}`;
      overlay.querySelector<HTMLButtonElement>('[data-save]')!.disabled = saving;
    } catch (error) {
      target.textContent = errorMessage(error);
      overlay.querySelector<HTMLButtonElement>('[data-save]')!.disabled = true;
    }
  }
  attachMoneyMask(field('agreement-total'));
  attachMoneyMask(field('agreement-down'));
  overlay.addEventListener('input', preview);
  preview();
}

export async function openDebtAgreementDetails(debtId: string, onChanged: OnChanged): Promise<void> {
  try {
    const agreements = await invoke<DebtAgreement[]>('debts:listAgreements', debtId);
    if (!agreements.length) { await showAlert('Nenhum acordo registrado para esta dívida.'); return; }
    const today = new Date().toISOString().slice(0, 10);
    const overlay = openModal({
      title: 'Acordos da dívida', saveLabel: 'Fechar',
      body: agreements.map(agreement => {
        const paid = agreement.installments.filter(item => item.paid_at != null).reduce((sum, item) => sum + item.amount_cents, 0);
        const difference = agreement.original_balance_cents - agreement.total_amount_cents;
        return `<section style="margin-bottom:24px">
          <h3>${esc(agreement.description)}</h3>
          <p>${esc(agreement.creditor ?? 'Credor não informado')} · ${formatDate(agreement.agreed_on)} · <strong>${agreementStatusLabel(agreement.status)}</strong></p>
          <div class="grid-3" style="margin:16px 0">
            <div><div class="stat-label">Saldo anterior</div><strong>${money(agreement.original_balance_cents)}</strong></div>
            <div><div class="stat-label">Total negociado</div><strong>${money(agreement.total_amount_cents)}</strong></div>
            <div><div class="stat-label">${difference >= 0 ? 'Desconto' : 'Acréscimo'}</div><strong>${money(Math.abs(difference))}</strong></div>
            <div><div class="stat-label">Entrada</div><strong>${money(agreement.down_payment_cents)}</strong></div>
            <div><div class="stat-label">Pago</div><strong>${money(paid)}</strong></div>
            <div><div class="stat-label">Restante</div><strong>${agreement.status === 'cancelled' ? '—' : money(agreement.total_amount_cents - paid)}</strong></div>
          </div>
          ${agreement.notes ? `<p style="white-space:pre-wrap">${esc(agreement.notes)}</p>` : ''}
          <div style="overflow:auto;max-height:320px"><table class="table">
            <thead><tr><th>Pagamento</th><th>Vencimento</th><th>Valor</th><th>Situação</th><th></th></tr></thead>
            <tbody>${agreement.installments.map(item => `<tr>
              <td>${item.number === 0 ? 'Entrada' : `${item.number}/${agreement.installments_total}`}</td>
              <td>${formatDate(item.due_date)}</td><td>${money(item.amount_cents)}</td>
              <td>${agreement.status === 'cancelled' ? 'Cancelado' : item.paid_at ? esc(td('Pago em {value}', [formatDate(item.paid_at)])) : item.due_date < today ? 'Em atraso' : 'Pendente'}</td>
              <td>${item.bill_id && agreement.status === 'active' ? `<button class="btn btn-primary btn-sm" data-agreement-pay="${esc(item.bill_id)}">Pagar</button>` : ''}</td>
            </tr>`).join('')}</tbody>
          </table></div>
          ${agreement.status === 'active' && paid === 0 ? `<button class="btn btn-secondary btn-sm" data-agreement-cancel="${esc(agreement.id)}" style="margin-top:12px">Cancelar acordo</button>` : ''}
        </section>`;
      }).join('') + '<p style="color:var(--text-2)">Para estornar um pagamento, exclua sua despesa em Lançamentos. A parcela será reaberta no acordo e em Contas a pagar.</p>',
    });
    overlay.querySelector<HTMLElement>('.modal')!.style.maxWidth = '820px';
    overlay.querySelector<HTMLElement>('[data-close]')!.remove();
    const refresh = async (): Promise<void> => {
      overlay.remove();
      await onChanged();
      await openDebtAgreementDetails(debtId, onChanged);
    };
    overlay.querySelectorAll<HTMLButtonElement>('[data-agreement-pay]').forEach(button => {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await openBillPayment(button.dataset.agreementPay!, () => { void refresh(); }); }
        catch (error) { await showAlert(errorMessage(error)); }
        finally { button.disabled = false; }
      });
    });
    overlay.querySelectorAll<HTMLButtonElement>('[data-agreement-cancel]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!await showConfirm('Cancelar este acordo e restaurar as condições anteriores da dívida? As parcelas pendentes do acordo serão removidas.', { danger: true, okLabel: 'Cancelar acordo' })) return;
        button.disabled = true;
        try { await invoke('debts:cancelAgreement', button.dataset.agreementCancel!); await refresh(); }
        catch (error) { await showAlert(errorMessage(error)); button.disabled = false; }
      });
    });
  } catch (error) {
    await showAlert(errorMessage(error));
  }
}
