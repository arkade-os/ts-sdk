package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"math/big"
	"os"
	"strconv"
	"strings"

	"github.com/arkade-os/emulator/pkg/arkade"
)

const opsCoreFile = "testdata/ops-core-cases.txt"

type opsCase struct {
	*Case
	family string
}

var opsFamily = map[string]string{
	"arith": "arith", "num": "arith", "modexp": "arith", "shift": "arith", "cmp": "arith",
	"bit": "splice", "splice": "splice", "digest": "hash", "hash": "hash", "mid": "hash",
	"eq": "core", "flow": "core", "stack": "core", "merkle": "merkle",
}

// opsCoreCases reads the token DSL documented at the top of opsCoreFile; w:/wn:/wst:
// seed the stack through SetStack, which no script push can do for oversized items.
func opsCoreCases() []opsCase {
	f, err := os.Open(opsCoreFile)
	if err != nil {
		fatal("%v", err)
	}
	defer f.Close()
	var out []opsCase
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, tokens, ok := strings.Cut(line, "|")
		name = strings.TrimSpace(name)
		fam := opsFamily[strings.Split(name, "/")[0]]
		if !ok || fam == "" {
			fatal("%s: bad line %q", opsCoreFile, line)
		}
		script, seed := opsTokens(tokens)
		c := &Case{Name: "ops/" + name, Mode: "expression", World: defaultWorld(), InputAmount: 5000, Script: script, Seed: seed}
		out = append(out, opsCase{c, fam})
	}
	return out
}

func opsTokens(line string) (script []byte, seed [][]byte) {
	seed = [][]byte{}
	for _, tok := range strings.Fields(line) {
		switch {
		case strings.HasPrefix(tok, "n:"):
			script = append(script, push(num(opsNum(tok[2:])))...)
		case strings.HasPrefix(tok, "x:"):
			script = append(script, push(opsSpec(tok[2:]))...)
		case strings.HasPrefix(tok, "s:"):
			script = append(script, push([]byte(tok[2:]))...)
		case strings.HasPrefix(tok, "st:"):
			script = append(script, push(opsState(tok[3:]))...)
		case strings.HasPrefix(tok, "raw:"):
			script = append(script, opsSpec(tok[4:])...)
		case strings.HasPrefix(tok, "w:"):
			seed = append(seed, opsSpec(tok[2:]))
		case strings.HasPrefix(tok, "wn:"):
			seed = append(seed, num(opsNum(tok[3:])))
		case strings.HasPrefix(tok, "wst:"):
			seed = append(seed, opsState(tok[4:]))
		default:
			op, count := tok, 1
			if i := strings.Index(op, "*"); i >= 0 {
				count, _ = strconv.Atoi(op[i+1:])
				op = op[:i]
			}
			v, ok := arkade.OpcodeByName["OP_"+strings.TrimPrefix(op, "OP_")]
			if !ok {
				fatal("%s: unknown opcode %q", opsCoreFile, tok)
			}
			script = append(script, bytes.Repeat([]byte{v}, count)...)
		}
	}
	return script, seed
}

// opsNum is decimal or 0x hex, or [-]B^E[+-D].
func opsNum(s string) *big.Int {
	neg := strings.HasPrefix(s, "-") && strings.Contains(s, "^")
	if neg {
		s = s[1:]
	}
	base, rest, pow := strings.Cut(s, "^")
	if !pow {
		return bi(s)
	}
	delta := big.NewInt(0)
	if j := strings.IndexAny(rest, "+-"); j >= 0 {
		delta, rest = bi(rest[j:]), rest[:j]
	}
	e, _ := strconv.Atoi(rest)
	v := new(big.Int).Exp(bi(base), big.NewInt(int64(e)), nil)
	if neg {
		v.Neg(v)
	}
	return v.Add(v, delta)
}

// opsSpec: part ('+' part)*; part is hex, HH*count, IV, P (state prefix), u64=, s= or n=.
func opsSpec(s string) []byte {
	out := []byte{}
	if s == "" {
		return out
	}
	for _, part := range strings.Split(s, "+") {
		switch {
		case part == "IV":
			out = append(out, unhex("6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19")...)
		case part == "P":
			out = append(out, unhex("097f060102ff8200000070ff80006c")...)
		case strings.HasPrefix(part, "u64="):
			out = binary.BigEndian.AppendUint64(out, opsNum(part[4:]).Uint64())
		case strings.HasPrefix(part, "s="):
			out = append(out, part[2:]...)
		case strings.HasPrefix(part, "n="):
			out = append(out, num(opsNum(part[2:]))...)
		case strings.Contains(part, "*"):
			b, n, _ := strings.Cut(part, "*")
			count, _ := strconv.Atoi(n)
			out = append(out, bytes.Repeat(unhex(b), count)...)
		default:
			out = append(out, unhex(part)...)
		}
	}
	return out
}

// opsState is st:<magic>|<h>|<buf>|<len>, a framed sha256 midstate with each field explicit.
func opsState(s string) []byte {
	f := strings.Split(s, "|")
	magic := "73686103"
	if f[0] != "" {
		magic = f[0]
	}
	out := opsSpec("P+" + magic)
	h, buf := opsSpec(f[1]), opsSpec(f[2])
	if len(h) != 32 || len(buf) != 64 {
		fatal("%s: bad state %q", opsCoreFile, s)
	}
	out = append(append(out, h...), buf...)
	return binary.BigEndian.AppendUint64(out, opsNum(f[3]).Uint64())
}
