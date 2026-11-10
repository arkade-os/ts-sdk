# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-c1f70dd.tgz` is the built discovery client from
arkade-os/solver-registry commit `c1f70dd493841f6a310ab82205f44d0bd59d4a55`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `3c43ef315e6cfe37d1aa5a984fd0502ac41d056f2e2066d3745f51a9877cbf3b`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
Release preflight blocks swap and combined SDK releases while this file dependency remains.
