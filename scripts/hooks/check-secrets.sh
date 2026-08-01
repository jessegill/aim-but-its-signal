#!/usr/bin/env bash
#
# Account-state / secret guard.
#
# SPEC.md §10: the app links as a *real* Signal device and a linked device has full account
# access. This repository is public. Nothing that could reconstruct, hijack, or leak account
# state may ever reach a commit — signal-cli account files, key material, local databases, or
# a device-linking URI.
#
# This is the single source of truth for the rule. It is used by:
#   - scripts/hooks/pre-commit          (local, scans the staged index)
#   - .github/workflows/ci.yml          (CI, scans tracked files and the PR diff)
#
# Usage:
#   check-secrets.sh --staged            scan files staged for commit (blob content from index)
#   check-secrets.sh --tracked           scan every tracked file in the worktree
#   check-secrets.sh --range BASE..HEAD  scan files changed in a range
#   check-secrets.sh --files f1 f2 ...   scan an explicit list
#
# Exit 0 = clean, 1 = at least one finding, 2 = usage error.

set -uo pipefail

RED=''
YELLOW=''
BOLD=''
RESET=''
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  RED=$'\033[31m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
fi

# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------

# Paths that must never be committed, matched case-insensitively against the repo-relative
# path. Extended regular expressions.
PATH_PATTERNS=(
  # Local databases (SPEC.md §8: the store holds decrypted-at-use message content)
  '\.(db|db-journal|db-wal|db-shm|sqlite|sqlite3|sqlitedb)$'

  # signal-cli account state. The daemon stores an account as `data/<E.164>` plus a
  # `data/<E.164>.d/` directory, alongside these stores.
  '(^|/)\.?signal-cli(-data)?(/|$)'
  '(^|/)data/\+[0-9]{6,15}(\.d)?(/|$)'
  '(^|/)\+[0-9]{9,15}(\.d)?(/|$)'
  '(^|/)accounts\.json$'
  '(^|/)(recipients-store|identity-store|session-store|sender-keys|group-store|sticker-packs)(/|$)'
  '(^|/)(sessions|identities|pre-keys|signed-pre-keys|kyber-pre-keys)/'
  # Real message media the daemon downloads. Root-anchored so a legitimate
  # src/renderer/ui/attachments/ component directory is not caught.
  '^(attachments|avatars|stickers|contact-avatars|profile-avatars)/'

  # Key material / credentials
  '\.(pem|key|p8|p12|pfx|jks|keystore|asc|gpg|kdbx|ppk|mobileprovision|cer|der|crt)$'
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)$'
  '(^|/)\.netrc$'
  # .npmrc is intentionally NOT blocked by path: the repo commits a secret-free one that
  # documents the native-module build. It is caught by content instead (registry auth tokens).

  # Local env files (.env.example is carved out via PATH_ALLOW below)
  '(^|/)\.env(\.[^/]*)?$'
)

# Paths matching these are never reported, even if a PATH_PATTERN would hit.
PATH_ALLOW=(
  '(^|/)\.env\.example$'
  '(^|/)resources/icons/[^/]+\.(cer|der|crt)$'
)

# Content signatures. Any hit is fatal. Kept high-signal so the guard does not get disabled
# for crying wolf.
CONTENT_PATTERNS=(
  # Signal device-linking URI. Narrowed to require actual key material in a parameter
  # rather than matching the bare scheme, so protocol documentation can write the shape
  # (`sgnl://linkdevice?uuid=…&pub_key=…`) without tripping the guard. A real URI always
  # carries long base64 values here, so anything genuinely sensitive still matches.
  'sgnl://linkdevice\?[^[:space:]]*(uuid|pub_key)=[A-Za-z0-9%+/_-]{16,}'
  'tsdevice:/'                                         # legacy device-linking URI
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '-----BEGIN PGP PRIVATE KEY BLOCK-----'
  '(aci|pni)IdentityKeyPair'                           # signal-cli account json
  '"(identityPrivateKey|masterKey|storageKey|pniRegistrationId)"'
  '"profileKey"[[:space:]]*:[[:space:]]*"[A-Za-z0-9+/=]{16,}"'
  '"password"[[:space:]]*:[[:space:]]*"[^"]{12,}"'
  '"(registrationId|encryptedDeviceName)"[[:space:]]*:'
  '_auth(Token)?[[:space:]]*=[[:space:]]*[^[:space:]$]'   # npm registry credentials in .npmrc
  '(GITHUB|GH|NPM)_TOKEN[[:space:]]*=[[:space:]]*[A-Za-z0-9_-]{16,}'
)

# Files exempted from the *content* scan only. This script necessarily contains the
# signatures it searches for; nothing else belongs here.
CONTENT_ALLOW=(
  '(^|/)scripts/hooks/check-secrets\.sh$'
)

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

MODE=""
RANGE=""
declare -a EXPLICIT_FILES=()

case "${1:-}" in
  --staged)  MODE=staged ;;
  --tracked) MODE=tracked ;;
  --range)
    MODE=range
    RANGE="${2:-}"
    if [ -z "$RANGE" ]; then echo "check-secrets: --range needs a revision range" >&2; exit 2; fi
    ;;
  --files)
    MODE=files
    shift
    EXPLICIT_FILES=("$@")
    ;;
  -h|--help|"")
    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
  *)
    echo "check-secrets: unknown option '$1'" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-secrets: not inside a git repository" >&2
  exit 2
}
cd "$REPO_ROOT" || exit 2

# ---------------------------------------------------------------------------
# File list
# ---------------------------------------------------------------------------

declare -a FILES=()
case "$MODE" in
  staged)
    while IFS= read -r line; do [ -n "$line" ] && FILES+=("$line"); done \
      < <(git diff --cached --name-only --diff-filter=ACMR -z | tr '\0' '\n')
    ;;
  tracked)
    while IFS= read -r line; do [ -n "$line" ] && FILES+=("$line"); done \
      < <(git ls-files -z | tr '\0' '\n')
    ;;
  range)
    while IFS= read -r line; do [ -n "$line" ] && FILES+=("$line"); done \
      < <(git diff --name-only --diff-filter=ACMR -z "$RANGE" | tr '\0' '\n')
    ;;
  files)
    FILES=("${EXPLICIT_FILES[@]}")
    ;;
esac

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "check-secrets: no files to scan (${MODE})"
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

matches_any() {
  # $1 = subject, rest = ERE patterns
  local subject="$1"; shift
  local pattern
  for pattern in "$@"; do
    if printf '%s' "$subject" | grep -Eiq -- "$pattern"; then
      return 0
    fi
  done
  return 1
}

# Emit file content for scanning: from the index in --staged mode (so partially staged
# changes are judged on what is actually being committed), from the worktree otherwise.
read_content() {
  local file="$1"
  if [ "$MODE" = "staged" ]; then
    git show ":$file" 2>/dev/null
  elif [ "$MODE" = "range" ]; then
    git show "${RANGE##*..}:$file" 2>/dev/null || cat -- "$file" 2>/dev/null
  else
    cat -- "$file" 2>/dev/null
  fi
}

FINDINGS=0
report() {
  FINDINGS=$((FINDINGS + 1))
  printf '%s%sBLOCKED%s %s\n         %s\n' "$RED" "$BOLD" "$RESET" "$1" "$2"
}

# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

for file in "${FILES[@]}"; do
  # ---- path rules ----
  if ! matches_any "$file" "${PATH_ALLOW[@]}"; then
    for pattern in "${PATH_PATTERNS[@]}"; do
      if printf '%s' "$file" | grep -Eiq -- "$pattern"; then
        report "$file" "path matches forbidden pattern: $pattern"
        break
      fi
    done
  fi

  # ---- content rules ----
  matches_any "$file" "${CONTENT_ALLOW[@]}" && continue

  content="$(read_content "$file")"
  [ -z "$content" ] && continue

  # grep -I skips binary payloads; run it once per pattern against the captured content.
  for pattern in "${CONTENT_PATTERNS[@]}"; do
    hit="$(printf '%s' "$content" | grep -InEm1 -- "$pattern" 2>/dev/null)"
    if [ -n "$hit" ]; then
      lineno="${hit%%:*}"
      report "$file:$lineno" "content matches forbidden signature: $pattern"
    fi
  done
done

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [ "$FINDINGS" -gt 0 ]; then
  cat >&2 <<EOF

${RED}${BOLD}$FINDINGS finding(s). Refusing to proceed.${RESET}

This repository is public and the app links as a real Signal device with full account
access (SPEC.md §10). Signal account state, key material, local databases and device-linking
URIs must never be committed.

If a finding is a false positive, add a narrow exception to scripts/hooks/check-secrets.sh
in its own commit and say why. Do not use --no-verify.
EOF
  exit 1
fi

printf '%sok%s check-secrets: %d file(s) scanned (%s), no account state or key material found\n' \
  "$YELLOW" "$RESET" "${#FILES[@]}" "$MODE"
exit 0
