import os
import unittest
from unittest import mock

from apiosk_mcp import __version__
from apiosk_mcp.cli import DEFAULT_NPM_PACKAGE, build_command, main


class CliTests(unittest.TestCase):
    def test_default_package_tracks_python_version(self):
        self.assertEqual(DEFAULT_NPM_PACKAGE, f"@apiosk/mcp@{__version__}")

    @mock.patch("shutil.which", return_value="/usr/local/bin/npx")
    def test_build_command_uses_npx_and_pinned_npm_package(self, _which):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                build_command(["--probe"]),
                ["/usr/local/bin/npx", "-y", DEFAULT_NPM_PACKAGE, "--probe"],
            )

    @mock.patch("shutil.which", return_value="/opt/bin/npx")
    def test_build_command_allows_npm_package_override(self, _which):
        with mock.patch.dict(os.environ, {"APIOSK_MCP_NPM_PACKAGE": "@apiosk/mcp@next"}):
            self.assertEqual(build_command(), ["/opt/bin/npx", "-y", "@apiosk/mcp@next"])

    def test_version_does_not_start_stdio_server(self):
        with mock.patch("os.execv") as execv:
            self.assertEqual(main(["--version"]), 0)
            execv.assert_not_called()


if __name__ == "__main__":
    unittest.main()
