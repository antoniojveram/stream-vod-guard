#!/usr/bin/env bash
# End-to-end demo: synthetic HLS live stream -> capture -> intentional crash ->
# watchdog restart -> final MKV with audio. Runs inside the Docker image.
set -euo pipefail
cd "$(dirname "$0")/.."
E2E=1 node --test test/e2e.test.js
