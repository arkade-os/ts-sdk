package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	. "github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type artifactFn struct {
	Name   string `json:"name"`
	Arkade *struct {
		Asm []string `json:"asm"`
	} `json:"arkade"`
	Leaves []struct {
		Asm []string `json:"asm"`
	} `json:"leaves"`
}

type typedInput struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// assemble mirrors the executor's asm.Assemble (internal/asm/asm.go), placeholders
// bound by declared type; bytes are what reach the VM, so the binding values are free.
func assemble(tokens []string, inputs []typedInput, ints map[string]int64, byts map[string][]byte) []byte {
	types := map[string]string{}
	for _, in := range inputs {
		types[in.Name] = in.Type
	}
	var out []byte
	for _, tok := range tokens {
		switch {
		case strings.HasPrefix(tok, "OP_"):
			op, ok := OpcodeByName[tok]
			if !ok {
				panic("unknown opcode " + tok)
			}
			out = append(out, op)
		case regexp.MustCompile(`^-?[0-9]+$`).MatchString(tok):
			n, _ := strconv.ParseInt(tok, 10, 64)
			out = append(out, push(n64(n))...)
		case strings.HasPrefix(tok, "0x"):
			out = append(out, asmData(unhex(tok[2:]))...)
		case strings.HasPrefix(tok, "<"):
			name := strings.TrimPrefix(strings.Trim(tok, "<>"), "!")
			switch {
			case name == "SERVER_KEY":
				out = append(out, push(xonly(keyN(11)))...)
			case strings.HasPrefix(name, "EMULATOR_KEY"):
				out = append(out, push(xonly(keyN(12)))...)
			case name == "COSIGNER_KEY":
				out = append(out, push(xonly(keyN(13)))...)
			case ints[name] != 0 || types[name] == "int":
				v, ok := ints[name]
				if !ok {
					v = 1_000_000_000
				}
				out = append(out, push(n64(v))...)
			case byts[name] != nil:
				out = append(out, asmData(byts[name])...)
			case types[name] == "pubkey":
				out = append(out, push(xonly(keyN(byte(len(name)+20))))...)
			default:
				d := sha256.Sum256([]byte(name))
				out = append(out, asmData(d[:])...)
			}
		default:
			panic("unsupported token " + tok)
		}
	}
	return out
}

// asmData keeps the executor's quirk: a lone 0x00 is OP_DATA_1 0x00, not OP_0.
func asmData(d []byte) []byte {
	if len(d) == 1 && d[0] == 0 {
		return []byte{txscript.OP_DATA_1, 0}
	}
	return push(d)
}

type executorScripts struct {
	Source      string `json:"source"`
	Expressions []struct {
		Tokens []string `json:"tokens"`
		Files  []string `json:"files"`
	} `json:"expressions"`
	Covenants []struct {
		Name   string       `json:"name"`
		Asm    []string     `json:"asm"`
		Inputs []typedInput `json:"inputs"`
		Files  []string     `json:"files"`
	} `json:"covenants"`
}

const executorScriptsFile = "testdata/executor-v1-af8d9eb.json"

// extractExecutor reads the executor's template/v1 vectors once into testdata, so
// a normal run depends on no checkout but the one this module pins.
func extractExecutor(dir string) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil || len(files) == 0 {
		fatal("no executor vectors in %s (%v)", dir, err)
	}
	sort.Strings(files)
	exprs := map[string][]string{}
	type cov struct {
		name, key string
		asm       []string
		inputs    []typedInput
		files     []string
	}
	covs := map[string]*cov{}
	exprRE := regexp.MustCompile(`\$\(([^)]*)\)`)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			fatal("%v", err)
		}
		base := filepath.Base(f)
		var doc any
		if err := json.Unmarshal(raw, &doc); err != nil {
			fatal("%s: %v", base, err)
		}
		var walk func(v any, inputs []typedInput)
		walk = func(v any, inputs []typedInput) {
			switch t := v.(type) {
			case map[string]any:
				if ci, ok := t["constructorInputs"]; ok {
					b, _ := json.Marshal(ci)
					_ = json.Unmarshal(b, &inputs)
				}
				if fns, ok := t["functions"].([]any); ok {
					for _, fn := range fns {
						b, _ := json.Marshal(fn)
						var af artifactFn
						_ = json.Unmarshal(b, &af)
						if af.Arkade == nil {
							continue
						}
						key := strings.Join(af.Arkade.Asm, " ")
						if covs[key] == nil {
							covs[key] = &cov{name: af.Name, key: key, asm: af.Arkade.Asm, inputs: inputs}
						}
						c := covs[key]
						if len(c.files) == 0 || c.files[len(c.files)-1] != base {
							c.files = append(c.files, base)
						}
					}
				}
				keys := make([]string, 0, len(t))
				for k := range t {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				for _, k := range keys {
					walk(t[k], inputs)
				}
			case []any:
				for _, e := range t {
					walk(e, inputs)
				}
			case string:
				for _, m := range exprRE.FindAllStringSubmatch(t, -1) {
					if fs := exprs[m[1]]; len(fs) == 0 || fs[len(fs)-1] != base {
						exprs[m[1]] = append(fs, base)
					}
				}
			}
		}
		walk(doc, nil)
	}
	var out executorScripts
	out.Source = "arkade-os/executor@af8d9eb pkg/template/testdata/vectors/v1"
	keys := make([]string, 0, len(exprs))
	for k := range exprs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out.Expressions = append(out.Expressions, struct {
			Tokens []string `json:"tokens"`
			Files  []string `json:"files"`
		}{strings.Split(k, " "), exprs[k]})
	}
	ckeys := make([]string, 0, len(covs))
	for k := range covs {
		ckeys = append(ckeys, k)
	}
	sort.Strings(ckeys)
	for _, k := range ckeys {
		c := covs[k]
		out.Covenants = append(out.Covenants, struct {
			Name   string       `json:"name"`
			Asm    []string     `json:"asm"`
			Inputs []typedInput `json:"inputs"`
			Files  []string     `json:"files"`
		}{c.name, c.asm, c.inputs, c.files})
	}
	strs := func(ss []string) []any {
		l := make([]any, len(ss))
		for i, x := range ss {
			l[i] = x
		}
		return l
	}
	var exl, cvl []any
	for _, e := range out.Expressions {
		exl = append(exl, obj{{"tokens", strs(e.Tokens)}, {"files", strs(e.Files)}})
	}
	for _, c := range out.Covenants {
		ins := []any{}
		for _, in := range c.Inputs {
			ins = append(ins, obj{{"name", in.Name}, {"type", in.Type}})
		}
		cvl = append(cvl, obj{{"name", c.Name}, {"asm", strs(c.Asm)}, {"inputs", ins}, {"files", strs(c.Files)}})
	}
	doc := obj{{"source", out.Source}, {"expressions", exl}, {"covenants", cvl}}
	if err := os.MkdirAll("testdata", 0o755); err != nil {
		fatal("%v", err)
	}
	if err := os.WriteFile(executorScriptsFile, render(doc), 0o644); err != nil {
		fatal("%v", err)
	}
	fmt.Printf("extracted %d expressions, %d covenants\n", len(out.Expressions), len(out.Covenants))
}

func covenantHand() []*Case {
	b := &book{}
	b.cov("covenant/witness-over-520-unchecked", "", "2.7/witness-unchecked", sc(o(OP_SIZE), 600, o(OP_NUMEQUALVERIFY, OP_DROP, OP_1)), [][]byte{rep(7, 600)})
	b.cov("covenant/clean-stack", "", "", sc(o(OP_1, OP_1)), nil)
	b.cov("covenant/false-result", "", "", sc(o(OP_0)), nil)
	b.cov("covenant/empty-result-is-clean-stack", "", "", sc(o(OP_1, OP_DROP)), nil)
	b.cov("covenant/negative-zero-result", "", "3.1/asbool-negative-zero", sc([]byte{0x80}), nil)
	b.cov("covenant/witness-only-true", "", "", sc(o(OP_NOP)), [][]byte{{1}})
	d := defaultWorld()
	b.cov("covenant/prevout-sweep-fails-closed", "", "2.6/fetcher-nil", sc(o(OP_1)), nil, inW(&world{name: "in1-unfetchable", tx: d.tx, prevouts: d.prevouts[:1]}))
	b.cov("covenant/script-too-big", "", "", raw(rep(OP_NOP, 10001)), nil)
	b.cov("covenant/input-index-out-of-range-panics", "", "", sc(o(OP_1)), nil, at(5, 0))
	b.cov("covenant/malformed-push", "", "", sc(raw{OP_DATA_5, 1}), nil)
	pub := xonly(sigKey)
	checksigs := func(n int) []byte {
		s := sc()
		for range n {
			s = append(s, sc([]byte{}, pub, o(OP_CHECKSIG, OP_DROP))...)
		}
		return append(s, OP_1)
	}
	b.cov("covenant/metering/checksig-at-limit", OP_CHECKSIG, "2.9/charge", checksigs(50), nil)
	b.cov("covenant/metering/checksig-over-limit-even-empty-sig", OP_CHECKSIG, "2.9/charge", checksigs(51), nil)
	b.cov("covenant/metering/exact-limits-replace", OP_CHECKSIG, "2.9/charge", checksigs(51), nil, lim(ComputeLimits{OP_CHECKSIG: 51}))
	b.cov("covenant/metering/empty-exact-limits-unlimited", OP_CHECKSIG, "2.9/charge", checksigs(60), nil, lim(ComputeLimits{}))
	b.cov("covenant/metering/zero-limit-forbids", OP_CHECKSIG, "2.9/charge", checksigs(1), nil, lim(ComputeLimits{OP_CHECKSIG: 0}))
	b.cov("covenant/metering/budget-within", OP_CHECKSIG, "2.9/charge", checksigs(3), nil, budget(ComputeLimits{OP_CHECKSIG: 3}))
	b.cov("covenant/metering/budget-exhausted", OP_CHECKSIG, "2.9/charge", checksigs(4), nil, budget(ComputeLimits{OP_CHECKSIG: 3}))
	b.cov("covenant/metering/per-input-limit-charged-before-budget", OP_CHECKSIG, "2.9/charge", checksigs(3), nil,
		lim(ComputeLimits{OP_CHECKSIG: 2}), budget(ComputeLimits{OP_CHECKSIG: 10}))
	b.cov("covenant/metering/budget-of-other-opcode-ignored", OP_CHECKSIG, "2.9/charge", checksigs(5), nil, budget(ComputeLimits{OP_ECADD: 0}))
	dead := sc(o(OP_0, OP_IF))
	dead = append(dead, checksigs(60)[:len(checksigs(60))-1]...)
	b.cov("covenant/metering/dead-branch-not-charged", OP_CHECKSIG, "2.9/charge", append(dead, sc(o(OP_ENDIF, OP_1))...), nil)
	modexps := func(n int) []byte {
		s := sc()
		for range n {
			s = append(s, sc(2, 3, 5, o(OP_MODEXP, OP_DROP))...)
		}
		return append(s, OP_1)
	}
	b.cov("covenant/metering/modexp-over-limit", OP_MODEXP, "2.9/charge", modexps(65), nil)
	b.ex("covenant/metering/expression-mode-unmetered", OP_MODEXP, "2.9/charge", modexps(65))
	other := sc(xonly(keyN(2)), o(OP_CHECKSIGVERIFY), xonly(keyN(3)), o(OP_CHECKSIG))
	b.cov("covenant/sighash-commits-to-spending-leaf", OP_SIGHASH, "3.8/tag-arkade-tapsighash",
		sc(0, o(OP_SIGHASH), sighashFor(d, 0, other, 0), o(OP_EQUAL)), nil, leafM(other))
	timedSavings(b)
	executorCases(b)
	fuzzSeeds(b)
	return b.cases
}

func timedSavings(b *book) {
	raw, err := os.ReadFile("../fixtures/arkade/timed-savings.json")
	if err != nil {
		fatal("%v", err)
	}
	var art struct {
		ConstructorInputs []typedInput `json:"constructorInputs"`
		Functions         []artifactFn `json:"functions"`
	}
	if err := json.Unmarshal(raw, &art); err != nil {
		fatal("timed-savings.json: %v", err)
	}
	payout := sha256.Sum256([]byte("payout"))
	fns := map[string]artifactFn{}
	for _, f := range art.Functions {
		if f.Arkade != nil {
			fns[f.Name] = f
		}
	}
	build := func(fn string, releaseAt int64) ([]byte, []byte) {
		f := fns[fn]
		ints := map[string]int64{"releaseAt": releaseAt}
		byts := map[string][]byte{"payout": payout[:]}
		script := assemble(f.Arkade.Asm, art.ConstructorInputs, ints, byts)
		leaf := assemble(f.Leaves[0].Asm, art.ConstructorInputs, map[string]int64{"releaseAt": 1_000_000_000}, byts)
		return script, leaf
	}
	payoutScript := append([]byte{txscript.OP_1, 32}, payout[:]...)
	anchor := []byte{txscript.OP_1, 2, 0x4e, 0x73}
	in := outpoint("savings", 0)
	vtxo := p2tr(30)
	mk := func(name string, f func(tx *wire.MsgTx)) *world {
		tx := wire.NewMsgTx(3)
		tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in, Sequence: wire.MaxTxInSequenceNum})
		tx.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: payoutScript})
		tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: 2, Data: []byte{1}}))
		tx.AddTxOut(&wire.TxOut{Value: 0, PkScript: anchor})
		f(tx)
		return &world{name: "timed-savings-" + name, tx: tx, prevouts: []prevout{
			{op: in, out: &wire.TxOut{Value: 10_000, PkScript: vtxo}, vtxo: vtxo},
			{op: outpoint("message", 0), out: &wire.TxOut{Value: 0, PkScript: vtxo}, vtxo: vtxo},
		}}
	}
	past, future := int64(1_000_000_000), int64(1)<<40
	rel := func(name string, releaseAt int64, f func(tx *wire.MsgTx)) {
		s, l := build("release", releaseAt)
		b.cov("covenant/timed-savings/release-"+name, "", "", s, nil, inW(mk("release-"+name, f)), leafM(l))
	}
	rel("matured", past, func(*wire.MsgTx) {})
	rel("still-locked", future, func(*wire.MsgTx) {})
	rel("wrong-payout", past, func(tx *wire.MsgTx) { tx.TxOut[0].PkScript = p2tr(31) })
	rel("principal-changed", past, func(tx *wire.MsgTx) { tx.TxOut[0].Value = 9_999 })
	rel("anchor-not-zero", past, func(tx *wire.MsgTx) { tx.TxOut[2].Value = 1 })
	rel("four-outputs", past, func(tx *wire.MsgTx) { tx.AddTxOut(&wire.TxOut{PkScript: anchor}) })
	renew := func(name string, releaseAt int64, idx int, f func(tx *wire.MsgTx)) {
		s, l := build("renew", releaseAt)
		w := mk("renew-"+name, func(tx *wire.MsgTx) {
			tx.Version = 2
			tx.TxIn = append([]*wire.TxIn{{PreviousOutPoint: outpoint("message", 0), Sequence: wire.MaxTxInSequenceNum}}, tx.TxIn...)
			tx.TxOut = []*wire.TxOut{{Value: 10_000, PkScript: vtxo}}
			f(tx)
		})
		b.cov("covenant/timed-savings/renew-"+name, "", "", s, nil, inW(w), at(idx, 0), leafM(l))
	}
	renew("before-release", future, 1, func(*wire.MsgTx) {})
	renew("mature-must-release", past, 1, func(*wire.MsgTx) {})
	renew("wrong-index", future, 0, func(*wire.MsgTx) {})
	renew("version-3", future, 1, func(tx *wire.MsgTx) { tx.Version = 3 })
	renew("script-changed", future, 1, func(tx *wire.MsgTx) { tx.TxOut[0].PkScript = p2tr(32) })
}

func executorCases(b *book) {
	raw, err := os.ReadFile(executorScriptsFile)
	if err != nil {
		fatal("%v (regenerate with -extract-executor <executor>/pkg/template/testdata/vectors/v1)", err)
	}
	var es executorScripts
	if err := json.Unmarshal(raw, &es); err != nil {
		fatal("%v", err)
	}
	src := outpoint("executor-source", 0)
	parent := wire.NewMsgTx(3)
	parent.AddTxIn(&wire.TxIn{PreviousOutPoint: outpoint("executor-parent", 0)})
	parent.AddTxOut(&wire.TxOut{Value: 100_000, PkScript: p2tr(14)})
	parent.AddTxOut(extOut(extension.UnknownPacket{PacketType: 2, Data: n64LE(41)}))
	draft := wire.NewMsgTx(2)
	draft.AddTxIn(&wire.TxIn{PreviousOutPoint: src, Sequence: wire.MaxTxInSequenceNum})
	w := &world{name: "executor-draft", tx: draft, prevouts: []prevout{
		{op: src, out: &wire.TxOut{Value: 100_000, PkScript: p2tr(14)}, arkTx: parent, vtxo: p2tr(14)},
	}}
	// a trigger TLV: 6 header bytes, then the 32-byte value `6 32 OP_SUBSTR` extracts
	tlv := append(rep(0x06, 6), rep(0x77, 32)...)
	byts := map[string][]byte{"preimage": []byte("secret"), "tlv:2": tlv}
	for i, e := range es.Expressions {
		script := assemble(e.Tokens, nil, map[string]int64{"refund_locktime": 500_000}, byts)
		b.ex("covenant/executor/expression-"+itoa(i)+"-"+strings.Join(e.Files[:1], ""), "", "", script, inW(w), at(0, 100_000))
	}
	for i, c := range es.Covenants {
		script := assemble(c.Asm, c.Inputs, nil, nil)
		name := "covenant/executor/arkade-" + itoa(i) + "-" + c.Name
		if !hasOpcode(script, OP_PUSHEXPIRY) {
			b.cov(name, "", "", script, nil)
			continue
		}
		// the service supplies the VTXO expiry for these; one far past, one far future
		b.cov(name+"/expiry-past", "", "", script, nil, exp(1_500_000_000))
		b.cov(name+"/expiry-future", "", "", script, nil, exp(1<<40))
	}
}

func n64LE(v uint64) []byte {
	out := make([]byte, 8)
	for i := range out {
		out[i] = byte(v >> (8 * i))
	}
	return out
}

// fuzzSeeds replays the emulator's minimised fuzz inputs as scripts and packets.
func fuzzSeeds(b *book) {
	dir := moduleDir("github.com/arkade-os/emulator/pkg/arkade")
	for _, target := range []string{"FuzzOpcodes", "FuzzDeserializeEmulatorPacket"} {
		files, _ := filepath.Glob(filepath.Join(dir, "testdata", "fuzz", target, "*"))
		sort.Strings(files)
		for _, f := range files {
			data := fuzzBytes(f)
			name := "covenant/fuzz/" + target + "/" + filepath.Base(f)
			if target == "FuzzOpcodes" {
				b.ex(name+"/expression", "", "", data)
				b.cov(name+"/covenant", "", "", data, nil)
				continue
			}
			w := txWith("fuzz-"+filepath.Base(f), func(tx *wire.MsgTx) {
				tx.AddTxOut(extOut(extension.UnknownPacket{PacketType: PacketType, Data: data}))
			})
			b.cov(name, "", "3.12/emulator-packet-validation", sc(o(OP_1)), nil, inW(w))
		}
	}
}

func fuzzBytes(path string) []byte {
	raw, err := os.ReadFile(path)
	if err != nil {
		fatal("%v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if len(lines) != 2 || lines[0] != "go test fuzz v1" || !strings.HasPrefix(lines[1], "[]byte(") {
		fatal("%s: unexpected fuzz corpus format", path)
	}
	s, err := strconv.Unquote(strings.TrimSuffix(strings.TrimPrefix(lines[1], "[]byte("), ")"))
	if err != nil {
		fatal("%s: %v", path, err)
	}
	return []byte(s)
}

// hasOpcode tokenizes, as the service's hasPushExpiryOpcode does (utils.go:395).
func hasOpcode(script []byte, op byte) bool {
	tok := MakeScriptTokenizer(0, script)
	for tok.Next() {
		if tok.Opcode() == op {
			return true
		}
	}
	return false
}
