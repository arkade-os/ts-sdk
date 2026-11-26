package main

import (
	"bytes"
	"path/filepath"
	"strings"

	"arkade-vm-oracle/emulate"
	"arkade-vm-oracle/opsassets"
	"arkade-vm-oracle/opsig"
)

// foreignFixtures are the generators whose cases need what the case format lacks:
// step-callback stacks and sighash digests (ops-sig), codec answers (ops-assets),
// closure decoding and byte-pinned PSBT mutations (emulate).
func foreignFixtures() map[string]obj {
	var sig bytes.Buffer
	opsig.Generate(&sig)
	worlds, cases := []any{}, []any{}
	for _, line := range strings.Split(strings.TrimSpace(sig.String()), "\n") {
		v := ordered([]byte(line)).(obj)
		if v[0].k == "n" {
			cases = append(cases, v)
		} else {
			worlds = append(worlds, v)
		}
	}
	var assets, emu bytes.Buffer
	opsassets.Generate(&assets)
	emulate.Generate(filepath.Join(moduleDir("github.com/arkade-os/emulator/pkg/emulator"), "testdata"), &emu)
	return map[string]obj{
		"ops-sig.json":    {{"worlds", worlds}, {"cases", cases}},
		"ops-assets.json": ordered(assets.Bytes()).(obj),
		"emulate.json":    ordered(emu.Bytes()).(obj),
	}
}
