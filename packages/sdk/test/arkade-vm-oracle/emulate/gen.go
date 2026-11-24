// Go-derived expectations for packages/sdk/test/arkade-vm-emulate.test.ts.
// Mutations operate on raw PSBT key-value maps, exactly as the TS test does, and every
// case records sha256 over its base64 inputs so the TS side proves it built the same bytes.
package emulate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	arkintent "github.com/arkade-os/arkd/pkg/ark-lib/intent"
	"github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type pair struct{ k, v []byte }

type rawPsbt struct {
	global          []pair
	inputs, outputs [][]pair
}

func readVarBytes(r *bytes.Reader) []byte {
	n, err := wire.ReadVarInt(r, 0)
	must(err)
	b := make([]byte, n)
	_, err = io.ReadFull(r, b)
	must(err)
	return b
}

func decodeRaw(b []byte) *rawPsbt {
	r := bytes.NewReader(b[5:])
	readMap := func() []pair {
		var m []pair
		for {
			k := readVarBytes(r)
			if len(k) == 0 {
				return m
			}
			m = append(m, pair{k, readVarBytes(r)})
		}
	}
	p := &rawPsbt{global: readMap()}
	tx := p.tx()
	for range tx.TxIn {
		p.inputs = append(p.inputs, readMap())
	}
	for range tx.TxOut {
		p.outputs = append(p.outputs, readMap())
	}
	return p
}

func (p *rawPsbt) encode() []byte {
	var w bytes.Buffer
	w.Write([]byte{0x70, 0x73, 0x62, 0x74, 0xff})
	writeMap := func(m []pair) {
		for _, kv := range m {
			must(wire.WriteVarBytes(&w, 0, kv.k))
			must(wire.WriteVarBytes(&w, 0, kv.v))
		}
		w.WriteByte(0)
	}
	writeMap(p.global)
	for _, m := range p.inputs {
		writeMap(m)
	}
	for _, m := range p.outputs {
		writeMap(m)
	}
	return w.Bytes()
}

func (p *rawPsbt) tx() *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	must(tx.DeserializeNoWitness(bytes.NewReader(p.global[0].v)))
	return tx
}

func (p *rawPsbt) setTx(tx *wire.MsgTx) {
	var w bytes.Buffer
	must(tx.SerializeNoWitness(&w))
	p.global[0].v = w.Bytes()
}

// set replaces the first pair keyed k, deletes it when v is nil, or appends.
func set(m []pair, k, v []byte) []pair {
	for i, kv := range m {
		if bytes.Equal(kv.k, k) {
			if v == nil {
				return slices.Delete(slices.Clone(m), i, i+1)
			}
			out := slices.Clone(m)
			out[i] = pair{k, v}
			return out
		}
	}
	if v == nil {
		return m
	}
	return append(slices.Clone(m), pair{k, v})
}

func get(m []pair, k []byte) []byte {
	for _, kv := range m {
		if bytes.Equal(kv.k, k) {
			return slices.Clone(kv.v)
		}
	}
	panic(fmt.Sprintf("no key %x", k))
}

func byType(m []pair, t byte) int {
	for i, kv := range m {
		if kv.k[0] == t {
			return i
		}
	}
	panic(fmt.Sprintf("no key type %x", t))
}

var (
	witnessUtxoKey = []byte{0x01}
	prevArkKey     = append([]byte{0xde}, "prevarktx"...)
	prevoutKey     = append([]byte{0xde}, "prevouttx"...)
)

// extensionScript is OP_RETURN <"ARK" 0x01 len packet>, one emulator entry with no witness.
func extensionScript(vin uint16, entryScript, trailing []byte) []byte {
	pkt := []byte{0x01}
	pkt = binary.LittleEndian.AppendUint16(pkt, vin)
	pkt = append(pkt, byte(len(entryScript)))
	pkt = append(pkt, entryScript...)
	pkt = append(pkt, 0x00)
	pkt = append(pkt, trailing...)
	data := append([]byte("ARK"), 0x01, byte(len(pkt)))
	data = append(data, pkt...)
	return append([]byte{0x6a, byte(len(data))}, data...)
}

// extensionWith wraps raw emulator packet bytes in OP_RETURN <"ARK" 0x01 len packet>.
func extensionWith(pkt []byte) []byte {
	data := append([]byte("ARK"), 0x01, byte(len(pkt)))
	data = append(data, pkt...)
	return append([]byte{0x6a, byte(len(data))}, data...)
}

func replaceExtension(p *rawPsbt, ext []byte) {
	tx := p.tx()
	for _, out := range tx.TxOut {
		if len(out.PkScript) > 0 && out.PkScript[0] == 0x6a {
			out.PkScript = ext
		}
	}
	p.setTx(tx)
}

type fixture struct {
	Name        string   `json:"name"`
	ArkTx       string   `json:"arkTx"`
	Checkpoints []string `json:"checkpoints"`
	Proof       string   `json:"proof"`
	Message     string   `json:"message"`
	Tx          string   `json:"tx"`
}

func loadFixture(dir, file, name string) fixture {
	raw, err := os.ReadFile(dir + "/" + file)
	must(err)
	var fix struct{ Valid, Invalid []fixture }
	must(json.Unmarshal(raw, &fix))
	for _, f := range append(fix.Valid, fix.Invalid...) {
		if f.Name == name {
			return f
		}
	}
	panic("fixture " + name)
}

func b64d(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	must(err)
	return b
}

type serviceCase struct {
	name, variant string
	psbt          []byte
	checkpoints   [][]byte // nil entry: Go's nil checkpoint
	message       string
	limits        arkade.ComputeLimits
}

type request struct {
	Txid           string   `json:"txid"`
	InputIndex     int      `json:"inputIndex"`
	ScriptHash     string   `json:"scriptHash"`
	ClosurePubKeys []string `json:"closurePubKeys"`
}

type outcome struct {
	Name       string    `json:"name"`
	Digest     string    `json:"digest"`
	ParseError string    `json:"parseError,omitempty"`
	Error      string    `json:"error,omitempty"`
	Code       string    `json:"code,omitempty"`
	Requests   []request `json:"requests,omitempty"`
}

func digest(c serviceCase) string {
	parts := []string{base64.StdEncoding.EncodeToString(c.psbt)}
	for _, cp := range c.checkpoints {
		parts = append(parts, base64.StdEncoding.EncodeToString(cp))
	}
	h := sha256.Sum256([]byte(strings.Join(parts, ",")))
	return hex.EncodeToString(h[:])
}

func parse(b []byte) (*psbt.Packet, error) {
	if b == nil {
		return nil, nil
	}
	return psbt.NewFromRawBytes(bytes.NewReader(b), false)
}

func run(c serviceCase) outcome {
	o := outcome{Name: c.name, Digest: digest(c)}
	ptx, err := parse(c.psbt)
	if err != nil {
		o.ParseError = err.Error()
		return o
	}
	var cps []*psbt.Packet
	for _, b := range c.checkpoints {
		cp, err := parse(b)
		if err != nil {
			o.ParseError = err.Error()
			return o
		}
		cps = append(cps, cp)
	}
	limits := c.limits
	if limits == nil {
		limits = arkade.DefaultComputeLimits()
	}
	svc := emulator.New(limits)
	data := emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}}
	var reqs []emulator.SignRequest
	switch c.variant {
	case "offchain":
		reqs, err = svc.EmulateOffchainTx(context.Background(), emulator.OffchainTx{ArkTx: ptx, Checkpoints: cps}, data)
	case "proof":
		reqs, err = svc.EmulateBatchRegistration(context.Background(), emulator.Proof{Proof: arkintent.Proof{Packet: *ptx}, Message: c.message}, data)
	default:
		reqs, err = svc.EmulateOnchainTx(context.Background(), emulator.OnchainTx{Tx: ptx})
	}
	if err != nil {
		o.Error = err.Error()
		var se txscript.Error
		if errors.As(err, &se) {
			o.Code = se.ErrorCode.String()
		}
		return o
	}
	for _, r := range reqs {
		keys := []string{}
		for _, k := range r.ClosurePubKeys {
			keys = append(keys, hex.EncodeToString(schnorr.SerializePubKey(k)))
		}
		o.Requests = append(o.Requests, request{r.Packet.UnsignedTx.TxID(), r.InputIndex, hex.EncodeToString(r.ScriptHash), keys})
	}
	return o
}

func serviceCases(dir string) []serviceCase {
	off := loadFixture(dir, "offchain_tx.json", "single vtxo")
	arkB, cpB := b64d(off.ArkTx), b64d(off.Checkpoints[0])
	ark := func() *rawPsbt { return decodeRaw(arkB) }
	offchain := func(name string, p *rawPsbt, cps ...[]byte) serviceCase {
		if len(cps) == 0 {
			cps = [][]byte{cpB}
		}
		return serviceCase{name: name, variant: "offchain", psbt: p.encode(), checkpoints: cps}
	}
	var cases []serviceCase

	p := ark()
	p.inputs[0] = set(p.inputs[0], witnessUtxoKey, nil)
	cases = append(cases, offchain("ark input without witness utxo", p))

	p = ark()
	p.inputs[0] = append(slices.Clone(p.inputs[0]), pair{prevArkKey, append(get(p.inputs[0], prevArkKey), 0x00)})
	cases = append(cases, offchain("two prevarktx fields", p))

	p = ark()
	p.inputs[0] = set(p.inputs[0], prevArkKey, append(get(p.inputs[0], prevArkKey), 0x00, 0x01))
	cases = append(cases, offchain("prevarktx with trailing bytes", p))

	p = ark()
	prevArk := wire.NewMsgTx(2)
	must(prevArk.Deserialize(bytes.NewReader(get(p.inputs[0], prevArkKey))))
	var stripped bytes.Buffer
	must(prevArk.SerializeNoWitness(&stripped))
	raw := stripped.Bytes()
	// marker and flag, then an empty witness per input: a framing Serialize never writes
	flagged := slices.Concat(raw[:4], []byte{0x00, 0x01}, raw[4:len(raw)-4], make([]byte, len(prevArk.TxIn)), raw[len(raw)-4:])
	p.inputs[0] = set(p.inputs[0], prevArkKey, flagged)
	cases = append(cases, offchain("prevarktx with a superfluous witness record", p))

	p = ark()
	p.inputs[0] = append(slices.Clone(p.inputs[0]), pair{prevArkKey, get(p.inputs[0], prevArkKey)})
	cases = append(cases, offchain("identical prevarktx twice", p))

	cases = append(cases, offchain("nil checkpoint", ark(), nil))

	cp := decodeRaw(cpB)
	ctx := cp.tx()
	ctx.TxIn = nil
	cp.setTx(ctx)
	cp.inputs = nil
	p = ark()
	atx := p.tx()
	atx.TxIn[0].PreviousOutPoint.Hash = ctx.TxHash()
	p.setTx(atx)
	cases = append(cases, offchain("checkpoint without inputs", p, cp.encode()))

	p = ark()
	atx = p.tx()
	atx.TxIn[0].PreviousOutPoint.Index = 5
	p.setTx(atx)
	cases = append(cases, offchain("ark input vout beyond checkpoint outputs", p))

	p = ark()
	p.inputs[0] = slices.Delete(slices.Clone(p.inputs[0]), byType(p.inputs[0], 0x15), byType(p.inputs[0], 0x15)+1)
	cases = append(cases, offchain("ark input without tapleaf", p))

	p = ark()
	i := byType(p.inputs[0], 0x15)
	p.inputs[0] = slices.Clone(p.inputs[0])
	p.inputs[0][i] = pair{p.inputs[0][i].k, []byte{0x51, 0xc0}}
	cases = append(cases, offchain("tapleaf decodes as no closure", p))

	p = ark()
	wu := get(p.inputs[0], witnessUtxoKey)
	wu[8] = 0x00
	p.inputs[0] = set(p.inputs[0], witnessUtxoKey, wu)
	cases = append(cases, offchain("witness utxo script length byte is not read", p))

	p = ark()
	replaceExtension(p, extensionScript(0, []byte{0x02, 0x01}, nil))
	cases = append(cases, offchain("malformed script fails expiry scan", p))

	p = ark()
	replaceExtension(p, extensionScript(0, []byte{0x51}, []byte{0x00}))
	cases = append(cases, offchain("emulator packet with trailing byte", p))

	intent := loadFixture(dir, "intent.json", "only message input entry")
	pr := decodeRaw(b64d(intent.Proof))
	ptx := pr.tx()
	ptx.TxIn = ptx.TxIn[:1]
	pr.setTx(ptx)
	pr.inputs = pr.inputs[:1]
	cases = append(cases, serviceCase{name: "proof with only its message input", variant: "proof", psbt: pr.encode(), message: intent.Message})

	on := loadFixture(dir, "onchain_tx.json", "single input")
	onB := b64d(on.Tx)
	oc := decodeRaw(onB)
	prev := wire.NewMsgTx(2)
	must(prev.Deserialize(bytes.NewReader(get(oc.inputs[0], prevoutKey))))
	prev.TxOut[0].PkScript = []byte{0x51}
	var pb bytes.Buffer
	must(prev.Serialize(&pb))
	oc.inputs[0] = set(oc.inputs[0], prevoutKey, pb.Bytes())
	otx := oc.tx()
	otx.TxIn[0].PreviousOutPoint.Hash = prev.TxHash()
	oc.setTx(otx)
	wu = binary.LittleEndian.AppendUint64(nil, uint64(prev.TxOut[0].Value))
	oc.inputs[0] = set(oc.inputs[0], witnessUtxoKey, append(wu, 0x01, 0x51))
	cases = append(cases, serviceCase{name: "onchain input spending a non-taproot prevout", variant: "onchain", psbt: oc.encode()})

	oc = decodeRaw(onB)
	replaceExtension(oc, extensionScript(0, []byte{0x02, 0x01}, nil))
	cases = append(cases, serviceCase{name: "malformed script fails engine creation", variant: "onchain", psbt: oc.encode()})

	p = ark()
	i = byType(p.inputs[0], 0x15)
	p.inputs[0] = slices.Clone(p.inputs[0])
	k := slices.Clone(p.inputs[0][i].k)
	k[1] ^= 0x01
	p.inputs[0][i] = pair{k, p.inputs[0][i].v}
	cases = append(cases, offchain("ark input control block with the wrong parity", p))

	cp = decodeRaw(cpB)
	ctx = cp.tx()
	ctx.TxOut[0].PkScript = []byte{0x51}
	cp.setTx(ctx)
	p = ark()
	atx = p.tx()
	atx.TxIn[0].PreviousOutPoint.Hash = ctx.TxHash()
	p.setTx(atx)
	wu = get(p.inputs[0], witnessUtxoKey)
	p.inputs[0] = set(p.inputs[0], witnessUtxoKey, append(wu[:8:8], 0x01, 0x51))
	cases = append(cases, offchain("ark input witness utxo is not taproot", p, cp.encode()))

	p = ark()
	p.inputs[0] = set(p.inputs[0], prevArkKey, make([]byte, 1_000_001))
	cases = append(cases, offchain("prevarktx over the length cap", p))

	oc = decodeRaw(onB)
	i = byType(oc.inputs[0], 0x15)
	oc.inputs[0] = slices.Clone(oc.inputs[0])
	k = slices.Clone(oc.inputs[0][i].k)
	k[1] = 0xc2
	oc.inputs[0][i] = pair{k, oc.inputs[0][i].v}
	cases = append(cases, serviceCase{name: "control block leaf version differs from the leaf's", variant: "onchain", psbt: oc.encode()})

	cases = append(cases, serviceCase{name: "exact compute limits replace the defaults", variant: "onchain", psbt: onB, limits: arkade.ComputeLimits{txscript.OP_1: 0}})

	for _, pk := range []struct {
		name string
		pkt  []byte
	}{
		{"emulator packet without entries", []byte{0x00}},
		{"emulator entry with an empty script", []byte{0x01, 0x00, 0x00, 0x00, 0x00}},
		{"emulator entries sharing a vin", []byte{0x02, 0x00, 0x00, 0x01, 0x51, 0x00, 0x00, 0x00, 0x01, 0x51, 0x00}},
		{"emulator packet over the entry cap", []byte{0xfd, 0xe9, 0x03}},
		{"emulator entry vin beyond the inputs", []byte{0x01, 0x05, 0x00, 0x01, 0x51, 0x00}},
	} {
		p = ark()
		replaceExtension(p, extensionWith(pk.pkt))
		cases = append(cases, offchain(pk.name, p))
	}
	p = ark()
	replaceExtension(p, []byte{0x6a, 0x07, 0x41, 0x52, 0x4b, 0x01, 0x10, 0x00, 0x00})
	cases = append(cases, offchain("extension shorter than its packet length", p))
	return cases
}

var closureScripts = []string{
	"", "50",
	"20" + pk1 + "ac",
	"20" + pk1 + "ad20" + pk2 + "ac",
	"20" + pk1 + "ac20" + pk2 + "ba529c",
	"20" + pk1 + "ac20" + pk2 + "ba539c",
	"009c",
	"029000b27520" + pk1 + "ac",
	"03010040b27520" + pk1 + "ac",
	"03900001b27520" + pk1 + "ac",
	"050000008000b27520" + pk1 + "ac",
	"020500b27520" + pk1 + "ac",
	"0320a107b17520" + pk1 + "ac",
	"55b17520" + pk1 + "ac",
	"0105b17520" + pk1 + "ac",
	"0181b17520" + pk1 + "ac",
	"060000000000" + "01b17520" + pk1 + "ac",
	"07000000000000" + "01b17520" + pk1 + "ac",
	"516920" + pk1 + "ac",
	"a820" + strings.Repeat("ab", 32) + "876920" + pk1 + "ac",
	"ac6920" + pk1 + "ac",
	"4c01516920" + pk1 + "ac",
	"5169029000b27520" + pk1 + "ac",
	"516903900001b27520" + pk1 + "ac",
	"20" + strings.Repeat("00", 31) + "05ac",
	"20" + strings.Repeat("ff", 32) + "ac",
	"20" + pk1 + "ac4c",
	"51",
}

const (
	pk1 = "d231c179b485a576e303d0e4e7405dbf53d16ea296c09030f7110444e0c0cf6b"
	pk2 = "4d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766"
)

type closureOutcome struct {
	Script string   `json:"script"`
	Valid  bool     `json:"valid"`
	Keys   []string `json:"keys,omitempty"`
	Error  string   `json:"error,omitempty"`
}

func closureCases() []closureOutcome {
	var out []closureOutcome
	for _, s := range closureScripts {
		b, err := hex.DecodeString(s)
		must(err)
		o := closureOutcome{Script: s}
		c, err := script.DecodeClosure(b)
		if err != nil {
			o.Error = err.Error()
			out = append(out, o)
			continue
		}
		var keys []*btcec.PublicKey
		switch c := c.(type) {
		case *script.MultisigClosure:
			keys = c.PubKeys
		case *script.CSVMultisigClosure:
			keys = c.PubKeys
		case *script.CLTVMultisigClosure:
			keys = c.PubKeys
		case *script.ConditionMultisigClosure:
			keys = c.PubKeys
		case *script.ConditionCSVMultisigClosure:
			keys = c.PubKeys
		}
		o.Valid, o.Keys = true, []string{}
		for _, k := range keys {
			o.Keys = append(o.Keys, hex.EncodeToString(schnorr.SerializePubKey(k)))
		}
		out = append(out, o)
	}
	return out
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

// Generate replays the service mutations, closures and draft queries against the fixtures in dir.
func Generate(dir string, w io.Writer) {
	var svc []outcome
	for _, c := range serviceCases(dir) {
		svc = append(svc, run(c))
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	must(enc.Encode(map[string]any{"service": svc, "closures": closureCases(), "draft": draftCases()}))
}
