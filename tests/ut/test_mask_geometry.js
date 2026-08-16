//============================================================================
// test_mask_geometry.js - Small tests for exclusion region geometry
//
// Run: node tests/ut/test_mask_geometry.js
//
// Expected values are derived from the geometric definitions, not from the
// implementation.
//============================================================================

var mg = require("../../javascript/mask_geometry.js");
var syn = require("../fixtures/synthetic.js");
var core = require("../../javascript/detection_core.js");

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

//----------------------------------------------------------------------------
// Half-plane
//
// The boundary line passes through the image centre offset by `offset` along
// the normal (-sin(angle), cos(angle)). For angle = 0 the normal is (0, 1),
// so the line is horizontal and the signed distance is simply y - cy - offset.
//----------------------------------------------------------------------------

suite("signedDistance: horizontal boundary", function () {
   var hp = mg.makeHalfPlane(0, 0, 1);
   var w = 101, h = 101;   // centre at (50, 50)
   close(mg.signedDistance(hp, 50, 50, w, h), 0, 1e-12, "centre is on the line");
   close(mg.signedDistance(hp, 50, 60, w, h), 10, 1e-12, "10 below the centre");
   close(mg.signedDistance(hp, 50, 40, w, h), -10, 1e-12, "10 above the centre");
   close(mg.signedDistance(hp, 0, 50, w, h), 0, 1e-12, "x does not matter for a horizontal line");
});

suite("signedDistance: vertical boundary", function () {
   // angle = 90 -> normal = (-sin 90, cos 90) = (-1, 0)
   var hp = mg.makeHalfPlane(90, 0, 1);
   var w = 101, h = 101;
   close(mg.signedDistance(hp, 40, 50, w, h), 10, 1e-12, "left of centre is positive");
   close(mg.signedDistance(hp, 60, 50, w, h), -10, 1e-12, "right of centre is negative");
});

suite("signedDistance: offset shifts the line", function () {
   var hp = mg.makeHalfPlane(0, 20, 1);
   var w = 101, h = 101;
   close(mg.signedDistance(hp, 50, 70, w, h), 0, 1e-12, "line moved 20 down");
});

suite("halfPlaneKeeps: sides", function () {
   var w = 101, h = 101;
   var keepBelow = mg.makeHalfPlane(0, 0, 1);
   ok(mg.halfPlaneKeeps(keepBelow, 50, 80, w, h), "keep=+1 keeps larger y");
   ok(!mg.halfPlaneKeeps(keepBelow, 50, 20, w, h), "keep=+1 excludes smaller y");

   var keepAbove = mg.makeHalfPlane(0, 0, -1);
   ok(!mg.halfPlaneKeeps(keepAbove, 50, 80, w, h), "keep=-1 excludes larger y");
   ok(mg.halfPlaneKeeps(keepAbove, 50, 20, w, h), "keep=-1 keeps smaller y");
});

//----------------------------------------------------------------------------
// Excluded fraction
//
// A horizontal boundary through the centre splits the frame in half, so the
// excluded fraction must be 1/2 up to the discretisation of the centre row.
//----------------------------------------------------------------------------

suite("excludedFraction: half-plane through the centre", function () {
   var w = 100, h = 100;
   var region = mg.makeRegion([mg.makeHalfPlane(0, 0, -1)], "and");
   var f = mg.excludedFraction(region, w, h);
   close(f, 0.5, 0.01, "half the frame is excluded");
});

suite("excludedFraction: bottom 15 percent, reproducing the atomcam behaviour", function () {
   // Excluding the bottom 15% of a 100-high frame means the boundary sits at
   // y = 85. The centre is at (h-1)/2 = 49.5, so offset = 85 - 49.5 = 35.5.
   var w = 100, h = 100;
   var region = mg.makeRegion([mg.makeHalfPlane(0, 35.5, -1)], "and");
   var f = mg.excludedFraction(region, w, h);
   close(f, 0.15, 0.011, "15% excluded");
});

suite("excludedFraction: empty region excludes nothing", function () {
   var region = mg.makeRegion([], "and");
   close(mg.excludedFraction(region, 50, 50), 0, 1e-12, "no half-planes, nothing excluded");
});

suite("excludedFraction: rotating the boundary keeps the area at half", function () {
   // A line through the centre always bisects the frame, whatever its angle.
   var w = 101, h = 101;
   var angles = [0, 15, 30, 45, 60, 90, 135];
   for (var i = 0; i < angles.length; ++i) {
      var region = mg.makeRegion([mg.makeHalfPlane(angles[i], 0, -1)], "and");
      var f = mg.excludedFraction(region, w, h);
      close(f, 0.5, 0.02, "boundary at " + angles[i] + " degrees bisects the frame");
   }
});

//----------------------------------------------------------------------------
// Region composition
//----------------------------------------------------------------------------

suite("regionKeeps: AND of two half-planes leaves a wedge", function () {
   var w = 101, h = 101;
   // Keep only samples above the centre AND left of the centre.
   var region = mg.makeRegion([
      mg.makeHalfPlane(0, 0, -1),    // keep smaller y
      mg.makeHalfPlane(90, 0, 1)     // keep smaller x
   ], "and");
   ok(mg.regionKeeps(region, 20, 20, w, h), "top-left is kept");
   ok(!mg.regionKeeps(region, 80, 20, w, h), "top-right is excluded");
   ok(!mg.regionKeeps(region, 20, 80, w, h), "bottom-left is excluded");
   ok(!mg.regionKeeps(region, 80, 80, w, h), "bottom-right is excluded");
   close(mg.excludedFraction(region, w, h), 0.75, 0.02, "three quadrants excluded");
});

suite("regionKeeps: OR of two half-planes keeps three quadrants", function () {
   var w = 101, h = 101;
   var region = mg.makeRegion([
      mg.makeHalfPlane(0, 0, -1),
      mg.makeHalfPlane(90, 0, 1)
   ], "or");
   close(mg.excludedFraction(region, w, h), 0.25, 0.02, "one quadrant excluded");
});

//----------------------------------------------------------------------------
// Keyframe interpolation
//----------------------------------------------------------------------------

suite("interpolateAngle: linear within the shortest arc", function () {
   close(mg.interpolateAngle(0, 40, 0.5), 20, 1e-12, "midpoint of 0 and 40");
   close(mg.interpolateAngle(10, 50, 0.25), 20, 1e-12, "quarter point");
   close(mg.interpolateAngle(30, 30, 0.7), 30, 1e-12, "no movement");
});

suite("interpolateAngle: wraps the short way modulo 180", function () {
   // A line has no direction, so 170 -> 10 is a 20 degree move through 180/0,
   // not a 160 degree move backwards.
   close(mg.interpolateAngle(170, 10, 0.5), 0, 1e-9, "170 to 10 passes through 180/0");
   close(mg.interpolateAngle(10, 170, 0.5), 0, 1e-9, "and the same in reverse");
   close(mg.interpolateAngle(179, 1, 0.5), 0, 1e-9, "179 to 1 is a 2 degree move");
});

suite("normalizeAngle: folds into [0,180)", function () {
   close(mg.normalizeAngle(0), 0, 1e-12, "0");
   close(mg.normalizeAngle(180), 0, 1e-12, "180 folds to 0");
   close(mg.normalizeAngle(190), 10, 1e-12, "190 folds to 10");
   close(mg.normalizeAngle(-10), 170, 1e-12, "-10 folds to 170");
   close(mg.normalizeAngle(-190), 170, 1e-12, "-190 folds to 170");
});

suite("interpolateHalfPlanes: endpoints and midpoint", function () {
   var kf = [
      { t: 0, halfPlane: mg.makeHalfPlane(10, -30, -1) },
      { t: 100, halfPlane: mg.makeHalfPlane(50, 30, -1) }
   ];
   var a = mg.interpolateHalfPlanes(kf, 0);
   close(a.angle, 10, 1e-12, "at t=0 the first keyframe is used");
   close(a.offset, -30, 1e-12, "offset at t=0");

   var b = mg.interpolateHalfPlanes(kf, 100);
   close(b.angle, 50, 1e-12, "at t=100 the last keyframe is used");

   var m = mg.interpolateHalfPlanes(kf, 50);
   close(m.angle, 30, 1e-12, "midpoint angle");
   close(m.offset, 0, 1e-12, "midpoint offset");
});

suite("interpolateHalfPlanes: clamps outside the keyframe range", function () {
   var kf = [
      { t: 10, halfPlane: mg.makeHalfPlane(20, 5, -1) },
      { t: 20, halfPlane: mg.makeHalfPlane(40, 15, -1) }
   ];
   close(mg.interpolateHalfPlanes(kf, -100).angle, 20, 1e-12, "before the first keyframe");
   close(mg.interpolateHalfPlanes(kf, 1e9).angle, 40, 1e-12, "after the last keyframe");
});

suite("interpolateHalfPlanes: unsorted keyframes are handled", function () {
   var kf = [
      { t: 100, halfPlane: mg.makeHalfPlane(50, 30, -1) },
      { t: 0, halfPlane: mg.makeHalfPlane(10, -30, -1) }
   ];
   var m = mg.interpolateHalfPlanes(kf, 50);
   close(m.angle, 30, 1e-12, "order does not matter");
});

suite("interpolateHalfPlanes: empty input returns null", function () {
   ok(mg.interpolateHalfPlanes([], 0) === null, "empty keyframes");
   ok(mg.interpolateHalfPlanes(null, 0) === null, "null keyframes");
});

//----------------------------------------------------------------------------
// Zero-border detection
//----------------------------------------------------------------------------

suite("buildValidDataMask: marks the zero-filled border invalid", function () {
   var f = syn.makeField(50, 50, 0);
   // Valid data only in a 30x30 interior block.
   syn.addRect(f, 10, 10, 30, 30, 1.0);
   var mask = mg.buildValidDataMask(f, 0);
   ok(mask[0] === 0, "corner is invalid");
   ok(mask[25 * 50 + 25] === 1, "interior is valid");
   ok(mask[10 * 50 + 10] === 1, "block edge is valid before erosion");
});

suite("buildValidDataMask: erosion shrinks the valid area", function () {
   var f = syn.makeField(50, 50, 0);
   syn.addRect(f, 10, 10, 30, 30, 1.0);
   var mask = mg.buildValidDataMask(f, 3);
   ok(mask[10 * 50 + 10] === 0, "block edge is dropped by erosion");
   ok(mask[13 * 50 + 13] === 1, "3 pixels inside is retained");
   ok(mask[25 * 50 + 25] === 1, "interior is retained");
});

suite("erode: a full mask stays full except at the frame border", function () {
   var w = 20, h = 20;
   var m = new Uint8Array(w * h);
   for (var i = 0; i < m.length; ++i) {
      m[i] = 1;
   }
   var e = mg.erode(m, w, h, 2);
   ok(e[0] === 0, "corner is eroded because the kernel leaves the frame");
   ok(e[10 * w + 10] === 1, "centre survives");
});

//----------------------------------------------------------------------------
// Integration with the detection core
//----------------------------------------------------------------------------

suite("buildMask feeds detection_core and suppresses an excluded trail", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 21);
   // Trail low in the frame, at a slant, as a horizon-hugging feature would be.
   syn.addLine(f, 40, 250, 340, 280, 2.0, 0.06);

   var before = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 });
   ok(before.candidates.length >= 1, "trail is detected without a mask");

   // Boundary tilted to match the trail, keeping only the region above it.
   // Centre is at ((400-1)/2, (300-1)/2) = (199.5, 149.5). A line at angle
   // atan2(30,300) = 5.71 degrees passing near y = 240 at the centre needs
   // offset = (240 - 149.5) * cos(5.71 deg) = 90.05.
   var angle = Math.atan2(30, 300) * 180 / Math.PI;
   var offset = (240 - 149.5) * Math.cos(angle * Math.PI / 180);
   var region = mg.makeRegion([mg.makeHalfPlane(angle, offset, -1)], "and");
   var mask = mg.buildMask(region, f.width, f.height);

   var after = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 }, mask);
   ok(after.candidates.length === 0,
      "trail is suppressed by the tilted half-plane (got " + after.candidates.length + ")");

   var frac = mg.excludedFraction(region, f.width, f.height);
   ok(frac > 0.15 && frac < 0.30,
      "roughly the bottom fifth is excluded (got " + (frac * 100).toFixed(1) + "%)");
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
