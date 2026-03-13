autowatch = 1;
inlets = 1;
outlets = 1;

var RATIO_LABELS = [
    "1/8", "1/6", "1/4", "1/3", "1/2", "2/3", "3/4", "1",
    "4/3", "3/2", "2", "9/4", "7/3", "5/2", "8/3", "11/4",
    "3", "13/4", "10/3", "7/2", "11/3", "15/4", "4", "6", "8"
];

var RATIOS = [
    0.125,
    1.0 / 6.0,
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    0.75,
    1.0,
    4.0 / 3.0,
    1.5,
    2.0,
    9.0 / 4.0,
    7.0 / 3.0,
    2.5,
    8.0 / 3.0,
    11.0 / 4.0,
    3.0,
    13.0 / 4.0,
    10.0 / 3.0,
    3.5,
    11.0 / 3.0,
    15.0 / 4.0,
    4.0,
    6.0,
    8.0
];

var DEFAULT_INTERVAL_MS = 125.0;
var MAX_INTERVAL_MS = 10000.0;
var EPS = 1.0e-9;
var UNITY_EPS = 1.0e-6;
var INTERVAL_EMA_ALPHA = 0.22;
var INTERVAL_OUTLIER_RATIO = 0.35;
var INTERVAL_SLEW_RATIO = 0.10;
var PARAM_SMOOTH_ALPHA = 0.22;
var MAX_TRANSITION_TICKS = 32;

var state = {
    ratioIndex: 7,
    transitionLength: 0.0,
    ratioCurrent: 1.0,
    transitionActive: 0,
    transitionFrom: 1.0,
    transitionTo: 1.0,
    transitionSteps: 0,
    transitionStep: 0,
    velocityShape: 0.5,
    velocityDepth: 0.35,
    velocityInvert: 0,
    velocityShapeSmoothed: 0.5,
    velocityDepthSmoothed: 0.35,
    velocityInvertSmoothed: 0.0,
    lastEventTimeMs: -1,
    intervalMs: DEFAULT_INTERVAL_MS,
    phase: 0.0,
    resyncPending: 0,
    resyncForceFirst: 0
};

var pendingTasks = [];
var activeNotes = [];
var activeVelocities = [];

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function smoothInterval(measuredMs) {
    var prev = state.intervalMs;
    var m = Number(measuredMs);
    if (!isFinite(m) || m <= 0) {
        return prev;
    }
    if (!isFinite(prev) || prev <= 0) {
        return clamp(m, 1.0, MAX_INTERVAL_MS);
    }

    // Reject single-tick spikes by limiting instantaneous deviation.
    var mMin = prev * (1.0 - INTERVAL_OUTLIER_RATIO);
    var mMax = prev * (1.0 + INTERVAL_OUTLIER_RATIO);
    var clipped = clamp(m, mMin, mMax);

    // Exponential smoothing to absorb timer jitter.
    var target = prev + (clipped - prev) * INTERVAL_EMA_ALPHA;

    // Additional slew limiting for phase stability.
    var maxStep = Math.max(0.25, prev * INTERVAL_SLEW_RATIO);
    var delta = clamp(target - prev, -maxStep, maxStep);
    return clamp(prev + delta, 1.0, MAX_INTERVAL_MS);
}

function smoothVelocityParams() {
    var a = PARAM_SMOOTH_ALPHA;
    state.velocityShapeSmoothed += (state.velocityShape - state.velocityShapeSmoothed) * a;
    state.velocityDepthSmoothed += (state.velocityDepth - state.velocityDepthSmoothed) * a;
    state.velocityInvertSmoothed += (state.velocityInvert - state.velocityInvertSmoothed) * a;
}

function tanhSafe(x) {
    if (Math.tanh) {
        return Math.tanh(x);
    }
    if (x > 20) {
        return 1;
    }
    if (x < -20) {
        return -1;
    }
    var e2x = Math.exp(2 * x);
    return (e2x - 1) / (e2x + 1);
}

function decodeIndex(v, count, fallback) {
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

function transitionTickCount() {
    var amt = clamp(state.transitionLength, 0, 1);
    return Math.round(amt * MAX_TRANSITION_TICKS);
}

function beginRatioTransition(targetRatio) {
    var target = Number(targetRatio);
    var from;
    var steps;

    if (!isFinite(target) || target <= EPS) {
        return;
    }

    from = Number(state.ratioCurrent);
    if (!isFinite(from) || from <= EPS) {
        from = RATIOS[state.ratioIndex];
    }

    steps = transitionTickCount();
    state.transitionFrom = from;
    state.transitionTo = target;

    if (steps <= 0 || Math.abs(target - from) <= EPS) {
        state.transitionActive = 0;
        state.transitionSteps = 0;
        state.transitionStep = 0;
        state.ratioCurrent = target;
        return;
    }

    state.transitionActive = 1;
    state.transitionSteps = steps;
    state.transitionStep = 0;
    state.ratioCurrent = from;
}

function ratioForThisTick() {
    if (!state.transitionActive || state.transitionSteps <= 0) {
        return state.ratioCurrent;
    }
    var t = clamp((state.transitionStep + 1) / state.transitionSteps, 0, 1);
    return state.transitionFrom + (state.transitionTo - state.transitionFrom) * t;
}

function advanceRatioTransition() {
    var t;

    if (!state.transitionActive || state.transitionSteps <= 0) {
        return;
    }

    state.transitionStep += 1;
    if (state.transitionStep >= state.transitionSteps) {
        state.transitionActive = 0;
        state.transitionSteps = 0;
        state.transitionStep = 0;
        state.ratioCurrent = state.transitionTo;
        return;
    }

    t = state.transitionStep / state.transitionSteps;
    state.ratioCurrent = state.transitionFrom + (state.transitionTo - state.transitionFrom) * t;
}

function isTriggerEvent(velocity) {
    return Number(velocity) !== 0;
}

function isNoteOn(velocity) {
    return Number(velocity) > 0;
}

function normalizeNote(note) {
    return clamp(Math.floor(Number(note) || 0), 0, 127);
}

function outputRawEvent(note, velocity) {
    outlet(0, 0, note, velocity);
}

function forceNoteOff(note) {
    var n = normalizeNote(note);
    if (!activeNotes[n]) {
        return;
    }
    // Use velocity 0 for note-off so downstream trigger chains
    // don't accidentally treat offs as extra triggers.
    outputRawEvent(n, 0);
    activeNotes[n] = 0;
    activeVelocities[n] = 0;
}

function flushAllNotes() {
    var i;
    for (i = 0; i < 128; i++) {
        forceNoteOff(i);
    }
}

function outputManagedEvent(note, velocity) {
    var n = normalizeNote(note);
    var v = Number(velocity);
    var on = isNoteOn(v);

    if (on) {
        var onVel = Math.round(v);
        if (!isFinite(onVel) || onVel < 1) {
            onVel = 100;
        }
        onVel = clamp(onVel, 1, 127);

        // Never allow overlapping note-ons on the same note.
        if (activeNotes[n]) {
            forceNoteOff(n);
        }

        outputRawEvent(n, onVel);
        activeNotes[n] = 1;
        activeVelocities[n] = onVel;
        return;
    }

    // Ignore orphan offs; they cause extra chatter without musical value.
    if (!activeNotes[n]) {
        return;
    }

    outputRawEvent(n, 0);
    activeNotes[n] = 0;
    activeVelocities[n] = 0;
}

function clearPending() {
    var i;
    for (i = 0; i < pendingTasks.length; i++) {
        try {
            pendingTasks[i].cancel();
        } catch (e) {
            // Ignore already-finished tasks.
        }
    }
    pendingTasks = [];
}

function resetClock(preserveInterval) {
    var ratio = RATIOS[state.ratioIndex];

    clearPending();
    flushAllNotes();
    state.lastEventTimeMs = -1;
    state.phase = 0.0;
    state.resyncPending = 0;
    state.resyncForceFirst = 0;
    state.transitionActive = 0;
    state.transitionFrom = ratio;
    state.transitionTo = ratio;
    state.transitionSteps = 0;
    state.transitionStep = 0;
    state.ratioCurrent = ratio;
    state.velocityShapeSmoothed = state.velocityShape;
    state.velocityDepthSmoothed = state.velocityDepth;
    state.velocityInvertSmoothed = state.velocityInvert;
    if (!preserveInterval) {
        state.intervalMs = DEFAULT_INTERVAL_MS;
    }
}

function applyPendingResync() {
    if (!state.resyncPending) {
        return;
    }

    state.phase = 0.0;
    state.resyncForceFirst = 1;
    state.resyncPending = 0;
}

function resyncPhase() {
    // Queue resync and apply it on a clock edge so lane order
    // (clock vs resync in the same scheduler slice) cannot glitch timing.
    state.resyncPending = 1;
}

function velocityCurve(frac, shape, depth, invert) {
    var f = clamp(frac, 0, 1);
    var s = clamp(shape, 0, 1);
    var d = clamp(depth, 0, 1);
    var inv = clamp(invert, 0, 1);

    // Smooth basis curves (no hard corners).
    var early = 0.5 + 0.5 * Math.cos(Math.PI * f); // high -> low
    var late = 1.0 - early; // low -> high
    var bell = Math.sin(Math.PI * f); // center peak

    // Shape crossfades continuously between early/bell/late.
    var shapePos = 2.0 * s - 1.0; // -1..1
    var sideMix = 0.5 * (shapePos + 1.0); // 0=early, 1=late
    var side = early * (1.0 - sideMix) + late * sideMix;
    var amount = Math.abs(shapePos);
    var core = bell * (1.0 - amount) + side * amount; // 0..1

    // Smooth depth response centered around 1x.
    var bipolar = 2.0 * core - 1.0; // -1..1
    var drive = 1.0 + 4.0 * d;
    var norm = tanhSafe(drive);
    var curved = (norm > EPS) ? (tanhSafe(drive * bipolar) / norm) : bipolar;
    var motion = curved * d;
    var normalMul = clamp(1.0 + 1.15 * motion, 0.2, 2.5);

    // Inversion is reciprocal dynamics, not phase mirroring.
    var invertedMul = clamp(1.0 / normalMul, 0.2, 2.5);
    return normalMul + (invertedMul - normalMul) * inv;
}

function shapeVelocity(inVelocity, frac) {
    smoothVelocityParams();

    var raw = Number(inVelocity);
    var mag = Math.abs(Math.round(raw));

    if (!isFinite(mag) || mag < 1) {
        mag = 100;
    }

    mag = clamp(mag, 1, 127);
    mag = Math.round(
        mag * velocityCurve(
            frac,
            state.velocityShapeSmoothed,
            state.velocityDepthSmoothed,
            state.velocityInvertSmoothed
        )
    );
    mag = clamp(mag, 1, 127);

    // Derived pulses are emitted as note-ons; offs are handled separately.
    return mag;
}

function emitClock(delayMs, note, baseVelocity, frac) {
    var delay = Math.max(0, Number(delayMs) || 0);

    if (delay <= 0) {
        outputManagedEvent(note, shapeVelocity(baseVelocity, frac));
        return;
    }

    var t = new Task(function (n, v, ph) {
        outputManagedEvent(n, shapeVelocity(v, ph));
    }, this, note, baseVelocity, frac);

    t.schedule(delay);
    pendingTasks.push(t);

    if (pendingTasks.length > 256) {
        pendingTasks.splice(0, pendingTasks.length - 256);
    }
}

function scheduleDerivedEvents(intervalMs, note, velocity, ratio) {
    var ratioVal = Number(ratio);
    var forceFirst = state.resyncForceFirst;

    if (!isFinite(ratioVal) || ratioVal <= EPS) {
        ratioVal = RATIOS[state.ratioIndex];
    }

    if (forceFirst) {
        emitClock(0, note, velocity, 0.0);
        state.resyncForceFirst = 0;
    }

    // At 1x users expect exact pass-through timing.
    // Snap to trigger-time instead of waiting for the next phase boundary.
    if (Math.abs(ratioVal - 1.0) < UNITY_EPS) {
        if (!forceFirst) {
            emitClock(0, note, velocity, 0.0);
        }
        state.phase += 1.0;
        state.phase -= Math.floor(state.phase);
        return;
    }

    var phaseStart = state.phase;
    var phaseEnd = phaseStart + ratioVal;

    var kStart = Math.ceil(phaseStart - EPS);
    var kEnd = Math.floor(phaseEnd - EPS);

    var k;
    for (k = kStart; k <= kEnd; k++) {
        var frac = (k - phaseStart) / ratioVal;

        if (frac < -EPS || frac >= (1.0 - EPS)) {
            continue;
        }

        if (forceFirst && Math.abs(frac) <= 1.0e-6) {
            continue;
        }

        var delay = Math.max(0, frac * intervalMs);
        emitClock(delay, note, velocity, frac);
    }

    state.phase = phaseEnd - Math.floor(phaseEnd);
    if (state.phase < 0) {
        state.phase += 1.0;
    }
}

function handleClockEvent(note, velocity) {
    var ratio;
    var now = new Date().getTime();

    if (state.lastEventTimeMs >= 0) {
        var measured = now - state.lastEventTimeMs;
        if (isFinite(measured) && measured > 0 && measured <= MAX_INTERVAL_MS) {
            state.intervalMs = smoothInterval(measured);
        }
    }

    state.lastEventTimeMs = now;

    applyPendingResync();

    // Hard re-anchor to every incoming edge: any not-yet-fired events from
    // the previous prediction are stale once a new source tick arrives.
    clearPending();

    ratio = ratioForThisTick();
    scheduleDerivedEvents(state.intervalMs, note, velocity, ratio);
    advanceRatioTransition();
}

function handleParam(index, value) {
    var idx = Math.floor(Number(index));
    if (!isFinite(idx)) {
        return;
    }

    if (idx === 0) {
        var nextRatioIndex = decodeIndex(value, RATIOS.length, state.ratioIndex);
        if (nextRatioIndex !== state.ratioIndex) {
            state.ratioIndex = nextRatioIndex;
            beginRatioTransition(RATIOS[state.ratioIndex]);
        }
        return;
    }

    if (idx === 1) {
        state.velocityShape = decodeFloat(value, 0, 1, state.velocityShape);
        return;
    }

    if (idx === 2) {
        state.velocityDepth = decodeFloat(value, 0, 1, state.velocityDepth);
        return;
    }

    if (idx === 3) {
        state.velocityInvert = decodeIndex(value, 2, state.velocityInvert);
        return;
    }

    if (idx === 4) {
        state.transitionLength = decodeFloat(value, 0, 1, state.transitionLength);
        if (state.transitionActive) {
            beginRatioTransition(state.transitionTo);
        }
    }
}

function handleMidiLane(lane, note, velocity) {
    var l = Math.floor(Number(lane));
    var n = Math.floor(Number(note));
    var v = Number(velocity);

    if (!isFinite(l) || !isFinite(n) || !isFinite(v)) {
        return;
    }

    if (l === 0) {
        // Clock input: any non-zero velocity is a trigger, 0 is off.
        // This keeps compatibility with sources that emit signed pulses.
        if (Math.abs(v) > EPS) {
            handleClockEvent(n, Math.abs(v));
            return;
        }

        // Zero velocity is off.
        outputManagedEvent(n, 0);
        return;
    }

    if (l === 1 && isTriggerEvent(v)) {
        resyncPhase();
    }
}

function list() {
    var args = arrayfromargs(arguments);
    if (args.length >= 2) {
        handleParam(args[0], args[1]);
    }
}

function anything() {
    var name = messagename;

    // Some host-side metadata paths can emit "dictionary null" during load.
    // Ignore dictionary traffic entirely in this mapper.
    if (name === "dictionary") {
        return;
    }

    var args = arrayfromargs(arguments);

    if (name === "param") {
        if (args.length >= 2) {
            handleParam(args[0], args[1]);
        }
        return;
    }

    if (name === "midi_lane") {
        if (args.length >= 3) {
            handleMidiLane(args[0], args[1], args[2]);
        }
        return;
    }

    if (name === "resync") {
        resyncPhase();
        return;
    }

    if (name === "reset") {
        resetClock(true);
        return;
    }

    if (name === "ratio") {
        if (args.length >= 1) {
            var nextIndex = decodeIndex(args[0], RATIOS.length, state.ratioIndex);
            if (nextIndex !== state.ratioIndex) {
                state.ratioIndex = nextIndex;
                beginRatioTransition(RATIOS[state.ratioIndex]);
            }
        }
        return;
    }

    if (name === "transition_length") {
        if (args.length >= 1) {
            state.transitionLength = decodeFloat(args[0], 0, 1, state.transitionLength);
            if (state.transitionActive) {
                beginRatioTransition(state.transitionTo);
            }
        }
        return;
    }

    if (name === "velocity_shape") {
        if (args.length >= 1) {
            state.velocityShape = decodeFloat(args[0], 0, 1, state.velocityShape);
        }
        return;
    }

    if (name === "velocity_depth") {
        if (args.length >= 1) {
            state.velocityDepth = decodeFloat(args[0], 0, 1, state.velocityDepth);
        }
        return;
    }

    if (name === "velocity_invert") {
        if (args.length >= 1) {
            state.velocityInvert = decodeIndex(args[0], 2, state.velocityInvert);
        }
        return;
    }

    if (name === "init") {
        resetClock(false);
        return;
    }

    if (name === "bang") {
        resetClock(true);
        return;
    }

    if (name === "info") {
        return;
    }
}

function dictionary() {
    // Explicitly swallow dictionary messages (including dictionary null).
}
