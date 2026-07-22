<!-- mcp-name: io.github.obcraft/apiosk-mcp -->

# Publishing the Apiosk MCP server

This document is the release runbook for `io.github.obcraft/apiosk-mcp`. It
covers the npm package, the PyPI launcher, and the official MCP Registry entry.

## What is published where

| Artifact | Registry | Identifier | Ownership proof |
| --- | --- | --- | --- |
| Canonical server (npm) | npmjs.com | `@apiosk/mcp` | `mcpName` in `package.json` |
| Launcher (PyPI) | pypi.org | `apiosk-mcp` | `mcp-name:` marker in `README.md` |
| Metadata only | registry.modelcontextprotocol.io | `io.github.obcraft/apiosk-mcp` | GitHub auth on the `io.github.obcraft/` namespace |

The MCP Registry stores **metadata only**. The npm and PyPI packages must be
published *first*, because the registry verifies that the artifacts named in
`server.json` actually exist and carry the ownership marker.

## The single-version rule

Every release, these five values must be identical before you tag:

- `package.json` → `version`
- `pyproject.toml` → `version`
- `python/apiosk_mcp/__init__.py` → `__version__`
- `dxt.json` → `version`
- `server.json` → `version` **and** both `packages[].version` entries

And these three must match each other (they define identity, not version):

- `package.json` → `mcpName`
- `server.json` → `name`
- `README.md` → `mcp-name:` marker

`server.json` is validated against
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`.

## Automated release (preferred)

A GitHub Actions workflow at `.github/workflows/publish-mcp-registry.yml` runs
the whole release when you push a version tag. It verifies the versions agree
with the tag, publishes npm, publishes PyPI, then publishes `server.json` to the
registry via GitHub OIDC (no registry secret required).

One-time repository secrets to configure (Settings → Secrets and variables →
Actions):

- `NPM_TOKEN` — an npm automation token with publish rights to `@apiosk/mcp`
- `PYPI_API_TOKEN` — a PyPI API token scoped to `apiosk-mcp`

Then, to cut a release:

```bash
# 1. Bump the version in all five files to e.g. 1.7.1 (keep them in sync).
# 2. Commit.
git commit -am "chore: release v1.7.1"

# 3. Tag and push. The workflow does the rest.
git tag v1.7.1
git push origin main --tags
```

Confirm afterwards:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.obcraft/apiosk-mcp" \
  | python3 -m json.tool | grep -E '"version"|isLatest'
```

## Manual release (fallback, requires local credentials)

Run from the `mcp/` directory.

```bash
# --- npm ---
npm ci
npm publish --access public          # needs: npm login / npm adduser

# --- PyPI ---
python -m pip install --upgrade build twine
python -m build
python -m twine upload dist/*         # needs: a PyPI API token

# --- MCP Registry ---
# Install the publisher CLI:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" \
  | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

mcp-publisher login github               # opens GitHub device-flow in a browser
mcp-publisher publish                     # publishes ./server.json
```

Verify:

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.obcraft/apiosk-mcp"
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Registry validation failed for package` | The npm/PyPI package for this version isn't published yet, or its ownership marker doesn't match. Publish the package first; confirm `mcpName` (npm) / `mcp-name:` in README (PyPI) equals the `server.json` name. |
| `Invalid or expired Registry JWT token` | Re-run `mcp-publisher login github`. |
| `You do not have permission to publish this server` | GitHub identity doesn't own the `io.github.obcraft/` namespace. Publish as the `obcraft` account. |
| Registry still shows the old version | The registry caches; re-query after a minute. The `isLatest: true` entry is the one clients resolve. |
