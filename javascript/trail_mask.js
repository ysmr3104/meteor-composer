//============================================================================
// trail_mask.js - Building a feathered mask around a meteor trail
//
// Pure JavaScript, no PJSR dependency. Stage 3 of docs/requirements.md 7.2.
//
// The mask marks where a trail's light is, so that Stage 4 can add that light
// to the master and nothing else. Two properties decide whether the composite
// looks right:
//
//   it has to cover the whole trail, including the faint ends and the halo,
//   because anything left outside the mask is simply missing from the result;
//
//   and its edge has to fade, because a hard edge puts a visible seam around
//   every meteor - requirements.md 7.2 calls feathering mandatory.
//
// The shape is a capsule: the segment between the trail's endpoints, thickened
// by a radius. A rotated rectangle would clip the rounded ends where a meteor
// brightens and fades; an axis-aligned box would cover many times the area for
// a diagonal trail, and every extra pixel is sub-frame noise added to a
// master that is otherwise much cleaner.
//
// Coordinates are full-resolution image pixels. Candidates are in the 1/8
// detection field, so callers convert first (preview_geometry's centre
// mapping, not a bare multiplication).
//============================================================================

// Sized by measurement, not by rule. tests/pjsr/probe_trail_profile.js walked
// 31 accepted meteors and averaged the residual as a function of distance from
// the trail's axis:
//
//    distance from axis      light          against the residual noise
//      0 px                  9.20e-4              5.2 sigma
//      5 px                  1.75e-4              1.0 sigma
//     15 px                  9.03e-5              0.51 sigma
//     20 px                  1.62e-5              0.09 sigma
//     53 px                  ~5e-6                0.03 sigma
//
// and past the endpoints, along the axis: 0.87 sigma at the endpoint itself,
// 0.38 sigma 8 px beyond it, into the noise by 10 px.
//
// So the light is gone by 20 px. The first version of this file reached 53 px
// from the axis (median over the same 31 trails) and covered 5.18% of the
// frame; the outer two thirds of that carried no meteor at all, only the sub
// frame's noise, and the composited meteors sat in patches an operator could
// see. The mask now stops where the light does.
var DEFAULT_MASK_OPTIONS = {
   // Half-width of the solid core, in full-resolution pixels, measured out
   // from the trail's axis. Set where the light falls to the noise.
   coreRadius: 5,

   // Multiplier applied to the candidate's measured half-width, when known.
   //
   // Zero, because the measurement found no relationship to follow. minorLength
   // is measured on the 1/8 detection field, where a trail one or two pixels
   // wide is smaller than a sample, so it reports the sample grid rather than
   // the trail: the widest candidate of the night (43 px) had light out to 3 px
   // and the narrowest (8 px) out to 4 px. Scaling the core by it made masks
   // seven times wider than the light for no reason that survives measurement.
   //
   // Kept as an option rather than deleted, because the reasoning applies to
   // this 1/8 field and not necessarily to another rig's.
   coreScale: 0,

   // Width of the fade outside the core, in pixels. Reaches 20 px from the
   // axis, where the light is under a tenth of the noise.
   featherWidth: 15,

   // Extension along the trail's axis beyond each endpoint.
   //
   // The endpoints come from the extreme thresholded samples, which is where
   // the trail dropped below the detection threshold, not where it stopped
   // emitting. Without this the faint tips are cut off, and the tips are
   // exactly where a meteor's brightening and fading shows. The measured light
   // is still at 0.38 sigma 8 px out, so 10 covers it.
   endExtension: 10
};

// Distance from a point to a line segment. The mask is a level set of this,
// so everything else here is a consequence of this one function.
function distanceToSegment(px, py, x0, y0, x1, y1) {
   var dx = x1 - x0;
   var dy = y1 - y0;
   var lengthSquared = dx * dx + dy * dy;
   if (lengthSquared <= 0) {
      return Math.sqrt((px - x0) * (px - x0) + (py - y0) * (py - y0));
   }
   var t = ((px - x0) * dx + (py - y0) * dy) / lengthSquared;
   if (t < 0) {
      t = 0;
   } else if (t > 1) {
      t = 1;
   }
   var cx = x0 + t * dx;
   var cy = y0 + t * dy;
   return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}

// Smoothstep. Chosen over a linear ramp because its first derivative is zero
// at both ends: a linear fade leaves a visible crease where it meets the
// unmasked sky, which is the seam feathering exists to remove.
function smoothstep(t) {
   if (t <= 0) {
      return 0;
   }
   if (t >= 1) {
      return 1;
   }
   return t * t * (3 - 2 * t);
}

// The trail's axis, extended past both endpoints.
function extendedSegment(trail, extension) {
   var dx = trail.x1 - trail.x0;
   var dy = trail.y1 - trail.y0;
   var len = Math.sqrt(dx * dx + dy * dy);
   if (len <= 0) {
      return { x0: trail.x0, y0: trail.y0, x1: trail.x1, y1: trail.y1 };
   }
   var ux = dx / len;
   var uy = dy / len;
   return {
      x0: trail.x0 - ux * extension,
      y0: trail.y0 - uy * extension,
      x1: trail.x1 + ux * extension,
      y1: trail.y1 + uy * extension
   };
}

// Core half-width to use for this trail.
function coreRadiusFor(trail, options) {
   var opt = mergeMaskOptions(options);
   var measured = 0;
   if (typeof trail.width === "number" && trail.width > 0) {
      measured = (trail.width / 2) * opt.coreScale;
   }
   return Math.max(opt.coreRadius, measured);
}

// Mask value at one pixel: 1 inside the core, 0 beyond the feather, smoothly
// between.
function maskValueAt(px, py, trail, options) {
   var opt = mergeMaskOptions(options);
   var seg = extendedSegment(trail, opt.endExtension);
   var core = coreRadiusFor(trail, opt);
   var d = distanceToSegment(px, py, seg.x0, seg.y0, seg.x1, seg.y1);
   if (d <= core) {
      return 1;
   }
   if (d >= core + opt.featherWidth) {
      return 0;
   }
   return smoothstep(1 - (d - core) / opt.featherWidth);
}

// The rectangle the mask can be non-zero in.
//
// Returned so that callers only walk the pixels that can matter: a trail
// covers a few thousand pixels of a 24-million-pixel frame, and evaluating
// the whole frame would waste essentially all of the work.
function maskBounds(trail, imageWidth, imageHeight, options) {
   var opt = mergeMaskOptions(options);
   var seg = extendedSegment(trail, opt.endExtension);
   var reach = coreRadiusFor(trail, opt) + opt.featherWidth;

   var left = Math.floor(Math.min(seg.x0, seg.x1) - reach);
   var right = Math.ceil(Math.max(seg.x0, seg.x1) + reach);
   var top = Math.floor(Math.min(seg.y0, seg.y1) - reach);
   var bottom = Math.ceil(Math.max(seg.y0, seg.y1) + reach);

   return {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(imageWidth - 1, right),
      bottom: Math.min(imageHeight - 1, bottom),
      clipped: left < 0 || top < 0 || right > imageWidth - 1 || bottom > imageHeight - 1
   };
}

// Render one trail's mask into a plain field, the same { data, width, height }
// shape the detection core uses.
//
// `field` is reused when given, so several trails can be accumulated into one
// mask. Values are combined with max rather than added: two trails that cross
// must not produce a value above 1 there, which would brighten the crossing
// point in the composite.
function renderTrailMask(trail, width, height, options, field) {
   var out = field;
   if (!out) {
      out = { data: new Float32Array(width * height), width: width, height: height };
   }
   var bounds = maskBounds(trail, width, height, options);
   for (var y = bounds.top; y <= bounds.bottom; ++y) {
      var rowStart = y * width;
      for (var x = bounds.left; x <= bounds.right; ++x) {
         var v = maskValueAt(x, y, trail, options);
         if (v > out.data[rowStart + x]) {
            out.data[rowStart + x] = v;
         }
      }
   }
   return out;
}

// Render several trails into one mask.
function renderMask(trails, width, height, options) {
   var field = { data: new Float32Array(width * height), width: width, height: height };
   for (var i = 0; i < trails.length; ++i) {
      renderTrailMask(trails[i], width, height, options, field);
   }
   return field;
}

// How much of the frame a mask covers, and how much of that is fully opaque.
//
// Reported so that an operator can see when a mask has grown to cover a large
// part of the frame - at which point the composite stops being "the master
// plus a meteor" and starts being a blend of two images with different noise.
function maskCoverage(field) {
   var total = field.width * field.height;
   var touched = 0;
   var solid = 0;
   var sum = 0;
   for (var i = 0; i < field.data.length; ++i) {
      var v = field.data[i];
      if (v > 0) {
         ++touched;
         sum += v;
         if (v >= 1) {
            ++solid;
         }
      }
   }
   return {
      total: total,
      touched: touched,
      solid: solid,
      weightedArea: sum,
      fraction: total > 0 ? touched / total : 0
   };
}

// --- The signal-driven mask -------------------------------------------------
//
// The capsule above assumes the axis is where the light is. Measured against
// 31 accepted meteors, it is not: the endpoints come from the 1/8 detection
// field, where each carries up to 4 px of quantisation, and a small error in
// direction becomes a large displacement at the far end of a long trail.
// The light-weighted offset from the assumed axis ran to 12 px, both as a
// displacement and as a rotation, and one trail had 0% of its light within
// 6 px of its own axis and 87% within 15.
//
// So the wide capsule was covering the trails only by being wide. Narrowing it
// would have missed eight of the thirty-one rather than trimming them.
//
// This builds the mask from the light instead. The capsule becomes a corridor -
// a bound on where to look, not a claim about where the trail is - and inside
// it the mask is the region where the residual actually stands above the
// noise. It follows a displaced axis, a curved trail and a flare alike,
// because none of those are special cases to it.
//
// Two things keep it honest:
//
//   The residual is smoothed before thresholding. A trail's light is coherent
//   across neighbouring pixels and noise is not, so smoothing raises the light
//   relative to the noise by the square root of the kernel - which is what lets
//   the threshold sit low enough to catch the faint edges of a trail without
//   catching noise.
//
//   Only the region connected to the trail's core is kept. Isolated pixels that
//   crossed the threshold by chance are not part of the meteor, and a mask that
//   included them would put specks of sub-frame noise across the corridor.
//   Hysteresis with the core as the seed, which is the standard shape of this
//   problem.

var DEFAULT_SIGNAL_OPTIONS = {
   // Half-width of the corridor to search, in pixels. Wide enough to contain
   // the worst measured axis error (12 px) with room to spare, and narrow
   // enough that it cannot wander onto something unrelated.
   corridorRadius: 25,

   // Extension of the corridor along the axis past each endpoint, for the same
   // reason the capsule had one: the endpoints are where the trail crossed the
   // detection threshold, not where it stopped emitting.
   corridorExtension: 25,

   // Box smoothing radius. 2 gives a 5x5 kernel, which divides the noise by 5
   // while leaving a trail one or two pixels wide clearly above it.
   smoothRadius: 2,

   // Thresholds, in multiples of the SMOOTHED noise. Light above kHigh is
   // certainly the meteor and takes the mask to 1; below kLow it is not part
   // of the mask at all; between them the mask fades, which is what feathers
   // the edge. The fade needs no separate feather width: the light itself
   // falls off smoothly, so a smooth threshold on it gives a smooth edge that
   // ends exactly where the light does.
   // Measured: with a low threshold of 2 the growth from the core picked up
   // about 170 pixels of pure noise per trail, because 2.3% of a smoothed
   // field stands above two deviations and eight-connected growth chains them
   // together. At 3 that rate is 0.13%, an order of magnitude fewer, and what
   // it gives up is the part of a trail's halo that is already below half the
   // per-pixel noise.
   kLow: 3.0,
   kHigh: 5.0,

   // The core is always covered, however faint. It guarantees that an accepted
   // meteor always contributes something: if a trail were too faint to cross
   // the threshold anywhere, a mask built only from the light would come out
   // empty and the meteor would vanish from the composite without a word.
   //
   // It sits on the assumed axis, which the measurement says can be up to 12 px
   // from the real trail, so on those it covers empty sky. That costs a strip
   // six pixels wide of clipped noise - about 0.4 sigma, against a master noise
   // three times larger - and it buys the guarantee above.
   coreRadius: 3,
   coreExtension: 6,

   // Light above kHigh within this distance of the axis also seeds the region.
   //
   // Without it the core would be the only seed, and a trail displaced from
   // its axis by more than the core's radius would only be found if its faint
   // outskirts happened to reach back to the core. Sized to cover the worst
   // measured axis error. Beyond it, light is still masked when it is
   // CONNECTED to something that seeded - which is how a flare or a bright
   // trail's halo gets covered - but it cannot start a region of its own,
   // so a star residual out at the corridor's edge is not mistaken for the
   // meteor.
   seedRadius: 15
};

// Separable box smoothing over a rectangular buffer.
function boxSmooth(data, width, height, radius) {
   if (radius <= 0) {
      return data;
   }
   var tmp = new Float32Array(width * height);
   var out = new Float32Array(width * height);
   var x, y, i, sum, count;

   for (y = 0; y < height; ++y) {
      var row = y * width;
      for (x = 0; x < width; ++x) {
         sum = 0;
         count = 0;
         var from = x - radius < 0 ? 0 : x - radius;
         var to = x + radius >= width ? width - 1 : x + radius;
         for (i = from; i <= to; ++i) {
            sum += data[row + i];
            ++count;
         }
         tmp[row + x] = sum / count;
      }
   }
   for (x = 0; x < width; ++x) {
      for (y = 0; y < height; ++y) {
         sum = 0;
         count = 0;
         var yFrom = y - radius < 0 ? 0 : y - radius;
         var yTo = y + radius >= height ? height - 1 : y + radius;
         for (i = yFrom; i <= yTo; ++i) {
            sum += tmp[i * width + x];
            ++count;
         }
         out[y * width + x] = sum / count;
      }
   }
   return out;
}

// The rectangle to search for one trail's light: the corridor's bounds.
function corridorBounds(trail, imageWidth, imageHeight, options) {
   var opt = mergeSignalOptions(options);
   return maskBounds(trail, imageWidth, imageHeight,
                     { coreRadius: opt.corridorRadius, coreScale: 0,
                       featherWidth: 0, endExtension: opt.corridorExtension });
}

// A capsule covering the whole corridor, used to keep the trail out of the
// linear fit and out of the local-background ring. Not the mask.
function renderCorridorMask(trails, width, height, options) {
   var opt = mergeSignalOptions(options);
   return renderMask(trails, width, height,
                     { coreRadius: opt.corridorRadius, coreScale: 0,
                       featherWidth: 0, endExtension: opt.corridorExtension });
}

// Build one trail's mask from the light itself.
//
// `light` is the residual over `rect`, in rect-local order, already with the
// local sky removed. `sigma` is its per-pixel noise. The returned array is
// rect-local too: it is the caller that places it in the frame.
function renderSignalMask(light, rect, trail, sigma, options) {
   var opt = mergeSignalOptions(options);
   var rw = rect.right - rect.left + 1;
   var rh = rect.bottom - rect.top + 1;
   var out = new Float32Array(rw * rh);
   if (rw <= 0 || rh <= 0) {
      return out;
   }

   var smoothed = boxSmooth(light, rw, rh, opt.smoothRadius);

   // A box of (2r+1)^2 independent samples divides the noise by (2r+1).
   var kernel = 2 * opt.smoothRadius + 1;
   var sigmaSmoothed = sigma > 0 ? sigma / kernel : 0;
   if (!(sigmaSmoothed > 0)) {
      // With no noise estimate there is nothing to threshold against, so fall
      // back to the geometric core alone rather than masking the whole
      // corridor.
      sigmaSmoothed = Infinity;
   }

   var low = opt.kLow * sigmaSmoothed;
   var high = opt.kHigh * sigmaSmoothed;

   var coreSegment = extendedSegment(trail, opt.coreExtension);
   var corridor = extendedSegment(trail, opt.corridorExtension);

   // Pass one: classify. `state` is 0 outside the corridor, 1 for a pixel that
   // could belong (above kLow), 2 for a core pixel, which seeds the region.
   var state = new Uint8Array(rw * rh);
   var stack = [];
   var x, y, i;
   for (y = 0; y < rh; ++y) {
      var iy = rect.top + y;
      for (x = 0; x < rw; ++x) {
         i = y * rw + x;
         var ix = rect.left + x;
         // The rectangle is axis-aligned and the trail usually is not, so its
         // corners can be far outside the corridor. Distance decides, not the
         // rectangle.
         if (distanceToSegment(ix, iy, corridor.x0, corridor.y0,
                               corridor.x1, corridor.y1) > opt.corridorRadius) {
            continue;
         }
         var dCore = distanceToSegment(ix, iy, coreSegment.x0, coreSegment.y0,
                                       coreSegment.x1, coreSegment.y1);
         if (dCore <= opt.coreRadius) {
            state[i] = 2;
            stack.push(i);
         } else if (smoothed[i] > low) {
            state[i] = 1;
            if (smoothed[i] > high && dCore <= opt.seedRadius) {
               stack.push(i);
            }
         }
      }
   }

   // Pass two: grow from the core over pixels above kLow, eight-connected.
   // Anything above the threshold that does not touch the trail is not the
   // trail.
   var reached = new Uint8Array(rw * rh);
   while (stack.length > 0) {
      i = stack.pop();
      if (reached[i]) {
         continue;
      }
      reached[i] = 1;
      var cy = Math.floor(i / rw);
      var cx = i - cy * rw;
      for (var dy = -1; dy <= 1; ++dy) {
         var ny = cy + dy;
         if (ny < 0 || ny >= rh) {
            continue;
         }
         for (var dx = -1; dx <= 1; ++dx) {
            var nx = cx + dx;
            if (nx < 0 || nx >= rw) {
               continue;
            }
            var ni = ny * rw + nx;
            if (!reached[ni] && state[ni] > 0) {
               stack.push(ni);
            }
         }
      }
   }

   // Pass three: the mask value. Solid in the core, and elsewhere a smooth
   // ramp between the two thresholds, which ends the mask exactly where the
   // light ends.
   for (i = 0; i < out.length; ++i) {
      if (!reached[i]) {
         continue;
      }
      if (state[i] === 2) {
         out[i] = 1;
         continue;
      }
      var t = (smoothed[i] - low) / (high - low);
      out[i] = smoothstep(t);
   }
   return out;
}

// How much of the corridor the mask ended up using, as a check that it is
// following light rather than filling the space it was given.
function signalMaskCoverage(maskLocal, rect) {
   var touched = 0;
   var solid = 0;
   var sum = 0;
   for (var i = 0; i < maskLocal.length; ++i) {
      if (maskLocal[i] > 0) {
         ++touched;
         sum += maskLocal[i];
         if (maskLocal[i] >= 1) {
            ++solid;
         }
      }
   }
   return { touched: touched, solid: solid, weightedArea: sum,
            rectArea: maskLocal.length };
}

// --- Utility ----------------------------------------------------------------

function mergeSignalOptions(options) {
   if (options && options.__signalMerged) {
      return options;
   }
   var out = { __signalMerged: true };
   for (var k in DEFAULT_SIGNAL_OPTIONS) {
      out[k] = DEFAULT_SIGNAL_OPTIONS[k];
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


function mergeMaskOptions(options) {
   if (options && options.__merged) {
      return options;
   }
   var out = { __merged: true };
   for (var k in DEFAULT_MASK_OPTIONS) {
      out[k] = DEFAULT_MASK_OPTIONS[k];
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
      DEFAULT_MASK_OPTIONS: DEFAULT_MASK_OPTIONS,
      distanceToSegment: distanceToSegment,
      smoothstep: smoothstep,
      extendedSegment: extendedSegment,
      coreRadiusFor: coreRadiusFor,
      maskValueAt: maskValueAt,
      maskBounds: maskBounds,
      renderTrailMask: renderTrailMask,
      renderMask: renderMask,
      maskCoverage: maskCoverage,
      DEFAULT_SIGNAL_OPTIONS: DEFAULT_SIGNAL_OPTIONS,
      boxSmooth: boxSmooth,
      corridorBounds: corridorBounds,
      renderCorridorMask: renderCorridorMask,
      renderSignalMask: renderSignalMask,
      signalMaskCoverage: signalMaskCoverage
   };
}
