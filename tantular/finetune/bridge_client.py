"""Python client for the Node JSONL bridge (tantular_office_addin/tools/finetune/bridge.mjs).

Spawns the bridge as a persistent subprocess, speaks its one-JSON-per-line
wire protocol, and exposes the add-in's real prompt registry and edit
validators to the fine-tuning harness. Never reimplements bridge behavior —
just a thin, blocking RPC wrapper.
"""

import itertools
import json
import subprocess


class BridgeError(RuntimeError):
    """Raised when the bridge responds with ok=false (or a malformed line)."""


class BridgeClient:
    def __init__(self, bridge_path, node_bin="node"):
        self.bridge_path = str(bridge_path)
        self._proc = subprocess.Popen(
            [node_bin, self.bridge_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._ids = itertools.count(1)

        ready_line = self._proc.stdout.readline()
        if not ready_line:
            stderr = self._proc.stderr.read()
            raise BridgeError(f"bridge produced no ready line; stderr: {stderr}")
        self.ready = json.loads(ready_line)

    def _rpc(self, cmd, args=None):
        req_id = next(self._ids)
        self._proc.stdin.write(json.dumps({"id": req_id, "cmd": cmd, "args": args or {}}) + "\n")
        self._proc.stdin.flush()

        while True:
            line = self._proc.stdout.readline()
            if not line:
                stderr = self._proc.stderr.read()
                raise BridgeError(f"bridge closed stdout while awaiting id={req_id}; stderr: {stderr}")
            resp = json.loads(line)
            if resp.get("id") != req_id:
                # Not our response (shouldn't happen with a synchronous, single
                # in-flight-request protocol, but don't silently swallow it).
                continue
            if not resp.get("ok", False):
                raise BridgeError(resp.get("error", "unknown bridge error"))
            return resp["result"]

    def dump_prompts(self):
        return self._rpc("dump-prompts")

    def validate_edit(self, doc_text, edits):
        return self._rpc("validate-edit", {"docText": doc_text, "edits": edits})

    def close(self):
        if self._proc.poll() is None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
            self._proc.terminate()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False
