# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-f45f92e.tgz` is the built discovery client from
arkade-os/solver-registry commit `f45f92e5bb8c24b1962dc753d5dc97bab782a1cc`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `baf89b56b80e84d671cbd5475a6ebafbc8b305aca6fbefb909ea8373360b2dca`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
