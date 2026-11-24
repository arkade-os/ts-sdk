package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	arkintent "github.com/arkade-os/arkd/pkg/ark-lib/intent"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

var vtxoNotFound = regexp.MustCompile(`vtxo \S+ not found`)

type serviceInput struct {
	variant       string
	psbt          string
	checkpoints   []string
	message       string
	expiries      map[string]int64
	errorContains string
	valid         bool
}

func (s *serviceInput) json() obj {
	o := obj{{"variant", s.variant}, {"psbt_b64", s.psbt}}
	if s.variant == "offchain" {
		cps := make([]any, len(s.checkpoints))
		for i, c := range s.checkpoints {
			cps[i] = c
		}
		o.add("checkpoints_b64", cps)
	}
	if s.variant == "proof" {
		o.add("message", s.message)
	}
	if s.variant != "onchain" {
		keys := make([]string, 0, len(s.expiries))
		for k := range s.expiries {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		ex := obj{}
		for _, k := range keys {
			ex.add(k, strconv.FormatInt(s.expiries[k], 10))
		}
		o.add("vtxo_expiries", ex)
	}
	return o
}

func decodePSBT(b64 string) *psbt.Packet {
	if b64 == "" {
		return nil
	}
	p, err := psbt.NewFromRawBytes(strings.NewReader(b64), true)
	if err != nil {
		panic(err)
	}
	return p
}

// runService drives the emulator's own production entry points (service.go) with
// the default compute limits, as the deployed service is configured by default.
func runService(s *serviceInput) *expect {
	svc := emulator.New(arkade.DefaultComputeLimits())
	data := emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}}
	for k, v := range s.expiries {
		op, err := wire.NewOutPointFromString(k)
		if err != nil {
			panic(err)
		}
		data.VtxoExpiries[*op] = v
	}
	var reqs []emulator.SignRequest
	var err error
	ctx := context.Background()
	switch s.variant {
	case "offchain":
		var cps []*psbt.Packet
		for _, c := range s.checkpoints {
			cps = append(cps, decodePSBT(c))
		}
		reqs, err = svc.EmulateOffchainTx(ctx, emulator.OffchainTx{ArkTx: decodePSBT(s.psbt), Checkpoints: cps}, data)
	case "proof":
		reg := emulator.Proof{Proof: arkintent.Proof{Packet: *decodePSBT(s.psbt)}, Message: s.message}
		reqs, err = svc.EmulateBatchRegistration(ctx, reg, data)
	default:
		reqs, err = svc.EmulateOnchainTx(ctx, emulator.OnchainTx{Tx: decodePSBT(s.psbt)})
	}
	if (err == nil) != s.valid {
		panic(fmt.Sprintf("service case outcome flipped: valid=%v, err=%v", s.valid, err))
	}
	e := &expect{}
	if err != nil {
		e.ok, e.stage, e.errorContains = false, "service", s.errorContains
		var se txscript.Error
		if errors.As(err, &se) {
			e.code = se.ErrorCode.String()
		}
		var xe *arkade.ExecutionError
		if errors.As(err, &xe) {
			e.failedOp, e.position, e.stage = xe.Opcode, xe.Position, "step"
			if strings.HasPrefix(xe.Err.Error(), "final script validation failed") {
				e.stage = "final"
			}
		}
		if !strings.Contains(err.Error(), s.errorContains) {
			panic("service error " + err.Error() + " lacks " + s.errorContains)
		}
		// upstream's bare "not found" also matches a checkpoint miss; pin the vtxo lookup
		if s.errorContains == "not found" {
			e.errorContains = vtxoNotFound.FindString(err.Error())
			if e.errorContains == "" {
				panic("missing-expiry error lacks the vtxo lookup: " + err.Error())
			}
		}
		return e
	}
	e.ok, e.requests = true, []obj{}
	for _, r := range reqs {
		keys := []any{}
		for _, k := range r.ClosurePubKeys {
			keys = append(keys, hex.EncodeToString(schnorr.SerializePubKey(k)))
		}
		e.requests = append(e.requests, obj{
			{"txid", r.Packet.UnsignedTx.TxID()}, {"input_index", r.InputIndex},
			{"script_hash", hex.EncodeToString(r.ScriptHash)}, {"closure_pubkeys", keys},
		})
	}
	return e
}

type serviceFixture struct {
	Name          string           `json:"name"`
	ArkTx         string           `json:"arkTx"`
	Checkpoints   []string         `json:"checkpoints"`
	Proof         string           `json:"proof"`
	Message       string           `json:"message"`
	Tx            string           `json:"tx"`
	VtxoExpiries  map[string]int64 `json:"vtxoExpiries"`
	ErrorContains string           `json:"errorContains"`
}

// serviceCases replays the emulator's own service fixtures (pkg/emulator/testdata).
func serviceCases() []*Case {
	dir := filepath.Join(moduleDir("github.com/arkade-os/emulator/pkg/emulator"), "testdata")
	var cases []*Case
	for _, f := range []struct{ file, variant string }{{"offchain_tx.json", "offchain"}, {"intent.json", "proof"}, {"onchain_tx.json", "onchain"}} {
		raw, err := os.ReadFile(filepath.Join(dir, f.file))
		if err != nil {
			fatal("%v", err)
		}
		var fix struct{ Valid, Invalid []serviceFixture }
		if err := json.Unmarshal(raw, &fix); err != nil {
			fatal("%s: %v", f.file, err)
		}
		for _, group := range []struct {
			name string
			list []serviceFixture
		}{{"valid", fix.Valid}, {"invalid", fix.Invalid}} {
			for _, x := range group.list {
				in := &serviceInput{variant: f.variant, checkpoints: x.Checkpoints, message: x.Message,
					expiries: x.VtxoExpiries, errorContains: x.ErrorContains, valid: group.name == "valid"}
				in.psbt = map[string]string{"offchain": x.ArkTx, "proof": x.Proof, "onchain": x.Tx}[f.variant]
				if in.psbt == "" && f.variant == "proof" {
					continue // emulator.Proof holds the packet by value: there is no absent proof
				}
				cases = append(cases, &Case{
					Name: "service/" + f.variant + "/" + group.name + "/" + strings.ReplaceAll(x.Name, " ", "-"),
					Mode: "service", Service: in,
				})
			}
		}
	}
	return cases
}
