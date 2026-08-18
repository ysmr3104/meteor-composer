//============================================================================
// test_detection_core.js - Small tests for the pure detection core
//
// Run: node tests/ut/test_detection_core.js
//
// Every expected value here is derived independently of the implementation.
// Calling the production moment code to produce an expectation would be a
// self-fulfilling test that cannot detect a bug (docs/tests.md 3-2).
//============================================================================

var core = require("../../javascript/detection_core.js");
var syn = require("../fixtures/synthetic.js");

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
// Moments
//
// Derivation used for the expectations, independent of the implementation:
//
//   For a uniform w x h rectangle sampled on an integer grid, the variance
//   along each axis is that of N equally spaced values: (N^2 - 1)/12.
//   Sheppard's correction adds 1/12, recovering the continuous N^2/12.
//
//   With the correction:  m20 = w^2/12, m02 = h^2/12, m11 = 0
//                         elongation = sqrt(m20/m02) = w/h   (for w >= h)
//   Without it:           elongation = sqrt((w^2-1)/(h^2-1))
//----------------------------------------------------------------------------

suite("computeMoments: rectangle with Sheppard's correction", function () {
   var cases = [
      { w: 40, h: 2 },
      { w: 60, h: 3 },
      { w: 10, h: 10 },
      { w: 100, h: 4 }
   ];
   for (var i = 0; i < cases.length; ++i) {
      var w = cases[i].w, h = cases[i].h;
      var m = core.computeMoments(syn.rectanglePoints(w, h), true);
      close(m.m20, w * w / 12, 1e-9, "m20 of " + w + "x" + h + " rectangle");
      close(m.m02, h * h / 12, 1e-9, "m02 of " + w + "x" + h + " rectangle");
      close(m.m11, 0, 1e-9, "m11 of " + w + "x" + h + " rectangle");
      close(m.elongation, w / h, 1e-9, "elongation of " + w + "x" + h + " rectangle");
      close(m.angle, 0, 1e-9, "angle of " + w + "x" + h + " rectangle");
      close(m.cx, (w - 1) / 2, 1e-9, "cx of " + w + "x" + h + " rectangle");
      close(m.cy, (h - 1) / 2, 1e-9, "cy of " + w + "x" + h + " rectangle");
   }
});

suite("computeMoments: rectangle without correction matches discrete variance", function () {
   var w = 40, h = 2;
   var m = core.computeMoments(syn.rectanglePoints(w, h), false);
   close(m.m20, (w * w - 1) / 12, 1e-9, "uncorrected m20");
   close(m.m02, (h * h - 1) / 12, 1e-9, "uncorrected m02");
   close(m.elongation, Math.sqrt((w * w - 1) / (h * h - 1)), 1e-9, "uncorrected elongation");
});

suite("computeMoments: a single pixel is not degenerate", function () {
   // Without Sheppard's correction both moments are zero and the ratio is
   // undefined. The correction must keep this finite and round.
   var m = core.computeMoments([{ x: 5, y: 7, w: 1 }], true);
   close(m.elongation, 1, 1e-9, "single pixel elongation is 1");
   close(m.cx, 5, 1e-12, "single pixel cx");
   close(m.cy, 7, 1e-12, "single pixel cy");
});

suite("computeMoments: a one-pixel-wide line stays finite", function () {
   // 50 x 1. Corrected: m20 = 50^2/12, m02 = 1/12 -> elongation = 50.
   var m = core.computeMoments(syn.rectanglePoints(50, 1), true);
   ok(isFinite(m.elongation), "elongation of a 1px-wide line is finite");
   close(m.elongation, 50, 1e-9, "elongation of a 50x1 line");
});

suite("computeMoments: rotation preserves elongation and reports the angle", function () {
   // Rotating exact coordinates loses no information, so elongation must be
   // exactly preserved. Sheppard's correction is only valid for axis-aligned
   // binning, so it is disabled on both sides of the comparison.
   var base = syn.rectanglePoints(40, 3);
   var reference = core.computeMoments(base, false);

   var angles = [0, 15, 30, 45, 60, 90, 120, 170];
   for (var i = 0; i < angles.length; ++i) {
      var deg = angles[i];
      var rotated = core.computeMoments(syn.rotatePoints(base, deg), false);
      close(rotated.elongation, reference.elongation, 1e-9,
            "elongation preserved under " + deg + " degree rotation");
      var expected = deg % 180;
      var diff = Math.abs(rotated.angle - expected);
      if (diff > 90) {
         diff = 180 - diff;
      }
      ok(diff < 1e-6, "angle after " + deg + " degree rotation (got " + rotated.angle + ")");
   }
});

suite("computeMoments: empty input returns null", function () {
   ok(core.computeMoments([], true) === null, "empty point set returns null");
});

//----------------------------------------------------------------------------
// Endpoints
//----------------------------------------------------------------------------

suite("computeEndpoints: horizontal bar", function () {
   var pts = syn.rectanglePoints(40, 2);
   var m = core.computeMoments(pts, true);
   var e = core.computeEndpoints(pts, m);
   // Extreme projections onto the major axis span x = 0 .. 39.
   close(e.length, 39, 1e-9, "length of a 40-wide bar is 39 sample spacings");
   ok(Math.min(e.x0, e.x1) === 0, "one endpoint at x=0");
   ok(Math.max(e.x0, e.x1) === 39, "other endpoint at x=39");
});

//----------------------------------------------------------------------------
// Bounding box
//
// Needed by the screening UI to draw a numbered box per candidate and to
// hit-test clicks.
//----------------------------------------------------------------------------

suite("computeBoundingBox: axis-aligned extent", function () {
   var pts = syn.rectanglePoints(40, 3);
   var b = core.computeBoundingBox(pts);
   ok(b.left === 0 && b.top === 0, "origin corner");
   ok(b.right === 39 && b.bottom === 2, "far corner");
   ok(b.width === 40 && b.height === 3, "inclusive width and height");
});

suite("computeBoundingBox: a diagonal trail gets a much larger box", function () {
   // The axis-aligned box of a diagonal trail covers far more area than the
   // trail itself. This was the reason to consider an oriented box for the
   // overlay, but measurement on real data showed no overlapping candidate
   // pairs at all (0 of 162), so the axis-aligned box is adequate. The
   // property is kept under test because it is the thing that would bite if
   // candidate density ever rises.
   var pts = [];
   for (var i = 0; i < 100; ++i) {
      pts.push({ x: i, y: i, w: 1 });
   }
   var b = core.computeBoundingBox(pts);
   ok(b.width === 100 && b.height === 100, "box is 100x100 for a 100-pixel diagonal");
   ok(b.width * b.height === 10000, "box area is 100x the pixel count");
});

suite("computeBoundingBox: empty input returns null", function () {
   ok(core.computeBoundingBox([]) === null, "no points, no box");
});

suite("detectCandidates: candidates carry a bounding box", function () {
   var f = syn.makeField(300, 200, 0);
   syn.addGaussianNoise(f, 0.002, 77);
   syn.addLine(f, 30, 40, 260, 160, 2.0, 0.06);
   var r = core.detectCandidates(f, { k: 5, minPixels: 20, minElongation: 6 });
   ok(r.candidates.length >= 1, "a candidate was found");
   if (r.candidates.length > 0) {
      var b = r.candidates[0].bbox;
      ok(b !== null && b !== undefined, "bbox is present");
      ok(b.left >= 0 && b.top >= 0, "box is inside the frame");
      ok(b.right < f.width && b.bottom < f.height, "box does not exceed the frame");
      ok(b.width > 200, "box spans most of the trail's horizontal extent");
   }
});

//----------------------------------------------------------------------------
// Robust statistics
//
// For a symmetric distribution, sigma = 1.4826 * MAD. The expectations below
// use hand-computable inputs rather than generated noise.
//----------------------------------------------------------------------------

suite("medianOf", function () {
   close(core.medianOf([3, 1, 2]), 2, 1e-12, "median of odd-length set");
   close(core.medianOf([4, 1, 3, 2]), 2.5, 1e-12, "median of even-length set");
   close(core.medianOf([]), 0, 1e-12, "median of empty set is 0");
});

suite("mad: known input", function () {
   // Values 1..9. Median 5. Deviations 4,3,2,1,0,1,2,3,4 -> median 2.
   var r = core.mad([1, 2, 3, 4, 5, 6, 7, 8, 9], null);
   close(r.median, 5, 1e-12, "median");
   close(r.mad, 2, 1e-12, "MAD");
   close(r.sigma, 2 * 1.4826, 1e-12, "sigma = 1.4826 * MAD");
});

suite("mad: resists a bright outlier population", function () {
   // A meteor occupies a small fraction of the frame. Adding a few very large
   // values must not move the MAD, which is the property the threshold relies
   // on.
   var clean = [];
   for (var i = 0; i < 1000; ++i) {
      clean.push((i % 11) - 5);
   }
   var contaminated = clean.slice();
   for (var j = 0; j < 20; ++j) {
      contaminated.push(10000);
   }
   var a = core.mad(clean, null);
   var b = core.mad(contaminated, null);
   close(b.mad, a.mad, 1e-9, "MAD is unchanged by 2% extreme outliers");
});

suite("mad: mask excludes samples", function () {
   // Without the mask the huge values dominate the median entirely.
   var data = [1, 1, 1, 1, 1000, 1000, 1000, 1000];
   var mask = new Uint8Array([1, 1, 1, 1, 0, 0, 0, 0]);
   var masked = core.mad(data, mask);
   var unmasked = core.mad(data, null);
   close(masked.median, 1, 1e-12, "masked median ignores the excluded half");
   ok(unmasked.median > 100, "unmasked median is dragged up (sanity check)");
});

//----------------------------------------------------------------------------
// Downsample / upsample / background removal
//----------------------------------------------------------------------------

suite("downsample: mean of a constant field is the constant", function () {
   var f = syn.makeField(16, 16, 0);
   syn.addLinearGradient(f, 0, 0, 7);
   var d = core.downsample(f, 4, "mean");
   ok(d.width === 4 && d.height === 4, "dimensions 16/4 = 4");
   for (var i = 0; i < d.data.length; ++i) {
      close(d.data[i], 7, 1e-12, "constant preserved at index " + i);
   }
});

suite("downsample: median rejects a thin line, mean does not", function () {
   var f = syn.makeField(32, 32, 0);
   // One-pixel-wide horizontal line: 1 of 8 rows in each 8x8 block.
   syn.addRect(f, 0, 12, 32, 1, 100);

   var med = core.downsample(f, 8, "median");
   var avg = core.downsample(f, 8, "mean");

   // Block row 1 covers y = 8..15 and contains the line.
   var medVal = med.data[1 * med.width + 0];
   var avgVal = avg.data[1 * avg.width + 0];
   close(medVal, 0, 1e-12, "median downsample removes the line");
   close(avgVal, 100 * 8 / 64, 1e-9, "mean downsample retains the line's flux");
});

suite("downsample: handles sizes that are not multiples of the factor", function () {
   var f = syn.makeField(10, 7, 0);
   syn.addLinearGradient(f, 0, 0, 3);
   var d = core.downsample(f, 4, "mean");
   ok(d.width === 3, "ceil(10/4) = 3 columns");
   ok(d.height === 2, "ceil(7/4) = 2 rows");
   close(d.data[d.data.length - 1], 3, 1e-12, "partial edge block still averages correctly");
});

suite("upsample: round trip of a constant field", function () {
   var f = syn.makeField(4, 4, 0);
   syn.addLinearGradient(f, 0, 0, 5);
   var u = core.upsample(f, 16, 16);
   ok(u.width === 16 && u.height === 16, "dimensions");
   for (var i = 0; i < u.data.length; ++i) {
      close(u.data[i], 5, 1e-12, "constant preserved after upsample");
   }
});

suite("removeBackground: flattens a gradient", function () {
   var f = syn.makeField(64, 64, 0);
   syn.addLinearGradient(f, 100, 50, 10);
   var flat = core.removeBackground(f, 8);

   // The residual of a smooth gradient must be small compared with the
   // gradient's own amplitude. Bilinear reconstruction of a linear ramp is
   // exact except for the half-block offset at the edges, so use a bound
   // rather than zero.
   var maxAbs = 0;
   for (var i = 0; i < flat.data.length; ++i) {
      maxAbs = Math.max(maxAbs, Math.abs(flat.data[i]));
   }
   ok(maxAbs < 10, "gradient of amplitude 100 flattened to under 10 (got " + maxAbs + ")");
});

suite("removeBackground: preserves a thin line", function () {
   var f = syn.makeField(64, 64, 0);
   syn.addLinearGradient(f, 100, 50, 10);
   syn.addLine(f, 5, 30, 58, 34, 2, 80);
   var flat = core.removeBackground(f, 8);

   var maxAbs = 0;
   for (var i = 0; i < flat.data.length; ++i) {
      maxAbs = Math.max(maxAbs, flat.data[i]);
   }
   ok(maxAbs > 60, "the line survives background removal (peak " + maxAbs + ")");
});

//----------------------------------------------------------------------------
// Connected components
//----------------------------------------------------------------------------

suite("connectedComponents: counts separated blobs", function () {
   var w = 20, h = 20;
   var b = new Uint8Array(w * h);
   b[2 * w + 2] = 1;
   b[2 * w + 3] = 1;
   b[15 * w + 15] = 1;
   var r = core.connectedComponents(b, w, h, 8);
   ok(r.components.length === 2, "two components (got " + r.components.length + ")");
});

suite("connectedComponents: 8-connectivity joins a diagonal, 4 does not", function () {
   var w = 10, h = 10;
   var b = new Uint8Array(w * h);
   for (var i = 0; i < 5; ++i) {
      b[(i + 1) * w + (i + 1)] = 1;
   }
   var r8 = core.connectedComponents(b, w, h, 8);
   var r4 = core.connectedComponents(b, w, h, 4);
   ok(r8.components.length === 1, "8-connectivity yields one component");
   ok(r4.components.length === 5, "4-connectivity splits the diagonal into 5");
});

suite("connectedComponents: does not wrap across row boundaries", function () {
   var w = 10, h = 10;
   var b = new Uint8Array(w * h);
   b[3 * w + (w - 1)] = 1;   // right edge of row 3
   b[4 * w + 0] = 1;         // left edge of row 4
   // These are adjacent in the flat array but not neighbours in 2D. They are
   // however diagonal neighbours under a naive index-based implementation.
   var r = core.connectedComponents(b, w, h, 8);
   ok(r.components.length === 2, "edge pixels are not connected (got "
      + r.components.length + ")");
});

suite("connectedComponents: handles a long trail without stack overflow", function () {
   var w = 4000, h = 4;
   var b = new Uint8Array(w * h);
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         b[y * w + x] = 1;
      }
   }
   var r = core.connectedComponents(b, w, h, 8);
   ok(r.components.length === 1, "one component");
   ok(r.components[0].pixels.length === w * h, "all pixels collected");
});

//----------------------------------------------------------------------------
// End-to-end screening on synthetic frames
//----------------------------------------------------------------------------

suite("detectCandidates: finds a synthetic trail among stars and noise", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addLinearGradient(f, 0.02, 0.01, 0.1);
   syn.addStarField(f, 300, 2.5, 0.05, 12345);
   syn.addGaussianNoise(f, 0.002, 999);
   syn.addLine(f, 40, 60, 340, 220, 2.0, 0.06);

   var r = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 });
   ok(r.candidates.length >= 1, "at least one candidate (got " + r.candidates.length + ")");

   if (r.candidates.length > 0) {
      // Sort by length and inspect the longest.
      r.candidates.sort(function (a, b) { return b.length - a.length; });
      var c = r.candidates[0];
      // Expected geometry, derived from the fixture parameters alone:
      //   dx = 300, dy = 160 -> length = sqrt(300^2+160^2) = 340.0
      //   angle = atan2(160, 300) = 28.07 degrees
      var expectedLength = Math.sqrt(300 * 300 + 160 * 160);
      var expectedAngle = Math.atan2(160, 300) * 180 / Math.PI;
      close(c.length, expectedLength, 6, "trail length");
      close(c.angle, expectedAngle, 2, "trail angle");
      ok(c.elongation > 20, "trail is strongly elongated (got " + c.elongation + ")");
   }
});

suite("detectCandidates: a star field alone yields no elongated candidate", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addLinearGradient(f, 0.02, 0.01, 0.1);
   syn.addStarField(f, 300, 2.5, 0.05, 4242);
   syn.addGaussianNoise(f, 0.002, 7);

   var r = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 });
   ok(r.candidates.length === 0,
      "no false trails from stars alone (got " + r.candidates.length + ")");
});

suite("detectCandidates: mask suppresses a trail in the excluded region", function () {
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 3);
   // Trail entirely inside the bottom quarter.
   syn.addLine(f, 40, 260, 340, 280, 2.0, 0.06);

   var all = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 });
   ok(all.candidates.length >= 1, "trail is found without a mask");

   var mask = new Uint8Array(f.width * f.height);
   for (var y = 0; y < f.height; ++y) {
      for (var x = 0; x < f.width; ++x) {
         mask[y * f.width + x] = (y < 225) ? 1 : 0;
      }
   }
   var masked = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 }, mask);
   ok(masked.candidates.length === 0,
      "trail is suppressed by the mask (got " + masked.candidates.length + ")");
});

suite("detectCandidates: bright excluded region does not raise the threshold", function () {
   // This is the ordering trap from docs/requirements.md 5.4: if the mask were
   // applied after computing MAD, the bright foreground would inflate sigma and
   // hide the faint trail in the sky region.
   var f = syn.makeField(400, 300, 0);
   syn.addGaussianNoise(f, 0.002, 5);
   syn.addLine(f, 40, 60, 340, 120, 2.0, 0.02);
   // Bright, textured "landscape" confined to the bottom third. The texture
   // matters: a flat bright region would be removed by background modelling,
   // whereas real buildings and trees add structure that inflates MAD.
   syn.addRect(f, 0, 200, 400, 100, 5.0);
   syn.addGaussianNoiseRect(f, 0, 200, 400, 100, 0.5, 6);

   var mask = new Uint8Array(f.width * f.height);
   for (var y = 0; y < f.height; ++y) {
      for (var x = 0; x < f.width; ++x) {
         mask[y * f.width + x] = (y < 200) ? 1 : 0;
      }
   }
   var masked = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 }, mask);
   var unmasked = core.detectCandidates(f, { k: 5.0, minPixels: 20, minElongation: 6 });

   ok(masked.sigma < unmasked.sigma,
      "masked sigma is smaller (" + masked.sigma + " vs " + unmasked.sigma + ")");
   ok(masked.candidates.length >= 1,
      "faint trail is still detected with the mask applied (got "
      + masked.candidates.length + ")");
});

//----------------------------------------------------------------------------
// Regions with no data
//----------------------------------------------------------------------------

suite("noDataMask finds exact zeros and nothing else", function () {
   var f = syn.makeField(40, 30, 0.1);
   var i;

   // No zeros at all: nothing to exclude.
   var none = core.noDataMask(f, 1);
   ok(none.emptyCount === 0, "a full field reports nothing missing");
   ok(none.applied === false, "and the mask is not applied");

   // A strip down the left, as registration leaves when it shifts a frame.
   for (var y = 0; y < 30; ++y) {
      for (var x = 0; x < 3; ++x) {
         f.data[y * 40 + x] = 0;
      }
   }
   var m = core.noDataMask(f, 1);
   ok(m.applied === true, "a strip of zeros is recognised");
   ok(m.emptyCount === 90, "and counted (" + m.emptyCount + ")");
   ok(m.usable[15 * 40 + 0] === 0, "the strip itself is excluded");
   ok(m.usable[15 * 40 + 3] === 0,
      "and so is the column beside it, which straddles the boundary");
   ok(m.usable[15 * 40 + 4] === 1, "one column further out is kept");
   ok(m.usable[15 * 40 + 39] === 1, "and the far side of the frame is untouched");
});

suite("noDataMask does not fire on noise, or on an empty field", function () {
   // Sky noise about a subtracted background is negative half the time. An
   // earlier version tested for "not positive" and marked half of a field like
   // this as missing, which with the dilation left nothing to detect in.
   var noisy = syn.makeField(60, 40, 0);
   syn.addGaussianNoise(noisy, 0.002, 4242);
   var m = core.noDataMask(noisy, 1);
   ok(m.emptyCount < noisy.data.length / 100,
      "noise about zero is not mistaken for missing data ("
      + m.emptyCount + " of " + noisy.data.length + ")");

   // A field that is mostly empty is not a frame with holes in it. Excluding
   // nearly all of it would leave nothing to compute statistics from, and
   // doing nothing is the right answer.
   var empty = syn.makeField(50, 50, 0);
   var all = core.noDataMask(empty, 1);
   ok(all.emptyCount === 2500, "an all-zero field is all zeros");
   ok(all.applied === false, "but the mask is not applied to it");
   for (var i = 0; i < all.usable.length; ++i) {
      if (!all.usable[i]) {
         ok(false, "and nothing is excluded");
         break;
      }
   }
   ok(true, "and nothing is excluded");
});

suite("the background model ignores samples with no data", function () {
   // The defect this fixes. A median over a block straddling the edge of the
   // data lands between the sky and nothing, so subtracting it leaves the sky
   // standing above zero in a line along that edge - and a line detector finds
   // it, correctly, as a line.
   var w = 96, h = 64;
   var f = syn.makeField(w, h, 0.1);
   var x, y;
   for (y = 0; y < h; ++y) {
      for (x = 0; x < 5; ++x) {
         f.data[y * w + x] = 0;
      }
   }

   var contaminated = core.removeBackground(f, 8, null);
   var corrected = core.removeBackground(f, 8, core.noDataMask(f, 1).usable);

   // The first column of real sky, right against the boundary.
   var contaminatedEdge = 0, correctedEdge = 0;
   for (y = 0; y < h; ++y) {
      contaminatedEdge += contaminated.data[y * w + 6];
      correctedEdge += corrected.data[y * w + 6];
   }
   contaminatedEdge /= h;
   correctedEdge /= h;

   ok(contaminatedEdge > 0.02,
      "with the zeros included the sky is left standing above the background ("
      + contaminatedEdge.toFixed(4) + ")");
   ok(Math.abs(correctedEdge) < Math.abs(contaminatedEdge) / 5,
      "and excluding them removes it (" + correctedEdge.toFixed(4) + ")");
});

suite("edgeContact separates lying along the boundary from touching it", function () {
   // The distinction the whole approach rests on. A candidate NEAR an edge is
   // not suspicious: a visual meteor of the evaluation night comes within 4 px
   // of the border, and excluding a band along the edge would take the recall
   // gate with it.
   var w = 60, h = 40;
   var f = syn.makeField(w, h, 0.1);
   var x, y;
   for (y = 0; y < h; ++y) {
      for (x = 0; x < 4; ++x) {
         f.data[y * w + x] = 0;
      }
   }
   var usable = core.noDataMask(f, 1).usable;

   // The pixels come from connectedComponents, not from a list written here.
   //
   // The first version of this test built them as plain indices, which is what
   // the function was written to expect - and both were wrong. Components carry
   // {x, y, w} objects, so every pixel read as NaN, every lookup came back
   // undefined, and every candidate measured as lying entirely along the
   // boundary. Thirteen of the thirty-one ground-truth meteors were being
   // scored as artefacts and this test said nothing, because it agreed with the
   // mistake.
   //
   // Taking the pixels from the real producer is what makes it a test of the
   // interface rather than of one side's opinion of it.
   function pixelsOf(binary) {
      var cc = core.connectedComponents(binary, w, h, 8);
      ok(cc.components.length === 1,
         "the fixture is one component (" + cc.components.length + ")");
      return cc.components[0].pixels;
   }

   // Along the boundary: a vertical line in the first usable column.
   var alongBinary = new Uint8Array(w * h);
   for (y = 10; y < 30; ++y) {
      alongBinary[y * w + 5] = 1;
   }
   var along = pixelsOf(alongBinary);

   // Across it: a horizontal line starting at the same column and running away.
   var acrossBinary = new Uint8Array(w * h);
   for (x = 5; x < 45; ++x) {
      acrossBinary[20 * w + x] = 1;
   }
   var across = pixelsOf(acrossBinary);

   var alongFraction = core.edgeContact(along, usable, w, h, 2);
   var acrossFraction = core.edgeContact(across, usable, w, h, 2);

   ok(alongFraction > 0.9,
      "one that runs along the boundary is almost entirely against it ("
      + (alongFraction * 100).toFixed(0) + "%)");
   ok(acrossFraction < 0.3,
      "one that merely starts there is not (" + (acrossFraction * 100).toFixed(0) + "%)");
   ok(alongFraction > acrossFraction * 2,
      "and the two are far enough apart to put a threshold between");
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
