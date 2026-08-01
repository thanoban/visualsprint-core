"""Regex-based entity extraction from OCR/caption text — ticket IDs, URLs,
stack-trace-looking lines. Deliberately simple: this feeds lexical grounding
(app.screen.grounding) and knowledge extraction, not a general NER system.
"""

from __future__ import annotations

import enum
import re

from pydantic import BaseModel

DEFAULT_TICKET_PREFIXES = ("PAY", "JIRA", "ENG", "OPS", "SUP")

_URL_PATTERN = re.compile(r"\bhttps?://[^\s<>\"'\)]+", re.IGNORECASE)

_STACK_TRACE_LINE_PATTERNS = (
    re.compile(r"Traceback \(most recent call last\)"),
    re.compile(r"^\s*File \"[^\"]+\", line \d+", re.MULTILINE),
    re.compile(r"^\s*at [\w.$]+\([\w.<>$]*(?::\d+)?\)", re.MULTILINE),  # java-style `at a.b.C(D.java:10)`
    re.compile(r"\b\w*(?:Exception|Error)\b:", re.IGNORECASE),
)


class EntityType(enum.StrEnum):
    TICKET_ID = "ticket_id"
    URL = "url"
    STACK_TRACE = "stack_trace"


class DetectedEntity(BaseModel):
    entity_type: EntityType
    text: str
    start: int
    end: int


def _ticket_id_pattern(ticket_prefixes: tuple[str, ...]) -> re.Pattern[str]:
    prefix_group = "|".join(re.escape(p) for p in ticket_prefixes)
    return re.compile(rf"\b(?:{prefix_group})-\d+\b")


def extract_entities(
    text: str, ticket_prefixes: tuple[str, ...] = DEFAULT_TICKET_PREFIXES
) -> list[DetectedEntity]:
    entities: list[DetectedEntity] = []

    ticket_pattern = _ticket_id_pattern(ticket_prefixes)
    for match in ticket_pattern.finditer(text):
        entities.append(
            DetectedEntity(entity_type=EntityType.TICKET_ID, text=match.group(0), start=match.start(), end=match.end())
        )

    for match in _URL_PATTERN.finditer(text):
        entities.append(
            DetectedEntity(entity_type=EntityType.URL, text=match.group(0), start=match.start(), end=match.end())
        )

    for pattern in _STACK_TRACE_LINE_PATTERNS:
        for match in pattern.finditer(text):
            line_start, line_end = _line_span(text, match.start())
            entities.append(
                DetectedEntity(
                    entity_type=EntityType.STACK_TRACE, text=text[line_start:line_end], start=line_start, end=line_end
                )
            )

    return _dedupe(entities)


def _line_span(text: str, offset: int) -> tuple[int, int]:
    line_start = text.rfind("\n", 0, offset) + 1
    line_end = text.find("\n", offset)
    if line_end == -1:
        line_end = len(text)
    return line_start, line_end


def _dedupe(entities: list[DetectedEntity]) -> list[DetectedEntity]:
    seen: set[tuple[EntityType, int, int]] = set()
    deduped: list[DetectedEntity] = []
    for entity in entities:
        key = (entity.entity_type, entity.start, entity.end)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entity)
    return sorted(deduped, key=lambda e: e.start)
