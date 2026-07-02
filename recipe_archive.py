"""Archive of Indonesian-support recipe variants for DGM-style evolution.

The Darwin Gödel Machine keeps an *archive* of every discovered variant instead
of hill-climbing on the current best. It selects parents roughly in proportion
to performance and inversely to how many children they already have, so strong
but under-explored variants get explored while every variant keeps a non-zero
selection probability. This module implements that bookkeeping for prompt/recipe
"organisms" rather than full coding agents.

It is deliberately dependency-free and deterministic given a seed, so runs are
reproducible and auditable.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class RecipeNode:
    """One archived recipe variant plus its evaluation and lineage metadata."""

    node_id: int
    recipe: dict[str, Any]
    public_score: float
    parent_id: int | None = None
    origin: str = "seed"
    children: int = 0
    valid: bool = True
    public_category_means: dict[str, float] = field(default_factory=dict)
    public_dimension_means: dict[str, float] = field(default_factory=dict)
    notes: str = ""

    @property
    def name(self) -> str:
        return str(self.recipe.get("name", f"node_{self.node_id}"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "name": self.name,
            "recipe": self.recipe,
            "public_score": self.public_score,
            "parent_id": self.parent_id,
            "origin": self.origin,
            "children": self.children,
            "valid": self.valid,
            "public_category_means": self.public_category_means,
            "public_dimension_means": self.public_dimension_means,
            "notes": self.notes,
        }


@dataclass
class RecipeArchive:
    """Population-based archive with reproducible parent selection."""

    seed: str = "dgm-recipe-archive-v1"
    nodes: list[RecipeNode] = field(default_factory=list)
    _next_id: int = field(default=0, init=False)

    def add(
        self,
        recipe: dict[str, Any],
        public_score: float,
        parent_id: int | None = None,
        origin: str = "mutation",
        valid: bool = True,
        public_category_means: dict[str, float] | None = None,
        public_dimension_means: dict[str, float] | None = None,
        notes: str = "",
    ) -> RecipeNode:
        node = RecipeNode(
            node_id=self._next_id,
            recipe=dict(recipe),
            public_score=public_score,
            parent_id=parent_id,
            origin=origin,
            valid=valid,
            public_category_means=dict(public_category_means or {}),
            public_dimension_means=dict(public_dimension_means or {}),
            notes=notes,
        )
        self.nodes.append(node)
        self._next_id += 1
        if parent_id is not None:
            parent = self.get(parent_id)
            if parent is not None:
                parent.children += 1
        return node

    def get(self, node_id: int) -> RecipeNode | None:
        for node in self.nodes:
            if node.node_id == node_id:
                return node
        return None

    def valid_nodes(self) -> list[RecipeNode]:
        return [node for node in self.nodes if node.valid]

    def best(self) -> RecipeNode | None:
        valid = self.valid_nodes()
        if not valid:
            return None
        return max(valid, key=lambda node: (node.public_score, -node.node_id))

    def signature(self, recipe: dict[str, Any]) -> str:
        payload = json.dumps(_signature_payload(recipe), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def contains(self, recipe: dict[str, Any]) -> bool:
        target = self.signature(recipe)
        return any(self.signature(node.recipe) == target for node in self.nodes)

    def select_parent(self, iteration: int) -> RecipeNode | None:
        """DGM-style selection: high score, few children, always non-zero weight.

        Deterministic given ``seed`` and ``iteration`` so runs reproduce exactly.
        """

        candidates = self.valid_nodes()
        if not candidates:
            return None

        scores = [max(0.0, node.public_score) for node in candidates]
        max_score = max(scores) or 1.0
        weights: list[float] = []
        for node, score in zip(candidates, scores):
            # Sigmoid-like preference for strong performers (paper favours high
            # scorers) combined with an exploration bonus for few-children nodes.
            performance = 0.15 + (score / max_score)
            exploration = 1.0 / (1.0 + node.children)
            weights.append(performance * exploration)

        total = sum(weights)
        if total <= 0:
            return candidates[iteration % len(candidates)]

        # Deterministic weighted pick using a stable hash as the random draw.
        draw = _stable_unit_interval(self.seed, iteration) * total
        cumulative = 0.0
        for node, weight in zip(candidates, weights):
            cumulative += weight
            if draw <= cumulative:
                return node
        return candidates[-1]

    def lineage(self, node_id: int) -> list[int]:
        chain: list[int] = []
        current = self.get(node_id)
        while current is not None:
            chain.append(current.node_id)
            if current.parent_id is None:
                break
            current = self.get(current.parent_id)
        return list(reversed(chain))

    def to_records(self) -> list[dict[str, Any]]:
        return [node.to_dict() for node in self.nodes]

    def write_jsonl(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            for node in self.nodes:
                handle.write(json.dumps(node.to_dict(), ensure_ascii=False) + "\n")


def _signature_payload(recipe: dict[str, Any]) -> dict[str, Any]:
    payload = dict(recipe)
    payload.pop("name", None)
    payload.pop("origin", None)
    return payload


def _stable_unit_interval(seed: str, iteration: int) -> float:
    digest = hashlib.sha256(f"{seed}:{iteration}".encode("utf-8")).hexdigest()
    # Use the first 8 hex chars as a stable pseudo-random value in [0, 1).
    return int(digest[:8], 16) / 0xFFFFFFFF
