#!/usr/bin/env python3
"""
Build seq.piano.roll blocks from a MIDI file and write them into a RTMOG JSON file.

Each MIDI track (except the first tempo/meta track) is converted into a dedicated
piano roll block. The notes are sliced into 16 step chunks (2 bars assuming 4/4)
so every pattern in the block represents two bars of material.
"""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from copy import deepcopy
from pathlib import Path
from typing import Dict, List, Tuple

import mido

UNITS_PER_BEAT = 1.0  # halve the unit scale so playback is twice as fast
PATTERN_LENGTH_STEPS = 16  # steps per pattern (2 bars)
MIN_DURATION_UNITS = 1.0 / 96.0  # guard against zero-length notes
SEQL_RESOLUTION = 256  # sequencer internal resolution used by stored data

DEFAULT_SEQ_TEMPLATE: Dict = {
    "patcher": "seq.piano.roll",
    "name": "seq.piano.roll",
    "label": "seq.piano.roll",
    "type": "note",
    "poly": {
        "stack_mode": "unison all",
        "choose_mode": "blind cycle",
        "steal_mode": "cyclic",
        "return_mode": 1,
        "voices": 1,
    },
    "panel": {"parameters": [0], "enable": 1},
    "patterns": {
        "parameter": 0,
        "pattern_storage": "dict",
        "playhead_offset": 1,
        "names": ["1"] + [""] * 15,
    },
    "error": {"spread": 0, "drift": 0, "lockup": 0},
    "flock": {
        "weight": 0.2,
        "tension": 0.2,
        "friction": 0.4,
        "bounce": 0.7,
        "attrep": 0.5,
        "align": 0.5,
        "twist": 0.5,
        "brownian": 0,
    },
    "space": {"x": -5, "y": -1, "colour": [172, 80, 30]},
    "automap_to": 0,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert MIDI tracks to seq.piano.roll blocks."
    )
    parser.add_argument(
        "--midi",
        required=True,
        help="Path to the MIDI file to import.",
    )
    parser.add_argument(
        "--output",
        help="Output JSON path (default: <midi_stem>.json next to the MIDI file).",
    )
    parser.add_argument(
        "--template",
        help=(
            "Base RTMOG JSON file to clone (default: templates/autoload.json).",
        ),
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Keep existing seq.piano.roll blocks instead of replacing them.",
    )
    return parser.parse_args()


def get_seq_template(blocks: List[Dict]) -> Dict:
    for block in blocks:
        if isinstance(block, dict) and block.get("patcher") == "seq.piano.roll":
            template = deepcopy(block)
            template.pop("stored_piano_roll", None)
            return template
    return deepcopy(DEFAULT_SEQ_TEMPLATE)


def build_minimal_template() -> Dict:
    return {
        "MAX_WAVES": 256,
        "version": 0.555,
        "notepools": {"shape": {}, "notes": {}},
        "waves": [{} for _ in range(256)],
        "blocks": [],
    }


def extract_notes(track: mido.midifiles.tracks.MidiTrack) -> List[Tuple[int, int, int, int]]:
    """Return a list of (start_tick, end_tick, pitch, velocity) tuples for a track."""
    notes: List[Tuple[int, int, int, int]] = []
    active: Dict[Tuple[int, int], List[Tuple[int, int]]] = defaultdict(list)
    absolute_tick = 0

    for message in track:
        absolute_tick += message.time
        if message.is_meta:
            continue
        if message.type == "note_on" and message.velocity > 0:
            key = (message.channel, message.note)
            active[key].append((absolute_tick, message.velocity))
        elif message.type in ("note_off", "note_on"):
            if message.type == "note_on" and message.velocity > 0:
                continue
            key = (message.channel, message.note)
            if active[key]:
                start_tick, velocity = active[key].pop()
                if absolute_tick > start_tick:
                    notes.append((start_tick, absolute_tick, message.note, velocity))
    return notes


def build_patterns(
    notes: List[Tuple[int, int, int, int]], ticks_per_beat: int
) -> Tuple[Dict[str, Dict[str, List[float]]], int]:
    if not notes:
        return {}, 0

    units_per_tick = UNITS_PER_BEAT / float(ticks_per_beat)
    patterns: Dict[str, Dict[str, List[float]]] = {}
    event_counts = defaultdict(int)
    max_pattern_idx = 0

    def ensure_pattern(idx: int) -> None:
        if str(idx) not in patterns:
            patterns[str(idx)] = {
                "looppoints": [SEQL_RESOLUTION, 0, 0, PATTERN_LENGTH_STEPS]
            }

    for start_tick, end_tick, pitch, velocity in notes:
        start_unit = start_tick * units_per_tick
        duration_unit = max((end_tick - start_tick) * units_per_tick, MIN_DURATION_UNITS)
        remaining = duration_unit
        current_start = start_unit
        while remaining > 0:
            pattern_idx = int(current_start // PATTERN_LENGTH_STEPS)
            ensure_pattern(pattern_idx)
            pattern_start_unit = pattern_idx * PATTERN_LENGTH_STEPS
            position_in_pattern = current_start - pattern_start_unit
            available = PATTERN_LENGTH_STEPS - position_in_pattern
            chunk = min(remaining, available)
            if chunk <= 0:
                break
            event_counts[pattern_idx] += 1
            event_key = str(event_counts[pattern_idx])
            start_norm = position_in_pattern / SEQL_RESOLUTION
            length_norm = max(chunk / SEQL_RESOLUTION, MIN_DURATION_UNITS / SEQL_RESOLUTION)
            patterns[str(pattern_idx)][event_key] = [
                start_norm,
                0,
                pitch,
                velocity,
                length_norm,
            ]
            remaining -= chunk
            current_start += chunk
            max_pattern_idx = max(max_pattern_idx, pattern_idx)

    # Ensure every pattern up to the last used index exists, even if empty.
    for idx in range(max_pattern_idx + 1):
        ensure_pattern(idx)

    return patterns, max_pattern_idx + 1


def make_block(
    template: Dict,
    label: str,
    stored_roll: Dict[str, Dict[str, List[float]]],
    pattern_count: int,
    block_index: int,
) -> Dict:
    block = deepcopy(template)
    block["label"] = label

    name_length = max(pattern_count, 16)
    pattern_names = [f"{label} {i + 1}" for i in range(pattern_count)]
    if len(pattern_names) < name_length:
        pattern_names.extend([""] * (name_length - len(pattern_names)))
    block["patterns"]["names"] = pattern_names

    space = block.get("space", {}).copy()
    base_x = template.get("space", {}).get("x", 0)
    base_y = template.get("space", {}).get("y", 0)
    space["x"] = base_x + block_index * 1.5
    space["y"] = base_y - block_index * 1.0
    block["space"] = space

    block["stored_piano_roll"] = stored_roll
    return block


def main() -> None:
    args = parse_args()
    midi_path = Path(args.midi)
    output_path = Path(args.output) if args.output else midi_path.with_suffix(".json")
    template_path = Path(args.template) if args.template else Path("templates/autoload.json")

    if not midi_path.exists():
        raise FileNotFoundError(f"MIDI file not found: {midi_path}")
    if not template_path.exists():
        raise FileNotFoundError(f"Template file not found: {template_path}")

    data = json.loads(template_path.read_text())

    blocks = data.get("blocks")
    if not isinstance(blocks, list):
        blocks = []
        data["blocks"] = blocks
    template = get_seq_template(blocks)

    empty_slots: List[int] = [
        idx for idx, block in enumerate(blocks) if not block or not isinstance(block, dict)
    ]

    if not args.keep_existing:
        for idx, block in enumerate(blocks):
            if isinstance(block, dict) and block.get("patcher") == "seq.piano.roll":
                blocks[idx] = {}
                empty_slots.append(idx)
        empty_slots.sort()

    midi_file = mido.MidiFile(midi_path)
    empty_slots.sort()

    def place_block(block: Dict) -> None:
        if empty_slots:
            idx = empty_slots.pop(0)
            blocks[idx] = block
        else:
            blocks.append(block)

    block_offset = 0
    created_blocks = 0

    for idx, track in enumerate(midi_file.tracks):
        if idx == 0:
            continue  # skip meta/tempo track
        track_name = track.name.strip() or f"track_{idx}"
        notes = extract_notes(track)
        if not notes:
            continue
        stored_roll, pattern_count = build_patterns(notes, midi_file.ticks_per_beat)
        if not stored_roll:
            continue
        block = make_block(
            template,
            label=track_name,
            stored_roll=stored_roll,
            pattern_count=pattern_count,
            block_index=block_offset,
        )
        place_block(block)
        block_offset += 1
        created_blocks += 1

    output_path.write_text(json.dumps(data, indent=4))
    print(f"Wrote {created_blocks} seq.piano.roll blocks to {output_path}")


if __name__ == "__main__":
    main()
