#!/usr/bin/env bash
# Blocks commits that would leak private data into this public repo.
# Generic patterns live here; private names (internal repo names, hostnames) go in
# .public-guard.local (gitignored), one extended regex per line.
set -euo pipefail
mode="${1:-staged}"
if [ "$mode" = "all" ]; then files=$(git ls-files); else files=$(git diff --cached --name-only --diff-filter=ACM); fi
[ -z "$files" ] && exit 0
patterns=(
  '[A-Za-z]:\Users\'                       # Windows home paths
  '/home/[a-z_][a-z0-9_-]*/'                  # Linux home paths
  '/Users/[A-Za-z0-9_-]+/'                    # macOS home paths
  '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'  # Tailscale CGNAT IPs
  '[a-z0-9-]+\.ts\.net'                       # tailnet hostnames
  'sk-ant-[A-Za-z0-9_-]{10,}'                 # Anthropic keys
  'gh[pousr]_[A-Za-z0-9]{20,}'                # GitHub tokens
  '"sessionId"\s*:\s*"[0-9a-f]{8}-'           # raw transcript lines
)
if [ -f .public-guard.local ]; then while IFS= read -r p; do [ -n "$p" ] && patterns+=("$p"); done < .public-guard.local; fi
fail=0
for p in "${patterns[@]}"; do
  # shellcheck disable=SC2086
  if hits=$(printf '%s\n' $files | grep -v '^scripts/public-guard.sh$' | xargs -r grep -nIiE -- "$p" 2>/dev/null); then
    echo "public-guard: pattern matched: $p"; echo "$hits" | sed 's/^/  /'; fail=1
  fi
done
if printf '%s\n' $files | grep -E '\.jsonl$' >/dev/null; then echo "public-guard: .jsonl file staged"; fail=1; fi
[ $fail -eq 0 ] || { echo "public-guard: commit blocked. Remove the data or adjust the file."; exit 1; }
