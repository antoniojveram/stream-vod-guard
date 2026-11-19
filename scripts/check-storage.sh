#!/usr/bin/env bash
# Verify that a storage path exists, is writable and can hold large files.
set -euo pipefail

TARGET="${1:-./videos/recordings}"

if ! mountpoint -q "$(dirname "$TARGET")" 2>/dev/null; then
  echo "Note: $(dirname "$TARGET") does not look like a mount point." >&2
fi

mkdir -p "$TARGET"
echo "Directory: $TARGET"
df -h "$TARGET" | tail -1

TEST="$TARGET/.write-test-$$"
dd if=/dev/zero of="$TEST" bs=1M count=64 status=none
sync
SIZE=$(stat -c %s "$TEST")
rm -f "$TEST"
if [ "$SIZE" -ne 67108864 ]; then
  echo "ERROR: incomplete write ($SIZE bytes)" >&2
  exit 1
fi
echo "OK: 64 MB write verified."
