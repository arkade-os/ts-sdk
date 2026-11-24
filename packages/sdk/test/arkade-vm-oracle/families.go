package main

import "sync"

var emulatorVectors = sync.OnceValue(emulatorVectorCases)

func withImported(family string, hand []*Case) []*Case {
	return append(hand, emulatorVectors()[family]...)
}

func coreCases() []*Case       { return withImported("core", coreHand()) }
func arithCases() []*Case      { return withImported("arith", arithHand()) }
func spliceCases() []*Case     { return withImported("splice", spliceHand()) }
func hashCases() []*Case       { return withImported("hash", hashHand()) }
func merkleCases() []*Case     { return withImported("merkle", merkleHand()) }
func introspectCases() []*Case { return withImported("introspect", introspectHand()) }
func timeCases() []*Case       { return withImported("time", timeHand()) }
func sigCases() []*Case        { return withImported("sig", sigHand()) }
func ecCases() []*Case         { return withImported("ec", ecHand()) }
func assetCases() []*Case      { return withImported("asset", assetHand()) }
func packetCases() []*Case     { return withImported("packet", packetHand()) }
func tunnelCases() []*Case     { return withImported("tunnel", tunnelHand()) }
func intentCases() []*Case     { return withImported("intent", intentHand()) }
func covenantCases() []*Case   { return covenantHand() }
