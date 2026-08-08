from tantular.finetune.provenance import make_example


def test_schema_shape():
    ex = make_example(task="edit", split="train", family="memo-1",
                      messages=[{"role":"system","content":"s"}],
                      payload={"source_document":"d"},
                      generation={"teacher_model":"Qwen/Qwen3.5-397B-A17B","renderer":"qwen3_5_disable_thinking","bridge_protocol_version":"1","bridge_js_commit":"abc"},
                      training={"student_model":"Qwen/Qwen3-8B","renderer":"qwen3_disable_thinking"},
                      status="accepted", reject_reason=None)
    assert ex["provenance"]["generation"]["bridge_js_commit"] == "abc"
    assert ex["provenance"]["training"]["renderer"] == "qwen3_disable_thinking"
    assert ex["status"] == "accepted"
