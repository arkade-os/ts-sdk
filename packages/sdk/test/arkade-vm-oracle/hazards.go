package main

import "sort"

// The plan's §2/§3 hazard bullets that reach the VM through a public entry point.
var hazards = map[string]string{
	"2.6/fetcher-nil":                 "fetcher misses: hard ErrInvalidIndex, OP_TUNNEL soft fallback, INSPECTINPUTPACKET stack error, Execute fails closed",
	"2.7/witness-unchecked":           "witness items over 520 bytes enter the stack unchecked",
	"2.9/charge":                      "per-input compute limits: executing branches only, inside a taproot context, exact-replace limits",
	"2.9/no-65535-case":               "checkMinimalDataPush has no PUSHDATA4 case, so an executed PUSHDATA4 is never minimal",
	"2.9/order":                       "illegal and oversized pushes fail in dead branches, minimal-push only when executing",
	"2.9/post-step-limits":            "1000 elements and 128 KiB over data plus alt stack, checked after each step",
	"3.1/asbool-negative-zero":        "0x80 is false only as the last byte",
	"3.1/bignum-operands":             "arithmetic is BigNum up to 520 bytes, minimal encoding enforced",
	"3.1/bin2num-normalises":          "OP_BIN2NUM minimally encodes raw bytes; [0x80] becomes []",
	"3.1/div-mod-truncate":            "DIV/MOD truncate toward zero",
	"3.1/lshift-cap":                  "LSHIFT rejects shifts over 4160 and re-checks size; negative counts are ErrInvalidIndex",
	"3.1/mixed-width":                 "scriptNum operands beside BigNum values (NUM2BIN size, shift counts)",
	"3.1/num2bin-fixedbytes":          "NUM2BIN moves the sign bit to the last byte",
	"3.1/pushexpiry-minint64":         "scriptNum.Bytes panics on MinInt64 via OP_PUSHEXPIRY",
	"3.1/pushint-poison":              "PushInt results over 4 bytes break a later PopInt",
	"3.1/rshift-floor":                "RSHIFT rounds toward minus infinity",
	"3.1/scriptnum-operands":          "indices and selectors are 4-byte minimal scriptNums",
	"3.1/usebig":                      "useBig at CLTV/CSV/curve id: unobservable once values round-trip through stack bytes",
	"3.1/within-half-open":            "OP_WITHIN is min <= x < max",
	"3.2/alt-limits":                  "the alt stack counts toward both post-step limits",
	"3.2/depth-before-push":           "OP_DEPTH pushes the depth read before the push",
	"3.2/minimal-if":                  "IF/NOTIF require [] or [0x01]",
	"3.2/nipn-branches":               "PICK/ROLL bounds and the top, bottom and middle branches of nipN",
	"3.2/put":                         "OP_PUT overwrites in place, PutN(0) replaces the top",
	"3.2/same-slice":                  "duplicated elements are copies to a port that mutates in place",
	"3.3/aliasing":                    "splice results must not alias their source",
	"3.3/bitwise-equal-length":        "AND/OR/XOR require equal lengths",
	"3.3/cat-limit":                   "OP_CAT rejects results over 520 bytes",
	"3.3/left-right-bounds":           "LEFT/RIGHT reject n < 0 or n > len",
	"3.3/substr-no-clamp":             "SUBSTR is not clamped and its bound uses int64",
	"3.4/digest-selectors":            "OP_DIGEST selectors 1..5, keccak distinct from sha3, selector popped first",
	"3.4/sha256-midstate-framing":     "gob-framed midstate: exact length and prefix, h words free, pending count from length",
	"3.4/sha256-pop-order":            "SHA256UPDATE/FINALIZE pop data first, then state",
	"3.5/computes-not-verifies":       "OP_MERKLEBRANCHROOT pushes a root, it verifies nothing",
	"3.5/empty-proof":                 "an empty proof yields the leaf hash",
	"3.5/lexicographic":               "siblings are ordered by bytes.Compare, no direction bits",
	"3.5/metadata-tree-differs":       "asset metadata root is plain sha256, unsorted, odd leaf carried",
	"3.5/pop-order":                   "leaf_data, proof, branch_tag, leaf_tag; empty branch tag rejected",
	"3.5/proof-multiple-of-32":        "the proof is one element whose length is a multiple of 32",
	"3.5/raw-hash-mode":               "empty leaf tag means a raw 32-byte leaf",
	"3.6/2mul-2div":                   "2MUL is n+n, 2DIV truncates",
	"3.6/modulus-nonpositive":         "MODEXP rejects a zero or negative modulus",
	"3.6/negative-base":               "MODEXP normalises into [0, modulus) and accepts a negative base",
	"3.6/negative-exponent":           "MODEXP rejects a negative exponent",
	"3.6/operand-64-bytes":            "MODEXP operands are at most 64 encoded bytes, sign byte included",
	"3.6/pop-order":                   "MODEXP pops modulus, exp, base",
	"3.7/coord-bignum-encoding":       "EC coordinates are minimal LE BigNums",
	"3.7/coord-range":                 "coordinates below p, scalars below n, non-negative",
	"3.7/curves":                      "curve ids 0 secp256k1, 1 P-256, 2 bn254",
	"3.7/ecmulscalarverify":           "32-byte BE k, 33-byte compressed P, byte-compared Q, infinity rejected",
	"3.7/infinity":                    "infinity is (0,0) on all curves",
	"3.7/pairing":                     "bn254 only, 1..16 pairs, c1 before c0, pairs filled last-first",
	"3.7/pop-orders":                  "ECADD pops y2 x2 y1 x1 after the curve id",
	"3.7/tweakverify":                 "x-only P lifted even, k*G added, infinity rejected",
	"3.8/checkmultisig-disabled":      "CHECKMULTISIG(VERIFY) always fail when executed",
	"3.8/checksig-behaviour":          "pubkey popped first, empty sig pushes [], invalid sig is ErrNullFail",
	"3.8/checksigadd":                 "CHECKSIGADD pops pubkey, n, sig",
	"3.8/csfs":                        "CHECKSIGFROMSTACK: no context, raw 32-byte message, empty sig skips key parsing",
	"3.8/low-s":                       "both ECDSA schemes require low S",
	"3.8/output-masking":              "sha_outputs over the emulator packet with witness blobs dropped",
	"3.8/pubkey-schemes":              "32-byte schnorr, 0x10/0x11 + 33-byte ECDSA, anything else discouraged",
	"3.8/sighash-byte":                "64 bytes is DEFAULT, 65 needs a non-zero type, 0x80 rejected",
	"3.8/sighash-opcode":              "OP_SIGHASH validates the flag and the SINGLE output",
	"3.8/tag-arkade-tapsighash":       "the digest is tagged ArkadeTapSighash and commits to the spending leaf",
	"3.9/arkadescripthash-by-vin":     "emulator entries are found by vin, not position",
	"3.9/codesep-opcode-position":     "OP_CODESEPARATOR records the opcode position, not the byte offset",
	"3.9/ctx-gated":                   "CHECKSIG, CHECKSIGVERIFY, CHECKSIGADD, SIGHASH, CODESEPARATOR need a taproot context",
	"3.9/index-negative":              "introspection indices reject negatives with ErrInvalidIndex",
	"3.9/inspectversion-uint32":       "OP_INSPECTVERSION pushes the uint32 view of the version",
	"3.9/outpoint-internal-order":     "INSPECTINPUTOUTPOINT pushes the txid in internal order, then the vout",
	"3.9/pushscriptpubkey-sentinel":   "witness program then version, otherwise sha256(script) then -1",
	"3.9/txweight-txid-stripped":      "TXWEIGHT is stripped size times four, TXID is the stripped hash",
	"3.9/value-range":                 "satoshi values outside [0, 21e14] are ErrInvalidStackOperation",
	"3.9/value-vs-script-sources":     "INSPECTINPUTVALUE uses FetchPrevOutput, SCRIPTPUBKEY uses FetchVtxoPrevOutPkScript",
	"3.9/witnesshash-empty":           "an empty emulator witness hashes to 32 zero bytes",
	"3.10/checktime":                  "CHECKTIME pushes bool(n <= now), negative is ErrNegativeLockTime",
	"3.10/cltv":                       "CLTV peeks, same kind across 5e8, final input fails",
	"3.10/csv":                        "CSV disable bit is a NOP, version >= 2, masked comparison",
	"3.10/pushexpiry":                 "PUSHEXPIRY needs a host expiry, values unvalidated",
	"3.11/assetid-internal-order":     "asset ids compare in internal byte order",
	"3.11/count-not-bound-checked":    "IN/OUTASSETCOUNT do not bound-check the index",
	"3.11/lookup-flag":                "lookup misses collide with real hits, the flag disambiguates",
	"3.11/no-packet":                  "every asset opcode fails without an asset packet",
	"3.11/pop-orders":                 "asset opcodes pop the later operand first",
	"3.11/resolve-asset-id":           "a fresh issuance is (tx hash, position)",
	"3.11/sum-bigint":                 "INSPECTASSETGROUPSUM sums without wrapping",
	"3.11/variable-pushes":            "INSPECTASSETGROUP pushes a txid only for intent inputs",
	"3.12/emulator-packet-validation": "emulator packet rules checked by Execute before the script runs",
	"3.12/extension":                  "zero-packet and duplicate-type extensions rejected, first extension output only",
	"3.12/inspectinputpacket":         "index popped first, missing previous tx is an error",
	"3.12/inspectpacket":              "re-serialised content and a flag, malformed extension is an error",
	"3.12/intent":                     "gjson queries: path grammar, number rules, verbatim objects, explicit null reads as a miss",
	"3.12/tunnel":                     "pop order, depth guard, flag subset, assets compared exactly",
	"3.13/discouraged-nops":           "NOP1, NOP5-10 fail; only OP_NOP succeeds",
	"3.13/no-op-success":              "unknown opcodes fail, there is no OP_SUCCESS",
	"3.13/nop4-is-merkle":             "0xb3 is OP_MERKLEBRANCHROOT",
	"3.13/reenabled":                  "CAT and the other disabled-in-Bitcoin opcodes are live",
	"3.13/reserved-codes":             "reserved and invalid slots fail with ErrReservedOpcode when executed",
	"3.13/return-fails":               "OP_RETURN fails when executed; a dead branch skips it",
	"3.13/verif-dead-branch":          "VERIF/VERNOTIF fail even in a dead branch",
}

func hazardsTable(all []*Case) obj {
	used := map[string]bool{}
	for _, c := range all {
		if c.Hazard == "" {
			continue
		}
		if _, ok := hazards[c.Hazard]; !ok {
			fatal("case %s names unknown hazard %s", c.Name, c.Hazard)
		}
		used[c.Hazard] = true
	}
	ids := make([]string, 0, len(hazards))
	for id := range hazards {
		if !used[id] {
			fatal("hazard %s has no case", id)
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	list := make([]any, len(ids))
	for i, id := range ids {
		list[i] = obj{{"id", id}, {"text", hazards[id]}}
	}
	return obj{{"hazards", list}}
}
