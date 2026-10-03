import { execSync } from "node:child_process";

/**
 * Run a CLI command in the arkd container.
 *
 * The CLI writes `error:` to stdout and exits 0, so a non-throwing call is not
 * a successful one — that prefix is checked explicitly. WARN lines are dropped
 * because they interleave with the value callers parse out.
 */
export const execCommand = (command: string): string => {
    const result = execSync(command, { encoding: "utf8" })
        .replace(/\r/g, "")
        .split("\n")
        .filter((line) => !line.includes("WARN"))
        .join("\n")
        .trim();
    if (result.startsWith("error:")) throw new Error(result);
    return result;
};

/**
 * Retry a command that drives a settlement round, printing why each time.
 *
 * A round that loses a participant fails for everyone in it, so `redeem-notes`
 * fails transiently under load — observed in CI as `missing forfeit
 * transactions` and `VTXO_ALREADY_SPENT`. Retrying is resilience against that,
 * NOT a fix: a silent retry would hide a deterministic failure, so the cause is
 * printed on every attempt and the last one is thrown with its own count.
 */
export const settle = (command: string, label: string, attempts = 3): string => {
    for (let attempt = 1; ; attempt++) {
        try {
            return execCommand(command);
        } catch (error) {
            const cause = error instanceof Error ? error.message : String(error);
            if (attempt === attempts) throw new Error(`${label} failed after ${attempt}: ${cause}`);
            console.log(`${label} attempt ${attempt} failed, retrying: ${cause}`);
        }
    }
};

/**
 * Fund addresses offchain from the arkd CLI wallet.
 *
 * One redemption for all of them: `redeem-notes` is what drives a round, while
 * `ark send` is offchain and cheap. Funding three wallets with three
 * redemptions stretched CI funding to 40 seconds and made the rounds contend
 * with each other; one redemption plus N sends took 78ms.
 */
export const faucet = (arkdExec: string, addresses: readonly string[], satsEach: number): void => {
    const note = execCommand(`${arkdExec} arkd note --amount ${satsEach * addresses.length * 2}`);
    settle(`${arkdExec} ark redeem-notes -n ${note} --password secret`, "redeem-notes");
    for (const address of addresses) {
        settle(
            `${arkdExec} ark send --to ${address} --amount ${satsEach} --password secret`,
            `send to ${address.slice(0, 12)}…`,
        );
    }
};
