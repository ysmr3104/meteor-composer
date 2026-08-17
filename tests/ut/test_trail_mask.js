//============================================================================
// test_trail_mask.js - Small tests for meteor trail masks
//
// Run: node tests/ut/test_trail_mask.js
//
// Expected values come from the geometry - the distance from a point to a
// segment - not from calling the implementation back (docs/tests.md 3-2).
//
// The properties worth pinning down are the ones the composite depends on:
// the mask covers the whole trail including its faint ends, it reaches 0
// smoothly rather than with a visible step, and overlapping trails never push
// it above 1.
//============================================================================

var mask = require("../../javascript/trail_mask.js");

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

// A horizontal trail, so distances are easy to reason about by hand.
var HORIZONTAL = { x0: 100, y0: 200, x1: 300, y1: 200, width: 4 };

var NO_EXTRAS = { coreRadius: 10, coreScale: 0, featherWidth: 20, endExtension: 0 };

//----------------------------------------------------------------------------

suite("distanceToSegment", function () {
   // Perpendicular from the middle.
   close(mask.distanceToSegment(200, 210, 100, 200, 300, 200), 10, 1e-9,
         "10 above the middle of the segment");
   // On the segment.
   close(mask.distanceToSegment(150, 200, 100, 200, 300, 200), 0, 1e-9,
         "a point on the segment is at zero");
   // Past the end: the distance is to the endpoint, not to the infinite line.
   // Without this a mask would extend forever along the trail's direction.
   close(mask.distanceToSegment(400, 200, 100, 200, 300, 200), 100, 1e-9,
         "past the end, the distance is to the endpoint");
   close(mask.distanceToSegment(400, 200 + 100, 100, 200, 300, 200),
         Math.sqrt(100 * 100 + 100 * 100), 1e-9,
         "diagonally past the end, likewise");
   // A degenerate segment is a point.
   close(mask.distanceToSegment(103, 204, 100, 200, 100, 200), 5, 1e-9,
         "a zero-length segment behaves as a point");
});

suite("smoothstep", function () {
   close(mask.smoothstep(0), 0, 1e-9, "0 at the start");
   close(mask.smoothstep(1), 1, 1e-9, "1 at the end");
   close(mask.smoothstep(0.5), 0.5, 1e-9, "symmetric about the middle");
   ok(mask.smoothstep(-1) === 0 && mask.smoothstep(2) === 1, "clamped outside");

   // The reason for smoothstep rather than a straight ramp: the slope has to
   // vanish at both ends, or the fade meets the sky at a crease and the seam
   // is visible after all.
   var eps = 1e-4;
   var slopeAtZero = (mask.smoothstep(eps) - mask.smoothstep(0)) / eps;
   var slopeAtOne = (mask.smoothstep(1) - mask.smoothstep(1 - eps)) / eps;
   ok(slopeAtZero < 0.01, "the slope vanishes at the start (" + slopeAtZero.toFixed(5) + ")");
   ok(slopeAtOne < 0.01, "and at the end (" + slopeAtOne.toFixed(5) + ")");

   // Monotonic in between, so the fade never brightens on its way out.
   var previous = -1;
   for (var t = 0; t <= 1.0001; t += 0.05) {
      var v = mask.smoothstep(t);
      ok(v >= previous, "monotonic at t=" + t.toFixed(2));
      previous = v;
   }
});

suite("maskValueAt: core, fade, and outside", function () {
   // On the axis: solid.
   close(mask.maskValueAt(200, 200, HORIZONTAL, NO_EXTRAS), 1, 1e-9,
         "the axis is fully inside");
   // At the core edge: still solid.
   close(mask.maskValueAt(200, 210, HORIZONTAL, NO_EXTRAS), 1, 1e-9,
         "the core edge is still 1");
   // Halfway through the feather: smoothstep(0.5).
   close(mask.maskValueAt(200, 220, HORIZONTAL, NO_EXTRAS), 0.5, 1e-9,
         "halfway through the feather is a half");
   // At the outer edge: zero.
   close(mask.maskValueAt(200, 230, HORIZONTAL, NO_EXTRAS), 0, 1e-9,
         "the outer edge is 0");
   close(mask.maskValueAt(200, 400, HORIZONTAL, NO_EXTRAS), 0, 1e-9,
         "far away is 0");

   // Symmetric about the axis.
   close(mask.maskValueAt(200, 215, HORIZONTAL, NO_EXTRAS),
         mask.maskValueAt(200, 185, HORIZONTAL, NO_EXTRAS), 1e-9,
         "the fade is symmetric about the trail");

   // Never increases with distance.
   var previous = 2;
   for (var d = 0; d <= 40; d += 2) {
      var v = mask.maskValueAt(200, 200 + d, HORIZONTAL, NO_EXTRAS);
      ok(v <= previous + 1e-12, "monotonic falling at distance " + d);
      previous = v;
   }
});

suite("the ends are covered", function () {
   // A trail's endpoints are where it fell below the detection threshold, not
   // where it stopped emitting. The extension exists so the faint tips - the
   // part that shows a meteor brightening and fading - are inside the mask.
   var withExtension = { coreRadius: 10, coreScale: 0, featherWidth: 20,
                         endExtension: 15 };
   // 20 px past the endpoint. Without the extension that is 10 px into a
   // 20 px feather, so half covered; with a 15 px extension it is back
   // inside the solid core.
   close(mask.maskValueAt(320, 200, HORIZONTAL, NO_EXTRAS), 0.5, 1e-9,
         "20 px past the endpoint is only half covered");
   close(mask.maskValueAt(320, 200, HORIZONTAL, withExtension), 1, 1e-9,
         "and solid once the trail is extended past its endpoint");

   var seg = mask.extendedSegment(HORIZONTAL, 15);
   close(seg.x0, 85, 1e-9, "the segment extends before the first endpoint");
   close(seg.x1, 315, 1e-9, "and past the second");
   close(seg.y0, 200, 1e-9, "without drifting off the axis");

   // A diagonal trail extends along its own direction, not along an axis.
   var diagonal = { x0: 0, y0: 0, x1: 100, y1: 100 };
   var d = mask.extendedSegment(diagonal, Math.sqrt(2) * 10);
   close(d.x0, -10, 1e-6, "diagonal extension moves in x");
   close(d.y0, -10, 1e-6, "and equally in y");

   // A degenerate trail must not produce NaN.
   var dot = mask.extendedSegment({ x0: 5, y0: 5, x1: 5, y1: 5 }, 10);
   ok(!isNaN(dot.x0) && !isNaN(dot.y0), "a zero-length trail stays finite");
});

suite("coreRadiusFor: follows the measured width when it is wider", function () {
   var opt = { coreRadius: 6, coreScale: 2.0 };
   // width 4 -> half-width 2 -> scaled 4, below the floor of 6.
   close(mask.coreRadiusFor({ x0: 0, y0: 0, x1: 10, y1: 0, width: 4 }, opt), 6, 1e-9,
         "a thin trail gets the floor");
   // width 20 -> half-width 10 -> scaled 20, above the floor.
   close(mask.coreRadiusFor({ x0: 0, y0: 0, x1: 10, y1: 0, width: 20 }, opt), 20, 1e-9,
         "a wide trail gets its own width");
   // No measurement at all.
   close(mask.coreRadiusFor({ x0: 0, y0: 0, x1: 10, y1: 0 }, opt), 6, 1e-9,
         "no measured width falls back to the floor");
});

suite("maskBounds: only the pixels that can matter", function () {
   var b = mask.maskBounds(HORIZONTAL, 1000, 1000, NO_EXTRAS);
   close(b.left, 100 - 30, 1e-9, "left reaches core + feather before the trail");
   close(b.right, 300 + 30, 1e-9, "right likewise past it");
   close(b.top, 200 - 30, 1e-9, "top likewise");
   close(b.bottom, 200 + 30, 1e-9, "bottom likewise");
   ok(!b.clipped, "a trail well inside the frame is not clipped");

   // Everything outside the bounds must really be zero, otherwise rendering
   // only the bounds would silently truncate the mask.
   ok(mask.maskValueAt(b.left - 1, 200, HORIZONTAL, NO_EXTRAS) === 0,
      "just outside the bounds the mask is already zero");
   ok(mask.maskValueAt(200, b.top - 1, HORIZONTAL, NO_EXTRAS) === 0,
      "likewise above");

   // At the frame edge the bounds are clipped and say so.
   var edge = mask.maskBounds({ x0: 5, y0: 5, x1: 50, y1: 5 }, 1000, 1000, NO_EXTRAS);
   ok(edge.left === 0 && edge.top === 0, "bounds are clamped to the frame");
   ok(edge.clipped, "and report that they were");
});

suite("renderMask", function () {
   var field = mask.renderMask([{ x0: 20, y0: 30, x1: 60, y1: 30, width: 2 }],
                               100, 60, NO_EXTRAS);
   ok(field.width === 100 && field.height === 60, "the field has the requested size");
   ok(field.data.length === 6000, "and the matching number of samples");

   close(field.data[30 * 100 + 40], 1, 1e-6, "the axis is solid");
   // (95, 5) is 43 px from the nearest end of the trail, past core + feather.
   close(field.data[5 * 100 + 95], 0, 1e-6, "far from the trail is empty");

   // Every value stays within range, which the composite depends on: a value
   // above 1 would brighten the result beyond the light that is actually
   // there.
   var outOfRange = 0;
   for (var i = 0; i < field.data.length; ++i) {
      if (!(field.data[i] >= 0 && field.data[i] <= 1)) {
         ++outOfRange;
      }
   }
   ok(outOfRange === 0,
      "every one of the " + field.data.length + " samples is within [0, 1]"
      + (outOfRange ? " (" + outOfRange + " were not)" : ""));

   // Two trails crossing must not stack. Adding them would put the crossing
   // point above 1 and brighten it in the composite.
   var crossed = mask.renderMask([
      { x0: 10, y0: 30, x1: 90, y1: 30, width: 2 },
      { x0: 50, y0: 5, x1: 50, y1: 55, width: 2 }
   ], 100, 60, NO_EXTRAS);
   close(crossed.data[30 * 100 + 50], 1, 1e-6,
         "the crossing point is 1, not 2");

   var over = false;
   for (var j = 0; j < crossed.data.length; ++j) {
      if (crossed.data[j] > 1 + 1e-9) {
         over = true;
      }
   }
   ok(!over, "no sample anywhere exceeds 1");

   // An empty list gives an empty mask rather than throwing.
   var empty = mask.renderMask([], 10, 10, null);
   ok(empty.data.length === 100, "no trails still yields a field");
   var sum = 0;
   for (var k = 0; k < empty.data.length; ++k) {
      sum += empty.data[k];
   }
   close(sum, 0, 1e-9, "and it is all zero");
});

suite("maskCoverage", function () {
   var field = mask.renderMask([{ x0: 20, y0: 30, x1: 60, y1: 30, width: 2 }],
                               100, 60, NO_EXTRAS);
   var c = mask.maskCoverage(field);
   ok(c.total === 6000, "total counts every sample");
   ok(c.touched > 0 && c.touched < c.total, "some but not all of the frame is touched");
   ok(c.solid > 0 && c.solid <= c.touched, "the solid core is a subset of what is touched");
   ok(c.weightedArea <= c.touched, "the weighted area cannot exceed the touched count");
   ok(c.fraction > 0 && c.fraction < 1, "the fraction is between 0 and 1");

   var blank = mask.maskCoverage(mask.renderMask([], 10, 10, null));
   ok(blank.touched === 0 && blank.fraction === 0, "an empty mask covers nothing");
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
