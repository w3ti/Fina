import { invoke } from '../api';
import { formatCurrency, formatPercent } from '../../shared/utils';
import { runAIAction } from '../components/aiConsent';
import type { Debt, DebtAgreement } from '../../shared/types';
import { agreementStatusLabel, openDebtAgreementDetails, openDebtAgreementForm } from '../components/debtAgreementModal';
import { fromCents } from '../../shared/money';
import { td } from '../i18n';

export async function render(el: HTMLElement): Promise<void> {
  const [allDebts, agreements] = await Promise.all([
    invoke<Debt[]>('debts:list'), invoke<DebtAgreement[]>('debts:listAgreements'),
  ]);
  const debts = allDebts.filter(d => d.status !== 'quitada' && !d.agreement_id);
  const sorted = [...debts].sort((a, b) => priority(b) - priority(a));
  const total = sorted.reduce((sum, d) => sum + d.outstanding_balance, 0);
  const installments = sorted.reduce((sum, d) => sum + d.installment_amount, 0);
  const targetReduction = installments * 0.2;

  el.innerHTML = `
    ${agreements.length ? `
      <h2 style="margin-bottom:12px">Acordos registrados</h2>
      <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:24px">
        ${agreements.map(agreement => {
          const paid = agreement.installments.filter(item => item.paid_at != null).reduce((sum, item) => sum + item.amount_cents, 0);
          return `<div class="card"><div class="card-body" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div><strong>${esc(agreement.description)}</strong> · ${agreementStatusLabel(agreement.status)}
              <div style="color:var(--text-2)">${esc(td('Total negociado: {value} · Pago: {value}', [formatCurrency(fromCents(agreement.total_amount_cents)), formatCurrency(fromCents(paid))]))}</div>
            </div>
            <button class="btn btn-secondary btn-sm" data-agreement-debt="${esc(agreement.debt_id)}">Ver acordos</button>
          </div></div>`;
        }).join('')}
      </div>` : ''}
    <h2 style="margin-bottom:12px">Dívidas para negociar</h2>
    <div class="grid-3" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-label">Saldo negociável</div>
        <div class="stat-value stat-red">${formatCurrency(total)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Parcelas atuais</div>
        <div class="stat-value">${formatCurrency(installments)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Meta de redução</div>
        <div class="stat-value stat-green">${formatCurrency(targetReduction)}</div>
        <div class="stat-sub">20% das parcelas mensais</div>
      </div>
    </div>

    ${sorted.length === 0 ? `
      <div class="empty">
        <i class="ti ti-circle-check"></i>
        <div class="empty-title">Nenhuma dívida aguardando acordo</div>
      </div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:12px">
        ${sorted.map((d, index) => debtCard(d, index)).join('')}
      </div>
    `}
  `;

  el.querySelectorAll<HTMLButtonElement>('[data-agreement-debt]').forEach(button => {
    button.addEventListener('click', () => { void openDebtAgreementDetails(button.dataset.agreementDebt!, () => render(el)); });
  });
  el.querySelectorAll<HTMLButtonElement>('.btn-register-agreement').forEach(button => {
    button.addEventListener('click', () => {
      const debt = sorted[Number(button.dataset.index)];
      if (debt) openDebtAgreementForm(debt, () => render(el));
    });
  });

  el.querySelectorAll<HTMLButtonElement>('.btn-renegotiation-draft').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = sorted[Number(btn.dataset.index)];
      runAIAction({
        title: 'Rascunho de renegociação',
        consentText: 'O Fina vai enviar o tipo, o saldo devedor, a parcela, a taxa de juros e o status desta dívida (sem nome do credor nem descrição) junto com o resumo financeiro agregado, para gerar um rascunho de mensagem de negociação.',
        channel: 'ai:renegotiationDraft',
        payload: {
          type: d.type,
          outstanding_balance: d.outstanding_balance,
          installment_amount: d.installment_amount,
          interest_rate: d.interest_rate,
          status: d.status,
        },
      });
    });
  });
}

function debtCard(d: Debt, index: number): string {
  const suggestedInstallment = d.installment_amount * 0.8;
  const suggestedRate = Math.max(0, d.interest_rate * 0.75);
  const severity = d.status === 'em_atraso' || d.interest_rate >= 5 ? 'Alta' : d.interest_rate >= 2 ? 'Média' : 'Baixa';
  const color = severity === 'Alta' ? 'var(--danger)' : severity === 'Média' ? 'var(--warning)' : 'var(--accent)';
  return `
    <div class="card">
      <div class="card-body" style="display:flex;gap:14px;align-items:flex-start">
        <div style="width:32px;height:32px;border-radius:50%;background:${color}22;color:${color};display:flex;align-items:center;justify-content:center;font-weight:700">${index + 1}</div>
        <div style="flex:1">
          <div style="display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div>
              <div style="font-weight:700">${esc(d.description)}</div>
              <div style="font-size:0.78rem;color:var(--text-3)">${esc(d.creditor ?? 'Credor não informado')} · ${formatPercent(d.interest_rate, 2)}% a.m.</div>
            </div>
            <span class="badge" style="color:${color};background:${color}18">Prioridade ${severity}</span>
          </div>
          <div class="grid-3" style="margin-top:12px">
            <div>
              <div class="stat-label">Saldo</div>
              <strong>${formatCurrency(d.outstanding_balance)}</strong>
            </div>
            <div>
              <div class="stat-label">Parcela atual</div>
              <strong>${formatCurrency(d.installment_amount)}</strong>
            </div>
            <div>
              <div class="stat-label">Proposta inicial</div>
              <strong>${formatCurrency(suggestedInstallment)}/mês ou ${formatPercent(suggestedRate, 2)}% a.m.</strong>
            </div>
          </div>
          <div style="margin-top:10px;font-size:0.82rem;color:var(--text-2);line-height:1.5">
            Peça redução de juros, alongamento do prazo sem tarifas extras e desconto para quitação parcial. Use a parcela-alvo como limite de negociação.
          </div>
          <button type="button" class="btn btn-secondary btn-sm btn-renegotiation-draft" data-index="${index}" style="margin-top:12px"><i class="ti ti-sparkles"></i> Gerar rascunho com IA</button>
          <button type="button" class="btn btn-primary btn-sm btn-register-agreement" data-index="${index}" style="margin-top:12px">Registrar acordo</button>
        </div>
      </div>
    </div>
  `;
}

function priority(d: Debt): number {
  return d.outstanding_balance * 0.02 + d.installment_amount * 2 + d.interest_rate * 100 + (d.status === 'em_atraso' ? 1000 : 0);
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
