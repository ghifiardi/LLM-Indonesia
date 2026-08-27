"""Evidence readiness: drills, observations, and an advisory report.

Phase 5A. Builds the evidence package that must be recorded as passing before
limited automatic promotion is *designed* — it contains no promotion logic, and
nothing reads its output to authorise anything.

The distinction this package rests on:

* **Drills** deliberately induce a condition and verify the mechanism responded.
  They prove the code works on this build, machine and anchor set. They run in
  isolated state directories, because certifying production by breaking it
  proves something about a broken system.
* **Observations** are accumulated passively from real operation. They prove the
  deployment actually behaved.

A report that only drilled says "the code works". One that only observed says
"nothing broke, that we noticed". Both are reported, separately, and never
presented as each other.
"""

from __future__ import annotations

from .checks import CATALOGUE, DrillResult
from .observe import Observations, Segment, classify_freeze, gather, window_segments
from .report import Item, Report, generate, render
from .runner import DrillRun, run_drill, run_drills
from .verdicts import FAIL, INSUFFICIENT, PASS, combine

__all__ = [
    "CATALOGUE",
    "DrillResult",
    "DrillRun",
    "FAIL",
    "INSUFFICIENT",
    "Item",
    "Observations",
    "PASS",
    "Report",
    "Segment",
    "classify_freeze",
    "combine",
    "gather",
    "generate",
    "render",
    "run_drill",
    "run_drills",
    "window_segments",
]
