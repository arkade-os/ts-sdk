# TODOS

## VTXO Verification

- [ ] **Exit-path-only verification mode**: Consider adding `verifyFullTree: boolean` option (default: true per assignment spec). Exit-path-only verification (leaf → root only) is cheaper and sufficient for individual VTXO safety. Discuss with mentor whether full DAG is necessary. Can be retrofitted after Tier 1 without breaking changes. Added 2026-03-29.
