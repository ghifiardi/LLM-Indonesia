import pathlib
import pytest

from tantular.finetune.bridge_client import BridgeClient, BridgeError

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"


def test_ready_and_commands():
    with BridgeClient(str(BRIDGE)) as bc:
        assert bc.ready["protocol_version"] == "1"
        prompts = bc.dump_prompts()
        assert len(prompts) == 9
        r = bc.validate_edit("Pendapatan naik.", [{"find": "naik", "replace": "meningkat", "occurrence": 1}])
        assert r["apply"]["text"] == "Pendapatan meningkat."


def test_bridge_error_on_unknown_command():
    with BridgeClient(str(BRIDGE)) as bc:
        with pytest.raises(BridgeError):
            bc._rpc("no-such-cmd", {})
