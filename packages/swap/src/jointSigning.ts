import { base64, hex } from "@scure/base";
import { SigHash } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import {
    Transaction,
    arkade,
    assertAllowedSighashTypes,
    assertSameUnsignedTx,
    assertUnsignedPsbt,
    isBatchSignable,
    matchServerCheckpoints,
    setTapScriptSigEntries,
    tapLeavesOfInput,
    tapScriptSigEntries,
    toXOnly,
    verifyTapscriptSignatures,
    Extension,
    type EmulatorProvider,
    type Identity,
    type TapScriptSigEntry,
} from "@arkade-os/sdk";
import { deepFreeze, verifyOfferFillPlan, type JointGraph } from "./offerFillPlan";

export type JointFundingOwner = "solver" | "taxi";

export interface JointSignerBinding {
    readonly inputIndex: number;
    readonly identity: Identity;
}

export interface JointPins {
    readonly emulatorXOnly: string;
    readonly serverXOnly: string;
}

export type JointOwnerKeys = Partial<Record<JointFundingOwner, readonly string[]>>;

export interface PreparedJointSubmission {
    readonly arkTx: string;
    readonly checkpointTxs: readonly string[];
    readonly txid: string;
}

export interface SubmittedJointFill {
    readonly txid: string;
    readonly signedArkTx: string;
    readonly signedCheckpointTxs: readonly string[];
}

export class JointSigningError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(`joint signing: ${message} (not submitted)`, options);
        this.name = "JointSigningError";
    }
}

export class JointSubmissionAmbiguousError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(
            `joint submission: ${message} (ambiguous: reconcile before retrying, never auto-retry)`,
            options,
        );
        this.name = "JointSubmissionAmbiguousError";
    }
}

const OWNERS: readonly JointFundingOwner[] = ["solver", "taxi"];
const COVENANT_OWNER = "offer-covenant";

const fail = (message: string, cause?: unknown): never => {
    throw new JointSigningError(message, cause === undefined ? undefined : { cause });
};

const parseTx = (psbt: string, what: string): Transaction => {
    try {
        return Transaction.fromPSBT(base64.decode(psbt));
    } catch (error) {
        return fail(`${what} is not a parsable PSBT`, error);
    }
};

const containsBytes = (haystack: Uint8Array, needle: Uint8Array): boolean => {
    if (needle.length === 0 || needle.length > haystack.length) return false;
    for (let i = 0; i <= haystack.length - needle.length; i++) {
        let found = true;
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                found = false;
                break;
            }
        }
        if (found) return true;
    }
    return false;
};

const keyHexOf = async (identity: Identity, what: string): Promise<string> => {
    try {
        return hex.encode(toXOnly(await identity.xOnlyPublicKey(), what));
    } catch (error) {
        return fail(`${what} has no usable x-only key`, error);
    }
};

const sameMetadata = (a: JointGraph, b: JointGraph): boolean =>
    a.graphId === b.graphId &&
    JSON.stringify([a.inputOwners, a.inputOutpoints, a.outputs]) ===
        JSON.stringify([b.inputOwners, b.inputOutpoints, b.outputs]);

const entryId = (e: TapScriptSigEntry): string =>
    `${e.pubKeyHex}:${e.leafHashHex}:${hex.encode(e.signature)}`;

interface TrustedGraphs {
    ark: Transaction;
    checkpoints: Transaction[];
    owners: readonly string[];
}

const loadGraphs = (graph: JointGraph, what: string): TrustedGraphs => {
    const ark = parseTx(graph.arkTx, `${what} arkTx`);
    const checkpoints = graph.checkpoints.map((c, i) => parseTx(c, `${what} checkpoint ${i}`));
    if (
        graph.inputOwners.length !== ark.inputsLength ||
        graph.inputOutpoints.length !== ark.inputsLength ||
        checkpoints.length !== ark.inputsLength
    ) {
        fail(`${what} metadata does not match its transaction`);
    }
    return { ark, checkpoints, owners: [...graph.inputOwners] };
};

const loadTrustedForSigning = async (
    expected: JointGraph,
    owner: JointFundingOwner,
    bindings: readonly JointSignerBinding[],
): Promise<
    TrustedGraphs & {
        owned: number[];
        boundKeys: Map<number, string>;
        boundLeafArk: Map<number, string>;
        boundLeafCp: Map<number, string>;
    }
> => {
    if (!OWNERS.includes(owner)) fail(`unknown funding owner ${owner}`);
    if (!verifyOfferFillPlan(expected)) fail("trusted graph fails integrity");
    const trusted = loadGraphs(expected, "trusted");
    const owned = trusted.owners.flatMap((o, i) => (o === owner ? [i] : []));
    if (owned.length === 0) fail(`no inputs assigned to ${owner}`);
    if (bindings.length !== owned.length) {
        fail(`expected ${owned.length} bindings, got ${bindings.length}`);
    }
    const seen = new Set<number>();
    for (const b of bindings) {
        if (
            !Number.isInteger(b.inputIndex) ||
            b.inputIndex < 0 ||
            b.inputIndex >= trusted.ark.inputsLength
        ) {
            fail(`binding index ${b.inputIndex} out of range`);
        }
        if (seen.has(b.inputIndex)) fail(`duplicate binding for input ${b.inputIndex}`);
        seen.add(b.inputIndex);
        if (trusted.owners[b.inputIndex] !== owner) {
            fail(`input ${b.inputIndex} is not assigned to ${owner}`);
        }
    }
    try {
        assertUnsignedPsbt(trusted.ark, "trusted arkTx");
        trusted.checkpoints.forEach((c, i) => assertUnsignedPsbt(c, `trusted checkpoint ${i}`));
    } catch (error) {
        fail("trusted graph must be unsigned", error);
    }
    assertEdges(expected, trusted);
    const boundKeys = new Map<number, string>();
    const boundLeafArk = new Map<number, string>();
    const boundLeafCp = new Map<number, string>();
    for (const b of bindings) {
        const keyHex = await keyHexOf(b.identity, `binding for input ${b.inputIndex}`);
        const key = hex.decode(keyHex);
        boundLeafArk.set(
            b.inputIndex,
            selectedLeaf(trusted.ark, b.inputIndex, key, b.inputIndex, "funding tapscript"),
        );
        boundLeafCp.set(
            b.inputIndex,
            selectedLeaf(
                trusted.checkpoints[b.inputIndex],
                0,
                key,
                b.inputIndex,
                "checkpoint leaf",
            ),
        );
        boundKeys.set(b.inputIndex, keyHex);
    }
    return { ...trusted, owned, boundKeys, boundLeafArk, boundLeafCp };
};

const selectedLeaf = (
    tx: Transaction,
    index: number,
    key: Uint8Array,
    ownerIndex: number,
    what: string,
): string => {
    const candidates = tapLeavesOfInput(tx, index).filter((leaf) =>
        containsBytes(leaf.script, key),
    );
    if (candidates.length === 0) fail(`binding key for input ${ownerIndex} is not in its ${what}`);
    if (candidates.length > 1) fail(`multiple candidate leaves for input ${ownerIndex} (${what})`);
    return candidates[0].leafHashHex;
};

const assertEdges = (expected: JointGraph, trusted: TrustedGraphs): void => {
    try {
        const seen = new Set<string>();
        for (let i = 0; i < trusted.ark.inputsLength; i++) {
            if (trusted.checkpoints[i].inputsLength !== 1)
                fail(`checkpoint ${i} has no single input`);
            const spent = trusted.checkpoints[i].getInput(0);
            const spentTxid: Uint8Array | undefined = spent.txid as Uint8Array | undefined;
            const spentIndex: number | undefined = spent.index as number | undefined;
            if (spentTxid === undefined || spentIndex === undefined) {
                fail(`checkpoint ${i} has no outpoint`);
            }
            const funded = `${hex.encode(spentTxid as Uint8Array)}:${spentIndex as number}`;
            const want = `${expected.inputOutpoints[i].txid.toLowerCase()}:${expected.inputOutpoints[i].vout}`;
            if (funded !== want) fail(`checkpoint ${i} spends ${funded}, metadata says ${want}`);
            const edge = `${trusted.checkpoints[i].id}:0`;
            const arkSpent = trusted.ark.getInput(i);
            const arkTxid: Uint8Array | undefined = arkSpent.txid as Uint8Array | undefined;
            if (
                !(arkTxid instanceof Uint8Array) ||
                hex.encode(arkTxid) !== trusted.checkpoints[i].id ||
                arkSpent.index !== 0
            ) {
                fail(`ark input ${i} does not spend checkpoint ${edge}`);
            }
            if (seen.has(edge)) fail(`duplicate ark input ${edge}`);
            seen.add(edge);
        }
    } catch (error) {
        if (error instanceof JointSigningError) throw error;
        fail("trusted graph edges do not reconcile", error);
    }
};

const assertEntryValid = (
    tx: Transaction,
    trusted: Transaction,
    index: number,
    entry: TapScriptSigEntry,
    context: string,
): void => {
    if (entry.signature.length !== 64) {
        return fail(`${context} input ${index} carries a ${entry.signature.length}-byte signature`);
    }
    const leaf = tapLeavesOfInput(trusted, index).find((l) => l.leafHashHex === entry.leafHashHex);
    if (!leaf) return fail(`${context} input ${index} commits to an unknown leaf`);
    if (!containsBytes(leaf.script, hex.decode(entry.pubKeyHex))) {
        return fail(`${context} input ${index} key is not in its leaf`);
    }
    try {
        verifyTapscriptSignatures(
            tx,
            index,
            [entry.pubKeyHex],
            [],
            [SigHash.DEFAULT],
            tapLeafHash(leaf.script, leaf.version),
        );
    } catch (error) {
        return fail(`${context} input ${index} has an invalid signature`, error);
    }
};

const assertJointInputSigs = (
    tx: Transaction,
    trusted: Transaction,
    index: number,
    context: string,
): void => {
    let entries: TapScriptSigEntry[];
    try {
        entries = tapScriptSigEntries(tx, index);
    } catch (error) {
        return fail(`${context} input ${index} unreadable`, error);
    }
    const leaves = tapLeavesOfInput(trusted, index);
    if (entries.length === 0) return;
    for (const entry of entries) {
        if (entry.signature.length !== 64) {
            return fail(
                `${context} input ${index} carries a ${entry.signature.length}-byte signature`,
            );
        }
        const leaf = leaves.find((l) => l.leafHashHex === entry.leafHashHex);
        if (!leaf) return fail(`${context} input ${index} commits to an unknown leaf`);
        if (!containsBytes(leaf.script, hex.decode(entry.pubKeyHex))) {
            return fail(`${context} input ${index} key is not in its leaf`);
        }
    }
    try {
        verifyTapscriptSignatures(
            tx,
            index,
            entries.map((e) => e.pubKeyHex),
            [],
            [SigHash.DEFAULT],
        );
    } catch (error) {
        return fail(`${context} input ${index} has an invalid signature`, error);
    }
};

const assertAccumulatedSigs = (
    trusted: TrustedGraphs,
    acc: { ark: Transaction; checkpoints: Transaction[] },
    context: string,
): void => {
    for (let i = 0; i < trusted.ark.inputsLength; i++) {
        if (trusted.owners[i] === COVENANT_OWNER) {
            if (tapScriptSigEntries(acc.ark, i).length > 0) {
                fail(`${context} signs the covenant input`);
            }
            if (tapScriptSigEntries(acc.checkpoints[i], 0).length > 0) {
                fail(`${context} signs the covenant checkpoint`);
            }
            continue;
        }
        assertJointInputSigs(acc.ark, trusted.ark, i, context);
        assertJointInputSigs(
            acc.checkpoints[i],
            trusted.checkpoints[i],
            0,
            `${context} checkpoint ${i}`,
        );
    }
};

const reparse = (signed: unknown, what: string): Transaction => {
    if (!signed || typeof (signed as Transaction).toPSBT !== "function") {
        return fail(`${what}: signer returned no PSBT`);
    }
    try {
        return Transaction.fromPSBT((signed as Transaction).toPSBT());
    } catch (error) {
        return fail(`${what}: signer returned an unparsable PSBT`, error);
    }
};

export async function signJointGraphForOwner(args: {
    expected: JointGraph;
    partial?: JointGraph;
    owner: JointFundingOwner;
    bindings: JointSignerBinding[];
}): Promise<JointGraph> {
    const { expected, owner, bindings } = args;
    const trusted = await loadTrustedForSigning(expected, owner, bindings);
    const incoming = args.partial ?? expected;
    if (!sameMetadata(expected, incoming)) {
        fail("incoming partial does not match the trusted graph");
    }
    const acc = {
        ark: parseTx(incoming.arkTx, "incoming arkTx"),
        checkpoints: incoming.checkpoints.map((c, i) => parseTx(c, `incoming checkpoint ${i}`)),
    };
    try {
        assertSameUnsignedTx(acc.ark, trusted.ark, "incoming arkTx");
        acc.checkpoints.forEach((c, i) =>
            assertSameUnsignedTx(c, trusted.checkpoints[i], `incoming checkpoint ${i}`),
        );
    } catch (error) {
        if (error instanceof JointSigningError) throw error;
        fail("incoming partial alters unsigned fields", error);
    }
    assertAccumulatedSigs(trusted, acc, "incoming partial");
    const before: { ark: TapScriptSigEntry[][]; cps: TapScriptSigEntry[][] } = {
        ark: Array.from({ length: trusted.ark.inputsLength }, (_, i) =>
            tapScriptSigEntries(acc.ark, i),
        ),
        cps: acc.checkpoints.map((c) => tapScriptSigEntries(c, 0)),
    };

    let workArk = parseTx(incoming.arkTx, "incoming arkTx");
    const workCps = new Map<number, Transaction>(
        trusted.owned.map((index) => [
            index,
            parseTx(incoming.checkpoints[index], `incoming checkpoint ${index}`),
        ]),
    );
    const byIdentity = new Map<Identity, number[]>();
    for (const b of bindings) {
        byIdentity.set(b.identity, [...(byIdentity.get(b.identity) ?? []), b.inputIndex]);
    }
    for (const [identity, indexes] of byIdentity) {
        if (isBatchSignable(identity)) {
            const cps = indexes.map((index) => workCps.get(index) as Transaction);
            const signed = await identity
                .signMultiple([
                    { tx: workArk.clone(), inputIndexes: indexes },
                    ...cps.map((tx) => ({ tx: tx.clone(), inputIndexes: [0] })),
                ])
                .catch((error) => fail("batch signer refused the graph", error));
            if (signed.length !== indexes.length + 1) fail("batch signer returned a short array");
            workArk = reparse(signed[0], "signed arkTx");
            signed.slice(1).forEach((s, k) => {
                workCps.set(indexes[k], reparse(s, `signed checkpoint ${indexes[k]}`));
            });
        } else {
            try {
                workArk = reparse(await identity.sign(workArk.clone(), indexes), "signed arkTx");
                for (const index of indexes) {
                    const cp = workCps.get(index) as Transaction;
                    workCps.set(
                        index,
                        reparse(await identity.sign(cp.clone(), [0]), `signed checkpoint ${index}`),
                    );
                }
            } catch (error) {
                if (error instanceof JointSigningError) throw error;
                fail("signer refused the graph", error);
            }
        }
    }

    try {
        assertSameUnsignedTx(workArk, trusted.ark, "signed arkTx");
        for (const index of trusted.owned) {
            assertSameUnsignedTx(
                workCps.get(index) as Transaction,
                trusted.checkpoints[index],
                `signed checkpoint ${index}`,
            );
        }
    } catch (error) {
        if (error instanceof JointSigningError) throw error;
        fail("signer altered unsigned fields", error);
    }
    const added: { arkIndex: number; onCheckpoint: boolean; entry: TapScriptSigEntry }[] = [];
    const diffInto = (
        after: TapScriptSigEntry[],
        known: TapScriptSigEntry[],
        arkIndex: number,
        onCheckpoint: boolean,
        what: string,
    ): void => {
        const ids = new Set(known.map(entryId));
        for (const entry of after) {
            if (!ids.has(entryId(entry))) added.push({ arkIndex, onCheckpoint, entry });
        }
        for (const old of known) {
            if (!after.some((e) => entryId(e) === entryId(old))) fail(`${what} drops a signature`);
        }
    };
    for (let i = 0; i < trusted.ark.inputsLength; i++) {
        diffInto(
            tapScriptSigEntries(workArk, i),
            before.ark[i],
            i,
            false,
            `signed arkTx input ${i}`,
        );
        const afterCp = trusted.owned.includes(i)
            ? tapScriptSigEntries(workCps.get(i) as Transaction, 0)
            : tapScriptSigEntries(acc.checkpoints[i], 0);
        diffInto(afterCp, before.cps[i], i, true, `signed checkpoint ${i}`);
    }
    if (added.length === 0) fail("signer added no signature");
    for (const { arkIndex, onCheckpoint, entry } of added) {
        if (!trusted.owned.includes(arkIndex)) fail(`extra signature on foreign input ${arkIndex}`);
        if (entry.pubKeyHex !== trusted.boundKeys.get(arkIndex)) {
            fail(`input ${arkIndex} signature is not from its bound key`);
        }
        const selected = (onCheckpoint ? trusted.boundLeafCp : trusted.boundLeafArk).get(arkIndex);
        if (entry.leafHashHex !== selected) {
            fail(`input ${arkIndex} signature is not on its selected leaf`);
        }
    }
    for (let i = 0; i < trusted.ark.inputsLength; i++) {
        for (const onCheckpoint of [false, true]) {
            const base = onCheckpoint ? before.cps[i] : before.ark[i];
            const fresh = added
                .filter((a) => a.arkIndex === i && a.onCheckpoint === onCheckpoint)
                .map((a) => a.entry);
            setTapScriptSigEntries(
                onCheckpoint ? acc.checkpoints[i] : acc.ark,
                onCheckpoint ? 0 : i,
                [...base, ...fresh].map((e) => ({
                    pubKey: hex.decode(e.pubKeyHex),
                    leafHash: hex.decode(e.leafHashHex),
                    signature: e.signature,
                })),
            );
        }
    }
    assertAccumulatedSigs(trusted, acc, "signed graph");
    return deepFreeze({
        arkTx: base64.encode(acc.ark.toPSBT()),
        checkpoints: acc.checkpoints.map((c) => base64.encode(c.toPSBT())),
        graphId: expected.graphId,
        inputOwners: [...expected.inputOwners],
        inputOutpoints: expected.inputOutpoints.map((o) => ({ ...o })),
        outputs: structuredClone(expected.outputs),
    });
}

export function prepareJointSubmission(args: {
    expected: JointGraph;
    partial: JointGraph;
    ownerKeys: JointOwnerKeys;
}): PreparedJointSubmission {
    const { expected, partial } = args;
    if (!sameMetadata(expected, partial)) fail("partial does not match the trusted graph");
    if (!verifyOfferFillPlan(expected)) fail("trusted graph fails integrity");
    const trusted = loadGraphs(expected, "trusted");
    const acc = {
        ark: parseTx(partial.arkTx, "partial arkTx"),
        checkpoints: partial.checkpoints.map((c, i) => parseTx(c, `partial checkpoint ${i}`)),
    };
    try {
        assertSameUnsignedTx(acc.ark, trusted.ark, "partial arkTx");
        acc.checkpoints.forEach((c, i) =>
            assertSameUnsignedTx(c, trusted.checkpoints[i], `partial checkpoint ${i}`),
        );
    } catch (error) {
        if (error instanceof JointSigningError) throw error;
        fail("partial alters unsigned fields", error);
    }
    const required = [...new Set(trusted.owners)].filter((o) => o !== COVENANT_OWNER);
    if (required.length === 0) fail("trusted graph names no funding owner");
    const ownerPins = normalizeOwnerKeys(args.ownerKeys, trusted.owners);
    for (let i = 0; i < trusted.ark.inputsLength; i++) {
        if (trusted.owners[i] === COVENANT_OWNER) continue;
        const pins = ownerPins.get(trusted.owners[i])!;
        assertPinnedComplete(acc.ark, i, pins, trusted.owners[i], `funding input ${i}`);
        assertPinnedComplete(acc.checkpoints[i], 0, pins, trusted.owners[i], `checkpoint ${i}`);
    }
    assertAccumulatedSigs(trusted, acc, "partial");
    return { arkTx: partial.arkTx, checkpointTxs: [...partial.checkpoints], txid: acc.ark.id };
}

const normalizeOwnerKeys = (
    ownerKeys: JointOwnerKeys | undefined,
    owners: readonly string[],
): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const [owner, keys] of Object.entries(ownerKeys ?? {})) {
        if (!OWNERS.includes(owner as JointFundingOwner)) fail(`unknown funding owner ${owner}`);
        if (!Array.isArray(keys) || keys.length === 0) fail(`no keys pinned for ${owner}`);
        out.set(owner, new Set(keys.map((k) => pinHex(k, `${owner} pin`))));
    }
    for (const owner of [...new Set(owners)].filter((o) => o !== COVENANT_OWNER)) {
        if (!out.has(owner)) fail(`no owner keys pinned for ${owner}`);
    }
    return out;
};

const assertPinnedComplete = (
    tx: Transaction,
    index: number,
    pins: Set<string>,
    owner: string,
    what: string,
): void => {
    const entries = tapScriptSigEntries(tx, index);
    if (!entries.some((e) => pins.has(e.pubKeyHex))) fail(`${what} has no ${owner} signature`);
    for (const entry of entries) {
        if (!pins.has(entry.pubKeyHex)) {
            fail(`${what} carries a signature from unpinned key ${entry.pubKeyHex}`);
        }
    }
};

export function covenantCosignerKey(args: { expected: JointGraph; emulatorXOnly: string }): string {
    const ark = parseTx(args.expected.arkTx, "trusted arkTx");
    let script: Uint8Array | undefined;
    try {
        script = Extension.fromTx(ark)
            .getEmulatorPacket()
            ?.entries.find((e) => e.vin === 0)?.script;
    } catch (error) {
        return fail("trusted graph carries no emulator packet", error);
    }
    if (!script || script.length === 0) fail("trusted graph carries no covenant script");
    const base = pinHex(args.emulatorXOnly, "emulator pin");
    return hex.encode(arkade.computeArkadeScriptPublicKey(hex.decode(base), script as Uint8Array));
}

export async function submitJointFill(args: {
    expected: JointGraph;
    prepared: PreparedJointSubmission;
    provider: EmulatorProvider;
    pins: JointPins;
    ownerKeys: JointOwnerKeys;
}): Promise<SubmittedJointFill> {
    const { expected, prepared, provider, pins } = args;
    const partial: JointGraph = {
        arkTx: prepared.arkTx,
        checkpoints: [...prepared.checkpointTxs],
        graphId: expected.graphId,
        inputOwners: [...expected.inputOwners],
        inputOutpoints: expected.inputOutpoints.map((o) => ({ ...o })),
        outputs: structuredClone(expected.outputs),
    };
    let staged: PreparedJointSubmission;
    try {
        staged = prepareJointSubmission({ expected, partial, ownerKeys: args.ownerKeys });
    } catch (error) {
        if (error instanceof JointSigningError) throw error;
        throw new JointSigningError("prepared bytes fail validation", { cause: error });
    }
    if (staged.txid !== prepared.txid) fail("prepared txid does not match its bytes");
    const ownerPins = normalizeOwnerKeys(args.ownerKeys, expected.inputOwners);
    const emulatorPin = pinHex(pins.emulatorXOnly, "emulator pin");
    const serverPin = pinHex(pins.serverXOnly, "server pin");
    const covenantPin = covenantCosignerKey({ expected, emulatorXOnly: pins.emulatorXOnly });
    let response: { signedArkTx: string; signedCheckpointTxs: string[] };
    try {
        response = await provider.submitTx(staged.arkTx, [...staged.checkpointTxs]);
    } catch (error) {
        throw new JointSubmissionAmbiguousError("emulator submitTx failed", { cause: error });
    }
    const invalid = (message: string, cause?: unknown): never => {
        throw new JointSubmissionAmbiguousError(`emulator response ${message}`, { cause });
    };
    if (
        !response ||
        typeof response.signedArkTx !== "string" ||
        response.signedArkTx.length === 0 ||
        !Array.isArray(response.signedCheckpointTxs)
    ) {
        invalid("is malformed");
    }
    let signedArk: Transaction;
    try {
        signedArk = Transaction.fromPSBT(base64.decode(response.signedArkTx));
    } catch (error) {
        signedArk = invalid("arkTx is not a parsable PSBT", error);
    }
    const trustedArk = parseTx(expected.arkTx, "trusted arkTx");
    const preparedArk = parseTx(staged.arkTx, "prepared arkTx");
    const preparedCps = staged.checkpointTxs.map((c) => Transaction.fromPSBT(base64.decode(c)));
    if (signedArk.id !== staged.txid) invalid(`ark txid ${signedArk.id} is not ${staged.txid}`);
    try {
        assertSameUnsignedTx(signedArk, trustedArk, "emulator arkTx");
        assertAllowedSighashTypes(signedArk, [SigHash.DEFAULT]);
    } catch (error) {
        invalid("arkTx alters the trusted graph", error);
    }
    let matched: { server: Transaction; local: Transaction }[];
    try {
        matched = matchServerCheckpoints(
            response.signedCheckpointTxs,
            preparedCps,
            "emulator submitTx",
        );
    } catch (error) {
        matched = invalid("checkpoints do not match", error);
    }
    try {
        for (const { server, local } of matched) {
            assertSameUnsignedTx(server, local, "emulator checkpoint");
            assertAllowedSighashTypes(server, [SigHash.DEFAULT]);
        }
        assertSigsPreserved(preparedArk, signedArk, "emulator arkTx");
        matched.forEach(({ server, local }, i) =>
            assertSigsPreserved(local, server, `emulator checkpoint ${i}`),
        );
        assertResponseSigs({
            signedArk,
            trustedArk,
            matched,
            preparedCps,
            owners: [...expected.inputOwners],
            ownerPins,
            emulatorPin,
            serverPin,
            covenantPin,
        });
    } catch (error) {
        if (error instanceof JointSubmissionAmbiguousError) throw error;
        invalid("signatures do not verify", error);
    }
    return {
        txid: staged.txid,
        signedArkTx: response.signedArkTx,
        signedCheckpointTxs: [...response.signedCheckpointTxs],
    };
}

const assertSigsPreserved = (before: Transaction, after: Transaction, what: string): void => {
    for (let i = 0; i < before.inputsLength; i++) {
        const have = new Set(tapScriptSigEntries(after, i).map(entryId));
        for (const old of tapScriptSigEntries(before, i)) {
            if (!have.has(entryId(old))) throw new Error(`${what} input ${i} loses a signature`);
        }
    }
};

const assertResponseSigs = (args: {
    signedArk: Transaction;
    trustedArk: Transaction;
    matched: { server: Transaction; local: Transaction }[];
    preparedCps: Transaction[];
    owners: readonly string[];
    ownerPins: Map<string, Set<string>>;
    emulatorPin: string;
    serverPin: string;
    covenantPin: string;
}): void => {
    const {
        signedArk,
        trustedArk,
        matched,
        preparedCps,
        owners,
        ownerPins,
        emulatorPin,
        serverPin,
        covenantPin,
    } = args;
    for (let i = 0; i < signedArk.inputsLength; i++) {
        if (owners[i] === COVENANT_OWNER) continue;
        const pins = ownerPins.get(owners[i]);
        if (!pins) throw new Error(`emulator arkTx input ${i} has no pinned owner`);
        const entries = tapScriptSigEntries(signedArk, i);
        for (const entry of entries) {
            const cosigned = entry.pubKeyHex === emulatorPin || entry.pubKeyHex === serverPin;
            if (!pins.has(entry.pubKeyHex) && !cosigned) {
                throw new Error(
                    `emulator arkTx input ${i} carries a signature from unpinned key ${entry.pubKeyHex}`,
                );
            }
        }
        for (const entry of entries) {
            assertEntryValid(signedArk, trustedArk, i, entry, "emulator arkTx");
        }
    }
    const covenant = tapScriptSigEntries(signedArk, 0);
    if (covenant.length === 0) {
        throw new Error("covenant input carries no server or emulator signature");
    }
    for (const entry of covenant) {
        if (entry.pubKeyHex !== covenantPin && entry.pubKeyHex !== serverPin) {
            throw new Error(
                `covenant input carries a signature from unpinned key ${entry.pubKeyHex}`,
            );
        }
    }
    for (const entry of covenant) {
        assertEntryValid(signedArk, trustedArk, 0, entry, "emulator arkTx covenant");
    }
    const serverByTxid = new Map(matched.map((m) => [m.local.id, m.server] as const));
    preparedCps.forEach((local, i) => {
        const server = serverByTxid.get(local.id);
        if (!server) throw new Error(`emulator checkpoint ${i} is missing from the response`);
        if (owners[i] === COVENANT_OWNER) {
            for (const entry of tapScriptSigEntries(server, 0)) {
                const cosigned =
                    entry.pubKeyHex === emulatorPin ||
                    entry.pubKeyHex === serverPin ||
                    entry.pubKeyHex === covenantPin;
                if (!cosigned) {
                    throw new Error(
                        `emulator checkpoint ${i} carries a signature from unpinned key ${entry.pubKeyHex}`,
                    );
                }
                assertEntryValid(server, local, 0, entry, `emulator checkpoint ${i}`);
            }
            return;
        }
        const pins = ownerPins.get(owners[i]);
        if (!pins) throw new Error(`emulator checkpoint ${i} has no pinned owner`);
        const cpEntries = tapScriptSigEntries(server, 0);
        for (const entry of cpEntries) {
            const cosigned = entry.pubKeyHex === emulatorPin || entry.pubKeyHex === serverPin;
            if (!pins.has(entry.pubKeyHex) && !cosigned) {
                throw new Error(
                    `emulator checkpoint ${i} carries a signature from unpinned key ${entry.pubKeyHex}`,
                );
            }
        }
        for (const entry of cpEntries) {
            assertEntryValid(server, local, 0, entry, `emulator checkpoint ${i}`);
        }
    });
};

const pinHex = (pin: string, what: string): string => {
    try {
        return hex.encode(toXOnly(hex.decode(pin), what));
    } catch (error) {
        throw new JointSigningError(`${what} is not a public key`, { cause: error });
    }
};
