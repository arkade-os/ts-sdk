import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, docker, owned, published, save, sdk, waitFor } from "./common.mjs";

// Image versions come from this regtest commit's .env.defaults; bump the pin to change them.
export const inputs = { regtestCommit: "a1b4fdc859b41281d00d16596408055f254225bf" };
export async function createStack(output) {
    assert.equal(process.version, "v24.22.1");
    assert.equal(
        await command("git", ["-C", "regtest", "rev-parse", "HEAD"]),
        inputs.regtestCommit,
    );
    assert.equal(await command("git", ["-C", "regtest", "status", "--porcelain"]), "");
    const runId = randomUUID(),
        project = `native-proof-${runId}`,
        prefix = `${project}-`;
    const run = join(resolve(output), runId);
    await mkdir(join(run, "private"), { recursive: true, mode: 0o700 });
    await mkdir(join(run, "public"), { mode: 0o700 });
    const state = {
        runId,
        run,
        project,
        prefix,
        composeFile: join(run, "private/compose.json"),
        startedAt: new Date().toISOString(),
        inputs,
    };
    const config = JSON.parse(
        await docker(
            "compose",
            "--env-file",
            "regtest/.env.defaults",
            "--profile",
            "*",
            "-f",
            "regtest/docker/compose.base.yml",
            "-f",
            "regtest/docker/compose.ark.yml",
            "config",
            "--format",
            "json",
        ),
    );
    const services = [
        "bitcoin",
        "postgres",
        "nbxplorer",
        "fulcrum",
        "mempool_mariadb",
        "mempool_api",
        "mempool_web",
        "arkd-wallet",
        "arkd-signer",
        "redis",
        "arkd",
    ];
    config.name = project;
    const { emulator, delegatee } = config.services;
    config.services = Object.fromEntries(services.map((name) => [name, config.services[name]]));
    config.services["arkd-signer"].environment.ARKD_SIGNER_SECRET_KEY =
        randomBytes(32).toString("hex");
    const arkd = config.services.arkd;
    Object.assign(arkd.environment, {
        ARKD_BOARDING_EXIT_DELAY: "1536",
        ARKD_CHECKPOINT_EXIT_DELAY: "512",
        ARKD_UNILATERAL_EXIT_DELAY: "1024",
        ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "1024",
        ARKD_VTXO_TREE_EXPIRY: "6144",
        ARKD_INDEXER_EXPOSURE: "public",
        ARKD_SESSION_DURATION: "10",
        ARKD_UNLOCKER_PASSWORD: "secret",
        ARKD_ROUND_MIN_PARTICIPANTS_COUNT: "1",
        ARK_OFFCHAIN_INPUT_FEE: "0.0",
        ARK_OFFCHAIN_OUTPUT_FEE: "0.0",
        ARK_ONCHAIN_INPUT_FEE: "0.0",
        ARK_ONCHAIN_OUTPUT_FEE: "0.0",
    });
    config.services.emulator = {
        image: emulator.image,
        ports: [{ target: 7073 }],
        environment: {
            EMULATOR_PORT: "7073",
            EMULATOR_ARKD_URL: "arkd:7070",
            EMULATOR_ARKD_INDEXER_URL: "arkd:7070",
            EMULATOR_SECRET_KEY: randomBytes(32).toString("hex"),
        },
    };
    config.services.delegatee = {
        image: delegatee.image,
        ports: [{ target: 7080 }],
        environment: {
            DELEGATEE_ARK_URL: "arkd:7070",
            DELEGATEE_EMULATOR_URL: "emulator:7073",
            DELEGATEE_EXPLORER_URL: "http://mempool_web/api",
            DELEGATEE_DATABASE_URL: "postgres://postgres@postgres:5432/postgres?sslmode=disable",
            DELEGATEE_DELEGATE_KEY: randomBytes(32).toString("hex"),
            DELEGATEE_ADMIN_AUTH: "disabled",
            DELEGATEE_ONCHAIN_POLL_INTERVAL: "1s",
            DELEGATEE_RENEWAL_TIMEOUT: "30s",
            DELEGATEE_RENEWAL_RESERVE: "6200s",
            DELEGATEE_BOARDING_MAX_WAIT: "0s",
        },
    };
    const volumes = new Set();
    for (const [name, service] of Object.entries(config.services)) {
        delete service.profiles;
        service.container_name = `${prefix}${name}`;
        service.platform = "linux/amd64";
        service.restart = "no";
        service.labels = { "io.arkade.proof.run": runId };
        service.networks = { default: null };
        for (const port of service.ports ?? []) {
            port.published = "0";
            port.host_ip = "127.0.0.1";
        }
        for (const volume of service.volumes ?? []) {
            assert.equal(volume.type, "volume");
            volumes.add(volume.source);
        }
    }
    config.volumes = Object.fromEntries(
        [...volumes].map((name) => [
            name,
            { name: `${project}_${name}`, labels: { "io.arkade.proof.run": runId } },
        ]),
    );
    config.networks = {
        default: { name: `${project}_default`, labels: { "io.arkade.proof.run": runId } },
    };
    await save(state.composeFile, config);
    state.services = Object.keys(config.services);
    state.images = Object.fromEntries(
        Object.entries(config.services).map(([name, service]) => [name, service.image]),
    );
    state.privateKeyFile = join(run, "private/owner.json");
    state.database = join(run, "private/wallet.sqlite");
    await save(join(run, "private/state.json"), state);
    return state;
}
export async function startStack(state) {
    const compose = (...args) =>
        command("docker", ["compose", "-p", state.project, "-f", state.composeFile, ...args], {
            timeout: 1200000,
        });
    await compose("pull", ...state.services);
    await compose(
        "up",
        "-d",
        ...state.services.filter(
            (name) => !["arkd", "arkd-wallet", "emulator", "delegatee"].includes(name),
        ),
    );
    const rpc = async (...args) => {
        await owned(state, `${state.prefix}bitcoin`);
        return docker(
            "exec",
            `${state.prefix}bitcoin`,
            "bitcoin-cli",
            "-regtest",
            "-rpcuser=admin1",
            "-rpcpassword=123",
            ...args.map(String),
        );
    };
    const chain = await waitFor("Bitcoin RPC", async () => {
        try {
            return JSON.parse(await rpc("getblockchaininfo"));
        } catch {
            return false;
        }
    });
    assert.equal(chain.chain, "regtest");
    assert.equal(Number(await rpc("getblockcount")), 0, "The chain must be fresh");
    if (JSON.parse(await rpc("listwallets")).length === 0) await rpc("createwallet", "proof");
    assert.equal(JSON.parse(await rpc("listwallets")).length, 1);
    const address = await rpc("getnewaddress");
    await rpc("generatetoaddress", 101, address);
    // arkd exits if arkd-wallet isn't listening yet, and the proof disables restarts.
    await compose("up", "-d", "arkd-wallet");
    const wallet = await owned(state, `${state.prefix}arkd-wallet`);
    await waitFor("arkd-wallet", () =>
        docker("exec", wallet.Id, "nc", "-z", "127.0.0.1", "6060").then(
            () => true,
            () => false,
        ),
    );
    await compose("up", "-d", "arkd");
    const arkd = await owned(state, `${state.prefix}arkd`);
    state.arkUrl = published(arkd, 7070);
    const adminUrl = published(arkd, 7071);
    state.esploraUrl = `${published(await owned(state, `${state.prefix}mempool_web`), 80)}/api`;
    const request = async (path, body) => {
        const response = await fetch(`${adminUrl}${path}`, {
            ...(body
                ? {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(body),
                  }
                : {}),
            signal: AbortSignal.timeout(10000),
        });
        assert(response.ok, `Admin ${path}: HTTP ${response.status}`);
        return response.json();
    };
    let status = await waitFor("arkd admin", async () => {
        try {
            return await request("/v1/admin/wallet/status");
        } catch {
            return false;
        }
    });
    assert.equal(status.initialized, false, "The operator wallet must be fresh");
    const { seed } = await request("/v1/admin/wallet/seed");
    await request("/v1/admin/wallet/create", { seed, password: "secret" });
    status = await request("/v1/admin/wallet/status");
    if (!status.unlocked) await request("/v1/admin/wallet/unlock", { password: "secret" });
    await waitFor(
        "arkd wallet sync",
        async () => (await request("/v1/admin/wallet/status")).synced,
    );
    const operator = await request("/v1/admin/wallet/address");
    for (let i = 0; i < 21; i++) await rpc("sendtoaddress", operator.address, 1);
    await rpc("generatetoaddress", 1, address);
    await request("/v1/admin/intentFees", {
        fees: {
            offchainInputFee: "0.0",
            onchainInputFee: "0.0",
            offchainOutputFee: "0.0",
            onchainOutputFee: "0.0",
        },
    });
    await waitFor("Esplora tip", async () => {
        try {
            return (
                Number(await (await fetch(`${state.esploraUrl}/blocks/tip/height`)).text()) >=
                Number(await rpc("getblockcount"))
            );
        } catch {
            return false;
        }
    });
    state.backendBinarySha256 = (await docker("exec", arkd.Id, "sha256sum", "/app/arkd")).split(
        /\s+/,
    )[0];
    const arkInfo = await new sdk.RestArkProvider(state.arkUrl).getInfo();
    assert.equal(arkInfo.network, "regtest");
    await compose("up", "-d", "emulator");
    state.emulatorUrl = published(await owned(state, `${state.prefix}emulator`), 7073);
    const info = await waitFor("emulator", async () => {
        try {
            return await new sdk.RestEmulatorProvider(state.emulatorUrl).getInfo();
        } catch {
            return false;
        }
    });
    state.emulatorPublicKey = info.signerPubkey;
    await compose("up", "-d", "delegatee");
    state.delegateeUrl = published(await owned(state, `${state.prefix}delegatee`), 7080);
    const delegated = await waitFor("delegatee", async () => {
        try {
            return await new sdk.RestDelegateeProvider(state.delegateeUrl).getInfo();
        } catch {
            return false;
        }
    });
    assert.equal(delegated.network, "regtest");
    assert.equal(delegated.emulatorPubkey.slice(-64), info.signerPubkey.slice(-64));
    state.readyAt = new Date().toISOString();
    const identities = [];
    for (const name of state.services) {
        const c = await owned(state, `${state.prefix}${name}`);
        const [image] = JSON.parse(await docker("image", "inspect", c.Image));
        identities.push({
            name,
            containerId: c.Id,
            imageId: c.Image,
            configuredImage: c.Config.Image,
            repositoryDigests: image.RepoDigests,
        });
    }
    await save(join(state.run, "public/services.json"), {
        inputs,
        images: state.images,
        identities,
        backendBinarySha256: state.backendBinarySha256,
        emulator: info,
        delegatee: delegated,
        startedAt: state.startedAt,
        readyAt: state.readyAt,
    });
    await save(join(state.run, "private/state.json"), state);
}
export async function stopStack(state) {
    const ids = (
        await docker(
            "ps",
            "-aq",
            "--no-trunc",
            "--filter",
            `label=io.arkade.proof.run=${state.runId}`,
        )
    )
        .split(/\s+/)
        .filter(Boolean);
    for (const id of ids) {
        const container = await owned(state, id);
        if (container.State.Paused) await docker("unpause", id);
        await docker("stop", "-t", "30", id);
    }
    await save(join(state.run, "public/cleanup.json"), {
        stoppedContainerIds: ids,
        stoppedAt: new Date().toISOString(),
        volumesDeleted: false,
    });
}
