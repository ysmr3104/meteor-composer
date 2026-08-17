//============================================================================
// composition.js - Adding a meteor's light to the master, and nothing else
//
// Pure JavaScript, no PJSR dependency. Stage 4 of docs/requirements.md 7.3.
//
// The rule the whole stage rests on:
//
//   residual = sub - fit(master -> sub)
//   result   = master + residual * mask
//
// Not a lighten blend. A single sub-frame is far noisier than a master built
// from hundreds of them, so taking the brighter of the two inside the mask
// would take the sub's noise almost everywhere the meteor is not exactly, and
// every meteor would sit in a visible patch of grain. Subtracting a fitted
// master leaves only what the sub has that the master does not - the meteor -
// and adds that. The background stays the master's.
//
// The fit matters as much as the subtraction. A sub and a master differ in
// exposure depth, sky brightness and transparency, so subtracting the master
// raw would leave a constant offset that the mask would then paint into the
// result as a rectangle of altered sky. A per-channel linear fit removes
// exactly that.
//
// Terminology is Composition, never Integration (requirements.md 7.3): this
// selects light from one frame, it does not combine many statistically.
//============================================================================

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

// Fit the master to the sub over the region that will be composited, but
// EXCLUDING the trail itself.
//
// Including it would be self-defeating: the fit would partly absorb the
// meteor, and the residual - which is the meteor - would come out smaller
// than it is. `mask` marks the trail; samples where it is above
// `excludeAbove` are left out of the fit and the surrounding sky decides the
// relationship.
function fitMasterToSub(master, sub, mask, excludeAbove) {
   var threshold = excludeAbove === undefined ? 0 : excludeAbove;
   var x = [], y = [];
   for (var i = 0; i < mask.length; ++i) {
      if (mask[i] > threshold) {
         continue;
      }
      x.push(master[i]);
      y.push(sub[i]);
   }
   return linearFit(x, y);
}

// The light the sub has that the fitted master does not.
//
// Negative values are kept rather than clipped. Clipping here would bias the
// residual upward everywhere the sub happens to be darker than the master -
// which is half of the noise - and that bias, multiplied by the mask and
// added, would lift the sky inside every mask by a visible amount.
function residual(master, sub, fit) {
   var out = new Float32Array(master.length);
   for (var i = 0; i < master.length; ++i) {
      out[i] = sub[i] - (fit.scale * master[i] + fit.offset);
   }
   return out;
}

// master + residual * mask.
function composite(master, residualData, mask) {
   var out = new Float32Array(master.length);
   for (var i = 0; i < master.length; ++i) {
      out[i] = master[i] + residualData[i] * mask[i];
   }
   return out;
}

// The whole of Stage 4 for one channel of one sub-frame.
//
// Returns the composited channel plus what was done to get there, because a
// fit whose scale is nowhere near 1 means the two frames were not comparable
// and the result should not be trusted silently.
function composeChannel(master, sub, mask, options) {
   var opt = options || {};
   var fit = fitMasterToSub(master, sub, mask,
                            opt.fitExcludeAbove === undefined ? 0 : opt.fitExcludeAbove);
   var res = residual(master, sub, fit);
   var out = composite(master, res, mask);

   var peak = 0;
   var addedEnergy = 0;
   for (var i = 0; i < mask.length; ++i) {
      var added = res[i] * mask[i];
      addedEnergy += added;
      if (added > peak) {
         peak = added;
      }
   }
   return { data: out, fit: fit, peakAdded: peak, addedEnergy: addedEnergy };
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

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      linearFit: linearFit,
      fitMasterToSub: fitMasterToSub,
      residual: residual,
      composite: composite,
      composeChannel: composeChannel,
      fitIsPlausible: fitIsPlausible
   };
}
