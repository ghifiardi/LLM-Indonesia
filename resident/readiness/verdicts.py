"""Three outcomes, never two.

Collapsing "we did not observe this" into either PASS or FAIL is what turns a
readiness review into a formality. A short window, a missing drill, an
under-sampled veto rate, and an event that simply never happened naturally are
all *absence of evidence* — they are neither a demonstration nor a defect.
"""

from __future__ import annotations

PASS = "pass"
FAIL = "fail"
INSUFFICIENT = "insufficient_evidence"

VERDICTS = (PASS, FAIL, INSUFFICIENT)


def combine(verdicts: list[str]) -> str:
    """PASS only if everything passed; any FAIL is FAIL; otherwise INSUFFICIENT."""

    if not verdicts:
        return INSUFFICIENT
    if any(verdict == FAIL for verdict in verdicts):
        return FAIL
    if all(verdict == PASS for verdict in verdicts):
        return PASS
    return INSUFFICIENT
