//============================================================================
// preview_geometry.js - Coordinate math for the screening UI overlay
//
// Pure JavaScript, no PJSR dependency, so the whole of it runs under Node.js.
// The overlay's coordinate handling is the part of the UI most likely to be
// quietly wrong: nothing throws when a box is drawn 4 px off, it just stops
// lining up with the trail. Keeping it here makes it testable.
//
// Three coordinate spaces are in play:
//
//   detection    the 1/8 downsampled field the detector ran on. Candidate
//                cx/cy, endpoints and bbox are all in this space.
//   image        full-resolution pixels. The preview renders at 1:1
//                (docs/requirements.md 7.1), so this is also bitmap space.
//   view         what is on screen: image * zoom, minus the scroll offset.
//
// Converting detection -> image takes TWO different formulas, and using the
// wrong one is the bug this module exists to prevent:
//
//   a POINT (centroid, endpoint) maps to the CENTRE of its sample:
//       (n + 0.5) * scale - 0.5
//   a BOX EDGE maps to the SPAN the samples cover:
//       left  = n0 * scale
//       right = (n1 + 1) * scale - 1
//
// Multiplying a point by `scale` alone lands on the sample's top-left corner,
// off by up to scale/2 - 4 px at scale 8. A meteor trail is 1-2 px wide, so
// that is enough to miss it completely. tests/pjsr/probe_preview.js hit this
// exact bug and could not find the trail it was measuring until it was fixed.
//============================================================================

// --- detection <-> image ----------------------------------------------------

// Centre of detection sample n, in image pixels. For points.
function sampleCentreToImage(n, scale) {
   return (n + 0.5) * scale - 0.5;
}

// Inverse of sampleCentreToImage.
function imageToSampleCentre(v, scale) {
   return (v + 0.5) / scale - 0.5;
}

// The image-pixel span covered by detection samples n0..n1 inclusive. For
// box edges, where the extent matters rather than the centre.
function sampleSpanToImage(n0, n1, scale) {
   return { start: n0 * scale, end: (n1 + 1) * scale - 1 };
}

// --- image <-> view ---------------------------------------------------------

function imageToView(x, y, zoom, scrollX, scrollY) {
   return { x: x * zoom - scrollX, y: y * zoom - scrollY };
}

function viewToImage(vx, vy, zoom, scrollX, scrollY) {
   return { x: (vx + scrollX) / zoom, y: (vy + scrollY) / zoom };
}

// --- Candidate geometry -----------------------------------------------------

// A candidate's bounds in detection samples.
//
// `bbox` is what detection_core produces now, but candidate lists saved
// before it existed do not carry one, and those files are still worth
// loading: rerunning a detection over 654 frames costs eight minutes, and
// docs/requirements.md 7 makes rescreening an old result an explicit
// use case. So fall back to the endpoints, which every version has recorded.
//
// The fallback box is slightly tighter than the real one, because the
// endpoints lie on the trail's axis while the true bounding box also covers
// its width. `minorLength` corrects for that when it is present; without it
// the box can clip the trail by a sample or so, which the caller's `pad`
// covers in practice.
function candidateBounds(candidate) {
   if (candidate.bbox !== undefined && candidate.bbox !== null) {
      return {
         left: candidate.bbox.left, top: candidate.bbox.top,
         right: candidate.bbox.right, bottom: candidate.bbox.bottom
      };
   }
   var half = 0;
   if (typeof candidate.minorLength === "number" && candidate.minorLength > 0) {
      half = candidate.minorLength / 2;
   }
   return {
      left: Math.floor(Math.min(candidate.x0, candidate.x1) - half),
      top: Math.floor(Math.min(candidate.y0, candidate.y1) - half),
      right: Math.ceil(Math.max(candidate.x0, candidate.x1) + half),
      bottom: Math.ceil(Math.max(candidate.y0, candidate.y1) + half)
   };
}

// A candidate's axis-aligned bounding box in image pixels.
//
// requirements.md 7.1 settled on axis-aligned boxes: the concern was that a
// diagonal trail's bounding box is many times the trail's own area and that
// boxes would overlap in crowded frames, but the measurement found 0
// overlapping pairs out of 162 in the real session.
//
// `pad` grows the box outwards so the trail is not drawn on by its own
// outline; it is in image pixels.
function candidateBox(candidate, scaleX, scaleY, pad) {
   if (pad === undefined) {
      pad = 0;
   }
   var b = candidateBounds(candidate);
   var h = sampleSpanToImage(b.left, b.right, scaleX);
   var v = sampleSpanToImage(b.top, b.bottom, scaleY);
   return {
      left: h.start - pad,
      top: v.start - pad,
      right: h.end + pad,
      bottom: v.end + pad
   };
}

// A candidate's endpoints in image pixels. Points, so centre mapping.
function candidateEndpoints(candidate, scaleX, scaleY) {
   return {
      x0: sampleCentreToImage(candidate.x0, scaleX),
      y0: sampleCentreToImage(candidate.y0, scaleY),
      x1: sampleCentreToImage(candidate.x1, scaleX),
      y1: sampleCentreToImage(candidate.y1, scaleY)
   };
}

function candidateCentroid(candidate, scaleX, scaleY) {
   return {
      x: sampleCentreToImage(candidate.cx, scaleX),
      y: sampleCentreToImage(candidate.cy, scaleY)
   };
}

// --- Label placement --------------------------------------------------------

// Where to put a candidate's number so that it never lands on the trail.
//
// requirements.md 7.1: "the number is drawn offset so it does not overlap the
// trail". Placing it strictly outside the bounding box guarantees that
// without needing to know where inside the box the trail runs.
//
// Preference is above the box; if there is no room, below. The x is clamped
// so the label stays inside the image.
function labelAnchor(box, labelWidth, labelHeight, imageWidth, imageHeight, gap) {
   if (gap === undefined) {
      gap = 4;
   }
   var y = box.top - gap - labelHeight;
   if (y < 0) {
      y = box.bottom + gap;
      if (y + labelHeight > imageHeight) {
         // No room either side: sit just inside the top edge. The box is
         // taller than the image here, so overlap is unavoidable.
         y = 0;
      }
   }
   var x = box.left;
   if (x + labelWidth > imageWidth) {
      x = imageWidth - labelWidth;
   }
   if (x < 0) {
      x = 0;
   }
   return { x: x, y: y };
}

// --- Hit testing ------------------------------------------------------------

// Which candidate did the user click on? Returns an index into `candidates`,
// or -1.
//
// When boxes overlap, the smallest wins. A large box that happens to enclose
// a small one would otherwise make the small one unclickable, and the small
// one is the more specific target.
function hitTest(candidates, imageX, imageY, scaleX, scaleY, pad) {
   var best = -1;
   var bestArea = Infinity;
   for (var i = 0; i < candidates.length; ++i) {
      var box = candidateBox(candidates[i], scaleX, scaleY, pad);
      if (imageX < box.left || imageX > box.right
          || imageY < box.top || imageY > box.bottom) {
         continue;
      }
      var area = (box.right - box.left + 1) * (box.bottom - box.top + 1);
      if (area < bestArea) {
         bestArea = area;
         best = i;
      }
   }
   return best;
}

// --- Overlay layout ---------------------------------------------------------

// Everything the paint handler needs, in view coordinates, already culled.
//
// The paint handler should not compute geometry: it runs inside PJSR where it
// cannot be tested, and it runs on every repaint.
//
// `view` is { width, height, zoom, scrollX, scrollY }.
// `labelSize` is { width, height } of a rendered number, in view pixels.
function layoutOverlay(candidates, scaleX, scaleY, view, options) {
   var opt = options || {};
   var pad = opt.pad === undefined ? 0 : opt.pad;
   var labelSize = opt.labelSize || { width: 14, height: 12 };
   var imageWidth = opt.imageWidth === undefined ? Infinity : opt.imageWidth;
   var imageHeight = opt.imageHeight === undefined ? Infinity : opt.imageHeight;
   var margin = opt.margin === undefined ? 24 : opt.margin;

   var out = [];
   for (var i = 0; i < candidates.length; ++i) {
      var box = candidateBox(candidates[i], scaleX, scaleY, pad);

      var tl = imageToView(box.left, box.top, view.zoom, view.scrollX, view.scrollY);
      var br = imageToView(box.right, box.bottom, view.zoom, view.scrollX, view.scrollY);

      // Cull with a margin so a box just off screen does not pop in late.
      if (br.x < -margin || br.y < -margin
          || tl.x > view.width + margin || tl.y > view.height + margin) {
         continue;
      }

      // The label is placed in image space (so the "outside the box" rule is
      // about the image, not the current zoom), then converted.
      var labelImageW = labelSize.width / view.zoom;
      var labelImageH = labelSize.height / view.zoom;
      var anchor = labelAnchor(box, labelImageW, labelImageH,
                               imageWidth, imageHeight, 4 / view.zoom);
      var labelView = imageToView(anchor.x, anchor.y,
                                  view.zoom, view.scrollX, view.scrollY);

      out.push({
         index: i,
         box: { left: tl.x, top: tl.y, right: br.x, bottom: br.y },
         label: { x: labelView.x, y: labelView.y }
      });
   }
   return out;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      sampleCentreToImage: sampleCentreToImage,
      imageToSampleCentre: imageToSampleCentre,
      sampleSpanToImage: sampleSpanToImage,
      imageToView: imageToView,
      viewToImage: viewToImage,
      candidateBounds: candidateBounds,
      candidateBox: candidateBox,
      candidateEndpoints: candidateEndpoints,
      candidateCentroid: candidateCentroid,
      labelAnchor: labelAnchor,
      hitTest: hitTest,
      layoutOverlay: layoutOverlay
   };
}
