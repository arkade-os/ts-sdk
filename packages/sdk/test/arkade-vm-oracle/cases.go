package main

import (
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type mod func(*Case)

type book struct{ cases []*Case }

func (b *book) add(mode, name string, op any, hz string, script []byte, mods []mod) *Case {
	c := &Case{Name: name, Mode: mode, Hazard: hz, World: defaultWorld(), Script: script, InputAmount: 5000}
	switch t := op.(type) {
	case byte:
		c.Op = slots[t].name
	case int:
		c.Op = slots[t].name
	}
	for _, m := range mods {
		m(c)
	}
	b.cases = append(b.cases, c)
	return c
}

// ex is an expression-mode case: NewEngine + Step, the full final stack recorded.
func (b *book) ex(name string, op any, hz string, script []byte, mods ...mod) *Case {
	return b.add("expression", name, op, hz, script, mods)
}

// cov is a covenant-mode case: ArkadeScript.Execute with the witness seeding the stack.
func (b *book) cov(name string, op any, hz string, script []byte, witness [][]byte, mods ...mod) *Case {
	c := b.add("covenant", name, op, hz, script, mods)
	c.Witness = witness
	return c
}

func inW(w *world) mod           { return func(c *Case) { c.World = w } }
func at(i int, amount int64) mod { return func(c *Case) { c.InputIndex, c.InputAmount = i, amount } }
func exp(x int64) mod            { return func(c *Case) { c.Expiry = &x } }
func msg(s string) mod           { return func(c *Case) { c.IntentMessage = &s } }
func lim(l arkade.ComputeLimits) mod {
	return func(c *Case) { c.Limits = l }
}
func budget(l arkade.ComputeLimits) mod { return func(c *Case) { c.Budget = l } }
func leafM(l []byte) mod                { return func(c *Case) { c.TapLeaf = l } }
func pk() mod                           { return func(c *Case) { c.PacketsFromTx = true } }

// txWith copies the default world's tx with f applied; prevouts follow the inputs.
func txWith(name string, f func(tx *wire.MsgTx), extra ...prevout) *world {
	d := defaultWorld()
	tx := d.tx.Copy()
	f(tx)
	w := &world{name: name, tx: tx}
	have := map[wire.OutPoint]bool{}
	for _, p := range extra {
		w.prevouts = append(w.prevouts, p)
		have[p.op] = true
	}
	for _, p := range d.prevouts {
		if !have[p.op] {
			w.prevouts = append(w.prevouts, p)
		}
	}
	return w
}

// coverageCases fills the slots whose failure or success the emulator's own
// vectors cannot show at script level: pushes and pushers can only fail on the
// post-step count limit, PUSHDATA4 only succeeds in a dead branch.
func coverageCases(b *book, fam string) {
	for op := 0; op < 256; op++ {
		if familyOf(byte(op)) != fam {
			continue
		}
		s := slots[op]
		pusher := op <= txscript.OP_16 && op != txscript.OP_RESERVED
		switch op {
		case txscript.OP_DEPTH, arkade.OP_PUSHCURRENTINPUTINDEX, arkade.OP_INSPECTVERSION,
			arkade.OP_INSPECTLOCKTIME, arkade.OP_INSPECTNUMINPUTS, arkade.OP_INSPECTNUMOUTPUTS,
			arkade.OP_TXWEIGHT, arkade.OP_TXID:
			pusher = true
		}
		if !pusher {
			continue
		}
		token := oneToken(byte(op), s.length)
		if s.length > 1 {
			token = append([]byte{byte(op)}, rep(0x5a, s.length-1)...)
		}
		// the shortest minimal push of each, so the count limit and not ErrMinimalData decides
		switch op {
		case txscript.OP_PUSHDATA1:
			token = append([]byte{byte(op), 76}, rep(0x5a, 76)...)
		case txscript.OP_PUSHDATA2:
			token = append([]byte{byte(op), 0, 1}, rep(0x5a, 256)...)
		}
		if op == txscript.OP_PUSHDATA4 {
			b.ex("coverage/OP_PUSHDATA4/dead-branch", op, "2.9/order",
				sc(byte(txscript.OP_0), byte(txscript.OP_IF), raw{txscript.OP_PUSHDATA4, 1, 0, 0, 0, 7},
					byte(txscript.OP_ENDIF), byte(txscript.OP_1)))
			b.ex("coverage/OP_PUSHDATA4/executed-never-minimal", op, "2.9/no-65535-case",
				sc(raw{txscript.OP_PUSHDATA4, 1, 0, 0, 0, 7}))
			continue
		}
		b.ex("coverage/"+s.name+"/stack-count-overflow", op, "2.9/post-step-limits", sc(fill(1000), raw(token)))
	}
}
