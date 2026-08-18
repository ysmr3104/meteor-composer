//============================================================================
// detection_core.js - Pure JavaScript detection core for MeteorComposer
//
// Everything in this file is pure: it operates on plain arrays and never
// touches PJSR. That is deliberate. The PJSR layer converts an image to
//
//   { data: Float64Array|Array, width: int, height: int }
//
// via ImageWindow.open -> getLuminance -> resample -> toMatrix -> toArray,
// and everything downstream lives here so it can be tested under Node.js.
// See docs/tests.md section 2.
//
// Runs under both PJSR and Node.js (ES5 style, var only).
//============================================================================

// --- Field helpers ---------------------------------------------------------

function makeField(width, height) {
   return {
      data: new Float64Array(width * height),
      width: width,
      height: height
   };
}

// --- Downsampling ----------------------------------------------------------

// Block reduction by an integer factor. Partial blocks at the right and bottom
// edges are handled by using whatever samples exist, so the caller does not
// have to pad.
//
// mode:
//   "mean"   flux preserving, keeps thin features visible
//   "median" rejects thin features, which is what a background model wants
function downsample(field, factor, mode, mask) {
   if (factor < 1) {
      throw new Error("downsample: factor must be >= 1");
   }
   if (factor === 1) {
      return { data: new Float64Array(field.data), width: field.width, height: field.height };
   }
   var outW = Math.max(1, Math.ceil(field.width / factor));
   var outH = Math.max(1, Math.ceil(field.height / factor));
   var out = makeField(outW, outH);
   var block = [];

   for (var by = 0; by < outH; ++by) {
      for (var bx = 0; bx < outW; ++bx) {
         var x0 = bx * factor, y0 = by * factor;
         var x1 = Math.min(x0 + factor, field.width);
         var y1 = Math.min(y0 + factor, field.height);
         var n = 0, sum = 0;
         block.length = 0;
         for (var y = y0; y < y1; ++y) {
            var row = y * field.width;
            for (var x = x0; x < x1; ++x) {
               // A masked sample takes no part. For the background model this
               // is the whole point: a block straddling the edge of the data
               // would otherwise take the median of a mixture of sky and
               // nothing, which is lower than the sky - and subtracting a
               // background that is too low leaves the sky standing above zero
               // in a line along that edge. See noDataMask.
               if (mask && !mask[row + x]) {
                  continue;
               }
               var v = field.data[row + x];
               if (mode === "median") {
                  block.push(v);
               } else {
                  sum += v;
               }
               ++n;
            }
         }
         // A block with nothing usable in it is left at zero. Nothing is
         // detected there either, so the value cannot matter; what would
         // matter is inventing one.
         out.data[by * outW + bx] = (mode === "median")
            ? (block.length > 0 ? medianOf(block) : 0)
            : (n > 0 ? sum / n : 0);
      }
   }
   return out;
}

// Bilinear expansion back to a target size. Used to turn a coarse background
// model into a full-resolution one.
function upsample(field, width, height) {
   var out = makeField(width, height);
   var sx = (width > 1) ? (field.width - 1) / (width - 1) : 0;
   var sy = (height > 1) ? (field.height - 1) / (height - 1) : 0;

   for (var y = 0; y < height; ++y) {
      var fy = y * sy;
      var y0 = Math.floor(fy);
      var y1 = Math.min(y0 + 1, field.height - 1);
      var wy = fy - y0;
      for (var x = 0; x < width; ++x) {
         var fx = x * sx;
         var x0 = Math.floor(fx);
         var x1 = Math.min(x0 + 1, field.width - 1);
         var wx = fx - x0;

         var v00 = field.data[y0 * field.width + x0];
         var v01 = field.data[y0 * field.width + x1];
         var v10 = field.data[y1 * field.width + x0];
         var v11 = field.data[y1 * field.width + x1];

         out.data[y * width + x] =
            v00 * (1 - wx) * (1 - wy) +
            v01 * wx * (1 - wy) +
            v10 * (1 - wx) * wy +
            v11 * wx * wy;
      }
   }
   return out;
}

// Flatten large-scale structure: model the background by median-reducing the
// field, expand the model back, and subtract.
//
// Median reduction is what makes this safe for our purpose. A meteor occupies
// a small fraction of any block it crosses, so it does not survive into the
// model and is therefore not subtracted away from the residual.
function removeBackground(field, factor, mask) {
   var coarse = downsample(field, factor, "median", mask);
   var model = upsample(coarse, field.width, field.height);
   var out = makeField(field.width, field.height);
   for (var i = 0; i < field.data.length; ++i) {
      out.data[i] = field.data[i] - model.data[i];
   }
   return out;
}

// --- Robust statistics -----------------------------------------------------

function medianOf(values) {
   var n = values.length;
   if (n === 0) {
      return 0;
   }
   var sorted = Array.prototype.slice.call(values);
   sorted.sort(function (a, b) { return a - b; });
   var mid = n >> 1;
   return (n % 2 === 1) ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

// Median absolute deviation. Optionally restricted to samples where
// mask[i] is truthy, so excluded regions cannot inflate the estimate.
//
// This ordering matters: applying the mask AFTER computing MAD would let a
// bright foreground raise the threshold across the whole frame and silently
// destroy sensitivity in the sky (docs/requirements.md 5.4).
function mad(data, mask) {
   var values = collect(data, mask);
   if (values.length === 0) {
      return { median: 0, mad: 0, sigma: 0 };
   }
   var med = medianOf(values);
   var deviations = new Array(values.length);
   for (var i = 0; i < values.length; ++i) {
      deviations[i] = Math.abs(values[i] - med);
   }
   var m = medianOf(deviations);
   return { median: med, mad: m, sigma: 1.4826 * m };
}

function collect(data, mask) {
   var values = [];
   for (var i = 0; i < data.length; ++i) {
      if (!mask || mask[i]) {
         values.push(data[i]);
      }
   }
   return values;
}

// --- Thresholding ----------------------------------------------------------

// Binarise at median + k*sigma, honouring an optional inclusion mask.
function threshold(field, k, mask) {
   var stats = mad(field.data, mask);
   var level = stats.median + k * stats.sigma;
   var out = new Uint8Array(field.data.length);
   for (var i = 0; i < field.data.length; ++i) {
      out[i] = ((!mask || mask[i]) && field.data[i] > level) ? 1 : 0;
   }
   return { binary: out, level: level, stats: stats };
}

// --- Connected components --------------------------------------------------

// Iterative flood fill. Recursion would blow the stack on a long trail, and a
// meteor can easily be several hundred pixels.
//
// connectivity: 4 or 8. Default 8, because a diagonal trail one pixel wide is
// disconnected under 4-connectivity.
function connectedComponents(binary, width, height, connectivity) {
   var conn = (connectivity === 4) ? 4 : 8;
   var labels = new Int32Array(width * height);
   var components = [];
   var stack = [];
   var dx8 = [-1, 0, 1, -1, 1, -1, 0, 1];
   var dy8 = [-1, -1, -1, 0, 0, 1, 1, 1];
   var dx4 = [0, -1, 1, 0];
   var dy4 = [-1, 0, 0, 1];
   var dx = (conn === 8) ? dx8 : dx4;
   var dy = (conn === 8) ? dy8 : dy4;

   for (var seed = 0; seed < binary.length; ++seed) {
      if (binary[seed] === 0 || labels[seed] !== 0) {
         continue;
      }
      var id = components.length + 1;
      var pixels = [];
      stack.length = 0;
      stack.push(seed);
      labels[seed] = id;

      while (stack.length > 0) {
         var idx = stack.pop();
         var x = idx % width;
         var y = (idx - x) / width;
         pixels.push({ x: x, y: y, w: 1 });

         for (var d = 0; d < dx.length; ++d) {
            var nx = x + dx[d], ny = y + dy[d];
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
               continue;
            }
            var nidx = ny * width + nx;
            if (binary[nidx] !== 0 && labels[nidx] === 0) {
               labels[nidx] = id;
               stack.push(nidx);
            }
         }
      }
      components.push({ id: id, pixels: pixels });
   }
   return { components: components, labels: labels };
}

// --- Moments ---------------------------------------------------------------

// Second-order central moments of a weighted point set.
//
// applySheppard corrects for the fact that pixel data is binned: the variance
// of N equally spaced integers is (N^2-1)/12 rather than the continuous
// N^2/12. Adding 1/12 to the diagonal moments recovers the continuous value,
// which
//   - makes a w x h rectangle come out at exactly w/h elongation, and
//   - keeps a one-pixel-wide line finite instead of dividing by zero.
// It is only valid for axis-aligned binning, so callers working with already
// rotated real coordinates should pass false.
function computeMoments(points, applySheppard) {
   var sheppard = (applySheppard === undefined) ? true : applySheppard;
   var n = points.length;
   if (n === 0) {
      return null;
   }

   var sw = 0, sx = 0, sy = 0;
   var i, p;
   for (i = 0; i < n; ++i) {
      p = points[i];
      var w = (p.w === undefined) ? 1 : p.w;
      sw += w;
      sx += p.x * w;
      sy += p.y * w;
   }
   if (sw === 0) {
      return null;
   }
   var cx = sx / sw, cy = sy / sw;

   var m20 = 0, m02 = 0, m11 = 0;
   for (i = 0; i < n; ++i) {
      p = points[i];
      var wi = (p.w === undefined) ? 1 : p.w;
      var ddx = p.x - cx, ddy = p.y - cy;
      m20 += wi * ddx * ddx;
      m02 += wi * ddy * ddy;
      m11 += wi * ddx * ddy;
   }
   m20 /= sw;
   m02 /= sw;
   m11 /= sw;

   if (sheppard) {
      m20 += 1 / 12;
      m02 += 1 / 12;
   }

   // Eigenvalues of [[m20, m11], [m11, m02]].
   var trace = m20 + m02;
   var diff = m20 - m02;
   var root = Math.sqrt(diff * diff + 4 * m11 * m11);
   var lambda1 = 0.5 * (trace + root);
   var lambda2 = 0.5 * (trace - root);
   if (lambda2 < 0) {
      lambda2 = 0;
   }

   var elongation = (lambda2 > 0) ? Math.sqrt(lambda1 / lambda2) : Infinity;

   // Orientation of the major axis, in degrees, measured from +x towards +y
   // and folded into [0, 180) because a line has no direction.
   var angle = 0.5 * Math.atan2(2 * m11, diff) * 180 / Math.PI;
   while (angle < 0) {
      angle += 180;
   }
   while (angle >= 180) {
      angle -= 180;
   }

   return {
      count: n,
      weight: sw,
      cx: cx,
      cy: cy,
      m20: m20,
      m02: m02,
      m11: m11,
      lambda1: lambda1,
      lambda2: lambda2,
      elongation: elongation,
      angle: angle,
      // Equivalent extents of a uniform rectangle with the same moments.
      majorLength: Math.sqrt(12 * lambda1),
      minorLength: Math.sqrt(12 * lambda2)
   };
}

// Axis-aligned bounding box of a component.
//
// Needed by the UI for click hit-testing and for the optional axis-aligned
// overlay. Note that for a diagonal trail this box is much larger than the
// trail itself, which is why the endpoints below are reported separately and
// why an oriented box (centre + angle + majorLength/minorLength) is the better
// overlay shape when candidates are crowded.
function computeBoundingBox(points) {
   if (points.length === 0) {
      return null;
   }
   var left = points[0].x, right = points[0].x;
   var top = points[0].y, bottom = points[0].y;
   for (var i = 1; i < points.length; ++i) {
      var p = points[i];
      if (p.x < left) {
         left = p.x;
      }
      if (p.x > right) {
         right = p.x;
      }
      if (p.y < top) {
         top = p.y;
      }
      if (p.y > bottom) {
         bottom = p.y;
      }
   }
   return {
      left: left, top: top, right: right, bottom: bottom,
      width: right - left + 1,
      height: bottom - top + 1
   };
}

// Endpoints of a component, taken as the extreme projections onto the major
// axis. More useful than a bounding box: a diagonal trail's bounding box
// corners are not on the trail.
function computeEndpoints(points, moments) {
   var rad = moments.angle * Math.PI / 180;
   var ux = Math.cos(rad), uy = Math.sin(rad);
   var tMin = Infinity, tMax = -Infinity;
   var pMin = null, pMax = null;

   for (var i = 0; i < points.length; ++i) {
      var p = points[i];
      var t = (p.x - moments.cx) * ux + (p.y - moments.cy) * uy;
      if (t < tMin) {
         tMin = t;
         pMin = p;
      }
      if (t > tMax) {
         tMax = t;
         pMax = p;
      }
   }
   return {
      x0: pMin.x, y0: pMin.y,
      x1: pMax.x, y1: pMax.y,
      length: tMax - tMin
   };
}

// --- Detection -------------------------------------------------------------

var DEFAULT_OPTIONS = {
   backgroundFactor: 8,   // block size of the background model
   k: 5.0,                // threshold in robust sigmas
   connectivity: 8,
   minPixels: 12,         // reject cosmic-ray hits and single hot pixels
   minElongation: 6.0,    // stars sit near 1; a meteor is tens to hundreds
   minLength: 10.0,       // in samples of the working (downsampled) field

   // Keep the samples that hold no data out of the background model and the
   // statistics. WBPP leaves them wherever registration moved a frame off the
   // canvas; see noDataMask for what including them costs.
   excludeNoData: true,

   // How far the exclusion extends past a sample with no data, in samples. One
   // covers the ring that straddles the boundary and holds a fraction of the
   // sky.
   noDataDilation: 1,

   // How close to the edge of the data a candidate's pixel counts as touching
   // it, when measuring edgeContact.
   edgeContactReach: 2
};

function mergeDetectionOptions(options) {
   var out = {};
   for (var k in DEFAULT_OPTIONS) {
      out[k] = DEFAULT_OPTIONS[k];
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

// Samples that hold no data at all.
//
// WBPP writes registered frames into a fixed canvas, so wherever the alignment
// moved a frame off that canvas there is nothing: exactly zero. On this night
// one frame in a handful carried a diagonal wedge of it covering nearly 40% of
// the field, and every frame carried a strip a few samples wide down one side.
// It is a property of the output, not a fault to be fixed upstream.
//
// It has to be kept out of two calculations.
//
// The background model, first and most importantly. A median over a block that
// straddles the edge of the data comes out between the sky and nothing, so
// subtracting it leaves the sky standing above zero along that edge - and a line
// detector then finds that edge, correctly, as a line. Six of the candidates an
// operator reported as obviously-not-meteors were exactly this: one sample wide,
// running parallel to an edge.
//
// And the robust statistics. Measured on a frame that was 38% empty, the MAD
// came out 6.50e-5 against 2.39e-5 over the sky alone - the spread between two
// populations, not the noise of either - which put the threshold 29% too high
// and made the whole frame LESS sensitive. That direction was a surprise: the
// guess had been that a dark region drags the median down and makes it
// over-sensitive. It does drag the median down, and the MAD swamps it.
//
// Returned in the same sense as the mask detectCandidates already takes: 1
// means usable. `dilate` extends it over the samples that straddle the edge,
// which hold a fraction of the sky and are not representative of either side.
function noDataMask(field, dilate) {
   var reach = dilate === undefined ? 1 : Math.max(0, Math.floor(dilate));
   var empty = new Uint8Array(field.data.length);
   var found = 0;
   var i;
   for (i = 0; i < field.data.length; ++i) {
      // EXACTLY zero, or not a number at all. Nothing weaker will do.
      //
      // "Not positive" was tried first and it is wrong: sky noise about a
      // subtracted background is negative half the time, so on a field like
      // that it marked half the samples as missing and, with the dilation,
      // left nothing to detect in. Registration writes exact zeros where the
      // canvas has no frame under it, and a sample averaging sixty-four such
      // pixels is exactly zero too. Noise essentially never is.
      var v = field.data[i];
      if (v === 0 || !isFinite(v)) {
         empty[i] = 1;
         ++found;
      }
   }

   var usable = new Uint8Array(field.data.length);
   for (i = 0; i < usable.length; ++i) {
      usable[i] = 1;
   }

   // Only meaningful when most of the field holds sky. A frame with holes in it
   // is what this is for; a field that is mostly at or below zero is something
   // else - a synthetic fixture built on a zero background, or a frame whose
   // calibration went wrong - and calling nearly all of it "no data" would
   // leave nothing to detect in and nothing to compute statistics from.
   //
   // Doing nothing is the right answer there. Guessing is not.
   if (found === 0 || found * 2 >= field.data.length) {
      return { usable: usable, emptyCount: found, applied: false };
   }

   for (var y = 0; y < field.height; ++y) {
      for (var x = 0; x < field.width; ++x) {
         if (!empty[y * field.width + x]) {
            continue;
         }
         var yFrom = Math.max(0, y - reach), yTo = Math.min(field.height - 1, y + reach);
         var xFrom = Math.max(0, x - reach), xTo = Math.min(field.width - 1, x + reach);
         for (var ny = yFrom; ny <= yTo; ++ny) {
            for (var nx = xFrom; nx <= xTo; ++nx) {
               usable[ny * field.width + nx] = 0;
            }
         }
      }
   }
   return { usable: usable, emptyCount: found, applied: true };
}

// How much of a candidate lies along the edge of the data.
//
// Measured, rather than turned into a rejection here, because the obvious
// rejection is wrong: a candidate NEAR an edge is not suspicious. A visual
// meteor of this night - one of the nine the recall gate rests on - comes within
// 4 px of the border, and two more meteors do as well. Excluding a band along
// the edge would take them with it.
//
// What separates them is whether the candidate runs ALONG the boundary or merely
// touches it. Measured over the eight reported artefacts and four meteors, this
// came out 49% to 100% for the artefacts and 0% to 5% for the meteors, so the
// two do not overlap and the number is worth carrying.
//
// The judgement is left to the classifier, where it becomes a score and a reason
// the operator can read, instead of a candidate that silently never existed.
// `pixels` are the {x, y, w} objects connectedComponents produces, not indices.
// Written for indices first, which made pixels[i] % width a NaN, usable[NaN] an
// undefined, and every pixel of every candidate "next to no data" - so THIRTEEN
// of the thirty-one ground-truth meteors, three of them from the recall gate,
// were being scored as artefacts. The unit test passed throughout, because it
// was written against the same wrong assumption and handed the function plain
// indices. It now builds its pixels with connectedComponents.
function edgeContact(pixels, usable, width, height, reach) {
   var r = reach === undefined ? 2 : Math.max(1, Math.floor(reach));
   var touching = 0;
   for (var i = 0; i < pixels.length; ++i) {
      var x = pixels[i].x;
      var y = pixels[i].y;
      var near = false;
      for (var dy = -r; dy <= r && !near; ++dy) {
         for (var dx = -r; dx <= r; ++dx) {
            var nx = x + dx, ny = y + dy;
            // Beyond the array there is no data either, and a candidate lying
            // along the outermost column is the same finding as one lying along
            // a wedge.
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
               near = true;
               break;
            }
            if (!usable[ny * width + nx]) {
               near = true;
               break;
            }
         }
      }
      if (near) {
         ++touching;
      }
   }
   return pixels.length > 0 ? touching / pixels.length : 0;
}

// Run the screening pass over one field.
//
// mask, if given, is a Uint8Array of the same length as field.data where 0
// marks samples to exclude. It is applied before the statistics are computed.
function detectCandidates(field, options, mask) {
   var opt = mergeDetectionOptions(options);

   // The samples that hold no data, combined with whatever the caller excluded.
   //
   // They are kept out of the background model and out of the statistics, and
   // NOT out of the thresholding: a meteor is allowed to reach the edge of the
   // frame, and several real ones do.
   var noData = opt.excludeNoData
      ? noDataMask(field, opt.noDataDilation)
      : { usable: null, emptyCount: 0, applied: false };
   if (!noData.applied) {
      noData = { usable: null, emptyCount: noData.emptyCount, applied: false };
   }
   var usable = noData.usable;
   if (usable !== null && mask) {
      usable = new Uint8Array(usable.length);
      for (var u = 0; u < usable.length; ++u) {
         usable[u] = (noData.usable[u] && mask[u]) ? 1 : 0;
      }
   } else if (usable === null) {
      usable = mask ? mask : null;
   }

   var flat = removeBackground(field, opt.backgroundFactor, usable);
   var th = threshold(flat, opt.k, usable);
   var cc = connectedComponents(th.binary, field.width, field.height, opt.connectivity);

   var candidates = [];
   for (var i = 0; i < cc.components.length; ++i) {
      var pixels = cc.components[i].pixels;
      if (pixels.length < opt.minPixels) {
         continue;
      }
      var m = computeMoments(pixels, true);
      if (m === null) {
         continue;
      }
      var ends = computeEndpoints(pixels, m);
      if (m.elongation < opt.minElongation || ends.length < opt.minLength) {
         continue;
      }
      candidates.push({
         cx: m.cx, cy: m.cy,
         x0: ends.x0, y0: ends.y0,
         x1: ends.x1, y1: ends.y1,
         length: ends.length,
         angle: m.angle,
         elongation: m.elongation,
         pixelCount: pixels.length,
         majorLength: m.majorLength,
         minorLength: m.minorLength,
         // How much of it lies along the edge of the data. Recorded, not acted
         // on: see edgeContact.
         edgeContact: noData.usable === null ? 0
            : edgeContact(pixels, noData.usable, field.width, field.height,
                          opt.edgeContactReach),
         // For the UI overlay: axis-aligned box for hit-testing, and the
         // oriented box is (cx, cy, angle, majorLength, minorLength).
         bbox: computeBoundingBox(pixels)
      });
   }
   return {
      candidates: candidates,
      level: th.level,
      sigma: th.stats.sigma,
      median: th.stats.median,
      componentCount: cc.components.length,
      noDataSamples: noData.emptyCount
   };
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      makeField: makeField,
      downsample: downsample,
      upsample: upsample,
      removeBackground: removeBackground,
      medianOf: medianOf,
      mad: mad,
      noDataMask: noDataMask,
      edgeContact: edgeContact,
      threshold: threshold,
      connectedComponents: connectedComponents,
      computeMoments: computeMoments,
      computeEndpoints: computeEndpoints,
      computeBoundingBox: computeBoundingBox,
      detectCandidates: detectCandidates,
      DEFAULT_OPTIONS: DEFAULT_OPTIONS
   };
}
