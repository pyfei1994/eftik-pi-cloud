import contextlib
import io
import json
import os
import pathlib
import runpy
import sys
import unittest
import urllib.error
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("kitsume-credential")
main = runpy.run_path(str(SCRIPT))["main"]
resolve_skill_id = runpy.run_path(str(SCRIPT))["resolve_skill_id"]


class CredentialCliTest(unittest.TestCase):
    def test_resolves_unique_package_slug_to_installed_directory(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            skills = pathlib.Path(root) / "skills" / "publisher--gzh-explosive-content-detector"
            skills.mkdir(parents=True)
            (skills / "SKILL.md").write_text("---\nname: wechat-search\n---\n")
            with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": root}):
                self.assertEqual("publisher--gzh-explosive-content-detector",
                                 resolve_skill_id("gzh-explosive-content-detector"))
                self.assertEqual("publisher--gzh-explosive-content-detector",
                                 resolve_skill_id("wechat-search"))

    def test_rejects_ambiguous_alias(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            for publisher in ("first", "second"):
                skill = pathlib.Path(root) / "skills" / (publisher + "--shared")
                skill.mkdir(parents=True)
                (skill / "SKILL.md").write_text("---\nname: internal\n---\n")
            with mock.patch.dict(os.environ, {"PI_CODING_AGENT_DIR": root}):
                with self.assertRaisesRegex(ValueError, "多个"):
                    resolve_skill_id("shared")

    def test_injects_only_requested_names_and_strips_service_token(self):
        requested = []

        def response(request, timeout):
            requested.append(request.full_url)
            name = request.full_url.rsplit("/", 1)[-1]
            value = {"API_KEY": "hidden-key", "BASE_URL": "https://example.test"}[name]
            return contextlib.closing(io.BytesIO(json.dumps({"code": 0, "data": {"value": value}}).encode()))

        argv = [str(SCRIPT), "run", "skill-1", "API_KEY,BASE_URL", "--", "tool", "arg"]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, {"KITSUME_CREDENTIAL_TOKEN": "service-token"}), \
             mock.patch("urllib.request.urlopen", side_effect=response), \
             mock.patch("subprocess.call", return_value=0) as call:
            self.assertEqual(0, main())
        self.assertEqual(2, len(requested))
        env = call.call_args.kwargs["env"]
        self.assertEqual("hidden-key", env["API_KEY"])
        self.assertEqual("https://example.test", env["BASE_URL"])
        self.assertNotIn("KITSUME_CREDENTIAL_TOKEN", env)

    def test_missing_name_is_reported_without_running_script(self):
        error = urllib.error.HTTPError("https://example.test", 404, "missing", {}, None)
        output = io.StringIO()
        argv = [str(SCRIPT), "run", "skill-1", "some_api_key", "--", "tool"]
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, {"KITSUME_CREDENTIAL_TOKEN": "service-token"}), \
             mock.patch("urllib.request.urlopen", side_effect=error), \
             mock.patch("subprocess.call") as call, \
             contextlib.redirect_stderr(output):
            self.assertEqual(3, main())
        call.assert_not_called()
        self.assertIn("MISSING_CREDENTIAL skill-1/some_api_key", output.getvalue())


if __name__ == "__main__":
    unittest.main()
