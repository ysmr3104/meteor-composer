//============================================================================
// test_candidate_ops.js - Small tests for candidate list operations
//
// Run: node tests/ut/test_candidate_ops.js
//
// These tests never touch image data. Candidate records are constructed by
// hand so that every expectation is derived from geometry alone.
//============================================================================

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

// Build a candidate from its two endpoints, deriving the fields that
// detection_core would have produced.
function segment(x0, y0, x1, y1, pixelCount, elongation) {
   var dx = x1 - x0, dy = y1 - y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   var angle = Math.atan2(dy, dx) * 180 / Math.PI;
   while (angle < 0) {
      angle += 180;
   }
   while (angle >= 180) {
      angle -= 180;
   }
   return {
      cx: (x0 + x1) / 2,
      cy: (y0 + y1) / 2,
      x0: x0, y0: y0, x1: x1, y1: y1,
      length: len,
      angle: angle,
      elongation: (elongation === undefined) ? 20 : elongation,
      pixelCount: (pixelCount === undefined) ? 50 : pixelCount
   };
}

//----------------------------------------------------------------------------
// Geometry helpers
//----------------------------------------------------------------------------

suite("angleDifference: folds modulo 180", function () {
   close(ops.angleDifference(10, 20), 10, 1e-12, "simple difference");
   close(ops.angleDifference(170, 10), 20, 1e-12, "wraps through 180");
   close(ops.angleDifference(0, 90), 90, 1e-12, "perpendicular is the maximum");
   close(ops.angleDifference(0, 179), 1, 1e-12, "179 is 1 degree from 0");
   close(ops.angleDifference(45, 135), 90, 1e-12, "45 and 135 are perpendicular");
});

suite("perpendicularDistance", function () {
   // Horizontal line through the origin: distance is |py|.
   close(ops.perpendicularDistance(0, 0, 0, 100, 5), 5, 1e-12, "5 above a horizontal line");
   close(ops.perpendicularDistance(0, 0, 0, -100, -3), 3, 1e-12, "3 below, absolute value");
   // Vertical line through the origin: distance is |px|.
   close(ops.perpendicularDistance(0, 0, 90, 7, 100), 7, 1e-12, "7 from a vertical line");
   // A point on the line is at distance zero whatever the angle.
   close(ops.perpendicularDistance(10, 10, 30, 10, 10), 0, 1e-12, "point on the line");
});

suite("axialGap", function () {
   var a = segment(0, 0, 10, 0);
   var b = segment(15, 0, 25, 0);
   close(ops.axialGap(a, b), 5, 1e-12, "gap between collinear segments");

   var c = segment(5, 0, 15, 0);
   close(ops.axialGap(a, c), 0, 1e-12, "overlapping segments have no gap");
});

//----------------------------------------------------------------------------
// Collinear merging
//----------------------------------------------------------------------------

suite("mergeCollinear: joins fragments of one broken trail", function () {
   // A horizontal trail from x=0 to x=100, broken at x=40..55 as a masked
   // star would break it.
   var fragments = [
      segment(0, 50, 40, 50, 80),
      segment(55, 50, 100, 50, 90)
   ];
   var merged = ops.mergeCollinear(fragments, { maxGap: 40 });
   ok(merged.length === 1, "one merged object (got " + merged.length + ")");
   close(merged[0].length, 100, 1e-6, "spans the full extent");
   close(merged[0].angle, 0, 1e-6, "orientation preserved");
   ok(merged[0].fragmentCount === 2, "records the fragment count");
   ok(merged[0].pixelCount === 170, "pixel counts are summed");
   ok(merged[0].gaps.length === 1, "one gap recorded");
   close(merged[0].gaps[0], 15, 1e-6, "gap length is 15");
});

suite("mergeCollinear: does not join parallel but offset trails", function () {
   // Same direction, but 30 samples apart perpendicular to it. A Starlink
   // train looks exactly like this and must stay separate.
   var a = segment(0, 20, 100, 20);
   var b = segment(0, 50, 100, 50);
   var merged = ops.mergeCollinear([a, b], { maxPerpDistance: 4 });
   ok(merged.length === 2, "parallel trails stay separate (got " + merged.length + ")");
});

suite("mergeCollinear: does not join crossing trails", function () {
   var a = segment(0, 50, 100, 50);     // horizontal
   var b = segment(50, 0, 50, 100);     // vertical, crossing at the centre
   var merged = ops.mergeCollinear([a, b]);
   ok(merged.length === 2, "perpendicular trails stay separate");
});

suite("mergeCollinear: respects maxGap", function () {
   var a = segment(0, 50, 40, 50);
   var b = segment(200, 50, 240, 50);   // 160 away
   var near = ops.mergeCollinear([a, b], { maxGap: 200 });
   var far = ops.mergeCollinear([a, b], { maxGap: 40 });
   ok(near.length === 1, "merged when the gap is allowed");
   ok(far.length === 2, "kept apart when the gap exceeds the limit");
});

suite("mergeCollinear: merging is transitive", function () {
   // A-B and B-C are each close enough; A-C alone is not.
   var a = segment(0, 50, 30, 50);
   var b = segment(40, 50, 70, 50);
   var c = segment(80, 50, 110, 50);
   var merged = ops.mergeCollinear([a, b, c], { maxGap: 15 });
   ok(merged.length === 1, "three fragments become one (got " + merged.length + ")");
   ok(merged[0].fragmentCount === 3, "all three recorded");
   close(merged[0].length, 110, 1e-6, "spans the full extent");
});

suite("mergeCollinear: an aircraft strobe becomes one object with regular gaps", function () {
   // Five equal dashes with equal gaps, the signature of a strobe.
   var dashes = [];
   for (var i = 0; i < 5; ++i) {
      dashes.push(segment(i * 40, 100, i * 40 + 20, 100, 30));
   }
   var merged = ops.mergeCollinear(dashes, { maxGap: 30 });
   ok(merged.length === 1, "dashes merge into one object");
   ok(merged[0].fragmentCount === 5, "five fragments");
   ok(merged[0].gaps.length === 4, "four gaps");
   // Every gap is 20 long: dash 0..20, next starts at 40.
   for (var g = 0; g < merged[0].gaps.length; ++g) {
      close(merged[0].gaps[g], 20, 1e-6, "gap " + g + " is regular");
   }
});

suite("mergeCollinear: diagonal fragments", function () {
   var a = segment(0, 0, 30, 30);
   var b = segment(40, 40, 70, 70);
   var merged = ops.mergeCollinear([a, b], { maxGap: 20 });
   ok(merged.length === 1, "diagonal fragments merge");
   close(merged[0].angle, 45, 1e-6, "45 degree orientation");
   close(merged[0].length, Math.sqrt(70 * 70 + 70 * 70), 1e-6, "full diagonal extent");
});

suite("mergeCollinear: single candidate passes through", function () {
   var merged = ops.mergeCollinear([segment(0, 0, 50, 0)]);
   ok(merged.length === 1, "one in, one out");
   ok(merged[0].fragmentCount === 1, "fragment count is 1");
});

suite("mergeCollinear: empty input", function () {
   ok(ops.mergeCollinear([]).length === 0, "empty in, empty out");
});

suite("mergeCollinear: mean orientation wraps correctly near 0/180", function () {
   // 179 and 1 degrees are 2 degrees apart. Their mean must be 0, not 90.
   var a = segment(0, 0, 100, 1.745);    // about 1 degree
   var b = segment(120, 0, 220, -1.745); // about -1 degree = 179
   var merged = ops.mergeCollinear([a, b], { maxGap: 30, maxPerpDistance: 6 });
   ok(merged.length === 1, "the two near-horizontal segments merge");
   var ang = merged[0].angle;
   var distanceFromZero = Math.min(ang, 180 - ang);
   ok(distanceFromZero < 2,
      "mean orientation stays near 0/180 rather than jumping to 90 (got " + ang + ")");
});

//----------------------------------------------------------------------------
// Cross-frame matching
//----------------------------------------------------------------------------

function frame(index, file, candidates) {
   return { index: index, file: file, candidates: candidates };
}

suite("matchAcrossFrames: a meteor is a singleton track", function () {
   var frames = [
      frame(0, "a.xisf", []),
      frame(1, "b.xisf", [segment(100, 100, 300, 200)]),
      frame(2, "c.xisf", [])
   ];
   var tracks = ops.matchAcrossFrames(frames);
   ok(tracks.length === 1, "one track");
   ok(tracks[0].length === 1, "track has one member");
   ok(tracks[0].persistent === false, "not marked persistent");
});

suite("matchAcrossFrames: a meteor spanning an exposure boundary is not persistent", function () {
   // Exposures are contiguous, so a meteor occurring at a frame boundary is
   // recorded partly at the end of one frame and partly at the start of the
   // next. Two frames must therefore not be treated as evidence of a
   // satellite. Observed on 2026-08-12 in DSC05443 / DSC05444.
   var frames = [
      frame(0, "f0.xisf", []),
      frame(1, "f1.xisf", [segment(454, 86, 423, 96)]),
      frame(2, "f2.xisf", [segment(439, 88, 427, 94)]),
      frame(3, "f3.xisf", [])
   ];
   var tracks = ops.matchAcrossFrames(frames);
   ok(tracks.length === 1, "one track (got " + tracks.length + ")");
   ok(tracks[0].length === 2, "two members");
   ok(tracks[0].persistent === false,
      "a 2-frame track is NOT persistent, so the meteor survives filtering");
});

suite("matchAcrossFrames: maxMeteorFrames controls the boundary", function () {
   var frames = [];
   for (var i = 0; i < 3; ++i) {
      frames.push(frame(i, "f" + i + ".xisf",
                        [segment(i * 20, 100, i * 20 + 200, 100)]));
   }
   var lenient = ops.matchAcrossFrames(frames, { maxMeteorFrames: 3 });
   var strict = ops.matchAcrossFrames(frames, { maxMeteorFrames: 2 });
   ok(lenient[0].persistent === false, "3 frames allowed when maxMeteorFrames=3");
   ok(strict[0].persistent === true, "3 frames rejected when maxMeteorFrames=2");
});

suite("matchAcrossFrames: a satellite forms a persistent track", function () {
   // Same orientation, centroid drifting steadily.
   var frames = [];
   for (var i = 0; i < 5; ++i) {
      frames.push(frame(i, "f" + i + ".xisf",
                        [segment(i * 20, 100, i * 20 + 200, 100)]));
   }
   var tracks = ops.matchAcrossFrames(frames);
   ok(tracks.length === 1, "one track (got " + tracks.length + ")");
   ok(tracks[0].length === 5, "five members");
   ok(tracks[0].persistent === true, "marked persistent");
});

suite("matchAcrossFrames: tolerates a skipped frame", function () {
   // The trail is missed in frame 2 because it dipped below the threshold.
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", [segment(20, 100, 220, 100)]),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", [segment(60, 100, 260, 100)])
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxFrameGap: 2 });
   ok(tracks.length === 1, "still one track (got " + tracks.length + ")");
   ok(tracks[0].length === 3, "three members");
});

suite("matchAcrossFrames: a long gap starts a new track", function () {
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", [segment(80, 100, 280, 100)])
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxFrameGap: 2 });
   ok(tracks.length === 2, "two separate tracks (got " + tracks.length + ")");
});

suite("matchAcrossFrames: different orientation is not linked", function () {
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),      // 0 degrees
      frame(1, "f1.xisf", [segment(100, 0, 100, 200)])       // 90 degrees
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxAngleDiff: 15 });
   ok(tracks.length === 2, "perpendicular trails are separate objects");
});

suite("matchAcrossFrames: a large jump is not linked", function () {
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", [segment(2000, 100, 2200, 100)])
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxCentroidShift: 400 });
   ok(tracks.length === 2, "an implausible jump starts a new track");
});

suite("matchAcrossFrames: two simultaneous satellites stay separate", function () {
   var frames = [];
   for (var i = 0; i < 4; ++i) {
      frames.push(frame(i, "f" + i + ".xisf", [
         segment(i * 20, 100, i * 20 + 200, 100),
         segment(i * 20, 600, i * 20 + 200, 600)
      ]));
   }
   var tracks = ops.matchAcrossFrames(frames);
   ok(tracks.length === 2, "two tracks (got " + tracks.length + ")");
   ok(tracks[0].length === 4 && tracks[1].length === 4, "four members each");
});

suite("matchAcrossFrames: empty input", function () {
   ok(ops.matchAcrossFrames([]).length === 0, "no frames, no tracks");
});

//----------------------------------------------------------------------------

console.log("\n============================================");
console.log("passed: " + passed + "  failed: " + failed);
if (failed > 0) {
   console.log("\nFailures:");
   for (var i = 0; i < failures.length; ++i) {
      console.log("  - " + failures[i]);
   }
   process.exit(1);
}
console.log("OK");
