# Swap contracts

`asset-swap.ark` and `sats-swap.ark` (v3) let anyone complete a funded deposit through `fulfill`.
`asset-swap-v4.ark` and `sats-swap-v4.ark` are the directed versions: only `taker`, the key of the
solver that quoted the swap, can. Each adds `taker` to its v3 constructor, and a `fulfill`
tapscript that replaces the leaf the compiler would otherwise synthesize for `fulfill`.

## 1. The coin the person sends

```mermaid
flowchart LR
  user["user<br/>the maker"] --> fund["fund<br/>a send to the v4 address"]
  fund --> deposit["deposit<br/>carrier 330<br/>pot above it<br/>SatsSwap: plus the asset sold"]
```

The deposit is the coin the swap tracks. `fulfill` never inspects it.

## 2. The direct send

```mermaid
flowchart LR
  sender["anyone"] --> sent["direct send<br/>to the same v4 address"]
  sent --> second["second coin<br/>same address<br/>not the deposit"]
  deposit["the deposit"] --> spend["fulfill or cancel"]
  spend --> position["the deposit is spent<br/>the swap moves"]
```

A direct send creates a second coin beside the deposit. Only a spend of the deposit moves the swap.

## 3. The rejected transaction

```mermaid
flowchart TB
  subgraph accepted["accepted: the taker fills"]
    direction LR
    d1["input 0: deposit"] --> f1["fulfill<br/>takerSig, serverSig, emulatorSig"]
    t1["inputs 1..n: taker's coins"] --> f1
    f1 --> r1["output 0: receiver<br/>AssetSwap: asset ≥ amount<br/>SatsSwap: value ≥ amount"]
    f1 --> c1["taker's change<br/>unconstrained"]
  end
  subgraph rejected["rejected: a stranger fills"]
    direction LR
    d2["input 0: deposit"] --> f2["fulfill: REJECTED<br/>checkMultisig([taker, server, emulator], …)<br/>no takerSig"]
    s2["inputs 1..n: stranger's coins"] --> f2
    f2 --> r2["output 0: receiver<br/>the same payment"]
    f2 --> c2["stranger's change<br/>unconstrained"]
  end
  accepted ~~~ rejected
```

The stranger pays the receiver exactly as the taker does, so the covenant passes. The spend fails
only on the leaf's missing `takerSig`.

## 4. Who signs

```mermaid
flowchart LR
  subgraph signs["who signs"]
    fk["fulfill<br/>taker + server + emulator:fulfill"]
    ck["cancel<br/>user + server"]
  end
  subgraph builds["who can build"]
    v3["v3 fulfill<br/>server + emulator:fulfill<br/>anyone whose transaction passes the require"]
    v4["v4 fulfill<br/>only the holder of taker"]
  end
  signs ~~~ builds
```

A `require` is not authorization: it checks the transaction, not who may move the coins.

**Enforced:** output *i*, at the deposit's input index, pays the v1 program `receiver` at least
`amount` (units of `assetTxid`/`assetGroupIndex`, or sats); `fulfill` needs `taker`, the Arkade
Service and the `fulfill`-tweaked emulator; `cancel` needs `user` and the Arkade Service.

**Not claimed:** the quote's price, the solver's liveness (`cancel`, and the `exit` leaf that
`withExitClosure` appends, return the deposit without it), any output other than *i*, and partial
fills, which are unspecified for the directed versions.
