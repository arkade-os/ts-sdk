// Command arkade-vm-oracle writes the conformance vectors for the TypeScript
// port of the emulator's script VM.
//
//	cd packages/sdk/test/arkade-vm-oracle && GOTOOLCHAIN=go1.27.3 go run . -out ../fixtures/arkade-vm/
//	GOTOOLCHAIN=go1.27.3 go run . -extract-executor ../fixtures/template-v1  # refreshes testdata/
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sort"

	"github.com/sirupsen/logrus"
)

const (
	pinEmulator = "30a59c7"
	pinModule   = "v0.2.0"
	// The emulator image builds FROM golang:1.27.3, and the SHA-256 midstate
	// framing is a gob artifact of that toolchain.
	pinGo = "go1.27.3"
)

var families = []struct {
	name  string
	build func() []*Case
}{
	{"core", coreCases},
	{"arith", arithCases},
	{"splice", spliceCases},
	{"hash", hashCases},
	{"merkle", merkleCases},
	{"introspect", introspectCases},
	{"time", timeCases},
	{"sig", sigCases},
	{"ec", ecCases},
	{"asset", assetCases},
	{"packet", packetCases},
	{"tunnel", tunnelCases},
	{"intent", intentCases},
	{"covenant", covenantCases},
	{"service", serviceCases},
}

func main() {
	out := flag.String("out", "", "directory for the generated vectors")
	extract := flag.String("extract-executor", "", "refresh "+executorScriptsFile+" from the executor's v1 vectors dir")
	flag.Parse()
	if *extract != "" {
		extractExecutor(*extract)
		return
	}
	if *out == "" {
		fatal("-out is required")
	}
	if runtime.Version() != pinGo {
		fatal("run with GOTOOLCHAIN=%s (have %s): the midstate framing is toolchain-specific", pinGo, runtime.Version())
	}
	checkModules()
	logrus.SetOutput(io.Discard)

	files := map[string]obj{
		"opcodes.json":        opcodesTable(),
		"compute_limits.json": computeLimitsTable(),
		"sha256_framing.json": sha256Framing(),
	}
	built := map[string][]*Case{}
	keys := map[string]bool{}
	dropped := 0
	keep := func(family string, c *Case) {
		if k := c.inputKey(); keys[k] {
			dropped++
		} else {
			keys[k] = true
			built[family] = append(built[family], c)
		}
	}
	for _, f := range families {
		for _, c := range f.build() {
			keep(f.name, c)
		}
	}
	for _, c := range opsCoreCases() {
		keep(c.family, c.Case)
	}
	seen := map[string]string{}
	var all []*Case
	for _, f := range families {
		cases := built[f.name]
		worlds := map[string]*world{}
		list := make([]any, 0, len(cases))
		for _, c := range cases {
			if prev, dup := seen[c.Name]; dup {
				fatal("duplicate case name %q in %s and %s", c.Name, prev, f.name)
			}
			seen[c.Name] = f.name
			c.run()
			if c.World != nil {
				if w, ok := worlds[c.World.name]; ok && w != c.World {
					fatal("two worlds named %q", c.World.name)
				}
				worlds[c.World.name] = c.World
			}
			list = append(list, c.json())
		}
		names := make([]string, 0, len(worlds))
		for n := range worlds {
			names = append(names, n)
		}
		sort.Strings(names)
		wj := obj{}
		for _, n := range names {
			wj.add(n, worlds[n].json())
		}
		files[f.name+".json"] = obj{{"family", f.name}, {"worlds", wj}, {"cases", list}}
		all = append(all, cases...)
	}
	files["hazards.json"] = hazardsTable(all)
	for name, body := range foreignFixtures() {
		files[name] = body
	}

	if err := os.MkdirAll(*out, 0o755); err != nil {
		fatal("%v", err)
	}
	for name, body := range files {
		doc := append(obj{{"format", "arkade-vm-oracle/v1"}, {"pin", pinJSON()}}, body...)
		if err := os.WriteFile(filepath.Join(*out, name), render(doc), 0o644); err != nil {
			fatal("%v", err)
		}
	}
	fmt.Printf("wrote %d files, %d cases (%d exact duplicates dropped); emulator vectors skipped: %v\n",
		len(files), len(all), dropped, skippedEmulatorVectors)
}

func pinJSON() obj { return obj{{"emulator", pinEmulator}, {"module", pinModule}, {"go", pinGo}} }

func checkModules() {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		fatal("no build info")
	}
	want := map[string]string{
		"github.com/arkade-os/emulator/pkg/arkade":   pinModule,
		"github.com/arkade-os/emulator/pkg/emulator": pinModule,
	}
	for _, d := range info.Deps {
		if v, ok := want[d.Path]; ok {
			if d.Version != v || d.Replace != nil {
				fatal("%s is %s, the pin says %s", d.Path, d.Version, v)
			}
			delete(want, d.Path)
		}
	}
	if len(want) != 0 {
		fatal("missing modules %v", want)
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "arkade-vm-oracle: "+format+"\n", args...)
	os.Exit(1)
}
