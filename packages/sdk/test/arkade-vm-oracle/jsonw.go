package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Ordered JSON in biome's layout (width 100, indent 4, expand auto), so the
// committed vectors survive `biome format` byte for byte: objects always break,
// scalar arrays stay flat only when they fit.

type kv struct {
	k string
	v any
}

type obj []kv

func (o *obj) add(k string, v any) { *o = append(*o, kv{k, v}) }

const lineWidth = 100

func render(v any) []byte {
	var b strings.Builder
	write(&b, v, 0, 0, 0)
	b.WriteByte('\n')
	return []byte(b.String())
}

func write(b *strings.Builder, v any, indent, col, tail int) {
	switch t := v.(type) {
	case obj:
		if len(t) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, e := range t {
			key := quote(e.k)
			b.WriteString(strings.Repeat(" ", indent+4) + key + ": ")
			writeItem(b, e.v, indent+4, indent+4+len(key)+2, i < len(t)-1)
		}
		b.WriteString(strings.Repeat(" ", indent) + "}")
	case []any:
		if flat, ok := flatArray(t); ok && col+len(flat)+tail <= lineWidth {
			b.WriteString(flat)
			return
		}
		b.WriteString("[\n")
		for i, e := range t {
			b.WriteString(strings.Repeat(" ", indent+4))
			writeItem(b, e, indent+4, indent+4, i < len(t)-1)
		}
		b.WriteString(strings.Repeat(" ", indent) + "]")
	default:
		b.WriteString(scalar(v))
	}
}

func writeItem(b *strings.Builder, v any, indent, col int, comma bool) {
	tail := 0
	if comma {
		tail = 1
	}
	write(b, v, indent, col, tail)
	if comma {
		b.WriteByte(',')
	}
	b.WriteByte('\n')
}

func flatArray(a []any) (string, bool) {
	parts := make([]string, len(a))
	for i, e := range a {
		switch t := e.(type) {
		case obj:
			if len(t) > 0 {
				return "", false
			}
			parts[i] = "{}"
		case []any:
			s, ok := flatArray(t)
			if !ok {
				return "", false
			}
			parts[i] = s
		default:
			parts[i] = scalar(e)
		}
	}
	return "[" + strings.Join(parts, ", ") + "]", true
}

func scalar(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		return strconv.FormatBool(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case uint32:
		return strconv.FormatUint(uint64(t), 10)
	case string:
		return quote(t)
	case json.Number:
		return t.String()
	}
	panic(fmt.Sprintf("jsonw: unsupported %T", v))
}

// Non-ASCII is escaped so that byte length equals display width.
func quote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\n':
			b.WriteString(`\n`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04x`, r)
		case r > 0x7f:
			for _, u := range utf16.Encode([]rune{r}) {
				fmt.Fprintf(&b, `\u%04x`, u)
			}
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// ordered re-reads JSON keeping key order, so foreign generators share this layout.
func ordered(data []byte) any {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		panic(err)
	}
	return v
}

func readValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		if t == '[' {
			list := []any{}
			for dec.More() {
				v, err := readValue(dec)
				if err != nil {
					return nil, err
				}
				list = append(list, v)
			}
			_, err := dec.Token()
			return list, err
		}
		o := obj{}
		for dec.More() {
			k, err := dec.Token()
			if err != nil {
				return nil, err
			}
			v, err := readValue(dec)
			if err != nil {
				return nil, err
			}
			o.add(k.(string), v)
		}
		_, err := dec.Token()
		return o, err
	}
	return tok, nil
}
