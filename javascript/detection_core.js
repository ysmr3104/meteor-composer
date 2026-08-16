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
function downsample(field, factor, mode) {
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
               var v = field.data[row + x];
               if (mode === "median") {
                  block.push(v);
               } else {
                  sum += v;
               }
               ++n;
            }
         }
         out.data[by * outW + bx] = (mode === "median") ? medianOf(block) : (n > 0 ? sum / n : 0);
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
function removeBackground(field, factor) {
   var coarse = downsample(field, factor, "median");
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
   minLength: 10.0        // in samples of the working (downsampled) field
};

function mergeOptions(options) {
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

// Run the screening pass over one field.
//
// mask, if given, is a Uint8Array of the same length as field.data where 0
// marks samples to exclude. It is applied before the statistics are computed.
function detectCandidates(field, options, mask) {
   var opt = mergeOptions(options);
   var flat = removeBackground(field, opt.backgroundFactor);
   var th = threshold(flat, opt.k, mask);
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
      componentCount: cc.components.length
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
      threshold: threshold,
      connectedComponents: connectedComponents,
      computeMoments: computeMoments,
      computeEndpoints: computeEndpoints,
      computeBoundingBox: computeBoundingBox,
      detectCandidates: detectCandidates,
      DEFAULT_OPTIONS: DEFAULT_OPTIONS
   };
}
