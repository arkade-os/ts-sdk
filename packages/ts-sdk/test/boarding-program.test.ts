import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { InputSignerRouter } from "../src/wallet/inputSignerRouter";
import { ReadonlyWallet } from "../src/wallet/wallet";
import { networks } from "../src/networks";
import {
    BoardingProgramScript,
    createBoardingProgramScript,
    type BoardingProgram,
} from "../src/script/boarding";
import { CSVMultisigTapscript, MultisigTapscript } from "../src/script/tapscript";
import { scriptFromTapLeafScript } from "../src/script/base";

const key = (fill: number) => schnorr.getPublicKey(new Uint8Array(32).fill(fill));
const boardingKey = key(1);
const cosignerKey = key(2);
const operatorKey = key(3);
const recoveryKey = key(4);
const boardingDelay = { type: "seconds", value: 604672n } as const;

function program(overrides: Partial<BoardingProgram> = {}): BoardingProgram {
    return {
        name: "vault-board-v2",
        boardingPubKey: boardingKey,
        cosignerPubKey: cosignerKey,
        recoveryPubKey: recoveryKey,
        ...overrides,
    };
}

describe("named boarding programs", () => {
    it("rejects every program name except the release-pinned vault program", () => {
        expect(() =>
            createBoardingProgramScript(
                { ...program(), name: "another-program" } as BoardingProgram,
                operatorKey,
                boardingDelay,
            ),
        ).toThrow("unsupported boarding program");
    });

    it("canonically constructs the exact cooperative and recovery leaves", () => {
        const script = createBoardingProgramScript(program(), operatorKey, boardingDelay);
        const expectedCollaborative = MultisigTapscript.encode({
            pubkeys: [boardingKey, cosignerKey, operatorKey],
        }).script;
        const expectedExit = CSVMultisigTapscript.encode({
            pubkeys: [recoveryKey],
            timelock: boardingDelay,
        }).script;

        expect(script).toBeInstanceOf(BoardingProgramScript);
        expect(hex.encode(scriptFromTapLeafScript(script.forfeit()))).toBe(
            hex.encode(expectedCollaborative),
        );
        expect(hex.encode(scriptFromTapLeafScript(script.exit()))).toBe(hex.encode(expectedExit));
    });

    it("reconstructs the same script and addresses without a persisted contract", () => {
        const beforeRestart = createBoardingProgramScript(program(), operatorKey, boardingDelay);
        const afterRestart = createBoardingProgramScript(program(), operatorKey, boardingDelay);

        expect(hex.encode(afterRestart.pkScript)).toBe(hex.encode(beforeRestart.pkScript));
        expect(afterRestart.address("tark", operatorKey).encode()).toBe(
            beforeRestart.address("tark", operatorKey).encode(),
        );
        expect(afterRestart.onchainAddress()).toBe(beforeRestart.onchainAddress());
    });

    it("discovers the configured script after restart without a boarding contract row", async () => {
        const script = createBoardingProgramScript(program(), operatorKey, boardingDelay);
        const coin = {
            txid: "11".repeat(32),
            vout: 0,
            value: 10_000,
            status: { confirmed: true, block_height: 1, block_time: 1 },
        };
        const saveUtxos = async () => undefined;
        let queriedContracts = false;
        const wallet = Object.create(ReadonlyWallet.prototype) as ReadonlyWallet &
            Record<string, unknown>;
        Object.assign(wallet, {
            _boardingTapscript: script,
            network: networks.mutinynet,
            identity: { xOnlyPublicKey: async () => boardingKey },
            contractRepository: {
                getContracts: async () => {
                    queriedContracts = true;
                    return [];
                },
            },
            onchainProvider: { getCoins: async () => [coin] },
            walletRepository: { saveUtxos },
        });

        const found = await wallet.getBoardingUtxos();

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ txid: coin.txid, vout: coin.vout, value: coin.value });
        expect(hex.encode(found[0].tapTree)).toBe(hex.encode(script.encode()));
        expect(queriedContracts).toBe(false);
    });

    it("routes named register, delete, and final board inputs to the worker identity", async () => {
        const script = createBoardingProgramScript(program(), operatorKey, boardingDelay);
        const router = new InputSignerRouter({
            identity: { xOnlyPublicKey: async () => boardingKey } as never,
            contractRepository: { getContracts: async () => [] } as never,
            boardingPkScript: script.pkScript,
        });

        for (const indexes of [[0, 1], [0, 1], [0]]) {
            await expect(
                router.classify(indexes.map((index) => ({ index, lookupScript: script.pkScript }))),
            ).resolves.toEqual({ identityIndexes: indexes, descriptorGroups: new Map() });
        }
    });

    it.each([
        ["boarding/cosigner", { cosignerPubKey: boardingKey }],
        ["boarding/recovery", { recoveryPubKey: boardingKey }],
        ["boarding/Operator", { boardingPubKey: operatorKey }],
        ["cosigner/recovery", { recoveryPubKey: cosignerKey }],
        ["cosigner/Operator", { cosignerPubKey: operatorKey }],
        ["recovery/Operator", { recoveryPubKey: operatorKey }],
    ] as const)("rejects a %s role-key collision", (_label, overrides) => {
        expect(() =>
            createBoardingProgramScript(program(overrides), operatorKey, boardingDelay),
        ).toThrow("four distinct keys");
    });

    it("rejects malformed role keys before constructing the script", () => {
        expect(() =>
            createBoardingProgramScript(
                program({ recoveryPubKey: new Uint8Array(31) }),
                operatorKey,
                boardingDelay,
            ),
        ).toThrow("recovery key must be 32-byte x-only");
    });
});
