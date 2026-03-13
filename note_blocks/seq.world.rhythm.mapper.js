autowatch = 1;
inlets = 1;
outlets = 2;

var ROLE_NAMES = ['timeline', 'foundation', 'groove', 'lead'];
var STYLE_NAMES = ['West African', 'Afro-Cuban', 'Brazilian', 'Balkan', 'Indian', 'Gamelan', 'Jazz', 'Electronic', 'Breakbeat', 'Techno'];
var ROLE_PARAM_BASE0 = 22;
var ROLE_PARAM_STRIDE = 8;
var NOTES_BASE = 54;
var activeTasks = [];

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function normalizeVelocity(v) {
    var f = Number(v);
    if (!isFinite(f)) {
        return 0;
    }
    if (f > 1.0) {
        f = f / 127.0;
    }
    return clamp(f, 0.0, 1.0);
}

function decodeIndex(v, count) {
    var f = Number(v);
    if (!isFinite(f)) {
        return 0;
    }
    if (Math.abs(f - Math.round(f)) < 1.0e-6 && f >= 0 && f <= count - 1) {
        return Math.round(f);
    }
    if (f >= 0 && f <= 1) {
        return clamp(Math.round(f * (count - 1)), 0, count - 1);
    }
    return clamp(Math.round(f), 0, count - 1);
}

function decodeInt(v, lo, hi) {
    var f = Number(v);
    if (!isFinite(f)) {
        return lo;
    }
    if (Math.abs(f - Math.round(f)) < 1.0e-6 && f >= lo && f <= hi) {
        return Math.round(f);
    }
    if (f >= 0 && f <= 1) {
        return clamp(Math.round(lo + f * (hi - lo)), lo, hi);
    }
    return clamp(Math.round(f), lo, hi);
}

function decodeFloat(v, lo, hi) {
    var f = Number(v);
    if (!isFinite(f)) {
        return lo;
    }
    if (lo === 0 && hi === 1) {
        return clamp(f, lo, hi);
    }
    if (f >= 0 && f <= 1) {
        return lo + (hi - lo) * f;
    }
    return clamp(f, lo, hi);
}

var state = {
    style: 0,
    bars: 1,
    seed: 1,
    fillBeats: 4,
    fillIntensity: 0.70,
    tapAmount: 0.0,
    tapGateMs: 80,
    velScale: 1.0,

    meterAmt: 0.0,
    meterIdx: 0,
    claveAmt: 0.0,
    claveIdx: 0,
    asymmAmt: 0.0,
    asymmIdxMenu: 0,
    euclidAmt: 0.0,
    restLayerAmt: 0.0,
    iramaAmt: 0.0,
    iramaLevel: 0,

    roles: [
        { length: 16, density: 0.55, variation: 0.25, rest: 0.10, fillProb: 0.15, fillIntensity: 0.70, callProb: 0.10, style: -1, articulation: 0.10 },
        { length: 16, density: 0.25, variation: 0.20, rest: 0.15, fillProb: 0.20, fillIntensity: 0.75, callProb: 0.10, style: -1, articulation: 0.10 },
        { length: 16, density: 0.50, variation: 0.35, rest: 0.10, fillProb: 0.30, fillIntensity: 0.80, callProb: 0.15, style: -1, articulation: 0.20 },
        { length: 16, density: 0.35, variation: 0.50, rest: 0.25, fillProb: 0.25, fillIntensity: 0.85, callProb: 0.25, style: -1, articulation: 0.30 },
    ],

    notes: [36, 38, 40, 42, 44, 46, 48, 50],

    buttons: {
        generate: 0,
        fillNow: 0,
        tap: 0,
        reset: 0,
    },
};

function roleFromAny(v) {
    if (typeof v === 'number') {
        var n = Math.floor(v);
        if (n >= 0 && n < 4) {
            return n;
        }
        return -1;
    }
    var s = String(v).toLowerCase();
    if (s === 'timeline' || s === 'tl') { return 0; }
    if (s === 'foundation' || s === 'fd') { return 1; }
    if (s === 'groove' || s === 'gr') { return 2; }
    if (s === 'lead' || s === 'ld') { return 3; }
    return -1;
}

function laneFor(role, voice) {
    var v = Math.floor(voice);
    if (role === 0) { return v <= 0 ? 0 : 1; }
    if (role === 1) { return v <= 0 ? 2 : 3; }
    if (role === 2) { return v <= 0 ? 4 : 5; }
    if (role === 3) { return v <= 0 ? 6 : 7; }
    return -1;
}

function emitMidi(lane, note, velocity, delayMs) {
    var d = Math.max(0, Number(delayMs) || 0);
    if (d <= 0) {
        outlet(1, lane, note, velocity);
        return;
    }

    var task = new Task(function (a, b, c) {
        outlet(1, a, b, c);
    }, this, lane, note, velocity);
    task.schedule(d);
    activeTasks.push(task);
    if (activeTasks.length > 4096) {
        activeTasks.splice(0, 2048);
    }
}

function emitTriggeredMidi(lane, note, onVelocity, offsetMs, gateMs) {
    var onDelay = Math.max(0, Number(offsetMs) || 0);
    // For trigger-style drum lanes we emit a single note-on pulse only.
    // This avoids downstream voices firing again on note-off.
    emitMidi(lane, note, onVelocity, onDelay);
}

function sendRole(role) {
    var r = state.roles[role];
    outlet(0, 'setrole', ROLE_NAMES[role], r.length, r.density, r.variation, r.rest, r.fillProb, r.fillIntensity, r.callProb, r.style, r.articulation);
}

function sendAllRoles() {
    var i;
    for (i = 0; i < 4; i++) {
        sendRole(i);
    }
}

function applyMeterLayer() {
    var enabled = state.meterAmt > 0.0001 ? 1 : 0;
    outlet(0, 'meterlayer', enabled, state.meterIdx, state.meterAmt);
}

function applyClaveLayer() {
    var enabled = state.claveAmt > 0.0001 ? 1 : 0;
    outlet(0, 'clavelayer', enabled, state.claveIdx, state.claveAmt);
}

function applyAsymmLayer() {
    var enabled = state.asymmAmt > 0.0001 ? 1 : 0;
    var groupingIndex = state.asymmIdxMenu <= 0 ? -1 : (state.asymmIdxMenu - 1);
    outlet(0, 'asymmlayer', enabled, groupingIndex, state.asymmAmt);
}

function applyEuclidLayer() {
    var enabled = state.euclidAmt > 0.0001 ? 1 : 0;
    outlet(0, 'euclidlayer', enabled, state.euclidAmt, 0, 0, 1);
}

function applyRestLayer() {
    var enabled = state.restLayerAmt > 0.0001 ? 1 : 0;
    outlet(0, 'restlayer', enabled, state.restLayerAmt);
}

function applyIramaLayer() {
    var enabled = state.iramaAmt > 0.0001 ? 1 : 0;
    outlet(0, 'iramalayer', enabled, state.iramaLevel, state.iramaAmt);
}

function applyAllLayers() {
    applyMeterLayer();
    applyClaveLayer();
    applyAsymmLayer();
    applyEuclidLayer();
    applyRestLayer();
    applyIramaLayer();
}

function triggerFillNow() {
    outlet(0, 'fillnow', state.fillBeats, state.fillIntensity);
}

function triggerTap(velocity) {
    var vel = normalizeVelocity(velocity);
    if (vel <= 0) {
        vel = 0.8;
    }
    outlet(0, 'tap', vel, state.tapGateMs, 0.0);
}

function triggerGenerate() {
    outlet(0, 'generate');
}

function triggerReset() {
    outlet(0, 'clockreset', 0);
}

function init() {
    outlet(0, 'seed', state.seed);
    outlet(0, 'bars', state.bars);
    outlet(0, 'style', state.style);
    outlet(0, 'tapamount', state.tapAmount);
    sendAllRoles();
    applyAllLayers();
    triggerGenerate();
}

function handleRoleParam(index, value) {
    var role = Math.floor((index - ROLE_PARAM_BASE0) / ROLE_PARAM_STRIDE);
    var offset = (index - ROLE_PARAM_BASE0) % ROLE_PARAM_STRIDE;

    if (role < 0 || role > 3) {
        return;
    }

    var r = state.roles[role];
    var needSetRole = false;

    switch (offset) {
        case 0:
            r.length = decodeInt(value, 1, 64);
            needSetRole = true;
            break;
        case 1:
            r.density = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 2:
            r.variation = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 3:
            r.rest = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 4:
            r.fillProb = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 5:
            r.fillIntensity = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 6:
            r.callProb = decodeFloat(value, 0, 1);
            needSetRole = true;
            break;
        case 7:
            r.articulation = decodeFloat(value, 0, 1);
            outlet(0, 'articulation', ROLE_NAMES[role], r.articulation);
            break;
    }

    if (needSetRole) {
        sendRole(role);
    }
}

function handleParam(index, value) {
    var idx = Math.floor(index);
    var v = Number(value);

    if (idx >= ROLE_PARAM_BASE0 && idx < ROLE_PARAM_BASE0 + (4 * ROLE_PARAM_STRIDE)) {
        handleRoleParam(idx, v);
        return;
    }

    if (idx >= NOTES_BASE && idx < NOTES_BASE + 8) {
        state.notes[idx - NOTES_BASE] = decodeInt(v, 0, 127);
        return;
    }

    switch (idx) {
        case 0:
            state.style = decodeIndex(v, STYLE_NAMES.length);
            outlet(0, 'style', state.style);
            break;
        case 1:
            state.bars = decodeInt(v, 1, 64);
            outlet(0, 'bars', state.bars);
            break;
        case 2:
            state.seed = decodeInt(v, 0, 999999);
            outlet(0, 'seed', state.seed);
            break;
        case 3: {
            var genNow = v > 0 ? 1 : 0;
            if (genNow && !state.buttons.generate) {
                triggerGenerate();
            }
            state.buttons.generate = genNow;
            break;
        }
        case 4:
            state.fillBeats = decodeInt(v, 1, 16);
            break;
        case 5:
            state.fillIntensity = decodeFloat(v, 0, 1);
            break;
        case 6: {
            var fillNow = v > 0 ? 1 : 0;
            if (fillNow && !state.buttons.fillNow) {
                triggerFillNow();
            }
            state.buttons.fillNow = fillNow;
            break;
        }
        case 7:
            state.tapAmount = decodeFloat(v, 0, 1);
            outlet(0, 'tapamount', state.tapAmount);
            break;
        case 8:
            state.tapGateMs = decodeInt(v, 10, 300);
            break;
        case 9: {
            var tapNow = v > 0 ? 1 : 0;
            if (tapNow && !state.buttons.tap) {
                triggerTap(100);
            }
            state.buttons.tap = tapNow;
            break;
        }
        case 10: {
            var resetNow = v > 0 ? 1 : 0;
            if (resetNow && !state.buttons.reset) {
                triggerReset();
            }
            state.buttons.reset = resetNow;
            break;
        }
        case 11:
            state.velScale = decodeFloat(v, 0.1, 2.0);
            break;
        case 12:
            state.meterAmt = decodeFloat(v, 0, 1);
            applyMeterLayer();
            break;
        case 13:
            state.meterIdx = decodeIndex(v, 4);
            applyMeterLayer();
            break;
        case 14:
            state.claveAmt = decodeFloat(v, 0, 1);
            applyClaveLayer();
            break;
        case 15:
            state.claveIdx = decodeIndex(v, 4);
            applyClaveLayer();
            break;
        case 16:
            state.asymmAmt = decodeFloat(v, 0, 1);
            applyAsymmLayer();
            break;
        case 17:
            state.asymmIdxMenu = decodeIndex(v, 6);
            applyAsymmLayer();
            break;
        case 18:
            state.euclidAmt = decodeFloat(v, 0, 1);
            applyEuclidLayer();
            break;
        case 19:
            state.restLayerAmt = decodeFloat(v, 0, 1);
            applyRestLayer();
            break;
        case 20:
            state.iramaAmt = decodeFloat(v, 0, 1);
            applyIramaLayer();
            break;
        case 21:
            state.iramaLevel = decodeIndex(v, 5);
            applyIramaLayer();
            break;
    }
}

function handleMidiLane(lane, pitch, velocity) {
    var l = Math.floor(Number(lane));
    var p = Math.floor(Number(pitch));
    var vel = Number(velocity);
    if (!isFinite(l) || !isFinite(p) || !isFinite(vel)) {
        return;
    }

    switch (l) {
        case 0:
            // Benny clock blocks (core.clock, midi.ext.clock) emit clock ticks as lane 0,
            // note 0, negative velocity pulses. Accept those in addition to note-on style input.
            if (!(vel > 0 || (p === 0 && vel < 0))) {
                return;
            }
            outlet(0, 'clock');
            break;
        case 1:
            if (vel <= 0) { return; }
            triggerReset();
            break;
        case 2:
            if (vel <= 0) { return; }
            triggerGenerate();
            break;
        case 3:
            if (vel <= 0) { return; }
            triggerFillNow();
            break;
        case 4:
            if (vel <= 0) { return; }
            triggerTap(vel);
            break;
    }
}

function handleTrig(args) {
    if (args.length < 8) {
        return;
    }

    var role = roleFromAny(args[1]);
    if (role < 0) {
        return;
    }

    var voice = Math.floor(Number(args[2]));
    var velocity = normalizeVelocity(args[4]) * state.velScale;
    var midiVel = clamp(Math.round(velocity * 127), 1, 127);
    var lane = laneFor(role, voice);
    if (lane < 0 || lane >= state.notes.length) {
        return;
    }

    var note = state.notes[lane];
    var offsetMs = Number(args[6]);
    if (!isFinite(offsetMs)) {
        offsetMs = 0;
    }
    var gateMs = Number(args[7]);
    if (!isFinite(gateMs)) {
        gateMs = 80;
    }
    emitTriggeredMidi(lane, note, midiVel, offsetMs, gateMs);
}

function list() {
    var args = arrayfromargs(arguments);
    if (args.length >= 2) {
        handleParam(args[0], args[1]);
    }
}

function anything() {
    var name = messagename;
    var args = arrayfromargs(arguments);

    if (name === 'generate') {
        triggerGenerate();
        return;
    }

    if (name === 'fill_now' || name === 'fillnow') {
        triggerFillNow();
        return;
    }

    if (name === 'tap_feel' || name === 'tapfeel') {
        triggerTap(100);
        return;
    }

    if (name === 'reset') {
        triggerReset();
        return;
    }

    if (name === 'param') {
        if (args.length >= 2) {
            handleParam(args[0], args[1]);
        }
        return;
    }

    if (name === 'midi_lane') {
        if (args.length >= 3) {
            handleMidiLane(args[0], args[1], args[2]);
        }
        return;
    }

    if (name === 'trig') {
        handleTrig(args);
        return;
    }

    if (name === 'init') {
        init();
        return;
    }

    if (name === 'bang') {
        triggerGenerate();
        return;
    }

    if (name === 'info') {
        return;
    }
}
