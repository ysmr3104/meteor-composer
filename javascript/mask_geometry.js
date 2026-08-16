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
      buildValidDataMask: buildValidDataMask,
      erode: erode
   };
}
