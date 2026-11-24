import { ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { scriptError } from "../errors";
import { sha256Finalize, sha256Initialize, sha256Update } from "../hash";
import { merkleBranchRoot } from "../merkle";
import type { FamilyHandlers, OpcodeHandler } from "../opcodes";

type HashFn = (data: Uint8Array) => Uint8Array;

// 4 is legacy (Ethereum) Keccak-256 and 5 is NIST SHA3-256: different functions.
const DIGESTS = new Map<number, HashFn>([
    [1, sha256],
    [2, sha1],
    [3, ripemd160],
    [4, keccak_256],
    [5, sha3_256],
]);

const hashTop =
    (f: HashFn): OpcodeHandler =>
    (_op, _data, vm) =>
        vm.dstack.pushByteArray(f(vm.dstack.popByteArray()));

const invalid = (message: string) => scriptError("ErrInvalidStackOperation", message);

export const hashopsHandlers: FamilyHandlers<"hashops"> = {
    OP_RIPEMD160: hashTop(ripemd160),
    OP_SHA1: hashTop(sha1),
    OP_SHA256: hashTop(sha256),
    OP_HASH160: hashTop((b) => ripemd160(sha256(b))),
    OP_HASH256: hashTop((b) => sha256(sha256(b))),
    // the selector is on top, adjacent to the opcode in the script
    OP_DIGEST: (_op, _data, vm) => {
        const hashType = vm.dstack.popInt();
        const buf = vm.dstack.popByteArray();
        const digest = DIGESTS.get(hashType);
        if (!digest) throw invalid(`unsupported OP_DIGEST hash type ${hashType}`);
        vm.dstack.pushByteArray(digest(buf));
    },
    OP_SHA256INITIALIZE: (_op, _data, vm) =>
        vm.dstack.pushByteArray(sha256Initialize(vm.dstack.popByteArray())),
    // UPDATE and FINALIZE both pop the data first, then the state beneath it
    OP_SHA256UPDATE: (_op, _data, vm) => {
        const data = vm.dstack.popByteArray();
        vm.dstack.pushByteArray(sha256Update(vm.dstack.popByteArray(), data));
    },
    OP_SHA256FINALIZE: (_op, _data, vm) => {
        const data = vm.dstack.popByteArray();
        vm.dstack.pushByteArray(sha256Finalize(vm.dstack.popByteArray(), data));
    },
    // computes and pushes a root; it does not verify one, despite the OP_MERKLEBRANCHVERIFY alias
    OP_MERKLEBRANCHROOT: (_op, _data, vm) => {
        const leafData = vm.dstack.popByteArray();
        const proof = vm.dstack.popByteArray();
        if (proof.length % 32 !== 0) throw invalid("proof length must be a multiple of 32");
        const branchTag = vm.dstack.popByteArray();
        if (branchTag.length === 0) throw invalid("branch_tag must not be empty");
        const leafTag = vm.dstack.popByteArray();
        vm.dstack.pushByteArray(merkleBranchRoot(leafTag, leafData, branchTag, proof));
    },
};
