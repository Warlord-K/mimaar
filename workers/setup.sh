#!/usr/bin/env bash
# Creates the Python environment the server uses to process uploaded databags.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv-worker
.venv-worker/bin/pip install --upgrade pip >/dev/null
.venv-worker/bin/pip install -r workers/requirements.txt
echo "Worker ready: $(pwd)/.venv-worker/bin/python"
