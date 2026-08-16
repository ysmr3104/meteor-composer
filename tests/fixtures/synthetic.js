//============================================================================
// synthetic.js - Deterministic synthetic fields for MeteorComposer tests
//
// Every generator is seeded. Math.random() is never used: a flaky fixture
// makes the whole suite untrustworthy (docs/tests.md section 3-3).
//
// Runs under both PJSR and Node.js (ES5 style, var only).
//============================================================================

// --- Deterministic RNG -----------------------------------------------------

// mulberry32. Small, fast, and good enough for noise fixtures. The point is
// reproducibility, not cryptographic or statistical excellence.
function makeRng(seed) {
   var state = seed >>> 0;
   return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
}

// Box-Muller, using the seeded generator.
function makeGaussianRng(seed) {
   var rng = makeRng(seed);
   var spare = null;
   return function () {
      if (spare !== null) {
         var s = spare;
         spare = null;
         return s;
      }
      var u = 0, v = 0;
      while (u === 0) {
         u = rng();
      }
      v = rng();
      var mag = Math.sqrt(-2.0 * Math.log(u));
      spare = mag * Math.sin(2.0 * Math.PI * v);
      return mag * Math.cos(2.0 * Math.PI * v);
   };
}

// --- Field construction ----------------------------------------------------

// A field is the plain-array structure handed across the PJSR boundary:
//   { data: Float64Array, width: int, height: int }
function makeField(width, height, fill) {
   var data = new Float64Array(width * height);
   if (fill) {
      for (var i = 0; i < data.length; ++i) {
         data[i] = fill;
      }
   }
   return { data: data, width: width, height: height };
}

function cloneField(field) {
   return {
      data: new Float64Array(field.data),
      width: field.width,
      height: field.height
   };
}

function fieldAt(field, x, y) {
   return field.data[y * field.width + x];
}

function fieldSet(field, x, y, value) {
   field.data[y * field.width + x] = value;
}

function fieldAdd(field, x, y, value) {
   if (x < 0 || y < 0 || x >= field.width || y >= field.height) {
      return;
   }
   field.data[y * field.width + x] += value;
}

// --- Generators ------------------------------------------------------------

// Linear gradient across the frame. Used to verify that background removal
// flattens large-scale structure without eating thin features.
function addLinearGradient(field, amplitudeX, amplitudeY, offset) {
   for (var y = 0; y < field.height; ++y) {
      for (var x = 0; x < field.width; ++x) {
         var fx = field.width > 1 ? x / (field.width - 1) : 0;
         var fy = field.height > 1 ? y / (field.height - 1) : 0;
         field.data[y * field.width + x] += offset + amplitudeX * fx + amplitudeY * fy;
      }
   }
}

// Axis-aligned filled rectangle. The analytic moment expectations in the tests
// are derived from this shape, so it must stay exactly a rectangle.
function addRect(field, x0, y0, w, h, amplitude) {
   for (var y = y0; y < y0 + h; ++y) {
      for (var x = x0; x < x0 + w; ++x) {
         fieldAdd(field, x, y, amplitude);
      }
   }
}

// Anti-aliased line of a given width, modelling a meteor or satellite trail.
// Uses distance-to-segment rather than Bresenham so that diagonal trails are
// not systematically thinner than axis-aligned ones.
function addLine(field, x0, y0, x1, y1, width, amplitude) {
   var minX = Math.max(0, Math.floor(Math.min(x0, x1) - width - 1));
   var maxX = Math.min(field.width - 1, Math.ceil(Math.max(x0, x1) + width + 1));
   var minY = Math.max(0, Math.floor(Math.min(y0, y1) - width - 1));
   var maxY = Math.min(field.height - 1, Math.ceil(Math.max(y0, y1) + width + 1));
   var half = width / 2;

   for (var y = minY; y <= maxY; ++y) {
      for (var x = minX; x <= maxX; ++x) {
         var d = distanceToSegment(x, y, x0, y0, x1, y1);
         if (d <= half) {
            fieldAdd(field, x, y, amplitude);
         } else if (d < half + 1) {
            fieldAdd(field, x, y, amplitude * (half + 1 - d));
         }
      }
   }
}

function distanceToSegment(px, py, x0, y0, x1, y1) {
   var dx = x1 - x0, dy = y1 - y0;
   var lenSq = dx * dx + dy * dy;
   var t = 0;
   if (lenSq > 0) {
      t = ((px - x0) * dx + (py - y0) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
   }
   var cx = x0 + t * dx, cy = y0 + t * dy;
   return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// Round Gaussian star.
function addStar(field, cx, cy, fwhm, amplitude) {
   var sigma = fwhm / 2.3548200450309493;
   var radius = Math.ceil(3 * sigma);
   for (var y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); ++y) {
      for (var x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); ++x) {
         var dx = x - cx, dy = y - cy;
         var r2 = dx * dx + dy * dy;
         fieldAdd(field, x, y, amplitude * Math.exp(-r2 / (2 * sigma * sigma)));
      }
   }
}

// Field of randomly placed stars. Deterministic for a given seed.
function addStarField(field, count, fwhm, amplitude, seed) {
   var rng = makeRng(seed);
   for (var i = 0; i < count; ++i) {
      var cx = rng() * field.width;
      var cy = rng() * field.height;
      // Vary brightness so the field is not artificially uniform.
      var a = amplitude * (0.3 + 0.7 * rng());
      addStar(field, cx, cy, fwhm, a);
   }
}

function addGaussianNoise(field, sigma, seed) {
   var gauss = makeGaussianRng(seed);
   for (var i = 0; i < field.data.length; ++i) {
      field.data[i] += gauss() * sigma;
   }
}

// Noise confined to a rectangle. Needed to model a bright, textured foreground
// (buildings, trees) that must not be allowed to inflate the sky's threshold.
function addGaussianNoiseRect(field, x0, y0, w, h, sigma, seed) {
   var gauss = makeGaussianRng(seed);
   for (var y = y0; y < y0 + h; ++y) {
      if (y < 0 || y >= field.height) {
         continue;
      }
      for (var x = x0; x < x0 + w; ++x) {
         if (x < 0 || x >= field.width) {
            continue;
         }
         field.data[y * field.width + x] += gauss() * sigma;
      }
   }
}

// --- Point sets for moment tests ------------------------------------------

// Exact grid points of a w x h rectangle, centred on the origin. Returned as
// {x, y, w} triples so that moment tests can use exact coordinates instead of
// rasterised ones (rasterisation would add error that masks real bugs).
function rectanglePoints(w, h) {
   var pts = [];
   for (var y = 0; y < h; ++y) {
      for (var x = 0; x < w; ++x) {
         pts.push({ x: x, y: y, w: 1 });
      }
   }
   return pts;
}

// Rotate a point set about its centroid by degrees. Coordinates stay real, so
// no information is lost: elongation must be exactly preserved and the
// recovered angle must equal the applied rotation.
function rotatePoints(points, degrees) {
   var rad = degrees * Math.PI / 180;
   var cos = Math.cos(rad), sin = Math.sin(rad);
   var sx = 0, sy = 0, sw = 0;
   var i;
   for (i = 0; i < points.length; ++i) {
      sx += points[i].x * points[i].w;
      sy += points[i].y * points[i].w;
      sw += points[i].w;
   }
   var cx = sx / sw, cy = sy / sw;
   var out = [];
   for (i = 0; i < points.length; ++i) {
      var dx = points[i].x - cx, dy = points[i].y - cy;
      out.push({
         x: cx + dx * cos - dy * sin,
         y: cy + dx * sin + dy * cos,
         w: points[i].w
      });
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      makeRng: makeRng,
      makeGaussianRng: makeGaussianRng,
      makeField: makeField,
      cloneField: cloneField,
      fieldAt: fieldAt,
      fieldSet: fieldSet,
      fieldAdd: fieldAdd,
      addLinearGradient: addLinearGradient,
      addRect: addRect,
      addLine: addLine,
      addStar: addStar,
      addStarField: addStarField,
      addGaussianNoise: addGaussianNoise,
      addGaussianNoiseRect: addGaussianNoiseRect,
      rectanglePoints: rectanglePoints,
      rotatePoints: rotatePoints
   };
}
