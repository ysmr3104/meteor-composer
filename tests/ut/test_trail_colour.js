//============================================================================
// test_trail_colour.js - Small tests for reading a candidate's colour
//
// Run: node tests/ut/test_trail_colour.js
//
// The sampler is a function, so a whole image can be written here and the
// geometry checked against values that are known by construction rather than
// read back out of the implementation.
//============================================================================

var tc = require("../../javascript/trail_colour.js");

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

// A painted image with a sampler over it, so the expected colour is whatever
// was painted.
function makeImage(width, height, background) {
   var planes = [new Float64Array(width * height),
                 new Float64Array(width * height),
                 new Float64Array(width * height)];
   for (var c = 0; c < 3; ++c) {
      for (var i = 0; i < width * height; ++i) {
         planes[c][i] = background[c];
      }
   }
   return {
      width: width, height: height, planes: planes,
      set: function (x, y, rgb) {
         for (var k = 0; k < 3; ++k) {
            this.planes[k][y * width + x] = rgb[k];
         }
      },
      sampler: function (x, y, ch) {
         return planes[ch][y * width + x];
      }
   };
}

// A horizontal streak at row `row`, from x0 to x1.
function paintStreak(img, row, x0, x1, rgb) {
   for (var x = x0; x <= x1; ++x) {
      img.set(x, row, rgb);
   }
}

// A candidate in 1/8 samples covering the full-resolution span x0..x1 at `row`.
function candidateFor(x0, x1, row, scale) {
   var toSample = function (p) { return (p + 0.5) / scale - 0.5; };
   return { x0: toSample(x0), y0: toSample(row), x1: toSample(x1), y1: toSample(row) };
}

//----------------------------------------------------------------------------

suite("sampleCentreToImagePosition", function () {
   close(tc.sampleCentreToImagePosition(0, 8), 3.5, 1e-12,
         "sample 0 of an 8x reduction covers pixels 0-7, centred at 3.5");
   close(tc.sampleCentreToImagePosition(1, 8), 11.5, 1e-12, "sample 1 at 11.5");
   close(tc.sampleCentreToImagePosition(0, 1), 0, 1e-12, "no reduction is the identity");
});

suite("measureTrailColour: the background is subtracted", function () {
   var img = makeImage(400, 200, [0.01, 0.01, 0.01]);
   paintStreak(img, 100, 80, 320, [0.03, 0.07, 0.03]);
   var c = candidateFor(80, 320, 100, 8);
   var m = tc.measureTrailColour(img.sampler, c, 8, 8, 400, 200, null);

   ok(m !== null, "a measurement came back");
   // Painted 0.03/0.07/0.03 on a 0.01 background, so the excess is
   // 0.02/0.06/0.02 - the background must be gone, not merely small.
   close(m.r, 0.02, 1e-9, "red excess");
   close(m.g, 0.06, 1e-9, "green excess");
   close(m.b, 0.02, 1e-9, "blue excess");
   close(m.g / (m.r + m.g + m.b), 0.6, 1e-9, "green fraction is 0.6 by construction");
   close(m.maxChannel, 0.07, 1e-9,
         "maxChannel is the raw brightest value, not the excess");
});

suite("measureTrailColour: a neutral trail is neutral", function () {
   var img = makeImage(400, 200, [0.02, 0.02, 0.02]);
   paintStreak(img, 100, 80, 320, [0.05, 0.05, 0.05]);
   var m = tc.measureTrailColour(img.sampler, candidateFor(80, 320, 100, 8),
                                 8, 8, 400, 200, null);
   close(m.g / (m.r + m.g + m.b), 1 / 3, 1e-9,
         "an equal-channel trail comes out at exactly a third");
});

suite("measureTrailColour: a coloured background does not tint the trail", function () {
   // The camera's own bias is in the background too, and it is the trail's
   // excess over the sky that carries the information.
   var img = makeImage(400, 200, [0.01, 0.03, 0.01]);
   paintStreak(img, 100, 80, 320, [0.03, 0.05, 0.03]);
   var m = tc.measureTrailColour(img.sampler, candidateFor(80, 320, 100, 8),
                                 8, 8, 400, 200, null);
   close(m.g / (m.r + m.g + m.b), 1 / 3, 1e-9,
         "a green sky under a neutral trail still reads as neutral");
});

suite("measureTrailColour: the walk finds a trail the axis misses", function () {
   // The axis comes from moments on the 1/8 field and is off by up to a dozen
   // pixels (7.1.11), so the measurement walks across to find the light. Here
   // the candidate claims row 100 and the trail is really on row 104.
   var img = makeImage(400, 200, [0.01, 0.01, 0.01]);
   paintStreak(img, 104, 80, 320, [0.03, 0.07, 0.03]);
   var m = tc.measureTrailColour(img.sampler, candidateFor(80, 320, 100, 8),
                                 8, 8, 400, 200, null);
   close(m.g / (m.r + m.g + m.b), 0.6, 1e-9,
         "four pixels off the claimed axis is still found");

   // Beyond the search radius the walk finds only sky, and sky minus sky is
   // zero - not a colour, and not a wrong colour. greenFraction() refuses a
   // non-positive total, so such a candidate gets no colour term at all rather
   // than a made-up one. That is the behaviour that protects a meteor the
   // measurement failed on.
   var far = makeImage(400, 200, [0.01, 0.01, 0.01]);
   paintStreak(far, 130, 80, 320, [0.03, 0.07, 0.03]);
   var mf = tc.measureTrailColour(far.sampler, candidateFor(80, 320, 100, 8),
                                  8, 8, 400, 200, null);
   close(mf.r + mf.g + mf.b, 0, 1e-9,
         "thirty pixels off is outside the search, so the excess is zero");
   ok(require("../../javascript/classifier.js").greenFraction(mf) === null,
      "and greenFraction refuses it rather than returning a third");
});

suite("measureTrailColour: nothing to measure", function () {
   var img = makeImage(400, 200, [0.01, 0.01, 0.01]);
   var dot = { x0: 10, y0: 10, x1: 10, y1: 10 };
   ok(tc.measureTrailColour(img.sampler, dot, 8, 8, 400, 200, null) === null,
      "a zero-length trail has no colour");

   var offImage = { x0: 200, y0: 200, x1: 260, y1: 200 };
   ok(tc.measureTrailColour(img.sampler, offImage, 8, 8, 400, 200, null) === null,
      "a trail entirely outside the image has none either");
});

suite("measureTrailColour: a trail running off the edge", function () {
   // Half in, half out. The samples that land outside are skipped rather than
   // clamped onto the border, which would read the same pixel repeatedly.
   var img = makeImage(400, 200, [0.01, 0.01, 0.01]);
   paintStreak(img, 100, 0, 200, [0.03, 0.07, 0.03]);
   var c = candidateFor(-200, 200, 100, 8);
   var m = tc.measureTrailColour(img.sampler, c, 8, 8, 400, 200, null);
   ok(m !== null, "there is still a measurement");
   ok(m.n < 61, "fewer than every sample contributed (got " + m.n + ")");
});

suite("measureTrailColour: options are honoured", function () {
   var img = makeImage(400, 200, [0.01, 0.01, 0.01]);
   paintStreak(img, 104, 80, 320, [0.03, 0.07, 0.03]);
   var c = candidateFor(80, 320, 100, 8);

   var tight = tc.measureTrailColour(img.sampler, c, 8, 8, 400, 200,
                                     { searchRadius: 1 });
   close(tight.r + tight.g + tight.b, 0, 1e-9,
         "a search radius of one cannot reach a trail four pixels away");

   var few = tc.measureTrailColour(img.sampler, c, 8, 8, 400, 200,
                                   { samplesAlong: 10 });
   ok(few.n === 11, "eleven points for ten intervals (got " + few.n + ")");
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
