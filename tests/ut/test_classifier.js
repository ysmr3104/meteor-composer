//============================================================================
// test_classifier.js - Small tests for candidate scoring
//
// Run: node tests/ut/test_classifier.js
//
// The scoring weights themselves are not tested here: a threshold is not a
// property that a unit test can settle, and pretending otherwise is how test
// suites stop being believed (docs/tests.md 5-1). What is tested is the
// behaviour the weights sit inside - that a fixed structure is recognised as
// fixed and not as a satellite, that colour is ranked rather than compared
// against an absolute, that nothing is ever scored to exactly zero.
//
// How well the scoring separates real meteors is measured separately, against
// the labelled session, by tests/eval/evaluate_classifier.js.
//============================================================================

var clf = require("../../javascript/classifier.js");
var ops = require("../../javascript/candidate_ops.js");

var passed = 0;
var failed = 0;
var failures = [];

function ok(condition, message) {
   if (condition) {
      ++passed;
   } else {
      ++failed;
      failures.push(message);
      console.log("  FAIL: " + message);
   }
}

function close(actual, expected, tolerance, message) {
   var diff = Math.abs(actual - expected);
   ok(diff <= tolerance,
      message + " (expected " + expected + ", got " + actual + ", diff " + diff + ")");
}

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

// A track as matchAcrossFrames would return it.
function track(id, positions) {
   var members = [];
   for (var i = 0; i < positions.length; ++i) {
      members.push({
         frameIndex: i,
         file: "f" + i + ".xisf",
         candidate: { cx: positions[i][0], cy: positions[i][1],
                      length: 20, angle: 45, elongation: 10, pixelCount: 50 }
      });
   }
   return { id: id, length: members.length, members: members,
            persistent: members.length > 2 };
}

//----------------------------------------------------------------------------

suite("analyzeTracks: a fixed structure is not a satellite", function () {
   // The real example: 22 frames, centroid varying by under 0.1 samples.
   var fixed = [];
   for (var i = 0; i < 22; ++i) {
      fixed.push([421.9 + (i % 2) * 0.05, 180.9 - (i % 3) * 0.03]);
   }
   var a = clf.analyzeTracks([track(0, fixed)], null)[0];
   ok(a.stationary, "a track that does not move is stationary");
   ok(!a.persistent,
      "and is NOT reported as persistent - it is a fixed structure, not a "
      + "satellite, and the reason is what the operator reads");
   ok(a.spread < 0.2, "its spread is tiny (" + a.spread.toFixed(3) + ")");
   close(a.meanX, 421.925, 0.05, "mean position is the centre of the cluster");

   // A satellite: same number of frames, but moving.
   var moving = [];
   for (var j = 0; j < 14; ++j) {
      moving.push([100 + j * 40, 200 + j * 12]);
   }
   var b = clf.analyzeTracks([track(1, moving)], null)[0];
   ok(!b.stationary, "a moving track is not stationary");
   ok(b.persistent, "a long moving track is persistent");
   ok(b.spread > 100, "its spread is large (" + b.spread.toFixed(0) + ")");
});

suite("analyzeTracks: short tracks", function () {
   // One frame: a meteor. Cannot be called fixed on one observation.
   var one = clf.analyzeTracks([track(0, [[500, 400]])], null)[0];
   ok(!one.stationary, "a single frame is never stationary");
   ok(!one.persistent, "a single frame is never persistent");

   // Two frames in nearly the same place: a meteor that straddled an exposure
   // boundary looks like this. Two observations are not enough to call it
   // fixed, and calling it fixed would discard exactly the case
   // maxMeteorFrames exists to protect.
   var two = clf.analyzeTracks([track(0, [[500, 400], [500.05, 400.02]])], null)[0];
   ok(!two.stationary,
      "two frames are not enough to call a candidate fixed");
   ok(!two.persistent, "two frames is within what a meteor can do");

   // Three in the same place is enough.
   var three = clf.analyzeTracks([track(0, [[500, 400], [500.05, 400.02], [499.98, 400.01]])],
                                 null)[0];
   ok(three.stationary, "three frames in the same place is stationary");

   // Exactly at the radius boundary.
   var atEdge = clf.analyzeTracks([track(0, [[500, 400], [503, 400], [501.5, 400]])],
                                  { stationaryRadius: 1.5 })[0];
   ok(atEdge.stationary, "spread exactly at the radius still counts as fixed");
   var pastEdge = clf.analyzeTracks([track(0, [[500, 400], [504, 400], [502, 400]])],
                                    { stationaryRadius: 1.5 })[0];
   ok(!pastEdge.stationary, "spread past the radius does not");
});

suite("analyzeTracks matches candidate_ops' own tracks", function () {
   // Feed it the real thing rather than a hand-built structure, so the two
   // modules cannot drift apart in what a track looks like.
   var c1 = { cx: 100, cy: 100, angle: 45, length: 20, elongation: 10, pixelCount: 50 };
   var c2 = { cx: 100.02, cy: 100.01, angle: 45, length: 20, elongation: 10, pixelCount: 50 };
   var c3 = { cx: 99.99, cy: 100.03, angle: 45, length: 20, elongation: 10, pixelCount: 50 };
   var tracks = ops.matchAcrossFrames([
      { file: "a", candidates: [c1] },
      { file: "b", candidates: [c2] },
      { file: "c", candidates: [c3] }
   ], null);
   ok(tracks.length === 1, "the three link into one track");
   var a = clf.analyzeTracks(tracks, null)[0];
   ok(a.stationary, "and analyzeTracks reads it as stationary");
   ok(a.length === 3, "with the track's own length carried through");
});

suite("greenFraction", function () {
   close(clf.greenFraction({ r: 1, g: 2, b: 1 }), 0.5, 1e-9, "2 of 4 is a half");
   close(clf.greenFraction({ r: 1, g: 1, b: 1 }), 1 / 3, 1e-9, "equal channels give a third");

   // A faint trail can measure negative once the background is removed. A
   // ratio against a non-positive total is meaningless, not merely noisy, so
   // it is refused rather than returned as a number that looks usable.
   ok(clf.greenFraction({ r: -0.01, g: 0.005, b: 0.004 }) === null,
      "a non-positive total yields null");
   ok(clf.greenFraction({ r: 0, g: 0, b: 0 }) === null, "all zero yields null");
   ok(clf.greenFraction(null) === null, "no colour at all yields null");
});

suite("rankOf: colour is judged relative to the session", function () {
   var pop = [0.30, 0.40, 0.45, 0.50, 0.60];
   close(clf.rankOf(0.20, pop), 0.0, 1e-9, "below everything ranks at 0");
   close(clf.rankOf(0.70, pop), 1.0, 1e-9, "above everything ranks at 1");
   close(clf.rankOf(0.45, pop), 0.5, 1e-9, "the middle value ranks at the middle");

   // Ties get the same rank whichever order they arrived in. Without this,
   // two identical measurements could score differently.
   var tied = [0.4, 0.4, 0.4, 0.4];
   close(clf.rankOf(0.4, tied), 0.5, 1e-9, "a value equal to every entry ranks at 0.5");

   ok(clf.rankOf(0.5, []) === 0.5, "an empty population ranks everything neutrally");

   // The point of ranking: the same absolute value means different things in
   // different sessions. A camera whose whole population sits higher must not
   // make every candidate look green.
   var lowGear = [0.30, 0.32, 0.34, 0.36];
   var highGear = [0.50, 0.52, 0.54, 0.56];
   ok(clf.rankOf(0.35, lowGear) > 0.5, "0.35 is high for one camera");
   ok(clf.rankOf(0.35, highGear) < 0.5, "and low for another");
});

suite("scoreCandidate", function () {
   var plain = { trackLength: 1, stationary: false, persistent: false, colour: null };
   var s = clf.scoreCandidate(plain, null, null);
   close(s.score, 1.0, 1e-9, "an isolated candidate with no colour scores 1");
   ok(s.reasons.length === 0, "and carries no explanation, because nothing counted against it");

   var fixed = { trackLength: 22, stationary: true, persistent: false, colour: null };
   var f = clf.scoreCandidate(fixed, null, null);
   ok(f.score < 0.05, "a fixed structure scores very low");
   ok(f.score > 0, "but never exactly zero - sorting must not hide it entirely");
   ok(f.reasons.length === 1 && f.reasons[0].indexOf("stationary") >= 0,
      "and says it is stationary, not that it is a satellite");

   var sat = { trackLength: 14, stationary: false, persistent: true, colour: null };
   var p = clf.scoreCandidate(sat, null, null);
   ok(p.score < 0.2 && p.score > f.score,
      "a satellite scores low, but above a fixed structure");
   ok(p.reasons[0].indexOf("longer than a meteor") >= 0,
      "and says why");

   // Colour moves the score but cannot decide it: its measured accuracy is
   // 0.801, strong but not conclusive.
   var pop = [0.40, 0.45, 0.50, 0.55, 0.60];
   var green = clf.scoreCandidate(
      { trackLength: 1, stationary: false, persistent: false,
        colour: { r: 0.001, g: 0.004, b: 0.001 } }, pop, null);
   var grey = clf.scoreCandidate(
      { trackLength: 1, stationary: false, persistent: false,
        colour: { r: 0.003, g: 0.002, b: 0.003 } }, pop, null);
   ok(green.score > grey.score, "a greener candidate scores higher");
   ok(grey.score > 0.2,
      "but a colourless one keeps a substantial score - colour alone must not "
      + "bury a candidate");
   ok(green.reasons.length === 1 && green.reasons[0].indexOf("ranks at") >= 0,
      "the colour reason quotes the rank, not a bare threshold");

   // No colour measured: the score simply does not include that term, rather
   // than defaulting to a penalty. An unmeasured feature is not evidence.
   var noColour = clf.scoreCandidate(
      { trackLength: 1, stationary: false, persistent: false, colour: null }, pop, null);
   close(noColour.score, 1.0, 1e-9, "a candidate with no colour measured is not penalised");
});

suite("scoreAll", function () {
   var rows = [
      { trackLength: 1, stationary: false, persistent: false,
        colour: { r: 0.001, g: 0.004, b: 0.001 } },
      { trackLength: 22, stationary: true, persistent: false,
        colour: { r: 0.002, g: 0.002, b: 0.002 } },
      { trackLength: 14, stationary: false, persistent: true,
        colour: { r: 0.002, g: 0.003, b: 0.002 } }
   ];
   clf.scoreAll(rows, null);
   for (var i = 0; i < rows.length; ++i) {
      ok(rows[i].score > 0 && rows[i].score <= 1,
         "row " + i + " scores within (0, 1]");
      ok(Array.isArray(rows[i].scoreReasons), "row " + i + " carries its reasons");
   }
   ok(rows[0].score > rows[2].score && rows[2].score > rows[1].score,
      "isolated > satellite > fixed structure");
});

suite("presets", function () {
   var names = clf.presetNames();
   ok(names.length === 3, "three presets, as requirements.md 6.2 asks");
   // The default must hide nothing: a human screens everything afterwards, so
   // the cost of a missed meteor outweighs a longer list (6.2).
   ok(clf.PRESETS.loose.cutoff === 0, "the loose preset hides nothing at all");
   ok(clf.PRESETS.standard.cutoff < clf.PRESETS.strict.cutoff,
      "standard is looser than strict");
   for (var i = 0; i < names.length; ++i) {
      ok(clf.PRESETS[names[i]].label.length > 0, names[i] + " has a label");
   }
});

//----------------------------------------------------------------------------

console.log("\n============================================");
console.log("passed: " + passed + "  failed: " + failed);
if (failed > 0) {
   console.log("\nFailures:");
   failures.forEach(function (f) {
      console.log("  - " + f);
   });
   process.exit(1);
}
console.log("OK");
