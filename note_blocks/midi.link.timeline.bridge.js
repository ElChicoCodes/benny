autowatch = 1;
inlets = 1;
outlets = 1;

var TICK_STEP_LABELS = [
    "1/24",
    "1/16",
    "1/12",
    "1/8",
    "1/6",
    "1/4",
    "1/2",
    "1"
];

var TICK_STEPS = [
    1.0 / 24.0,
    1.0 / 16.0,
    1.0 / 12.0,
    1.0 / 8.0,
    1.0 / 6.0,
    0.25,
    0.5,
    1.0
];
var EPS = 1.0e-9;

var state = {
    tickSizeIndex: 5,
    tickModeForce: 1,
    sendEvery: 1,
    startBeat: 0.0,
    offsetMs: 0.0,
    tempoFollow: 0.2,
    tickCount: 0,
    currentBeat: 0.0,
    lastMappedMs: -1,
    intervalEmaMs: -1.0,
    tempoLastSent: -1.0,
    tempoResendEvery: 8,
    configSent: 0
};

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function decodeMenuIndex(v, count, fallback) {
    var f = Number(v);
    if (!isFinite(f)) {
        return fallback;
    }
    if (Math.abs(f - Math.round(f)) < 1.0e-6 && f >= 0 && f <= (count - 1)) {
        return Math.round(f);
    }
    if (f >= 0 && f <= 1) {
        return clamp(Math.round(f * (count - 1)), 0, count - 1);
    }
    return clamp(Math.round(f), 0, count - 1);
}

function decodeBool(v, fallback) {
    var f = Number(v);
    if (!isFinite(f)) {
        return fallback ? 1 : 0;
    }
    if (f === 0 || f === 1) {
        return f;
    }
    if (f >= 0 && f <= 1) {
        return f >= 0.5 ? 1 : 0;
    }
    return f !== 0 ? 1 : 0;
}

function decodeInt(v, lo, hi, fallback) {
    var f = Number(v);
    if (!isFinite(f)) {
        return fallback;
    }
    // Prefer explicit integer values first. This avoids ambiguity where
    // an intended value of 1 would otherwise be interpreted as normalized max.
    if (Math.abs(f - Math.round(f)) < 1.0e-6 && f >= lo && f <= hi) {
        return Math.round(f);
    }
    if (f >= 0 && f <= 1) {
        return clamp(Math.round(lo + (hi - lo) * f), lo, hi);
    }
    return clamp(Math.round(f), lo, hi);
}

function decodeFloat(v, lo, hi, fallback) {
    var f = Number(v);
    if (!isFinite(f)) {
        return fallback;
    }
    if (f >= 0 && f <= 1) {
        return lo + (hi - lo) * f;
    }
    return clamp(f, lo, hi);
}

function tickStep() {
    return TICK_STEPS[state.tickSizeIndex];
}

function sendBridgeConfig() {
    // Prevent the legacy global_transport Link objects from competing with abl.link.
    if (typeof messnamed === "function") {
        messnamed("link_enable", 0);
    }
    outlet(0, "enable", 1);
    outlet(0, "startstopsync", 1);
    outlet(0, "tickmode", state.tickModeForce);
    outlet(0, "tickstep", tickStep());
    outlet(0, "offset", state.offsetMs);
    state.configSent = 1;
}

function ensureBridgeConfig() {
    if (!state.configSent) {
        sendBridgeConfig();
    }
}

function resetTickCounter() {
    state.tickCount = 0;
    state.currentBeat = state.startBeat;
    state.lastMappedMs = -1;
    state.intervalEmaMs = -1.0;
    outlet(0, "tickreset", state.currentBeat);
}

function classifyLane(lane) {
    var l = Math.floor(Number(lane));
    if (!isFinite(l)) {
        return -1;
    }
    return l;
}

function init() {
    sendBridgeConfig();
    resetTickCounter();
}

function onTickTrigger() {
    ensureBridgeConfig();
    state.tickCount += 1;
    if ((state.tickCount % state.sendEvery) === 0) {
        var nowMs = new Date().getTime();
        if (state.lastMappedMs >= 0) {
            var dtMs = nowMs - state.lastMappedMs;
            if (isFinite(dtMs) && dtMs > 2 && dtMs < 5000) {
                if (state.intervalEmaMs < 0) {
                    state.intervalEmaMs = dtMs;
                } else {
                    state.intervalEmaMs += (dtMs - state.intervalEmaMs) * state.tempoFollow;
                }
                var beatDelta = tickStep() * state.sendEvery;
                var bpm = clamp((60000.0 * beatDelta) / state.intervalEmaMs, 20.0, 999.0);
                var periodicResend = ((state.tickCount % state.tempoResendEvery) === 0);
                if (state.tempoLastSent < 0 || Math.abs(bpm - state.tempoLastSent) >= 0.05 || periodicResend) {
                    // Send tempo first so peer slope and forced beat mapping agree.
                    outlet(0, "tempo", bpm);
                    state.tempoLastSent = bpm;
                }
            }
        }
        state.lastMappedMs = nowMs;

        if (state.tickModeForce) {
            outlet(0, "forcebeatnow", state.currentBeat);
        } else {
            outlet(0, "requestbeatnow", state.currentBeat);
        }
        outlet(0, "tick", state.currentBeat);
    }
    state.currentBeat += tickStep();
}

function onResetTrigger() {
    ensureBridgeConfig();
    resetTickCounter();
}

function handleParam(index, value) {
    var idx = Number(index);
    var val = Number(value);
    if (!isFinite(idx)) {
        return;
    }

    ensureBridgeConfig();

    if (idx === 0) {
        state.tickSizeIndex = decodeMenuIndex(val, TICK_STEPS.length, state.tickSizeIndex);
        outlet(0, "tickstep", tickStep());
        resetTickCounter();
        return;
    }

    if (idx === 1) {
        state.tickModeForce = decodeBool(val, state.tickModeForce);
        outlet(0, "tickmode", state.tickModeForce);
        return;
    }

    if (idx === 2) {
        state.sendEvery = decodeInt(val, 1, 24, state.sendEvery);
        state.lastMappedMs = -1;
        return;
    }

    if (idx === 3) {
        state.startBeat = decodeFloat(val, 0, 256, state.startBeat);
        resetTickCounter();
        return;
    }

    if (idx === 4) {
        state.offsetMs = decodeFloat(val, -200, 200, state.offsetMs);
        outlet(0, "offset", state.offsetMs);
        return;
    }

    if (idx === 5) {
        // 0 = very slow adaptation, 1 = immediate adaptation.
        state.tempoFollow = decodeFloat(val, 0, 1, state.tempoFollow);
    }
}

function handleMidiLane(lane, note, velocity) {
    var l = classifyLane(lane);
    var v = Number(velocity);
    if (!isFinite(l) || !isFinite(v) || Math.abs(v) <= EPS) {
        return;
    }

    // Tick stream: lane 0 trigger pulse (signed or positive-note style).
    // Do not constrain note value, because some sources encode step index in note.
    if (l === 0) {
        onTickTrigger();
        return;
    }

    // Optional reset stream: lane 1 trigger pulse.
    if (l === 1) {
        onResetTrigger();
    }
}

function anything() {
    var a = arrayfromargs(arguments);
    var m = messagename;

    if (m === "init") {
        init();
        return;
    }

    if (m === "param") {
        if (a.length >= 2) {
            handleParam(a[0], a[1]);
        }
        return;
    }

    if (m === "midi_lane") {
        if (a.length >= 3) {
            handleMidiLane(a[0], a[1], a[2]);
        }
    }
}

function loadbang() {
    init();
}

function param() {
    var a = arrayfromargs(arguments);
    if (a.length >= 2) {
        handleParam(a[0], a[1]);
    }
}

function midi_lane() {
    var a = arrayfromargs(arguments);
    if (a.length >= 3) {
        handleMidiLane(a[0], a[1], a[2]);
    }
}

function list() {
    var a = arrayfromargs(arguments);

    // Fallback for hosts that send raw triplets instead of selector messages.
    if (a.length >= 3) {
        handleMidiLane(a[0], a[1], a[2]);
        return;
    }

    if (a.length >= 2) {
        handleParam(a[0], a[1]);
    }
}
