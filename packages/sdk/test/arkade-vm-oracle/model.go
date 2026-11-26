package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
)

// prevout is what the fetcher answers for one outpoint; a nil field is a miss.
type prevout struct {
	op    wire.OutPoint
	out   *wire.TxOut
	arkTx *wire.MsgTx
	vtxo  []byte
}

type world struct {
	name     string
	tx       *wire.MsgTx
	prevouts []prevout
}

type fetcher map[wire.OutPoint]prevout

func (f fetcher) FetchPrevOutput(op wire.OutPoint) *wire.TxOut     { return f[op].out }
func (f fetcher) FetchPrevOutArkTx(op wire.OutPoint) *wire.MsgTx   { return f[op].arkTx }
func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte { return f[op].vtxo }
func (w *world) fetcher() fetcher {
	f := fetcher{}
	for _, p := range w.prevouts {
		f[p.op] = p
	}
	return f
}

type Case struct {
	Name, Mode, Op, Hazard string
	World                  *world
	InputIndex             int
	InputAmount            int64
	Script                 []byte
	Witness                [][]byte
	Seed                   [][]byte
	TapLeaf                []byte
	PacketsFromTx          bool
	Expiry                 *int64
	IntentMessage          *string
	Limits                 arkade.ComputeLimits
	Budget                 arkade.ComputeLimits
	PortUnsupported        bool
	Service                *serviceInput
	Expect                 *expect
}

type expect struct {
	ok            bool
	stack         [][]byte
	code, kind    string
	stage         string
	failedOp      string
	position      int
	requests      []obj
	errorContains string
}

// Covenant cases need a closure leaf NewArkadeScript accepts; the arkade script
// itself never reads it except through the sighash.
var defaultLeaf = mustScript(txscript.NewScriptBuilder().AddData(xonly(keyN(1))).AddOp(txscript.OP_CHECKSIG))

func keyN(n byte) *btcec.PrivateKey {
	k, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{n}, 32))
	return k
}

func xonly(k *btcec.PrivateKey) []byte { return k.PubKey().SerializeCompressed()[1:] }

func mustScript(b *txscript.ScriptBuilder) []byte {
	s, err := b.Script()
	if err != nil {
		panic(err)
	}
	return s
}

func (c *Case) run() {
	switch c.Mode {
	case "expression":
		c.Expect = runExpression(c)
	case "covenant":
		c.Expect = runCovenant(c)
	case "service":
		c.Expect = runService(c.Service)
	default:
		panic("unknown mode " + c.Mode)
	}
}

func runExpression(c *Case) (e *expect) {
	e = &expect{}
	vm, err := arkade.NewEngine(c.Script, c.World.tx, c.InputIndex, nil, nil, c.InputAmount, c.World.fetcher())
	if err != nil {
		e.fail(err, "engine")
		return e
	}
	if c.PacketsFromTx {
		injectPackets(c, vm)
	}
	if c.Expiry != nil {
		arkade.WithExpiry(*c.Expiry)(vm)
	}
	if c.IntentMessage != nil {
		arkade.WithIntentMessage(*c.IntentMessage)(vm)
	}
	if len(c.Seed) > 0 {
		vm.SetStack(c.Seed)
	}
	var pc string
	defer func() {
		if r := recover(); r != nil {
			e.ok, e.kind, e.stage, e.failedOp = false, "ErrPanic", "step", pc
		}
	}()
	for done := false; !done; {
		if s, _ := vm.DisasmPC(); len(strings.Fields(s)) > 1 {
			pc = strings.Fields(s)[1]
		}
		if done, err = vm.Step(); err != nil {
			e.fail(err, "step")
			e.failedOp = pc
			return e
		}
	}
	e.ok, e.stack = true, vm.GetStack()
	return e
}

func covenantPacket(c *Case) *psbt.Packet {
	ptx, err := psbt.NewFromUnsignedTx(c.World.tx)
	if err != nil {
		panic(err)
	}
	leaf := c.TapLeaf
	if leaf == nil {
		leaf = defaultLeaf
	}
	ptx.Inputs[entryVin(c)].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
		ControlBlock: make([]byte, 33), Script: leaf, LeafVersion: txscript.BaseLeafVersion,
	}}
	return ptx
}

// entryVin is where the leaf lives; Execute takes the input index separately, so
// an out-of-range index still reaches script.go:220.
func entryVin(c *Case) int {
	if c.InputIndex >= len(c.World.tx.TxIn) {
		return 0
	}
	return c.InputIndex
}

func runCovenant(c *Case) (e *expect) {
	e = &expect{}
	s, err := arkade.NewArkadeScript(covenantPacket(c), arkade.EmulatorEntry{
		Vin: uint16(entryVin(c)), Script: c.Script, Witness: c.Witness,
	})
	if err != nil {
		panic(fmt.Sprintf("%s: NewArkadeScript: %v", c.Name, err))
	}
	var opts []arkade.ExecuteOption
	if c.Limits != nil {
		opts = append(opts, arkade.WithExactComputeLimits(c.Limits))
	}
	if c.Budget != nil {
		opts = append(opts, arkade.WithComputeBudget(arkade.NewComputeBudgetWithLimits(c.Budget)))
	}
	if c.Expiry != nil {
		opts = append(opts, arkade.WithExpiry(*c.Expiry))
	}
	if c.IntentMessage != nil {
		opts = append(opts, arkade.WithIntentMessage(*c.IntentMessage))
	}
	defer func() {
		if r := recover(); r != nil {
			e.ok, e.kind, e.stage = false, "ErrPanic", "step"
		}
	}()
	if err := s.Execute(c.World.tx, c.World.fetcher(), c.InputIndex, opts...); err != nil {
		e.fail(err, "setup")
		return e
	}
	e.ok = true
	return e
}

// fail classifies err the way the TS port must: by btcd code when one exists,
// else by a stable kind; and locates it when Go wrapped it in an ExecutionError.
func (e *expect) fail(err error, stage string) {
	e.ok, e.stage = false, stage
	var se txscript.Error
	if errors.As(err, &se) {
		e.code = se.ErrorCode.String()
	} else {
		e.kind = kindOf(err)
	}
	var xe *arkade.ExecutionError
	if errors.As(err, &xe) {
		e.failedOp, e.position = xe.Opcode, xe.Position
		e.stage = "step"
		if strings.HasPrefix(xe.Err.Error(), "final script validation failed") {
			e.stage = "final"
		}
	} else if strings.Contains(err.Error(), "failed to create engine") {
		e.stage = "engine"
	}
}

func kindOf(err error) string {
	for name, sentinel := range map[string]error{
		"ErrBigNumDivisionByZero":     arkade.ErrBigNumDivisionByZero,
		"ErrBigNumModuloByZero":       arkade.ErrBigNumModuloByZero,
		"ErrBigNumModulusNotPositive": arkade.ErrBigNumModulusNotPositive,
		"ErrBigNumNegativeExponent":   arkade.ErrBigNumNegativeExponent,
	} {
		if errors.Is(err, sentinel) {
			return name
		}
	}
	var pe secp.Error
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	msg := err.Error()
	for prefix, kind := range map[string]string{
		"no prevout found for input": "ErrNoPrevout",
		"failed to parse extension":  "ErrExtensionParse",
		"failed to parse emulator":   "ErrEmulatorPacketParse",
	} {
		if strings.HasPrefix(msg, prefix) {
			return kind
		}
	}
	panic("unclassified uncoded error: " + msg)
}

func (e *expect) json(mode string) obj {
	o := obj{{"ok", e.ok}}
	if e.ok && mode == "expression" {
		o.add("stack_hex", hexList(e.stack))
	}
	if e.requests != nil {
		reqs := make([]any, len(e.requests))
		for i, r := range e.requests {
			reqs[i] = r
		}
		o.add("requests", reqs)
	}
	if !e.ok {
		o.add("code", nullable(e.code))
		o.add("kind", nullable(e.kind))
		o.add("stage", e.stage)
		if e.failedOp != "" {
			o.add("failed_op", e.failedOp)
		}
		if mode == "covenant" && e.failedOp != "" {
			o.add("position", e.position)
		}
		if e.errorContains != "" {
			o.add("error_contains", e.errorContains)
		}
	}
	return o
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func hexList(items [][]byte) []any {
	out := make([]any, len(items))
	for i, it := range items {
		out[i] = hex.EncodeToString(it)
	}
	return out
}

func txHex(tx *wire.MsgTx) string {
	var b bytes.Buffer
	if err := tx.Serialize(&b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b.Bytes())
}

func (w *world) json() obj {
	pvs := make([]any, len(w.prevouts))
	for i, p := range w.prevouts {
		o := obj{{"outpoint", obj{{"txid", hex.EncodeToString(p.op.Hash[:])}, {"index", p.op.Index}}}}
		if p.out != nil {
			o.add("value", strconv.FormatInt(p.out.Value, 10))
			o.add("script", hex.EncodeToString(p.out.PkScript))
		}
		if p.arkTx != nil {
			o.add("ark_tx_hex", txHex(p.arkTx))
		}
		if p.vtxo != nil {
			o.add("vtxo_script", hex.EncodeToString(p.vtxo))
		}
		pvs[i] = o
	}
	return obj{{"tx_hex", txHex(w.tx)}, {"prevouts", pvs}}
}

func (c *Case) json() obj {
	o := obj{{"name", c.Name}, {"mode", c.Mode}, {"op", nullable(c.Op)}}
	if c.Hazard != "" {
		o.add("hazard", c.Hazard)
	}
	if c.Service != nil {
		o = append(o, c.Service.json()...)
		o.add("expect", c.Expect.json(c.Mode))
		return o
	}
	o.add("world", c.World.name)
	o.add("input_index", c.InputIndex)
	if c.Mode == "expression" {
		o.add("input_amount", strconv.FormatInt(c.InputAmount, 10))
	}
	o.add("script_hex", hex.EncodeToString(c.Script))
	if c.Seed != nil {
		o.add("seed_hex", hexList(c.Seed))
	}
	if c.Mode == "covenant" {
		o.add("witness_hex", hexList(c.Witness))
		leaf := c.TapLeaf
		if leaf == nil {
			leaf = defaultLeaf
		}
		o.add("tap_leaf_hex", hex.EncodeToString(leaf))
		o.add("leaf_version", int(txscript.BaseLeafVersion))
	}
	if c.PacketsFromTx {
		o.add("packets_from_tx", true)
	}
	if c.Expiry != nil {
		o.add("expiry", strconv.FormatInt(*c.Expiry, 10))
	}
	if m := c.IntentMessage; m != nil && len(*m) > 4096 && strings.Count(*m, (*m)[:1]) == len(*m) {
		o.add("intent_message_fill", obj{{"char", (*m)[:1]}, {"length", len(*m)}})
	} else if m != nil {
		o.add("intent_message", *m)
	}
	for _, f := range []struct {
		k string
		v arkade.ComputeLimits
	}{{"limits", c.Limits}, {"budget", c.Budget}} {
		if f.v == nil {
			continue
		}
		l := obj{}
		for op := 0; op < 256; op++ {
			if v, ok := f.v[byte(op)]; ok {
				l.add(strconv.Itoa(op), int64(v))
			}
		}
		o.add(f.k, l)
	}
	if c.PortUnsupported {
		o.add("port_unsupported", true)
	}
	o.add("expect", c.Expect.json(c.Mode))
	return o
}

// injectPackets gives an expression engine the packets Execute would read off the tx.
func injectPackets(c *Case, vm *arkade.Engine) {
	ext, err := extension.NewExtensionFromTx(c.World.tx)
	if err != nil {
		panic(fmt.Sprintf("%s: extension: %v", c.Name, err))
	}
	if ap := ext.GetAssetPacket(); ap != nil {
		vm.SetAssetPacket(ap)
	}
	packet, err := arkade.FindEmulatorPacket(c.World.tx)
	if err != nil {
		panic(fmt.Sprintf("%s: emulator packet: %v", c.Name, err))
	}
	if packet != nil {
		vm.SetEmulatorPacket(packet)
	}
}

// inputKey covers everything that decides an outcome; equal keys are duplicate cases.
func (c *Case) inputKey() string {
	k := *c
	k.Name, k.Op, k.Hazard, k.Expect = "", "", "", &expect{}
	o := k.json()
	return string(render(o[:len(o)-1]))
}
