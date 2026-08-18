//============================================================================
// test_paths.js - Small tests for file and directory names
//
// Run: node tests/ut/test_paths.js
//
// The interesting one is defaultOutputDir. Everything this script writes goes
// to one directory, and where that directory is was, until it was asked about,
// nowhere the operator could see: the detection results were written to no file
// at all, and the session saved itself among the operator's registered frames.
//
// So the rule is tested, and so is the shape of the mistake it replaced: the
// frames directory must never be the answer.
//============================================================================

var paths = require("../../javascript/paths.js");

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

suite("isRealXisf", function () {
   ok(paths.isRealXisf("frame_0001.xisf"), "an ordinary name is accepted");
   ok(paths.isRealXisf("FRAME.XISF"), "the extension is matched case-insensitively");

   // exFAT volumes carry AppleDouble sidecars. They are not images, and they
   // are the same size in the listing as the files they shadow.
   ok(!paths.isRealXisf("._frame_0001.xisf"), "an AppleDouble sidecar is skipped");
   ok(!paths.isRealXisf(".hidden.xisf"), "a hidden file is skipped");
   ok(!paths.isRealXisf("frame.fits"), "another format is not an xisf");
   ok(!paths.isRealXisf(".xisf"), "the extension alone is not a file name");
   ok(!paths.isRealXisf(""), "and neither is nothing");
});

suite("baseName", function () {
   equal(paths.baseName("/a/b/c"), "c", "the last component");
   equal(paths.baseName("/a/b/c/"), "c",
         "a trailing separator does not make the name empty");
   equal(paths.baseName("c"), "c", "a bare name is its own base");
   equal(paths.baseName("/"), "", "the root has no name");
});

suite("directoryOf", function () {
   equal(paths.directoryOf("/a/b/c.json"), "/a/b", "the parent of a file");
   equal(paths.directoryOf("/a/b/c/"), "/a/b",
         "a trailing separator is stripped before the parent is taken");
   equal(paths.directoryOf("c.json"), "", "a bare name has no parent here");

   // The trailing-separator case is not academic. GetDirectoryDialog may hand
   // back ".../registered/group/", and without the strip defaultOutputDir sees
   // the parent as the group itself, fails to recognise `registered`, and
   // settles on the frames directory - the one place it must not write.
   equal(paths.defaultOutputDir("/data/session/registered/group/"),
         "/data/session",
         "a browsed directory with a trailing separator still resolves");
});

suite("defaultOutputDir", function () {
   // WBPP's layout: <root>/registered/<group>/*.xisf. Writing into the group
   // would put generated files among the calibrated frames, and so would
   // writing into `registered`. The root is the answer.
   equal(paths.defaultOutputDir("/data/session/registered/Light_BIN-1_6024x4024"),
         "/data/session",
         "the WBPP layout resolves to the root above `registered`");
   equal(paths.defaultOutputDir("/data/session/REGISTERED/Light_BIN-1"),
         "/data/session",
         "and the directory name is matched case-insensitively");

   // Anything else: the parent. Still not the frames directory itself.
   equal(paths.defaultOutputDir("/data/session/frames"), "/data/session",
         "an unrecognised layout falls back to the parent");

   // The frames directory must never be the answer. That was the defect: the
   // session file was saved into the directory holding 654 registered frames,
   // which is the operator's input data and the last place anyone looks.
   var framesDirs = [
      "/data/session/registered/Light_BIN-1",
      "/data/session/frames",
      "/data/registered/g"
   ];
   for (var i = 0; i < framesDirs.length; ++i) {
      ok(paths.defaultOutputDir(framesDirs[i]) !== framesDirs[i],
         "the frames directory is never chosen to write into: " + framesDirs[i]);
   }

   // Degenerate input must not produce a path that looks usable.
   equal(paths.defaultOutputDir(""), "", "nothing in, nothing out");
   equal(paths.defaultOutputDir(null), "", "and null is not a directory");

   // A directory with no parent has nowhere above it to go.
   equal(paths.defaultOutputDir("frames"), "frames",
         "a relative name with no parent stays as it is");
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
