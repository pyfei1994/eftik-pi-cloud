import importlib.util
import os
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path


spec = importlib.util.spec_from_file_location("skill_installer", Path(__file__).with_name("skill-installer.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class SkillInstallerTest(unittest.TestCase):
    def test_installs_full_package_and_replaces_existing(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            destination = Path(root) / "installed"
            destination.mkdir()
            (destination / "old.txt").write_text("old")
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("skill/SKILL.md", "---\nname: example\n---\n")
                package.writestr("skill/references/usage.md", "full package")
                script = zipfile.ZipInfo("skill/setup.sh")
                script.create_system = 3
                script.external_attr = (stat.S_IFREG | 0o755) << 16
                package.writestr(script, "#!/bin/sh\n")
            installer.install(str(archive), str(destination))
            self.assertTrue((destination / "SKILL.md").is_file())
            self.assertEqual((destination / "references/usage.md").read_text(), "full package")
            self.assertTrue((destination / "setup.sh").is_file())
            if os.name != "nt":
                self.assertTrue((destination / "setup.sh").stat().st_mode & stat.S_IXUSR)
            self.assertFalse((destination / "old.txt").exists())

    def test_rejects_traversal_without_replacing_existing(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "bad.zip"
            destination = Path(root) / "installed"
            destination.mkdir()
            (destination / "SKILL.md").write_text("existing")
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("SKILL.md", "new")
                package.writestr("../escape.txt", "bad")
            with self.assertRaises(ValueError):
                installer.install(str(archive), str(destination))
            self.assertEqual((destination / "SKILL.md").read_text(), "existing")
            self.assertFalse((Path(root) / "escape.txt").exists())

    def test_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "bad.zip"
            symlink = zipfile.ZipInfo("scripts/tool")
            symlink.create_system = 3
            symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("SKILL.md", "skill")
                package.writestr(symlink, "/tmp/target")
            with self.assertRaises(ValueError):
                installer.install(str(archive), str(Path(root) / "installed"))

    def test_finds_nested_manifest_with_root_readme_and_system_junk(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            destination = Path(root) / "installed"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("README.md", "repository overview")
                package.writestr("__MACOSX/._SKILL.md", "junk")
                package.writestr("package/skill.md", "---\nname: example\n---\n")
                package.writestr("package/scripts/tool.py", "print('ok')")
            installer.install(str(archive), str(destination))
            self.assertTrue((destination / "SKILL.md").is_file())
            self.assertTrue((destination / "scripts/tool.py").is_file())
            self.assertFalse((destination / "README.md").exists())

    def test_rejects_ambiguous_skill_package(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("one/SKILL.md", "one")
                package.writestr("two/SKILL.md", "two")
            with self.assertRaisesRegex(ValueError, "只能包含一个"):
                installer.install(str(archive), str(Path(root) / "installed"))

    def test_prefers_root_manifest_over_nested_example(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            destination = Path(root) / "installed"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("SKILL.md", "---\nname: root\ndescription: Root skill\n---\n")
                package.writestr("examples/other/SKILL.md", "example")
            installer.install(str(archive), str(destination))
            self.assertIn("name: root", (destination / "SKILL.md").read_text())

    def test_adds_missing_description_so_pi_can_load_skill(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            destination = Path(root) / "publisher--example"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("SKILL.md", "---\nname: example\ndescription: \"\"\n---\n\n# Useful Search\n")
            installer.install(str(archive), str(destination))
            content = (destination / "SKILL.md").read_text()
            self.assertIn('description: "Useful Search"', content)
            self.assertEqual(content.count("description:"), 1)

    def test_rejects_unclosed_frontmatter(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "skill.zip"
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("SKILL.md", "---\nname: broken\n# Body")
            with self.assertRaisesRegex(ValueError, "没有结束标记"):
                installer.install(str(archive), str(Path(root) / "installed"))


if __name__ == "__main__":
    unittest.main()
