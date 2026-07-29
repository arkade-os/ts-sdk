/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    // Required in a monorepo: these packages are linked from source and ship
    // untranspiled ESM referencing workspace siblings, which Next will not
    // resolve from node_modules without being told to transpile them.
    transpilePackages: [
        "@arkade-os/sats-connect-react",
        "@arkade-os/sats-connect",
        "@arkade-os/wallet-providers",
        "@arkade-os/checkout",
    ],
};

export default nextConfig;
