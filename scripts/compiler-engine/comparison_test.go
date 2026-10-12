package compilercomparison_test

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/btcutil/v2"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type variant struct {
	LeafHex            string            `json:"leafHex"`
	CovenantHex        string            `json:"covenantHex"`
	KeySecrets         map[string]string `json:"keySecrets"`
	ExpectedSignerKeys []string          `json:"expectedSignerKeys"`
}

type assetContext struct {
	TxidHex     string `json:"txidHex"`
	WireTxidHex string `json:"wireTxidHex"`
	GroupIndex  uint16 `json:"groupIndex"`
	Amount      string `json:"amount"`
}

type context struct {
	WantAmount          string        `json:"wantAmount"`
	MakerPkScript       string        `json:"makerPkScript"`
	WantAssetTxid       string        `json:"wantAssetTxid"`
	WantAssetGroupIndex uint16        `json:"wantAssetGroupIndex"`
	Path                string        `json:"path"`
	Version             string        `json:"version"`
	Profile             string        `json:"profile"`
	PreimageHex         string        `json:"preimageHex"`
	InputIndex          int           `json:"inputIndex"`
	InputValue          string        `json:"inputValue"`
	DestinationHex      string        `json:"destinationHex"`
	InputAsset          *assetContext `json:"inputAsset"`
	RefundLocktime      uint32        `json:"refundLocktime,string"`
	Sequence            uint32        `json:"sequence,string"`
}

type comparison struct {
	Name      string  `json:"name"`
	Kind      string  `json:"kind"`
	Context   context `json:"context"`
	Manual    variant `json:"manual"`
	Generated variant `json:"generated"`
}

type result struct {
	Name               string `json:"name"`
	Scope              string `json:"scope"`
	Kind               string `json:"kind"`
	Optimization       string `json:"optimization"`
	MoneyDomain        string `json:"moneyDomain"`
	Mutation           string `json:"mutation"`
	ManualAccepted     bool   `json:"manualAccepted"`
	GeneratedAccepted  bool   `json:"generatedAccepted"`
	ManualError        string `json:"manualError,omitempty"`
	GeneratedError     string `json:"generatedError,omitempty"`
	ExpectedEquivalent bool   `json:"expectedEquivalent"`
}

type fetcher struct{ txscript.PrevOutputFetcher }

func (fetcher) FetchPrevOutArkTx(wire.OutPoint) *wire.MsgTx { return nil }
func (f fetcher) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	return f.FetchPrevOutput(op).PkScript
}

func decode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func amount(t *testing.T, s string) uint64 {
	t.Helper()
	if s == "" {
		return 0
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

type spend struct {
	Tx      *wire.MsgTx
	Fetcher fetcher
	Packet  asset.Packet
	Vin     int
	Vout    int
}

func baseSpend(t *testing.T, c comparison) spend {
	t.Helper()
	x := c.Context
	tx := wire.NewMsgTx(2)
	prev := map[wire.OutPoint]*wire.TxOut{}
	for i := 0; i <= x.InputIndex; i++ {
		op := wire.OutPoint{Hash: chainhash.Hash{byte(i + 1)}}
		tx.AddTxIn(wire.NewTxIn(&op, nil, nil))
		prev[op] = wire.NewTxOut(int64(amount(t, x.InputValue)), []byte{0x51})
	}
	tx.TxIn[x.InputIndex].Sequence = x.Sequence
	tx.LockTime = x.RefundLocktime
	value := amount(t, x.InputValue)
	destination := x.DestinationHex
	if strings.HasPrefix(c.Kind, "swap-") {
		if c.Kind == "swap-btc" {
			value = amount(t, x.WantAmount)
		}
		if value > math.MaxInt64 {
			value = math.MaxInt64
		}
		destination = x.MakerPkScript
	}
	vout := x.InputIndex
	if strings.HasPrefix(c.Kind, "swap-") {
		vout = 0
	}
	for i := 0; i < vout; i++ {
		tx.AddTxOut(wire.NewTxOut(1, []byte{0x51}))
	}
	tx.AddTxOut(wire.NewTxOut(int64(value), decode(t, destination)))
	s := spend{tx, fetcher{txscript.NewMultiPrevOutFetcher(prev)}, nil, x.InputIndex, vout}
	var id asset.AssetId
	var units uint64
	if c.Kind == "swap-asset" {
		copy(id.Txid[:], decode(t, x.WantAssetTxid))
		id.Index = x.WantAssetGroupIndex
		units = amount(t, x.WantAmount)
	} else if x.InputAsset != nil {
		copy(id.Txid[:], decode(t, x.InputAsset.WireTxidHex))
		id.Index = x.InputAsset.GroupIndex
		units = amount(t, x.InputAsset.Amount)
	} else {
		return s
	}
	s.Packet = asset.Packet{{AssetId: &id, Inputs: []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: uint16(s.Vin), Amount: units}}, Outputs: []asset.AssetOutput{{Vout: uint16(s.Vout), Amount: units}}}}
	return s
}

func executeCovenant(t *testing.T, c comparison, v variant, s spend) error {
	t.Helper()
	engine, err := arkade.NewEngine(decode(t, v.CovenantHex), s.Tx, s.Vin, txscript.NewSigCache(100), txscript.NewTxSigHashes(s.Tx, s.Fetcher), s.Fetcher.FetchPrevOutput(s.Tx.TxIn[s.Vin].PreviousOutPoint).Value, s.Fetcher)
	if err != nil {
		return err
	}
	engine.SetAssetPacket(s.Packet)
	return engine.Execute()
}

func mutations(c comparison) []string {
	m := []string{"valid", "wrong-destination", "witness-v0", "witness-v2", "missing-output", "extra-output"}
	value := amountNoTest(c.Context.InputValue)
	if c.Kind == "swap-btc" {
		value = amountNoTest(c.Context.WantAmount)
	}
	if value > 0 {
		m = append(m, "underpay")
	}
	if value < math.MaxInt64 {
		m = append(m, "overpay")
	}
	if c.Kind == "swap-asset" || c.Context.InputAsset != nil {
		m = append(m, "asset-absent", "asset-wrong-id", "asset-wrong-group", "asset-wrong-output-index", "asset-extra-count")
		units := amountNoTest(c.Context.WantAmount)
		if c.Context.InputAsset != nil {
			units = amountNoTest(c.Context.InputAsset.Amount)
		}
		if units > 0 {
			m = append(m, "asset-underpay")
		}
		if units < math.MaxUint64 {
			m = append(m, "asset-overpay")
		}
		if c.Context.InputAsset != nil {
			m = append(m, "asset-wrong-input-index", "asset-input-absent", "asset-boundary-zero", "asset-boundary-one", "asset-boundary-int64", "asset-boundary-uint64")
		}
	}
	return m
}

func mutate(s *spend, name string) {
	switch name {
	case "underpay":
		s.Tx.TxOut[s.Vout].Value--
	case "overpay":
		s.Tx.TxOut[s.Vout].Value++
	case "wrong-destination":
		s.Tx.TxOut[s.Vout].PkScript[len(s.Tx.TxOut[s.Vout].PkScript)-1] ^= 1
	case "witness-v0":
		s.Tx.TxOut[s.Vout].PkScript[0] = 0
	case "witness-v2":
		s.Tx.TxOut[s.Vout].PkScript[0] = 0x52
	case "missing-output":
		s.Tx.TxOut = s.Tx.TxOut[:s.Vout]
	case "extra-output":
		s.Tx.AddTxOut(wire.NewTxOut(1, []byte{0x51}))
	case "asset-underpay":
		s.Packet[0].Outputs[0].Amount--
	case "asset-overpay":
		s.Packet[0].Outputs[0].Amount++
	case "asset-absent":
		s.Packet = nil
	case "asset-wrong-id":
		s.Packet[0].AssetId.Txid[0] ^= 1
	case "asset-wrong-group":
		s.Packet[0].AssetId.Index ^= 1
	case "asset-wrong-output-index":
		s.Packet[0].Outputs[0].Vout = uint16(s.Vout) ^ 1
	case "asset-wrong-input-index":
		s.Packet[0].Inputs[0].Vin = uint16(s.Vin + 1)
	case "asset-input-absent":
		s.Packet[0].Inputs = nil
	case "asset-boundary-zero", "asset-boundary-one", "asset-boundary-int64", "asset-boundary-uint64":
		units := map[string]uint64{"asset-boundary-zero": 0, "asset-boundary-one": 1, "asset-boundary-int64": math.MaxInt64, "asset-boundary-uint64": math.MaxUint64}[name]
		s.Packet[0].Inputs[0].Amount = units
		s.Packet[0].Outputs[0].Amount = units
	case "asset-extra-count":
		other := *s.Packet[0].AssetId
		other.Index ^= 1
		s.Packet = append(s.Packet, asset.AssetGroup{AssetId: &other, Outputs: []asset.AssetOutput{{Vout: uint16(s.Vout), Amount: 1}}})
	}
}

func expected(c comparison, mutation string) bool {
	if strings.HasPrefix(mutation, "asset-boundary-") {
		return true
	}
	if c.Kind == "swap-btc" && amountNoTest(c.Context.WantAmount) > btcutil.MaxSatoshi {
		return false
	}
	if c.Kind == "swap-asset" && mutation == "underpay" {
		return true
	}
	if c.Kind == "swap-asset" && mutation == "asset-underpay" && amountNoTest(c.Context.WantAmount) == 0 {
		return true
	}
	if mutation == "valid" || mutation == "overpay" || mutation == "extra-output" || mutation == "asset-overpay" {
		return true
	}
	if mutation == "asset-extra-count" && c.Kind == "swap-asset" {
		return true
	}
	if mutation == "asset-wrong-input-index" || mutation == "asset-input-absent" {
		return false
	}
	return false
}

func amountNoTest(s string) uint64 { n, _ := strconv.ParseUint(s, 10, 64); return n }

func caseResult(c comparison, mutation, scope string, manual, generated error, equivalent bool) result {
	optimization := c.Name[strings.LastIndex(c.Name, "/")+1:]
	domain := "valid-satoshi-amount"
	if c.Kind == "swap-btc" && amountNoTest(c.Context.WantAmount) > btcutil.MaxSatoshi {
		domain = "above-max-bitcoin-money"
	}
	r := result{Name: c.Name, Scope: scope, Kind: c.Kind, Optimization: optimization, MoneyDomain: domain, Mutation: mutation, ManualAccepted: manual == nil, GeneratedAccepted: generated == nil, ExpectedEquivalent: equivalent}
	if manual != nil {
		r.ManualError = manual.Error()
	}
	if generated != nil {
		r.GeneratedError = generated.Error()
	}
	return r
}

func recordResults(t *testing.T, path string, results []result) {
	t.Helper()
	encoded, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("COMPILER_COMPARISON_WRITE") == "1" {
		if err := os.WriteFile(path, append(encoded, '\n'), 0644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var expected []result
	if err := json.Unmarshal(raw, &expected); err != nil {
		t.Fatal(err)
	}
	canonical, err := json.MarshalIndent(expected, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, canonical) {
		t.Errorf("engine result snapshot changed: %s; regenerate explicitly with --write", path)
	}
}

func executeLeaf(t *testing.T, c comparison, v variant, mutation string) error {
	t.Helper()
	s := baseSpend(t, c)
	leaf := txscript.NewBaseTapLeaf(decode(t, v.LeafHex))
	internal, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{99}, 32))
	tree := txscript.AssembleTaprootScriptTree(leaf)
	control := tree.LeafMerkleProofs[0].ToControlBlock(internal.PubKey())
	controlBytes, err := control.ToBytes()
	if err != nil {
		t.Fatal(err)
	}
	root := tree.RootNode.TapHash()
	outputKey := txscript.ComputeTaprootOutputKey(internal.PubKey(), root[:])
	pkScript, err := txscript.PayToTaprootScript(outputKey)
	if err != nil {
		t.Fatal(err)
	}
	prev := s.Fetcher.FetchPrevOutput(s.Tx.TxIn[s.Vin].PreviousOutPoint)
	prev.PkScript = pkScript
	if mutation == "cltv-too-early" {
		s.Tx.LockTime--
	}
	if mutation == "csv-too-early" {
		s.Tx.TxIn[s.Vin].Sequence--
	}
	if mutation == "cltv-final-sequence" {
		s.Tx.TxIn[s.Vin].Sequence = math.MaxUint32
	}
	if mutation == "csv-disabled" {
		s.Tx.TxIn[s.Vin].Sequence |= 1 << 31
	}
	if mutation == "csv-version-one" {
		s.Tx.Version = 1
	}
	hashes := txscript.NewTxSigHashes(s.Tx, s.Fetcher)
	var pubkeys [][]byte
	var previous []byte
	parser := txscript.MakeScriptTokenizer(0, leaf.Script)
	for parser.Next() {
		if parser.Opcode() == txscript.OP_CHECKSIG || parser.Opcode() == txscript.OP_CHECKSIGVERIFY {
			if len(previous) != 32 {
				t.Fatalf("nonconstant signing key for %s", c.Name)
			}
			pubkeys = append(pubkeys, append([]byte(nil), previous...))
		}
		previous = parser.Data()
	}
	if parser.Err() != nil {
		t.Fatal(parser.Err())
	}
	if len(v.ExpectedSignerKeys) == 0 || len(pubkeys) != len(v.ExpectedSignerKeys) {
		t.Fatalf("signer count differs from independent policy for %s: leaf=%d required=%d", c.Name, len(pubkeys), len(v.ExpectedSignerKeys))
	}
	for i, expected := range v.ExpectedSignerKeys {
		if !bytes.Equal(pubkeys[i], decode(t, expected)) {
			t.Fatalf("signer %d differs from independent policy for %s: leaf=%x required=%s", i, c.Name, pubkeys[i], expected)
		}
	}
	witness := wire.TxWitness{}
	for i := len(pubkeys) - 1; i >= 0; i-- {
		secret := v.KeySecrets[hex.EncodeToString(pubkeys[i])]
		if secret == "" {
			t.Fatalf("missing signing secret for %s key %x", c.Name, pubkeys[i])
		}
		key, _ := btcec.PrivKeyFromBytes(decode(t, secret))
		if !bytes.Equal(schnorr.SerializePubKey(key.PubKey()), pubkeys[i]) {
			t.Fatal("signing secret does not match leaf key")
		}
		signature, err := txscript.RawTxInTapscriptSignature(s.Tx, hashes, s.Vin, prev.Value, pkScript, leaf, txscript.SigHashDefault, key)
		if err != nil {
			t.Fatal(err)
		}
		if mutation == "wrong-signature-"+strconv.Itoa(i) {
			signature[0] ^= 1
		}
		if mutation != "missing-signature-"+strconv.Itoa(i) {
			witness = append(witness, signature)
		}
	}
	if strings.Contains(strings.ToLower(c.Context.Path), "claim") {
		preimage := decode(t, c.Context.PreimageHex)
		if mutation == "wrong-preimage" {
			preimage[0] ^= 1
		}
		witness = append(witness, preimage)
	}
	s.Tx.TxIn[s.Vin].Witness = append(witness, leaf.Script, controlBytes)
	engine, err := txscript.NewEngine(pkScript, s.Tx, s.Vin, txscript.StandardVerifyFlags, nil, hashes, prev.Value, s.Fetcher)
	if err != nil {
		return err
	}
	return engine.Execute()
}

func TestCompilerTapscriptComparison(t *testing.T) {
	raw, err := os.ReadFile(os.Getenv("COMPILER_COMPARISON_VECTORS"))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Comparisons []comparison `json:"comparisons"`
		Cases       []comparison `json:"cases"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	rows := input.Comparisons
	if len(rows) == 0 {
		rows = input.Cases
	}
	var results []result
	for _, c := range rows {
		if len(c.Manual.KeySecrets) == 0 {
			continue
		}
		if len(c.Manual.ExpectedSignerKeys) == 0 || len(c.Manual.ExpectedSignerKeys) != len(c.Generated.ExpectedSignerKeys) {
			t.Fatalf("inconsistent independent signer policy for %s", c.Name)
		}
		mutations := []string{"valid"}
		for i := range c.Manual.ExpectedSignerKeys {
			mutations = append(mutations, "wrong-signature-"+strconv.Itoa(i), "missing-signature-"+strconv.Itoa(i))
		}
		if strings.Contains(strings.ToLower(c.Context.Path), "claim") {
			mutations = append(mutations, "wrong-preimage")
		}
		if strings.HasPrefix(c.Context.Path, "unilateral") || c.Context.Path == "exit" {
			mutations = append(mutations, "csv-too-early", "csv-disabled", "csv-version-one")
		}
		if c.Context.Path == "nonInteractiveRefundWithoutReceiver" || c.Context.Path == "refundWithoutReceiver" {
			mutations = append(mutations, "cltv-too-early", "cltv-final-sequence")
		}
		for _, mutation := range mutations {
			t.Run(c.Name+"/"+mutation, func(t *testing.T) {
				manual := executeLeaf(t, c, c.Manual, mutation)
				generated := executeLeaf(t, c, c.Generated, mutation)
				wrongLength := mutation == "valid" && c.Context.Version == "v2" && strings.Contains(strings.ToLower(c.Context.Path), "claim") && len(decode(t, c.Context.PreimageHex)) != 32
				r := caseResult(c, mutation, "bitcoin-tapscript", manual, generated, true)
				results = append(results, r)
				want := mutation == "valid" && !wrongLength
				if r.ManualAccepted != want || r.GeneratedAccepted != want {
					t.Errorf("want accepted=%v, manual=%v (%v), generated=%v (%v)", want, r.ManualAccepted, manual, r.GeneratedAccepted, generated)
				}
			})
		}
	}
	if len(results) == 0 {
		t.Fatal("no signed tapscript executions")
	}
	if destination := os.Getenv("COMPILER_COMPARISON_RESULTS"); destination != "" {
		recordResults(t, strings.TrimSuffix(destination, ".json")+"-tapscript.json", results)
	}
	t.Logf("executed %d paired signed tapscript cases", len(results))
}

func TestCompilerCovenantComparison(t *testing.T) {
	raw, err := os.ReadFile(os.Getenv("COMPILER_COMPARISON_VECTORS"))
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Comparisons []comparison `json:"comparisons"`
		Cases       []comparison `json:"cases"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatal(err)
	}
	rows := input.Comparisons
	if len(rows) == 0 {
		rows = input.Cases
	}
	if len(rows) == 0 {
		t.Fatal("no comparison rows")
	}
	var results []result
	for _, c := range rows {
		if c.Manual.CovenantHex == "" || c.Generated.CovenantHex == "" {
			continue
		}
		for _, mutation := range mutations(c) {
			t.Run(c.Name+"/"+mutation, func(t *testing.T) {
				s := baseSpend(t, c)
				mutate(&s, mutation)
				manual := executeCovenant(t, c, c.Manual, s)
				generated := executeCovenant(t, c, c.Generated, s)
				r := caseResult(c, mutation, "emulator-covenant", manual, generated, true)
				results = append(results, r)
				want := expected(c, mutation)
				if r.ManualAccepted != want || r.GeneratedAccepted != want {
					t.Errorf("want accepted=%v, manual=%v (%v), generated=%v (%v)", want, r.ManualAccepted, manual, r.GeneratedAccepted, generated)
				}
			})
		}
	}
	if len(results) == 0 {
		t.Fatal("no covenant executions")
	}
	if destination := os.Getenv("COMPILER_COMPARISON_RESULTS"); destination != "" {
		recordResults(t, destination, results)
	}
	t.Logf("executed %d paired covenant cases", len(results))
}
