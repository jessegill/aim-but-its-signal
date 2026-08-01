#!/usr/bin/env bash
#
# Point git at the repo's tracked hooks. Run once per clone.
#
#     ./scripts/hooks/install-hooks.sh
#
# Uses core.hooksPath rather than copying into .git/hooks so the hooks stay version
# controlled and updates arrive with a pull. No dependency, no husky, no postinstall.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

chmod +x scripts/hooks/pre-commit scripts/hooks/check-secrets.sh
git config core.hooksPath scripts/hooks

echo "ok  core.hooksPath -> scripts/hooks"
echo "    pre-commit will now run the account-state guard on every commit."
echo "    Undo with: git config --unset core.hooksPath"
