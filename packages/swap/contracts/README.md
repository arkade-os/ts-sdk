# Swap compiler comparison

These source files express the existing want-BTC and want-asset offer constraints.
The variants with `exit` add the maker-only CSV path after `fulfill` and `cancel`.
`exitSequence` is an encoded canonical BIP68 operand, not seconds; the comparison
binds it with the SDK's `timelockToSequence` helper.

Production continues to import `src/swap-want-*.program.json` and append its
optional exit leaf. These generated artifacts are comparison inputs only.

The human-written covenant inspects output 0 once, checking its witness version
and program from the same result. The source explicitly checks both properties;
the compiler emits two inspections and additional constructor-stack operations.
Deleting the version check to reduce the generated size would weaken the covenant.
The generated `fulfill` bytecode therefore differs, changing its emulator key
tweak and the complete contract address. `cancel` and `exit` leaves must remain
byte-identical, including key order and block/second lock encoding.

The test matrix covers both want directions, no exit, block and second exits,
ScriptNum amount boundaries through the unsigned 64-bit offer limit, asset group
indices 0, 1, 255, 256 and 65535, and a non-palindromic transaction ID to expose
byte-order mistakes. Comparisons retain both bytecode forms; they do not force
parity by editing the generated assembly.

The shared report adds script-byte and opcode differences. Its VM comparison
must confirm amount, asset presence and destination checks independently before
these sources could replace the production builders. Extra outputs or unrelated
assets are intentionally unconstrained by the existing covenant.
