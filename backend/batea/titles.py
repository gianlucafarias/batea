"""Etiquetas automáticas a partir del título (versión, acapella, tool...)."""
from __future__ import annotations

import re

_RULES: list[tuple[str, str]] = [
    (r"\ba\s?cap+el+a\b|\bacapela\b", "Acapella"),
    (r"\binstrumental\b", "Instrumental"),
    (r"\bmash\s?-?up\b", "Mashup"),
    (r"\bbootleg\b|\bflip\b", "Bootleg"),
    (r"\bdub\b", "Dub"),
    (r"\b(tool|loop|dj tool|drum tool|beat tool)s?\b", "Tool / Loop"),
    (r"\bextended\b", "Extended"),
    (r"\boriginal mix\b|\boriginal\b", "Original"),
    (r"\bremix\b|\brmx\b|\brework\b", "Remix"),
    (r"\bedit\b|\bre-?edit\b", "Edit"),
    (r"\bvocal mix\b|\bvox\b|\bvocal\b", "Vocal"),
]


def auto_version_tags(title: str | None) -> list[str]:
    if not title:
        return []
    t = title.lower()
    found: list[str] = []
    for pattern, tag in _RULES:
        if re.search(pattern, t) and tag not in found:
            found.append(tag)
    # "Remix" y "Original" no conviven: si dice remix, gana remix
    if "Remix" in found and "Original" in found:
        found.remove("Original")
    if "Acapella" in found and "Vocal" in found:
        found.remove("Vocal")
    return found
