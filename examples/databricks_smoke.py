"""Read-only Apiosk smoke test through a registered Databricks MCP service.

Requires DATABRICKS_MCP_SERVER_URL and Databricks SDK authentication.
Never discovers a paid request, approves a purchase, or executes an action.
"""

import json
import os
from urllib.parse import urlsplit


def main():
    from databricks.sdk import WorkspaceClient
    from databricks_mcp import DatabricksMCPClient

    workspace = WorkspaceClient()
    server_url = os.environ["DATABRICKS_MCP_SERVER_URL"]
    endpoint = urlsplit(server_url)
    workspace_url = urlsplit(workspace.config.host)
    if (endpoint.scheme != "https" or endpoint.netloc != workspace_url.netloc
            or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
            or not endpoint.path.startswith("/ai-gateway/mcp-services/")):
        raise ValueError("Use the registered MCP service URL from your authenticated Databricks workspace.")

    client = DatabricksMCPClient(server_url=server_url, workspace_client=workspace)
    names = {tool.name for tool in client.list_tools()}
    expected = {"apiosk_sources", "apiosk_discover", "apiosk_search", "apiosk_prepare", "apiosk_execute", "apiosk_status"}
    if "apiosk_approve" in names:
        raise RuntimeError("Deselect the app-only apiosk_approve tool in the Databricks MCP service.")
    if not expected.issubset(names):
        raise RuntimeError(f"Missing Apiosk agent tools: {sorted(expected - names)}")

    result = client.call_tool("apiosk_sources", {"limit": 1})
    if isinstance(result, dict):
        response = result
    else:
        response = result.model_dump(by_alias=True)
    if response.get("isError"):
        raise RuntimeError("Apiosk returned a tool error; inspect connection authorization in Databricks.")
    data = response.get("structuredContent")
    if not isinstance(data, dict):
        for block in response.get("content", []):
            if block.get("type") == "text":
                try:
                    candidate = json.loads(block["text"])
                except (ValueError, KeyError):
                    continue
                if isinstance(candidate, dict) and candidate.get("protocol_version") == "2":
                    data = candidate
                    break
    if not isinstance(data, dict) or data.get("protocol_version") != "2" or not isinstance(data.get("sources"), list):
        raise RuntimeError("Expected an Apiosk v2 source catalog response.")
    print(json.dumps({"status": "ok", "agent_tools": len(expected), "returned_sources": len(data["sources"]), "provider_purchases": 0}))


if __name__ == "__main__":
    main()
