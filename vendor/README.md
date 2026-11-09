# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-df7e0ee.tgz` is the built discovery client from
arkade-os/solver-registry commit `df7e0ee7a6abcdf7665892418d6477155601c041`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `f0d369731b39824d6697066a8d40431807c255aa477f2b7a402e9c812c2205b5`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
