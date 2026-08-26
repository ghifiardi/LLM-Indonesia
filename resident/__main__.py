"""Entry point so the resident CLI runs as a module.

    python3 -m godel_agent_prototype.resident init
    python3 -m godel_agent_prototype.resident reflect-once
"""

from __future__ import annotations

from .cli import main


if __name__ == "__main__":
    raise SystemExit(main())
