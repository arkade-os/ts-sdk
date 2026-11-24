package main

import (
	"encoding/hex"
	"math/big"

	. "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/wire/v2"
)

// o turns opcode constants into script bytes; a bare int in sc is a number push.
func o(ops ...int) raw {
	out := make(raw, len(ops))
	for i, op := range ops {
		out[i] = byte(op)
	}
	return out
}

func coreHand() []*Case {
	b := &book{}
	coverageCases(b, "core")
	// §3.2 stack
	for n := 0; n <= 3; n++ {
		b.ex("core/OP_ROLL/index-"+itoa(n), OP_ROLL, "3.2/nipn-branches", sc([]byte{1}, []byte{2}, []byte{3}, []byte{4}, n, o(OP_ROLL)))
	}
	b.ex("core/OP_ROLL/index-out-of-range", OP_ROLL, "3.2/nipn-branches", sc([]byte{1}, []byte{2}, 2, o(OP_ROLL)))
	b.ex("core/OP_ROLL/negative-index", OP_ROLL, "3.2/nipn-branches", sc([]byte{1}, -1, o(OP_ROLL)))
	b.ex("core/OP_PICK/five-byte-index", OP_PICK, "3.1/scriptnum-operands", sc([]byte{1}, n64(1<<32), o(OP_PICK)))
	b.ex("core/OP_PICK/non-minimal-index", OP_PICK, "3.1/scriptnum-operands", sc([]byte{1}, []byte{0, 0}, o(OP_PICK)))
	b.ex("core/OP_PUT/replaces-top-at-0", OP_PUT, "3.2/put", sc([]byte{1}, []byte{2}, []byte{9}, 0, o(OP_PUT)))
	b.ex("core/OP_PUT/replaces-deep", OP_PUT, "3.2/put", sc([]byte{1}, []byte{2}, []byte{3}, []byte{9}, 2, o(OP_PUT)))
	b.ex("core/OP_PUT/index-beyond-depth", OP_PUT, "3.2/put", sc([]byte{1}, []byte{9}, 1, o(OP_PUT)))
	b.ex("core/OP_DUP/copy-not-alias", OP_DUP, "3.2/same-slice", sc([]byte{1, 0xff}, o(OP_DUP, OP_INVERT)))
	b.ex("core/OP_IFDUP/copy-not-alias", OP_IFDUP, "3.2/same-slice", sc([]byte{0x0f, 0xf0}, o(OP_IFDUP, OP_INVERT)))
	b.ex("core/OP_2OVER/copy-not-alias", OP_2OVER, "3.2/same-slice", sc([]byte{1}, []byte{2}, []byte{3}, []byte{4}, o(OP_2OVER, OP_INVERT, OP_SWAP, OP_INVERT)))
	b.ex("core/OP_DEPTH/reads-before-push", OP_DEPTH, "3.2/depth-before-push", sc([]byte{7}, []byte{8}, o(OP_DEPTH)))
	b.ex("core/OP_DEPTH/empty", OP_DEPTH, "3.2/depth-before-push", sc(o(OP_DEPTH)))
	for _, top := range [][]byte{{}, {1}, {2}, {1, 0}, {0}, {0x80}} {
		b.ex("core/OP_IF/minimal-if-"+hexs(top), OP_IF, "3.2/minimal-if", sc(top, o(OP_IF, OP_2, OP_ELSE, OP_3, OP_ENDIF)))
		b.ex("core/OP_NOTIF/minimal-if-"+hexs(top), OP_NOTIF, "3.2/minimal-if", sc(top, o(OP_NOTIF, OP_2, OP_ELSE, OP_3, OP_ENDIF)))
	}
	b.ex("core/OP_ELSE/flips-branch", OP_ELSE, "", sc(o(OP_0, OP_IF, OP_2, OP_ELSE, OP_3, OP_ENDIF)))
	b.ex("core/OP_ELSE/unmatched", OP_ELSE, "", sc(o(OP_1, OP_ELSE)))
	b.ex("core/OP_ELSE/twice", OP_ELSE, "", sc(o(OP_1, OP_IF, OP_2, OP_ELSE, OP_3, OP_ELSE, OP_4, OP_ENDIF)))
	b.ex("core/OP_ENDIF/nested-dead", OP_ENDIF, "", sc(o(OP_0, OP_IF, OP_1, OP_IF, OP_RETURN, OP_ENDIF, OP_ENDIF, OP_5)))
	b.ex("core/OP_ENDIF/unmatched", OP_ENDIF, "", sc(o(OP_1, OP_ENDIF)))
	b.ex("core/OP_IF/unbalanced-at-end", OP_IF, "", sc(o(OP_1, OP_IF, OP_1)))
	b.ex("core/OP_TOALTSTACK/alt-counts-toward-limit", OP_TOALTSTACK, "3.2/alt-limits",
		sc(fill(999), o(OP_TOALTSTACK, OP_1, OP_1)))
	b.ex("core/OP_FROMALTSTACK/empty-alt", OP_FROMALTSTACK, "", sc(o(OP_FROMALTSTACK)))
	// §2.9 ordering: illegal and oversized even when dead, minimal push only when executing
	b.ex("core/OP_VERIF/illegal-in-dead-branch", OP_VERIF, "3.13/verif-dead-branch", sc(o(OP_0, OP_IF, OP_VERIF, OP_ENDIF, OP_1)))
	b.ex("core/OP_VERNOTIF/illegal-in-dead-branch", OP_VERNOTIF, "3.13/verif-dead-branch", sc(o(OP_0, OP_IF, OP_VERNOTIF, OP_ENDIF, OP_1)))
	b.ex("core/OP_RESERVED/ok-in-dead-branch", OP_RESERVED, "3.13/reserved-codes", sc(o(OP_0, OP_IF, OP_RESERVED, OP_ENDIF, OP_1)))
	b.ex("core/OP_PUSHDATA2/oversize-in-dead-branch", OP_PUSHDATA2, "2.9/order",
		sc(o(OP_0, OP_IF), raw{OP_PUSHDATA2, 0x09, 0x02}, raw(rep(1, 521)), o(OP_ENDIF, OP_1)))
	b.ex("core/OP_PUSHDATA1/non-minimal-in-dead-branch", OP_PUSHDATA1, "2.9/order",
		sc(o(OP_0, OP_IF), raw{OP_PUSHDATA1, 1, 5}, o(OP_ENDIF, OP_1)))
	b.ex("core/OP_DATA_1/non-minimal-small-int", OP_DATA_1, "2.9/order", sc(raw{OP_DATA_1, 5}))
	b.ex("core/OP_DATA_1/minimal-zero-byte", OP_DATA_1, "2.9/order", sc(raw{OP_DATA_1, 0}))
	b.ex("core/OP_DATA_1/non-minimal-negative-one", OP_DATA_1, "2.9/order", sc(raw{OP_DATA_1, 0x81}))
	b.ex("core/OP_PUSHDATA2/256-bytes", OP_PUSHDATA2, "", sc(raw{OP_PUSHDATA2, 0, 1}, raw(rep(3, 256)), o(OP_SIZE)))
	b.ex("core/OP_PUSHDATA2/255-bytes-not-minimal", OP_PUSHDATA2, "", sc(raw{OP_PUSHDATA2, 255, 0}, raw(rep(3, 255))))
	b.ex("core/tokenizer/truncated-pushdata4-length", OP_PUSHDATA4, "", sc(raw{OP_PUSHDATA4, 1, 0}))
	b.ex("core/tokenizer/pushdata4-negative-length", OP_PUSHDATA4, "", sc(raw{OP_PUSHDATA4, 0xff, 0xff, 0xff, 0xff}))
	b.ex("core/tokenizer/truncated-data", OP_DATA_5, "", sc(raw{OP_DATA_5, 1, 2}))
	b.ex("core/engine/script-too-big", "", "", sc(raw(rep(OP_NOP, 10001))))
	b.ex("core/engine/script-at-limit", "", "", sc(raw(rep(OP_NOP, 9999)), o(OP_1)))
	b.ex("core/engine/empty-script", "", "", nil)
	b.ex("core/engine/stack-bytes-at-limit", "", "2.9/post-step-limits", stackBytes(32))
	b.ex("core/engine/stack-bytes-over-limit", OP_DATA_33, "2.9/post-step-limits", stackBytes(33))
	b.ex("core/engine/alt-bytes-count-toward-limit", OP_DATA_33, "3.2/alt-limits",
		sc(raw(stackBytes(0)), o(OP_DROP, OP_TOALTSTACK), rep(5, 33)))
	b.ex("core/engine/scriptsig-runs-first", "", "", sc(o(OP_ADD)), inW(txWith("scriptsig-push", func(tx *wire.MsgTx) {
		tx.TxIn[0].SignatureScript = sc(2, 3)
	})))
	b.ex("core/engine/scriptsig-not-push-only", "", "", sc(o(OP_1)), inW(txWith("scriptsig-nop", func(tx *wire.MsgTx) {
		tx.TxIn[0].SignatureScript = sc(o(OP_NOP))
	})))
	b.ex("core/engine/input-index-out-of-range", "", "", sc(o(OP_1)), at(5, 0))
	// §3.13
	b.ex("core/OP_NOP/succeeds", OP_NOP, "3.13/discouraged-nops", sc(o(OP_NOP, OP_1)))
	for _, op := range []int{OP_NOP1, OP_NOP5, OP_NOP10} {
		b.ex("core/"+slots[op].name+"/discouraged", op, "3.13/discouraged-nops", sc(o(op, OP_1)))
	}
	b.ex("core/OP_NOP4/is-merklebranchroot", OP_MERKLEBRANCHROOT, "3.13/nop4-is-merkle", sc(o(OP_MERKLEBRANCHROOT)))
	b.ex("core/OP_RETURN/always-fails", OP_RETURN, "3.13/return-fails", sc(o(OP_RETURN), []byte{1, 2}))
	b.ex("core/OP_UNKNOWN192/fails", OP_UNKNOWN192, "3.13/no-op-success", sc(o(OP_UNKNOWN192)))
	b.ex("core/OP_INVALIDOPCODE/fails", OP_INVALIDOPCODE, "3.13/reserved-codes", sc(o(OP_INVALIDOPCODE)))
	b.ex("core/OP_CAT/re-enabled", OP_CAT, "3.13/reenabled", sc([]byte{1}, []byte{2}, o(OP_CAT)))
	b.ex("core/OP_EQUAL/raw-bytes-not-numbers", OP_EQUAL, "", sc([]byte{}, []byte{0}, o(OP_EQUAL)))
	b.ex("core/OP_EQUALVERIFY/fails", OP_EQUALVERIFY, "", sc([]byte{1}, []byte{2}, o(OP_EQUALVERIFY)))
	b.ex("core/OP_VERIFY/negative-zero-false", OP_VERIFY, "3.1/asbool-negative-zero", sc([]byte{0, 0x80}, o(OP_VERIFY)))
	b.ex("core/OP_VERIFY/negative-zero-not-last", OP_VERIFY, "3.1/asbool-negative-zero", sc([]byte{0x80, 0}, o(OP_VERIFY, OP_1)))
	return b.cases
}

func stackBytes(extra int) []byte {
	return sc(raw(push(rep(1, 520))), raw(rep(OP_DUP, 251)), raw(push(rep(2, extra))))
}

func spliceHand() []*Case {
	b := &book{}
	b.ex("splice/OP_CAT/at-limit", OP_CAT, "3.3/cat-limit", sc(rep(1, 260), rep(2, 260), o(OP_CAT, OP_SIZE)))
	b.ex("splice/OP_CAT/exceeds-element-limit", OP_CAT, "3.3/cat-limit", sc(rep(1, 260), rep(2, 261), o(OP_CAT)))
	b.ex("splice/OP_CAT/pop-order", OP_CAT, "3.3/cat-limit", sc([]byte{0xaa}, []byte{0xbb}, o(OP_CAT)))
	sub := func(name, hz string, x []byte, begin, size any) {
		b.ex("splice/OP_SUBSTR/"+name, OP_SUBSTR, hz, sc(x, begin, size, o(OP_SUBSTR)))
	}
	sub("middle", "3.3/substr-no-clamp", []byte{1, 2, 3, 4}, 1, 2)
	sub("to-end", "3.3/substr-no-clamp", []byte{1, 2, 3, 4}, 2, 2)
	sub("past-end", "3.3/substr-no-clamp", []byte{1, 2, 3, 4}, 3, 2)
	sub("negative-begin", "3.3/substr-no-clamp", []byte{1, 2}, -1, 1)
	sub("negative-size", "3.3/substr-no-clamp", []byte{1, 2}, 0, -1)
	sub("int32-overflow-sum", "3.3/substr-no-clamp", []byte{1, 2}, int64(1<<31-1), int64(1<<31-1))
	sub("empty", "3.3/substr-no-clamp", []byte{}, 0, 0)
	for _, n := range []int{0, 2, 3, -1} {
		b.ex("splice/OP_LEFT/n-"+itoa(n), OP_LEFT, "3.3/left-right-bounds", sc([]byte{1, 2}, n, o(OP_LEFT)))
		b.ex("splice/OP_RIGHT/n-"+itoa(n), OP_RIGHT, "3.3/left-right-bounds", sc([]byte{1, 2}, n, o(OP_RIGHT)))
	}
	b.ex("splice/OP_LEFT/sub-slice-not-alias", OP_LEFT, "3.3/aliasing", sc([]byte{0x0f, 0xf0, 0xaa}, o(OP_DUP), 2, o(OP_LEFT, OP_INVERT)))
	b.ex("splice/OP_SUBSTR/sub-slice-not-alias", OP_SUBSTR, "3.3/aliasing", sc([]byte{0x0f, 0xf0, 0xaa}, o(OP_DUP), 1, 1, o(OP_SUBSTR, OP_INVERT)))
	b.ex("splice/OP_RIGHT/sub-slice-not-alias", OP_RIGHT, "3.3/aliasing", sc([]byte{0x0f, 0xf0, 0xaa}, o(OP_DUP), 2, o(OP_RIGHT, OP_DUP, OP_AND, OP_INVERT)))
	for _, op := range []int{OP_AND, OP_OR, OP_XOR} {
		b.ex("splice/"+slots[op].name+"/equal-length", op, "3.3/bitwise-equal-length", sc([]byte{0x0f, 0xf0}, []byte{0xff, 0x0f}, o(op)))
		b.ex("splice/"+slots[op].name+"/length-mismatch", op, "3.3/bitwise-equal-length", sc([]byte{0x0f}, []byte{0xff, 0x0f}, o(op)))
	}
	b.ex("splice/OP_INVERT/empty", OP_INVERT, "", sc([]byte{}, o(OP_INVERT)))
	b.ex("splice/OP_SIZE/of-520", OP_SIZE, "", sc(rep(9, 520), o(OP_SIZE)))
	b.ex("splice/OP_REVERSEBYTES/fresh-buffer", OP_REVERSEBYTES, "3.3/aliasing", sc([]byte{1, 2, 3}, o(OP_DUP, OP_REVERSEBYTES)))
	b.ex("splice/OP_REVERSEBYTES/empty", OP_REVERSEBYTES, "", sc([]byte{}, o(OP_REVERSEBYTES)))
	return b.cases
}

func arithHand() []*Case {
	b := &book{}
	bin := func(name string, op int, hz string, x, y any) {
		b.ex("arith/"+slots[op].name+"/"+name, op, hz, sc(x, y, o(op)))
	}
	bin("trunc-neg", OP_DIV, "3.1/div-mod-truncate", -7, 2)
	bin("trunc-neg-divisor", OP_DIV, "3.1/div-mod-truncate", 7, -2)
	bin("by-zero", OP_DIV, "3.1/div-mod-truncate", 7, 0)
	bin("trunc-neg", OP_MOD, "3.1/div-mod-truncate", -7, 2)
	bin("by-zero", OP_MOD, "3.1/div-mod-truncate", 7, 0)
	bin("minint64-by-minus-one", OP_DIV, "3.1/bignum-operands", big.NewInt(-1<<63), -1)
	bin("minint64-mod-minus-one", OP_MOD, "3.1/bignum-operands", big.NewInt(-1<<63), -1)
	bin("floor-neg", OP_RSHIFT, "3.1/rshift-floor", -7, 1)
	bin("minus-one-stays", OP_RSHIFT, "3.1/rshift-floor", -1, 200)
	bin("positive-to-zero", OP_RSHIFT, "3.1/rshift-floor", 5, 5000)
	bin("big-value", OP_RSHIFT, "3.1/rshift-floor", pow2(4000), 3990)
	bin("negative-count", OP_RSHIFT, "3.1/lshift-cap", 5, -1)
	bin("cap-4160", OP_LSHIFT, "3.1/lshift-cap", 1, 4161)
	bin("at-cap-but-too-big", OP_LSHIFT, "3.1/lshift-cap", 1, 4160)
	bin("largest-fit", OP_LSHIFT, "3.1/lshift-cap", 1, 4158)
	bin("zero-any-count", OP_LSHIFT, "3.1/lshift-cap", 0, 100000)
	bin("negative-count", OP_LSHIFT, "3.1/lshift-cap", 1, -1)
	bin("negative-value", OP_LSHIFT, "3.1/lshift-cap", -3, 2)
	bin("five-byte-count", OP_LSHIFT, "3.1/mixed-width", 1, n64(1<<32))
	bin("nine-byte-operands", OP_ADD, "3.1/bignum-operands", pow2(64), pow2(64))
	bin("520-byte-operand", OP_SUB, "3.1/bignum-operands", new(big.Int).Sub(pow2(4159), big.NewInt(1)), 1)
	b.cov("arith/OP_ADD/521-byte-operand-from-witness", OP_ADD, "3.1/bignum-operands", sc(1, o(OP_ADD)), [][]byte{append(rep(1, 520), 0)})
	bin("result-past-520", OP_MUL, "3.1/bignum-operands", pow2(4150), pow2(10))
	bin("int64-overflow-promotes", OP_ADD, "3.1/bignum-operands", big.NewInt(1<<63-1), 1)
	bin("non-minimal-operand", OP_ADD, "3.1/bignum-operands", raw(push([]byte{1, 0})), 1)
	bin("negative-zero-operand", OP_ADD, "3.1/bignum-operands", raw(push([]byte{0x80})), 1)
	b.ex("arith/OP_WITHIN/left-inclusive", OP_WITHIN, "3.1/within-half-open", sc(2, 2, 5, o(OP_WITHIN)))
	b.ex("arith/OP_WITHIN/right-exclusive", OP_WITHIN, "3.1/within-half-open", sc(5, 2, 5, o(OP_WITHIN)))
	b.ex("arith/OP_WITHIN/big-bounds", OP_WITHIN, "3.1/within-half-open", sc(pow2(100), 0, pow2(101), o(OP_WITHIN)))
	b.ex("arith/OP_NUM2BIN/minus-one-4", OP_NUM2BIN, "3.1/num2bin-fixedbytes", sc(-1, 4, o(OP_NUM2BIN)))
	b.ex("arith/OP_NUM2BIN/sign-byte-dropped", OP_NUM2BIN, "3.1/num2bin-fixedbytes", sc(-128, 3, o(OP_NUM2BIN)))
	b.ex("arith/OP_NUM2BIN/too-small", OP_NUM2BIN, "3.1/num2bin-fixedbytes", sc(256, 1, o(OP_NUM2BIN)))
	b.ex("arith/OP_NUM2BIN/negative-size", OP_NUM2BIN, "3.1/num2bin-fixedbytes", sc(1, -1, o(OP_NUM2BIN)))
	b.ex("arith/OP_NUM2BIN/size-521", OP_NUM2BIN, "3.1/num2bin-fixedbytes", sc(1, 521, o(OP_NUM2BIN)))
	b.ex("arith/OP_NUM2BIN/zero-520", OP_NUM2BIN, "3.1/mixed-width", sc(0, 520, o(OP_NUM2BIN, OP_SIZE, OP_NIP)))
	b.ex("arith/OP_BIN2NUM/negative-zero", OP_BIN2NUM, "3.1/bin2num-normalises", sc([]byte{0x80}, o(OP_BIN2NUM)))
	b.ex("arith/OP_BIN2NUM/padded-negative", OP_BIN2NUM, "3.1/bin2num-normalises", sc([]byte{5, 0, 0, 0x80}, o(OP_BIN2NUM)))
	b.ex("arith/OP_BIN2NUM/keeps-sign-byte", OP_BIN2NUM, "3.1/bin2num-normalises", sc([]byte{0x80, 0, 0}, o(OP_BIN2NUM)))
	b.cov("arith/OP_BIN2NUM/over-520-from-witness", OP_BIN2NUM, "2.7/witness-unchecked", sc(o(OP_BIN2NUM, OP_DROP, OP_1)), [][]byte{rep(1, 521)})
	// §3.6 MODEXP: stack [... base exp modulus]
	mx := func(name, hz string, base, e, m any) {
		b.ex("arith/OP_MODEXP/"+name, OP_MODEXP, hz, sc(base, e, m, o(OP_MODEXP)))
	}
	mx("basic", "3.6/pop-order", 4, 13, 497)
	mx("zero-pow-zero", "3.6/negative-base", 0, 0, 7)
	mx("mod-one", "3.6/negative-base", 5, 3, 1)
	mx("negative-base-normalised", "3.6/negative-base", -5, 3, 7)
	mx("zero-modulus", "3.6/modulus-nonpositive", 5, 3, 0)
	mx("negative-modulus", "3.6/modulus-nonpositive", 5, 3, -7)
	mx("negative-exponent", "3.6/negative-exponent", 5, -1, 7)
	mx("64-byte-operand", "3.6/operand-64-bytes", new(big.Int).Sub(pow2(511), big.NewInt(1)), 2, new(big.Int).Sub(pow2(511), big.NewInt(3)))
	mx("sign-byte-makes-65", "3.6/operand-64-bytes", new(big.Int).Sub(pow2(512), big.NewInt(1)), 2, 7)
	mx("65-byte-modulus", "3.6/operand-64-bytes", 2, 2, pow2(512))
	b.ex("arith/OP_2MUL/is-add-self", OP_2MUL, "3.6/2mul-2div", sc(big.NewInt(1<<62), o(OP_2MUL)))
	b.ex("arith/OP_2DIV/truncates", OP_2DIV, "3.6/2mul-2div", sc(-3, o(OP_2DIV)))
	b.ex("arith/OP_ABS/minint64", OP_ABS, "3.1/bignum-operands", sc(big.NewInt(-1<<63), o(OP_ABS)))
	b.ex("arith/OP_NEGATE/minint64", OP_NEGATE, "3.1/bignum-operands", sc(big.NewInt(-1<<63), o(OP_NEGATE)))
	b.ex("arith/OP_NOT/big-nonzero", OP_NOT, "3.1/bignum-operands", sc(pow2(80), o(OP_NOT)))
	b.ex("arith/OP_NUMEQUALVERIFY/fails", OP_NUMEQUALVERIFY, "", sc(1, 2, o(OP_NUMEQUALVERIFY)))
	b.ex("arith/OP_BOOLAND/big", OP_BOOLAND, "3.1/bignum-operands", sc(pow2(90), 1, o(OP_BOOLAND)))
	return b.cases
}

func hashHand() []*Case {
	b := &book{}
	for sel := 0; sel <= 6; sel++ {
		b.ex("hash/OP_DIGEST/selector-"+itoa(sel), OP_DIGEST, "3.4/digest-selectors", sc([]byte("abc"), sel, o(OP_DIGEST)))
	}
	b.ex("hash/OP_DIGEST/selector-popped-first", OP_DIGEST, "3.4/digest-selectors", sc(4, []byte("abc"), o(OP_DIGEST)))
	b.ex("hash/OP_DIGEST/five-byte-selector", OP_DIGEST, "3.4/digest-selectors", sc([]byte("abc"), n64(1<<32+1), o(OP_DIGEST)))
	ini := sha256InitState
	b.ex("hash/OP_SHA256INITIALIZE/fresh-context", OP_SHA256INITIALIZE, "3.4/sha256-midstate-framing", sc([]byte{}, o(OP_SHA256INITIALIZE)))
	b.ex("hash/OP_SHA256INITIALIZE/with-data", OP_SHA256INITIALIZE, "3.4/sha256-midstate-framing", sc(rep(7, 100), o(OP_SHA256INITIALIZE)))
	b.ex("hash/OP_SHA256UPDATE/round-trip", OP_SHA256UPDATE, "3.4/sha256-pop-order", sc([]byte("ab"), o(OP_SHA256INITIALIZE), []byte("cd"), o(OP_SHA256UPDATE), []byte("ef"), o(OP_SHA256FINALIZE)))
	b.ex("hash/OP_SHA256UPDATE/pop-order-swapped", OP_SHA256UPDATE, "3.4/sha256-pop-order", sc(ini([]byte("ab")), o(OP_SWAP), []byte("cd"), o(OP_SWAP, OP_SHA256UPDATE)))
	b.ex("hash/OP_SHA256FINALIZE/witnessless-state", OP_SHA256FINALIZE, "3.4/sha256-midstate-framing", sc(ini([]byte("abc")), []byte{}, o(OP_SHA256FINALIZE)))
	st := ini(rep(0, 64))
	b.ex("hash/OP_SHA256FINALIZE/block-boundary-state", OP_SHA256FINALIZE, "3.4/sha256-midstate-framing", sc(st, []byte{1}, o(OP_SHA256FINALIZE)))
	short := append([]byte{}, st[:len(st)-1]...)
	b.ex("hash/OP_SHA256UPDATE/short-state", OP_SHA256UPDATE, "3.4/sha256-midstate-framing", sc(short, []byte{1}, o(OP_SHA256UPDATE)))
	badPrefix := append([]byte{}, st...)
	badPrefix[1] ^= 1
	b.ex("hash/OP_SHA256UPDATE/bad-prefix", OP_SHA256UPDATE, "3.4/sha256-midstate-framing", sc(badPrefix, []byte{1}, o(OP_SHA256UPDATE)))
	badMagic := append([]byte{}, st...)
	badMagic[15] = 'x'
	b.ex("hash/OP_SHA256FINALIZE/bad-magic", OP_SHA256FINALIZE, "3.4/sha256-midstate-framing", sc(badMagic, []byte{}, o(OP_SHA256FINALIZE)))
	arbitrary := append([]byte{}, st...)
	for i := 19; i < 51; i++ {
		arbitrary[i] = byte(i)
	}
	b.ex("hash/OP_SHA256FINALIZE/arbitrary-h-words", OP_SHA256FINALIZE, "3.4/sha256-midstate-framing", sc(arbitrary, []byte{}, o(OP_SHA256FINALIZE)))
	// nx comes from the length field: claim 3 pending bytes of a 64-byte state
	lying := append([]byte{}, st...)
	lying[len(lying)-1] = 0x43
	b.ex("hash/OP_SHA256UPDATE/length-sets-pending-count", OP_SHA256UPDATE, "3.4/sha256-midstate-framing", sc(lying, []byte("z"), o(OP_SHA256UPDATE), []byte{}, o(OP_SHA256FINALIZE)))
	b.cov("hash/OP_SHA256UPDATE/witness-supplied-state", OP_SHA256UPDATE, "3.4/sha256-midstate-framing",
		sc([]byte("def"), o(OP_SHA256UPDATE), []byte{}, o(OP_SHA256FINALIZE, OP_SIZE), 32, o(OP_EQUALVERIFY, OP_DROP, OP_1)), [][]byte{ini([]byte("abc"))})
	for _, op := range []int{OP_RIPEMD160, OP_SHA1, OP_SHA256, OP_HASH160, OP_HASH256} {
		b.ex("hash/"+slots[op].name+"/of-520", op, "", sc(rep(0x61, 520), o(op)))
		b.ex("hash/"+slots[op].name+"/empty-stack", op, "", sc(o(op)))
	}
	return b.cases
}

func merkleHand() []*Case {
	b := &book{}
	leaf, sib1, sib2 := rep(0x11, 32), rep(0x01, 32), rep(0xee, 32)
	mr := func(name, hz string, leafTag, branchTag, proof, data []byte) {
		b.ex("merkle/"+name, OP_MERKLEBRANCHROOT, hz, sc(leafTag, branchTag, proof, data, o(OP_MERKLEBRANCHROOT)))
	}
	mr("tagged-leaf-two-steps", "3.5/lexicographic", []byte("leaf"), []byte("branch"), append(append([]byte{}, sib1...), sib2...), []byte("payload"))
	mr("raw-hash-mode", "3.5/raw-hash-mode", []byte{}, []byte("branch"), sib2, leaf)
	mr("raw-hash-mode-wrong-size", "3.5/raw-hash-mode", []byte{}, []byte("branch"), sib2, leaf[:31])
	mr("empty-proof", "3.5/empty-proof", []byte("leaf"), []byte("branch"), []byte{}, []byte("x"))
	mr("proof-not-multiple-of-32", "3.5/proof-multiple-of-32", []byte("leaf"), []byte("branch"), sib1[:31], []byte("x"))
	mr("empty-branch-tag", "3.5/pop-order", []byte("leaf"), []byte{}, sib1, []byte("x"))
	mr("pop-order-swapped", "3.5/pop-order", []byte("branch"), []byte("leaf"), []byte("x"), sib1)
	mr("sibling-smaller-sorts-first", "3.5/lexicographic", []byte{}, []byte("b"), sib1, leaf)
	mr("sibling-larger-sorts-second", "3.5/lexicographic", []byte{}, []byte("b"), sib2, leaf)
	b.ex("merkle/computes-root-not-verify", OP_MERKLEBRANCHROOT, "3.5/computes-not-verifies", sc([]byte{}, []byte("b"), []byte{}, leaf, o(OP_MERKLEBRANCHROOT), leaf, o(OP_EQUAL)))
	return b.cases
}

func itoa(n int) string { return big.NewInt(int64(n)).String() }

func hexs(b []byte) string {
	if len(b) == 0 {
		return "empty"
	}
	return "0x" + hex.EncodeToString(b)
}
