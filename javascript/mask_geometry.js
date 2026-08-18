//============================================================================
// mask_geometry.js - Exclusion region geometry for MeteorComposer
//
// Pure JavaScript, no PJSR. Implements the exclusion regions described in
// docs/requirements.md section 5:
//
//   Tier 1  a rotatable half-plane, static for the whole session
//   Tier 2  keyframed half-planes interpolated by frame timestamp
//
// Tier 3 (horizon from WCS) is Phase 5 and is not implemented here.
//
// Why a half-plane and not a simple "bottom N%": in registered coordinates the
// ground rotates over the session for BOTH tracked and fixed shooting, because
// registration aligns on the stars. A static horizontal cut cannot follow it.
//
// Runs under both PJSR and Node.js (ES5 style, var only).
//============================================================================

// --- Half-plane ------------------------------------------------------------

// A half-plane is defined by the angle of its boundary line and the signed
// perpendicular offset of that line from the image centre.
//
//   angle    degrees, the direction of the boundary line, measured from +x
//            towards +y. 0 is a horizontal line.
//   offset   signed distance from the image centre to the line, in pixels,
//            measured along the line's normal.
//   keep     which side is KEPT. +1 keeps the side the normal points away
//            from; -1 keeps the other side.
//
// The normal of a line at `angle` is (-sin(angle), cos(angle)).
function makeHalfPlane(angle, offset, keep) {
   return {
      angle: angle,
      offset: offset,
      keep: (keep === -1) ? -1 : 1
   };
}

// Signed distance from a point to the boundary line, positive on the side the
// normal points towards.
function signedDistance(halfPlane, x, y, width, height) {
   var rad = halfPlane.angle * Math.PI / 180;
   var nx = -Math.sin(rad);
   var ny = Math.cos(rad);
   var cx = (width - 1) / 2;
   var cy = (height - 1) / 2;
   return (x - cx) * nx + (y - cy) * ny - halfPlane.offset;
}

// True when the sample is KEPT (i.e. not excluded) by this half-plane.
function halfPlaneKeeps(halfPlane, x, y, width, height) {
   var d = signedDistance(halfPlane, x, y, width, height);
   return (halfPlane.keep === 1) ? (d >= 0) : (d <= 0);
}

// --- Keyframe interpolation ------------------------------------------------

// Keyframes are [{ t: number, halfPlane: {...} }, ...], where t is any
// monotonically increasing value (a timestamp in ms, or a frame index).
//
// Angles are interpolated on the shortest arc modulo 180 degrees, because a
// line has no direction: 179 -> 1 is a 2 degree move, not 178.
function interpolateHalfPlanes(keyframes, t) {
   if (!keyframes || keyframes.length === 0) {
      return null;
   }
   var sorted = keyframes.slice().sort(function (a, b) { return a.t - b.t; });
   if (t <= sorted[0].t) {
      return cloneHalfPlane(sorted[0].halfPlane);
   }
   var last = sorted[sorted.length - 1];
   if (t >= last.t) {
      return cloneHalfPlane(last.halfPlane);
   }
   for (var i = 0; i < sorted.length - 1; ++i) {
      var a = sorted[i], b = sorted[i + 1];
      if (t >= a.t && t <= b.t) {
         var span = b.t - a.t;
         var f = (span === 0) ? 0 : (t - a.t) / span;
         return {
            angle: interpolateAngle(a.halfPlane.angle, b.halfPlane.angle, f),
            offset: a.halfPlane.offset + f * (b.halfPlane.offset - a.halfPlane.offset),
            keep: a.halfPlane.keep
         };
      }
   }
   return cloneHalfPlane(last.halfPlane);
}

function cloneHalfPlane(hp) {
   return { angle: hp.angle, offset: hp.offset, keep: hp.keep };
}

// Shortest-arc interpolation modulo 180.
function interpolateAngle(a, b, f) {
   var d = normalizeAngle(b) - normalizeAngle(a);
   while (d > 90) {
      d -= 180;
   }
   while (d < -90) {
      d += 180;
   }
   return normalizeAngle(normalizeAngle(a) + f * d);
}

function normalizeAngle(a) {
   var x = a % 180;
   if (x < 0) {
      x += 180;
   }
   return x;
}

// --- Region composition ----------------------------------------------------

// A region is a list of half-planes combined with a mode:
//   "and" a sample is kept only if every half-plane keeps it
//   "or"  a sample is kept if any half-plane keeps it
//
// "and" is the useful default for landscape masking: each half-plane cuts away
// one intrusion (trees on the left, a building on the right, ground below),
// and a sample must survive all of them.
function makeRegion(halfPlanes, mode) {
   return {
      halfPlanes: halfPlanes || [],
      mode: (mode === "or") ? "or" : "and"
   };
}

function regionKeeps(region, x, y, width, height) {
   var n = region.halfPlanes.length;
   if (n === 0) {
      return true;
   }
   var i;
   if (region.mode === "or") {
      for (i = 0; i < n; ++i) {
         if (halfPlaneKeeps(region.halfPlanes[i], x, y, width, height)) {
            return true;
         }
      }
      return false;
   }
   for (i = 0; i < n; ++i) {
      if (!halfPlaneKeeps(region.halfPlanes[i], x, y, width, height)) {
         return false;
      }
   }
   return true;
}

// Build the inclusion mask consumed by detection_core: 1 = keep, 0 = exclude.
//
// The mask must be applied before the robust statistics are computed. Applying
// it afterwards lets a bright foreground inflate MAD and destroy sensitivity
// across the sky (docs/requirements.md 5.4).
function buildMask(region, width, height, extraMask) {
   var mask = new Uint8Array(width * height);
   for (var y = 0; y < height; ++y) {
      var row = y * width;
      for (var x = 0; x < width; ++x) {
         var keep = regionKeeps(region, x, y, width, height);
         if (keep && extraMask) {
            keep = extraMask[row + x] !== 0;
         }
         mask[row + x] = keep ? 1 : 0;
      }
   }
   return mask;
}

// Fraction of the frame that is excluded, in [0, 1].
//
// Surfacing this in the UI matters: over-masking silently destroys recall and
// is otherwise invisible.
function excludedFraction(region, width, height) {
   var total = width * height;
   if (total === 0) {
      return 0;
   }
   var excluded = 0;
   for (var y = 0; y < height; ++y) {
      for (var x = 0; x < width; ++x) {
         if (!regionKeeps(region, x, y, width, height)) {
            ++excluded;
         }
      }
   }
   return excluded / total;
}

// --- Edge bands (the form the UI collects) ---------------------------------

// The dialog does not ask for half-planes, and it does not ask for an angle
// either. It asks, per edge, how far in the excluded band reaches AT EACH END
// of that edge:
//
//   top, bottom     the left end first, then the right end
//   left, right     the top end first, then the bottom end
//
// as a percentage of the frame's height (top, bottom) or width (left, right).
//
// Why two depths rather than a depth and a tilt. Both describe the same family
// of lines, but a tilt is signed, and PJSR's SpinBox cannot hold a negative
// number - assigning one leaves it at zero, silently, whether by the property
// or by setRange() (measured; tests/pjsr/probe_layout.js). Depths are never
// negative, so every number in the row can be a spin box the operator steps
// with the keyboard, and there is no sign convention or pivot to explain: each
// number is how much is covered, right there.
//
// The cost is that a level band needs the same number entered twice.
var MASK_EDGES = ["top", "bottom", "left", "right"];

function makeEdgeSpec() {
   var spec = {};
   for (var i = 0; i < MASK_EDGES.length; ++i) {
      spec[MASK_EDGES[i]] = { start: 0, end: 0 };
   }
   return spec;
}

function clampPercent(p) {
   var v = Number(p);
   if (!isFinite(v) || v < 0) {
      return 0;
   }
   return (v > 100) ? 100 : v;
}

function edgeSpecIsEmpty(spec) {
   for (var i = 0; i < MASK_EDGES.length; ++i) {
      var e = spec ? spec[MASK_EDGES[i]] : null;
      if (!e) {
         continue;
      }
      if (clampPercent(e.start) !== 0 || clampPercent(e.end) !== 0) {
         return false;
      }
   }
   return true;
}

// One edge -> one half-plane, or null when the edge excludes nothing.
//
// The boundary passes through the two depths, so the excluded band is the
// trapezoid between it and the edge. Its area is therefore the MEAN of the two
// percentages - which is what the readout will show, and what makes the numbers
// predictable: 8 and 14 excludes 11% of the frame.
function edgeHalfPlane(edge, startPercent, endPercent, width, height) {
   var a = clampPercent(startPercent);
   var b = clampPercent(endPercent);
   if (a === 0 && b === 0) {
      return null;
   }
   var x0, y0, x1, y1, keep, da, db;
   switch (edge) {
   case "top":
      da = a / 100 * height;
      db = b / 100 * height;
      x0 = 0; y0 = da; x1 = width - 1; y1 = db;
      keep = 1;                     // keep what is below the boundary
      break;
   case "bottom":
      da = a / 100 * height;
      db = b / 100 * height;
      x0 = 0; y0 = (height - 1) - da; x1 = width - 1; y1 = (height - 1) - db;
      keep = -1;                    // keep what is above it
      break;
   case "left":
      da = a / 100 * width;
      db = b / 100 * width;
      x0 = da; y0 = 0; x1 = db; y1 = height - 1;
      keep = -1;                    // keep what is to its right
      break;
   case "right":
      da = a / 100 * width;
      db = b / 100 * width;
      x0 = (width - 1) - da; y0 = 0; x1 = (width - 1) - db; y1 = height - 1;
      keep = 1;                     // keep what is to its left
      break;
   default:
      return null;
   }
   return halfPlaneThrough(x0, y0, x1, y1, keep, width, height);
}

// The half-plane whose boundary passes through two points.
//
// `keep` is fixed per edge rather than derived from a probe point, because at
// 100% there is no kept sample left to probe: the sign has to come from the
// geometry. For a top or bottom band the boundary always runs left to right, so
// its normal (-sin, cos) always points down the frame; for a left or right band
// it always runs top to bottom, so the normal always points to -x. Those are
// the two facts the constants above rest on.
function halfPlaneThrough(x0, y0, x1, y1, keep, width, height) {
   var angle = Math.atan2(y1 - y0, x1 - x0) * 180 / Math.PI;
   var rad = angle * Math.PI / 180;
   var nx = -Math.sin(rad);
   var ny = Math.cos(rad);
   var cx = (width - 1) / 2;
   var cy = (height - 1) / 2;
   // A point on the boundary has signed distance zero, which fixes the offset.
   var offset = (x0 - cx) * nx + (y0 - cy) * ny;
   return makeHalfPlane(angle, offset, keep);
}

// The four edges combined with "and": a sample survives only if every edge
// keeps it. "or" would mean one edge alone could rescue a sample another edge
// cut away, which is not what "the ground is at the bottom AND trees on the
// left" means.
function edgeSpecToRegion(spec, width, height) {
   var planes = [];
   for (var i = 0; i < MASK_EDGES.length; ++i) {
      var edge = MASK_EDGES[i];
      var e = spec ? spec[edge] : null;
      if (!e) {
         continue;
      }
      var hp = edgeHalfPlane(edge, e.start, e.end, width, height);
      if (hp) {
         planes.push(hp);
      }
   }
   return makeRegion(planes, "and");
}

// The two endpoints where an edge's boundary line meets the frame border, for
// drawing it on the preview. Returns null when the line misses the frame
// entirely (which happens at 0% with a tilt, on the half that runs off).
function edgeBoundarySegment(edge, startPercent, endPercent, width, height) {
   var hp = edgeHalfPlane(edge, startPercent, endPercent, width, height);
   if (!hp) {
      return null;
   }
   return halfPlaneSegment(hp, width, height);
}

// Clip the boundary line against the frame rectangle. Parametrise the line as
// P0 + t*d with d the line direction, and intersect with the four borders.
function halfPlaneSegment(halfPlane, width, height) {
   var rad = halfPlane.angle * Math.PI / 180;
   var dx = Math.cos(rad);
   var dy = Math.sin(rad);
   var nx = -Math.sin(rad);
   var ny = Math.cos(rad);
   var cx = (width - 1) / 2;
   var cy = (height - 1) / 2;
   // Closest point of the line to the image centre.
   var x0 = cx + nx * halfPlane.offset;
   var y0 = cy + ny * halfPlane.offset;

   var hits = [];
   var w = width - 1;
   var h = height - 1;
   var eps = 1e-9;

   if (Math.abs(dx) > eps) {
      addHit(hits, x0, y0, dx, dy, (0 - x0) / dx, w, h, eps);
      addHit(hits, x0, y0, dx, dy, (w - x0) / dx, w, h, eps);
   }
   if (Math.abs(dy) > eps) {
      addHit(hits, x0, y0, dx, dy, (0 - y0) / dy, w, h, eps);
      addHit(hits, x0, y0, dx, dy, (h - y0) / dy, w, h, eps);
   }
   if (hits.length < 2) {
      return null;
   }
   hits.sort(function (a, b) { return a.t - b.t; });
   var first = hits[0];
   var last = hits[hits.length - 1];
   if (Math.abs(last.t - first.t) < eps) {
      return null;
   }
   return { x0: first.x, y0: first.y, x1: last.x, y1: last.y };
}

function addHit(hits, x0, y0, dx, dy, t, w, h, eps) {
   var x = x0 + dx * t;
   var y = y0 + dy * t;
   if (x < -eps || x > w + eps || y < -eps || y > h + eps) {
      return;
   }
   hits.push({ t: t, x: x, y: y });
}

// --- Mask from a painted image --------------------------------------------

// The operator can paint the exclusion instead of describing it with numbers,
// which is the only practical option for a tree line. BLACK IS EXCLUDED:
// painting a region out is the gesture people expect.
//
// The painted file is rarely the frame's size (a screenshot, a resized JPEG),
// so it is sampled by nearest neighbour onto the target grid. Nearest
// neighbour and not bilinear, because an interpolated edge would produce
// half-excluded samples with no defensible threshold.
//
// lum is a luminance field in [0, 1], row-major, lumWidth by lumHeight.
function maskFromLuminance(lum, lumWidth, lumHeight, width, height, threshold) {
   var limit = (threshold === undefined) ? 0.5 : threshold;
   var out = new Uint8Array(width * height);
   if (lumWidth <= 0 || lumHeight <= 0) {
      return out;
   }
   for (var y = 0; y < height; ++y) {
      var sy = Math.floor((y + 0.5) * lumHeight / height);
      if (sy < 0) {
         sy = 0;
      } else if (sy >= lumHeight) {
         sy = lumHeight - 1;
      }
      var srcRow = sy * lumWidth;
      var dstRow = y * width;
      for (var x = 0; x < width; ++x) {
         var sx = Math.floor((x + 0.5) * lumWidth / width);
         if (sx < 0) {
            sx = 0;
         } else if (sx >= lumWidth) {
            sx = lumWidth - 1;
         }
         out[dstRow + x] = (lum[srcRow + sx] >= limit) ? 1 : 0;
      }
   }
   return out;
}

// Excluded samples as row-aligned runs.
//
// The preview overlay is painted from these. A banded or painted mask is made
// of long solid spans, so a few hundred rectangle fills replace hundreds of
// thousands of per-pixel writes - which is the difference between an overlay
// that follows the numbers as they are typed and one that does not.
function maskRuns(mask, width, height) {
   var runs = [];
   for (var y = 0; y < height; ++y) {
      var row = y * width;
      var x = 0;
      while (x < width) {
         if (mask[row + x]) {
            ++x;
            continue;
         }
         var start = x;
         while (x < width && !mask[row + x]) {
            ++x;
         }
         runs.push({ y: y, x0: start, x1: x - 1 });
      }
   }
   return runs;
}

// Turn a luminance field by a multiple of 90 degrees, clockwise.
//
// A painted mask is in the FRAME's orientation, but the operator paints it
// against what is on screen - and the preview can be turned. It is also
// perfectly normal for the file to arrive from a phone or a screenshot in a
// different orientation entirely. Either way the fix is the same: turn the file
// rather than ask the operator to go and re-export it.
//
// Clockwise, matching Bitmap.rotated() and the preview's own rotate buttons, so
// there is one direction convention in the script rather than two.
function rotateLuminance(data, width, height, degrees) {
   var turn = ((Math.round(degrees / 90) % 4) + 4) % 4;
   if (turn === 0) {
      return { data: data, width: width, height: height };
   }
   var outWidth = (turn === 2) ? width : height;
   var outHeight = (turn === 2) ? height : width;
   var out = new Float32Array(outWidth * outHeight);
   var x, y, src;
   for (y = 0; y < outHeight; ++y) {
      for (x = 0; x < outWidth; ++x) {
         if (turn === 1) {
            // 90 clockwise: the old top-left corner ends up at the top right.
            src = (height - 1 - x) * width + y;
         } else if (turn === 2) {
            src = (height - 1 - y) * width + (width - 1 - x);
         } else {
            // 270 clockwise: the old top-left corner ends up at the bottom left.
            src = x * width + (width - 1 - y);
         }
         out[y * outWidth + x] = data[src];
      }
   }
   return { data: out, width: outWidth, height: outHeight };
}

// Fraction excluded by an explicit inclusion mask, in [0, 1]. Same readout as
// excludedFraction() but for the painted path, so the UI can report one number
// whichever source is active.
function maskExcludedFraction(mask) {
   if (!mask || mask.length === 0) {
      return 0;
   }
   var excluded = 0;
   for (var i = 0; i < mask.length; ++i) {
      if (!mask[i]) {
         ++excluded;
      }
   }
   return excluded / mask.length;
}

// --- Zero-border detection -------------------------------------------------

// StarAlignment fills areas outside the registered frame with zero. The shape
// changes per frame, so differencing or thresholding across the boundary
// produces a rim of false positives.
//
// erodeRadius shrinks the valid area to also drop the interpolation fringe
// just inside the border.
function buildValidDataMask(field, erodeRadius, threshold) {
   var w = field.width, h = field.height;
   var limit = (threshold === undefined) ? 0 : threshold;
   var raw = new Uint8Array(w * h);
   var i;
   for (i = 0; i < field.data.length; ++i) {
      raw[i] = (field.data[i] > limit) ? 1 : 0;
   }
   var r = (erodeRadius === undefined) ? 0 : Math.floor(erodeRadius);
   if (r <= 0) {
      return raw;
   }
   return erode(raw, w, h, r);
}

// Square-kernel erosion. Separable, so it is two linear passes rather than
// a quadratic neighbourhood scan.
function erode(mask, width, height, radius) {
   var tmp = new Uint8Array(width * height);
   var x, y, k, ok;

   for (y = 0; y < height; ++y) {
      for (x = 0; x < width; ++x) {
         ok = 1;
         for (k = -radius; k <= radius; ++k) {
            var xx = x + k;
            if (xx < 0 || xx >= width || mask[y * width + xx] === 0) {
               ok = 0;
               break;
            }
         }
         tmp[y * width + x] = ok;
      }
   }

   var out = new Uint8Array(width * height);
   for (y = 0; y < height; ++y) {
      for (x = 0; x < width; ++x) {
         ok = 1;
         for (k = -radius; k <= radius; ++k) {
            var yy = y + k;
            if (yy < 0 || yy >= height || tmp[yy * width + x] === 0) {
               ok = 0;
               break;
            }
         }
         out[y * width + x] = ok;
      }
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      makeHalfPlane: makeHalfPlane,
      signedDistance: signedDistance,
      halfPlaneKeeps: halfPlaneKeeps,
      interpolateHalfPlanes: interpolateHalfPlanes,
      interpolateAngle: interpolateAngle,
      normalizeAngle: normalizeAngle,
      makeRegion: makeRegion,
      regionKeeps: regionKeeps,
      buildMask: buildMask,
      excludedFraction: excludedFraction,
      MASK_EDGES: MASK_EDGES,
      makeEdgeSpec: makeEdgeSpec,
      clampPercent: clampPercent,
      edgeSpecIsEmpty: edgeSpecIsEmpty,
      edgeHalfPlane: edgeHalfPlane,
      halfPlaneThrough: halfPlaneThrough,
      edgeSpecToRegion: edgeSpecToRegion,
      edgeBoundarySegment: edgeBoundarySegment,
      halfPlaneSegment: halfPlaneSegment,
      maskFromLuminance: maskFromLuminance,
      maskExcludedFraction: maskExcludedFraction,
      maskRuns: maskRuns,
      rotateLuminance: rotateLuminance,
      buildValidDataMask: buildValidDataMask,
      erode: erode
   };
}
