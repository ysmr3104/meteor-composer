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

// --- Display rotation -------------------------------------------------------
//
// The preview can be turned in quarter steps so that portrait framing is
// comfortable to work with. Rotation is display-only: candidate coordinates,
// the ground truth and everything written to disk stay in image space.
//
// Bitmap.rotated() takes DEGREES and turns CLOCKWISE for a positive angle.
// That is measured, not assumed - the reference documents no semantics and no
// script shipped with PixInsight calls the method. tests/pjsr/probe_rotation.js
// rotated a 40x20 bitmap with a marker at (2,1) by 90 and got a 20x40 bitmap
// with the marker at (18,2), which is exactly (x,y) -> (H-1-y, x).
//
// Passing radians is not an error that announces itself: Math.PI/2 is read as
// 1.57 degrees, so the image comes back very slightly tilted and slightly
// larger (41x22 in the probe) rather than turned.

function normalizeRotation(rotation) {
   var r = rotation % 360;
   if (r < 0) {
      r += 360;
   }
   return r;
}

// Dimensions after rotation. Quarter turns swap them exactly; the probe
// confirmed 6024x4024 becomes 4024x6024 with no canvas growth.
function rotatedSize(width, height, rotation) {
   var r = normalizeRotation(rotation);
   if (r === 90 || r === 270) {
      return { width: height, height: width };
   }
   return { width: width, height: height };
}

// Image pixel -> rotated display pixel.
function imageToDisplay(x, y, rotation, imageWidth, imageHeight) {
   switch (normalizeRotation(rotation)) {
      case 90:  return { x: imageHeight - 1 - y, y: x };
      case 180: return { x: imageWidth - 1 - x, y: imageHeight - 1 - y };
      case 270: return { x: y, y: imageWidth - 1 - x };
      default:  return { x: x, y: y };
   }
}

// Rotated display pixel -> image pixel. Needed for hit testing: the click
// arrives in display space and the candidates live in image space.
function displayToImage(dx, dy, rotation, imageWidth, imageHeight) {
   switch (normalizeRotation(rotation)) {
      case 90:  return { x: dy, y: imageHeight - 1 - dx };
      case 180: return { x: imageWidth - 1 - dx, y: imageHeight - 1 - dy };
      case 270: return { x: imageWidth - 1 - dy, y: dx };
      default:  return { x: dx, y: dy };
   }
}

// An axis-aligned box stays axis-aligned under a quarter turn, but its
// corners change roles, so the result has to be re-normalised: rotating
// (left, top) by 90 produces the box's top-right, not its top-left.
function rotateBox(box, rotation, imageWidth, imageHeight) {
   var a = imageToDisplay(box.left, box.top, rotation, imageWidth, imageHeight);
   var b = imageToDisplay(box.right, box.bottom, rotation, imageWidth, imageHeight);
   return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y)
   };
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
// or -1. Coordinates are in IMAGE space; a rotated preview must convert the
// click with displayToImage() first.
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
   var rotation = opt.rotation === undefined ? 0 : opt.rotation;

   // Label placement and culling happen in display space, which is what the
   // viewport actually shows; under a quarter turn the image's width and
   // height swap.
   var displaySize = rotatedSize(imageWidth, imageHeight, rotation);

   var out = [];
   for (var i = 0; i < candidates.length; ++i) {
      var box = rotateBox(candidateBox(candidates[i], scaleX, scaleY, pad),
                          rotation, imageWidth, imageHeight);

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
                               displaySize.width, displaySize.height,
                               4 / view.zoom);
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

// --- Following the selection ------------------------------------------------
//
// Moving through the candidate list while the preview is zoomed in used to
// leave the preview where it was, so the operator had to pan to find the
// candidate they had just selected. The enlarged pane was always centred on
// it, but the frame view was not.
//
// Scrolling on every selection change would be worse: most of the time the
// next candidate is already on screen, and moving the frame under the
// operator for no reason makes the view feel unstable. So this answers a
// narrower question - does the box need bringing into view, and if so, where
// to.
//
// `box` is in DISPLAY coordinates (rotation already applied, zoom not).
// `view` is { width, height, zoom, scrollX, scrollY, maxScrollX, maxScrollY }.

// Is the box fully on screen, with `margin` view pixels to spare on every
// side? The margin keeps a candidate touching the edge of the viewport from
// counting as visible: it is technically drawn, but it reads as cut off.
function boxIsVisible(box, view, margin) {
   var m = margin === undefined ? 0 : margin;
   var left = box.left * view.zoom - view.scrollX;
   var top = box.top * view.zoom - view.scrollY;
   var right = box.right * view.zoom - view.scrollX;
   var bottom = box.bottom * view.zoom - view.scrollY;
   return left >= m && top >= m
       && right <= view.width - m && bottom <= view.height - m;
}

// The scroll position that centres the box, clamped to what the scrollbars
// allow. Clamping means a candidate near the frame's edge ends up off-centre,
// which is correct: there is nothing beyond the frame to show.
function centringScroll(box, view) {
   var cx = (box.left + box.right) / 2 * view.zoom;
   var cy = (box.top + box.bottom) / 2 * view.zoom;
   return {
      x: Math.max(0, Math.min(view.maxScrollX, Math.round(cx - view.width / 2))),
      y: Math.max(0, Math.min(view.maxScrollY, Math.round(cy - view.height / 2)))
   };
}

// Where to scroll to bring the box into view, or null when nothing should
// move. Null covers three cases that all mean "leave it alone":
//
//   - the viewport has no size yet, so nothing can be reasoned about
//   - the box is already comfortably visible
//   - centring it would not change the scroll position anyway
//
// Returning null rather than the current position lets the caller skip the
// update entirely, so no repaint is queued for a view that did not move.
//
// There is deliberately NO special case for Fit. It looks like one is needed -
// stepping through the list at Fit must not move the frame - but at Fit the
// scroll range is zero on both axes, so the only legal scroll position is
// (0, 0) and centringScroll clamps to it. The no-op check below then returns
// null. An explicit `maxScroll <= 0` guard was written here first and removed
// again: deleting it changed no behaviour and no test, which is the definition
// of a branch that cannot decide anything.
function scrollToShow(box, view, margin) {
   if (view.width <= 0 || view.height <= 0) {
      return null;
   }
   if (boxIsVisible(box, view, margin)) {
      return null;
   }
   var target = centringScroll(box, view);
   if (target.x === view.scrollX && target.y === view.scrollY) {
      return null;
   }
   return target;
}

// --- Exports ---------------------------------------------------------------

if (typeof module !== "undefined") {
   module.exports = {
      sampleCentreToImage: sampleCentreToImage,
      imageToSampleCentre: imageToSampleCentre,
      sampleSpanToImage: sampleSpanToImage,
      normalizeRotation: normalizeRotation,
      rotatedSize: rotatedSize,
      imageToDisplay: imageToDisplay,
      displayToImage: displayToImage,
      rotateBox: rotateBox,
      imageToView: imageToView,
      viewToImage: viewToImage,
      candidateBounds: candidateBounds,
      candidateBox: candidateBox,
      candidateEndpoints: candidateEndpoints,
      candidateCentroid: candidateCentroid,
      labelAnchor: labelAnchor,
      hitTest: hitTest,
      layoutOverlay: layoutOverlay,
      boxIsVisible: boxIsVisible,
      centringScroll: centringScroll,
      scrollToShow: scrollToShow
   };
}
