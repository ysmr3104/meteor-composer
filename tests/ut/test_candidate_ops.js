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

suite("matchAcrossFrames: proximity alone does not bridge a long gap", function () {
   // Four frames apart and nowhere near the earlier trail's line: neither rule
   // applies, so these are two objects.
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", [segment(80, 300, 280, 300)])   // 200 samples off the line
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxFrameGap: 2 });
   ok(tracks.length === 2, "two separate tracks (got " + tracks.length + ")");
});

suite("matchAcrossFrames: a continuation bridges a longer gap than proximity", function () {
   // The two rules have different reaches on purpose. A trail that is missed
   // for three frames and comes back ON THE SAME LINE is the same object; a
   // disc of the same reach would link almost anything.
   //
   // This is the strobing aircraft: its anti-collision light flashes, so the
   // trail is a row of dashes and is only detected when enough of them run
   // together. Present in DSC05337, absent in 5338 to 5340, present again from
   // 5341 - and the isolated frame came back with a perfect score at the top
   // of the strict list.
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", [segment(260, 100, 460, 100)])
   ];
   var tracks = ops.matchAcrossFrames(frames, { maxFrameGap: 2 });
   ok(tracks.length === 1,
      "collinear across four frames is one object (got " + tracks.length + ")");
   ok(tracks[0].length === 2, "with two members");

   // And the reach is finite: beyond maxContinuationFrameGap it is two objects
   // again, however well they line up.
   var farther = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", []),
      frame(5, "f5.xisf", []),
      frame(6, "f6.xisf", [segment(260, 100, 460, 100)])
   ];
   var far = ops.matchAcrossFrames(farther, { maxFrameGap: 2 });
   ok(far.length === 2,
      "six frames apart is beyond the continuation's reach (got "
      + far.length + ")");
});

suite("matchAcrossFrames: the two reaches are configured separately", function () {
   // Raising both was measured to cost a labelled meteor; raising only the
   // continuation was not. The separation is the point, so it is asserted.
   var frames = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", [segment(260, 100, 460, 100)])
   ];
   ok(ops.matchAcrossFrames(frames, { maxContinuationFrameGap: 2 }).length === 2,
      "with the continuation's reach cut to two, the gap is not bridged");
   ok(ops.matchAcrossFrames(frames, { maxContinuationFrameGap: 4 }).length === 1,
      "with four, it is");

   // Proximity keeps its own, shorter reach: a trail that is near but NOT on
   // the earlier line is not linked across four frames.
   var offLine = [
      frame(0, "f0.xisf", [segment(0, 100, 200, 100)]),
      frame(1, "f1.xisf", []),
      frame(2, "f2.xisf", []),
      frame(3, "f3.xisf", []),
      frame(4, "f4.xisf", [segment(210, 160, 410, 160)])   // 60 off the line
   ];
   ok(ops.matchAcrossFrames(offLine, { maxFrameGap: 2, maxContinuationFrameGap: 4 }).length === 2,
      "near but off the line stays two objects across four frames");
   ok(ops.matchAcrossFrames(offLine, { maxFrameGap: 4 }).length === 1,
      "proximity would have linked it, which is why its reach is left at two");
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

//----------------------------------------------------------------------------
// Continuation matching
//
// The geometry below is the aircraft measured in the 2026-08-12 session,
// in samples of the 1/8 field, so a change that would have let it break loose
// again fails here.
//
//   frame 4976   (380,271)-(314,279)   angle 173
//   frame 4977   (500,255)-(397,269)   angle 173
//   frame 4978   (637,239)-(610,240)   angle 174
//
// The centroid moves 102.3 samples from 4976 to 4977 and 176 from 4977 to 4978,
// against a limit of 100 - so proximity alone loses it after the seventh frame.
//----------------------------------------------------------------------------

function candidateFrom(x0, y0, x1, y1) {
   var dx = x1 - x0, dy = y1 - y0;
   var angle = ops.normalizeAngle180(Math.atan2(dy, dx) * 180 / Math.PI);
   return {
      x0: x0, y0: y0, x1: x1, y1: y1,
      cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
      length: Math.sqrt(dx * dx + dy * dy),
      angle: angle
   };
}

var AIR_4976 = candidateFrom(380, 271, 314, 279);
var AIR_4977 = candidateFrom(500, 255, 397, 269);
var AIR_4978 = candidateFrom(637, 239, 610, 240);

suite("perpendicularToLine", function () {
   var c = candidateFrom(0, 0, 100, 0);
   close(ops.perpendicularToLine(c, 50, 0), 0, 1e-9, "a point on the line");
   close(ops.perpendicularToLine(c, 50, 7), 7, 1e-9, "seven above it");
   close(ops.perpendicularToLine(c, -300, 7), 7, 1e-9,
         "and still seven far off the end - the line is infinite, not the segment");

   var v = candidateFrom(10, 0, 10, 50);
   close(ops.perpendicularToLine(v, 13, 200), 3, 1e-9, "a vertical line");

   var dot = candidateFrom(5, 5, 5, 5);
   close(ops.perpendicularToLine(dot, 5, 9), 4, 1e-9,
         "a zero-length trail falls back to the distance from the point");
});

suite("nearestEndpointGap", function () {
   var a = candidateFrom(0, 0, 100, 0);
   var b = candidateFrom(120, 0, 220, 0);
   close(ops.nearestEndpointGap(a, b), 20, 1e-9, "end to start");
   close(ops.nearestEndpointGap(b, a), 20, 1e-9, "and the same either way round");
   var c = candidateFrom(0, 0, 100, 0);
   close(ops.nearestEndpointGap(a, c), 0, 1e-9, "trails that share an endpoint");
});

suite("continuesTrail: the aircraft that broke loose", function () {
   ok(ops.continuesTrail(AIR_4976, AIR_4977, 1, null),
      "4977 continues 4976");
   ok(ops.continuesTrail(AIR_4977, AIR_4978, 1, null),
      "4978 continues 4977");

   // The measurements that decide it, asserted so a tolerance change is visible.
   var perp = Math.max(ops.perpendicularToLine(AIR_4977, AIR_4978.x0, AIR_4978.y0),
                       ops.perpendicularToLine(AIR_4977, AIR_4978.x1, AIR_4978.y1));
   ok(perp < 3, "4978 sits within 3 samples of 4977's line (" + perp.toFixed(2) + ")");
   var gap = ops.nearestEndpointGap(AIR_4977, AIR_4978);
   ok(gap > 100 && gap < 150,
      "and carries on from its end after a gap of " + gap.toFixed(0) + " samples");

   // The reverse test is what a two-directional rule would have used, and it
   // is why this one is one-directional.
   var reverse = Math.max(ops.perpendicularToLine(AIR_4978, AIR_4977.x0, AIR_4977.y0),
                          ops.perpendicularToLine(AIR_4978, AIR_4977.x1, AIR_4977.y1));
   ok(reverse > 15,
      "measured the other way round it is " + reverse.toFixed(0)
      + " samples off, which would have refused the join");
});

suite("continuesTrail: what it refuses", function () {
   // Parallel but displaced: a different object going the same way.
   var displaced = candidateFrom(560, 300, 660, 286);
   ok(!ops.continuesTrail(AIR_4977, displaced, 1, null),
      "a parallel trail well off the line is not a continuation");

   // On the line but far past the end.
   var faraway = candidateFrom(1400, 133, 1500, 119);
   ok(!ops.continuesTrail(AIR_4977, faraway, 1, null),
      "on the line but far beyond the gap limit is not either");

   // The gap allowance scales with the frame gap, because a skipped frame means
   // twice as long to travel.
   ok(!ops.continuesTrail(AIR_4977, candidateFrom(760, 220, 800, 214), 1, null),
      "too far for one frame");
   ok(ops.continuesTrail(AIR_4977, candidateFrom(760, 220, 800, 214), 2, null),
      "but within reach across two");
});

suite("matchAcrossFrames: the aircraft is one track again", function () {
   // Seven frames the disc could follow, then the two it could not.
   var frames = [
      { file: "f4970", candidates: [candidateFrom(86, 308, 58, 310)] },
      { file: "f4971", candidates: [candidateFrom(116, 302, 86, 308)] },
      { file: "f4972", candidates: [candidateFrom(152, 298, 117, 303)] },
      { file: "f4973", candidates: [candidateFrom(195, 292, 153, 298)] },
      { file: "f4974", candidates: [candidateFrom(247, 287, 195, 293)] },
      { file: "f4975", candidates: [candidateFrom(312, 277, 249, 287)] },
      { file: "f4976", candidates: [AIR_4976] },
      { file: "f4977", candidates: [AIR_4977] },
      { file: "f4978", candidates: [AIR_4978] }
   ];
   var tracks = ops.matchAcrossFrames(frames, null);
   var longest = 0;
   for (var i = 0; i < tracks.length; ++i) {
      if (tracks[i].length > longest) {
         longest = tracks[i].length;
      }
   }
   ok(tracks.length === 1,
      "all nine frames are one track (got " + tracks.length + " tracks)");
   ok(longest === 9, "of length nine (got " + longest + ")");
   ok(tracks[0].persistent, "and it is marked persistent");

   // Without the continuation rule it breaks into three, which is the state
   // that put two aircraft frames at the top of the strict list.
   var noContinuation = ops.matchAcrossFrames(frames, {
      maxContinuationPerp: 0, maxContinuationGap: 0
   });
   ok(noContinuation.length === 3,
      "proximity alone breaks it into three (got " + noContinuation.length + ")");
});

suite("matchAcrossFrames: a two-frame meteor stays two frames", function () {
   // A meteor at an exposure boundary continues its own line too - that is
   // exactly what the continuation rule looks for - so the guard has to be the
   // track length, not the geometry. Two frames is still not persistent.
   var frames = [
      { file: "a", candidates: [candidateFrom(100, 100, 200, 140)] },
      { file: "b", candidates: [candidateFrom(205, 142, 300, 180)] }
   ];
   var tracks = ops.matchAcrossFrames(frames, null);
   ok(tracks.length === 1, "the two halves are one track");
   ok(tracks[0].length === 2, "of length two");
   ok(!tracks[0].persistent, "and two frames is not persistent");
});


suite("combineGroup carries the fields the fragments had", function () {
   // A field dropped in the merge does not fail; it arrives downstream as
   // `undefined` and the code reading it quietly does nothing. edgeContact is
   // the one that matters: the classifier compares it against a threshold, and
   // `undefined >= 0.30` is false, so a merged candidate lying entirely along
   // the boundary of the registered data would keep full marks in silence.
   var a = {
      cx: 10, cy: 10, x0: 0, y0: 10, x1: 20, y1: 10,
      length: 20, angle: 0, elongation: 10, pixelCount: 40,
      minorLength: 3, majorLength: 20, edgeContact: 0.0,
      bbox: { left: 0, top: 8, right: 20, bottom: 12, width: 21, height: 5 }
   };
   var b = {
      cx: 32, cy: 10, x0: 24, y0: 10, x1: 40, y1: 10,
      length: 16, angle: 0, elongation: 8, pixelCount: 30,
      minorLength: 5, majorLength: 16, edgeContact: 0.9,
      bbox: { left: 24, top: 8, right: 40, bottom: 12, width: 17, height: 5 }
   };
   var merged = ops.mergeCollinear([a, b], null);
   ok(merged.length === 1, "the two fragments become one candidate");
   var m = merged[0];

   close(m.edgeContact, 0.9, 1e-9,
         "edgeContact is the largest of the fragments': if any part of the "
         + "object runs along the data boundary, the object does");
   close(m.minorLength, 5, 1e-9, "minorLength is the widest fragment's");
   close(m.majorLength, m.length, 1e-9,
         "majorLength is the merged extent along the axis");
   ok(m.bbox !== undefined && m.bbox !== null, "there is a bounding box");
   ok(m.bbox.left === 0 && m.bbox.top === 8
      && m.bbox.right === 40 && m.bbox.bottom === 12,
      "and it covers both fragments (got " + JSON.stringify(m.bbox) + ")");
   ok(m.bbox.width === 41 && m.bbox.height === 5,
      "with its width and height filled in");
});

suite("combineGroup: a lone candidate keeps everything it had", function () {
   var only = {
      cx: 5, cy: 5, x0: 0, y0: 5, x1: 10, y1: 5,
      length: 10, angle: 0, elongation: 7, pixelCount: 20,
      minorLength: 2, majorLength: 10, edgeContact: 0.4,
      bbox: { left: 0, top: 4, right: 10, bottom: 6, width: 11, height: 3 }
   };
   var m = ops.mergeCollinear([only], null)[0];
   close(m.edgeContact, 0.4, 1e-9, "edgeContact survives");
   close(m.minorLength, 2, 1e-9, "minorLength survives");
   ok(m.bbox !== null && m.bbox.right === 10, "the box survives");
   ok(m.fragmentCount === 1, "and it is reported as one fragment");
});

suite("unionBoundingBox: fragments without a box", function () {
   var withBox = { bbox: { left: 2, top: 3, right: 8, bottom: 9 } };
   var without = {};
   var u = ops.unionBoundingBox([withBox, without]);
   ok(u !== null && u.left === 2 && u.right === 8,
      "one box among several is still a box");
   ok(ops.unionBoundingBox([without, without]) === null,
      "no boxes at all gives null, so candidateBounds() falls back as usual");
});


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
