#!/bin/sh
# Usage: scripts/check-commit-scope.sh "<commit subject or PR title>"
#
# A conventional-commit scope names the package the change ships in, a directory under packages/
# (AGENTS.md, Commit Messages and PR Titles). Any other scope fails. A subject with no scope
# passes, as does one not in type(scope): form at all: merges, reverts, fixups.
set -eu
cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
    echo "usage: $0 \"<commit subject or PR title>\"" >&2
    exit 2
fi

# "<scope>" when the subject opens with type(scope): or type(scope)!:, empty otherwise.
scope=$(printf '%s\n' "$1" | sed -nE '1s/^[[:alpha:]]+\(([^)]*)\)!?:.*/<\1>/p')
[ -n "$scope" ] || exit 0
scope=${scope#<}
scope=${scope%>}

packages=
for manifest in packages/*/package.json; do
    [ -f "$manifest" ] || continue
    package=${manifest#packages/}
    package=${package%/package.json}
    [ "$scope" != "$package" ] || exit 0
    packages="${packages:+$packages, }$package"
done

cat >&2 <<EOF
"$1"
The scope "$scope" is not a package. Scope by the package the change ships in ($packages),
or leave the scope out when the change is not confined to one package.
See AGENTS.md, Commit Messages and PR Titles.
EOF
exit 1
