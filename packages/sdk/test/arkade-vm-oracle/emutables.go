package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

// opcodeSpecs (opcode_test.go:332) is package-level but test-only, and Go refuses
// -overlay under GOMODCACHE, so the package is copied out and this file added.
const exporterTest = `package arkade

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/btcsuite/btcd/wire/v2"
)

// zzSer is "" when tx holds a nil input or output, which wire cannot encode.
func zzSer(tx *wire.MsgTx) string {
	for _, o := range tx.TxOut {
		if o == nil {
			return ""
		}
	}
	for _, i := range tx.TxIn {
		if i == nil {
			return ""
		}
	}
	var b bytes.Buffer
	_ = tx.Serialize(&b)
	return hex.EncodeToString(b.Bytes())
}

type zzPrev struct {
	Hash, Script, ArkTx, Vtxo string
	Index                     uint32
	Value                     *int64
}

type zzVec struct {
	Op           int
	Valid        bool
	Name, Skip   string
	Stack, Alt   []string
	Data         *string
	Tx, Packet   string
	Prevouts     []zzPrev
	Expiry       *int64
	Intent       *string
}

func zzHex(items [][]byte) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = hex.EncodeToString(it)
	}
	return out
}

func TestZZOracleExport(t *testing.T) {
	var out []zzVec
	for op, spec := range opcodeSpecs {
		if spec == nil {
			continue
		}
		for _, g := range []struct {
			valid bool
			vs    []opcodeVector
		}{{true, spec.validVectors}, {false, spec.invalidVectors}} {
			for _, v := range g.vs {
				w := buildOpcodeWorld()
				if v.setupWorld != nil {
					v.setupWorld(w)
				}
				vm, err := newOpcodeEngine(w, 0)
				if err != nil {
					t.Fatal(err)
				}
				x := zzVec{Op: op, Valid: g.valid, Name: v.name, Stack: zzHex(v.inputStack), Alt: zzHex(v.inputAltStack)}
				if v.opcodeData != nil {
					d := hex.EncodeToString(v.opcodeData)
					x.Data = &d
				}
				if v.setupVM != nil {
					sentinel := BigNumFromInt64(-7)
					vm.currentTime = sentinel
					v.setupVM(vm)
					switch {
					case len(vm.condStack) > 0:
						x.Skip = "condStack"
					case vm.taprootCtx != nil:
						x.Skip = "taprootCtx"
					case vm.currentTime.Cmp(sentinel) != 0:
						x.Skip = "clock"
					}
					x.Expiry = vm.expiry
					if vm.intentMessage != nil {
						s := string(vm.intentMessage)
						x.Intent = &s
					}
				}
				if x.Tx = zzSer(&w.tx); x.Tx == "" {
					x.Skip = "nil tx field"
					out = append(out, x)
					continue
				}
				if v.setupWorld != nil && w.packet != nil {
					p, _ := w.packet.Serialize()
					x.Packet = hex.EncodeToString(p)
				}
				for _, in := range w.tx.TxIn {
					p := zzPrev{Hash: hex.EncodeToString(in.PreviousOutPoint.Hash[:]), Index: in.PreviousOutPoint.Index}
					if w.prevFetcher != nil {
						if o := w.prevFetcher.FetchPrevOutput(in.PreviousOutPoint); o != nil {
							p.Value, p.Script = &o.Value, hex.EncodeToString(o.PkScript)
						}
						if a := w.prevFetcher.FetchPrevOutArkTx(in.PreviousOutPoint); a != nil {
							if p.ArkTx = zzSer(a); p.ArkTx == "" {
								x.Skip = "nil ark tx field"
							}
						}
						if s := w.prevFetcher.FetchVtxoPrevOutPkScript(in.PreviousOutPoint); s != nil {
							p.Vtxo = hex.EncodeToString(s)
						}
					}
					x.Prevouts = append(x.Prevouts, p)
				}
				out = append(out, x)
			}
		}
	}
	b, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("ORACLE_EXPORT"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}
`

type zzPrev struct {
	Hash, Script, ArkTx, Vtxo string
	Index                     uint32
	Value                     *int64
}

type zzVec struct {
	Op         int
	Valid      bool
	Name, Skip string
	Stack, Alt []string
	Data       *string
	Tx, Packet string
	Prevouts   []zzPrev
	Expiry     *int64
	Intent     *string
}

func goCmd(dir string, args ...string) []byte {
	cmd := exec.Command("go", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN="+pinGo, "GOFLAGS=-mod=mod")
	out, err := cmd.CombinedOutput()
	if err != nil {
		fatal("go %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

func moduleDir(path string) string {
	return strings.TrimSpace(string(goCmd(".", "list", "-m", "-f", "{{.Dir}}", path)))
}

var skippedEmulatorVectors = map[string]int{}

func exportOpcodeSpecs() []zzVec {
	src := moduleDir("github.com/arkade-os/emulator/pkg/arkade")
	tmp, err := os.MkdirTemp("", "arkade-vm-oracle-")
	if err != nil {
		fatal("%v", err)
	}
	defer os.RemoveAll(tmp)
	err = filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		dst := filepath.Join(tmp, rel)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
	if err == nil {
		err = os.WriteFile(filepath.Join(tmp, "zz_oracle_export_test.go"), []byte(exporterTest), 0o644)
	}
	if err != nil {
		fatal("copy %s: %v", src, err)
	}
	outFile := filepath.Join(tmp, "export.json")
	cmd := exec.Command("go", "test", "-count=1", "-run", "^TestZZOracleExport$", ".")
	cmd.Dir = tmp
	cmd.Env = append(os.Environ(), "GOTOOLCHAIN="+pinGo, "GOFLAGS=-mod=mod", "ORACLE_EXPORT="+outFile)
	if out, err := cmd.CombinedOutput(); err != nil {
		fatal("exporting opcodeSpecs: %v\n%s", err, out)
	}
	b, err := os.ReadFile(outFile)
	if err != nil {
		fatal("%v", err)
	}
	var vecs []zzVec
	if err := json.Unmarshal(b, &vecs); err != nil {
		fatal("%v", err)
	}
	return vecs
}

func unhex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func decodeTx(s string) *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	if err := tx.Deserialize(bytes.NewReader(unhex(s))); err != nil {
		panic(err)
	}
	return tx
}

// emulatorVectorCases turns each vector into a script: pushes rebuild the input
// stacks, then the opcode runs through the public engine and Go's result is kept.
// Vectors whose setup lives in engine internals are skipped; their behaviour is
// covered by the hand-written families.
func emulatorVectorCases() map[string][]*Case {
	byFamily := map[string][]*Case{}
	worlds := map[string]*world{}
	for _, v := range exportOpcodeSpecs() {
		op := byte(v.Op)
		reason := v.Skip
		var stack, alt [][]byte
		for _, s := range v.Stack {
			stack = append(stack, unhex(s))
		}
		for _, s := range v.Alt {
			alt = append(alt, unhex(s))
		}
		// a stack element over 520 bytes can only arrive as covenant witness
		witnessed := false
		for _, it := range stack {
			witnessed = witnessed || len(it) > txscript.MaxScriptElementSize
		}
		for _, it := range alt {
			if len(it) > txscript.MaxScriptElementSize && reason == "" {
				reason = "alt element over 520 bytes"
			}
		}
		if v.Intent != nil && len(*v.Intent) > 4096 && reason == "" {
			reason = "intent message over 4 KiB, see intent/size-*"
		}
		if reason != "" {
			skippedEmulatorVectors[reason]++
			continue
		}
		tx := decodeTx(v.Tx)
		if v.Packet != "" {
			tx = withEmulatorPacket(tx, unhex(v.Packet))
			if tx == nil {
				skippedEmulatorVectors["emulator packet fails FindEmulatorPacket"]++
				continue
			}
		}
		w := &world{tx: tx}
		var amount int64
		for i, p := range v.Prevouts {
			var hash [32]byte
			copy(hash[:], unhex(p.Hash))
			pv := prevout{op: wire.OutPoint{Hash: hash, Index: p.Index}}
			if p.Value != nil {
				pv.out = &wire.TxOut{Value: *p.Value, PkScript: unhex(p.Script)}
				if i == 0 {
					amount = *p.Value
				}
			}
			if p.ArkTx != "" {
				pv.arkTx = decodeTx(p.ArkTx)
			}
			if p.Vtxo != "" {
				pv.vtxo = unhex(p.Vtxo)
			}
			w.prevouts = append(w.prevouts, pv)
		}
		w = internWorld(worlds, w)
		script := []byte{}
		for _, a := range alt {
			script = append(script, push(a)...)
			script = append(script, txscript.OP_TOALTSTACK)
		}
		if !witnessed {
			for _, s := range stack {
				script = append(script, push(s)...)
			}
		}
		script = append(script, opcodeWithData(op, v.Data)...)
		if op == txscript.OP_IF || op == txscript.OP_NOTIF {
			script = append(script, txscript.OP_ENDIF)
		}
		group := "invalid"
		if v.Valid {
			group = "valid"
		}
		c := &Case{
			Name: fmt.Sprintf("emulator/%s/%s/%s", slots[op].name, group, v.Name), Mode: "expression",
			Op: slots[op].name, World: w, InputAmount: amount, Script: script,
			Expiry: v.Expiry, IntentMessage: v.Intent, PacketsFromTx: v.Packet != "",
		}
		if witnessed {
			c.Mode, c.Witness, c.PacketsFromTx = "covenant", stack, false
		}
		if op == arkade.OP_INSPECTINTENTMESSAGE && len(stack) > 0 {
			c.PortUnsupported = intentUnsupported(v.Intent, stack[len(stack)-1])
		}
		fam := familyOf(op)
		byFamily[fam] = append(byFamily[fam], c)
	}
	return byFamily
}

func opcodeWithData(op byte, data *string) []byte {
	length := slots[op].length
	var d []byte
	if data != nil {
		d = unhex(*data)
	} else if length > 1 {
		d = make([]byte, length-1)
	}
	switch length {
	case 1:
		return []byte{op}
	case -1:
		return append([]byte{op, byte(len(d))}, d...)
	case -2:
		return append([]byte{op, byte(len(d)), byte(len(d) >> 8)}, d...)
	case -4:
		return append([]byte{op, byte(len(d)), byte(len(d) >> 8), byte(len(d) >> 16), byte(len(d) >> 24)}, d...)
	}
	return append([]byte{op}, d...)
}

// withEmulatorPacket appends the packet as an extension output, so the TS side
// reads it off the tx exactly as Execute does.
func withEmulatorPacket(tx *wire.MsgTx, packet []byte) *wire.MsgTx {
	out, err := extension.Extension{extension.UnknownPacket{PacketType: arkade.PacketType, Data: packet}}.TxOut()
	if err != nil {
		return nil
	}
	cp := tx.Copy()
	cp.AddTxOut(out)
	if p, err := arkade.FindEmulatorPacket(cp); err != nil || p == nil {
		return nil
	}
	return cp
}

func internWorld(worlds map[string]*world, w *world) *world {
	key := string(render(w.json()))
	if have, ok := worlds[key]; ok {
		return have
	}
	w.name = fmt.Sprintf("emulator-%d", len(worlds))
	worlds[key] = w
	return w
}

func familyOf(op byte) string {
	switch {
	case op <= 0x7d || op == 0x87 || op == 0x88 || op == 0x89 || op == 0x8a || op == 0xb0 ||
		(op >= 0xb4 && op <= 0xb9) || op == 0xbb || (op >= 0xbc && op <= 0xc2) || op == 0xd0 ||
		(op >= 0xdd && op <= 0xdf) || op >= 0xf9:
		return "core"
	case (op >= 0x7e && op <= 0x86) || op == 0xd9:
		return "splice"
	case (op >= 0x8b && op <= 0xa5) || op == 0xd7 || op == 0xd8 || op == 0xda:
		return "arith"
	case (op >= 0xa6 && op <= 0xaa) || (op >= 0xc3 && op <= 0xc6):
		return "hash"
	case op == 0xb3:
		return "merkle"
	case op == 0xab || op == 0xac || op == 0xad || op == 0xae || op == 0xaf || op == 0xba || op == 0xcc || op == 0xf6:
		return "sig"
	case op == 0xb1 || op == 0xb2 || op == 0xdb || op == 0xdc:
		return "time"
	case op >= 0xe0 && op <= 0xe4:
		return "ec"
	case op >= 0xe5 && op <= 0xf2:
		return "asset"
	case op == 0xf4 || op == 0xf5:
		return "packet"
	case op == 0xf7:
		return "tunnel"
	case op == 0xf8:
		return "intent"
	}
	return "introspect"
}
