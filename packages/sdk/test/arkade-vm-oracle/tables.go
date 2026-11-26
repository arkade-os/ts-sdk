package main

import (
	"bytes"
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type slot struct {
	value   int
	name    string
	length  int
	aliases []string
}

var slots = buildSlots()

func slotByName(name string) slot {
	op, ok := arkade.OpcodeByName[name]
	if !ok {
		panic("unknown opcode " + name)
	}
	return slots[op]
}

func buildSlots() [256]slot {
	var out [256]slot
	byValue := map[byte][]string{}
	for name, v := range arkade.OpcodeByName {
		byValue[v] = append(byValue[v], name)
	}
	for i := range 256 {
		op := byte(i)
		length := probeLength(op)
		name := disasmName(oneToken(op, length))
		names := byValue[op]
		if !slices.Contains(names, name) {
			panic(fmt.Sprintf("slot %#x: disassembly name %s not in OpcodeByName", i, name))
		}
		aliases := slices.DeleteFunc(slices.Clone(names), func(n string) bool { return n == name })
		slices.Sort(aliases)
		out[i] = slot{i, name, length, aliases}
	}
	return out
}

// probeLength reads the tokenizer's width convention off one parse: 1 for a
// bare opcode, the total size for OP_DATA_n, minus the prefix width for PUSHDATAn.
func probeLength(op byte) int {
	script := append([]byte{op, 0x01, 0, 0, 0}, bytes.Repeat([]byte{0xaa}, 80)...)
	tok := arkade.MakeScriptTokenizer(0, script)
	if !tok.Next() {
		panic(fmt.Sprintf("slot %#x does not tokenize: %v", op, tok.Err()))
	}
	consumed, data := int(tok.ByteIndex()), len(tok.Data())
	switch {
	case consumed == 1:
		return 1
	case data == consumed-1:
		return consumed
	default:
		return -(consumed - 1 - data)
	}
}

func oneToken(op byte, length int) []byte {
	switch {
	case length > 1:
		return append([]byte{op}, make([]byte, length-1)...)
	case length < 0:
		return append([]byte{op}, make([]byte, -length)...)
	}
	return []byte{op}
}

func disasmName(script []byte) string {
	vm, err := arkade.NewEngine(script, oneInputTx(), 0, nil, nil, 0, nil)
	if err != nil {
		panic(err)
	}
	s, err := vm.DisasmScript(1)
	if err != nil {
		panic(err)
	}
	return strings.Fields(s)[1]
}

func oneInputTx() *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(&wire.TxIn{Sequence: wire.MaxTxInSequenceNum})
	return tx
}

func opcodesTable() obj {
	list := make([]any, 256)
	for i, s := range slots {
		aliases := make([]any, len(s.aliases))
		for j, a := range s.aliases {
			aliases[j] = a
		}
		list[i] = obj{{"value", s.value}, {"name", s.name}, {"length", s.length}, {"aliases", aliases}}
	}
	return obj{{"opcodes", list}}
}

func limitsJSON(c arkade.ComputeLimits) []any {
	var out []any
	for op := range 256 {
		if v, ok := c[byte(op)]; ok {
			out = append(out, obj{{"opcode", op}, {"name", slots[op].name}, {"limit", int64(v)}})
		}
	}
	return out
}

func computeLimitsTable() obj {
	def := arkade.DefaultComputeLimits()
	agg := arkade.AggregateComputeLimits(def)
	budget := 0
	for op, v := range def {
		if budget == 0 {
			budget = agg[op] / v
		}
		if agg[op] != v*budget {
			panic("aggregate is not a uniform multiple of the per-input limits")
		}
	}
	return obj{
		{"default", limitsJSON(def)},
		{"aggregate", limitsJSON(agg)},
		{"request_input_budget", budget},
		{"engine", obj{
			{"max_script_element_size", txscript.MaxScriptElementSize},
			{"max_script_size", txscript.MaxScriptSize},
			{"max_stack_size", txscript.MaxStackSize},
			{"max_combined_stack_byte_size", probeStackByteBudget()},
		}},
	}
}

// probeStackByteBudget measures the unexported maxCombinedStackByteSize: 252
// copies of a 520-byte element, then one more push of n bytes.
func probeStackByteBudget() int {
	base := txscript.NewScriptBuilder().AddData(bytes.Repeat([]byte{1}, 520))
	for range 251 {
		base.AddOp(txscript.OP_DUP)
	}
	prefix := mustScript(base)
	last := -1
	for n := 0; n <= 520; n++ {
		push := mustScript(txscript.NewScriptBuilder().AddData(bytes.Repeat([]byte{2}, n)))
		c := &Case{Name: "probe", Mode: "expression", World: defaultWorld(), Script: append(slices.Clone(prefix), push...)}
		if e := runExpression(c); e.ok {
			last = 252*520 + n
		} else if e.code != "ErrStackOverflow" {
			panic("stack byte probe failed with " + e.code)
		} else {
			break
		}
	}
	if last < 252*520 || last == 252*520+520 {
		panic("stack byte budget is outside the probe range")
	}
	return last
}

// sha256Framing reads the midstate off the stack exactly as a covenant sees it;
// the prefix is whatever precedes the stdlib MarshalBinary payload.
func sha256Framing() obj {
	var prefix []byte
	states := []any{}
	for _, data := range [][]byte{{}, []byte("abc"), make([]byte, 64), []byte("Hello")} {
		state := sha256InitState(data)
		h := sha256.New()
		h.Write(data)
		payload, err := h.(encoding.BinaryMarshaler).MarshalBinary()
		if err != nil || !bytes.HasSuffix(state, payload) {
			panic("midstate does not end with the stdlib marshaled payload")
		}
		p := state[:len(state)-len(payload)]
		if prefix != nil && !bytes.Equal(p, prefix) {
			panic("midstate framing differs between states")
		}
		prefix = p
		digest := sha256.Sum256(data)
		states = append(states, obj{
			{"data_hex", hex.EncodeToString(data)},
			{"state_hex", hex.EncodeToString(state)},
			{"digest_hex", hex.EncodeToString(digest[:])},
		})
	}
	// opcode_test.go:1079 sha256InitGolden, the emulator's own expectation for "Hello".
	golden := "097f060102ff8200000070ff80006c736861036a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd1948656c6c6f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005"
	return obj{
		{"prefix_hex", hex.EncodeToString(prefix)},
		{"total_len", len(prefix) + 108},
		{"payload_len", 108},
		{"matches_emulator_golden", hex.EncodeToString(sha256InitState([]byte("Hello"))) == golden},
		{"states", states},
	}
}

func sha256InitState(data []byte) []byte {
	script := mustScript(txscript.NewScriptBuilder().AddData(data).AddOp(arkade.OP_SHA256INITIALIZE))
	e := runExpression(&Case{Name: "sha256", Mode: "expression", World: defaultWorld(), Script: script})
	if !e.ok || len(e.stack) != 1 {
		panic("OP_SHA256INITIALIZE probe failed")
	}
	return e.stack[0]
}
