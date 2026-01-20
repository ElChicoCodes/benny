# Implementation Plan: `fx.roar` Audio Block

This document outlines the analysis of the "benny" project's architecture and the detailed plan for implementing a new `fx.roar` audio block by wrapping the existing `abl.device.roar~` Max external.

## 1. Analysis of the 'benny' Block Architecture

The "benny" project uses a modular, convention-based architecture for defining audio and note processing units. The system is designed to dynamically discover and load "blocks" by looking for specific file combinations in the `audio_blocks/` and `note_blocks/` directories.

An audio block is a collection of files that work together:

*   **The `.json` File (e.g., `fx.delay.tape.json`): The "Manifest"**
    *   **Purpose:** Defines the block's public interface, including all user-controllable parameters (name, type, range, default value, unit).
    *   **Function:** The main application reads this file to dynamically build the user interface, handle automation, and manage presets.

*   **The `.gendsp` or `.maxpat` File: The "Engine"**
    *   **Purpose:** Contains the core Digital Signal Processing (DSP) logic.
    *   **Technology:** This can be a `gen~` patch (`.gendsp`) for custom algorithms or a standard Max patch (`.maxpat`) that might host other objects.

*   **The Host `.maxpat` File: The "Shell"**
    *   **Purpose:** Encapsulates the engine and presents a standardized interface to the "benny" environment, handling audio routing and parameter mapping.

## 2. Revised Plan: Wrapping `abl.device.roar~`

The initial plan was to create a new `roar` effect from scratch. However, investigation revealed that a powerful and complex `abl.device.roar~` external object already exists within the Max `ableton-dsp` package.

The plan was therefore revised to **wrap** this existing object, which is a more robust and powerful approach.

## 3. Implementation Details

The implementation requires creating two files in the `/audio_blocks/` directory.

### 3.1. Parameter Manifest (`fx.roar.json`)

This file defines the parameters from the `abl.device.roar~` object that will be exposed to the benny UI. I have selected a primary subset of parameters for clarity and usability.

**File:** `/Users/jokubaspreiksa/Music/benny/audio_blocks/fx.roar.json`
**Content:**
```json
[
    {
        "longname": "input_gain",
        "shortname": "In Gain",
        "type": "float",
        "min": -24.0,
        "max": 24.0,
        "default": 0.0,
        "unit": "db",
        "meta": { "category": "Global" }
    },
    {
        "longname": "output_gain",
        "shortname": "Out Gain",
        "type": "float",
        "min": -48.0,
        "max": 12.0,
        "default": 0.0,
        "unit": "db",
        "meta": { "category": "Global" }
    },
    {
        "longname": "mix",
        "shortname": "Mix",
        "type": "float",
        "min": 0.0,
        "max": 100.0,
        "default": 100.0,
        "unit": "%",
        "meta": { "category": "Global" }
    },
    {
        "longname": "routing",
        "shortname": "Routing",
        "type": "enum",
        "enum": ["Single", "Serial", "Parallel", "Multiband", "Mid-Side", "Feedback", "Delay"],
        "default": 0,
        "meta": { "category": "Global" }
    },
    {
        "longname": "shaper_amount_1",
        "shortname": "Drive 1",
        "type": "float",
        "min": 0.0,
        "max": 100.0,
        "default": 50.0,
        "unit": "%",
        "meta": { "category": "Stage 1" }
    },
    {
        "longname": "shaper_level_1",
        "shortname": "Level 1",
        "type": "float",
        "min": -24.0,
        "max": 24.0,
        "default": 0.0,
        "unit": "db",
        "meta": { "category": "Stage 1" }
    },
    {
        "longname": "shaper_type_1",
        "shortname": "Type 1",
        "type": "enum",
        "enum": ["Soft sine", "Hard clip", "Bit crusher", "Diode clipper", "Tube preamp", "Half wave rectifier", "Full wave rectifier", "Polynomial", "Fractal", "Fold tri", "Noise inject", "Shards"],
        "default": 0,
        "meta": { "category": "Stage 1" }
    },
    {
        "longname": "shaper_amount_2",
        "shortname": "Drive 2",
        "type": "float",
        "min": 0.0,
        "max": 100.0,
        "default": 0.0,
        "unit": "%",
        "meta": { "category": "Stage 2" }
    },
    {
        "longname": "shaper_level_2",
        "shortname": "Level 2",
        "type": "float",
        "min": -24.0,
        "max": 24.0,
        "default": 0.0,
        "unit": "db",
        "meta": { "category": "Stage 2" }
    },
    {
        "longname": "shaper_type_2",
        "shortname": "Type 2",
        "type": "enum",
        "enum": ["Soft sine", "Hard clip", "Bit crusher", "Diode clipper", "Tube preamp", "Half wave rectifier", "Full wave rectifier", "Polynomial", "Fractal", "Fold tri", "Noise inject", "Shards"],
        "default": 0,
        "meta": { "category": "Stage 2" }
    },
    {
        "longname": "shaper_amount_3",
        "shortname": "Drive 3",
        "type": "float",
        "min": 0.0,
        "max": 100.0,
        "default": 0.0,
        "unit": "%",
        "meta": { "category": "Stage 3" }
    },
    {
        "longname": "shaper_level_3",
        "shortname": "Level 3",
        "type": "float",
        "min": -24.0,
        "max": 24.0,
        "default": 0.0,
        "unit": "db",
        "meta": { "category": "Stage 3" }
    },
    {
        "longname": "shaper_type_3",
        "shortname": "Type 3",
        "type": "enum",
        "enum": ["Soft sine", "Hard clip", "Bit crusher", "Diode clipper", "Tube preamp", "Half wave rectifier", "Full wave rectifier", "Polynomial", "Fractal", "Fold tri", "Noise inject", "Shards"],
        "default": 0,
        "meta": { "category": "Stage 3" }
    }
]
```

### 3.2. Host Patcher (`fx.roar.maxpat`)

This file hosts the `abl.device.roar~` object and connects it to the benny ecosystem. It should be created in the Max/MSP editor with the following structure.

**File:** `/Users/jokubaspreiksa/Music/benny/audio_blocks/fx.roar.maxpat`
**Conceptual Structure:**

*   **Main Object:** An `[abl.device.roar~]` object is the central component.
*   **Audio Routing:**
    *   Two `[inlet~]` objects for stereo audio input, connected to the `[abl.device.roar~]` object's audio inlets.
    *   Two `[outlet~]` objects for stereo audio output, connected to the `[abl.device.roar~]` object's audio outlets.
*   **UI and Parameter Handling:**
    *   A `[loadbang]` object triggers the process.
    *   A JavaScript object (e.g., `[js mix.channel.ui.js]`) is triggered by the loadbang.
    *   The script is passed the name of the manifest file: `fx.roar.json`.
    *   The script reads the JSON, dynamically generates the UI controls (knobs, menus), and maps them to the parameters of the `[abl.device.roar~]` object.
    *   A `[bpatcher]` object is used to display the generated UI.

## 4. Conclusion

Creating these two files will fully integrate the `abl.device.roar~` external as a native-behaving audio block within the "benny" project.
