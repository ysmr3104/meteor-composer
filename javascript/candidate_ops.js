//============================================================================
// candidate_ops.js - Operations on candidate lists for MeteorComposer
//
// Pure JavaScript, no PJSR and no image data. Everything here works on the
// candidate records produced by detection_core.detectCandidates(), which makes
// the whole module Small-testable (docs/tests.md section 2).
//
// Contains:
//   - collinear merging, needed by the 2nd pass because masking stars and
//     thresholding both fragment a trail (docs/requirements.md 4.6)
//   - cross-frame matching, the strongest satellite/aircraft discriminator
//     (docs/requirements.md 6.1)
//
// Runs under both PJSR and Node.js (ES5 style, var only).
//============================================================================

// --- Geometry helpers ------------------------------------------------------

function angleDifference(a, b) {
   var d = Math.abs(normalizeAngle180(a) - normalizeAngle180(b));
   return (d > 90) ? (180 - d) : d;
}

function normalizeAngle180(a) {
   var x = a % 180;
   if (x < 0) {
      x += 180;
   }
   return x;
}

// Perpendicular distance from a point to the infinite line through
// (cx, cy) at `angle` degrees.
function perpendicularDistance(cx, cy, angle, px, py) {
   var rad = angle * Math.PI / 180;
   var nx = -Math.sin(rad);
   var ny = Math.cos(rad);
   return Math.abs((px - cx) * nx + (py - cy) * ny);
}

// Gap between two segments measured along their shared direction.
//
// Both segments are projected onto the mean direction and the separation of
// the resulting intervals is returned; overlapping segments give zero.
//
// Taking the shortest distance between endpoints instead would be wrong: for
// two overlapping fragments it reports the offset between their near ends
// rather than zero, so an overlap looks like a gap.
function axialGap(a, b) {
   var ux = meanDirectionX(a, b);
   var uy = meanDirectionY(a, b);
   var ai = projectInterval(a, ux, uy);
   var bi = projectInterval(b, ux, uy);
   var separation = Math.max(ai[0], bi[0]) - Math.min(ai[1], bi[1]);
   return (separation > 0) ? separation : 0;
}

// Mean orientation of two segments, computed on doubled angles so that
// 179 and 1 average to 0 rather than 90.
function meanDirection(a, b) {
   var ra = 2 * a.angle * Math.PI / 180;
   var rb = 2 * b.angle * Math.PI / 180;
   var vx = Math.cos(ra) + Math.cos(rb);
   var vy = Math.sin(ra) + Math.sin(rb);
   var mean = 0.5 * Math.atan2(vy, vx);
   return [Math.cos(mean), Math.sin(mean)];
}

function meanDirectionX(a, b) {
   return meanDirection(a, b)[0];
}

function meanDirectionY(a, b) {
   return meanDirection(a, b)[1];
}

function projectInterval(seg, ux, uy) {
   var t0 = seg.x0 * ux + seg.y0 * uy;
   var t1 = seg.x1 * ux + seg.y1 * uy;
   return (t0 <= t1) ? [t0, t1] : [t1, t0];
}

// --- Collinear merging -----------------------------------------------------

var DEFAULT_MERGE_OPTIONS = {
   maxAngleDiff: 8.0,        // degrees between segment orientations
   maxPerpDistance: 4.0,     // how far off the shared line a segment may sit
   maxGap: 40.0              // largest end-to-end gap that is still one object
};

// Merge fragments that lie on a common line.
//
// Two things fragment a real trail: masking out a star the trail passes over,
// and thresholding a trail whose brightness dips. An aircraft's strobe produces
// the same pattern deliberately, so merging is also what turns a dashed strobe
// trail into a single object that can be recognised as one.
//
// Merging is transitive: A-B and B-C put A, B and C in one group even when A
// and C are far apart.
function mergeCollinear(candidates, options) {
   var opt = mergeWithDefaults(DEFAULT_MERGE_OPTIONS, options);
   var n = candidates.length;
   if (n === 0) {
      return [];
   }

   var parent = new Array(n);
   var i, j;
   for (i = 0; i < n; ++i) {
      parent[i] = i;
   }

   function find(x) {
      while (parent[x] !== x) {
         parent[x] = parent[parent[x]];
         x = parent[x];
      }
      return x;
   }

   function union(x, y) {
      var rx = find(x), ry = find(y);
      if (rx !== ry) {
         parent[ry] = rx;
      }
   }

   for (i = 0; i < n; ++i) {
      for (j = i + 1; j < n; ++j) {
         if (isCollinear(candidates[i], candidates[j], opt)) {
            union(i, j);
         }
      }
   }

   var groups = {};
   for (i = 0; i < n; ++i) {
      var root = find(i);
      if (!groups[root]) {
         groups[root] = [];
      }
      groups[root].push(candidates[i]);
   }

   var merged = [];
   for (var key in groups) {
      merged.push(combineGroup(groups[key]));
   }
   merged.sort(function (a, b) { return b.length - a.length; });
   return merged;
}

function isCollinear(a, b, opt) {
   if (angleDifference(a.angle, b.angle) > opt.maxAngleDiff) {
      return false;
   }
   // Each centroid must sit close to the other's line. Checking both ways
   // avoids accepting a short segment that happens to straddle a long one's
   // axis without sharing its direction.
   if (perpendicularDistance(a.cx, a.cy, a.angle, b.cx, b.cy) > opt.maxPerpDistance) {
      return false;
   }
   if (perpendicularDistance(b.cx, b.cy, b.angle, a.cx, a.cy) > opt.maxPerpDistance) {
      return false;
   }
   return axialGap(a, b) <= opt.maxGap;
}

// Combine a group into one record. The endpoints are the extreme projections
// onto the group's flux-weighted mean direction.
function combineGroup(group) {
   if (group.length === 1) {
      var only = shallowCopy(group[0]);
      only.fragmentCount = 1;
      only.gaps = [];
      return only;
   }

   var totalPixels = 0;
   var sx = 0, sy = 0;
   var i;
   for (i = 0; i < group.length; ++i) {
      var w = group[i].pixelCount;
      totalPixels += w;
      sx += group[i].cx * w;
      sy += group[i].cy * w;
   }
   var cx = sx / totalPixels, cy = sy / totalPixels;

   // Mean orientation, computed on doubled angles so that 179 and 1 average to
   // 0 rather than 90.
   var vx = 0, vy = 0;
   for (i = 0; i < group.length; ++i) {
      var rad2 = 2 * group[i].angle * Math.PI / 180;
      vx += Math.cos(rad2) * group[i].pixelCount;
      vy += Math.sin(rad2) * group[i].pixelCount;
   }
   var angle = normalizeAngle180(0.5 * Math.atan2(vy, vx) * 180 / Math.PI);

   var rad = angle * Math.PI / 180;
   var ux = Math.cos(rad), uy = Math.sin(rad);
   var tMin = Infinity, tMax = -Infinity;
   var pMin = null, pMax = null;
   var intervals = [];

   for (i = 0; i < group.length; ++i) {
      var ends = [
         { x: group[i].x0, y: group[i].y0 },
         { x: group[i].x1, y: group[i].y1 }
      ];
      var lo = Infinity, hi = -Infinity;
      for (var e = 0; e < 2; ++e) {
         var t = (ends[e].x - cx) * ux + (ends[e].y - cy) * uy;
         if (t < tMin) {
            tMin = t;
            pMin = ends[e];
         }
         if (t > tMax) {
            tMax = t;
            pMax = ends[e];
         }
         lo = Math.min(lo, t);
         hi = Math.max(hi, t);
      }
      intervals.push([lo, hi]);
   }

   // Gaps between consecutive fragments along the axis. An aircraft strobe
   // produces regular gaps; a meteor broken by a masked star produces one or
   // two irregular ones.
   intervals.sort(function (a, b) { return a[0] - b[0]; });
   var gaps = [];
   for (i = 1; i < intervals.length; ++i) {
      var gap = intervals[i][0] - intervals[i - 1][1];
      if (gap > 0) {
         gaps.push(gap);
      }
   }

   return {
      cx: cx,
      cy: cy,
      x0: pMin.x, y0: pMin.y,
      x1: pMax.x, y1: pMax.y,
      length: tMax - tMin,
      angle: angle,
      // Elongation of the merged object is not the mean of its parts; report
      // the largest fragment's value and let the caller recompute from pixels
      // if it needs an exact figure.
      elongation: maxOf(group, "elongation"),
      pixelCount: totalPixels,
      fragmentCount: group.length,
      gaps: gaps
   };
}

function maxOf(list, key) {
   var m = -Infinity;
   for (var i = 0; i < list.length; ++i) {
      if (list[i][key] > m) {
         m = list[i][key];
      }
   }
   return m;
}

// --- Cross-frame matching --------------------------------------------------

var DEFAULT_MATCH_OPTIONS = {
   maxFrameGap: 2,          // frames may be skipped when a trail is faint
   maxAngleDiff: 15.0,      // satellites keep a nearly constant orientation
   // In samples of the working field, per frame.
   //
   // Was 400, which is over half the width of the 753-sample field and links
   // things that have nothing to do with each other. Measured on the
   // 2026-08-12 session against the screening verdicts:
   //
   //   maxCentroidShift   tracks   persistent candidates   meteors caught
   //              400       130                     302                2
   //              200       135                     297                0
   //              100       146                     282                0
   //
   // At 400 the linker swept up two labelled meteors and marked them
   // persistent - exactly the failure that matters, since a meteor lost costs
   // more than thirty aircraft kept (6.2). Dropping to 100 keeps 93% of the
   // suppression and leaves a wide margin before meteors start being caught.
   // A satellite crossing the field in 11-14 frames moves about 60 samples
   // per frame, so 100 is still generous for what this is meant to link.
   maxCentroidShift: 100.0,

   // Longest track that could still be a single meteor.
   //
   // A meteor lasts a fraction of a second, but exposures are contiguous: one
   // that occurs at an exposure boundary is recorded partly at the end of one
   // frame and partly at the start of the next. Two frames is therefore
   // normal, not evidence of a satellite.
   //
   // Confirmed on the 2026-08-12 session: the labelled meteor in DSC05443 /
   // DSC05444 forms a 2-frame track, while the satellites crossing the same
   // frames form 11 and 14 frame tracks. Track lengths cluster at 1 (63
   // tracks) and 2 (23 tracks), then thin out, so the boundary sits naturally
   // at 2.
   maxMeteorFrames: 2
};

// Link candidates that appear in consecutive frames.
//
// This is the strongest discriminator available (docs/requirements.md 6.1):
// satellites and aircraft appear in a run of frames with a smoothly moving
// position, whereas a meteor lasts a fraction of a second and shows up once.
//
// frames is [{ file, index, candidates: [...] }, ...] in capture order.
// The return value assigns a track id to every candidate and reports the run
// length of each track.
function matchAcrossFrames(frames, options) {
   var opt = mergeWithDefaults(DEFAULT_MATCH_OPTIONS, options);
   var tracks = [];
   var i, j, k;

   for (i = 0; i < frames.length; ++i) {
      var frame = frames[i];
      for (j = 0; j < frame.candidates.length; ++j) {
         var cand = frame.candidates[j];
         var best = null;
         var bestScore = Infinity;

         for (k = 0; k < tracks.length; ++k) {
            var track = tracks[k];
            var last = track.members[track.members.length - 1];
            var frameGap = i - last.frameIndex;
            if (frameGap <= 0 || frameGap > opt.maxFrameGap) {
               continue;
            }
            if (angleDifference(cand.angle, last.candidate.angle) > opt.maxAngleDiff) {
               continue;
            }
            var dx = cand.cx - last.candidate.cx;
            var dy = cand.cy - last.candidate.cy;
            var shift = Math.sqrt(dx * dx + dy * dy);
            if (shift > opt.maxCentroidShift * frameGap) {
               continue;
            }
            if (shift < bestScore) {
               bestScore = shift;
               best = track;
            }
         }

         if (best === null) {
            best = { id: tracks.length, members: [] };
            tracks.push(best);
         }
         best.members.push({
            frameIndex: i,
            file: frame.file,
            candidate: cand
         });
      }
   }

   var out = [];
   for (k = 0; k < tracks.length; ++k) {
      out.push({
         id: tracks[k].id,
         length: tracks[k].members.length,
         members: tracks[k].members,
         // Anything lasting longer than a meteor plausibly can is almost
         // certainly a satellite or an aircraft. See maxMeteorFrames for why
         // the boundary is not 1.
         persistent: tracks[k].members.length > opt.maxMeteorFrames
      });
   }
   return out;
}

// --- Utility ---------------------------------------------------------------

function mergeWithDefaults(defaults, options) {
   var out = {};
   for (var k in defaults) {
      out[k] = defaults[k];
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

function shallowCopy(obj) {
   var out = {};
   for (var k in obj) {
      out[k] = obj[k];
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      angleDifference: angleDifference,
      normalizeAngle180: normalizeAngle180,
      perpendicularDistance: perpendicularDistance,
      axialGap: axialGap,
      mergeCollinear: mergeCollinear,
      matchAcrossFrames: matchAcrossFrames,
      DEFAULT_MERGE_OPTIONS: DEFAULT_MERGE_OPTIONS,
      DEFAULT_MATCH_OPTIONS: DEFAULT_MATCH_OPTIONS
   };
}
