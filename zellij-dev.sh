#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

exec zellij --layout zellij-dev-layout.kdl
