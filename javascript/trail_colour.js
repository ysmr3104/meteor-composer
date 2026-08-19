//============================================================================
// trail_colour.js - Reading a candidate's colour off the frame
//
// Pure JavaScript, no PJSR. The caller supplies a sampler function, so the
// geometry - walking the trail, finding its brightest point across, taking the
// background from both sides - can be tested without an image
// (docs/tests.md 2).
//
// Why this exists at all: green fraction was measured on the 2026-08-12 session
// (docs/requirements.md 6.1.0) and separates meteors from everything else
// better than any other single feature available - balanced accuracy 0.801,
// against 0.540 for elongation, which detection leans on. The classifier has
// carried the term since it was measured. Nothing ever supplied the value, so
// it has never done anything.
//============================================================================

var DEFAULT_COLOUR_OPTIONS = {
   // Points along the trail. Sixty is what the measurement in 6.1.0 used, and
   // it is generous: the longest labelled trail is about 100 samples of the 1/8
   // field, so roughly 800 full-resolution pixels.
   samplesAlong: 60,

   // How far to look across the trail for its brightest point, in
   // full-resolution pixels. The trail's axis comes from moments on the 1/8
   // field and is off by up to a dozen pixels (7.1.11), so the walk has to be
   // wide enough to find the light rather than assume where it is.
   searchRadius: 6,

   // Where the background is read, either side of the trail. Far enough to
   // clear the trail's own wings - light was measured out to about 20 px from
   // the axis (7.1.10) - without reaching into a neighbouring star.
   backgroundOffset: 24
};

// Sample centre in image coordinates. The detection field is a reduction, so a
// sample covers `scale` pixels and its centre sits half a pixel in.
function sampleCentreToImagePosition(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

function clampTo(v, lo, hi) {
   return v < lo ? lo : (v > hi ? hi : v);
}

// Read one candidate's colour.
//
// `sampler` is sampler(x, y, channel) -> Number, with integer coordinates
// inside the image. `width` and `height` are the image's, in pixels.
//
// Returns per-channel means over the trail with the local background already
// subtracted, the values at the brightest point, and how close that point came
// to clipping. Returns null when there is nothing to measure - a zero-length
// trail, or every sample outside the image.
//
// Negative means are possible on a faint trail and are left alone rather than
// clipped: clipping would hide how noisy the measurement is, and
// greenFraction() already refuses a non-positive total.
function measureTrailColour(sampler, candidate, scaleX, scaleY, width, height, options) {
   var opt = mergeColourDefaults(options);

   var x0 = sampleCentreToImagePosition(candidate.x0, scaleX);
   var y0 = sampleCentreToImagePosition(candidate.y0, scaleY);
   var x1 = sampleCentreToImagePosition(candidate.x1, scaleX);
   var y1 = sampleCentreToImagePosition(candidate.y1, scaleY);

   var dx = x1 - x0, dy = y1 - y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   if (!(len >= 1)) {
      return null;
   }
   var ux = dx / len, uy = dy / len;
   var px = -uy, py = ux;      // unit perpendicular

   var sumR = 0, sumG = 0, sumB = 0;
   var bgR = 0, bgG = 0, bgB = 0;
   var n = 0;
   var peakLum = -Infinity;
   var peakR = 0, peakG = 0, peakB = 0;
   var maxChannel = 0;

   for (var s = 0; s <= opt.samplesAlong; ++s) {
      var f = s / opt.samplesAlong;
      var cx = x0 + dx * f;
      var cy = y0 + dy * f;

      // Across the trail, keeping the brightest point found.
      var bestLum = -Infinity, bestX = -1, bestY = -1;
      for (var r = -opt.searchRadius; r <= opt.searchRadius; ++r) {
         var sx = Math.round(cx + px * r);
         var sy = Math.round(cy + py * r);
         if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
            continue;
         }
         var lum = sampler(sx, sy, 0) + sampler(sx, sy, 1) + sampler(sx, sy, 2);
         if (lum > bestLum) {
            bestLum = lum;
            bestX = sx;
            bestY = sy;
         }
      }
      if (bestX < 0) {
         continue;
      }

      // Background from both sides, averaged, so a gradient across the trail
      // does not bias the result.
      var b1x = clampTo(Math.round(cx + px * opt.backgroundOffset), 0, width - 1);
      var b1y = clampTo(Math.round(cy + py * opt.backgroundOffset), 0, height - 1);
      var b2x = clampTo(Math.round(cx - px * opt.backgroundOffset), 0, width - 1);
      var b2y = clampTo(Math.round(cy - py * opt.backgroundOffset), 0, height - 1);

      var tR = sampler(bestX, bestY, 0);
      var tG = sampler(bestX, bestY, 1);
      var tB = sampler(bestX, bestY, 2);

      var kR = (sampler(b1x, b1y, 0) + sampler(b2x, b2y, 0)) / 2;
      var kG = (sampler(b1x, b1y, 1) + sampler(b2x, b2y, 1)) / 2;
      var kB = (sampler(b1x, b1y, 2) + sampler(b2x, b2y, 2)) / 2;

      sumR += tR; sumG += tG; sumB += tB;
      bgR += kR; bgG += kG; bgB += kB;
      ++n;

      if (bestLum > peakLum) {
         peakLum = bestLum;
         peakR = tR - kR;
         peakG = tG - kG;
         peakB = tB - kB;
      }
      var m = Math.max(tR, Math.max(tG, tB));
      if (m > maxChannel) {
         maxChannel = m;
      }
   }

   if (n === 0) {
      return null;
   }

   return {
      n: n,
      r: (sumR - bgR) / n,
      g: (sumG - bgG) / n,
      b: (sumB - bgB) / n,
      peakR: peakR, peakG: peakG, peakB: peakB,
      // How close the brightest sample came to clipping. Recorded because the
      // saturation hypothesis in 6.1.0 turns on it and could not be tested on
      // that data - nothing there came near 1.
      maxChannel: maxChannel
   };
}

function mergeColourDefaults(options) {
   var out = {};
   for (var key in DEFAULT_COLOUR_OPTIONS) {
      out[key] = DEFAULT_COLOUR_OPTIONS[key];
   }
   if (options) {
      for (key in options) {
         if (options[key] !== undefined) {
            out[key] = options[key];
         }
      }
   }
   return out;
}

if (typeof module !== "undefined") {
   module.exports = {
      DEFAULT_COLOUR_OPTIONS: DEFAULT_COLOUR_OPTIONS,
      measureTrailColour: measureTrailColour,
      sampleCentreToImagePosition: sampleCentreToImagePosition
   };
}
