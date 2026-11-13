/**
 * Boards onchain outputs held by a custom tapscript into a virtual output.
 *
 * Needs Docker; starts the regtest stack if it isn't running. From the repo root:
 * ```
 * $ npx tsx packages/sdk/examples/node/custom-boarding.ts
 * ```
 */

import { execFileSync } from "node:child_process";
import {
    type ContractHandler,
    contractHandlers,
    CSVMultisigTapscript,
    ESPLORA_URL,
    EsploraProvider,
    type ExtendedCoin,
    hasBoardingTxExpired,
    MnemonicIdentity,
    MultisigTapscript,
    scriptFromTapLeafScript,
    networks,
    Ramps,
    type RelativeTimelock,
    RestOperatorProvider,
    VtxoScript,
    Wallet,
} from "../../src";
import {
    type SQLExecutor,
    SQLiteContractRepository,
    SQLiteWalletRepository,
} from "../../src/repositories/sqlite";
import { hex } from "@scure/base";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { EventSource } from "eventsource";

(globalThis as any).EventSource = EventSource;

const SEED_PHRASE =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" as const;
const BACKUP_SEED_PHRASE = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong" as const;
const OPERATOR_URL = "http://localhost:7070" as const;
const EXPLORER_URL = "http://localhost:3000" as const;
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

const regtest = (...args: string[]) =>
    execFileSync(process.execPath, ["regtest/regtest.mjs", ...args], {
        cwd: REPO_ROOT,
        stdio: "inherit",
    });

async function waitFor<T>(what: string, poll: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 60_000;
    for (;;) {
        const found = await poll();
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 1000));
    }
}

/** 0. Start the regtest stack, unless it's already running */
const isOperatorUp = () =>
    fetch(`${OPERATOR_URL}/v1/info`).then(
        (res) => res.ok,
        () => false,
    );
if (!(await isOperatorUp())) regtest("start", "--profile", "ark");

/** 1. Initialize SQLite database */
const initDB = (dbPath: string) => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    const sqlExecutor = {
        run: async (sql, params) => {
            db.prepare(sql).run(...((params ?? []) as SQLInputValue[]));
        },
        get: async <T>(sql: string, params?: unknown[]) =>
            db.prepare(sql).get(...((params ?? []) as SQLInputValue[])) as T | undefined,
        all: async <T>(sql: string, params?: unknown[]) =>
            db.prepare(sql).all(...((params ?? []) as SQLInputValue[])) as T[],
    } as const satisfies SQLExecutor;
    const closeDB = () => db.close();
    return { sqlExecutor, closeDB };
};
const { sqlExecutor, closeDB } = initDB("wallet.sqlite");

/** 2. Create user and backup identities */
const userIdentity = MnemonicIdentity.fromMnemonic(SEED_PHRASE, {
    isMainnet: false,
});
const backupIdentity = MnemonicIdentity.fromMnemonic(BACKUP_SEED_PHRASE, {
    isMainnet: false,
});

/** 3. Extract user and backup x-only public keys */
const userPubkey = await userIdentity.xOnlyPublicKey();
const backupPubkey = await backupIdentity.xOnlyPublicKey();

/** 4. Connect to operator */
const operator = new RestOperatorProvider(OPERATOR_URL);
const operatorInfo = await operator.getInfo();

/** 5. Extract operator x-only public key */
const operatorPubkey = hex.decode(operatorInfo.signerPubkey).slice(1);

/**
 * 6. Extract operator boarding exit timelock, and double it for recovery
 *
 * Delays below 512 are blocks (regtest), the rest seconds (BIP 68).
 */
const exitTimelock = {
    value: operatorInfo.boardingExitDelay,
    type: operatorInfo.boardingExitDelay >= 512n ? "seconds" : "blocks",
} as const satisfies RelativeTimelock;
const recoveryTimelock = {
    value: exitTimelock.value * 2n,
    type: exitTimelock.type,
} as const satisfies RelativeTimelock;

/** 7. Construct custom boarding tapscript (same as index.ts) */
const collaborativeScript = MultisigTapscript.encode({
    pubkeys: [userPubkey, operatorPubkey],
}).script;

const customBoardingTapscript = new VtxoScript([
    // user + operator (boarding spends this path)
    collaborativeScript,
    // user alone, after the boarding exit delay (unilateral exit)
    CSVMultisigTapscript.encode({
        pubkeys: [userPubkey],
        timelock: exitTimelock,
    }).script,
    // backup key alone, after twice the boarding exit delay (recovery)
    CSVMultisigTapscript.encode({
        pubkeys: [backupPubkey],
        timelock: recoveryTimelock,
    }).script,
]);
const boardingAddress = customBoardingTapscript.onchainAddress(networks.regtest);

/**
 * 8. Register a contract handler for raw tapscripts
 *
 * The wallet needs a contract for this script (step 10), and every contract
 * type needs a handler that rebuilds the script from the contract's params.
 * No built-in handler builds this script, so register one that stores the
 * whole tap tree. It returns no spending paths, because the wallet spends
 * these outputs only by boarding them, with the inputs from step 15.
 *
 * Scope 'onchain': without it the contract manager never syncs this script's
 * outputs, so it can't track them or mark them spent once boarded.
 *
 * deriveTapscripts: the leaf the wallet signs with. Without it the SDK expects
 * a DefaultVtxo.Script, and fails on any other tree.
 */
const RAW_TAPSCRIPT_HANDLER = {
    type: "raw-tapscript",
    defaultScope: "onchain",
    createScript: (params) => VtxoScript.decode(hex.decode(params.tapTree)),
    serializeParams: (params) => params,
    deserializeParams: (params) => params,
    selectPath: () => null,
    getAllSpendingPaths: () => [],
    getSpendablePaths: () => [],
    deriveTapscripts: (script: VtxoScript) => {
        // user + operator, the only leaf without a timelock
        const leaf = script.leaves.find(
            (leaf) => CSVMultisigTapscript.isScriptValid(scriptFromTapLeafScript(leaf)) !== true,
        );
        if (!leaf) throw new Error("No collaborative leaf in tap tree");
        return { forfeitTapLeafScript: leaf, proofTapLeafScript: leaf, tapTree: script.encode() };
    },
} satisfies ContractHandler<Record<string, string>> & {
    deriveTapscripts: (
        script: VtxoScript,
    ) => Pick<ExtendedCoin, "forfeitTapLeafScript" | "proofTapLeafScript" | "tapTree">;
};

contractHandlers.register(RAW_TAPSCRIPT_HANDLER);

/** 9. Create wallet */
const onchain = new EsploraProvider(ESPLORA_URL.regtest);
const wallet = await Wallet.create({
    identity: userIdentity,
    operatorProvider: operator,
    onchainProvider: onchain,
    /**
     * Explicitly disable settlement
     * Recommended to leave undefined for production
     */
    settlementConfig: false,
    /**
     * Explicitly disable address rotation
     * Recommended to use 'hd' for production
     */
    walletMode: "static",
    /**
     * Explicitly use SQLite storage
     * Defaults to IndexedDB if undefined
     */
    storage: {
        walletRepository: new SQLiteWalletRepository(sqlExecutor),
        contractRepository: new SQLiteContractRepository(sqlExecutor),
    },
});

/**
 * 10. Register the custom boarding tapscript as a contract
 *
 * The wallet signs an input only if its script matches one of the wallet's
 * contracts, or the wallet's own DefaultVtxo boarding script. It skips any
 * other input without an error, and that input reaches the operator unsigned.
 *
 * Watch 'retained': this script only holds onchain outputs, so the indexer
 * has nothing to watch. Registering the same script and type again does
 * nothing, so reruns are safe.
 */
const customScript = hex.encode(customBoardingTapscript.pkScript);
const contractManager = await wallet.getContractManager();
await contractManager.createContract({
    label: "Custom boarding",
    type: RAW_TAPSCRIPT_HANDLER.type,
    params: { tapTree: hex.encode(customBoardingTapscript.encode()) },
    script: customScript,
    address: boardingAddress,
    watch: "retained",
});

/**
 * 11. Report what the wallet sees
 *
 * The wallet balance counts its own boarding address and virtual outputs.
 * The custom boarding outputs appear only on their contract.
 *
 * Recoverable: virtual outputs past their batch expiry. Regtest batches
 * expire in minutes, and settlement is off, so nothing renews them.
 */
const report = async (stage: string) => {
    await contractManager.syncOnchain([customScript]);
    const balance = await wallet.getBalance();
    const [custom] = await contractManager.getContractsWithVtxos(
        { script: customScript },
        undefined,
        {
            unspentOnly: true,
        },
    );
    console.log(`\n${stage}`);
    console.table({
        "wallet boarding": balance.boarding.total,
        "wallet settled": balance.settled,
        "wallet preconfirmed": balance.preconfirmed,
        "wallet available": balance.available,
        "wallet recoverable": balance.recoverable,
        "wallet total": balance.total,
        "custom contract": custom.vtxos.reduce((sum, vtxo) => sum + vtxo.value, 0),
    });
};
await report("Before funding");

/**
 * 12. Fund the custom boarding address and wait for the output to confirm
 *
 * Wallet.getBoardingUtxos() only checks DefaultVtxo boarding addresses,
 * so ask the onchain provider directly.
 */
regtest("faucet", boardingAddress, "0.001", "--confirm");
const coins = await waitFor("a confirmed output", async () => {
    const found = await onchain.getCoins(boardingAddress);
    return found.some((coin) => coin.status.confirmed) ? found : undefined;
});
await report("After funding");

/**
 * 13. Attach the custom boarding tapscript to each output
 *
 * The wallet signs both the batch registration request and the commitment
 * transaction through the user + operator path. The SDK's helper for this,
 * extendCoinWithTapscript, is internal and only accepts DefaultVtxo.Script,
 * so reuse the handler's leaves.
 */
const tapscripts = RAW_TAPSCRIPT_HANDLER.deriveTapscripts(customBoardingTapscript);
const extendedCoins = coins.map((coin) => ({ ...coin, ...tapscripts })) satisfies ExtendedCoin[];

/**
 * 14. Keep the outputs the operator accepts
 *
 * The operator only accepts confirmed outputs whose shortest exit delay
 * (exitTimelock) hasn't passed yet. One rejected input fails the whole
 * boarding, so skip expired outputs: only an exit path can spend them.
 */
const confirmedCoins = extendedCoins.filter((coin) => coin.status.confirmed);
const tip = await onchain.getChainTip();
const boardingInputs: ExtendedCoin[] = [];
for (const coin of confirmedCoins) {
    // seconds timelocks count from the median time of the block before confirmation
    const parentTime =
        exitTimelock.type === "seconds"
            ? await onchain.getMedianTimePast(coin.status.block_height! - 1)
            : undefined;
    if (!hasBoardingTxExpired(coin, exitTimelock, tip.height, tip.time, parentTime)) {
        boardingInputs.push(coin);
    }
}

const expiredCount = confirmedCoins.length - boardingInputs.length;
if (expiredCount) {
    console.warn(`Skipping ${expiredCount} expired output(s), spend them through an exit path`);
}

if (!boardingInputs.length) {
    throw new Error("No outputs to board", { cause: boardingAddress });
}

/** 15. Board the outputs into a virtual output at the wallet's Arkade address */
console.log(
    `Boarding ${boardingInputs.length} output(s) to ${await wallet.getAddress()}, waiting for next batch...`,
);
const commitmentTxid = await new Ramps(wallet).onboard(
    operatorInfo.fees,
    boardingInputs,
    undefined,
    (event) => console.log(`  ${event.type}`),
);
console.log(`Boarded: ${EXPLORER_URL}/tx/${commitmentTxid}`);
await report("After boarding");

/** 16. Graceful shutdown */
console.log("Disposing wallet...");
await wallet.dispose();

console.log("Closing database...");
closeDB();
