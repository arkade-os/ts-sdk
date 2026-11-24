# arkade-vm-oracle

Generates every Go-derived expectation the TypeScript Arkade script VM (`src/arkade/vm`) is tested
against: the conformance vectors read by `test/arkade-vm.test.ts`, and the fixtures read by
`test/arkade-vm-ops-core.test.ts`, `-ops-sig.test.ts`, `-ops-assets.test.ts` and `-emulate.test.ts`.
Each expectation is the real emulator's answer, not a hand-written one.

## Pins

| | |
|---|---|
| emulator | `30a59c7` (image `v0.0.10`) |
| `github.com/arkade-os/emulator/pkg/arkade`, `pkg/emulator` | `v0.2.0` |
| Go toolchain | `go1.27.3`, the emulator Dockerfile's `golang:1.27.3` |

The SHA-256 midstate framing is a Go `gob` artifact, so the oracle refuses any other toolchain, and
every generated file carries the pin that `test/arkade-vm.test.ts` asserts.

## Regenerate

```sh
cd packages/sdk/test/arkade-vm-oracle
GOTOOLCHAIN=go1.27.3 go run . -out ../fixtures/arkade-vm/
```

Two runs are byte-identical. The run reads the emulator module from the Go module cache: its
`testdata` (fuzz seeds, service fixtures), and its test-only `opcodeSpecs` table, which it exports by
copying the package to a temporary directory and running `go test` there. Inputs kept here:
`testdata/ops-core-cases.txt` (a token DSL, documented in its first line) and
`testdata/executor-v1-af8d9eb.json`, refreshed from the executor's template vectors with
`GOTOOLCHAIN=go1.27.3 go run . -extract-executor ../fixtures/template-v1`.

## CI

CI runs only the TypeScript side against the committed fixtures; it needs no Go toolchain.
Regenerate and commit the fixtures whenever a pin moves.
