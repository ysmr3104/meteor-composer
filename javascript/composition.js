//============================================================================
// composition.js - Adding a meteor's light to the master, and nothing else
//
// Pure JavaScript, no PJSR dependency. Stage 4 of docs/requirements.md 7.3.
//
// The rule:
//
//   fit      = linear fit of master to sub, over the sky outside the corridors
//   light    = sub - fit(master) - localBackground        , clipped at zero
//   mask     = where that light stands above the noise, inside the corridor
//   result   = master + max over frames of ( light * mask )
//
// Three properties of that formula were each paid for by a defect:
//
//   Clipped at zero, so the result can never come out darker than the master.
//   This is the lighten blend an operator expects - "the meteor is laid on
//   top" - and it is what the earlier signed version failed to be. The cost is
//   a bias: half of the residual noise is positive and survives the clip,
//   lifting the masked sky by sigma/sqrt(2*pi), about 0.4 sigma. Measured
//   against this data that is 7e-5 against a master noise of 2.1e-4, so it
//   sits at a third of the noise the master already has. That measurement is
//   what makes the clip affordable; without it the mask edge would be traded
//   for a mask-shaped step.
//
//   Minus a local background, because a single linear fit over 24 million
//   pixels cannot follow a local difference in sky level between a sub and a
//   master, and whatever it leaves behind is painted into the result in the
//   shape of the mask. Measured per trail, that leftover reached 1.9e-4 -
//   comparable with the master's own noise - and up to 3.2e-3 on the one frame
//   whose fit is known to be broken. The clip hides it when it is negative and
//   paints it when it is positive, so it has to be removed rather than
//   tolerated.
//
//   Max over frames, and every frame fitted against the SAME pristine master.
//   Accumulating instead - compositing one frame into the master and fitting
//   the next against the result - digs a hole wherever two masks overlap: the
//   second frame has no meteor where the first one's is, so its residual there
//   is the first one's light with a minus sign, and with a fit scale of 1.1
//   that subtracts more than was added. Meteors that cross an exposure
//   boundary produce exactly that overlap, and they came out with a black
//   gouge along the trail. Four overlapping pairs were measured in a single
//   night's 31 accepted meteors, three of them within 10 pixels.
//
// Terminology is Composition, never Integration (requirements.md 7.3): this
// selects light from one frame, it does not combine many statistically.
//
// The mask is no longer a shape laid over the light but a description of it.
// A capsule around the detected endpoints had to be made wide to cover the
// trail at all, because those endpoints come from the 1/8 detection field and
// the axis they define was measured to miss the real trail by up to 12 px. A
// wide mask hides that; a narrow one would have missed eight of thirty-one
// meteors outright. Building the mask from the residual removes the dependence
// on the axis being right - see trail_mask.js, which does that part.
//
// Geometry lives in trail_mask.js. Everything else here works on plain arrays
// plus a rectangle, and the single point where the two meet is resolved
// lazily, so that the #include order cannot matter.
//============================================================================

var DEFAULT_COMPOSE_OPTIONS = {
   // Sample every nth pixel in each direction when fitting. Two coefficients
   // do not need 24 million samples, and a stride of 7 still leaves close to
   // half a million. Measured: the full-pixel fit took 3.8 s per frame against
   // 1.1 s for the strided one, and both gave the same scale to three decimals.
   fitStride: 7,

   // Width of the ring outside the mask used to measure the local sky, in
   // pixels. It has to be wide enough to average the noise down well below the
   // level error it is measuring, and close enough that it is still the same
   // sky. The trail's light is below a tenth of the noise by 20 px from the
   // axis (measured), which is where the mask now ends, so the ring starts
   // clear of the meteor.
   ringWidth: 24,

   // Stride within the ring. The ring holds tens of thousands of pixels and
   // the median of every other one is the same number.
   ringStride: 2,

   // Whether to remove the local sky level before adding. Off is the honest
   // way to reproduce the earlier behaviour when comparing.
   removeLocalBackground: true
};

// Fit `source` to `reference` as reference ~= scale * source + offset, by
// least squares.
//
// Both are plain arrays of the same length. Samples where either side is
// non-finite are skipped, so a frame with undefined border pixels does not
// poison the fit.
//
// This is the same relationship PixInsight's LinearFit computes. It is done
// here rather than by calling the process because it has to run on the
// samples that are actually being composited, and because a fit is a handful
// of sums that can be tested, whereas a process invocation cannot.
function linearFit(source, reference) {
   var n = 0;
   var sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
   for (var i = 0; i < source.length; ++i) {
      var x = source[i];
      var y = reference[i];
      if (!isFinite(x) || !isFinite(y)) {
         continue;
      }
      ++n;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
   }
   if (n === 0) {
      return { scale: 1, offset: 0, samples: 0 };
   }
   var meanX = sumX / n;
   var meanY = sumY / n;
   var varianceX = sumXX / n - meanX * meanX;
   if (!(varianceX > 0)) {
      // A constant source carries no slope information. Matching the means is
      // the most that can honestly be said.
      return { scale: 1, offset: meanY - meanX, samples: n };
   }
   var covariance = sumXY / n - meanX * meanY;
   var scale = covariance / varianceX;
   return { scale: scale, offset: meanY - scale * meanX, samples: n };
}

// Fit the master to the sub over the whole frame, on a strided grid, skipping
// everything the masks cover.
//
// The masks have to be skipped: a fit that included the trail would partly
// absorb the meteor, and the light that is then added - which is what is left
// over - would come out smaller than it is.
function fitOnGrid(master, sub, mask, width, height, options) {
   var opt = mergeComposeOptions(options);
   var stride = opt.fitStride > 0 ? Math.floor(opt.fitStride) : 1;
   var x = [], y = [];
   for (var iy = 0; iy < height; iy += stride) {
      var row = iy * width;
      for (var ix = 0; ix < width; ix += stride) {
         var i = row + ix;
         if (mask[i] > 0) {
            continue;
         }
         x.push(master[i]);
         y.push(sub[i]);
      }
   }
   return linearFit(x, y);
}

// The sky level the fit failed to match, measured just outside one trail's
// mask.
//
// Only unmasked pixels take part, which is the point: they are pixels the
// composite will not touch, so they say what the residual is where there is
// certainly no meteor. The median rather than the mean, so that a star or a
// second trail clipping the corner of the rectangle does not move it.
function localBackground(master, sub, fit, mask, width, height, rect, options) {
   var opt = mergeComposeOptions(options);
   var ring = Math.max(0, Math.floor(opt.ringWidth));
   var stride = opt.ringStride > 0 ? Math.floor(opt.ringStride) : 1;

   var left = Math.max(0, rect.left - ring);
   var right = Math.min(width - 1, rect.right + ring);
   var top = Math.max(0, rect.top - ring);
   var bottom = Math.min(height - 1, rect.bottom + ring);

   var values = [];
   for (var y = top; y <= bottom; y += stride) {
      var row = y * width;
      for (var x = left; x <= right; x += stride) {
         var i = row + x;
         if (mask[i] > 0) {
            continue;
         }
         var v = sub[i] - (fit.scale * master[i] + fit.offset);
         if (isFinite(v)) {
            values.push(v);
         }
      }
   }
   if (values.length === 0) {
      return { level: 0, sigma: 0, samples: 0 };
   }
   values.sort(function (a, b) { return a - b; });
   var level = medianOfSorted(values);

   // Noise as a robust deviation, so that the numbers reported alongside the
   // level are not themselves set by a star in the corner.
   var deviations = [];
   for (var k = 0; k < values.length; ++k) {
      deviations.push(Math.abs(values[k] - level));
   }
   deviations.sort(function (a, b) { return a - b; });
   return {
      level: level,
      sigma: 1.4826 * medianOfSorted(deviations),
      samples: values.length
   };
}

// Add one trail's light into `added`, which accumulates over every trail of
// every frame.
//
// Nothing negative is ever written, so the composite cannot come out darker
// than the master anywhere. Contributions combine with max rather than by
// summing: where two frames of one meteor overlap, the brighter of the two is
// the meteor, whereas their sum would count the crossing twice.
function addTrailLight(master, sub, fit, maskLocal, rect, width, background, added) {
   var level = background ? background.level : 0;
   var peak = 0;
   var energy = 0;
   var pixels = 0;
   var rw = rect.right - rect.left + 1;

   for (var y = rect.top; y <= rect.bottom; ++y) {
      var row = y * width;
      var localRow = (y - rect.top) * rw - rect.left;
      for (var x = rect.left; x <= rect.right; ++x) {
         var i = row + x;
         var m = maskLocal[localRow + x];
         if (m <= 0) {
            continue;
         }
         var v = sub[i] - (fit.scale * master[i] + fit.offset) - level;
         if (!(v > 0)) {
            continue;
         }
         var a = v * m;
         if (a > added[i]) {
            energy += a - added[i];
            added[i] = a;
            ++pixels;
            if (a > peak) {
               peak = a;
            }
         }
      }
   }
   return { peak: peak, energy: energy, pixels: pixels };
}

// The residual over one rectangle, averaged across the channels, with each
// channel's local sky removed.
//
// Averaged because there is one mask, not three: a meteor is in the same place
// in every channel, and combining them first gives the mask a third of the
// noise to work against. The light that is finally ADDED is still each
// channel's own - only the decision about where is shared.
function frameLight(masterChannels, subChannels, fits, backgrounds, rect, width) {
   var channels = masterChannels.length;
   var rw = rect.right - rect.left + 1;
   var rh = rect.bottom - rect.top + 1;
   var light = new Float32Array(rw * rh);
   var varianceSum = 0;

   for (var ch = 0; ch < channels; ++ch) {
      var fit = fits[ch];
      var level = backgrounds[ch].level;
      var master = masterChannels[ch];
      var sub = subChannels[ch];
      for (var y = 0; y < rh; ++y) {
         var row = (rect.top + y) * width + rect.left;
         var localRow = y * rw;
         for (var x = 0; x < rw; ++x) {
            light[localRow + x] +=
               (sub[row + x] - (fit.scale * master[row + x] + fit.offset) - level)
               / channels;
         }
      }
      varianceSum += backgrounds[ch].sigma * backgrounds[ch].sigma;
   }

   // Averaging N channels of independent noise divides the deviation by N,
   // and the channels do not share a noise level, so the deviations add in
   // quadrature rather than being averaged.
   return { light: light, sigma: Math.sqrt(varianceSum) / channels,
            width: rw, height: rh };
}

// Everything Stage 4 does for one frame, given plain arrays.
//
// `corridorMask` covers the search corridor around every trail. It is not the
// mask that is composited: it keeps the trails out of the linear fit and out
// of the local-background ring. The mask that IS composited is built here,
// per trail, from the light.
//
// `rects` are the corridor bounds, one per trail. `added` is the accumulator,
// one array per channel, shared across every frame in the composite;
// `maskOut` accumulates the masks the same way, for the artifact.
//
// The fits for every channel are computed and checked BEFORE anything is
// written. A frame that does not match the master must leave no trace at all:
// writing two channels and then rejecting the third would produce a colour
// cast that looks like a bug in the mask.
function composeFrame(masterChannels, subChannels, corridorMask, width, height,
                     trails, rects, added, maskOut, options) {
   var channels = masterChannels.length;
   var fits = [];
   var ch;

   for (ch = 0; ch < channels; ++ch) {
      fits.push(fitOnGrid(masterChannels[ch], subChannels[ch], corridorMask,
                          width, height, options));
      var check = fitIsPlausible(fits[ch], options);
      if (!check.ok) {
         return { written: false, fits: fits, reason: check.reason,
                  channel: ch, trails: [] };
      }
   }

   var opt = mergeComposeOptions(options);
   var geometry = trailMaskFunctions();
   var report = [];

   for (var t = 0; t < rects.length; ++t) {
      var rect = rects[t];
      var backgrounds = [];
      for (ch = 0; ch < channels; ++ch) {
         backgrounds.push(opt.removeLocalBackground
            ? localBackground(masterChannels[ch], subChannels[ch], fits[ch],
                              corridorMask, width, height, rect, options)
            : { level: 0, sigma: 0, samples: 0 });
      }

      var combined = frameLight(masterChannels, subChannels, fits, backgrounds,
                                rect, width);
      var maskLocal = geometry.renderSignalMask(combined.light, rect, trails[t],
                                                combined.sigma, options);

      var perChannel = [];
      for (ch = 0; ch < channels; ++ch) {
         var outcome = addTrailLight(masterChannels[ch], subChannels[ch], fits[ch],
                                     maskLocal, rect, width, backgrounds[ch],
                                     added[ch]);
         perChannel.push({ background: backgrounds[ch], peak: outcome.peak,
                           energy: outcome.energy, pixels: outcome.pixels });
      }

      if (maskOut) {
         mergeMaskInto(maskOut, width, maskLocal, rect);
      }

      report.push({ channels: perChannel, sigma: combined.sigma,
                    coverage: geometry.signalMaskCoverage(maskLocal, rect) });
   }

   return { written: true, fits: fits, reason: null, channel: -1, trails: report };
}

// Place a rect-local mask into the frame-sized accumulator, keeping the larger
// value where they overlap - the same rule the light itself accumulates by.
function mergeMaskInto(maskOut, width, maskLocal, rect) {
   var rw = rect.right - rect.left + 1;
   for (var y = rect.top; y <= rect.bottom; ++y) {
      var row = y * width;
      var localRow = (y - rect.top) * rw - rect.left;
      for (var x = rect.left; x <= rect.right; ++x) {
         var v = maskLocal[localRow + x];
         if (v > maskOut[row + x]) {
            maskOut[row + x] = v;
         }
      }
   }
}

// master + added. A separate step because the accumulator is finished only
// once every frame has contributed.
function applyAdded(master, added) {
   var out = new Float32Array(master.length);
   for (var i = 0; i < master.length; ++i) {
      out[i] = master[i] + added[i];
   }
   return out;
}

// Whether a fit looks trustworthy.
//
// A sub and a master of the same target through the same optics should differ
// by roughly a constant factor. A scale far from 1 means something else is
// going on - the wrong master, a different filter, a frame from another
// session - and compositing anyway would produce a result that looks
// plausible and is wrong.
function fitIsPlausible(fit, options) {
   var opt = options || {};
   var minScale = opt.minScale === undefined ? 0.2 : opt.minScale;
   var maxScale = opt.maxScale === undefined ? 5.0 : opt.maxScale;
   var minSamples = opt.minSamples === undefined ? 100 : opt.minSamples;

   if (fit.samples < minSamples) {
      return { ok: false, reason: "only " + fit.samples + " samples outside the mask" };
   }
   if (!(fit.scale >= minScale && fit.scale <= maxScale)) {
      return { ok: false,
               reason: "fit scale " + fit.scale.toFixed(3)
                     + " is outside " + minScale + " to " + maxScale
                     + " - is this the right master?" };
   }
   return { ok: true, reason: null };
}

// --- Utility ----------------------------------------------------------------

// trail_mask.js supplies the geometry, and this is the one place the two
// modules meet. Under #include they share a single global scope and the
// functions are simply there; under Node each file is its own module, so it is
// required instead. Resolved on first use rather than at load, so that the
// #include order cannot matter.
var _trailMaskModule = null;

function trailMaskFunctions() {
   if (_trailMaskModule === null) {
      _trailMaskModule = (typeof renderSignalMask === "function")
         ? { renderSignalMask: renderSignalMask,
             signalMaskCoverage: signalMaskCoverage }
         : require("./trail_mask.js");
   }
   return _trailMaskModule;
}

function medianOfSorted(sorted) {
   if (sorted.length === 0) {
      return 0;
   }
   var mid = sorted.length >> 1;
   return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mergeComposeOptions(options) {
   if (options && options.__composeMerged) {
      return options;
   }
   var out = { __composeMerged: true };
   for (var k in DEFAULT_COMPOSE_OPTIONS) {
      out[k] = DEFAULT_COMPOSE_OPTIONS[k];
   }
   if (options) {
      for (var j in options) {
         if (options[j] !== undefined) {
            out[j] = options[j];
         }
      }
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      DEFAULT_COMPOSE_OPTIONS: DEFAULT_COMPOSE_OPTIONS,
      linearFit: linearFit,
      fitOnGrid: fitOnGrid,
      localBackground: localBackground,
      addTrailLight: addTrailLight,
      composeFrame: composeFrame,
      frameLight: frameLight,
      mergeMaskInto: mergeMaskInto,
      applyAdded: applyAdded,
      fitIsPlausible: fitIsPlausible
   };
}
