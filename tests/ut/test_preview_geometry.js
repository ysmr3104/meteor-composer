//============================================================================
// test_preview_geometry.js - Small tests for the overlay coordinate math
//
// Run: node tests/ut/test_preview_geometry.js
//
// Expected values are derived by hand from the definitions of the two
// mappings, never by calling the implementation back (docs/tests.md 3-2).
//
// The distinction the tests exist to pin down: a POINT maps to the centre of
// its sample, a BOX EDGE maps to the span the samples cover. They differ by
// up to scale/2, which is 4 px at scale 8 - wider than a meteor trail.
//============================================================================

var geom = require("../../javascript/preview_geometry.js");

var passed = 0;
var failed = 0;
var failures = [];

function ok(condition, message) {
   if (condition) {
      ++passed;
   } else {
      ++failed;
      failures.push(message);
      console.log("  FAIL: " + message);
   }
}

function close(actual, expected, tolerance, message) {
   var diff = Math.abs(actual - expected);
   ok(diff <= tolerance,
      message + " (expected " + expected + ", got " + actual + ", diff " + diff + ")");
}

function suite(name, fn) {
   console.log("\n=== " + name + " ===");
   fn();
}

// A candidate as detection_core would emit it, in detection samples.
function candidate(bbox, ends) {
   return {
      cx: (bbox.left + bbox.right) / 2,
      cy: (bbox.top + bbox.bottom) / 2,
      x0: ends[0], y0: ends[1], x1: ends[2], y1: ends[3],
      bbox: {
         left: bbox.left, top: bbox.top, right: bbox.right, bottom: bbox.bottom,
         width: bbox.right - bbox.left + 1,
         height: bbox.bottom - bbox.top + 1
      }
   };
}

//----------------------------------------------------------------------------

suite("sampleCentreToImage: points land on the centre of their sample", function () {
   // Sample 0 at scale 8 represents full-resolution pixels 0..7. Its centre
   // sits between pixels 3 and 4, i.e. 3.5.
   close(geom.sampleCentreToImage(0, 8), 3.5, 1e-9, "sample 0, scale 8 -> 3.5");
   // Sample 1 covers 8..15, centre 11.5.
   close(geom.sampleCentreToImage(1, 8), 11.5, 1e-9, "sample 1, scale 8 -> 11.5");
   // Sample 100 covers 800..807, centre 803.5.
   close(geom.sampleCentreToImage(100, 8), 803.5, 1e-9, "sample 100, scale 8 -> 803.5");

   // Scale 1 is the identity: a sample is a pixel and its centre is itself.
   close(geom.sampleCentreToImage(0, 1), 0, 1e-9, "scale 1 is the identity at 0");
   close(geom.sampleCentreToImage(37, 1), 37, 1e-9, "scale 1 is the identity at 37");

   // The naive conversion (multiply by scale) is what the probe got wrong.
   // At scale 8 it is short by exactly 3.5 px, half a sample minus half a
   // pixel. Asserting the size of the error keeps the reason on record.
   var naive = 100 * 8;
   close(geom.sampleCentreToImage(100, 8) - naive, 3.5, 1e-9,
        "naive n*scale is short by scale/2 - 0.5");
});

suite("imageToSampleCentre: round trips", function () {
   var scales = [1, 2, 3, 8];
   for (var s = 0; s < scales.length; ++s) {
      for (var n = 0; n < 5; ++n) {
         close(geom.imageToSampleCentre(geom.sampleCentreToImage(n, scales[s]), scales[s]),
               n, 1e-9, "round trip n=" + n + " scale=" + scales[s]);
      }
   }
});

suite("sampleSpanToImage: box edges cover the whole span", function () {
   // Samples 0..0 at scale 8 cover pixels 0..7.
   var one = geom.sampleSpanToImage(0, 0, 8);
   close(one.start, 0, 1e-9, "single sample starts at 0");
   close(one.end, 7, 1e-9, "single sample ends at 7");

   // Samples 2..4 at scale 8 cover pixels 16..39.
   var many = geom.sampleSpanToImage(2, 4, 8);
   close(many.start, 16, 1e-9, "samples 2..4 start at 16");
   close(many.end, 39, 1e-9, "samples 2..4 end at 39");

   // The span is exactly (count * scale) pixels wide.
   ok(many.end - many.start + 1 === 3 * 8, "3 samples at scale 8 span 24 px");

   // A span edge is NOT the same as a point mapping. Conflating them is the
   // bug this module exists to prevent.
   ok(geom.sampleSpanToImage(2, 4, 8).start !== geom.sampleCentreToImage(2, 8),
      "span start and centre differ");
});

suite("candidateBox: bounding box in image pixels", function () {
   var c = candidate({ left: 10, top: 20, right: 12, bottom: 21 }, [10, 20, 12, 21]);
   var box = geom.candidateBox(c, 8, 8, 0);
   close(box.left, 80, 1e-9, "left edge = 10 * 8");
   close(box.top, 160, 1e-9, "top edge = 20 * 8");
   close(box.right, 103, 1e-9, "right edge = (12 + 1) * 8 - 1");
   close(box.bottom, 175, 1e-9, "bottom edge = (21 + 1) * 8 - 1");

   var padded = geom.candidateBox(c, 8, 8, 5);
   close(padded.left, 75, 1e-9, "padding grows the box outwards on the left");
   close(padded.right, 108, 1e-9, "padding grows the box outwards on the right");

   // Non-square scaling, as would happen if width and height did not divide
   // evenly by the same factor.
   var rect = geom.candidateBox(c, 8, 4, 0);
   close(rect.top, 80, 1e-9, "top uses scaleY");
   close(rect.bottom, 87, 1e-9, "bottom uses scaleY");
});

suite("candidateBounds: falls back to the endpoints when bbox is absent", function () {
   // Candidate lists saved before detection_core recorded a bbox are still
   // loadable; the real 2026-08-12 run is one of them. Reading `bbox` blindly
   // threw for every candidate in that file.
   var legacy = {
      cx: 236.8, cy: 135.1,
      x0: 225, y0: 114, x1: 247, y1: 160,
      length: 51.0, angle: 64.1, elongation: 9.1, pixelCount: 198,
      majorLength: 51.6, minorLength: 5.66
   };

   var b = geom.candidateBounds(legacy);
   // Endpoints span x 225..247, widened by minorLength/2 = 2.83 and rounded
   // outwards, so 222..250.
   ok(b.left === 222, "left comes from the lower endpoint minus half the minor axis");
   ok(b.right === 250, "right comes from the upper endpoint plus half the minor axis");
   ok(b.top === 111, "top likewise");
   ok(b.bottom === 163, "bottom likewise");

   // The endpoints must lie inside the derived box, otherwise the overlay
   // would not contain the trail it is meant to mark.
   ok(b.left <= Math.min(legacy.x0, legacy.x1)
      && b.right >= Math.max(legacy.x0, legacy.x1),
      "the derived box contains both endpoints in x");
   ok(b.top <= Math.min(legacy.y0, legacy.y1)
      && b.bottom >= Math.max(legacy.y0, legacy.y1),
      "the derived box contains both endpoints in y");

   // Endpoints in either order give the same box.
   var reversed = geom.candidateBounds({
      x0: 247, y0: 160, x1: 225, y1: 114, minorLength: 5.66
   });
   ok(reversed.left === b.left && reversed.right === b.right,
      "endpoint order does not matter");

   // Without minorLength the box still forms, just tighter.
   var noMinor = geom.candidateBounds({ x0: 225, y0: 114, x1: 247, y1: 160 });
   ok(noMinor.left === 225 && noMinor.right === 247,
      "without a minor axis the box is the endpoint span");

   // An explicit bbox always wins over the fallback.
   var withBox = geom.candidateBounds({
      x0: 0, y0: 0, x1: 1, y1: 1,
      bbox: { left: 10, top: 20, right: 12, bottom: 21 }
   });
   ok(withBox.left === 10 && withBox.right === 12, "an explicit bbox takes priority");

   // candidateBox has to work on a legacy candidate end to end.
   var box = geom.candidateBox(legacy, 8, 8, 0);
   ok(box.left === 222 * 8, "candidateBox uses the fallback bounds");
   ok(box.right === (250 + 1) * 8 - 1, "and still maps the span, not the centre");

   // A degenerate candidate (a single sample) must not produce an inverted box.
   var dot = geom.candidateBounds({ x0: 5, y0: 5, x1: 5, y1: 5 });
   ok(dot.left <= dot.right && dot.top <= dot.bottom, "a single-sample box is not inverted");
});

suite("candidateEndpoints: endpoints use the centre mapping", function () {
   var c = candidate({ left: 10, top: 20, right: 12, bottom: 21 }, [10, 20, 12, 21]);
   var e = geom.candidateEndpoints(c, 8, 8);
   close(e.x0, 83.5, 1e-9, "x0 = (10 + 0.5) * 8 - 0.5");
   close(e.y0, 163.5, 1e-9, "y0 = (20 + 0.5) * 8 - 0.5");
   close(e.x1, 99.5, 1e-9, "x1 = (12 + 0.5) * 8 - 0.5");
   close(e.y1, 171.5, 1e-9, "y1 = (21 + 0.5) * 8 - 0.5");

   // Endpoints must sit inside the box that was built from the same bbox.
   var box = geom.candidateBox(c, 8, 8, 0);
   ok(e.x0 >= box.left && e.x1 <= box.right, "endpoints lie within the box in x");
   ok(e.y0 >= box.top && e.y1 <= box.bottom, "endpoints lie within the box in y");
});

suite("rotation: matches what Bitmap.rotated() actually does", function () {
   // The reference expectation here is measured, not derived:
   // tests/pjsr/probe_rotation.js rotated a 40x20 bitmap whose only lit pixel
   // was at (2,1) and PixInsight returned a 20x40 bitmap with that pixel at
   // (18,2). If this assertion ever fails, the preview and the overlay have
   // stopped agreeing with the bitmap they are drawn on.
   var W = 40, H = 20;
   var r90 = geom.imageToDisplay(2, 1, 90, W, H);
   ok(r90.x === 18 && r90.y === 2,
      "90 CW sends (2,1) to (18,2), as PixInsight does");

   var size90 = geom.rotatedSize(W, H, 90);
   ok(size90.width === 20 && size90.height === 40, "90 swaps the dimensions");

   // The probe's half-turn result, also measured.
   var r180 = geom.imageToDisplay(2, 1, 180, W, H);
   ok(r180.x === 37 && r180.y === 18, "180 sends (2,1) to (37,18), as PixInsight does");
   var size180 = geom.rotatedSize(W, H, 180);
   ok(size180.width === 40 && size180.height === 20, "180 keeps the dimensions");

   // Corners go where corners should go.
   var tl = geom.imageToDisplay(0, 0, 90, W, H);
   ok(tl.x === H - 1 && tl.y === 0, "90 sends the top-left corner to the top-right");

   // Round trips, every quarter and both directions.
   var rotations = [0, 90, 180, 270, 360, -90];
   for (var i = 0; i < rotations.length; ++i) {
      var rot = rotations[i];
      var points = [[0, 0], [2, 1], [39, 19], [17, 8]];
      for (var j = 0; j < points.length; ++j) {
         var d = geom.imageToDisplay(points[j][0], points[j][1], rot, W, H);
         var back = geom.displayToImage(d.x, d.y, rot, W, H);
         ok(back.x === points[j][0] && back.y === points[j][1],
            "round trip at " + rot + " for (" + points[j] + ")");
      }
   }

   // -90 and 270 are the same turn.
   var a = geom.imageToDisplay(5, 3, -90, W, H);
   var b = geom.imageToDisplay(5, 3, 270, W, H);
   ok(a.x === b.x && a.y === b.y, "-90 and 270 agree");
   var c = geom.imageToDisplay(5, 3, 360, W, H);
   ok(c.x === 5 && c.y === 3, "360 is the identity");

   // Four quarter turns return to the start.
   var p = { x: 7, y: 4 };
   var q = geom.imageToDisplay(p.x, p.y, 90, W, H);          // now 20x40
   var q2 = geom.imageToDisplay(q.x, q.y, 90, H, W);         // back to 40x20
   var q3 = geom.imageToDisplay(q2.x, q2.y, 90, W, H);
   var q4 = geom.imageToDisplay(q3.x, q3.y, 90, H, W);
   ok(q4.x === p.x && q4.y === p.y, "four quarter turns are the identity");

   // A rotated box must stay a proper box: rotating (left,top) by 90 gives
   // the top-RIGHT corner, so the result needs re-normalising.
   var box = { left: 2, top: 1, right: 10, bottom: 5 };
   var rb = geom.rotateBox(box, 90, W, H);
   ok(rb.left <= rb.right && rb.top <= rb.bottom, "the rotated box is not inverted");
   // Its extent swaps: 9 wide x 5 tall becomes 5 wide x 9 tall.
   ok(rb.right - rb.left === 4, "width becomes the old height");
   ok(rb.bottom - rb.top === 8, "height becomes the old width");
   // Every corner of the original lands inside the rotated box.
   var corners = [[2, 1], [10, 1], [2, 5], [10, 5]];
   for (var k = 0; k < corners.length; ++k) {
      var cd = geom.imageToDisplay(corners[k][0], corners[k][1], 90, W, H);
      ok(cd.x >= rb.left && cd.x <= rb.right && cd.y >= rb.top && cd.y <= rb.bottom,
         "corner (" + corners[k] + ") lies inside the rotated box");
   }

   ok(geom.rotateBox(box, 0, W, H).left === 2, "no rotation leaves the box alone");
});

suite("layoutOverlay honours rotation", function () {
   var c = candidate({ left: 0, top: 0, right: 1, bottom: 1 }, [0, 0, 1, 1]);
   var view = { width: 4000, height: 4000, zoom: 1.0, scrollX: 0, scrollY: 0 };
   var opts = { imageWidth: 6024, imageHeight: 4024 };

   var upright = geom.layoutOverlay([c], 8, 8, view, opts);
   ok(upright.length === 1, "the candidate is laid out unrotated");
   close(upright[0].box.left, 0, 1e-9, "unrotated box starts at the left edge");

   // Rotated 90 CW, a candidate at the image's top-left appears at the
   // display's top-right, so its box must move.
   var turnedOpts = { imageWidth: 6024, imageHeight: 4024, rotation: 90 };
   var turned = geom.layoutOverlay([c], 8, 8, view, turnedOpts);
   ok(turned.length === 1, "the candidate is still laid out when rotated");
   ok(turned[0].box.left > upright[0].box.left,
      "a top-left candidate moves right when the view is turned 90 CW");
   ok(turned[0].box.left <= 4024, "and stays within the rotated width");
});

suite("imageToView / viewToImage", function () {
   var v = geom.imageToView(100, 200, 2.0, 30, 40);
   close(v.x, 170, 1e-9, "100 * 2 - 30");
   close(v.y, 360, 1e-9, "200 * 2 - 40");

   var back = geom.viewToImage(v.x, v.y, 2.0, 30, 40);
   close(back.x, 100, 1e-9, "x round trips");
   close(back.y, 200, 1e-9, "y round trips");

   // Fractional zoom, as fitToWindow produces.
   var z = 6024 / 1000;
   var f = geom.viewToImage(geom.imageToView(4013, 2011, z, 7, 9).x,
                            geom.imageToView(4013, 2011, z, 7, 9).y, z, 7, 9);
   close(f.x, 4013, 1e-6, "round trips at fractional zoom");
});

suite("hitTest", function () {
   // Two boxes: a large one and a small one inside it.
   var big = candidate({ left: 0, top: 0, right: 20, bottom: 20 }, [0, 0, 20, 20]);
   var small = candidate({ left: 5, top: 5, right: 6, bottom: 6 }, [5, 5, 6, 6]);
   var list = [big, small];

   // A point inside only the large box.
   ok(geom.hitTest(list, 8, 150, 8, 8, 0) === 0, "point in the large box only");

   // A point inside both: the smaller wins, because the larger would
   // otherwise make it unreachable.
   var inSmall = geom.hitTest(list, 44, 44, 8, 8, 0);
   ok(inSmall === 1, "overlapping boxes resolve to the smaller one");

   // Outside everything.
   ok(geom.hitTest(list, 5000, 5000, 8, 8, 0) === -1, "miss returns -1");

   // Exactly on the boundary counts as a hit; a pixel outside does not.
   ok(geom.hitTest([small], 40, 40, 8, 8, 0) === 0, "left/top edge is inclusive");
   ok(geom.hitTest([small], 55, 55, 8, 8, 0) === 0, "right/bottom edge is inclusive");
   ok(geom.hitTest([small], 39, 40, 8, 8, 0) === -1, "one pixel left of the box misses");
   ok(geom.hitTest([small], 56, 55, 8, 8, 0) === -1, "one pixel right of the box misses");

   // Padding widens the target.
   ok(geom.hitTest([small], 39, 40, 8, 8, 4) === 0, "padding makes the near miss a hit");

   ok(geom.hitTest([], 0, 0, 8, 8, 0) === -1, "empty list returns -1");
});

suite("labelAnchor: the number never overlaps the box", function () {
   var box = { left: 100, top: 100, right: 200, bottom: 140 };

   var above = geom.labelAnchor(box, 14, 12, 6024, 4024, 4);
   close(above.y, 84, 1e-9, "sits above the box: top - gap - height");
   ok(above.y + 12 <= box.top, "label bottom is above the box top");
   close(above.x, 100, 1e-9, "aligned with the box left edge");

   // No room above: flip below.
   var atTop = { left: 100, top: 3, right: 200, bottom: 40 };
   var below = geom.labelAnchor(atTop, 14, 12, 6024, 4024, 4);
   ok(below.y >= atTop.bottom, "flips below when there is no room above");

   // Near the right edge the label is pulled back inside the image.
   var atRight = { left: 6020, top: 100, right: 6023, bottom: 140 };
   var pulled = geom.labelAnchor(atRight, 14, 12, 6024, 4024, 4);
   ok(pulled.x + 14 <= 6024, "label stays inside the image on the right");
   ok(pulled.x >= 0, "label stays inside the image on the left");

   // A box taller than the image has no valid side; the label is clamped
   // rather than pushed off screen.
   var huge = { left: 0, top: -10, right: 100, bottom: 5000 };
   var clamped = geom.labelAnchor(huge, 14, 12, 6024, 4024, 4);
   ok(clamped.y >= 0, "degenerate box still yields an on-screen label");
});

suite("layoutOverlay", function () {
   var c = candidate({ left: 10, top: 10, right: 12, bottom: 11 }, [10, 10, 12, 11]);
   var view = { width: 800, height: 600, zoom: 1.0, scrollX: 0, scrollY: 0 };

   var laid = geom.layoutOverlay([c], 8, 8, view,
                                 { imageWidth: 6024, imageHeight: 4024 });
   ok(laid.length === 1, "one visible candidate is laid out");
   ok(laid[0].index === 0, "the original index is carried through");
   close(laid[0].box.left, 80, 1e-9, "box left in view coords at zoom 1");
   close(laid[0].box.right, 103, 1e-9, "box right in view coords at zoom 1");

   // Scrolled and zoomed.
   var view2 = { width: 800, height: 600, zoom: 2.0, scrollX: 100, scrollY: 50 };
   var laid2 = geom.layoutOverlay([c], 8, 8, view2,
                                  { imageWidth: 6024, imageHeight: 4024 });
   close(laid2[0].box.left, 80 * 2 - 100, 1e-9, "box left honours zoom and scroll");
   close(laid2[0].box.top, 80 * 2 - 50, 1e-9, "box top honours zoom and scroll");

   // Off screen candidates are culled.
   var far = candidate({ left: 700, top: 700, right: 702, bottom: 701 },
                       [700, 700, 702, 701]);
   var culled = geom.layoutOverlay([far], 8, 8, view,
                                   { imageWidth: 6024, imageHeight: 4024 });
   ok(culled.length === 0, "a candidate outside the viewport is culled");

   // Culling must not renumber the survivors: the label has to match the
   // candidate list row, so index refers to the input array.
   var mixed = geom.layoutOverlay([far, c], 8, 8, view,
                                  { imageWidth: 6024, imageHeight: 4024 });
   ok(mixed.length === 1, "only the visible one survives");
   ok(mixed[0].index === 1, "the surviving entry keeps its original index");
});

//----------------------------------------------------------------------------

suite("boxIsVisible: the margin decides what counts as on screen", function () {
   var view = { width: 800, height: 600, zoom: 1.0, scrollX: 0, scrollY: 0,
                maxScrollX: 5224, maxScrollY: 3424 };

   // Comfortably inside.
   ok(geom.boxIsVisible({ left: 100, top: 100, right: 200, bottom: 150 },
                        view, 24),
      "a box well inside the viewport is visible");

   // Straddling the right edge.
   ok(!geom.boxIsVisible({ left: 700, top: 100, right: 900, bottom: 150 },
                         view, 0),
      "a box running past the right edge is not visible");

   // Exactly on the edge. Visible with no margin, not visible once a margin
   // is asked for - this is the whole point of the margin.
   ok(geom.boxIsVisible({ left: 0, top: 0, right: 800, bottom: 600 },
                        view, 0),
      "a box exactly filling the viewport is visible with no margin");
   ok(!geom.boxIsVisible({ left: 0, top: 0, right: 800, bottom: 600 },
                         view, 1),
      "the same box is not visible once 1 px of margin is required");

   // Scroll and zoom are both applied: display 900 at zoom 2 minus scroll
   // 1000 lands at 800, the far edge.
   var view2 = { width: 800, height: 600, zoom: 2.0, scrollX: 1000,
                 scrollY: 0, maxScrollX: 5224, maxScrollY: 3424 };
   ok(geom.boxIsVisible({ left: 500, top: 10, right: 900, bottom: 100 },
                        view2, 0),
      "zoom and scroll are both honoured");
   ok(!geom.boxIsVisible({ left: 499, top: 10, right: 900, bottom: 100 },
                         view2, 0),
      "one display pixel further left at zoom 2 falls off the near edge");
});

//----------------------------------------------------------------------------

suite("centringScroll: centres the box, clamped to the scroll range", function () {
   var view = { width: 800, height: 600, zoom: 1.0, scrollX: 0, scrollY: 0,
                maxScrollX: 5224, maxScrollY: 3424 };

   // Box centre at (2000, 1500); half the viewport is (400, 300).
   var s = geom.centringScroll({ left: 1950, top: 1450, right: 2050,
                                 bottom: 1550 }, view);
   ok(s.x === 1600, "scrollX puts the box centre at the viewport centre");
   ok(s.y === 1200, "scrollY puts the box centre at the viewport centre");

   // Near the top-left corner the ideal scroll is negative, so it clamps to 0
   // and the box ends up off-centre. That is correct: there is nothing beyond
   // the frame to show.
   var corner = geom.centringScroll({ left: 0, top: 0, right: 40, bottom: 40 },
                                    view);
   ok(corner.x === 0 && corner.y === 0, "clamps at the near edge");

   // Same at the far edge.
   var far = geom.centringScroll({ left: 6000, top: 4000, right: 6024,
                                   bottom: 4024 }, view);
   ok(far.x === view.maxScrollX && far.y === view.maxScrollY,
      "clamps at the far edge");

   // Zoom multiplies the display coordinate before centring.
   var view2 = { width: 800, height: 600, zoom: 2.0, scrollX: 0, scrollY: 0,
                 maxScrollX: 11248, maxScrollY: 7448 };
   var z = geom.centringScroll({ left: 950, top: 450, right: 1050,
                                 bottom: 550 }, view2);
   ok(z.x === 2 * 1000 - 400, "centring accounts for zoom on x");
   ok(z.y === 2 * 500 - 300, "centring accounts for zoom on y");
});

//----------------------------------------------------------------------------

suite("scrollToShow: moves only when it has to", function () {
   var box = { left: 3000, top: 2000, right: 3040, bottom: 2040 };

   // Fit: the whole frame is on screen, so there is nothing to scroll. This is
   // the case that must not move - the operator stepping through a list at Fit
   // should see a still frame. There is no dedicated branch for it; the zero
   // scroll range leaves centring nowhere to go.
   var fit = { width: 800, height: 600, zoom: 0.125, scrollX: 0, scrollY: 0,
               maxScrollX: 0, maxScrollY: 0 };
   ok(geom.scrollToShow(box, fit, 24) === null,
      "at Fit nothing scrolls, even for a candidate far from the centre");

   // Same at Fit for a candidate in the frame's corner, which falls inside the
   // margin and so does not count as visible. It still must not move.
   ok(geom.scrollToShow({ left: 0, top: 0, right: 8, bottom: 8 }, fit, 24)
      === null,
      "nor for a candidate in the corner of the frame at Fit");

   // No viewport yet. Before the first resize the viewport reports zero size,
   // and every comparison against it is meaningless: a box would be judged
   // off screen and the frame yanked to a position computed from nothing.
   var unsized = { width: 0, height: 0, zoom: 1.0, scrollX: 0, scrollY: 0,
                   maxScrollX: 5224, maxScrollY: 3424 };
   ok(geom.scrollToShow(box, unsized, 24) === null,
      "a viewport with no size does not scroll");

   // Zoomed in, candidate off screen: bring it to the middle.
   var away = { width: 800, height: 600, zoom: 1.0, scrollX: 0, scrollY: 0,
                maxScrollX: 5224, maxScrollY: 3424 };
   var target = geom.scrollToShow(box, away, 24);
   ok(target !== null, "an off-screen candidate is brought into view");
   ok(target.x === 3020 - 400 && target.y === 2020 - 300,
      "and it is centred when it moves");

   // Zoomed in, candidate already comfortably on screen: leave it alone. The
   // view staying put while stepping through nearby candidates is the point.
   //
   // The scroll here is deliberately NOT the centring one. Picking a scroll
   // that already centres the box would let this pass even without the
   // already-visible check, because the centring result would equal the
   // current position and the no-op check would catch it instead. Off-centre
   // but visible is the only state that pins this behaviour down.
   var near = { width: 800, height: 600, zoom: 1.0, scrollX: 2400,
                scrollY: 1600, maxScrollX: 5224, maxScrollY: 3424 };
   ok(geom.boxIsVisible(box, near, 24), "the box really is on screen here");
   ok(geom.centringScroll(box, near).x !== near.scrollX,
      "and it is off-centre, so centring would move the view");
   ok(geom.scrollToShow(box, near, 24) === null,
      "a candidate already in view does not move the frame");

   // Off screen, but centring would not change the scroll: still null, so no
   // repaint is queued for a view that did not move. A box at the very corner
   // of the frame clamps to the scroll position we are already at.
   var atCorner = { width: 800, height: 600, zoom: 1.0, scrollX: 0,
                    scrollY: 0, maxScrollX: 5224, maxScrollY: 3424 };
   var cornerBox = { left: 0, top: 0, right: 4, bottom: 4 };
   ok(!geom.boxIsVisible(cornerBox, atCorner, 24),
      "a box inside the margin does not count as visible");
   ok(geom.scrollToShow(cornerBox, atCorner, 24) === null,
      "but it does not scroll either, because centring clamps to where we are");

   // One axis scrollable and the other not is the common case for a portrait
   // frame in a wide viewport. The unscrollable axis must not block the other.
   var oneAxis = { width: 800, height: 600, zoom: 1.0, scrollX: 0, scrollY: 0,
                   maxScrollX: 0, maxScrollY: 3424 };
   var below = { left: 100, top: 2000, right: 140, bottom: 2040 };
   var moved = geom.scrollToShow(below, oneAxis, 24);
   ok(moved !== null, "a scrollable y axis still follows the selection");
   ok(moved.x === 0, "the unscrollable x axis stays clamped at 0");
   ok(moved.y === 2020 - 300, "y is centred");
});

//----------------------------------------------------------------------------

console.log("\n============================================");
console.log("passed: " + passed + "  failed: " + failed);
if (failed > 0) {
   console.log("\nFailures:");
   failures.forEach(function (f) {
      console.log("  - " + f);
   });
   process.exit(1);
}
console.log("OK");
