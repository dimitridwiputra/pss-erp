-- FIN-006 / MVP-OD-10: the detailed branch P&L flag is CFO-owned, independently
-- of the gross-profit-summary permission. Correct the generic Finance seed owner.
UPDATE platform.config_key
SET owner_role_code = 'CFO'
WHERE key = 'finance.branch_pnl_visible';
