# Deployment and release boundary

Version 3.0.0 replaces the source implementation in the canonical `obcraft/apiosk-mcp` repository. These manifests describe the intended release; their presence is not evidence that npm, a registry, Claude Desktop or Fly runs that version.

Pushing `main` runs checks only. Fly deployment and npm publication use separate `workflow_dispatch` workflows with explicit confirmation inputs. Version tags do not deploy or publish. The previous repository's automatic main-push Fly deployment and tag-triggered npm/PyPI/registry publication are deliberately not retained.

## Hosted state

The hosted service uses the existing Fly app `apiosk-mcp`, public origin `https://mcp.apiosk.com`, Gateway v2 origin and configured OAuth secrets. Keep those existing identities and secrets when deploying. This replacement does not rotate them or provision infrastructure.

`APIOSK_MCP_STATE_DIR=/data/state` contains private saved conversations, evidence and durable approval intent. `fly.toml` mounts an existing `mcp_state` volume at `/data`. Before the first deployment, provision and review that volume in `ams`, retain any prior journal data and back it up. The container initializes this directory's permissions and runs the service as the unprivileged `node` user.

Run **one machine** with this file-backed journal. A local Fly volume is not a shared database; independent replicas would have different conversation histories and approval journals. The deployment workflow refuses an existing multi-machine topology and uses `--ha=false`. Do not add replicas or separate regional volumes until state ownership, distributed locking and interrupted-approval recovery have been implemented and verified.

Deployment readiness still requires an authenticated end-to-end check against the target Gateway, valid OAuth redirects and secrets, durable-volume restoration, and verified source/approval recovery. `/health` confirms the MCP process, not source execution or deployment acceptance. A tester or protocol test does not establish a delivered message, paid retrieval or running recurring job.

## Package metadata

The npm identity is `@apiosk/mcp`; the MCP registry identity remains `io.github.obcraft/apiosk-mcp`. `server.json` advertises the npm artifact and hosted endpoint. No unimplemented PyPI wrapper is advertised. Public npm publication and registry updates are separate operations.

`manifest.json` follows the [official MCPB manifest format](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md). `dxt.json` carries the same metadata for tooling that still reads that filename. A manifest is not a built or installed desktop bundle. Bundle creation must include the entry point, pinned dependencies, source and brand assets, and be validated in the intended host.

The [official MCP registry format](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md) describes `server.json`. Its package version must already be publicly available before publishing registry metadata.
