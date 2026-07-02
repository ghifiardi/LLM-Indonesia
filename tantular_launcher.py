"""Tantular launcher — an Ollama-style interactive menu for the Indonesian SLM.

Run with no arguments for a keyboard-driven menu (arrow keys + Enter, or number
keys); falls back to a numbered prompt when stdin is not a TTY. Non-interactive
flags (--list / --chat / --bakeoff / --build) make it scriptable and testable.

    python3 -m godel_agent_prototype.tantular_launcher
    python3 -m godel_agent_prototype.tantular_launcher --chat tantular:0.1-id-safety
    python3 -m godel_agent_prototype.tantular_launcher --bakeoff
    python3 -m godel_agent_prototype.tantular_launcher --build

The Chat action uses `ollama run <tag>`, so it exercises the tag's built-in
Modelfile SYSTEM prompt (unlike the scored benchmark, which injects its own).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

TANTULAR_DIR = Path(__file__).with_name("tantular")

# tag -> Modelfile, in lineage/build order. LoRA needs a local adapter.
VARIANTS: list[tuple[str, str]] = [
    ("tantular:0.1-base", "Modelfile.base"),
    ("tantular:0.1-id", "Modelfile.id"),
    ("tantular:0.1-id-safety", "Modelfile.id-safety"),
    ("tantular:0.1-id-lora", "Modelfile.id-lora"),
]

CSI = "\x1b["


@dataclass
class MenuItem:
    label: str
    sublabel: str
    action: Callable[[], int]


# --- ollama helpers -------------------------------------------------------


def ollama_available() -> bool:
    return shutil.which("ollama") is not None


def installed_tags() -> set[str]:
    """Return the set of tantular:* tags currently registered with Ollama."""

    if not ollama_available():
        return set()
    try:
        out = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=15
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return set()
    tags: set[str] = set()
    for line in out.splitlines()[1:]:
        name = line.split()[0] if line.split() else ""
        if name.startswith("tantular:"):
            tags.add(name)
    return tags


def chat_with(tag: str) -> int:
    """Hand the terminal to `ollama run <tag>` for an interactive chat."""

    if not ollama_available():
        print("ollama is not installed (https://ollama.com/download).")
        return 1
    print(f"\nStarting chat with {tag}. Type /bye to exit.\n")
    return subprocess.run(["ollama", "run", tag]).returncode


def build_variants() -> int:
    """`ollama create` each variant whose Modelfile exists (skip LoRA w/o adapter)."""

    if not ollama_available():
        print("ollama is not installed (https://ollama.com/download).")
        return 1
    rc = 0
    for tag, modelfile in VARIANTS:
        path = TANTULAR_DIR / modelfile
        if not path.exists():
            continue
        if "lora" in tag and not (TANTULAR_DIR / "adapters").exists():
            print(f"skip  {tag} (no tantular/adapters/ present)")
            continue
        print(f"build {tag} <- tantular/{modelfile}")
        result = subprocess.run(["ollama", "create", tag, "-f", str(path)])
        rc = rc or result.returncode
    return rc


def run_bakeoff() -> int:
    """Score the installed tantular tags on the holdout split."""

    tags = sorted(installed_tags()) or ["tantular:0.1-id-safety"]
    cmd = [
        sys.executable,
        "-m",
        "godel_agent_prototype.benchmark_ollama_models",
        "--split",
        "holdout",
        "--models",
        *tags,
    ]
    print(f"\nrunning: {' '.join(cmd)}\n")
    return subprocess.run(cmd, cwd=str(Path(__file__).resolve().parent.parent)).returncode


def list_tags() -> int:
    tags = installed_tags()
    if not tags:
        print("No tantular:* tags found. Choose 'Build variants' first.")
        return 0
    print("Installed Tantular tags:")
    for tag in sorted(tags):
        print(f"  - {tag}")
    return 0


# --- menu construction ----------------------------------------------------


def build_menu() -> list[MenuItem]:
    """Assemble the menu; chat entries are offered per installed tag."""

    installed = installed_tags()
    items: list[MenuItem] = []

    preferred = [t for t, _ in VARIANTS if "id" in t]  # id / safety / lora first
    for tag in preferred:
        if tag in installed:
            note = {
                "tantular:0.1-id-safety": "safety-hardened (recommended)",
                "tantular:0.1-id": "Indonesian assistant",
                "tantular:0.1-id-lora": "LoRA fine-tuned",
            }.get(tag, "chat")
            items.append(MenuItem(f"Chat with {tag}", note, lambda t=tag: chat_with(t)))

    if not any(i.label.startswith("Chat") for i in items):
        items.append(
            MenuItem(
                "Build variants first",
                "no tantular:* tags installed yet",
                build_variants,
            )
        )

    items.append(MenuItem("Run bake-off", "score variants on the holdout split", run_bakeoff))
    items.append(MenuItem("Build / rebuild variants", "ollama create from Modelfiles", build_variants))
    items.append(MenuItem("List Tantular tags", "show installed tantular:* models", list_tags))
    items.append(MenuItem("Quit", "exit the launcher", lambda: 0))
    return items


# --- rendering / input ----------------------------------------------------


def _render(items: list[MenuItem], selected: int) -> None:
    sys.stdout.write(CSI + "2J" + CSI + "H")  # clear + home
    print("Tantular — Indonesian safety-and-service SLM\n")
    for i, item in enumerate(items):
        pointer = "▸" if i == selected else " "
        head = f"{CSI}1m{item.label}{CSI}0m" if i == selected else item.label
        print(f"{pointer} {head}")
        print(f"    {CSI}2m{item.sublabel}{CSI}0m")
    print(f"\n{CSI}2m↑/↓ or number to move · Enter to select · q to quit{CSI}0m")


def _read_key() -> str:
    import termios
    import tty

    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        ch = sys.stdin.read(1)
        if ch == "\x1b":
            seq = sys.stdin.read(2)
            return {"[A": "up", "[B": "down"}.get(seq, "esc")
        if ch in ("\r", "\n"):
            return "enter"
        if ch in ("\x03", "q", "Q"):
            return "quit"
        return ch
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)


def _interactive_loop(items: list[MenuItem]) -> int:
    selected = 0
    while True:
        _render(items, selected)
        key = _read_key()
        if key == "up":
            selected = (selected - 1) % len(items)
        elif key == "down":
            selected = (selected + 1) % len(items)
        elif key.isdigit() and 1 <= int(key) <= len(items):
            selected = int(key) - 1
            key = "enter"
        if key == "quit":
            return 0
        if key == "enter":
            item = items[selected]
            if item.label == "Quit":
                return 0
            sys.stdout.write(CSI + "2J" + CSI + "H")
            item.action()
            input("\nPress Enter to return to the menu...")


def _numbered_fallback(items: list[MenuItem]) -> int:
    print("Tantular launcher (non-interactive)\n")
    for i, item in enumerate(items, start=1):
        print(f"  {i}. {item.label} — {item.sublabel}")
    try:
        choice = int(input("\nSelect a number: ").strip())
    except (ValueError, EOFError):
        return 0
    if 1 <= choice <= len(items):
        return items[choice - 1].action()
    return 0


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="Print the menu items and exit.")
    parser.add_argument("--chat", metavar="TAG", help="Chat directly with a tantular tag.")
    parser.add_argument("--bakeoff", action="store_true", help="Run the holdout bake-off and exit.")
    parser.add_argument("--build", action="store_true", help="Build/rebuild variants and exit.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)

    if args.chat:
        return chat_with(args.chat)
    if args.bakeoff:
        return run_bakeoff()
    if args.build:
        return build_variants()

    items = build_menu()
    if args.list:
        for i, item in enumerate(items, start=1):
            print(f"{i}. {item.label} — {item.sublabel}")
        return 0

    if sys.stdin.isatty() and sys.stdout.isatty():
        try:
            return _interactive_loop(items)
        except (KeyboardInterrupt, EOFError):
            print()
            return 0
    return _numbered_fallback(items)


if __name__ == "__main__":
    raise SystemExit(main())
