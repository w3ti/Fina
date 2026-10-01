-- Valores de acordos nascem em centavos, sem colunas monetárias legadas.
CREATE TABLE debt_agreements (
  id TEXT PRIMARY KEY,
  debt_id TEXT NOT NULL REFERENCES debts(id) ON DELETE RESTRICT,
  agreed_on TEXT NOT NULL,
  original_balance_cents INTEGER NOT NULL CHECK (typeof(original_balance_cents) = 'integer' AND original_balance_cents BETWEEN 1 AND 9007199254740991),
  total_amount_cents INTEGER NOT NULL CHECK (typeof(total_amount_cents) = 'integer' AND total_amount_cents BETWEEN 1 AND 9007199254740991),
  down_payment_cents INTEGER NOT NULL CHECK (typeof(down_payment_cents) = 'integer' AND down_payment_cents BETWEEN 0 AND total_amount_cents),
  installments_total INTEGER NOT NULL CHECK (typeof(installments_total) = 'integer' AND installments_total BETWEEN 0 AND 600),
  previous_terms TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_debt_agreement_current ON debt_agreements(debt_id) WHERE status != 'cancelled';

CREATE TABLE debt_agreement_installments (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL REFERENCES debt_agreements(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK (typeof(number) = 'integer' AND number BETWEEN 0 AND 600),
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 9007199254740991),
  due_date TEXT NOT NULL,
  bill_id TEXT UNIQUE REFERENCES bills(id) ON DELETE SET NULL,
  transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agreement_id, number),
  CHECK ((transaction_id IS NULL AND paid_at IS NULL) OR (transaction_id IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE TRIGGER incremental_tombstone_debt_agreements
AFTER DELETE ON debt_agreements BEGIN
  INSERT OR REPLACE INTO incremental_tombstones (id, table_name, row_id, deleted_at)
  VALUES (lower(hex(randomblob(16))), 'debt_agreements', OLD.id, datetime('now'));
END;
CREATE TRIGGER incremental_tombstone_debt_agreement_installments
AFTER DELETE ON debt_agreement_installments BEGIN
  INSERT OR REPLACE INTO incremental_tombstones (id, table_name, row_id, deleted_at)
  VALUES (lower(hex(randomblob(16))), 'debt_agreement_installments', OLD.id, datetime('now'));
END;
