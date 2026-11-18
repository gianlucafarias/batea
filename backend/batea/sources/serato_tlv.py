"""Primitivas de lectura de los archivos binarios de Serato 3.x."""
from __future__ import annotations

import struct
from collections.abc import Iterator


def _records(data: bytes, header: str) -> Iterator[tuple[bytes | int, bytes]]:
    offset = 0
    while offset + 8 <= len(data):
        tag, length = struct.unpack_from(header, data, offset)
        offset += 8
        end = offset + length
        if end > len(data):
            break  # Serato puede dejar el último registro a medio escribir.
        yield tag, data[offset:end]
        offset = end


def records(data: bytes) -> Iterator[tuple[str, bytes]]:
    for tag, payload in _records(data, ">4sI"):
        if tag.isascii():
            yield tag.decode("ascii"), payload


def string(data: bytes) -> str | None:
    try:
        return data.decode("utf-16-be").removeprefix("\ufeff").rstrip("\0")
    except UnicodeDecodeError:
        return None


def value(tag: str, data: bytes):
    prefix = tag[0]
    if prefix in "tpv":
        return string(data)
    if (prefix, len(data)) in {("u", 4), ("s", 2)}:
        return int.from_bytes(data, "big")
    if prefix == "b" and len(data) == 1:
        return data[0] != 0
    if prefix == "o":
        return list(records(data))
    return None


def fields(data: bytes, *tags: str) -> dict:
    wanted = set(tags)
    return {tag: value(tag, payload) for tag, payload in records(data) if tag in wanted}


def adat_records(data: bytes, tag: str, *, strings: set[int], numbers: set[int]) -> Iterator[dict]:
    for record_tag, record in records(data):
        if record_tag != tag:
            continue
        for field_tag, payload in records(record):
            if field_tag != "adat":
                continue
            fields = {}
            for field_id, field in _records(payload, ">II"):
                if field_id in strings:
                    fields[field_id] = string(field)
                elif field_id in numbers and len(field) == 4:
                    fields[field_id] = int.from_bytes(field, "big")
            yield fields
