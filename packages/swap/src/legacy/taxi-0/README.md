# Frozen Taxi offer recovery

These sources and compiler artifacts are copied byte-for-byte from
`packages/swap/contracts` at `37aa317a08750dd39b5a9f639f4d0452d46655fa`, the sealed
unpublished `@arkade-os/swap@0.2.0-taxi.0` candidate. Its archive SHA-256 is
`faa05b0abb38570bebf603e2c79f94c2fb3c2d8087e43d59d11b4790d9e0f7da`.

This tree is distinct from both published `asset-swap-v2` and `asset-swap-v3`.
It is a reader-only fallback selected by an existing offer's exact script. It is
not a negotiated version, a new-offer default, or a replacement funding target.
Keep these artifacts unchanged so persisted offers retain their original address,
fulfill, cancel and optional exit scripts.
