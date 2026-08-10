"""Shared post-processing for decoded Tinker teacher output.

Split out (D2, ft-fixD review finding) from gen_prose.py, where
`_strip_trailing_chat_terminator` originally lived and was applied only in
`TinkerProseTeacher.sample()`. `TinkerRouterTeacher.sample()` (gen_router.py)
decodes teacher output with the exact same `tokenizer.decode` pattern and
feeds it into `_split_candidates` (the router synthesis path), which does
NOT strip a trailing chat-template terminator -- so the token could land
inside accepted router-synthesis completions. Both teachers now import this
shared helper instead of gen_router.py reaching into gen_prose.py (or
duplicating the function), keeping the two synthesis modules decoupled from
each other while sharing the one post-processing rule that both need.

`TinkerEditTeacher` (gen_edit.py) deliberately does NOT use this: its
consumer `_parse_edits_json` slices `text.find("{")..text.rfind("}")`, which
structurally discards any trailing terminator token regardless -- stripping
here would be redundant, not incorrect, so it's intentionally left alone
(see the comment at that call site).
"""

_CHAT_TEMPLATE_TERMINATORS = ("<|im_end|>",)


def strip_trailing_chat_terminator(text):
    """Strip a trailing chat-template terminator token (e.g. `<|im_end|>`)
    and surrounding whitespace from decoded teacher output, at the source.
    Only removes a terminator that is *trailing* -- after stripping trailing
    whitespace, the string ends with the terminator; loops to also catch a
    terminator followed by more trailing whitespace/terminators. A
    terminator occurring mid-text (e.g. quoted inside sampled prose) is
    never touched, since it isn't at the end of the string.
    """
    if not isinstance(text, str):
        return text
    result = text
    while True:
        stripped = result.rstrip()
        matched = None
        for terminator in _CHAT_TEMPLATE_TERMINATORS:
            if stripped.endswith(terminator):
                matched = terminator
                break
        if matched is None:
            return stripped
        result = stripped[: -len(matched)]
