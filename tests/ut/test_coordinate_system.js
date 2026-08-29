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
