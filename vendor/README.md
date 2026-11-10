# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-2ee6a81.tgz` is the built discovery client from
arkade-os/solver-registry commit `2ee6a813b346a20d0320429f4b15df6c526f86ec`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `88cc3f9ddf3d30c86e8873657dd080cf8d7342ed4b55f8f1774d40754d7827a6`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
Release preflight blocks swap and combined SDK releases while this file dependency remains.
