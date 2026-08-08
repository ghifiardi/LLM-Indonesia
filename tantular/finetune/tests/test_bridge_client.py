import pathlib

from tantular.finetune.bridge_client import BridgeClient

BRIDGE = pathlib.Path(__file__).parents[3] / "tantular_office_addin/tools/finetune/bridge.mjs"


def test_ready_and_commands():
    with BridgeClient(str(BRIDGE)) as bc:
        assert bc.ready["protocol_version"] == "1"
        prompts = bc.dump_prompts()
        assert len(prompts) == 9
        r = bc.validate_edit("Pendapatan naik.", [{"find": "naik", "replace": "meningkat", "occurrence": 1}])
        assert r["apply"]["text"] == "Pendapatan meningkat."
