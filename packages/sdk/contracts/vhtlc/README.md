# VHTLC compiler comparisons

These sources and artifacts are comparison candidates. The production SDK still uses `src/script/vhtlc.ts`; no runtime import or covenant address changes here.

`signatures-v1.ark` describes the six signature spending paths. `payout-btc-v1.ark` and `payout-asset-v1.ark` describe the three noninteractive paths. The delayed refund explicitly tweaks the emulator to the ordinary refund covenant, preserving the shared sender destination and co-signer. The fixture assembles leaves in the production order, and selects eight instead of nine for the historical `preTimelockedRefund` profile. It does not rewrite generated artifacts.

Both payout contracts require the output at the active input index to have witness version 1, the committed 32-byte destination program, and at least the input's sats. The asset contract additionally requires both asset lookups to succeed, at least the input's bound asset quantity, and exactly one asset on the output. `assetWireTxid` is the canonical asset txid reversed once by the fixture, matching the existing implementation's opcode wire order. Extra input assets remain outside this single-asset guarantee, just as in production.

The compiler emits different payout bytecode from the optimized handwritten covenant. This changes the emulator's tweaked key, its associated tapleaves and the committed address. Semantic VM comparisons are required; compiler output cannot replace a funded contract by editing its source.

## V2 is not adoptable with the pinned compiler

The `*-v2-candidate.ark` files declare `bytes32 preimage`. The pinned compiler records that type in the witness ABI but emits no `OP_SIZE 32 OP_EQUALVERIFY` in its tapscript hashlock. The production V2 leaves enforce this guard. An ABI type is not a consensus check.

The comparison suite binds `HASH160` to actual 31-byte and 33-byte preimages. The production V2 hashlock rejects those witnesses; generated candidate hashlocks accept them. Production V1 accepts those witnesses by design. These are distinct profiles, not interchangeable versions. A compiler change and new pin are needed before V2 can migrate faithfully.

The fixtures export raw manual/generated leaf and covenant bytes, independent signing secrets for each tweaked emulator key, and transaction context for the Go VM differential runner. They cover four CLTV/CSV boundary profiles, BTC and asset denominations, four independent key sets, full and legacy leaf inventories, and both compiler optimization modes. The TypeScript hashlock helper executes only the condition prefix; full signature, timelock and introspection evidence comes from the Go VM runner.
