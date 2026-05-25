#!/usr/bin/env python3
"""Run SWE-agent local deployment with a writable runtime root.

SWE-agent and SWE-ReX assume a Linux-like /root path for tools, state, and
submission files. macOS local deployment cannot write there, so the focused
eval adapter maps those paths to a per-run writable directory without changing
SWE-agent task semantics.
"""

from __future__ import annotations

import asyncio
import json
import os
import shlex
import sys
from pathlib import Path


def runtime_root() -> Path:
    return Path(os.environ.get("AIONIS_SWE_AGENT_LOCAL_ROOT", "/tmp/aionis-swe-agent-local-root")).resolve()


def force_symlink(target: Path, link: Path) -> None:
    try:
        if link.exists() or link.is_symlink():
            link.unlink()
        link.symlink_to(target)
    except OSError:
        pass


def prepare_runtime_root(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / ".bashrc").touch()
    bin_dir = root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    python = Path(sys.executable).resolve()
    force_symlink(python, bin_dir / "python")
    force_symlink(python, bin_dir / "python3")
    pip_wrapper = "\n".join([
        "#!/usr/bin/env sh",
        "if [ \"$1\" = \"install\" ]; then",
        f"  exec {shlex.quote(str(python))} -m pip \"$@\" --break-system-packages",
        "fi",
        f"exec {shlex.quote(str(python))} -m pip \"$@\"",
        "",
    ])
    for name in ("pip", "pip3"):
        target = bin_dir / name
        target.write_text(pip_wrapper)
        target.chmod(0o755)


def rewrite_root_literals(root: Path) -> None:
    tools_dir = root / "tools"
    if not tools_dir.exists():
        return
    for file in tools_dir.rglob("*"):
        if not file.is_file():
            continue
        try:
            text = file.read_text()
        except UnicodeDecodeError:
            continue
        patched = text.replace("/root/", f"{root.as_posix()}/").replace("/root", root.as_posix())
        if patched != text:
            file.write_text(patched)


def patch_swe_agent_local_root() -> None:
    root = runtime_root()
    prepare_runtime_root(root)
    root_bin = root / "bin"

    import sweagent.agent.agents as agents_mod
    import sweagent.environment.swe_env as swe_env_mod
    import sweagent.tools.tools as tools_mod
    from swerex.runtime.abstract import Command as RexCommand
    from swerex.runtime.abstract import CreateBashSessionRequest, UploadRequest

    original_set_env_variables = swe_env_mod.SWEEnv.set_env_variables

    def patched_init_deployment(self):
        self._chook.on_start_deployment()
        asyncio.run(self.deployment.start())
        asyncio.run(
            self.deployment.runtime.create_session(
                CreateBashSessionRequest(startup_source=[str(root / ".bashrc")], startup_timeout=10)
            )
        )
        original_set_env_variables(
            self,
            {"LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "PIP_PROGRESS_BAR": "off", "PAGER": "cat"},
        )
        self.logger.info("Environment Initialized")

    def patched_tool_reset(self, env):
        self.logger.info("Resetting tools")
        env_variables = self.config.env_variables.copy() | {
            var: os.getenv(var) for var in self.config.propagate_env_variables
        }
        env_variables["PATH"] = f"{root_bin}:{env_variables.get('PATH') or os.getenv('PATH', '')}"
        env.set_env_variables(env_variables)
        env.write_file(str(root / ".swe-agent-env"), json.dumps(self.config.registry_variables))
        env.write_file(str(root / "state.json"), "{}")
        if self._reset_commands:
            env.communicate(" && ".join(self._reset_commands), check="raise", timeout=self.config.install_timeout)

    async def patched_upload_bundles(self, env):
        await env.deployment.runtime.execute(
            RexCommand(command=f"rm -rf {shlex.quote(str(root / 'tools'))}", shell=True)
        )
        await asyncio.gather(
            *(
                env.deployment.runtime.upload(
                    UploadRequest(
                        source_path=bundle.path.as_posix(),
                        target_path=str(root / "tools" / bundle.path.name),
                    )
                )
                for bundle in self.config.bundles
            )
        )
        rewrite_root_literals(root)

    def patched_install_commands(self, env):
        env.set_env_variables(self.config.env_variables)
        cwd = env.communicate("pwd", check="raise").strip()
        asyncio.run(self._upload_bundles(env))
        bundle_bin_paths = [str(root_bin)]
        for bundle in self.config.bundles:
            bundle_dir = root / "tools" / bundle.path.name
            bundle_bin_paths.append(str(bundle_dir / "bin"))
            bundle_dir_q = shlex.quote(str(bundle_dir))
            root_bin_q = shlex.quote(str(root_bin))
            cmds = [
                f"export PATH={root_bin_q}:{bundle_dir_q}/bin:$PATH",
                f"chmod +x {bundle_dir_q}/bin/*",
            ]
            if (bundle.path / "install.sh").exists():
                cmds.append(f"cd {bundle_dir_q} && source install.sh")
            cmds.append(f"chmod +x {bundle_dir_q}/bin/*")
            env.communicate(" && ".join(cmds), check="raise", timeout=self.config.install_timeout)
        env.communicate(f"cd {shlex.quote(cwd)}", check="raise")
        existing_path = env.communicate("echo $PATH", check="raise").strip()
        path = ":".join([*bundle_bin_paths, existing_path])
        env.set_env_variables({"PATH": path})
        asyncio.run(self._check_available_commands(env, {"PATH": path}))

    def patched_get_state(self, env):
        try:
            state_str = env.read_file(str(root / "state.json"))
            return json.loads(state_str)
        except Exception:
            return {}

    def repo_cwd(agent):
        repo_name = "/"
        if agent._env is not None and agent._env.repo is not None:
            repo_name = f"/{agent._env.repo.repo_name}"
        return repo_name

    def write_model_patch(agent):
        assert agent._env is not None
        submission_command = f"git add -A && git diff --cached > {shlex.quote(str(root / 'model.patch'))}"
        cwd = repo_cwd(agent)
        agent.logger.info("Executing submission command %s in %s", submission_command, cwd)
        agent._env.execute_command(submission_command, check=True, cwd=cwd)

    def patched_handle_submission(self, step, *, observation="", force_submission=False):
        step = step.model_copy(deep=True)
        assert self.tools is not None
        action_text = getattr(step, "action", "") or ""
        action_requested_submit = action_text.strip() == "submit"
        is_submission = self.tools.check_for_submission_cmd(observation or step.observation) or action_requested_submit
        if is_submission or force_submission:
            assert self._env is not None
            if action_requested_submit or force_submission:
                try:
                    write_model_patch(self)
                except Exception as exc:
                    self.logger.error("Failed to write submission patch, got %s", exc)
            try:
                submission = self._env.read_file(str(root / "model.patch"), encoding="utf-8", errors="backslashreplace")
            except FileNotFoundError:
                self.logger.warning("Submission file not found, no submission was made")
                return step
            except Exception as exc:
                self.logger.exception("Failed to read submission file, got %s", exc)
                return step
            step.submission = submission if submission.strip() else None
            step.observation = submission
            if not step.exit_status:
                step.exit_status = "submitted"
            elif step.submission:
                step.exit_status = f"submitted ({step.exit_status})"
            step.done = True
            self.logger.info("Found submission: %s", submission)
        return step

    def patched_attempt_autosubmission_after_error(self, step):
        self.logger.warning("Attempting autosubmission after error")
        step = step.model_copy(deep=True)
        step.done = True
        assert self._env is not None
        if not asyncio.run(self._env.deployment.is_alive(timeout=10)):
            self.logger.error("Runtime is no longer alive")
            try:
                last_trajectory_step = self.trajectory[-1]
            except IndexError:
                self.logger.info("No last trajectory step to extract patch from")
                return step
            if "diff" not in last_trajectory_step["state"]:
                self.logger.info("No diff in last trajectory step state, cannot autosubmit")
                return step
            diff = last_trajectory_step["state"]["diff"]
            self.logger.info("Using diff from last trajectory step to autosubmit")
            step.submission = diff
            if step.submission:
                step.observation = "Environment died unexpectedly. Exited (autosubmitted)"
                step.exit_status = f"submitted ({step.exit_status})"
            else:
                self.logger.info("Diff from last traj step empty.")
            return step

        try:
            write_model_patch(self)
        except Exception as exc:
            self.logger.error("Failed to execute submission command, got %s", exc)
        step = self.handle_submission(step, observation="", force_submission=True)
        if step.submission:
            self.logger.info("Exiting with autosubmission")
            step.observation = "Exited (autosubmitted)"
        return step

    swe_env_mod.SWEEnv._init_deployment = patched_init_deployment
    tools_mod.ToolHandler.reset = patched_tool_reset
    tools_mod.ToolHandler._upload_bundles = patched_upload_bundles
    tools_mod.ToolHandler._install_commands = patched_install_commands
    tools_mod.ToolHandler._get_state = patched_get_state
    agents_mod.DefaultAgent.handle_submission = patched_handle_submission
    agents_mod.DefaultAgent.attempt_autosubmission_after_error = patched_attempt_autosubmission_after_error


def main() -> int:
    patch_swe_agent_local_root()
    from sweagent.run.run import main as swe_agent_main

    result = swe_agent_main()
    return 0 if result is None else int(result)


if __name__ == "__main__":
    sys.exit(main())
