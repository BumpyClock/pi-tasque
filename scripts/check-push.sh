#!/bin/sh
set -eu
[ "$(node --version)" = v26.12.1 ] || { echo 'Use Node 26.12.1 from .node-version; prepare dependencies with npm ci.' >&2; exit 1; }
[ "$(npm --version)" = 11.12.0 ] || { echo 'Use npm 11.12.0, then npm ci.' >&2; exit 1; }
[ -x node_modules/.bin/tsc ] && [ -x node_modules/.bin/vitest ] || { echo 'Missing prepared project tools. Run npm ci before pushing.' >&2; exit 1; }
# Full project checks avoid unsafe affected-only skips, including unknown/new refs.
npm run typecheck
npm test
