import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command, directory, docker, owned, published, save, sdk, waitFor } from "./common.mjs";

export const inputs = {
    arkdCommit: "e0cbfd5d9c6dfc56924d39284edfa76ca8c5cbdd",
    regtestCommit: "8afc1eb8455fdc20a1df1237aff3787bd6913494",
    emulator:
        "ghcr.io/arkade-os/emulator@sha256:6539005abbaffee44a3a2f82072f49b0f926f32043bda12ab14658dc87f8889f",
    delegatee:
        "ghcr.io/arkade-os/delegatee@sha256:b49dd1ab434ac8472439a3e1f5bd676bcac06528ae8629e9a7017047e5f0c315",
    wallet: "ghcr.io/arkade-os/arkd-wallet@sha256:9c4092115440039e87f1fc7e053c388d508abb36edbe9fe07c9e0a140948edd2",
};
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
        "arkd",
    ];
    config.name = project;
    config.services = Object.fromEntries(services.map((name) => [name, config.services[name]]));
    config.services.redis = {
        image: "redis:7-alpine",
        healthcheck: {
            test: ["CMD", "redis-cli", "ping"],
            interval: "2s",
            timeout: "2s",
            retries: 30,
        },
        volumes: [{ type: "volume", source: "redis_data", target: "/data" }],
    };
    config.services["arkd-wallet"].image = inputs.wallet;
    config.services["arkd-wallet"].environment.ARKD_WALLET_SIGNER_KEY =
        randomBytes(32).toString("hex");
    const arkd = config.services.arkd;
    arkd.image = `${project}:arkd`;
    arkd.build = { context: directory, dockerfile: "Dockerfile" };
    arkd.depends_on.postgres = { condition: "service_healthy" };
    arkd.depends_on.redis = { condition: "service_healthy" };
    Object.assign(arkd.environment, {
        ARKD_BOARDING_EXIT_DELAY: "1536",
        ARKD_CHECKPOINT_EXIT_DELAY: "512",
        ARKD_UNILATERAL_EXIT_DELAY: "1024",
        ARKD_PUBLIC_UNILATERAL_EXIT_DELAY: "1024",
        ARKD_VTXO_TREE_EXPIRY: "6144",
        ARKD_DB_TYPE: "postgres",
        ARKD_EVENT_DB_TYPE: "postgres",
        ARKD_LIVE_STORE_TYPE: "redis",
        ARKD_PG_DB_URL: "postgresql://postgres@postgres:5432/projection?sslmode=disable",
        ARKD_PG_EVENT_DB_URL: "postgresql://postgres@postgres:5432/event?sslmode=disable",
        ARKD_PG_DB_AUTOCREATE: "true",
        ARKD_REDIS_URL: "redis://redis:6379/0",
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
        image: inputs.emulator,
        ports: [{ target: 7073 }],
        environment: {
            EMULATOR_PORT: "7073",
            EMULATOR_ARKD_URL: "arkd:7070",
            EMULATOR_ARKD_INDEXER_URL: "arkd:7070",
            EMULATOR_SECRET_KEY: randomBytes(32).toString("hex"),
        },
    };
    config.services.delegatee = {
        image: inputs.delegatee,
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
    await compose("build", "--pull", "arkd");
    await compose("pull", ...state.services.filter((name) => name !== "arkd"));
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
    await compose("up", "-d", "arkd-wallet", "arkd");
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
