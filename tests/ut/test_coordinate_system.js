//============================================================================
// test_coordinate_system.js - Which coordinate system a session is closed in
//
// Run: node tests/ut/test_coordinate_system.js
//
// The two things worth pinning are the two ways a composite can come out
// looking finished and being wrong: ground-referenced frames read as if they
// were aligned, and registered frames used as a landscape. Both are silent in
// the result, so both are tested here.
//============================================================================

var cs = require("../../javascript/coordinate_system.js");

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

function equal(actual, expected, message) {
   ok(actual === expected,
      message + " (expected \"" + expected + "\", got \"" + actual + "\")");
}

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

//----------------------------------------------------------------------------

suite("an unknown system is the one every earlier session used", function () {
   // A detection_results.json written before this existed has no coordinate
   // system in it. That file is not broken and must not be read as ground.
   equal(cs.normaliseCoordinateSystem(undefined), "sky",
         "no answer means sky-referenced");
   equal(cs.normaliseCoordinateSystem(null), "sky", "nor does null change it");
   equal(cs.normaliseCoordinateSystem(""), "sky", "nor an empty string");
   equal(cs.normaliseCoordinateSystem("Ground"), "sky",
         "and it is not case-insensitive - only the literal is accepted");
   equal(cs.normaliseCoordinateSystem("ground"), "ground",
         "the literal is accepted");

   ok(!cs.isGroundReferenced(undefined), "so nothing unknown reads as ground");
   ok(cs.isGroundReferenced("ground"), "and ground reads as ground");
});

suite("the directory says which system it holds", function () {
   equal(cs.directorySuggests("/data/night/registered/group"), "sky",
         "a group under registered is sky-referenced");
   equal(cs.directorySuggests("/data/night/debayered/group"), "ground",
         "a group under debayered is ground-referenced");

   // GetDirectoryDialog may or may not hand back a trailing separator. The
   // same omission in paths.directoryOf cost a wrong output directory.
   equal(cs.directorySuggests("/data/night/debayered/group/"), "ground",
         "a trailing separator changes nothing");
   equal(cs.directorySuggests("/data/night/registered"), "sky",
         "and the stage directory itself is recognised");

   // Two levels only. A root called `registered` three levels up is about the
   // operator's filing, not about these frames.
   equal(cs.directorySuggests("/registered/night/stage/group"), null,
         "three levels up is not evidence");

   equal(cs.directorySuggests("/data/night/calibrated/group"), null,
         "calibrated says nothing - for a colour camera it is still a mosaic");
   equal(cs.directorySuggests(""), null, "nothing in gives nothing out");
   equal(cs.directorySuggests(null), null, "as does null");
});

suite("a directory that disagrees is named, not overruled", function () {
   var wrongWay = cs.coordinateMismatch("ground", "/data/registered/group");
   ok(wrongWay !== null,
      "registered frames chosen for a ground-referenced session are flagged");
   ok(wrongWay.indexOf("arc") >= 0,
      "and the flag says what goes wrong: the landscape becomes an arc");

   var otherWay = cs.coordinateMismatch("sky", "/data/debayered/group");
   ok(otherWay !== null,
      "debayered frames chosen for a sky-referenced session are flagged");
   ok(otherWay.indexOf("pixel") >= 0,
      "and that flag says the meteors would be placed by pixel");

   equal(cs.coordinateMismatch("sky", "/data/registered/group"), null,
         "agreement is silent");
   equal(cs.coordinateMismatch("ground", "/data/debayered/group"), null,
         "in both directions");
   equal(cs.coordinateMismatch("ground", "/data/lights/group"), null,
         "and a directory with nothing to say says nothing");
});

suite("the words change with the system", function () {
   // The background of a ground-referenced composite is one frame or a stack
   // of frames that were never aligned. Calling it a master light would be
   // wrong in a field the operator is being asked to fill in.
   equal(cs.backgroundLabel("ground"), "Background:",
         "a ground-referenced composite has a background");
   equal(cs.backgroundLabel("sky"), "Master light:",
         "a sky-referenced one has a master light");

   equal(cs.expectedDirectoryName("ground"), "debayered",
         "ground-referenced frames come from debayered");
   equal(cs.expectedDirectoryName("sky"), "registered",
         "sky-referenced frames come from registered");

   ok(cs.framesDialogCaption("ground") !== cs.framesDialogCaption("sky"),
      "the browser caption names the directory being looked for");
});

suite("the background offered is the middle of the night", function () {
   equal(cs.middleFrame(["a", "b", "c"]), "b", "odd counts take the centre");
   equal(cs.middleFrame(["a", "b", "c", "d"]), "b",
         "even counts take the earlier of the two middles");
   equal(cs.middleFrame(["only"]), "only", "one frame is the answer");
   equal(cs.middleFrame([]), null, "no frames gives nothing to offer");
   equal(cs.middleFrame(null), null, "as does null");

   // Not the first frame. The ends of a night hold the brightest sky and
   // whoever is still walking around with a torch.
   var night = [];
   for (var i = 0; i < 1045; ++i) {
      night.push("DSC_" + i);
   }
   ok(cs.middleFrame(night) !== night[0], "and it is never the first frame");
   ok(cs.middleFrame(night) !== night[night.length - 1], "nor the last");
});

suite("the stack window is consecutive and centred", function () {
   var night = [];
   for (var i = 0; i < 100; ++i) {
      night.push("f" + i);
   }

   var w = cs.medianStackFrames(night, "f50", 15);
   equal(w.length, 15, "the count asked for is the count returned");
   equal(w[0], "f43", "and it starts seven before the centre");
   equal(w[14], "f57", "and ends seven after");

   // Consecutive, not spread. Spreading the same 15 frames across the night
   // would draw the stars as dashes over the whole rotation instead of one
   // short trail.
   var consecutive = true;
   for (var j = 1; j < w.length; ++j) {
      if (night.indexOf(w[j]) !== night.indexOf(w[j - 1]) + 1) {
         consecutive = false;
      }
   }
   ok(consecutive, "every frame in the window follows the one before it");

   // Clamped rather than shortened: the operator asked for a noise reduction,
   // and silently giving them half of it at the ends of the night would be a
   // different result wearing the same number.
   var first = cs.medianStackFrames(night, "f0", 15);
   equal(first.length, 15, "a centre at the very start still gets 15");
   equal(first[0], "f0", "taken from the start");
   var last = cs.medianStackFrames(night, "f99", 15);
   equal(last.length, 15, "and so does one at the very end");
   equal(last[14], "f99", "taken from the end");

   var all = cs.medianStackFrames(night, "f50", 500);
   equal(all.length, 100, "asking for more frames than exist gives all of them");

   equal(cs.medianStackFrames(night, "not-here", 5).length, 5,
         "an unknown centre still produces a window");
   equal(cs.medianStackFrames([], "f1", 5).length, 0, "no frames, no window");

   ok(cs.MIN_STACK_FRAMES >= 3,
      "the minimum is at least three - a median of two is their mean");
});

suite("the trail estimate refuses to guess", function () {
   // The number the operator makes the choice on. Inventing one would be
   // worse than saying nothing.
   equal(cs.stackTrailEstimate(15, 0), "", "no interval, no estimate");
   equal(cs.stackTrailEstimate(15, -1), "", "nor a nonsensical one");
   equal(cs.stackTrailEstimate(1, 14), "", "one frame draws no trail");

   // mave's data: 13 s exposures about 14 s apart. 15 frames spans 196 s,
   // which is 0.82 degrees - the figure probe_median_background measured.
   var estimate = cs.stackTrailEstimate(15, 14);
   ok(estimate.indexOf("0.82") >= 0,
      "15 frames 14 s apart is 0.82 deg of trail (got: " + estimate + ")");
   ok(cs.stackTrailEstimate(5, 14).indexOf("56 s") >= 0,
      "and a short window is given in seconds, not fractions of a minute");
});

suite("a night that crosses midnight still has a positive interval", function () {
   equal(cs.observationSeconds("2026-08-12T00:54:13.123"), 3253.123,
         "the time of day is read");
   equal(cs.observationSeconds("no date here"), null, "and rubbish is refused");
   equal(cs.observationSeconds(null), null, "as is null");

   // mave's night: 23:25:20 to 03:38:04, 1045 frames. Subtracting the stamps
   // without allowing for midnight gives a negative interval, and a star trail
   // measured in negative degrees.
   var interval = cs.frameIntervalSeconds("2026-08-12T23:25:20",
                                          "2026-08-13T03:38:04", 1045);
   ok(interval > 0, "the interval is positive across midnight");
   ok(Math.abs(interval - 14.55) < 0.1,
      "and it is about 14.6 s (got " + interval.toFixed(2) + ")");

   var sameNight = cs.frameIntervalSeconds("2026-08-12T01:00:00",
                                           "2026-08-12T01:10:00", 41);
   ok(Math.abs(sameNight - 15) < 0.001,
      "a night inside one day is unaffected");

   equal(cs.frameIntervalSeconds("bad", "worse", 10), 0,
         "unreadable stamps give 0, which reads as `say nothing`");
   equal(cs.frameIntervalSeconds("2026-08-12T01:00:00",
                                 "2026-08-12T01:00:00", 1), 0,
         "and so does a single frame");
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
