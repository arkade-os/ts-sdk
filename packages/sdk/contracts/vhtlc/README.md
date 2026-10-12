# VHTLC compiler comparisons

These sources and artifacts are comparison candidates. The production SDK still uses `src/script/vhtlc.ts`; no runtime import or covenant address changes here.

`signatures-v1.ark` describes the six signature spending paths. `payout-btc-v1.ark` and `payout-asset-v1.ark` describe the three noninteractive paths. The delayed refund explicitly tweaks the emulator to the ordinary refund covenant, preserving the shared sender destination and co-signer. The fixture assembles leaves in the production order, and selects eight instead of nine for the historical `preTimelockedRefund` profile. It does not rewrite generated artifacts.

Both payout contracts require the output at the active input index to have witness version 1, the committed 32-byte destination program, and at least the input's sats. The asset contract additionally requires both asset lookups to succeed, at least the input's bound asset quantity, and exactly one asset on the output. `assetWireTxid` is the canonical asset txid reversed once by the fixture, matching the existing implementation's opcode wire order. Extra input assets remain outside this single-asset guarantee, just as in production.

The compiler emits different payout bytecode from the optimized handwritten covenant. This changes the emulator's tweaked key, its associated tapleaves and the committed address. Semantic VM comparisons are required; compiler output cannot replace a funded contract by editing its source.

## V2 fixed-width hashlock

The `*-v2-candidate.ark` files declare `bytes32 preimage`. The compiler pin includes [compiler draft #172](https://github.com/arkade-os/compiler/pull/172), which emits `OP_SIZE 32 OP_EQUALVERIFY` before hashing. The original pin recorded only the witness ABI type and emitted no runtime guard; the comparison exposed and reproduced that bug before the fix.

The comparison suite binds `HASH160` to actual 31-byte and 33-byte preimages. Production V2 and generated candidate hashlocks must both reject those witnesses. Both V1 implementations accept them by design. These profiles remain distinct. The compiler dependency is still a draft and generated payouts commit to different addresses, so the candidates remain comparison inputs rather than runtime replacements.

The fixtures export raw manual/generated leaf and covenant bytes, independent signing secrets for each tweaked emulator key, and transaction context for the Go VM differential runner. They cover four CLTV/CSV boundary profiles, BTC and asset denominations, four independent key sets, full and legacy leaf inventories, and both compiler optimization modes. The TypeScript hashlock helper executes only the condition prefix; full signature, timelock and introspection evidence comes from the Go VM runner.
