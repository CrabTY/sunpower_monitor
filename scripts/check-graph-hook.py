"""Exercise local pushes and worktrees with fake Graphify; no external services."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    root = Path(__file__).resolve().parents[1]
    names = ("graph.json", "graph.html", "GRAPH_REPORT.md")
    with tempfile.TemporaryDirectory(prefix="sunpower-hook-check-") as temporary:
        repo = Path(temporary) / "repo"
        repo.mkdir()
        bin_dir = Path(temporary) / "bin"
        bin_dir.mkdir()
        for command in ("git", "mktemp", "mkdir", "rm", "cp", "tar", "cmp"):
            (bin_dir / command).symlink_to(shutil.which(command))
        graphify = bin_dir / "graphify"
        graphify.write_text(f"#!{sys.executable}\n" + '''
import os
from pathlib import Path
import sys
assert sys.argv[1:] == ["update", "."]
assert not Path(".git").exists()
assert not Path("untracked.py").exists()
if os.environ.get("FAIL_GRAPHIFY"):
    sys.exit(1)
out = Path("graphify-out")
out.mkdir(exist_ok=True)
for name in ("graph.json", "graph.html", "GRAPH_REPORT.md"):
    (out / name).write_text(Path("source.py").read_text())
''')
        graphify.chmod(0o755)
        env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        env.update(PATH=str(bin_dir), GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")

        def git(*args, failure=None, cwd=repo, extra_env=None):
            result = subprocess.run(
                [str(bin_dir / "git"), *args], cwd=cwd,
                env={**env, **(extra_env or {})}, text=True, capture_output=True,
            )
            if failure is not None:
                assert result.returncode != 0, result.stdout
                assert failure in result.stdout + result.stderr, result.stderr
            else:
                assert result.returncode == 0, result.stderr
            return result.stdout

        remote = Path(temporary) / "remote.git"
        git("init", "--quiet", "--initial-branch=main")
        git("init", "--quiet", "--bare", str(remote))
        git("config", "user.name", "Hook test")
        git("config", "user.email", "hook@example.com")
        git("remote", "add", "origin", str(remote))
        (repo / ".githooks").mkdir()
        shutil.copy2(root / ".githooks/pre-push", repo / ".githooks/pre-push")
        git("config", "core.hooksPath", ".githooks")
        source = repo / "source.py"
        source.write_text("value = 1\n")
        git("add", ".")
        git("commit", "--quiet", "-m", "Code without a graph")
        head = git("rev-parse", "HEAD")
        git("push", "origin", "main", failure="Push paused")
        assert git("rev-parse", "HEAD") == head
        git("diff", "--cached", "--exit-code")
        assert git("ls-remote", "origin", "refs/heads/main") == ""
        for name in names:
            assert (repo / "graphify-out" / name).read_text() == "value = 1\n"
        git("add", "graphify-out")
        git("commit", "--quiet", "-m", "Graph results")
        git("push", "origin", "main")
        remote_before = git("ls-remote", "origin", "refs/heads/main")

        source.write_text("value = 2\n")
        git("add", "source.py")
        git("commit", "--quiet", "-m", "Integrated code")
        secondary = Path(temporary) / "secondary"
        git("worktree", "add", "--detach", str(secondary), "HEAD")
        git("push", "origin", "HEAD:main", cwd=secondary, failure="Push paused")
        assert (secondary / "graphify-out/graph.json").read_text() == "value = 2\n"
        assert (repo / "graphify-out/graph.json").read_text() == "value = 1\n"
        git("worktree", "remove", "--force", str(secondary))
        assert git("ls-remote", "origin", "refs/heads/main") == remote_before

        output = repo / "graphify-out/graph.json"
        output.write_text("preserve this graph edit\n")
        git("push", "origin", "main", failure="will not overwrite")
        assert output.read_text() == "preserve this graph edit\n"
        git("add", str(output))
        git("push", "origin", "main", failure="will not overwrite")
        git("restore", "--staged", "--worktree", "--", "graphify-out/graph.json")
        git("push", "origin", "main", failure="", extra_env={"FAIL_GRAPHIFY": "1"})
        assert output.read_text() == "value = 1\n"

        source.write_text("uncommitted = 99\n")
        (repo / "untracked.py").write_text("do_not_include = True\n")
        git("push", "origin", "main", failure="Push paused")
        assert output.read_text() == "value = 2\n"
        assert source.read_text() == "uncommitted = 99\n"
        assert (repo / "untracked.py").exists()
        git("diff", "--cached", "--exit-code")
        assert git("ls-remote", "origin", "refs/heads/main") == remote_before
        git("add", "graphify-out")
        git("commit", "--quiet", "-m", "Updated graph")
        graphify.unlink()
        git("push", "origin", "main", failure="Graphify is required")
        git("branch", "feature")
        git("push", "origin", "feature")
        assert git("ls-remote", "origin", "refs/heads/feature").startswith(git("rev-parse", "HEAD").strip())
        print("Graph hook checks passed: main only, worktree isolation, exact commit, preserved edits, failed rebuild, missing tool.")


if __name__ == "__main__":
    main()
