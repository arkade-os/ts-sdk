# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-6e9b577.tgz` is the built discovery client from
arkade-os/solver-registry commit `6e9b577f075878732d2f805bd00bbd69cf29fc49`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `571f08835bae031be86b5acde6cd9ee22b3f047524ebf7ab464491be518a48bf`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
Release preflight blocks swap and combined SDK releases while this file dependency remains.
