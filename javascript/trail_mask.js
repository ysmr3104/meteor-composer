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

// --- Utility ----------------------------------------------------------------

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
      maskCoverage: maskCoverage
   };
}
