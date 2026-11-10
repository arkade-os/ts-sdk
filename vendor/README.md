# Vendored discovery dependency

`arkade-os-solver-discovery-0.3.0-routing-b5b414d.tgz` is the built discovery client from
arkade-os/solver-registry commit `b5b414d33d1bf18161a29e00db4e89cddf446a08`,
[PR #42](https://github.com/arkade-os/solver-registry/pull/42).

SHA256: `41034fa5c4928e5fadd6421a2b64a3571b6442a61fd5820e281c7aa1ffdfe576`.

Built with the package's `build` script and packed using `npm pack --ignore-scripts`.
The swap package uses this artifact until the additive solver-routing exports are published.
Replace its file dependency with that release and regenerate the lockfile when available.
Release preflight blocks swap and combined SDK releases while this file dependency remains.
