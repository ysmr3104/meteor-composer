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
// Edge bands
//
// The dialog collects, per edge, how far in the band reaches at each END of
// that edge - two percentages, never negative. The boundary runs through both,
// so the excluded band is a trapezoid and its area is the MEAN of the two.
// Expected values below come from that definition.
//----------------------------------------------------------------------------

suite("edgeHalfPlane: nothing set means no half-plane", function () {
   for (var i = 0; i < mg.MASK_EDGES.length; ++i) {
      var edge = mg.MASK_EDGES[i];
      ok(mg.edgeHalfPlane(edge, 0, 0, 100, 100) === null,
         edge + " at 0% on both ends excludes nothing");
   }
});

suite("edgeHalfPlane: one end alone is not a no-op", function () {
   // A band that reaches in at one end and nowhere at the other is a triangle.
   var w = 200, h = 200;
   var region = mg.makeRegion([mg.edgeHalfPlane("top", 0, 20, w, h)], "and");
   var frac = mg.excludedFraction(region, w, h);
   // Mean of 0 and 20 is 10.
   close(frac, 0.10, 0.006, "0% at one end and 20% at the other excludes 10%");
});

suite("edgeHalfPlane: a level band excludes its own percentage", function () {
   var w = 300, h = 200;
   var cases = [
      { edge: "top", percent: 10 },
      { edge: "bottom", percent: 10 },
      { edge: "left", percent: 10 },
      { edge: "right", percent: 10 },
      { edge: "bottom", percent: 25 },
      { edge: "left", percent: 40 }
   ];
   for (var i = 0; i < cases.length; ++i) {
      var c = cases[i];
      var region = mg.makeRegion(
         [mg.edgeHalfPlane(c.edge, c.percent, c.percent, w, h)], "and");
      close(mg.excludedFraction(region, w, h), c.percent / 100, 0.006,
            c.edge + " at " + c.percent + "% on both ends excludes that fraction");
   }
});

suite("edgeHalfPlane: a sloped band excludes the mean of its ends", function () {
   // This is the property that makes the numbers predictable: 8 and 14 is 11%,
   // and the operator can read the readout as "about the average of what I
   // typed" rather than having to think about geometry.
   var w = 400, h = 400;
   var cases = [
      { edge: "bottom", a: 8, b: 14 },
      { edge: "bottom", a: 20, b: 5 },
      { edge: "top", a: 0, b: 30 },
      { edge: "left", a: 12, b: 4 },
      { edge: "right", a: 3, b: 21 }
   ];
   for (var i = 0; i < cases.length; ++i) {
      var c = cases[i];
      var region = mg.makeRegion([mg.edgeHalfPlane(c.edge, c.a, c.b, w, h)], "and");
      close(mg.excludedFraction(region, w, h), (c.a + c.b) / 200, 0.006,
            c.edge + " " + c.a + "/" + c.b + " excludes their mean");
   }
});

suite("edgeHalfPlane: which side is kept", function () {
   var w = 300, h = 200;
   // top 10% of 200 rows -> the boundary sits at y = 20.
   var top = mg.edgeHalfPlane("top", 10, 10, w, h);
   ok(!mg.halfPlaneKeeps(top, 150, 5, w, h), "top band excludes a row above the boundary");
   ok(mg.halfPlaneKeeps(top, 150, 100, w, h), "top band keeps the middle of the frame");
   ok(mg.halfPlaneKeeps(top, 150, 195, w, h), "top band keeps the opposite edge");

   var bottom = mg.edgeHalfPlane("bottom", 10, 10, w, h);
   ok(!mg.halfPlaneKeeps(bottom, 150, 195, w, h), "bottom band excludes the bottom rows");
   ok(mg.halfPlaneKeeps(bottom, 150, 5, w, h), "bottom band keeps the top rows");

   var left = mg.edgeHalfPlane("left", 10, 10, w, h);
   ok(!mg.halfPlaneKeeps(left, 5, 100, w, h), "left band excludes the left columns");
   ok(mg.halfPlaneKeeps(left, 295, 100, w, h), "left band keeps the right columns");

   var right = mg.edgeHalfPlane("right", 10, 10, w, h);
   ok(!mg.halfPlaneKeeps(right, 295, 100, w, h), "right band excludes the right columns");
   ok(mg.halfPlaneKeeps(right, 5, 100, w, h), "right band keeps the left columns");
});

suite("edgeHalfPlane: the first number is the end nearest the origin", function () {
   // top and bottom read left end first; left and right read top end first.
   // Getting these round the wrong way would put the slope the other way and
   // nothing about the excluded area would reveal it - the mean is the same.
   var w = 400, h = 400;

   var top = mg.edgeHalfPlane("top", 0, 40, w, h);
   ok(mg.halfPlaneKeeps(top, 5, 5, w, h),
      "top 0/40: the left end is not covered");
   ok(!mg.halfPlaneKeeps(top, 395, 5, w, h),
      "top 0/40: the right end is");

   var bottom = mg.edgeHalfPlane("bottom", 40, 0, w, h);
   ok(!mg.halfPlaneKeeps(bottom, 5, 395, w, h),
      "bottom 40/0: the left end is covered");
   ok(mg.halfPlaneKeeps(bottom, 395, 395, w, h),
      "bottom 40/0: the right end is not");

   var left = mg.edgeHalfPlane("left", 40, 0, w, h);
   ok(!mg.halfPlaneKeeps(left, 5, 5, w, h),
      "left 40/0: the top end is covered");
   ok(mg.halfPlaneKeeps(left, 5, 395, w, h),
      "left 40/0: the bottom end is not");

   var right = mg.edgeHalfPlane("right", 0, 40, w, h);
   ok(mg.halfPlaneKeeps(right, 395, 5, w, h),
      "right 0/40: the top end is not covered");
   ok(!mg.halfPlaneKeeps(right, 395, 395, w, h),
      "right 0/40: the bottom end is");
});

suite("clampPercent", function () {
   ok(mg.clampPercent(-5) === 0, "negative clamps to 0");
   ok(mg.clampPercent(0) === 0, "0 stays 0");
   ok(mg.clampPercent(37.5) === 37.5, "an in-range value passes through");
   ok(mg.clampPercent(140) === 100, "above 100 clamps to 100");
   ok(mg.clampPercent(NaN) === 0, "a non-number clamps to 0");
   ok(mg.clampPercent("12") === 12, "a numeric string is accepted (the UI hands us text)");
});

suite("edgeHalfPlane: 100% on both ends excludes the whole frame", function () {
   var w = 60, h = 40;
   for (var i = 0; i < mg.MASK_EDGES.length; ++i) {
      var edge = mg.MASK_EDGES[i];
      var region = mg.makeRegion([mg.edgeHalfPlane(edge, 100, 100, w, h)], "and");
      close(mg.excludedFraction(region, w, h), 1.0, 1e-12,
            edge + " at 100% excludes every sample");
   }
});

//----------------------------------------------------------------------------
// Edge specs
//----------------------------------------------------------------------------

suite("edgeSpecIsEmpty", function () {
   var spec = mg.makeEdgeSpec();
   ok(mg.edgeSpecIsEmpty(spec), "a fresh spec excludes nothing");
   ok(mg.edgeSpecIsEmpty(null), "a missing spec excludes nothing");
   spec.bottom.start = 10;
   ok(!mg.edgeSpecIsEmpty(spec), "a depth at one end makes it non-empty");
   spec.bottom.start = 0;
   spec.bottom.end = 3;
   ok(!mg.edgeSpecIsEmpty(spec), "a depth at the other end does too");
});

suite("edgeSpecToRegion: the edges combine with and", function () {
   var w = 200, h = 200;
   var spec = mg.makeEdgeSpec();
   spec.top.start = 10;
   spec.top.end = 10;
   spec.bottom.start = 10;
   spec.bottom.end = 10;
   var region = mg.edgeSpecToRegion(spec, w, h);
   ok(region.halfPlanes.length === 2, "only the edges that are set become half-planes");
   ok(region.mode === "and", "the mode is and");
   close(mg.excludedFraction(region, w, h), 0.20, 0.006,
         "two disjoint 10% bands exclude 20%");

   var empty = mg.edgeSpecToRegion(mg.makeEdgeSpec(), w, h);
   ok(empty.halfPlanes.length === 0, "an empty spec produces no half-planes");
   close(mg.excludedFraction(empty, w, h), 0, 1e-12, "and excludes nothing");
});

suite("edgeSpecToRegion: overlapping bands do not double-count", function () {
   // Left 60% and right 60% overlap in the middle fifth. With "and" that strip
   // is excluded by both, and the union - not the sum - is what is lost.
   var w = 200, h = 100;
   var spec = mg.makeEdgeSpec();
   spec.left.start = 60;
   spec.left.end = 60;
   spec.right.start = 60;
   spec.right.end = 60;
   var frac = mg.excludedFraction(mg.edgeSpecToRegion(spec, w, h), w, h);
   close(frac, 1.0, 1e-12, "the two bands together cover the frame exactly once");
});

suite("buildMask: an edge spec produces the mask detection consumes", function () {
   var w = 40, h = 40;
   var spec = mg.makeEdgeSpec();
   spec.bottom.start = 25;   // rows below y = 39 - 10 = 29
   spec.bottom.end = 25;
   var mask = mg.buildMask(mg.edgeSpecToRegion(spec, w, h), w, h);
   ok(mask.length === w * h, "the mask covers the field");
   ok(mask[10 * w + 20] === 1, "a sample in the kept part is 1");
   ok(mask[38 * w + 20] === 0, "a sample in the excluded band is 0");
});

//----------------------------------------------------------------------------
// Boundary segments for the preview overlay
//----------------------------------------------------------------------------

suite("edgeBoundarySegment: level boundaries", function () {
   var w = 100, h = 200;
   var seg = mg.edgeBoundarySegment("top", 10, 10, w, h);   // y = 20
   ok(seg !== null, "the top boundary crosses the frame");
   close(Math.min(seg.x0, seg.x1), 0, 1e-9, "it starts at the left border");
   close(Math.max(seg.x0, seg.x1), w - 1, 1e-9, "it ends at the right border");
   close(seg.y0, 20, 1e-9, "at the depth the percentage asks for");
   close(seg.y1, 20, 1e-9, "and it is level");

   var left = mg.edgeBoundarySegment("left", 10, 10, w, h);   // x = 10
   ok(left !== null, "the left boundary crosses the frame");
   close(left.x0, 10, 1e-9, "it is vertical at the depth asked for");
   close(left.x1, 10, 1e-9, "at both ends");
   close(Math.min(left.y0, left.y1), 0, 1e-9, "spanning the top border");
   close(Math.max(left.y0, left.y1), h - 1, 1e-9, "to the bottom border");
});

suite("edgeBoundarySegment: a sloped boundary passes through both depths", function () {
   var w = 300, h = 300;
   var seg = mg.edgeBoundarySegment("bottom", 10, 25, w, h);
   ok(seg !== null, "the sloped boundary crosses the frame");
   ok(seg.x0 >= -1e-6 && seg.x0 <= w - 1 + 1e-6
      && seg.x1 >= -1e-6 && seg.x1 <= w - 1 + 1e-6, "x stays in range");
   ok(seg.y0 >= -1e-6 && seg.y0 <= h - 1 + 1e-6
      && seg.y1 >= -1e-6 && seg.y1 <= h - 1 + 1e-6, "y stays in range");

   // At x = 0 it should sit 10% up from the bottom, at x = w-1, 25% up.
   var atLeft = (seg.x0 < seg.x1) ? seg.y0 : seg.y1;
   var atRight = (seg.x0 < seg.x1) ? seg.y1 : seg.y0;
   close(atLeft, (h - 1) - 0.10 * h, 1e-6, "the left end is at the first depth");
   close(atRight, (h - 1) - 0.25 * h, 1e-6, "the right end is at the second");
});

suite("edgeBoundarySegment: nothing to draw when the line misses the frame", function () {
   ok(mg.edgeBoundarySegment("top", 0, 0, 100, 100) === null,
      "an unset edge has no boundary");
   ok(mg.edgeBoundarySegment("top", 100, 100, 100, 100) === null,
      "at 100% the boundary sits past the last row, so there is no segment");
});

//----------------------------------------------------------------------------
// Painted masks
//
// Black is excluded. The painted file is rarely the frame's size, so it is
// sampled by nearest neighbour.
//----------------------------------------------------------------------------

suite("maskFromLuminance: black is excluded", function () {
   var w = 4, h = 2;
   var lum = new Float32Array([
      1, 1, 0, 0,
      1, 0.6, 0.4, 0
   ]);
   var mask = mg.maskFromLuminance(lum, w, h, w, h);
   ok(mask[0] === 1 && mask[1] === 1, "white is kept");
   ok(mask[2] === 0 && mask[3] === 0, "black is excluded");
   ok(mask[4] === 1, "and on the second row too");
   ok(mask[5] === 1, "0.6 is above the halfway point, so kept");
   ok(mask[6] === 0, "0.4 is below it, so excluded");
});

suite("maskFromLuminance: an explicit threshold", function () {
   var lum = new Float32Array([0.2, 0.4, 0.6, 0.8]);
   var strict = mg.maskFromLuminance(lum, 4, 1, 4, 1, 0.75);
   ok(strict[0] === 0 && strict[1] === 0 && strict[2] === 0 && strict[3] === 1,
      "only the brightest survives a high threshold");
   var loose = mg.maskFromLuminance(lum, 4, 1, 4, 1, 0.1);
   ok(loose[0] === 1 && loose[3] === 1, "a low threshold keeps everything");
});

suite("maskFromLuminance: rescales when the sizes differ", function () {
   // A 2x2 painting: the bottom-right quadrant is black.
   var lum = new Float32Array([1, 1, 1, 0]);
   var mask = mg.maskFromLuminance(lum, 2, 2, 8, 8);
   ok(mask.length === 64, "the mask comes back at the target size");
   ok(mask[0] === 1, "top-left quadrant kept");
   ok(mask[3] === 1, "top-right quadrant kept");
   ok(mask[4 * 8 + 1] === 1, "bottom-left quadrant kept");
   ok(mask[7 * 8 + 7] === 0, "bottom-right quadrant excluded");
   ok(mask[4 * 8 + 4] === 0, "including its first sample");
   close(mg.maskExcludedFraction(mask), 0.25, 1e-12, "a quarter is excluded");
});

suite("maskFromLuminance: shrinking a painting also works", function () {
   // Left half black, at 8x8, sampled down to 2x2.
   var lum = new Float32Array(64);
   for (var y = 0; y < 8; ++y) {
      for (var x = 0; x < 8; ++x) {
         lum[y * 8 + x] = (x < 4) ? 0 : 1;
      }
   }
   var mask = mg.maskFromLuminance(lum, 8, 8, 2, 2);
   ok(mask[0] === 0 && mask[2] === 0, "the left column is excluded");
   ok(mask[1] === 1 && mask[3] === 1, "the right column is kept");
});

suite("maskExcludedFraction", function () {
   close(mg.maskExcludedFraction(new Uint8Array([1, 1, 1, 1])), 0, 1e-12,
         "an all-keep mask excludes nothing");
   close(mg.maskExcludedFraction(new Uint8Array([0, 0, 0, 0])), 1, 1e-12,
         "an all-exclude mask excludes everything");
   close(mg.maskExcludedFraction(new Uint8Array([1, 0, 1, 0])), 0.5, 1e-12,
         "half and half");
   close(mg.maskExcludedFraction(null), 0, 1e-12, "no mask excludes nothing");
});

suite("rotateLuminance: quarter turns clockwise", function () {
   // 3 wide, 2 tall, every sample distinct so a wrong turn cannot look right:
   //   1 2 3
   //   4 5 6
   var d = new Float32Array([1, 2, 3, 4, 5, 6]);

   function rowsOf(r) {
      var rows = [];
      for (var y = 0; y < r.height; ++y) {
         var row = [];
         for (var x = 0; x < r.width; ++x) {
            row.push(r.data[y * r.width + x]);
         }
         rows.push(row.join(","));
      }
      return rows.join("|");
   }

   var r0 = mg.rotateLuminance(d, 3, 2, 0);
   ok(r0.width === 3 && r0.height === 2, "no turn keeps the size");
   ok(rowsOf(r0) === "1,2,3|4,5,6", "and the samples (got " + rowsOf(r0) + ")");
   ok(r0.data === d, "no turn hands back the same array rather than copying");

   var r90 = mg.rotateLuminance(d, 3, 2, 90);
   ok(r90.width === 2 && r90.height === 3, "a quarter turn swaps the size");
   ok(rowsOf(r90) === "4,1|5,2|6,3",
      "90 clockwise (got " + rowsOf(r90) + ")");

   var r180 = mg.rotateLuminance(d, 3, 2, 180);
   ok(r180.width === 3 && r180.height === 2, "a half turn keeps the size");
   ok(rowsOf(r180) === "6,5,4|3,2,1", "180 (got " + rowsOf(r180) + ")");

   var r270 = mg.rotateLuminance(d, 3, 2, 270);
   ok(r270.width === 2 && r270.height === 3, "three quarters swaps the size");
   ok(rowsOf(r270) === "3,6|2,5|1,4",
      "270 clockwise (got " + rowsOf(r270) + ")");
});

suite("rotateLuminance: the corner that matters", function () {
   // Which corner the mask's black lands in is the whole question, so it is
   // asserted on its own: a single dark sample at the top left, turned.
   var w = 4, h = 3;
   var d = new Float32Array(w * h);
   for (var i = 0; i < d.length; ++i) {
      d[i] = 1;
   }
   d[0] = 0;   // top-left

   var r90 = mg.rotateLuminance(d, w, h, 90);
   ok(r90.data[0 * r90.width + (r90.width - 1)] === 0,
      "90 clockwise moves the top-left corner to the top right");

   var r180 = mg.rotateLuminance(d, w, h, 180);
   ok(r180.data[(h - 1) * w + (w - 1)] === 0,
      "180 moves it to the bottom right");

   var r270 = mg.rotateLuminance(d, w, h, 270);
   ok(r270.data[(r270.height - 1) * r270.width + 0] === 0,
      "270 clockwise moves it to the bottom left");
});

suite("rotateLuminance: four quarter turns come back", function () {
   var w = 5, h = 3;
   var d = new Float32Array(w * h);
   for (var i = 0; i < d.length; ++i) {
      d[i] = i / (w * h);
   }
   var r = { data: d, width: w, height: h };
   for (var t = 0; t < 4; ++t) {
      r = mg.rotateLuminance(r.data, r.width, r.height, 90);
   }
   ok(r.width === w && r.height === h, "back to the original size");
   var same = true;
   for (i = 0; i < d.length; ++i) {
      if (r.data[i] !== d[i]) {
         same = false;
      }
   }
   ok(same, "and every sample is back where it started");
});

suite("rotateLuminance: angles outside 0-270", function () {
   var d = new Float32Array([1, 2, 3, 4, 5, 6]);
   var a = mg.rotateLuminance(d, 3, 2, 450);    // 450 = 90
   var b = mg.rotateLuminance(d, 3, 2, 90);
   ok(a.width === b.width && a.height === b.height, "450 is 90");
   var same = true;
   for (var i = 0; i < a.data.length; ++i) {
      if (a.data[i] !== b.data[i]) {
         same = false;
      }
   }
   ok(same, "and the samples match");

   var neg = mg.rotateLuminance(d, 3, 2, -90);  // -90 = 270
   var c = mg.rotateLuminance(d, 3, 2, 270);
   same = true;
   for (i = 0; i < neg.data.length; ++i) {
      if (neg.data[i] !== c.data[i]) {
         same = false;
      }
   }
   ok(same, "and -90 is 270");
});

suite("rotateLuminance and maskFromLuminance together", function () {
   // A painted mask whose black is on the left, turned a quarter clockwise, has
   // its black on top. This is the fix for a mask that was painted against a
   // turned preview.
   var w = 8, h = 8;
   var lum = new Float32Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         lum[y * w + x] = (x < 2) ? 0 : 1;
      }
   }
   var straight = mg.maskFromLuminance(lum, w, h, w, h);
   ok(straight[4 * w + 0] === 0 && straight[0 * w + 4] === 1,
      "unturned: the left is excluded, the top is not");

   var turned = mg.rotateLuminance(lum, w, h, 90);
   var mask = mg.maskFromLuminance(turned.data, turned.width, turned.height, w, h);
   ok(mask[0 * w + 4] === 0 && mask[4 * w + 0] === 1,
      "turned a quarter clockwise: the top is excluded, the left is not");
});

//----------------------------------------------------------------------------
// End to end: an edge band suppresses what falls inside it
//----------------------------------------------------------------------------

suite("edge band and detection: a trail in the band is not reported", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 21);
   syn.addStarField(f, 40, 2.5, 0.05, 7);
   syn.addLine(f, 40, 250, 340, 280, 2.0, 0.06);

   var before = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 });
   ok(before.candidates.length >= 1, "the trail is found with no exclusion");

   // The trail runs from y=250 to y=280 in a 300-row frame: a bottom band of
   // 20% reaches up to y = 299 - 60 = 239, so it covers the whole trail.
   var spec = mg.makeEdgeSpec();
   spec.bottom.start = 20;
   spec.bottom.end = 20;
   var mask = mg.buildMask(mg.edgeSpecToRegion(spec, f.width, f.height), f.width, f.height);
   var after = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 }, mask);
   ok(after.candidates.length === 0,
      "the trail is suppressed by the bottom band (got " + after.candidates.length + ")");
});

suite("edge band and detection: a trail outside the band survives", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 21);
   syn.addLine(f, 40, 60, 340, 90, 2.0, 0.06);

   var spec = mg.makeEdgeSpec();
   spec.bottom.start = 20;
   spec.bottom.end = 20;
   var mask = mg.buildMask(mg.edgeSpecToRegion(spec, f.width, f.height), f.width, f.height);
   var after = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 }, mask);
   ok(after.candidates.length >= 1,
      "a trail well clear of the band is still found (got " + after.candidates.length + ")");
});

suite("painted mask and detection: the same suppression by hand", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 21);
   syn.addLine(f, 40, 250, 340, 280, 2.0, 0.06);

   // A painting at a quarter of the field's size, bottom third blacked out.
   var pw = 100, ph = 75;
   var lum = new Float32Array(pw * ph);
   for (var y = 0; y < ph; ++y) {
      for (var x = 0; x < pw; ++x) {
         lum[y * pw + x] = (y >= 55) ? 0 : 1;
      }
   }
   var mask = mg.maskFromLuminance(lum, pw, ph, f.width, f.height);
   var after = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 }, mask);
   ok(after.candidates.length === 0,
      "the painted mask suppresses it too (got " + after.candidates.length + ")");
});

suite("maskRuns: excluded spans, row by row", function () {
   // 1 = keep, 0 = exclude. Row 0 has one run in the middle, row 1 is entirely
   // excluded, row 2 has runs at both ends.
   var w = 5, h = 3;
   var mask = new Uint8Array([
      1, 0, 0, 1, 1,
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0
   ]);
   var runs = mg.maskRuns(mask, w, h);
   ok(runs.length === 4, "four runs (got " + runs.length + ")");
   ok(runs[0].y === 0 && runs[0].x0 === 1 && runs[0].x1 === 2, "row 0 spans x 1..2");
   ok(runs[1].y === 1 && runs[1].x0 === 0 && runs[1].x1 === 4, "row 1 spans the whole width");
   ok(runs[2].y === 2 && runs[2].x0 === 0 && runs[2].x1 === 0, "row 2 starts with a single sample");
   ok(runs[3].y === 2 && runs[3].x0 === 4 && runs[3].x1 === 4, "and ends with one");

   // The runs must account for exactly the excluded samples: an overlay drawn
   // from them has to shade the same set the detection will refuse to look at.
   var covered = 0;
   for (var i = 0; i < runs.length; ++i) {
      covered += runs[i].x1 - runs[i].x0 + 1;
   }
   var excluded = 0;
   for (i = 0; i < mask.length; ++i) {
      if (!mask[i]) {
         ++excluded;
      }
   }
   ok(covered === excluded,
      "the runs cover every excluded sample and nothing else (" + covered
      + " vs " + excluded + ")");
});

suite("maskRuns: an all-keep mask has no runs", function () {
   var mask = new Uint8Array([1, 1, 1, 1]);
   ok(mg.maskRuns(mask, 2, 2).length === 0, "nothing to shade");
});

suite("maskRuns: a real edge band accounts for its own area", function () {
   var w = 120, h = 80;
   var spec = mg.makeEdgeSpec();
   spec.bottom.start = 12;
   spec.bottom.end = 18;
   spec.left.start = 8;
   spec.left.end = 8;
   var mask = mg.buildMask(mg.edgeSpecToRegion(spec, w, h), w, h);
   var runs = mg.maskRuns(mask, w, h);
   var covered = 0;
   for (var i = 0; i < runs.length; ++i) {
      covered += runs[i].x1 - runs[i].x0 + 1;
   }
   close(covered / (w * h), mg.maskExcludedFraction(mask), 1e-12,
         "the shaded area equals the excluded fraction the readout shows");
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
