# tax

Owns the statutory tax code vocabulary, effective-dated and approval-gated tax rates, and the
sales-tax computation. Read [DOMAIN.md](DOMAIN.md) before changing anything — the fail-closed rules
there (no default rate, no rate without an approval, no rounding without a configured mode) are the
ones a refactor is most likely to break by accident.