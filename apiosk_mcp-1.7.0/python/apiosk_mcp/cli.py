from __future__ import annotations

import os
import shutil
import subprocess
import sys
from typing import Sequence

from . import __version__

DEFAULT_NPM_PACKAGE = f"@apiosk/mcp@{__version__}"


def _print_help() -> None:
    print(
        "\n".join(
            [
                "apiosk-mcp: launch the official Apiosk MCP server over stdio.",
                "",
                "This PyPI package delegates to the canonical npm package:",
                f"  npx -y {DEFAULT_NPM_PACKAGE}",
                "",
                "Environment:",
                "  APIOSK_MCP_NPM_PACKAGE  Override the npm package spec to execute.",
                "  APIOSK_PRIVATE_KEY       Optional wallet key for automatic x402 payments.",
                "  APIOSK_CONNECT_TOKEN     Optional dashboard-managed access token.",
            ]
        )
    )


def _resolve_npx() -> str:
    npx = shutil.which("npx")
    if npx:
        return npx

    print(
        "apiosk-mcp requires Node.js and npx. Install Node.js 20+ first, then retry.",
        file=sys.stderr,
    )
    raise SystemExit(127)


def build_command(args: Sequence[str] | None = None) -> list[str]:
    package = os.environ.get("APIOSK_MCP_NPM_PACKAGE", DEFAULT_NPM_PACKAGE).strip()
    if not package:
        package = DEFAULT_NPM_PACKAGE

    return [_resolve_npx(), "-y", package, *(args or [])]


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    if args in (["--version"], ["-V"]):
        print(__version__)
        return 0

    if args in (["--help"], ["-h"]):
        _print_help()
        return 0

    command = build_command(args)

    if os.name == "posix":
        os.execv(command[0], command)
        return 127

    return subprocess.call(command)
