#engine v8

#feature-id    MeteorComposer : Image Analysis > MeteorComposer | ysmrastro > MeteorComposer
#feature-info  Detect meteors in a night's worth of registered frames, screen \
   the candidates by eye, and composite the accepted ones onto a master light.

//============================================================================
// MeteorComposer.js - Stage 1 (detection) and Stage 2 (screening UI)
//
// This file holds only what has to touch PJSR objects: reading frames,
// rendering previews, and the dialog itself. The geometry, the session state
// and the detection algorithm all live in pure modules that run under
// Node.js, because that is the only way any of it can be tested
// (docs/tests.md 2).
//
// V8 only (PixInsight 1.9.4+). `#engine v8` must stay on line 1: 1.9.4
// defaults to the legacy SpiderMonkey runtime, which does not exist in the
// arm64 build, and the resulting failure is reported only in the Process
// Console.
//============================================================================

#define VERSION "1.0.1"
#define TITLE   "MeteorComposer"

#include "paths.js"
#include "detection_core.js"
#include "candidate_ops.js"
#include "trail_colour.js"
#include "mask_geometry.js"
#include "classifier.js"
#include "trail_mask.js"
#include "composition.js"
#include "preview_geometry.js"
#include "session_model.js"

#define SETTINGS_KEY "MeteorComposer"

// Screening pass reduction. Detection runs on a 1/8 field; the preview is
// rendered at 1:1 (docs/requirements.md 7.1), so this is also the factor that
// converts candidate coordinates to preview coordinates.
#define SCREEN_FACTOR 8

// Full-resolution ARGB32 frames are ~92 MB each. Four were measured to
// coexist comfortably (probe_preview.js stage 5).
#define FRAME_CACHE_SIZE 4

#define DRAG_THRESHOLD 4

// How much clear space a selected candidate needs around it, in view pixels,
// before the frame view counts as already showing it. Without a margin a
// candidate flush against the viewport edge is technically drawn but reads as
// cut off, and the operator pans anyway.
#define FOLLOW_MARGIN 24

// Pane geometry. The splitter handle sets its own fixed width to this, and the
// dialog's sizer uses this margin; paneBudget() has to agree with both, so they
// are named rather than repeated as literals.
#define SPLITTER_WIDTH 7
#define DIALOG_MARGIN 8
#define LIST_MIN_WIDTH 220
#define DETAIL_MIN_WIDTH 180

// Written beside the detection results after every verdict, so that closing
// the dialog - or losing it - never costs the screening work.
#define AUTOSAVE_NAME "meteor_session.json"

// The detection results the UI writes. The same name run_detection.js uses, so
// either producer's file can be read by either consumer.
#define RESULTS_NAME "detection_results.json"

// Overlay colours by verdict. Unreviewed is deliberately the most visible:
// it is the thing the operator is looking for.
#define COLOUR_UNREVIEWED 0xFFFFD24A
#define COLOUR_METEOR     0xFF44DD55
#define COLOUR_NOT_METEOR 0xFFDD4444
#define COLOUR_UNCERTAIN  0xFFFF9922
#define COLOUR_SELECTED   0xFFFFFFFF

// The exclusion mask's tint. Translucent, and deliberately none of the verdict
// colours: an excluded region is not an opinion about a candidate.
#define COLOUR_MASK_TINT  0x5AA050FF

// A painted mask is only ever consulted on the 1/8 detection grid, so it is
// resampled to this on load. Matrix.toArray() returns a plain JavaScript
// Array, and holding a 24-megapixel mask at full resolution would cost
// hundreds of megabytes to answer questions asked at 1/8 scale.
#define MASK_FILE_MAX_SIDE 1024

// What the readout says when Image is selected but the file cannot be read. It
// is a #define because the readout carries a fixed width - so that a growing
// number cannot squeeze the spin boxes next to it - and every text it can hold
// has to be measured when that width is set.
#define MASK_UNREADABLE "Mask image unreadable"

//============================================================================
// PJSR layer: frames on disk
//============================================================================





function listFrames(dir) {
   var names = [];
   var find = new FileFind;
   if (find.begin(dir + "/*")) {
      do {
         if (!find.isDirectory && isRealXisf(find.name)) {
            names.push(find.name);
         }
      } while (find.next());
   }
   names.sort();
   return names;
}

// Image file -> plain field. This is the boundary described in
// docs/tests.md 2: everything past it is pure JavaScript.
function loadField(path, factor) {
   return withFrame(path, factor, function (field) { return field; });
}

// Open a frame, hand its reduced luminance field AND its full-resolution image
// to `fn`, and close it afterwards whatever happens.
//
// Detection needs the field; the colour measurement needs the image. Opening
// the file costs about 800 ms of the ~1.2 s a frame takes, so reading it twice
// would add most of ten minutes to a session. One open, both jobs, and the
// window's lifetime stays visible in one place.
function withFrame(path, factor, fn) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var image = win.mainView.image;
      var Y = new Image();
      image.getLuminance(Y);
      Y.resample(1.0 / factor);
      var m = Y.toMatrix();
      var field = { data: m.toArray(), width: Y.width, height: Y.height };
      return fn(field, image);
   } finally {
      win.forceClose();
   }
}

// Attach each candidate's colour, in place.
//
// Green fraction separates meteors from everything else better than any other
// feature measured (docs/requirements.md 6.1.0) and the classifier has carried
// the term since. Nothing supplied the value until now, so it did nothing.
//
// A candidate whose colour cannot be read keeps `colour` unset, and the
// classifier then scores it without the term rather than with a guess - which
// is the behaviour that protects a meteor the measurement failed on.
function attachColours(image, candidates, factor) {
   var sampler = function (x, y, channel) {
      return image.sample(x, y, channel);
   };
   for (var i = 0; i < candidates.length; ++i) {
      var colour = null;
      try {
         colour = measureTrailColour(sampler, candidates[i], factor, factor,
                                     image.width, image.height, null);
      } catch (e) {
         colour = null;
      }
      if (colour !== null) {
         candidates[i].colour = colour;
      }
   }
}

//============================================================================
// PJSR layer: preview rendering
//
// The native pattern used by WBPP (BPP-LNReferenceSelector.js /
// BPP-Helper.js). Do not hand-roll a per-pixel loop here: measured at 17-26 ms
// for a full 6024x4024 render, it is not the bottleneck. Opening the file and
// computing the statistics are.
//============================================================================

// What each stretch mode asks for, in one place.
//
// Every mode decision goes through here rather than being compared against a
// string wherever it happens to be needed. Adding a fourth mode later then
// means adding a row, not hunting for the branches that were missed - which is
// the failure this project has already had with `edgeContact` and with
// `row.colour`. tests/ut/test_module_isolation.js enforces the single point of
// decision statically.
function stfPlan(mode) {
   if (mode === "none") {
      // Linear. Nothing to compute, so nothing to lock either.
      return { stretch: false, linked: false, lockable: false };
   }
   if (mode === "linked") {
      return { stretch: true, linked: true, lockable: true };
   }
   // "unlinked" and anything unrecognised. Unlinked is what this script has
   // always done, so an unknown value from Settings lands on the behaviour the
   // operator already knows rather than on a surprise.
   return { stretch: true, linked: false, lockable: true };
}

var STF_MODES = ["none", "linked", "unlinked"];

function computeSTF(view, linked) {
   var median = view.computeOrFetchProperty("Median");
   var mad = view.computeOrFetchProperty("MAD");
   var centre = [];
   var sigma = [];
   for (var i = 0; i < median.length; ++i) {
      // A non-positive median makes the stretch degenerate.
      centre.push(Math.max(0.00001, median[i]));
      sigma.push(1.4826 * mad[i]);
   }
   // The last argument is linkedRGB. Unlinked gives each channel its own
   // stretch, which pulls a colour cast out of the sky and makes a faint trail
   // easier to see against it; linked keeps the channels in proportion, so the
   // colour of the trail itself is the colour it was recorded with. Both are
   // useful while screening, for different questions.
   return view.image.computeAutoStretch(centre, sigma, -2.8, 0.25, linked);
}

// Render one frame at 1:1.
//
// `lockedSTF` reuses a stretch computed from an earlier frame. Median and MAD
// cost ~445 ms of the ~1.2 s per frame, and registered frames from one
// session are statistically near-identical, so locking is the single largest
// saving available here.
function renderFrame(path, lockedSTF, mode) {
   var plan = stfPlan(mode);
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   var stretched = null;
   try {
      var view = win.mainView;
      // No stretch at all still needs the copy: render() reads the image, and
      // the window is closed on the way out.
      var stf = null;
      if (plan.stretch) {
         stf = lockedSTF !== null ? lockedSTF : computeSTF(view, plan.linked);
      }
      stretched = new Image(view.image);
      if (stf !== null) {
         stretched.applyDisplayFunction(stf);
      }
      return {
         bitmap: stretched.render(),
         width: view.image.width,
         height: view.image.height,
         stf: stf
      };
   } catch (e) {
      return null;
   } finally {
      if (stretched !== null) {
         stretched.free();
      }
      win.forceClose();
   }
}

//============================================================================
// PJSR layer: the exclusion mask
//
// The geometry and the black-is-excluded threshold live in mask_geometry.js
// with Small tests. Only reading the file and painting the tint are here.
//============================================================================

// Read a painted mask as a luminance field.
//
// Resampled on the way in, because the mask is only consulted on the detection
// grid; the residual difference in size, and any difference in aspect ratio,
// is taken up by maskFromLuminance(), which is also where the threshold - and
// with it the black-is-excluded convention - is decided.
function loadMaskLuminance(path, maxSide) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      var longest = Math.max(Y.width, Y.height);
      if (longest > maxSide) {
         Y.resample(maxSide / longest);
      }
      var m = Y.toMatrix();
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
   }
}

// A translucent tint over every excluded sample.
//
// Built from the mask itself rather than redrawn from the numbers, so the
// overlay cannot disagree with what detection will refuse to look at. It is at
// the detection grid's resolution, which is also the granularity exclusion
// really has - the blocks are not an artefact of the drawing.
function maskOverlayBitmap(mask, width, height) {
   var bmp = new Bitmap(width, height);
   bmp.fill(0x00000000);
   var runs = maskRuns(mask, width, height);
   for (var i = 0; i < runs.length; ++i) {
      var r = runs[i];
      bmp.fill(r.x0, r.y, r.x1 + 1, r.y + 1, COLOUR_MASK_TINT);
   }
   return bmp;
}

//============================================================================
// PJSR layer: composition (Stages 3 and 4)
//
// The arithmetic is in trail_mask.js and composition.js, both pure JavaScript
// with Small tests. Only the pixel traffic is here.
//============================================================================

function channelToArray(image, channel) {
   image.selectedChannel = channel;
   return image.toMatrix().toArray();
}

// Write a plain array back into one channel.
//
// The fourth argument of Image.apply() is the TARGET channel. firstChannel and
// lastChannel refer to the SOURCE image's channels, which is why passing the
// target there did nothing at all for channels 1 and 2: the source is
// one-channel, so asking it for channel 1 selected nothing and the call
// returned without writing and without throwing.
//
// That produced a composite with light in R only, and it is exactly the kind
// of silent no-op that has to be measured rather than reasoned about; see
// tests/pjsr/probe_channel_write.js for the experiment that settled it.
//
// Image.assign() is not an alternative: it replaces the whole image, leaving a
// one-channel result.
function arrayToChannel(image, channel, data) {
   var channelImage = (new Matrix(data, image.height, image.width)).toImage();
   image.apply(channelImage, ImageOp.Mov, new Point(0, 0), channel);
}

// A candidate's trail in full-resolution pixels, ready for trail_mask.
function trailFromCandidate(candidate) {
   return {
      x0: sampleCentreToImage(candidate.x0, SCREEN_FACTOR),
      y0: sampleCentreToImage(candidate.y0, SCREEN_FACTOR),
      x1: sampleCentreToImage(candidate.x1, SCREEN_FACTOR),
      y1: sampleCentreToImage(candidate.y1, SCREEN_FACTOR),
      width: (candidate.minorLength || 0) * SCREEN_FACTOR
   };
}

//============================================================================
// Frame cache
//
// Least-recently-used, so stepping back one frame is instant. Sized by
// measurement rather than guesswork.
//============================================================================

var FrameCache = class {
   constructor(capacity) {
      this.capacity = capacity;
      this.order = [];    // paths, most recent last
      this.entries = {};  // path -> render result
      this.lockedSTF = null;
      this.stfMode = "unlinked";
   }

   // Changing the stretch invalidates everything already rendered. The cache
   // holds finished bitmaps, not images, so an entry rendered under the old
   // mode cannot be re-stretched - it has to go. The locked stretch goes with
   // it: a stretch computed as unlinked is not the linked answer.
   setSTFMode(mode) {
      if (this.stfMode === mode) {
         return false;
      }
      this.stfMode = mode;
      this.lockedSTF = null;
      this.clear();
      return true;
   }

   has(path) {
      return this.entries[path] !== undefined;
   }

   get(path) {
      if (this.entries[path] !== undefined) {
         this.touch(path);
         return this.entries[path];
      }
      var result = renderFrame(path, this.lockedSTF, this.stfMode);
      if (result === null) {
         return null;
      }
      // The first successful render supplies the stretch for the rest of the
      // session unless the operator unlocks it. With no stretch there is
      // nothing to carry, and result.stf is null - storing it would look like
      // "not locked yet" and recompute forever.
      if (this.lockedSTF === null && this.lockSTF && result.stf !== null) {
         this.lockedSTF = result.stf;
      }
      this.put(path, result);
      return result;
   }

   put(path, result) {
      this.entries[path] = result;
      this.touch(path);
      while (this.order.length > this.capacity) {
         var evicted = this.order.shift();
         delete this.entries[evicted];
      }
   }

   touch(path) {
      var at = this.order.indexOf(path);
      if (at >= 0) {
         this.order.splice(at, 1);
      }
      this.order.push(path);
   }

   clear() {
      this.order = [];
      this.entries = {};
   }
};

//============================================================================
// MeteorPreviewControl
//
// Adapted from manual-image-solver 2.0.0's ImagePreviewControl: same manual
// scroll management (PJSR's ScrollBox does not reposition reliably after a
// viewport resize), same click-versus-drag threshold. Display rotation is
// dropped - it has no use here - and the star markers are replaced by
// candidate boxes.
//
// The paint handler computes no geometry. layoutOverlay() in
// preview_geometry.js returns boxes already in view coordinates, culled;
// this code only draws them. That keeps the part that can be wrong in a place
// that can be tested.
//============================================================================

var MeteorPreviewControl = class extends ScrollBox {
   constructor(parent) {
      super(parent);

      this.bitmap = null;         // as rendered, image orientation
      this.displayBitmap = null;  // what is actually drawn; rotated copy
      this.rotation = 0;          // 0 / 90 / 180 / 270, clockwise
      this.imageWidth = 0;
      this.imageHeight = 0;
      this.zoomLevel = 1.0;
      this.onFrameRedrawn = null;

      // The exclusion mask, tinted, at the detection grid's resolution. Drawn
      // scaled onto the same rectangle as the frame, so it follows zoom and
      // pan without any arithmetic of its own.
      this.maskBitmap = null;
      this.maskDisplayBitmap = null;

      this.candidates = [];
      this.verdicts = [];      // parallel to candidates
      this.rowNumbers = [];    // parallel to candidates; what the list shows
      this.selectedIndex = -1;
      this.onCandidateClick = null;

      this.scrollX = 0;
      this.scrollY = 0;
      this.maxScrollX = 0;
      this.maxScrollY = 0;

      this.isDragging = false;
      this.hasMoved = false;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this.panScrollX = 0;
      this.panScrollY = 0;

      this.zoomLevels = [
         0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 0.75,
         1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0
      ];
      this.zoomIndex = 9;
      this._needsFit = true;

      // manual-image-solver and split-image-solver both set `autoScrolls =
      // false` here. ScrollBox has no such property - the real ones are
      // horizontalAutoScroll / verticalAutoScroll - so that assignment only
      // ever created a stray JavaScript property and did nothing. Both
      // scripts work regardless, which shows the manual scroll management
      // does not depend on it, so the line is simply left out rather than
      // replaced with an untested behavioural change.

      var self = this;

      this.viewport.cursor = new Cursor(StdCursor.Arrow);

      // The viewport has no size during construction, so the initial fit has
      // to wait for the first resize.
      this.viewport.onResize = function () {
         if (self._needsFit && self.bitmap !== null) {
            self._needsFit = false;
            self.fitToWindow();
         } else {
            self.updateViewport();
         }
      };

      this.onHorizontalScrollPosUpdated = function (pos) {
         self.scrollX = pos;
         self.viewport.update();
      };
      this.onVerticalScrollPosUpdated = function (pos) {
         self.scrollY = pos;
         self.viewport.update();
      };

      this.viewport.onPaint = function () {
         var g = new Graphics(this);
         try {
            g.fillRect(this.boundsRect, new Brush(0xFF202020));
            var bmp = self.displayBitmap;
            if (bmp === null) {
               return;
            }

            var dispW = Math.round(bmp.width * self.zoomLevel);
            var dispH = Math.round(bmp.height * self.zoomLevel);
            var frameRect = new Rect(-self.scrollX, -self.scrollY,
                                     dispW - self.scrollX, dispH - self.scrollY);
            g.drawScaledBitmap(frameRect, bmp);

            // Under the candidate boxes: the boxes are the thing being judged.
            if (self.maskDisplayBitmap !== null) {
               g.drawScaledBitmap(frameRect, self.maskDisplayBitmap);
            }

            self.paintOverlay(g, this.width, this.height);
         } finally {
            g.end();
         }
      };

      this.viewport.onMousePress = function (x, y, button, buttonState, modifiers) {
         if (self.bitmap === null) {
            return;
         }
         if (button === 1 || button === 4) {
            self.isDragging = true;
            self.hasMoved = false;
            self.dragStartX = x;
            self.dragStartY = y;
            self.panScrollX = self.scrollX;
            self.panScrollY = self.scrollY;
         }
      };

      this.viewport.onMouseMove = function (x, y, buttonState, modifiers) {
         if (!self.isDragging) {
            return;
         }
         var dx = x - self.dragStartX;
         var dy = y - self.dragStartY;
         if (!self.hasMoved) {
            if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
               self.hasMoved = true;
               self.viewport.cursor = new Cursor(StdCursor.ClosedHand);
            }
         }
         if (self.hasMoved) {
            self.setScroll(self.panScrollX - dx, self.panScrollY - dy);
         }
      };

      // No movement means a click, which selects a candidate. Same mode-free
      // scheme as manual-image-solver: no modifier, no toolbar toggle.
      this.viewport.onMouseRelease = function (x, y, button, buttonState, modifiers) {
         if (!self.isDragging) {
            return;
         }
         if (!self.hasMoved && button === 1) {
            // The click arrives in view space; candidates live in image
            // space. With the preview turned, that is two conversions, not
            // one - view -> display -> image.
            var disp = viewToImage(x, y, self.zoomLevel, self.scrollX, self.scrollY);
            var img = displayToImage(disp.x, disp.y, self.rotation,
                                     self.imageWidth, self.imageHeight);
            var hit = hitTest(self.candidates, img.x, img.y,
                              SCREEN_FACTOR, SCREEN_FACTOR, self.hitPadding());
            if (hit >= 0 && self.onCandidateClick !== null) {
               self.onCandidateClick(hit);
            }
         }
         self.isDragging = false;
         self.hasMoved = false;
         self.viewport.cursor = new Cursor(StdCursor.Arrow);
      };

      this.viewport.onMouseWheel = function (x, y, delta, buttonState, modifiers) {
         if (self.bitmap === null) {
            return;
         }
         var oldZoom = self.zoomLevel;
         var newIdx = -1;
         var i;
         if (delta > 0) {
            for (i = 0; i < self.zoomLevels.length; ++i) {
               if (self.zoomLevels[i] > oldZoom + 1e-6) {
                  newIdx = i;
                  break;
               }
            }
         } else {
            for (i = self.zoomLevels.length - 1; i >= 0; --i) {
               if (self.zoomLevels[i] < oldZoom - 1e-6) {
                  newIdx = i;
                  break;
               }
            }
         }
         if (newIdx < 0) {
            return;
         }
         var newZoom = self.zoomLevels[newIdx];
         var factor = newZoom / oldZoom;
         self.zoomIndex = newIdx;
         self.zoomLevel = newZoom;
         self.scrollX = Math.round((self.scrollX + x) * factor - x);
         self.scrollY = Math.round((self.scrollY + y) * factor - y);
         self.updateViewport();
      };
   }

   // Clicking has to stay possible when zoomed out, where a box may be only a
   // few screen pixels across. The tolerance is defined in screen pixels and
   // converted, so it feels the same at every zoom.
   hitPadding() {
      return 4 / Math.max(this.zoomLevel, 1e-6);
   }

   verdictColour(verdict, selected) {
      if (selected) {
         return COLOUR_SELECTED;
      }
      if (verdict === VERDICT.METEOR) {
         return COLOUR_METEOR;
      }
      if (verdict === VERDICT.NOT_METEOR) {
         return COLOUR_NOT_METEOR;
      }
      if (verdict === VERDICT.UNCERTAIN) {
         return COLOUR_UNCERTAIN;
      }
      return COLOUR_UNREVIEWED;
   }

   paintOverlay(g, viewW, viewH) {
      if (this.candidates.length === 0) {
         return;
      }
      var view = {
         width: viewW, height: viewH,
         zoom: this.zoomLevel, scrollX: this.scrollX, scrollY: this.scrollY
      };
      var laid = layoutOverlay(this.candidates, SCREEN_FACTOR, SCREEN_FACTOR, view, {
         pad: 2,
         labelSize: { width: 18, height: 13 },
         imageWidth: this.imageWidth,
         imageHeight: this.imageHeight,
         rotation: this.rotation
      });

      g.antialiasing = true;
      g.font = new Font("Helvetica", 11);

      for (var i = 0; i < laid.length; ++i) {
         var item = laid[i];
         var selected = (item.index === this.selectedIndex);
         var colour = this.verdictColour(this.verdicts[item.index], selected);

         g.pen = new Pen(colour, selected ? 2.5 : 1.5);
         g.drawRect(new Rect(Math.round(item.box.left), Math.round(item.box.top),
                             Math.round(item.box.right), Math.round(item.box.bottom)));

         // The number matches the candidate list's row number, so the two
         // views can be read against each other.
         var label = "" + this.rowNumbers[item.index];
         g.pen = new Pen(colour);
         g.drawText(Math.round(item.label.x), Math.round(item.label.y) + 11, label);
      }
   }

   setFrame(rendered) {
      this.bitmap = rendered === null ? null : rendered.bitmap;
      this.imageWidth = rendered === null ? 0 : rendered.width;
      this.imageHeight = rendered === null ? 0 : rendered.height;
      this.rebuildDisplayBitmap();
      if (this._needsFit) {
         this.fitToWindow();
      } else {
         this.updateViewport();
      }
      if (this.onFrameRedrawn !== null) {
         this.onFrameRedrawn();
      }
   }

   // Bitmap.rotated() takes degrees and turns clockwise (measured; see
   // preview_geometry.js). A quarter turn of a 6024x4024 frame was 35 ms, so
   // rotating on every frame change is cheap enough that no rotated copy is
   // cached beyond the frame on screen.
   rebuildDisplayBitmap() {
      this.rebuildMaskDisplayBitmap();
      if (this.bitmap === null) {
         this.displayBitmap = null;
         return;
      }
      this.displayBitmap = (normalizeRotation(this.rotation) === 0)
         ? this.bitmap
         : this.bitmap.rotated(normalizeRotation(this.rotation));
   }

   // The mask is drawn onto the frame's rectangle, so it has to be turned with
   // the frame or it would sit across it.
   rebuildMaskDisplayBitmap() {
      if (this.maskBitmap === null) {
         this.maskDisplayBitmap = null;
         return;
      }
      this.maskDisplayBitmap = (normalizeRotation(this.rotation) === 0)
         ? this.maskBitmap
         : this.maskBitmap.rotated(normalizeRotation(this.rotation));
   }

   setMask(bitmap) {
      this.maskBitmap = bitmap;
      this.rebuildMaskDisplayBitmap();
      this.viewport.update();
   }

   // The rotation is a property of the preview, not of the frame, so it
   // survives moving to the next candidate.
   setRotation(degrees) {
      var previous = normalizeRotation(this.rotation);
      this.rotation = normalizeRotation(degrees);
      if (previous === this.rotation) {
         return;
      }
      this.rebuildDisplayBitmap();
      // Scroll position is meaningless across a turn; refit rather than
      // leave the operator looking at a corner of the frame.
      this.fitToWindow();
      if (this.onFrameRedrawn !== null) {
         this.onFrameRedrawn();
      }
   }

   setCandidates(candidates, verdicts, rowNumbers, selectedIndex) {
      this.candidates = candidates;
      this.verdicts = verdicts;
      this.rowNumbers = rowNumbers;
      this.selectedIndex = selectedIndex;
      this.viewport.update();
   }

   setSelected(index) {
      this.selectedIndex = index;
      this.viewport.update();
   }

   // Bring the selected candidate into view when the operator moves through
   // the list. The enlarged pane is always centred on the selection, but this
   // view was not following it, so at 1:1 the operator had to pan to find the
   // candidate they had just selected.
   //
   // Deliberately does nothing at Fit (the whole frame is already on screen)
   // and nothing when the candidate is already comfortably visible: moving the
   // frame when there is no need to makes the view feel unstable while
   // stepping through a list. Both decisions live in scrollToShow, which is
   // tested under Node.
   followSelection() {
      if (this.displayBitmap === null || this.selectedIndex < 0
          || this.selectedIndex >= this.candidates.length) {
         return;
      }
      var box = rotateBox(
         candidateBox(this.candidates[this.selectedIndex],
                      SCREEN_FACTOR, SCREEN_FACTOR, 2),
         this.rotation, this.imageWidth, this.imageHeight);
      var target = scrollToShow(box, {
         width: this.viewport.width,
         height: this.viewport.height,
         zoom: this.zoomLevel,
         scrollX: this.scrollX,
         scrollY: this.scrollY,
         maxScrollX: this.maxScrollX,
         maxScrollY: this.maxScrollY
      }, FOLLOW_MARGIN);
      if (target !== null) {
         this.setScroll(target.x, target.y);
      }
   }

   // Bring a candidate into view without changing the zoom. Used when the
   // operator moves through the list while zoomed in.
   centreOn(candidateIndex) {
      if (this.displayBitmap === null || candidateIndex < 0
          || candidateIndex >= this.candidates.length) {
         return;
      }
      var c = candidateCentroid(this.candidates[candidateIndex],
                                SCREEN_FACTOR, SCREEN_FACTOR);
      var d = imageToDisplay(c.x, c.y, this.rotation,
                             this.imageWidth, this.imageHeight);
      var viewW = this.viewport.width;
      var viewH = this.viewport.height;
      this.setScroll(d.x * this.zoomLevel - viewW / 2,
                     d.y * this.zoomLevel - viewH / 2);
   }

   setScroll(x, y) {
      this.scrollX = Math.max(0, Math.min(this.maxScrollX, Math.round(x)));
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, Math.round(y)));
      this.horizontalScrollPosition = this.scrollX;
      this.verticalScrollPosition = this.scrollY;
      this.viewport.update();
   }

   updateViewport() {
      if (this.displayBitmap === null) {
         this.setHorizontalScrollRange(0, 0);
         this.setVerticalScrollRange(0, 0);
         this.viewport.update();
         return;
      }
      var dispW = Math.round(this.displayBitmap.width * this.zoomLevel);
      var dispH = Math.round(this.displayBitmap.height * this.zoomLevel);
      var viewW = this.viewport.width > 0 ? this.viewport.width : this.width;
      var viewH = this.viewport.height > 0 ? this.viewport.height : this.height;

      this.maxScrollX = Math.max(0, dispW - viewW);
      this.maxScrollY = Math.max(0, dispH - viewH);
      this.scrollX = Math.max(0, Math.min(this.maxScrollX, this.scrollX));
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY));

      this.setHorizontalScrollRange(0, this.maxScrollX);
      this.setVerticalScrollRange(0, this.maxScrollY);
      this.horizontalScrollPosition = this.scrollX;
      this.verticalScrollPosition = this.scrollY;
      this.viewport.update();
   }

   fitToWindow() {
      if (this.displayBitmap === null) {
         return;
      }
      var viewW = this.viewport.width > 0 ? this.viewport.width : this.width;
      var viewH = this.viewport.height > 0 ? this.viewport.height : this.height;
      if (viewW <= 0 || viewH <= 0) {
         return;
      }
      this.zoomLevel = Math.min(viewW / this.displayBitmap.width,
                                viewH / this.displayBitmap.height);
      this.zoomIndex = this.nearestZoomIndex(this.zoomLevel);
      this.scrollX = 0;
      this.scrollY = 0;
      this._needsFit = false;
      this.updateViewport();
   }

   nearestZoomIndex(zoom) {
      var best = 0;
      var bestDiff = Math.abs(this.zoomLevels[0] - zoom);
      for (var i = 1; i < this.zoomLevels.length; ++i) {
         var diff = Math.abs(this.zoomLevels[i] - zoom);
         if (diff < bestDiff) {
            bestDiff = diff;
            best = i;
         }
      }
      return best;
   }

   zoomAroundCentre(newZoom) {
      if (this.displayBitmap === null || Math.abs(this.zoomLevel - newZoom) < 1e-9) {
         return;
      }
      var viewW = this.viewport.width > 0 ? this.viewport.width : this.width;
      var viewH = this.viewport.height > 0 ? this.viewport.height : this.height;
      var factor = newZoom / this.zoomLevel;
      this.scrollX = Math.round((this.scrollX + viewW / 2) * factor - viewW / 2);
      this.scrollY = Math.round((this.scrollY + viewH / 2) * factor - viewH / 2);
      this.zoomLevel = newZoom;
      this.updateViewport();
   }

   zoom11() {
      this.zoomIndex = this.nearestZoomIndex(1.0);
      this.zoomAroundCentre(1.0);
   }

   zoomIn() {
      for (var i = 0; i < this.zoomLevels.length; ++i) {
         if (this.zoomLevels[i] > this.zoomLevel + 1e-6) {
            this.zoomIndex = i;
            this.zoomAroundCentre(this.zoomLevels[i]);
            return;
         }
      }
   }

   zoomOut() {
      for (var i = this.zoomLevels.length - 1; i >= 0; --i) {
         if (this.zoomLevels[i] < this.zoomLevel - 1e-6) {
            this.zoomIndex = i;
            this.zoomAroundCentre(this.zoomLevels[i]);
            return;
         }
      }
   }
};

//============================================================================
// CandidateDetailControl
//
// A second view showing just the selected candidate, enlarged. At fit-to-
// window a trail is a few pixels long on screen, which is not enough to tell
// a meteor from a satellite, and zooming the main preview loses the context
// of where the candidate sits in the frame. This pane gives the close look
// while the main preview keeps the overview.
//
// It costs no memory: Graphics.drawScaledBitmapRect() takes a source
// rectangle and a destination rectangle, so the crop is done at draw time
// against the bitmap the preview already holds. Nothing is copied.
//============================================================================

var CandidateDetailControl = class extends Frame {
   constructor(parent) {
      super(parent);

      this.bitmap = null;      // the rotated display bitmap, shared with the preview
      this.box = null;         // selected candidate's box, in display coordinates
      this.colour = COLOUR_SELECTED;
      this.margin = 2.5;       // how much context around the box, as a multiple

      var self = this;

      this.onPaint = function () {
         var g = new Graphics(self);
         try {
            g.fillRect(self.boundsRect, new Brush(0xFF181818));
            if (self.bitmap === null || self.box === null) {
               g.pen = new Pen(0xFF808080);
               g.font = new Font("Helvetica", 11);
               g.drawText(8, 20, "No candidate selected");
               return;
            }
            var src = self.sourceRect();
            if (src === null) {
               return;
            }
            var dst = new Rect(0, 0, self.width, self.height);
            g.drawScaledBitmapRect(dst, self.bitmap, src);

            // Mark the candidate itself, so it is clear which part of this
            // enlarged view is the detection and which is context.
            var sx = self.width / (src.x1 - src.x0);
            var sy = self.height / (src.y1 - src.y0);
            g.pen = new Pen(self.colour, 1.5);
            g.drawRect(new Rect(
               Math.round((self.box.left - src.x0) * sx),
               Math.round((self.box.top - src.y0) * sy),
               Math.round((self.box.right - src.x0) * sx),
               Math.round((self.box.bottom - src.y0) * sy)));
         } finally {
            g.end();
         }
      };
   }

   // The crop to enlarge: the candidate's box plus context, widened to the
   // pane's aspect ratio so the image is not stretched, then clamped to the
   // bitmap. Clamping is done by shifting rather than shrinking, so the
   // magnification stays the same for a candidate near an edge.
   sourceRect() {
      if (this.bitmap === null || this.box === null
          || this.width <= 0 || this.height <= 0) {
         return null;
      }
      var cx = (this.box.left + this.box.right) / 2;
      var cy = (this.box.top + this.box.bottom) / 2;
      var w = Math.max(this.box.right - this.box.left, 1) * this.margin;
      var h = Math.max(this.box.bottom - this.box.top, 1) * this.margin;

      var aspect = this.width / this.height;
      if (w / h < aspect) {
         w = h * aspect;
      } else {
         h = w / aspect;
      }
      // Never enlarge past the frame itself.
      if (w > this.bitmap.width) {
         w = this.bitmap.width;
         h = w / aspect;
      }
      if (h > this.bitmap.height) {
         h = this.bitmap.height;
         w = h * aspect;
      }

      var x0 = cx - w / 2;
      var y0 = cy - h / 2;
      if (x0 < 0) {
         x0 = 0;
      }
      if (y0 < 0) {
         y0 = 0;
      }
      if (x0 + w > this.bitmap.width) {
         x0 = this.bitmap.width - w;
      }
      if (y0 + h > this.bitmap.height) {
         y0 = this.bitmap.height - h;
      }
      return new Rect(Math.round(x0), Math.round(y0),
                      Math.round(x0 + w), Math.round(y0 + h));
   }

   setSource(bitmap, box, colour) {
      this.bitmap = bitmap;
      this.box = box;
      this.colour = colour === undefined ? COLOUR_SELECTED : colour;
      this.update();
   }

   setMargin(margin) {
      this.margin = Math.max(1.05, Math.min(20, margin));
      this.update();
   }
};

//============================================================================
// SplitterHandle
//
// PJSR has no splitter class, so this is one: a narrow strip between two
// panes that reports how far it has been dragged. The owner decides what to
// do with the delta, which keeps this control free of any assumption about
// which pane grows.
//============================================================================

var SplitterHandle = class extends Control {
   constructor(parent, onDragged, onReleased) {
      super(parent);

      this.setFixedWidth(SPLITTER_WIDTH);
      this.cursor = new Cursor(StdCursor.HorizontalSize);
      this.toolTip = "<p>Drag to resize the panes.</p>";

      var self = this;
      this.dragging = false;
      this.pressX = 0;

      this.onPaint = function () {
         var g = new Graphics(self);
         try {
            g.fillRect(self.boundsRect, new Brush(0xFF3A3A3A));
            // A few dots down the middle, so the strip reads as a handle
            // rather than as a gap in the layout.
            g.pen = new Pen(0xFF808080);
            var midX = Math.floor(self.width / 2);
            var midY = Math.floor(self.height / 2);
            for (var d = -12; d <= 12; d += 6) {
               g.drawLine(midX, midY + d, midX, midY + d + 2);
            }
         } finally {
            g.end();
         }
      };

      this.onMousePress = function (x, y, button, buttonState, modifiers) {
         if (button === 1) {
            self.dragging = true;
            self.pressX = x;
         }
      };

      // The handle moves with the pane it resizes, so after applying a delta
      // the next event's x lands back near pressX. That makes the drag
      // self-correcting without tracking absolute screen coordinates.
      this.onMouseMove = function (x, y, buttonState, modifiers) {
         if (!self.dragging) {
            return;
         }
         var delta = x - self.pressX;
         if (delta !== 0 && onDragged) {
            onDragged(delta);
         }
      };

      // Release, not every move. Persisting a width on each mouse-move event
      // would write to the settings store dozens of times per drag for a value
      // that only matters once the operator lets go.
      this.onMouseRelease = function (x, y, button, buttonState, modifiers) {
         var wasDragging = self.dragging;
         self.dragging = false;
         if (wasDragging && onReleased) {
            onReleased();
         }
      };
   }
};

//============================================================================
// ModeDialog
//
// The mode is chosen here and fixed for the lifetime of the screening dialog
// (docs/requirements.md 7.1). It is not a toggle inside the main window: in
// ground-truth mode the score and classification columns must not exist, and
// a switch the operator can flip mid-session would make that guarantee
// meaningless.
//============================================================================

var ModeDialog = class extends Dialog {
   constructor() {
      super();

      this.mode = MODE.SCREENING;
      var self = this;

      this.windowTitle = TITLE + " " + VERSION;

      this.infoLabel = new Label(this);
      this.infoLabel.useRichText = true;
      this.infoLabel.wordWrapping = true;
      this.infoLabel.text =
         "<p><b>Choose a working mode.</b> It cannot be changed without "
       + "reopening this dialog.</p>";
      this.infoLabel.setMinWidth(460);

      this.screeningRadio = new RadioButton(this);
      this.screeningRadio.text = "Screening";
      this.screeningRadio.checked = true;
      this.screeningRadio.onCheck = function (checked) {
         if (checked) {
            self.mode = MODE.SCREENING;
         }
      };

      this.screeningInfo = new Label(this);
      this.screeningInfo.useRichText = true;
      this.screeningInfo.wordWrapping = true;
      this.screeningInfo.text =
         "<p>Normal use. Candidates can be filtered and sorted by score so "
       + "that the most likely ones come first.</p>";
      this.screeningInfo.setMinWidth(440);

      this.groundTruthRadio = new RadioButton(this);
      this.groundTruthRadio.text = "Ground truth";
      this.groundTruthRadio.onCheck = function (checked) {
         if (checked) {
            self.mode = MODE.GROUND_TRUTH;
         }
      };

      this.groundTruthInfo = new Label(this);
      this.groundTruthInfo.useRichText = true;
      this.groundTruthInfo.wordWrapping = true;
      this.groundTruthInfo.text =
         "<p>Label candidates to build an evaluation set. Every candidate is "
       + "shown, no scores or classifications are displayed, and the order is "
       + "capture order. Showing the classifier's own output while labelling "
       + "would make the resulting evaluation circular.</p>";
      this.groundTruthInfo.setMinWidth(440);

      this.okButton = new PushButton(this);
      this.okButton.text = "Continue";
      this.okButton.defaultButton = true;
      this.okButton.onClick = function () {
         self.ok();
      };

      this.cancelButton = new PushButton(this);
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = function () {
         self.cancel();
      };

      var buttons = new HorizontalSizer;
      buttons.addStretch();
      buttons.add(this.okButton);
      buttons.addSpacing(6);
      buttons.add(this.cancelButton);

      var screeningIndent = new HorizontalSizer;
      screeningIndent.addSpacing(22);
      screeningIndent.add(this.screeningInfo, 100);

      var groundTruthIndent = new HorizontalSizer;
      groundTruthIndent.addSpacing(22);
      groundTruthIndent.add(this.groundTruthInfo, 100);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 12;
      this.sizer.spacing = 6;
      this.sizer.add(this.infoLabel);
      this.sizer.addSpacing(6);
      this.sizer.add(this.screeningRadio);
      this.sizer.add(screeningIndent);
      this.sizer.addSpacing(6);
      this.sizer.add(this.groundTruthRadio);
      this.sizer.add(groundTruthIndent);
      this.sizer.addSpacing(10);
      this.sizer.add(buttons);

      this.adjustToContents();
      this.setFixedSize();
   }
};

//============================================================================
// MeteorComposerDialog
//============================================================================

// ----------------------------------------------------------------------------
// Where the composite comes from and where it goes
//
// Two native file dialogs used to do this - one to pick the master, one to
// choose the output. That failed on the first contact with an operator, in two
// ways worth remembering.
//
// The filters were written as [["Images", "*.xisf *.fit *.fits"]], one string
// holding several patterns. PJSR wants one extension per array element, so that
// filter matched nothing at all: the dialog showed no files, only folders, and
// "Open" greyed out as soon as you entered one. Nothing was broken in any way
// the code could notice - the dialog simply could not be used.
//
// And the shape was wrong regardless. Both paths are known before the operator
// is asked anything: the master sits in a `master` directory beside the frames,
// and the output belongs next to the session file that has been saving itself
// all along. Asking through two modal dialogs, one after the other, hides that,
// and it hides them from each other - you cannot see what master you chose
// while you are choosing where to write. The operator's own suggestion, which
// this follows, was to ask earlier and in one place.
//
// Both fields are editable text, so a path can be typed or pasted. That is not
// a nicety: it is the way out when a file dialog will not cooperate.
var ComposeDialog = class extends Dialog {
   constructor(meteorCount, masterGuess, outputGuess) {
      super();

      var self = this;
      this.masterPath = masterGuess || "";
      this.outputPath = outputGuess || "";

      this.windowTitle = "Compose meteor composite";

      this.infoLabel = new Label(this);
      this.infoLabel.useRichText = true;
      this.infoLabel.wordWrapping = true;
      this.infoLabel.text =
         "<p><b>" + meteorCount + " accepted meteor"
       + (meteorCount === 1 ? "" : "s") + "</b> will be added to the master "
       + "light. The master is not modified: the result is written to the "
       + "output file, with its mask beside it.</p>";
      this.infoLabel.setMinWidth(560);

      var labelWidth = 90;

      this.masterLabel = new Label(this);
      this.masterLabel.text = "Master light:";
      this.masterLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.masterLabel.setFixedWidth(labelWidth);

      this.masterEdit = new Edit(this);
      this.masterEdit.text = this.masterPath;
      this.masterEdit.toolTip =
         "<p>The master light the meteors are added to. Must have the same "
       + "dimensions as the registered frames, so use the uncropped master: an "
       + "autocropped one would put every mask in the wrong place.</p>";
      this.masterEdit.onTextUpdated = function (text) {
         self.masterPath = text.trim();
      };

      this.masterBrowse = new PushButton(this);
      this.masterBrowse.text = "Browse...";
      this.masterBrowse.onClick = function () {
         var dlg = new OpenFileDialog;
         dlg.caption = "Choose the master light";
         dlg.multipleSelections = false;
         // Every format PixInsight can read, from PixInsight itself. Writing
         // the list by hand is how the filter came to match nothing.
         dlg.loadImageFilters();
         if (self.masterPath.length > 0) {
            dlg.initialPath = directoryOf(self.masterPath);
         }
         if (dlg.execute()) {
            self.masterPath = dlg.filePath;
            self.masterEdit.text = self.masterPath;
         }
      };

      var masterRow = new HorizontalSizer;
      masterRow.spacing = 6;
      masterRow.add(this.masterLabel);
      masterRow.add(this.masterEdit, 100);
      masterRow.add(this.masterBrowse);

      this.outputLabel = new Label(this);
      this.outputLabel.text = "Composite:";
      this.outputLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.outputLabel.setFixedWidth(labelWidth);

      this.outputEdit = new Edit(this);
      this.outputEdit.text = this.outputPath;
      this.outputEdit.toolTip =
         "<p>Where to write the composite. The mask is written beside it with "
       + "_mask added to the name, because when a composite looks wrong the "
       + "mask is the first thing to look at.</p>";
      this.outputEdit.onTextUpdated = function (text) {
         self.outputPath = text.trim();
      };

      this.outputBrowse = new PushButton(this);
      this.outputBrowse.text = "Browse...";
      this.outputBrowse.onClick = function () {
         var dlg = new SaveFileDialog;
         dlg.caption = "Save the composite as";
         dlg.filters = [["XISF", "*.xisf"]];
         dlg.overwritePrompt = true;
         if (self.outputPath.length > 0) {
            // A directory. A path with a file name on the end is not a
            // documented use of initialPath.
            dlg.initialPath = directoryOf(self.outputPath);
         }
         if (dlg.execute()) {
            self.outputPath = dlg.filePath;
            self.outputEdit.text = self.outputPath;
         }
      };

      var outputRow = new HorizontalSizer;
      outputRow.spacing = 6;
      outputRow.add(this.outputLabel);
      outputRow.add(this.outputEdit, 100);
      outputRow.add(this.outputBrowse);

      this.composeButton = new PushButton(this);
      this.composeButton.text = "Compose";
      this.composeButton.defaultButton = true;
      this.composeButton.onClick = function () {
         var problem = self.validate();
         if (problem !== null) {
            (new MessageBox(problem, TITLE, StdIcon.Warning,
                            StdButton.Ok)).execute();
            return;
         }
         self.ok();
      };

      this.cancelButton = new PushButton(this);
      this.cancelButton.text = "Cancel";
      this.cancelButton.onClick = function () {
         self.cancel();
      };

      var buttons = new HorizontalSizer;
      buttons.addStretch();
      buttons.add(this.composeButton);
      buttons.addSpacing(6);
      buttons.add(this.cancelButton);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 12;
      this.sizer.spacing = 6;
      this.sizer.add(this.infoLabel);
      this.sizer.addSpacing(6);
      this.sizer.add(masterRow);
      this.sizer.add(outputRow);
      this.sizer.addSpacing(10);
      this.sizer.add(buttons);

      this.adjustToContents();
      this.setMinWidth(640);
      // Paths are long and the fields hold text, so let it be widened.
      this.userResizable = true;
   }

   // Checked here rather than after the operator has waited a minute for
   // thirty frames to be read.
   validate() {
      if (this.masterPath.length === 0) {
         return "Choose a master light.";
      }
      if (!File.exists(this.masterPath)) {
         return "That master does not exist:\n" + this.masterPath;
      }
      if (this.outputPath.length === 0) {
         return "Choose where to write the composite.";
      }
      var dir = directoryOf(this.outputPath);
      if (dir.length > 0 && !File.directoryExists(dir)) {
         return "That output directory does not exist:\n" + dir;
      }
      if (this.outputPath === this.masterPath) {
         return "The composite would overwrite the master. Choose another "
              + "output file.";
      }
      return null;
   }
};

var MeteorComposerDialog = class extends Dialog {
   constructor(mode) {
      super();

      this.mode = mode;
      this.session = null;
      this.displayed = [];     // filtered + sorted rows, what the list shows
      this.currentRow = -1;
      this.cache = new FrameCache(FRAME_CACHE_SIZE);
      this.cache.lockSTF = true;
      this.registeredDir = "";
      this.detectionResults = null;
      this.cancelRequested = false;
      this._syncingSelection = false;
      // Set when a verdict changes, cleared when the work reaches disk by any
      // route. Autosave normally clears it within a keystroke, so the
      // confirmation on close only appears when saving is actually failing -
      // which is exactly when it is worth appearing.
      this.dirty = false;
      this.resultsPath = null;
      this.outputDir = "";
      // Whether the operator set it themselves. A guess may be replaced by a
      // better guess; a choice may not.
      this.outputDirChosen = false;
      this.autosaveError = null;
      // The exclusion mask (docs/requirements.md 5). Two sources, one at a
      // time. "edges" with every number at zero excludes nothing, which is what
      // an untouched dialog has to mean: the mask must not be able to change a
      // result by being present.
      // Raised until restoreSettings() finishes. Persisting the mask is driven
      // from refreshMask(), which runs while the controls are being built, and
      // at that point the model holds defaults rather than anything the
      // operator chose.
      this._restoringSettings = true;
      this.maskMode = "edges";
      this.maskEdges = makeEdgeSpec();
      this.maskFilePath = "";
      // As read from disk, and the same field turned by maskFileRotation. Both
      // are kept so that changing the turn does not re-read the file.
      this.maskFileLumRaw = null;
      this.maskFileLum = null;
      this.maskFileRotation = 0;
      // Opening a frame costs about a second, so the first one is shown once
      // the window is up rather than during construction, where the wait would
      // read as a hang.
      this._firstFrameShown = false;
      // Screening opens sorted by score, highest first: the ordering was
      // measured to put 25 of 31 labelled meteors in the top 50 rows.
      // Ground-truth mode opens in capture order, because ordering by the
      // classifier's opinion is itself a nudge (docs/tests.md 5-2).
      this.sortKey = defaultSortKey(mode);
      this.sortAscending = (this.sortKey !== "score");

      var self = this;

      this.windowTitle = TITLE + " " + VERSION + "  -  "
                       + (mode === MODE.GROUND_TRUTH ? "Ground truth" : "Screening");

      // Replaced below by the width the columns actually need. 380 was a round
      // number, and eight columns did not fit in it.
      this.listWidth = 380;
      // Narrower than it was. Three panes shared a window, and with the list
      // opened wide enough for its columns the preview - the pane the judgement
      // is actually made in - was left the least of it. The splitter is there
      // for an operator who wants it wider.
      this.detailWidth = 280;

      this.buildSourceSection();
      this.buildListSection();
      this.buildPreviewSection();
      this.buildDetailSection();
      this.buildVerdictSection();
      this.buildButtonSection();

      // PJSR has no splitter, so the panes on either side carry a fixed width
      // and the preview in the middle takes whatever is left. Dragging a
      // handle adjusts the neighbouring fixed width.
      this.listPanel = new Control(this);
      this.listPanel.sizer = this.listSizer;
      this.listPanel.setFixedWidth(this.listWidth);

      this.previewPanel = new Control(this);
      this.previewPanel.sizer = this.previewSizer;

      this.detailPanel = new Control(this);
      this.detailPanel.sizer = this.detailSizer;
      this.detailPanel.setFixedWidth(this.detailWidth);

      this.listSplitter = new SplitterHandle(this, function (delta) {
         self.setListWidth(self.listWidth + delta);
      }, function () {
         self.saveViewSettings();
      });
      // Dragging the right-hand handle rightwards should shrink the detail
      // pane, hence the inverted sign.
      this.detailSplitter = new SplitterHandle(this, function (delta) {
         self.setDetailWidth(self.detailWidth - delta);
      }, function () {
         self.saveViewSettings();
      });

      // The toolbar spans both previews, so the two panes and the handle
      // between them sit under one header.
      var viewSplit = new HorizontalSizer;
      viewSplit.spacing = 0;
      viewSplit.add(this.previewPanel, 100);
      viewSplit.add(this.detailSplitter);
      viewSplit.add(this.detailPanel);

      var viewSizer = new VerticalSizer;
      viewSizer.spacing = 4;
      viewSizer.add(this.viewToolbar);
      viewSizer.add(viewSplit, 100);

      this.viewPanel = new Control(this);
      this.viewPanel.sizer = viewSizer;

      var split = new HorizontalSizer;
      split.spacing = 0;
      split.add(this.listPanel);
      split.add(this.listSplitter);
      split.add(this.viewPanel, 100);

      this.sizer = new VerticalSizer;
      this.sizer.margin = DIALOG_MARGIN;
      this.sizer.spacing = 6;
      this.sizer.add(this.sourceGroup);
      this.sizer.add(split, 100);
      this.sizer.add(this.verdictGroup);
      this.sizer.add(this.buttonSizer);

      this.setMinSize(1180, 760);

      // Narrowing the window has to pull the fixed panes back in, or the row
      // overflows off the edge with no scrollbar to recover it.
      this.onResize = function () {
         self.reclampPanes();
      };

      // The dialog, the list and the preview all get the same handler:
      // whichever has focus, the judging keys have to work.
      var keyHandler = function (key, modifiers) {
         return self.handleKey(key, modifiers);
      };
      this.onKeyPress = keyHandler;
      this.candidateTree.onKeyPress = keyHandler;
      this.preview.onKeyPress = keyHandler;

      // The list pane opens wide enough to hold its columns. Anything narrower
      // and the operator meets a horizontal scrollbar before they meet the
      // Score column, which is one of the two reasons the list is sorted at all.
      //
      // Before restoreSettings, so that an operator who has dragged the
      // splitter keeps where they put it: a default may be improved, a choice
      // may not.
      if (this.columnsWidth > 0) {
         this.setListWidth(this.columnsWidth + 24);
      }

      this.restoreSettings();
      this.updateEnabled();

      // Not in the constructor: opening a frame takes about a second, and a
      // second before the window appears is indistinguishable from a hang.
      // processEvents() first so the dialog is actually painted before the wait.
      this.onShow = function () {
         if (self._firstFrameShown) {
            return;
         }
         self._firstFrameShown = true;
         if (self.registeredDir.length === 0) {
            return;
         }
         CoreApplication.processEvents();
         self.showFirstFrame();
      };
   }

   // --- Construction -------------------------------------------------------

   buildSourceSection() {
      var self = this;

      this.sourceGroup = new GroupBox(this);
      this.sourceGroup.title = "Source / Destination";

      var pathLabelWidth = 58;

      this.dirLabel = new Label(this.sourceGroup);
      this.dirLabel.text = "Frames:";
      this.dirLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.dirLabel.setFixedWidth(pathLabelWidth);

      this.dirEdit = new Edit(this.sourceGroup);
      this.dirEdit.readOnly = true;
      this.dirEdit.toolTip = "<p>Directory of registered frames (.xisf). Read "
                           + "only - nothing is ever written here.</p>";

      this.browseButton = new PushButton(this.sourceGroup);
      this.browseButton.text = "Browse...";
      this.browseButton.onClick = function () {
         var dlg = new GetDirectoryDialog;
         dlg.caption = "Registered frames directory";
         if (dlg.execute()) {
            self.registeredDir = dlg.directory;
            self.dirEdit.text = dlg.directory;
            // Only a guess, and only when the operator has not made a choice
            // of their own: overwriting a deliberate setting because the
            // frames changed would be worse than guessing wrong once.
            if (!self.outputDirChosen) {
               self.setOutputDir(defaultOutputDir(dlg.directory));
            }
            self.updateEnabled();
            // A mask is set by looking at the frame, so the frame comes first.
            self.cache.clear();
            self._firstFrameShown = true;
            self.showFirstFrame();
         }
      };

      // Everything this script produces goes here: the detection results, the
      // session that saves itself after every verdict, and the composite.
      //
      // It is a field in the window rather than a question asked later, and
      // that is the correction to a real failure. Detection used to write its
      // results NOWHERE - eight minutes of work lived in memory and left with
      // the dialog - and the session saved itself into the directory of
      // registered frames, which is the operator's input data and the last
      // place anyone would look. Neither was visible from the UI, so neither
      // could be noticed.
      this.outputLabel = new Label(this.sourceGroup);
      this.outputLabel.text = "Output:";
      this.outputLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.outputLabel.setFixedWidth(pathLabelWidth);

      this.outputEdit = new Edit(this.sourceGroup);
      this.outputEdit.toolTip =
         "<p>Where everything this script writes goes: detection_results.json, "
       + "the screening session (saved automatically after every verdict) and "
       + "the composite.</p>"
       + "<p>Kept out of the frames directory on purpose: that holds your "
       + "input data.</p>";
      this.outputEdit.onTextUpdated = function (text) {
         self.outputDir = text.trim();
         self.outputDirChosen = true;
      };

      this.outputBrowseButton = new PushButton(this.sourceGroup);
      this.outputBrowseButton.text = "Browse...";
      this.outputBrowseButton.onClick = function () {
         var dlg = new GetDirectoryDialog;
         dlg.caption = "Where to write results";
         if (self.outputDir.length > 0) {
            dlg.initialPath = self.outputDir;
         }
         if (dlg.execute()) {
            self.setOutputDir(dlg.directory);
            self.outputDirChosen = true;
         }
      };

      this.detectButton = new PushButton(this.sourceGroup);
      this.detectButton.text = "Run detection";
      this.detectButton.onClick = function () {
         self.runDetection();
      };

      this.loadButton = new PushButton(this.sourceGroup);
      this.loadButton.text = "Load results...";
      this.loadButton.toolTip =
         "<p>Load a detection_results.json produced by an earlier run, so that "
       + "screening can be redone without detecting again.</p>";
      this.loadButton.onClick = function () {
         self.loadResults();
      };

      this.progressLabel = new Label(this.sourceGroup);
      this.progressLabel.text = "No detection results loaded.";

      this.cancelDetectionButton = new PushButton(this.sourceGroup);
      this.cancelDetectionButton.text = "Cancel";
      this.cancelDetectionButton.enabled = false;
      this.cancelDetectionButton.onClick = function () {
         self.cancelRequested = true;
      };

      var row1 = new HorizontalSizer;
      row1.spacing = 6;
      row1.add(this.dirLabel);
      row1.add(this.dirEdit, 100);
      row1.add(this.browseButton);

      var rowOutput = new HorizontalSizer;
      rowOutput.spacing = 6;
      rowOutput.add(this.outputLabel);
      rowOutput.add(this.outputEdit, 100);
      rowOutput.add(this.outputBrowseButton);

      var row2 = new HorizontalSizer;
      row2.spacing = 6;
      row2.add(this.detectButton);
      row2.add(this.loadButton);
      row2.addSpacing(12);
      row2.add(this.progressLabel, 100);
      row2.add(this.cancelDetectionButton);

      this.sourceGroup.sizer = new VerticalSizer;
      this.sourceGroup.sizer.margin = 6;
      this.sourceGroup.sizer.spacing = 4;
      var maskRows = this.buildMaskRows(pathLabelWidth);

      this.sourceGroup.sizer.add(row1);
      this.sourceGroup.sizer.add(rowOutput);
      for (var m = 0; m < maskRows.length; ++m) {
         this.sourceGroup.sizer.add(maskRows[m]);
      }
      this.sourceGroup.sizer.add(row2);
   }

   // The exclusion mask.
   //
   // Two sources, one at a time: numbers per edge, or a painted image. Numbers
   // cover what actually happens - the ground across the bottom, trees up one
   // side - and an image covers everything else. A radio and not both at once,
   // because with two sources active no reading of the dialog tells you which
   // one put a shadow where.
   //
   // It sits below Output rather than between Frames and Output: those two are
   // a pair, where the frames are read and where the results are written, and
   // a mask is neither. It is a detection setting, so it belongs next to Run
   // detection.
   //
   // Per edge: how far in the band reaches, how much the boundary is tilted, and
   // which way. The tilt is signed and PJSR's SpinBox cannot hold a negative
   // number, so the sign is split off into the direction tick - which is the
   // operator's own suggestion, and better than the alternative that was tried:
   // two non-negative end depths cannot describe a boundary that leaves through
   // the edge it belongs to, which is exactly the corner cut a real mask needed.
   //
   // Two rows of two edges. One row was measured at 1203-1235 px against the
   // 1152 available at the dialog's minimum width, so it did not fit; two rows
   // fit with room to spare and leave the excluded-area readout enough space to
   // say what it means.
   buildMaskRows(pathLabelWidth) {
      var self = this;
      var group = this.sourceGroup;
      var nameWidth = this.font.width("Bottom:") + 6;

      this.maskLabel = new Label(group);
      this.maskLabel.text = "Mask:";
      this.maskLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
      this.maskLabel.setFixedWidth(pathLabelWidth);

      this.maskEdgesRadio = new RadioButton(group);
      this.maskEdgesRadio.text = "Edges";
      this.maskEdgesRadio.toolTip =
         "<p>Exclude a band along one or more edges of the frame.</p>"
       + "<p>All zero excludes nothing.</p>";
      this.maskEdgesRadio.checked = true;
      this.maskEdgesRadio.onCheck = function (checked) {
         if (checked) {
            self.maskMode = "edges";
            self.maskSourceChanged();
         }
      };

      this.maskFileRadio = new RadioButton(group);
      this.maskFileRadio.text = "Image";
      this.maskFileRadio.toolTip =
         "<p>Exclude wherever a painted image is black. For a shape straight "
       + "edges cannot describe, such as a tree line.</p>";
      this.maskFileRadio.onCheck = function (checked) {
         if (checked) {
            self.maskMode = "file";
            self.maskSourceChanged();
         }
      };

      // A RadioButton asks for a comfortable minimum width, and two of them
      // asking for it pushed the numbers out of the group.
      var radioWidth = Math.max(this.font.width(this.maskEdgesRadio.text),
                                this.font.width(this.maskFileRadio.text)) + 30;
      this.maskEdgesRadio.setFixedWidth(radioWidth);
      this.maskFileRadio.setFixedWidth(radioWidth);

      this.maskEdgeControls = {};

      var makeCell = function (edge, name) {
         var nameLabel = new Label(group);
         nameLabel.text = name + ":";
         nameLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
         nameLabel.setFixedWidth(nameWidth);

         var depthTip = "<p>How far in from the " + name.toLowerCase()
                      + " edge is excluded, as a percentage of the frame.</p>";

         var percent = new SpinBox(group);
         percent.setRange(0, 100);
         percent.stepSize = 1;
         percent.suffix = " %";
         percent.value = Math.round(self.maskEdges[edge].percent);
         percent.toolTip = depthTip;
         percent.onValueUpdated = function (value) {
            self.maskEdges[edge].percent = value;
            self.refreshMask();
         };

         var tiltTip =
            "<p>Tilt of the boundary, in degrees, turning about the middle of "
          + "the edge - so the excluded area stays where you set it while you "
          + "adjust the slope.</p>"
          + "<p>Clockwise on screen unless CCW is ticked. At zero depth a tilt "
          + "still cuts a corner, which is often what is wanted.</p>";

         var tilt = new SpinBox(group);
         tilt.setRange(0, 45);
         tilt.stepSize = 1;
         tilt.suffix = " deg";
         tilt.value = Math.round(Math.abs(self.maskEdges[edge].angle));
         tilt.toolTip = tiltTip;
         tilt.onValueUpdated = function (value) {
            self.maskEdges[edge].angle = self.maskEdgeControls[edge].ccw.checked
               ? -value : value;
            self.refreshMask();
         };

         // The sign, split off because a SpinBox cannot hold one.
         var ccw = new CheckBox(group);
         ccw.text = "CCW";
         ccw.checked = self.maskEdges[edge].angle < 0;
         ccw.toolTip =
            "<p>Tilt the other way: counter-clockwise on screen instead of "
          + "clockwise.</p>"
          + "<p>Nothing to do while the tilt is zero.</p>";
         ccw.onCheck = function (checked) {
            var magnitude = self.maskEdgeControls[edge].tilt.value;
            self.maskEdges[edge].angle = checked ? -magnitude : magnitude;
            self.refreshMask();
         };

         self.maskEdgeControls[edge] = { percent: percent, tilt: tilt, ccw: ccw };

         var cell = new HorizontalSizer;
         cell.spacing = 2;
         cell.add(nameLabel);
         cell.add(percent);
         cell.add(tilt);
         cell.add(ccw);
         return cell;
      };

      var spacer = function (width) {
         var label = new Label(group);
         label.text = "";
         label.setFixedWidth(width);
         return label;
      };

      // The one number that makes over-masking visible. Nothing else in the
      // dialog would show it: detection would simply find less, and quietly.
      //
      // It is worth watching. Measured on the 2026-08-12 session, a hand-painted
      // mask excluding 10.3% of the frame cost six labelled meteors, one of them
      // a visual one - the hard gate - and nothing but this number hinted at it.
      this.maskReadout = new Label(group);
      this.maskReadout.text = "Excluded: none";
      this.maskReadout.textAlignment = TextAlignment.Left | TextAlignment.VertCenter;
      this.maskReadout.toolTip =
         "<p>How much of the frame the mask excludes. Detection never looks "
       + "there, and it is left out of the statistics too.</p>"
       + "<p>Worth watching: over-masking costs meteors and there is no other "
       + "sign of it - the candidate list simply comes back shorter.</p>"
       + "<p>You do not need a mask for the area outside the registered frame. "
       + "Samples with no data are found and excluded automatically, per frame, "
       + "and they follow the shape exactly - which a straight edge cannot.</p>";
      this.maskReadout.setFixedWidth(
         Math.max(this.font.width("Excluded: 100.0% of the frame"),
                  this.font.width(MASK_UNREADABLE)) + 8);

      var rowTop = new HorizontalSizer;
      rowTop.spacing = 6;
      rowTop.add(this.maskLabel);
      rowTop.add(this.maskEdgesRadio);
      rowTop.add(makeCell("top", "Top"));
      rowTop.addSpacing(14);
      rowTop.add(makeCell("left", "Left"));
      rowTop.addStretch();

      var rowBottom = new HorizontalSizer;
      rowBottom.spacing = 6;
      rowBottom.add(spacer(pathLabelWidth));
      rowBottom.add(spacer(radioWidth));
      rowBottom.add(makeCell("bottom", "Bottom"));
      rowBottom.addSpacing(14);
      rowBottom.add(makeCell("right", "Right"));
      rowBottom.addStretch();
      rowBottom.add(this.maskReadout);

      this.maskFileEdit = new Edit(group);
      this.maskFileEdit.readOnly = true;
      this.maskFileEdit.toolTip =
         "<p>A painted mask. Black is excluded; anything brighter than halfway "
       + "is kept.</p>"
       + "<p>It does not have to be the frame's size - it is stretched to "
       + "cover the frame.</p>";

      this.maskFileBrowseButton = new PushButton(group);
      this.maskFileBrowseButton.text = "Browse...";
      this.maskFileBrowseButton.onClick = function () {
         self.chooseMaskFile();
      };

      // A painted mask is read in the FRAME's orientation, and that is not
      // always the orientation it was painted in - the preview can be turned,
      // and a file can arrive from anywhere. Turning it here beats sending the
      // operator back to an image editor, which is what happened the first time
      // this came up.
      this.maskRotateLabel = new Label(group);
      this.maskRotateLabel.text = "Turn:";
      this.maskRotateLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.maskRotateCombo = new ComboBox(group);
      this.maskRotations = [0, 90, 180, 270];
      for (var mr = 0; mr < this.maskRotations.length; ++mr) {
         this.maskRotateCombo.addItem(this.maskRotations[mr] + " deg");
      }
      this.maskRotateCombo.currentItem = 0;
      this.maskRotateCombo.toolTip =
         "<p>Turn the mask image clockwise before it is used, in case it was "
       + "painted or saved in a different orientation from the frame.</p>"
       + "<p>The mask is read in the frame's own orientation, which is not "
       + "necessarily the one on screen: turning the preview does not move "
       + "it.</p>";
      this.maskRotateCombo.onItemSelected = function (index) {
         self.maskFileRotation = self.maskRotations[index];
         self.applyMaskFileRotation();
         self.refreshMask();
      };

      var rowFile = new HorizontalSizer;
      rowFile.spacing = 6;
      rowFile.add(spacer(pathLabelWidth));
      rowFile.add(this.maskFileRadio);
      rowFile.add(this.maskFileEdit, 100);
      rowFile.add(this.maskFileBrowseButton);
      rowFile.addSpacing(10);
      rowFile.add(this.maskRotateLabel);
      rowFile.add(this.maskRotateCombo);

      return [rowTop, rowBottom, rowFile];
   }

   buildListSection() {
      var self = this;

      this.candidateTree = new TreeBox(this);
      this.candidateTree.alternateRowColor = true;
      this.candidateTree.headerVisible = true;
      this.candidateTree.headerSorting = false; // sorting is handled here
      this.candidateTree.rootDecoration = false;
      this.candidateTree.multipleSelection = false;

      // The score column exists only in screening mode. In ground-truth mode
      // it must not be present at all: showing the classifier's opinion while
      // someone labels the data it will be evaluated against makes the
      // evaluation circular (docs/tests.md 5-2).
      // "Frame" rather than "File": the column holds a short tag, not a path.
      // The full name is on the row as a tooltip and above the preview.
      this.columns = ["#", "Frame", "Len", "Ang", "Elong", "Track", "Verdict"];
      if (modeShowsScores(this.mode)) {
         this.columns.splice(6, 0, "Score");
      }

      this.candidateTree.numberOfColumns = this.columns.length;
      for (var i = 0; i < this.columns.length; ++i) {
         this.candidateTree.setHeaderText(i, this.columns[i]);
      }

      // Widths from the font rather than from round numbers. Fixed pixel counts
      // were the reason the list needed a horizontal scrollbar: eight columns
      // adding up to more than the pane, with the file column alone taking 210
      // of it to show a 47-character name.
      //
      // Each column gets the wider of its header and the widest value it will
      // hold, which is a measurement rather than an estimate.
      var sample = { "#": "4999", "Frame": "DSC04908", "Len": "999.9",
                     "Ang": "-179.9", "Elong": "99.9", "Track": "still x99",
                     "Score": "0.999", "Verdict": "not meteor" };
      var totalWidth = 0;
      for (i = 0; i < this.columns.length; ++i) {
         var name = this.columns[i];
         var text = sample[name] === undefined ? name : sample[name];
         var w = Math.max(this.font.width(name), this.font.width(text)) + 16;
         this.candidateTree.setColumnWidth(i, w);
         totalWidth += w;
      }
      // Remembered so the pane can be opened wide enough to hold them all.
      this.columnsWidth = totalWidth;

      // Column 0 holds the row's position in the displayed list, one-based,
      // which is also the number drawn on the preview.
      this.candidateTree.onCurrentNodeUpdated = function (node) {
         if (node === null || self._syncingSelection) {
            return;
         }
         self.selectDisplayed(parseInt(node.text(0), 10) - 1, false);
      };

      this.sortCombo = new ComboBox(this);
      this.sortCombo.addItem("Capture order");
      this.sortCombo.addItem("Length");
      this.sortCombo.addItem("Elongation");
      this.sortCombo.addItem("Track length");
      this.sortCombo.addItem("Verdict");
      this.sortKeys = ["frameIndex", "length", "elongation", "trackLength", "verdict"];
      if (modeShowsScores(this.mode)) {
         this.sortCombo.addItem("Score");
         this.sortKeys.push("score");
      }
      this.sortCombo.onItemSelected = function (index) {
         self.sortKey = self.sortKeys[index];
         // Longest first is the useful direction for length; everything else
         // reads forwards.
         self.sortAscending = (self.sortKey !== "length" && self.sortKey !== "score");
         self.refreshList();
      };
      var startIndex = this.sortKeys.indexOf(this.sortKey);
      this.sortCombo.currentItem = startIndex >= 0 ? startIndex : 0;

      // Reviewing your own calls. Available in both modes: this narrows by
      // what the operator decided, not by what the classifier decided, so it
      // is not the kind of filtering docs/tests.md 5-2 rules out.
      this.showLabel = new Label(this);
      this.showLabel.text = "Show:";
      this.showLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.showCombo = new ComboBox(this);
      this.showCombo.addItem("All");
      this.showCombo.addItem("Unreviewed");
      this.showCombo.addItem("Reviewed");
      this.showCombo.addItem("Meteor");
      this.showCombo.addItem("Not a meteor");
      this.showCombo.addItem("Uncertain");
      this.showFilters = [
         null,
         [VERDICT.UNREVIEWED],
         [VERDICT.METEOR, VERDICT.NOT_METEOR, VERDICT.UNCERTAIN],
         [VERDICT.METEOR],
         [VERDICT.NOT_METEOR],
         [VERDICT.UNCERTAIN]
      ];
      this.showFilter = null;
      this.scoreCutoff = 0;
      this.showCombo.onItemSelected = function (index) {
         self.showFilter = self.showFilters[index];
         self.refreshList();
      };

      // Score cutoff. requirements.md 6.2 asks for three presets plus one
      // slider rather than exposing every threshold. Everything below the
      // cutoff is still in the session - it is hidden from the list, not
      // discarded - and the default hides nothing.
      this.presetLabel = new Label(this);
      this.presetLabel.text = "Cutoff:";
      this.presetLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.presetCombo = new ComboBox(this);
      this.presetNameList = presetNames();
      for (var pi = 0; pi < this.presetNameList.length; ++pi) {
         this.presetCombo.addItem(PRESETS[this.presetNameList[pi]].label);
      }
      this.presetCombo.currentItem = 0;
      this.presetCombo.toolTip =
         "<p>Hide candidates whose score falls below the cutoff. Nothing is "
       + "deleted: the verdicts and the export still cover every candidate. "
       + "Measured on the 2026-08-12 session, the strict cutoff kept all 31 "
       + "labelled meteors while shrinking the list from 411 rows to 116.</p>";
      this.presetCombo.onItemSelected = function (index) {
         self.scoreCutoff = PRESETS[self.presetNameList[index]].cutoff;
         self.refreshList();
      };
      // Score-based hiding is classifier-derived, so it has no place in
      // ground-truth mode (docs/tests.md 5-2).
      if (!modeShowsScores(this.mode)) {
         this.presetCombo.enabled = false;
         this.presetLabel.enabled = false;
         this.presetCombo.toolTip =
            "<p>Disabled in ground-truth mode: narrowing the list by the "
          + "classifier's own score is what makes an evaluation circular.</p>";
      }

      this.hidePersistentCheck = new CheckBox(this);
      // "persistent" is the implementation's word and it does not survive
      // contact with an operator: asked what it hid, the answer given was
      // "fixed structures", which is a different thing entirely. Fixed
      // structures are flagged `stationary` and are pushed down the ranking,
      // never hidden - hiding them here would report them as satellites, and
      // the reason an operator reads would be a lie.
      this.hidePersistentCheck.text = "Hide satellites and aircraft";
      this.hidePersistentCheck.toolTip =
         "<p>Hide candidates whose track spans more frames than a meteor can: "
       + "more than maxMeteorFrames. Those move smoothly across the session, "
       + "which is a satellite or an aircraft.</p>"
       + "<p>This does NOT hide detections that never move - the ones that "
       + "come back at the same place frame after frame, which is what a star "
       + "does. Those are scored down instead: calling them satellites would "
       + "tell you the wrong thing about what you are looking at.</p>";
      this.hidePersistentCheck.onCheck = function () {
         self.refreshList();
      };
      // docs/tests.md 5-2: in ground-truth mode every candidate is shown.
      // The control is not merely ignored, it is disabled, so the state of
      // the UI matches what the model will do.
      if (!modeAllowsClassifierFiltering(this.mode)) {
         this.hidePersistentCheck.enabled = false;
         this.hidePersistentCheck.toolTip =
            "<p>Filtering is disabled in ground-truth mode: building the "
          + "evaluation set only from candidates the operational settings "
          + "surfaced would make recall a tautology.</p>";
      }

      this.sortLabel = new Label(this);
      this.sortLabel.text = "Sort:";
      this.sortLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      // A combo box is horizontally expandable, so without a stretch at the end
      // of the row the two of them share out all the spare width and the row
      // still runs past the pane. The stretch takes it instead.
      var controls = new HorizontalSizer;
      controls.spacing = 6;
      controls.add(this.showLabel);
      controls.add(this.showCombo);
      controls.addSpacing(8);
      controls.add(this.sortLabel);
      controls.add(this.sortCombo);
      controls.addStretch();

      var controls2 = new HorizontalSizer;
      controls2.spacing = 6;
      controls2.add(this.presetLabel);
      controls2.add(this.presetCombo);
      controls2.addStretch();

      // Its own row. Beside the cutoff combo it was cut off mid-word - "Hide
      // satellites and aircra" - and a control whose label is truncated is a
      // control nobody dares press. The rename that made it readable also made
      // it longer, so it no longer shares a line with anything.
      var controls3 = new HorizontalSizer;
      controls3.spacing = 6;
      controls3.add(this.hidePersistentCheck);
      controls3.addStretch();

      this.listSizer = new VerticalSizer;
      this.listSizer.spacing = 4;
      this.listSizer.add(controls);
      this.listSizer.add(controls2);
      this.listSizer.add(controls3);
      this.listSizer.add(this.candidateTree, 100);
   }

   buildPreviewSection() {
      var self = this;

      this.preview = new MeteorPreviewControl(this);
      this.preview.setScaledMinSize(420, 380);
      this.preview.onCandidateClick = function (candidateIndex) {
         self.selectByCandidateIndex(candidateIndex);
      };

      this.fitButton = new ToolButton(this);
      this.fitButton.text = "Fit";
      this.fitButton.onClick = function () {
         self.preview.fitToWindow();
      };

      this.zoom11Button = new ToolButton(this);
      this.zoom11Button.text = "1:1";
      this.zoom11Button.onClick = function () {
         self.preview.zoom11();
         self.preview.centreOn(self.currentCandidateIndex());
      };

      this.zoomInButton = new ToolButton(this);
      this.zoomInButton.text = "+";
      this.zoomInButton.onClick = function () {
         self.preview.zoomIn();
      };

      this.zoomOutButton = new ToolButton(this);
      this.zoomOutButton.text = "-";
      this.zoomOutButton.onClick = function () {
         self.preview.zoomOut();
      };

      // A ComboBox rather than three buttons, measured rather than guessed.
      // The preview pane promises 420 px (setScaledMinSize) and the toolbar
      // already wants 703. Three ToolButtons take it to 914 and squeeze the
      // frame name down to 31 px at the minimum window width; label plus
      // ComboBox takes it to 830 and leaves the name 42. Neither clips a
      // control, so the choice went to the narrower one - which also shows the
      // current mode natively, instead of the "▶Linked" text marker the two
      // solver scripts use to fake it. tests/pjsr/probe_layout.js stage 6.
      this.stfLabel = new Label(this);
      this.stfLabel.text = "STF:";
      this.stfLabel.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;

      this.stfCombo = new ComboBox(this);
      this.stfCombo.addItem("None");
      this.stfCombo.addItem("Linked");
      this.stfCombo.addItem("Unlinked");
      // A ComboBox starts on item 0, so leaving this out would show "None"
      // while the cache renders unlinked. The control and the thing it
      // controls have to start from the same place, and the order of STF_MODES
      // is the order of the items.
      this.stfCombo.currentItem = STF_MODES.indexOf("unlinked");
      this.stfCombo.toolTip =
         "<p><b>Unlinked</b> stretches each channel on its own statistics. It "
       + "pulls the colour cast out of the sky, which is usually the easiest "
       + "background to spot a faint trail against. This is the default.</p>"
       + "<p><b>Linked</b> uses one stretch for all three channels, so the "
       + "trail keeps the colour it was recorded with. Worth a look when you "
       + "are deciding whether something is a meteor: they tend to be green, "
       + "and unlinked takes that cue away.</p>"
       + "<p><b>None</b> is the linear image. Almost everything disappears, "
       + "which is what makes it useful for judging how bright a trail really "
       + "was.</p>";
      this.stfCombo.onItemSelected = function (index) {
         self.setSTFMode(STF_MODES[index]);
      };

      this.lockSTFCheck = new CheckBox(this);
      this.lockSTFCheck.text = "Lock stretch";
      this.lockSTFCheck.checked = true;
      this.lockSTFCheck.toolTip =
         "<p>Reuse the stretch computed from the first frame. Median and MAD "
       + "cost about 445 ms of the ~1.2 s each frame takes, and registered "
       + "frames from one session are near-identical, so locking makes "
       + "stepping through the list noticeably quicker.</p>";
      this.rotateLeftButton = new ToolButton(this);
      this.rotateLeftButton.text = "↶";
      this.rotateLeftButton.toolTip =
         "<p>Turn the preview a quarter turn anticlockwise. The rotation is a "
       + "property of the view, not of the frame, so it stays as you move "
       + "through the candidates.</p>";
      this.rotateLeftButton.onClick = function () {
         self.setRotation(self.preview.rotation - 90);
      };

      this.rotateRightButton = new ToolButton(this);
      this.rotateRightButton.text = "↷";
      this.rotateRightButton.toolTip =
         "<p>Turn the preview a quarter turn clockwise.</p>";
      this.rotateRightButton.onClick = function () {
         self.setRotation(self.preview.rotation + 90);
      };

      this.lockSTFCheck.onCheck = function (checked) {
         self.cache.lockSTF = checked;
         if (!checked) {
            self.cache.lockedSTF = null;
         }
         self.cache.clear();
         self.showCurrentFrame();
      };

      this.frameLabel = new Label(this);
      this.frameLabel.text = "";

      // ToolButton, not PushButton, and that is the whole fix.
      //
      // These six buttons hold one to three characters each and were taking 102
      // px apiece, which filled the preview pane and pushed "Lock stretch" off
      // the edge. Sizing them to their labels was tried and did nothing: a
      // PushButton on this platform has a minimum width of 102 and
      // setFixedWidth() cannot go under it - it sets maxWidth and leaves
      // minWidth alone, so the button comes out at 102 regardless. Measured, in
      // tests/pjsr/probe_layout.js, along with a ToolButton coming out at
      // exactly the width it is given.
      //
      // They still get an explicit width, because a bare ToolButton sizes to
      // its text and six differently-sized buttons in a row read as a mess.
      var toolButtons = [this.fitButton, this.zoom11Button, this.zoomInButton,
                         this.zoomOutButton, this.rotateLeftButton,
                         this.rotateRightButton];
      var toolWidth = 0;
      for (var tb = 0; tb < toolButtons.length; ++tb) {
         toolWidth = Math.max(toolWidth, this.font.width(toolButtons[tb].text));
      }
      for (tb = 0; tb < toolButtons.length; ++tb) {
         toolButtons[tb].setFixedWidth(toolWidth + 16);
      }

      // A CheckBox has a minWidth of zero, so a crowded row squeezes it until
      // its own label is cut - measured at 57 px for a control that wants 85,
      // which is where the "h" of "Lock stretch" went. Giving it a floor keeps
      // it whole and lets the frame name, which is next to it and elastic,
      // take the squeeze instead.
      //
      // A floor rather than a fixed width: 19 px of tick box and spacing is
      // what this font and style come to, and a floor still lets the control
      // have more if a different style wants more.
      this.lockSTFCheck.minWidth =
         this.font.width(this.lockSTFCheck.text) + 20;

      // A ComboBox has a minWidth of zero too - the same trap as the CheckBox
      // above, and it was walked into anyway. Measured at 65 px in a 490 px
      // toolbar and 42 px in a 420 px one, for a control whose widest item
      // ("Unlinked") needs 47 px of text plus the drop-down arrow. So the
      // longest item was cut at the width the operator actually opens at.
      //
      // The floor is the widest item plus room for the arrow, which is what
      // adjustToContents() would have asked for - it reports 86 - rather than a
      // number invented here.
      this.stfCombo.adjustToContents();
      this.stfCombo.minWidth = this.stfCombo.width;

      // A Label is elastic as well. "STF:" came out at exactly the width of
      // its text, with nothing to spare.
      this.stfLabel.minWidth = this.font.width(this.stfLabel.text) + 4;

      // Kept on `this` because it no longer lives in this panel. The two
      // previews used to carry a header each, side by side, and the operator
      // reported the left one overlapping itself at the initial window size.
      // One header above both is wider by the whole detail pane - 777 px at
      // the minimum window size instead of 490 - and the detail pane's own
      // controls move a row further in, where 280 px is plenty for them.
      var toolbar = new HorizontalSizer;
      this.viewToolbar = toolbar;
      toolbar.spacing = 4;
      toolbar.add(this.fitButton);
      toolbar.add(this.zoom11Button);
      toolbar.add(this.zoomInButton);
      toolbar.add(this.zoomOutButton);
      toolbar.addSpacing(8);
      toolbar.add(this.rotateLeftButton);
      toolbar.add(this.rotateRightButton);
      toolbar.addSpacing(10);
      toolbar.add(this.stfLabel);
      toolbar.add(this.stfCombo);
      toolbar.addSpacing(10);
      toolbar.add(this.lockSTFCheck);
      toolbar.addSpacing(10);
      toolbar.add(this.frameLabel, 100);

      this.previewSizer = new VerticalSizer;
      this.previewSizer.add(this.preview, 100);

      // Whenever the preview redraws its frame - a new frame, or a turn - the
      // detail pane is looking at a different bitmap and has to follow.
      this.preview.onFrameRedrawn = function () {
         self.updateDetail();
      };
   }

   buildDetailSection() {
      var self = this;

      this.detail = new CandidateDetailControl(this);
      this.detail.setScaledMinSize(220, 220);

      this.detailLabel = new Label(this);
      this.detailLabel.text = "Selected candidate";

      this.detailInButton = new ToolButton(this);
      this.detailInButton.text = "+";
      this.detailInButton.onClick = function () {
         self.detail.setMargin(self.detail.margin / 1.4);
      };

      this.detailOutButton = new ToolButton(this);
      this.detailOutButton.text = "-";
      this.detailOutButton.onClick = function () {
         self.detail.setMargin(self.detail.margin * 1.4);
      };

      var detailWidth = Math.max(this.font.width(this.detailInButton.text),
                                 this.font.width(this.detailOutButton.text)) + 16;
      this.detailInButton.setFixedWidth(detailWidth);
      this.detailOutButton.setFixedWidth(detailWidth);

      var toolbar = new HorizontalSizer;
      toolbar.spacing = 4;
      toolbar.add(this.detailLabel, 100);
      toolbar.add(this.detailInButton);
      toolbar.add(this.detailOutButton);

      this.detailSizer = new VerticalSizer;
      this.detailSizer.spacing = 4;
      this.detailSizer.add(toolbar);
      this.detailSizer.add(this.detail, 100);
   }

   // What the two fixed-width panes may share between them.
   //
   // The blanket cap of 900 each that used to be here ignored the window. At
   // the minimum size of 1180 the row has 1164 to spend, and the list alone
   // wants 380, so:
   //
   //   380 list + 7 handle + 420 preview minimum + 7 handle = 814
   //   leaving 350 for the detail pane, not 900
   //
   // Dragging the handle past that asked for 1714 in a 1164 row. A PJSR dialog
   // has no scrollbar, so the excess does not scroll - it goes off the edge,
   // and the operator sees the right-hand pane's contents slide out of view
   // with nothing to bring them back. Reported as "the detection box
   // disappeared", which is what it looks like from the outside.
   //
   // The preview keeps its minimum rather than sharing the shortfall: it is
   // the pane the judgement is actually made in.
   paneBudget() {
      var usable = this.width - 2 * DIALOG_MARGIN
                 - 2 * SPLITTER_WIDTH - this.preview.minWidth;
      return Math.max(0, usable);
   }

   setListWidth(width) {
      // The floor wins over the budget. A window too small for both floors is
      // prevented by setMinSize, but a floor that gives way would let a pane
      // vanish, and a pane of zero width cannot be dragged back.
      var room = Math.max(LIST_MIN_WIDTH, this.paneBudget() - this.detailWidth);
      this.listWidth = Math.max(LIST_MIN_WIDTH,
                                Math.min(room, Math.round(width)));
      this.listPanel.setFixedWidth(this.listWidth);
   }

   setDetailWidth(width) {
      var room = Math.max(DETAIL_MIN_WIDTH, this.paneBudget() - this.listWidth);
      this.detailWidth = Math.max(DETAIL_MIN_WIDTH,
                                  Math.min(room, Math.round(width)));
      this.detailPanel.setFixedWidth(this.detailWidth);
   }

   // Shrinking the window has to pull the panes back in. Without this, a width
   // that was legal in a wide window stays put when the window narrows, and
   // the row overflows again - the same symptom by a different route. Also
   // covers the widths restored from Settings, which are applied before the
   // window has its real size.
   reclampPanes() {
      // The detail pane gives way first, and the order is the whole point.
      //
      // Clamping the list first made it surrender to whatever the detail pane
      // currently held: widening the detail pane to 510 in a 1180 window left
      // the list at its floor of 220, and the width the operator had chosen for
      // it was gone for good. Found by reading the stored settings back
      // (listWidth 220, detailWidth 510) rather than by looking at the screen.
      //
      // The list's width is not arbitrary - there is code that sizes it to the
      // columns it has to show - while the detail pane is a magnifier that
      // works at any size. So the magnifier is the one that shrinks.
      this.setDetailWidth(this.detailWidth);
      this.setListWidth(this.listWidth);
   }

   setRotation(degrees) {
      this.preview.setRotation(degrees);
      this.preview.centreOn(this.preview.selectedIndex);
      this.refreshFrameLabel();
      this.saveViewSettings();
   }

   // Changing the stretch means re-reading and re-rendering the frame on
   // screen, which costs about a second. Nothing else in the session changes:
   // candidates, verdicts and the mask are all measured on the data, not on
   // how it is displayed.
   setSTFMode(mode) {
      if (!this.cache.setSTFMode(mode)) {
         return;
      }
      // Locking has nothing to hold on to without a stretch. The checkbox is
      // left where the operator put it rather than being forced off, so that
      // returning to Linked or Unlinked restores their own choice.
      this.lockSTFCheck.enabled = stfPlan(mode).lockable;
      this.saveViewSettings();
      if (this.session !== null) {
         this.showCurrentFrame();
      }
   }

   // Said out loud, because a turned preview is otherwise invisible and it
   // quietly breaks the correspondence between what is on screen and what a
   // mask file means. The rotation is remembered between sessions, so an
   // operator can arrive at a turned view they never chose - and then paint a
   // mask to match what they see, which is not the orientation the file is read
   // in. That is exactly what happened.
   rotationNote() {
      var turn = normalizeRotation(this.preview.rotation);
      return (turn === 0) ? "" : "   view turned " + turn + " deg";
   }

   // Re-stamp the note without re-reading the frame.
   refreshFrameLabel() {
      var text = this.frameLabel.text;
      var marker = "   view turned ";
      var cut = text.indexOf(marker);
      if (cut >= 0) {
         text = text.substring(0, cut);
      }
      if (text.length > 0) {
         this.frameLabel.text = text + this.rotationNote();
      }
   }

   // Point the detail pane at the selected candidate. The box is computed in
   // display coordinates, because that is the space the rotated bitmap the
   // pane draws from is in.
   updateDetail() {
      var index = this.preview.selectedIndex;
      if (this.preview.displayBitmap === null || index < 0
          || index >= this.preview.candidates.length) {
         this.detail.setSource(null, null);
         return;
      }
      var box = rotateBox(
         candidateBox(this.preview.candidates[index],
                      SCREEN_FACTOR, SCREEN_FACTOR, 2),
         this.preview.rotation, this.preview.imageWidth, this.preview.imageHeight);
      this.detail.setSource(this.preview.displayBitmap, box,
                            this.preview.verdictColour(
                               this.preview.verdicts[index], false));
   }

   buildVerdictSection() {
      var self = this;

      this.verdictGroup = new GroupBox(this);
      this.verdictGroup.title = "Verdict";

      this.meteorButton = new PushButton(this.verdictGroup);
      this.meteorButton.text = "Meteor (M)";
      this.meteorButton.onClick = function () {
         self.judge(VERDICT.METEOR);
      };

      this.notMeteorButton = new PushButton(this.verdictGroup);
      this.notMeteorButton.text = "Not a meteor (N)";
      this.notMeteorButton.onClick = function () {
         self.judge(VERDICT.NOT_METEOR);
      };

      this.uncertainButton = new PushButton(this.verdictGroup);
      this.uncertainButton.text = "Uncertain (U)";
      this.uncertainButton.toolTip =
         "<p>Kept separate from both other answers and excluded from the "
       + "evaluation denominator. Guessing would destabilise the baseline.</p>";
      this.uncertainButton.onClick = function () {
         self.judge(VERDICT.UNCERTAIN);
      };

      this.prevButton = new PushButton(this.verdictGroup);
      this.prevButton.text = "< Previous (P)";
      this.prevButton.onClick = function () {
         self.selectDisplayed(step(self.displayed, self.currentRow, -1), true);
      };

      this.clearVerdictButton = new PushButton(this.verdictGroup);
      this.clearVerdictButton.text = "Clear";
      this.clearVerdictButton.onClick = function () {
         self.judge(VERDICT.UNREVIEWED, true);
      };

      this.summaryLabel = new Label(this.verdictGroup);
      this.summaryLabel.text = "";

      this.verdictGroup.sizer = new HorizontalSizer;
      this.verdictGroup.sizer.margin = 6;
      this.verdictGroup.sizer.spacing = 6;
      this.verdictGroup.sizer.add(this.prevButton);
      this.verdictGroup.sizer.addSpacing(10);
      this.verdictGroup.sizer.add(this.meteorButton);
      this.verdictGroup.sizer.add(this.notMeteorButton);
      this.verdictGroup.sizer.add(this.uncertainButton);
      this.verdictGroup.sizer.add(this.clearVerdictButton);
      this.verdictGroup.sizer.addSpacing(16);
      this.verdictGroup.sizer.add(this.summaryLabel, 100);
   }

   buildButtonSection() {
      var self = this;

      this.saveSessionButton = new PushButton(this);
      this.saveSessionButton.text = "Save session...";
      this.saveSessionButton.onClick = function () {
         self.saveSession();
      };

      this.loadSessionButton = new PushButton(this);
      this.loadSessionButton.text = "Load session...";
      this.loadSessionButton.onClick = function () {
         self.loadSession();
      };

      this.composeButton = new PushButton(this);
      this.composeButton.text = "Compose...";
      this.composeButton.toolTip =
         "<p>Build the meteor composite: the master light with the accepted "
       + "meteors' own light added inside a feathered mask around each trail. "
       + "The master is never modified.</p>";
      this.composeButton.onClick = function () {
         self.runComposition();
      };

      this.exportButton = new PushButton(this);
      this.exportButton.text = "Export ground truth...";
      this.exportButton.onClick = function () {
         self.exportGroundTruth();
      };

      this.resetButton = new PushButton(this);
      this.resetButton.text = "Reset";
      this.resetButton.toolTip =
         "<p>Put everything back to how the dialog opens: the directories, the "
       + "mask, the list filters and the sort order.</p>"
       + "<p>The loaded detection and its verdicts are discarded too. It asks "
       + "first.</p>";
      this.resetButton.onClick = function () {
         self.resetAll();
      };

      this.closeButton = new PushButton(this);
      this.closeButton.text = "Close";
      this.closeButton.onClick = function () {
         self.requestClose();
      };

      this.autosaveLabel = new Label(this);
      this.autosaveLabel.text = "";
      this.autosaveLabel.toolTip =
         "<p>Verdicts are written to " + AUTOSAVE_NAME + " in the output "
       + "directory after every judgement, so there is nothing to remember to "
       + "save.</p>";

      this.buttonSizer = new HorizontalSizer;
      this.buttonSizer.spacing = 6;
      this.buttonSizer.add(this.saveSessionButton);
      this.buttonSizer.add(this.loadSessionButton);
      this.buttonSizer.add(this.exportButton);
      this.buttonSizer.add(this.composeButton);
      this.buttonSizer.addSpacing(12);
      this.buttonSizer.add(this.autosaveLabel, 100);
      this.buttonSizer.add(this.resetButton);
      this.buttonSizer.addSpacing(12);
      this.buttonSizer.add(this.closeButton);
   }

   // --- Detection ----------------------------------------------------------

   // --- Reset --------------------------------------------------------------

   // Everything back to how the dialog opens: the settings, the directories,
   // and the loaded work.
   //
   // This is the full reset PixInsight's own processes offer, and it discards
   // real work - an eight-minute detection and a night of verdicts - so it
   // asks first, and says what will go. The verdicts are named separately in
   // the question when there are any, because "reset" does not sound like
   // "throw away 116 judgements".
   resetAll() {
      var verdicts = this.session === null ? 0 : summarize(this.session).reviewed;
      var message = "Reset everything?\n\n"
                  + "The frames and output directories, the mask, the list "
                  + "filters and the sort order all go back to their defaults.";
      if (this.detectionResults !== null) {
         message += "\n\nThe loaded detection will be discarded";
         if (verdicts > 0) {
            message += ", including " + verdicts + " verdict"
                     + (verdicts === 1 ? "" : "s");
            message += this.dirty
               ? " - and some of those are not saved yet."
               : ". They are saved in " + AUTOSAVE_NAME + " and can be loaded "
                 + "again with the detection results.";
         } else {
            message += ".";
         }
      }
      var box = new MessageBox(message, TITLE, StdIcon.Question,
                               StdButton.Yes, StdButton.No);
      if (box.execute() !== StdButton.Yes) {
         return;
      }

      this.session = null;
      this.detectionResults = null;
      this.displayed = [];
      this.currentRow = -1;
      this.dirty = false;
      this.resultsPath = null;
      this.autosaveError = null;
      this.cancelRequested = false;

      this.registeredDir = "";
      this.dirEdit.text = "";
      this.outputDir = "";
      this.outputEdit.text = "";
      this.outputDirChosen = false;

      this.clearMask();

      this.showCombo.currentItem = 0;
      this.showFilter = this.showFilters[0];
      if (this.presetCombo.enabled) {
         this.presetCombo.currentItem = 0;
         this.scoreCutoff = PRESETS[this.presetNameList[0]].cutoff;
      }
      this.hidePersistentCheck.checked = false;

      this.sortKey = defaultSortKey(this.mode);
      this.sortAscending = (this.sortKey !== "score");
      var startIndex = this.sortKeys.indexOf(this.sortKey);
      this.sortCombo.currentItem = startIndex >= 0 ? startIndex : 0;

      this.candidateTree.clear();
      this.cache.clear();
      this.preview.setCandidates([], [], [], -1);
      this.preview.setFrame(null);
      this.preview.setRotation(0);
      this.detail.setSource(null, null);

      this.progressLabel.text = "No detection results loaded.";
      this.frameLabel.text = "";
      this.summaryLabel.text = "";
      this.autosaveLabel.text = "";

      // So that closing the dialog does not write the cleared-away directories
      // back over the stored ones only to have them restored next time.
      this.updateEnabled();
      console.noteln("<end><cbr>MeteorComposer: reset");
   }

   // --- Exclusion mask -----------------------------------------------------

   maskSourceChanged() {
      var edges = (this.maskMode === "edges");
      for (var i = 0; i < MASK_EDGES.length; ++i) {
         var cell = this.maskEdgeControls[MASK_EDGES[i]];
         cell.percent.enabled = edges;
         cell.tilt.enabled = edges;
         cell.ccw.enabled = edges;
      }
      this.maskFileEdit.enabled = !edges;
      this.maskFileBrowseButton.enabled = !edges;
      this.maskRotateLabel.enabled = !edges;
      this.maskRotateCombo.enabled = !edges;
      this.refreshMask();
   }

   clearMask() {
      this.maskEdges = makeEdgeSpec();
      for (var i = 0; i < MASK_EDGES.length; ++i) {
         var cell = this.maskEdgeControls[MASK_EDGES[i]];
         cell.percent.value = 0;
         cell.tilt.value = 0;
         cell.ccw.checked = false;
      }
      this.maskFilePath = "";
      this.maskFileLumRaw = null;
      this.maskFileLum = null;
      this.maskFileRotation = 0;
      this.maskRotateCombo.currentItem = 0;
      this.maskFileEdit.text = "";
      this.maskMode = "edges";
      this.maskEdgesRadio.checked = true;
      this.maskSourceChanged();
   }

   chooseMaskFile() {
      var dlg = new OpenFileDialog;
      dlg.caption = "Mask image - black is excluded";
      dlg.multipleSelections = false;
      // Every format PixInsight can read, from PixInsight itself. A hand-written
      // filter list is how a file dialog comes to match nothing at all.
      dlg.loadImageFilters();
      if (this.maskFilePath.length > 0) {
         var dir = directoryOf(this.maskFilePath);
         if (dir.length > 0 && File.directoryExists(dir)) {
            dlg.initialPath = dir;
         }
      }
      if (!dlg.execute()) {
         return;
      }
      this.setMaskFile(dlg.filePath);
   }

   setMaskFile(path) {
      this.maskFilePath = path;
      this.maskFileEdit.text = path;
      this.maskFileLumRaw = null;
      this.maskFileLum = null;
      var failure = null;
      this.cursor = new Cursor(StdCursor.Wait);
      try {
         this.maskFileLumRaw = loadMaskLuminance(path, MASK_FILE_MAX_SIDE);
      } catch (e) {
         failure = "" + e;
      } finally {
         this.cursor = new Cursor(StdCursor.Arrow);
      }
      this.applyMaskFileRotation();
      this.reportMaskFile();
      if (this.maskFileLum === null) {
         (new MessageBox(
            "Could not read that image as a mask:\n" + path
          + (failure === null ? "" : "\n\n" + failure),
            TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
      this.refreshMask();
   }

   // Said in the console, because a mask of the wrong shape is stretched to fit
   // and the stretching does not show in the overlay - a band that should be
   // level comes out sloped, by a little, and nothing says why.
   reportMaskFile() {
      if (this.maskFileLumRaw === null) {
         return;
      }
      var raw = this.maskFileLumRaw;
      var used = this.maskFileLum;
      console.writeln("<end><cbr>MeteorComposer: mask image " + raw.width + "x"
                      + raw.height
                      + (this.maskFileRotation === 0
                         ? ""
                         : ", turned " + this.maskFileRotation + " deg to "
                           + used.width + "x" + used.height));
      var frameWidth = this.preview.imageWidth;
      var frameHeight = this.preview.imageHeight;
      if (frameWidth <= 0 || frameHeight <= 0) {
         return;
      }
      var maskAspect = used.width / used.height;
      var frameAspect = frameWidth / frameHeight;
      console.writeln("                            frame " + frameWidth + "x"
                      + frameHeight);
      if (Math.abs(maskAspect / frameAspect - 1) > 0.02) {
         console.warningln("** The mask image is a different shape from the "
            + "frame (" + maskAspect.toFixed(3) + " against "
            + frameAspect.toFixed(3) + "). It is stretched to cover the frame, "
            + "so straight edges in it will not stay straight. Turning it may "
            + "be what is needed.");
      }
   }

   // The turned copy the rest of the dialog reads. Kept apart from what was read
   // off disk so that turning the mask costs a rotation, not another trip to the
   // file.
   applyMaskFileRotation() {
      if (this.maskFileLumRaw === null) {
         this.maskFileLum = null;
         return;
      }
      var raw = this.maskFileLumRaw;
      this.maskFileLum = rotateLuminance(raw.data, raw.width, raw.height,
                                         this.maskFileRotation);
   }

   // The mask detection is given, at the field's own size.
   //
   // null when nothing is excluded, so that an untouched Mask row leaves
   // detectCandidates() on exactly the path it was on before this row existed.
   // A mask of all ones would be arithmetically equivalent, but "equivalent"
   // is a claim, and there is no reason to make it.
   maskForField(fieldWidth, fieldHeight) {
      if (this.maskMode === "file") {
         if (this.maskFileLum === null) {
            return null;
         }
         return maskFromLuminance(this.maskFileLum.data,
                                  this.maskFileLum.width, this.maskFileLum.height,
                                  fieldWidth, fieldHeight);
      }
      if (edgeSpecIsEmpty(this.maskEdges)) {
         return null;
      }
      return buildMask(edgeSpecToRegion(this.maskEdges, fieldWidth, fieldHeight),
                       fieldWidth, fieldHeight);
   }

   // Recompute the readout and the preview overlay. Called on every keystroke
   // in the mask fields, which is why it works on the 1/8 grid: a few hundred
   // thousand samples is fast enough to follow typing, and it is also the grid
   // detection will use, so the shading is the mask and not a picture of it.
   refreshMask() {
      var haveFrame = (this.preview.imageWidth > 0 && this.preview.imageHeight > 0);
      // With no frame open yet the readout falls back to a nominal frame. The
      // percentages are exact at any size; only a tilt makes the excluded area
      // depend on the aspect ratio, and a frame appears as soon as one is
      // chosen, so this is a transient.
      var fw = haveFrame ? Math.max(1, Math.round(this.preview.imageWidth / SCREEN_FACTOR)) : 750;
      var fh = haveFrame ? Math.max(1, Math.round(this.preview.imageHeight / SCREEN_FACTOR)) : 500;

      var mask = this.maskForField(fw, fh);
      if (mask === null) {
         this.maskReadout.text = (this.maskMode === "file" && this.maskFilePath.length > 0)
            ? MASK_UNREADABLE
            : "Excluded: none";
         this.preview.setMask(null);
         return;
      }
      var fraction = maskExcludedFraction(mask);
      this.maskReadout.text = "Excluded: " + (fraction * 100).toFixed(1)
                            + "% of the frame";
      this.preview.setMask(haveFrame ? maskOverlayBitmap(mask, fw, fh) : null);
      this.persistMask();
   }

   // Every edit to the mask - a depth, a tilt, the CCW box, the radio pair, the
   // file, the turn - ends up in refreshMask(). Persisting from there rather
   // than from each handler means a new control cannot be added and forgotten,
   // which is the same reason the selected row is read through one accessor.
   //
   // Restoring is the one caller that must not write: it would log a save for a
   // value it just read, and it runs before the operator has done anything.
   persistMask() {
      if (this._restoringSettings) {
         return;
      }
      this.saveMaskSetting();
   }

   // Recorded in the detection results, so that a results file carries the mask
   // it was produced under. Without it, a candidate list and the same list with
   // a third of the frame excluded are indistinguishable on disk.
   maskSpec() {
      if (this.maskMode === "file") {
         return { mode: "file", file: this.maskFilePath,
                  rotate: this.maskFileRotation };
      }
      var edges = {};
      for (var i = 0; i < MASK_EDGES.length; ++i) {
         var e = this.maskEdges[MASK_EDGES[i]];
         edges[MASK_EDGES[i]] = { percent: e.percent, angle: e.angle };
      }
      return { mode: "edges", edges: edges };
   }

   // Put the controls back to what a results file was produced under, so that
   // the shading over a loaded frame is the exclusion those candidates were
   // found with rather than whatever the fields happen to hold.
   applyMaskSpec(spec) {
      if (!spec) {
         return;
      }
      if (spec.mode === "file") {
         this.maskMode = "file";
         this.maskFileRadio.checked = true;
         // Before the file is read, so the first turn applied is the stored one.
         var turn = this.maskRotations.indexOf(Number(spec.rotate) || 0);
         this.maskFileRotation = turn >= 0 ? this.maskRotations[turn] : 0;
         this.maskRotateCombo.currentItem = turn >= 0 ? turn : 0;
         if (spec.file !== undefined && spec.file !== null && spec.file.length > 0
             && File.exists(spec.file)) {
            this.setMaskFile(spec.file);
            return;
         }
         // Said out loud rather than silently falling back to no mask: the
         // candidate list was produced with something this session cannot see.
         this.maskFilePath = (spec.file === undefined || spec.file === null)
            ? "" : spec.file;
         this.maskFileEdit.text = this.maskFilePath;
         this.maskFileLumRaw = null;
         this.maskFileLum = null;
         this.maskSourceChanged();
         return;
      }
      this.maskMode = "edges";
      this.maskEdgesRadio.checked = true;
      this.maskEdges = makeEdgeSpec();
      for (var i = 0; i < MASK_EDGES.length; ++i) {
         var edge = MASK_EDGES[i];
         var from = (spec.edges && spec.edges[edge]) ? spec.edges[edge] : null;
         if (from !== null) {
            this.maskEdges[edge].percent = Math.round(clampPercent(from.percent));
            // Clamped to what the spin box can express, so the control and the
            // model cannot disagree about what is set.
            var tilt = Math.round(Number(from.angle) || 0);
            if (tilt > 45) {
               tilt = 45;
            } else if (tilt < -45) {
               tilt = -45;
            }
            this.maskEdges[edge].angle = tilt;
         }
         var cell = this.maskEdgeControls[edge];
         cell.percent.value = this.maskEdges[edge].percent;
         cell.tilt.value = Math.abs(this.maskEdges[edge].angle);
         cell.ccw.checked = this.maskEdges[edge].angle < 0;
      }
      this.maskSourceChanged();
   }

   // The first frame, shown as soon as there is a directory to show it from.
   //
   // A mask is set by looking at the sky it is going to hide, not by imagining
   // it. Nothing else in the dialog would put a frame on screen before an
   // eight-minute detection had run.
   showFirstFrame() {
      if (this.registeredDir.length === 0 || this.session !== null) {
         return;
      }
      var frames = listFrames(this.registeredDir);
      if (frames.length === 0) {
         this.frameLabel.text = "No .xisf frames in that directory.";
         return;
      }
      var path = this.framePath(frames[0]);
      this.cursor = new Cursor(StdCursor.Wait);
      try {
         var rendered = this.cache.get(path);
         this.preview.setFrame(rendered);
         this.frameLabel.text = (rendered === null)
            ? "Could not open " + frames[0]
            : frames[0] + "   " + rendered.width + "x" + rendered.height
              + "   (first frame)" + this.rotationNote();
      } finally {
         this.cursor = new Cursor(StdCursor.Arrow);
      }
      // The frame's size is what the overlay needs, so this has to come after.
      this.refreshMask();
   }

   runDetection() {
      if (this.registeredDir.length === 0) {
         (new MessageBox("Choose a directory of registered frames first.",
                         TITLE, StdIcon.Warning, StdButton.Ok)).execute();
         return;
      }
      var frames = listFrames(this.registeredDir);
      if (frames.length === 0) {
         (new MessageBox("No .xisf files found in that directory.",
                         TITLE, StdIcon.Warning, StdButton.Ok)).execute();
         return;
      }

      // Ground-truth mode detects with deliberately loose settings. Building
      // the evaluation set from what the operational settings happened to
      // find would make recall measure nothing (docs/tests.md 5-2).
      var options = this.detectionOptions();

      this.cancelRequested = false;
      this.cancelDetectionButton.enabled = true;
      this.detectButton.enabled = false;

      // `group` holds the directory's name, matching what
      // tests/pjsr/run_detection.js writes, so either producer's file can be
      // read by either consumer. The full path goes in its own field: a
      // results file is often carried to another machine where the volume is
      // mounted somewhere else, so the path is a hint, not the identity.
      var results = { group: baseName(this.registeredDir),
                      registeredDir: this.registeredDir,
                      screenFactor: SCREEN_FACTOR,
                      options: options, mask: this.maskSpec(), frames: [] };
      var withCandidates = 0;

      for (var i = 0; i < frames.length; ++i) {
         if (this.cancelRequested) {
            break;
         }
         var name = frames[i];
         var record = { file: name, candidates: [] };
         try {
            var self = this;
            var found = withFrame(this.registeredDir + "/" + name, SCREEN_FACTOR,
               function (field, image) {
                  // Built from this frame's own field size. The mask has to be
                  // exactly the field's length, and a percentage describes the
                  // same mask at any size, so nothing is carried between frames.
                  var mask = self.maskForField(field.width, field.height);
                  if (i === 0) {
                     self.reportMaskCost(field, mask);
                  }
                  var result = detectCandidates(field, options, mask);
                  attachColours(image, result.candidates, SCREEN_FACTOR);
                  return { field: field, result: result };
               });
            if (found !== null) {
               var field = found.field;
               var r = found.result;
               record.width = field.width;
               record.height = field.height;
               record.candidates = r.candidates;
               record.sigma = r.sigma;
               record.median = r.median;
               record.componentCount = r.componentCount;
               record.noDataSamples = r.noDataSamples;
               // How many components were joined into one candidate. Recorded so
               // that a candidate count can be read against the raw component
               // count without re-running the detection.
               record.fragmentsMerged = r.fragmentsMerged;
            } else {
               record.error = "could not open";
            }
         } catch (e) {
            record.error = "" + e;
         }
         if (record.candidates.length > 0) {
            ++withCandidates;
         }
         results.frames.push(record);

         this.progressLabel.text = "Detecting " + (i + 1) + " / " + frames.length
                                 + "   frames with candidates: " + withCandidates;
         CoreApplication.processEvents();
      }

      this.cancelDetectionButton.enabled = false;
      this.detectButton.enabled = true;

      if (this.cancelRequested && results.frames.length < frames.length) {
         this.progressLabel.text = "Cancelled after " + results.frames.length
                                 + " / " + frames.length + " frames.";
         // Recorded in the file itself. A partial results file is a perfectly
         // ordinary-looking one, and tests/eval/evaluate.js would score it as
         // though every frame had been examined - reporting a recall that is
         // really a measure of how far the run got.
         results.cancelled = true;
         results.framesRequested = frames.length;
      }

      this.adoptResults(results);
      this.writeResults(results);
   }

   // How much of the mask is sky, said once at the start of a run.
   //
   // The excluded percentage on its own does not distinguish the two things a
   // mask can cover. Samples outside the registered frame are found and
   // excluded automatically, per frame, following the shape exactly - so
   // masking them by hand adds nothing. What the readout cannot separate is how
   // much REAL SKY the mask also takes, and that is the part that costs
   // meteors.
   //
   // Measured on the 2026-08-12 session: a painted mask excluding 10.3% of the
   // frame cost six labelled meteors, one of them a visual one, because most of
   // what it covered was sky that a straight edge could not avoid. Nothing in
   // the dialog said so. Now it does.
   reportMaskCost(field, mask) {
      if (mask === null) {
         console.writeln("<end><cbr>MeteorComposer: no exclusion mask.");
         return;
      }
      var noData = noDataMask(field, 0);
      var total = mask.length;
      var excluded = 0;
      var alsoEmpty = 0;
      for (var i = 0; i < total; ++i) {
         if (mask[i] === 0) {
            ++excluded;
            if (noData.usable !== null && noData.usable[i] === 0) {
               ++alsoEmpty;
            }
         }
      }
      var sky = excluded - alsoEmpty;
      var pc = function (n) { return (n / total * 100).toFixed(1) + "%"; };
      console.writeln("<end><cbr>MeteorComposer: mask excludes " + pc(excluded)
                      + " of the frame - " + pc(alsoEmpty)
                      + " of it has no data anyway, " + pc(sky) + " is sky.");
      if (sky / total > 0.02) {
         console.warningln("** " + pc(sky) + " of the frame is sky the detection "
            + "will not search. Samples outside the registered frame are already "
            + "excluded automatically, per frame and to their exact shape, so a "
            + "mask is only needed for something in front of the sky.");
      }
   }

   // Write the detection out, so that eight minutes of work survives the
   // dialog.
   //
   // It did not, before: `Run detection` kept its results in memory and wrote
   // nothing at all. The verdicts autosaved, but they identify candidates by
   // file and index within the frame, so without the candidate list they
   // referred to nothing: the next session had to detect again, and any
   // difference in the result would have orphaned every verdict.
   //
   // A failure here is reported and does not stop the screening - the results
   // are already loaded, and the operator can still work. But it is said out
   // loud, because the consequence of not knowing is discovering it after a
   // night of screening.
   writeResults(results) {
      var path = this.resultsOutputPath();
      if (path === null) {
         (new MessageBox(
            "The detection is loaded but could not be saved: no output "
          + "directory is set.\n\nSet one and run the detection again, or the "
          + "candidate list will be lost when this dialog closes.",
            TITLE, StdIcon.Warning, StdButton.Ok)).execute();
         return;
      }
      try {
         File.writeTextFile(path, JSON.stringify(results));
         this.resultsPath = path;
         console.noteln("<end><cbr>MeteorComposer: detection written to " + path);
      } catch (e) {
         (new MessageBox(
            "The detection is loaded but could not be written to\n" + path
          + "\n\n" + e
          + "\n\nThe candidate list will be lost when this dialog closes. "
          + "Choose a writable output directory and detect again.",
            TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
   }

   detectionOptions() {
      var options = {
         backgroundFactor: DEFAULT_OPTIONS.backgroundFactor,
         k: DEFAULT_OPTIONS.k,
         connectivity: DEFAULT_OPTIONS.connectivity,
         minPixels: DEFAULT_OPTIONS.minPixels,
         minElongation: DEFAULT_OPTIONS.minElongation,
         minLength: DEFAULT_OPTIONS.minLength
      };
      if (this.mode === MODE.GROUND_TRUTH) {
         options.k = 3.5;
         options.minPixels = 6;
         options.minElongation = 3.0;
         options.minLength = 5.0;
      }
      return options;
   }

   loadResults() {
      var dlg = new OpenFileDialog;
      dlg.caption = "Load detection results";
      dlg.multipleSelections = false;
      dlg.filters = [["JSON files", "*.json"]];
      if (!dlg.execute()) {
         return;
      }
      try {
         var payload = JSON.parse(File.readTextFile(dlg.filePath));
         // Remembered so the autosave lands beside the results it belongs to.
         this.resultsPath = dlg.filePath;
         // Only a full path is usable here. `group` is the directory's name,
         // not a path, so adopting it would produce a path that resolves to
         // nothing and every frame would fail to open. Leave an
         // already-chosen directory alone either way.
         if (this.registeredDir.length === 0 && payload.registeredDir) {
            this.registeredDir = payload.registeredDir;
            this.dirEdit.text = payload.registeredDir;
         }
         this.adoptResults(payload);
         if (this.registeredDir.length === 0) {
            (new MessageBox(
               "Results loaded, but this file does not record where the "
             + "frames are. Choose the registered frames directory with "
             + "Browse before selecting a candidate, otherwise the preview "
             + "cannot open them.",
               TITLE, StdIcon.Information, StdButton.Ok)).execute();
         }
      } catch (e) {
         (new MessageBox("Could not read that file:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
   }

   adoptResults(results) {
      this.detectionResults = results;
      this.session = createSession(results, this.mode, {});

      // Cross-frame matching needs every frame in capture order, including
      // the ones with no candidates, so the frame numbering it produces lines
      // up with the run.
      var forMatching = [];
      for (var i = 0; i < results.frames.length; ++i) {
         forMatching.push({
            file: results.frames[i].file,
            candidates: results.frames[i].candidates || []
         });
      }
      applyTracks(this.session.rows, matchAcrossFrames(forMatching, null));

      // A fixed structure does not respect the linker's frame-gap limit: the
      // real one appeared in 22 frames spread over 613, and the linker only
      // ever joined 8 of them. It is found over the whole session instead.
      var fixed = markFixedStructures(this.session.rows, null);
      for (var k = 0; k < this.session.rows.length; ++k) {
         if (this.session.rows[k].stationary) {
            // Not a satellite. Saying "persistent" here would give the
            // operator the wrong reason.
            this.session.rows[k].persistent = false;
         }
      }
      scoreAll(this.session.rows, null);
      if (fixed.length > 0) {
         console.writeln("<end><cbr>detections that never move: " + fixed.length
                         + " (stars, most likely)");
      }

      var sum = summarize(this.session);
      this.progressLabel.text = results.frames.length + " frames, "
                              + sum.total + " candidates.";
      this.cache.clear();
      this.refreshList();
      this.updateEnabled();
      this.updateAutosaveLabel();
      // Before the list is drawn: the overlay over the first frame shown should
      // be the exclusion these candidates were found with.
      this.applyMaskSpec(results.mask);

      this.offerResume();
   }

   // --- List ---------------------------------------------------------------

   refreshList() {
      if (this.session === null) {
         return;
      }
      var filter = {
         hidePersistent: this.hidePersistentCheck.checked,
         verdicts: this.showFilter
      };
      // Which candidate is selected, by identity rather than by position. A
      // position in the displayed list means nothing across a rebuild: row 40
      // of 411 is a different candidate from row 40 of 92, and may not exist.
      var selectedRow = this.currentDisplayedRow();
      var selectedId = selectedRow === null ? null : selectedRow.id;

      var rows = filterRows(this.session, filter);
      if (this.scoreCutoff > 0 && modeShowsScores(this.mode)) {
         var kept = [];
         for (var q = 0; q < rows.length; ++q) {
            if (rows[q].score === undefined || rows[q].score >= this.scoreCutoff) {
               kept.push(rows[q]);
            }
         }
         rows = kept;
      }
      this.displayed = sortRows(this.session, rows, this.sortKey, this.sortAscending);

      this.candidateTree.clear();
      for (var i = 0; i < this.displayed.length; ++i) {
         var row = this.displayed[i];
         var node = new TreeBoxNode(this.candidateTree);
         // The row's position in the displayed list. headerSorting is off and
         // ordering is done in sortRows(), so this is always the row's real
         // position, and the same number is drawn on the preview.
         node.setText(0, "" + (i + 1));
         node.setText(1, frameTag(row.file));
         // The whole name is still reachable: it is what an operator needs when
         // they go looking for the frame on disk.
         node.setToolTip(1, row.file);
         node.setText(2, row.candidate.length.toFixed(1));
         node.setText(3, row.candidate.angle.toFixed(1));
         node.setText(4, row.candidate.elongation.toFixed(1));
         node.setText(5, this.trackText(row));
         node.setToolTip(5, this.trackToolTip(row));
         var col = 6;
         if (modeShowsScores(this.mode)) {
            node.setText(col++, row.score === undefined ? "-" : row.score.toFixed(3));
         }
         node.setText(col, this.verdictText(row.verdict));
      }

      // The old index is meaningless now, and leaving it in place is what put
      // an out-of-range index into selectDisplayed() and threw: filtering the
      // list shorter than the selected row read past the end of it. Cleared
      // here rather than guarded there, so that `currentRow` keeps its
      // invariant - inside `displayed`, or -1 - for every reader.
      this.currentRow = -1;

      if (this.displayed.length > 0) {
         // Follow the candidate that was selected. If the filter hid it, start
         // at the top rather than at whatever now occupies its old position.
         var target = indexOfRowId(this.displayed, selectedId);
         this.selectDisplayed(target >= 0 ? target : 0, true);
      } else {
         this.preview.setCandidates([], [], [], -1);
      }
      this.updateSummary();
   }

   // Something that never moves and something that crosses the sky are both
   // "seen many times", but they are not the same finding and the operator acts
   // on them differently.
   //
   // The column used to read "22 fixed", which is the implementation's word for
   // it. It says nothing to the person reading the list. "same place" is the
   // observation, and it is what makes the row worth ignoring.
   trackText(row) {
      // Short, because it shares a pane with seven other columns. The sentence
      // that explains it is one hover away, on the cell.
      if (row.stationary) {
         return "still x" + row.fixedCount;
      }
      return "" + row.trackLength + (row.persistent ? " *" : "");
   }

   // What the Track column means for this row, in words.
   trackToolTip(row) {
      if (row.scoreReasons !== undefined && row.scoreReasons !== null
          && row.scoreReasons.length > 0) {
         return "<p>" + row.scoreReasons.join("</p><p>") + "</p>";
      }
      if (row.trackLength > 1) {
         return "<p>Matched in " + row.trackLength + " frames.</p>";
      }
      return "<p>Seen in this frame only, which is what a meteor does.</p>";
   }

   verdictText(verdict) {
      if (verdict === VERDICT.METEOR) {
         return "meteor";
      }
      if (verdict === VERDICT.NOT_METEOR) {
         return "not meteor";
      }
      if (verdict === VERDICT.UNCERTAIN) {
         return "uncertain";
      }
      return "-";
   }

   // The selected row, or null when there is not one.
   //
   // The only way to read it. `currentRow` is an index into `displayed`, and
   // `displayed` is rebuilt whenever the filter or the sort changes, so an
   // index held across a rebuild can point past the end - which is what threw
   // the first time an operator narrowed the list below the selected row.
   //
   // refreshList() keeps `currentRow` inside the list or at -1, so in practice
   // this returns null only when nothing is selected. It checks anyway: the
   // invariant is worth one comparison, and a direct read is worth none.
   // tests/ut/test_module_isolation.js forbids the direct read.
   currentDisplayedRow() {
      if (this.currentRow < 0 || this.currentRow >= this.displayed.length) {
         return null;
      }
      return this.displayed[this.currentRow];
   }

   // The candidate's position within the frame's candidate array, which is
   // what the preview draws.
   currentCandidateIndex() {
      var row = this.currentDisplayedRow();
      return row === null ? -1 : row.indexInFrame;
   }

   selectByCandidateIndex(candidateIndex) {
      var current = this.currentDisplayedRow();
      if (current === null) {
         return;
      }
      var file = current.file;
      for (var i = 0; i < this.displayed.length; ++i) {
         if (this.displayed[i].file === file
             && this.displayed[i].indexInFrame === candidateIndex) {
            this.selectDisplayed(i, true);
            return;
         }
      }
   }

   selectDisplayed(index, syncTree) {
      if (index < 0 || index >= this.displayed.length) {
         return;
      }
      // Only a row that is genuinely in the current list can say which frame is
      // on screen. Anything else - including a row index left over from a list
      // that has since been rebuilt - means the preview cannot be trusted, so
      // the frame is redrawn rather than assumed to be right.
      var showing = this.currentDisplayedRow();
      var frameChanged = showing === null
                      || showing.file !== this.displayed[index].file;
      this.currentRow = index;

      // Setting currentNode fires onCurrentNodeUpdated, which calls back into
      // here. The guard stops the frame being rendered twice per move.
      if (syncTree && index < this.candidateTree.numberOfChildren) {
         this._syncingSelection = true;
         try {
            this.candidateTree.currentNode = this.candidateTree.child(index);
         } finally {
            this._syncingSelection = false;
         }
      }

      if (frameChanged) {
         this.showCurrentFrame();
      } else {
         this.updateOverlay();
      }
      this.updateSummary();
   }

   // --- Preview ------------------------------------------------------------

   showCurrentFrame() {
      var row = this.currentDisplayedRow();
      if (row === null || this.session === null) {
         return;
      }
      var path = this.framePath(row.file);

      this.cursor = new Cursor(StdCursor.Wait);
      try {
         var rendered = this.cache.get(path);
         this.preview.setFrame(rendered);
         if (rendered === null) {
            this.frameLabel.text = "Could not open " + row.file;
            return;
         }
         this.frameLabel.text = row.file
            + "   " + rendered.width + "x" + rendered.height
            + this.rotationNote();
      } finally {
         this.cursor = new Cursor(StdCursor.Arrow);
      }

      this.updateOverlay();
      this.prefetchNext();
   }

   // Read the next frame while the operator is looking at this one. Each
   // frame costs about 750 ms with the stretch locked, and judging takes
   // longer than that, so the wait disappears.
   prefetchNext() {
      var current = this.currentDisplayedRow();
      if (current === null || this.currentRow + 1 >= this.displayed.length) {
         return;
      }
      var nextFile = this.displayed[this.currentRow + 1].file;
      if (nextFile === current.file) {
         return;
      }
      var path = this.framePath(nextFile);
      if (this.cache.has(path)) {
         return;
      }
      CoreApplication.processEvents();
      this.cache.get(path);
   }

   framePath(file) {
      return this.registeredDir + "/" + file;
   }

   // Give the preview every candidate in the current frame, not just the
   // selected one: a frame holding a meteor and a satellite at once is normal
   // (up to 5 were measured), and the point of the overlay is telling them
   // apart.
   updateOverlay() {
      var current = this.currentDisplayedRow();
      if (current === null) {
         return;
      }
      var file = current.file;
      var candidates = [];
      var verdicts = [];
      var numbers = [];
      var selected = -1;

      for (var i = 0; i < this.displayed.length; ++i) {
         var row = this.displayed[i];
         if (row.file !== file) {
            continue;
         }
         if (i === this.currentRow) {
            selected = candidates.length;
         }
         candidates.push(row.candidate);
         verdicts.push(row.verdict);
         numbers.push(i + 1);
      }
      this.preview.setCandidates(candidates, verdicts, numbers, selected);
      this.preview.followSelection();
      this.updateDetail();
   }

   // --- Judging ------------------------------------------------------------

   judge(verdict, stay) {
      var row = this.currentDisplayedRow();
      if (row === null) {
         return;
      }
      setVerdict(this.session, row.id, verdict);
      this.dirty = true;

      var node = this.candidateTree.child(this.currentRow);
      if (node !== null) {
         node.setText(this.columns.length - 1, this.verdictText(verdict));
      }

      this.autosave();

      // Judging advances, so a pass through the list is one keystroke per
      // candidate. Correcting means stepping back with the arrow keys.
      if (!stay && this.currentRow + 1 < this.displayed.length) {
         this.selectDisplayed(this.currentRow + 1, true);
      } else {
         this.updateOverlay();
         this.updateSummary();
      }
   }

   updateSummary() {
      if (this.session === null) {
         return;
      }
      var sum = summarize(this.session);
      var position = this.currentRow >= 0
         ? ((this.currentRow + 1) + " / " + this.displayed.length)
         : ("- / " + this.displayed.length);
      this.summaryLabel.text =
         position
       + "     reviewed " + sum.reviewed + " / " + sum.total
       + "     meteor " + sum.counts[VERDICT.METEOR]
       + "   not " + sum.counts[VERDICT.NOT_METEOR]
       + "   uncertain " + sum.counts[VERDICT.UNCERTAIN];
   }

   handleKey(key, modifiers) {
      if (this.session === null || this.currentRow < 0) {
         return false;
      }
      switch (key) {
         case KeyCode.M:
            this.judge(VERDICT.METEOR);
            return true;
         case KeyCode.N:
            this.judge(VERDICT.NOT_METEOR);
            return true;
         case KeyCode.U:
            this.judge(VERDICT.UNCERTAIN);
            return true;
         case KeyCode.Space:
            this.selectDisplayed(step(this.displayed, this.currentRow, 1), true);
            return true;
         // P for previous. The arrow keys do the same thing, but M/N/U are
         // typed with the right hand and reaching for an arrow breaks the
         // rhythm; N is already taken by not-a-meteor, so there is no
         // matching letter for "next".
         case KeyCode.P:
         case KeyCode.Left:
            this.selectDisplayed(step(this.displayed, this.currentRow, -1), true);
            return true;
         case KeyCode.Right:
            this.selectDisplayed(step(this.displayed, this.currentRow, 1), true);
            return true;
         default:
            return false;
      }
   }

   // --- Persistence --------------------------------------------------------

   setOutputDir(dir) {
      this.outputDir = dir === null ? "" : dir;
      this.outputEdit.text = this.outputDir;
   }

   // Where everything this script writes goes.
   //
   // The output field first, because it is the one the operator can see. Then
   // the directory a results file was loaded from, which is a reasonable
   // reading of "this session lives here". The frames directory is NOT a
   // fallback any more: it holds the operator's input data, and a session file
   // that appeared among 654 calibrated frames is one nobody finds.
   writeDir() {
      if (this.outputDir.length > 0) {
         return this.outputDir;
      }
      if (this.resultsPath !== null) {
         var dir = directoryOf(this.resultsPath);
         if (dir.length > 0) {
            return dir;
         }
      }
      return null;
   }

   autosavePath() {
      var dir = this.writeDir();
      return dir === null ? null : dir + "/" + AUTOSAVE_NAME;
   }

   resultsOutputPath() {
      var dir = this.writeDir();
      return dir === null ? null : dir + "/" + RESULTS_NAME;
   }

   // Called after every verdict. The payload is a few kilobytes - only the
   // judged rows are stored - so writing it on each keystroke costs nothing
   // measurable, and it removes the need for the operator to remember to save.
   autosave() {
      if (this.session === null) {
         return;
      }
      var path = this.autosavePath();
      if (path === null) {
         this.autosaveError = "nowhere to write to";
         this.updateAutosaveLabel();
         return;
      }
      try {
         File.writeTextFile(path, JSON.stringify(toSessionJSON(this.session), null, 2));
         this.dirty = false;
         this.autosaveError = null;
      } catch (e) {
         // Keep `dirty` set: the work is not safe, and the confirmation on
         // close is the last thing standing between the operator and losing
         // it.
         this.autosaveError = "" + e;
      }
      this.updateAutosaveLabel();
   }

   updateAutosaveLabel() {
      if (this.autosaveError !== null) {
         this.autosaveLabel.text = "Autosave FAILED: " + this.autosaveError;
         return;
      }
      var path = this.autosavePath();
      this.autosaveLabel.text = path === null
         ? ""
         : ("Autosaving to " + AUTOSAVE_NAME);
   }

   // Offer to pick up where the last run left off. Asked rather than applied
   // silently: an autosave from a different night's work would otherwise
   // stamp verdicts onto the wrong candidates without the operator noticing.
   offerResume() {
      var path = this.autosavePath();
      if (path === null || !File.exists(path)) {
         return;
      }
      var saved;
      try {
         saved = JSON.parse(File.readTextFile(path));
      } catch (e) {
         return;
      }
      var count = (saved && saved.verdicts) ? saved.verdicts.length : 0;
      if (count === 0) {
         return;
      }
      // Mixing modes would be worse than starting over: the ground-truth pass
      // runs looser detection settings, so its candidate list is not the same
      // list the screening pass sees.
      if (saved.mode !== undefined && saved.mode !== this.mode) {
         return;
      }

      var message = "An automatically saved session was found with "
                  + count + " verdicts.\n\n" + path + "\n\nResume it?";
      var box = new MessageBox(message, TITLE, StdIcon.Question,
                               StdButton.Yes, StdButton.No);
      if (box.execute() !== StdButton.Yes) {
         return;
      }
      var out = applySessionJSON(this.session, saved);
      this.refreshList();
      if (out.orphans.length > 0) {
         (new MessageBox(
            "Restored " + out.restored + " verdicts. " + out.orphans.length
          + " no longer match any candidate and were discarded - the "
          + "detection parameters have probably changed since.",
            TITLE, StdIcon.Information, StdButton.Ok)).execute();
      }
   }

   // The Close button asks before discarding work. The window's own close
   // button is not intercepted: Control.onClose()'s return value is not
   // documented, and guessing wrong would make the dialog impossible to
   // close. Autosave covers that route instead.
   requestClose() {
      if (this.dirty && this.session !== null) {
         var summary = summarize(this.session);
         var box = new MessageBox(
            "There are " + summary.reviewed + " verdicts that could not be "
          + "saved automatically"
          + (this.autosaveError !== null ? " (" + this.autosaveError + ")" : "")
          + ".\n\nClose anyway and lose them?",
            TITLE, StdIcon.Warning, StdButton.No, StdButton.Yes);
         if (box.execute() !== StdButton.Yes) {
            return;
         }
      }
      this.ok();
   }

   saveSession() {
      if (this.session === null) {
         return;
      }
      var dlg = new SaveFileDialog;
      dlg.caption = "Save screening session";
      dlg.filters = [["JSON files", "*.json"]];
      // Offer the same name and place the autosave uses, so an explicit save
      // lands where the operator would go looking for it.
      dlg.overwritePrompt = true;
      // initialPath is a DIRECTORY. The shipped scripts all pass one
      // (WeightsOptimizer-GUI.js: sfd.initialPath = engine.params.workingDir),
      // and a path with a file name on the end is not a documented use.
      var suggested = this.autosavePath();
      if (suggested !== null) {
         dlg.initialPath = directoryOf(suggested);
      }
      if (!dlg.execute()) {
         return;
      }
      try {
         File.writeTextFile(dlg.filePath,
                            JSON.stringify(toSessionJSON(this.session), null, 2));
      } catch (e) {
         (new MessageBox("Could not write the session:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
   }

   loadSession() {
      if (this.session === null) {
         (new MessageBox("Load or run a detection first.",
                         TITLE, StdIcon.Warning, StdButton.Ok)).execute();
         return;
      }
      var dlg = new OpenFileDialog;
      dlg.caption = "Load screening session";
      dlg.multipleSelections = false;
      dlg.filters = [["JSON files", "*.json"]];
      var suggested = this.autosavePath();
      if (suggested !== null) {
         dlg.initialPath = directoryOf(suggested);
      }
      if (!dlg.execute()) {
         return;
      }
      try {
         var saved = JSON.parse(File.readTextFile(dlg.filePath));
         var out = applySessionJSON(this.session, saved);
         this.refreshList();
         // Orphans mean the detection has changed since the session was
         // saved. Saying so is the only way the operator learns how much of
         // their work no longer applies.
         var message = "Restored " + out.restored + " verdicts.";
         if (out.orphans.length > 0) {
            message += "\n\n" + out.orphans.length + " verdicts no longer match "
                     + "any candidate and were discarded. The detection "
                     + "parameters have probably changed since the session "
                     + "was saved.";
         }
         (new MessageBox(message, TITLE, StdIcon.Information, StdButton.Ok)).execute();
      } catch (e) {
         (new MessageBox("Could not read that session:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
   }

   exportGroundTruth() {
      if (this.session === null) {
         return;
      }
      var dlg = new SaveFileDialog;
      dlg.caption = "Export ground truth";
      dlg.filters = [["JSON files", "*.json"]];
      if (!dlg.execute()) {
         return;
      }
      var frameCount = this.detectionResults !== null
         ? this.detectionResults.frames.length : null;
      try {
         var gt = toGroundTruth(this.session, { frameCount: frameCount },
                                SCREEN_FACTOR, SCREEN_FACTOR);
         File.writeTextFile(dlg.filePath, JSON.stringify(gt, null, 2));
      } catch (e) {
         (new MessageBox("Could not write the ground truth:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      }
   }

   // --- Composition (Stages 3 and 4) ---------------------------------------

   // Every candidate the operator judged a meteor, grouped by frame.
   acceptedTrails() {
      var byFile = {};
      for (var i = 0; i < this.session.rows.length; ++i) {
         var row = this.session.rows[i];
         if (row.verdict !== VERDICT.METEOR) {
            continue;
         }
         if (byFile[row.file] === undefined) {
            byFile[row.file] = [];
         }
         byFile[row.file].push(trailFromCandidate(row.candidate));
      }
      var jobs = [];
      for (var file in byFile) {
         jobs.push({ file: file, trails: byFile[file] });
      }
      jobs.sort(function (a, b) { return a.file < b.file ? -1 : 1; });
      return jobs;
   }

   runComposition() {
      var self = this;
      if (this.session === null) {
         return;
      }
      var jobs = this.acceptedTrails();
      if (jobs.length === 0) {
         (new MessageBox("No candidates have been judged a meteor yet.",
                         TITLE, StdIcon.Information, StdButton.Ok)).execute();
         return;
      }

      var dlg = new ComposeDialog(this.acceptedCount(),
                                  this.guessMasterPath(),
                                  this.guessOutputPath());
      if (!dlg.execute()) {
         return;
      }
      var masterPath = dlg.masterPath;
      var outputPath = dlg.outputPath;

      this.cursor = new Cursor(StdCursor.Wait);
      var restoreTitle = this.windowTitle;
      var restoreButton = this.composeButton.text;
      this.composeButton.enabled = false;
      try {
         this.compose(masterPath, outputPath, jobs);
      } catch (e) {
         (new MessageBox("Composition failed:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      } finally {
         this.cursor = new Cursor(StdCursor.Arrow);
         this.windowTitle = restoreTitle;
         this.composeButton.text = restoreButton;
         this.composeButton.enabled = true;
      }
   }


   // How many candidates were judged a meteor. `acceptedTrails` groups them by
   // frame, so its length is a frame count, not a meteor count.
   acceptedCount() {
      var jobs = this.acceptedTrails();
      var total = 0;
      for (var i = 0; i < jobs.length; ++i) {
         total += jobs[i].trails.length;
      }
      return total;
   }

   // The master light, guessed rather than asked for.
   //
   // WBPP puts it in a `master` directory beside `registered`, so the frames'
   // own location says where to look. The uncropped one is preferred: an
   // autocropped master has different dimensions from the subs, which would
   // put every mask in the wrong place.
   //
   // Returns "" when there is nothing to go on, which leaves the field empty
   // rather than filling it with a path that does not exist.
   guessMasterPath() {
      if (this.registeredDir.length === 0) {
         return "";
      }
      var candidates = [];
      var dir = this.registeredDir;
      for (var up = 0; up < 3 && dir.length > 1; ++up) {
         candidates.push(dir + "/master");
         dir = directoryOf(dir);
      }
      for (var i = 0; i < candidates.length; ++i) {
         var found = this.findMasterIn(candidates[i]);
         if (found !== null) {
            return found;
         }
      }
      return "";
   }

   findMasterIn(dir) {
      if (!File.directoryExists(dir)) {
         return null;
      }
      var plain = null, autocrop = null;
      var find = new FileFind;
      if (find.begin(dir + "/*")) {
         do {
            if (find.isDirectory || !isRealXisf(find.name)) {
               continue;
            }
            if (find.name.indexOf("autocrop") >= 0) {
               if (autocrop === null) {
                  autocrop = dir + "/" + find.name;
               }
            } else if (plain === null) {
               plain = dir + "/" + find.name;
            }
         } while (find.next());
      }
      return plain !== null ? plain : autocrop;
   }

   // The same directory as everything else this script writes.
   guessOutputPath() {
      var dir = this.writeDir();
      if (dir === null || dir.length === 0) {
         return "";
      }
      return dir + "/meteor_composite.xisf";
   }

   compose(masterPath, outputPath, jobs) {
      var masterWindow = ImageWindow.open(masterPath)[0];
      if (!masterWindow) {
         throw new Error("could not open the master: " + masterPath);
      }

      var composed = 0;
      var skipped = [];
      var aborted = false;
      var W, H, channels;

      // Progress goes to the Process Console, not only to a label in this
      // dialog.
      //
      // The label was there and was missed: a minute passed with nothing to
      // watch, and the wait cursor did not survive - opening an ImageWindow
      // resets it - so there was no way to tell whether anything was
      // happening. The console is where a PixInsight user looks for the
      // progress of a batch, it stays on screen, and it ends up in the log
      // file, which the message box does not: the list of frames left out used
      // to vanish with the dialog that reported it.
      console.show();
      console.abortEnabled = true;
      console.writeln("<end><cbr><b>MeteorComposer</b>: compositing "
                      + jobs.length + " frames");
      console.writeln("master: " + masterPath);
      console.writeln("output: " + outputPath);
      console.flush();

      try {
         var masterImage = masterWindow.mainView.image;
         W = masterImage.width;
         H = masterImage.height;
         channels = masterImage.numberOfChannels;

         var output = new Image(masterImage);

         // The master is read once and never written to. Every frame is fitted
         // against this pristine copy, and the light each one contributes goes
         // into a separate accumulator.
         //
         // Compositing into the master as it went - which is what this did
         // first - breaks a meteor that crossed an exposure boundary. Its two
         // frames are adjacent stretches of one path, so the second frame's
         // mask covers the first frame's trail, and the second frame has no
         // meteor there: its residual is the first frame's light with a minus
         // sign, and a fit scale above 1 subtracts more than was added. The
         // trail came out with a black gouge along it.
         var masterChannels = [];
         var added = [];
         var ch;
         for (ch = 0; ch < channels; ++ch) {
            masterChannels.push(channelToArray(masterImage, ch));
            added.push(new Float32Array(W * H));
         }

         var combinedMask = new Float32Array(W * H);

         var startedAt = Date.now();

         for (var k = 0; k < jobs.length; ++k) {
            var job = jobs[k];
            var frameStarted = Date.now();
            this.progressLabel.text = "Compositing " + (k + 1) + " / " + jobs.length
                                    + "   " + job.file;
            // Re-asserted every frame: opening an image window puts the cursor
            // back to an arrow, so setting it once before the loop does not
            // last.
            this.cursor = new Cursor(StdCursor.Wait);

            // The title bar and the button that was just pressed. Neither can
            // be hidden: this dialog is often maximised, which puts the Process
            // Console behind it, and the progress label lives at the top of the
            // window while the button is at the bottom where the operator is
            // looking.
            var progress = (k + 1) + " / " + jobs.length;
            this.windowTitle = TITLE + " - compositing " + progress;
            this.composeButton.text = "Compositing " + progress;
            console.write("<end><cbr>[" + (k + 1) + "/" + jobs.length + "] "
                          + job.file + " ... ");
            console.flush();
            CoreApplication.processEvents();

            if (console.abortRequested) {
               aborted = true;
               console.writeln("");
               console.warningln("aborted by the user");
               break;
            }

            // The corridor is where to look for the trail, not the mask. The
            // mask itself is built from the light, because the axis these
            // trails carry comes from the 1/8 detection field and was measured
            // to miss the real trail by up to 12 px.
            var corridorField = renderCorridorMask(job.trails, W, H, null);
            var rects = [];
            for (var ti = 0; ti < job.trails.length; ++ti) {
               rects.push(corridorBounds(job.trails[ti], W, H, null));
            }

            var subWindow = null;
            try {
               subWindow = ImageWindow.open(this.framePath(job.file))[0];
            } catch (e) {
               skipped.push(job.file + ": could not open");
               console.warningln("could not open it");
               continue;
            }
            if (!subWindow) {
               skipped.push(job.file + ": could not open");
               console.warningln("could not open it");
               continue;
            }

            try {
               var subImage = subWindow.mainView.image;
               if (subImage.width !== W || subImage.height !== H) {
                  // A cropped master against uncropped subs would put every
                  // mask in the wrong place, and the result would look like a
                  // mask bug rather than a mismatch.
                  var mismatch = subImage.width + "x" + subImage.height
                               + " does not match the master's " + W + "x" + H;
                  skipped.push(job.file + ": " + mismatch);
                  console.warningln("LEFT OUT - " + mismatch);
                  continue;
               }

               var subChannels = [];
               for (ch = 0; ch < channels; ++ch) {
                  subChannels.push(channelToArray(subImage, ch));
               }

               var outcome = composeFrame(masterChannels, subChannels,
                                          corridorField.data, W, H, job.trails,
                                          rects, added, combinedMask, null);
               if (!outcome.written) {
                  // Compositing a frame that does not match the master
                  // produces a result that looks plausible and is wrong, so
                  // the frame is left out and the operator is told. Nothing
                  // was written for any channel.
                  skipped.push(job.file + ": " + outcome.reason);
                  console.warningln("LEFT OUT - " + outcome.reason);
                  continue;
               }

               ++composed;
               var lit = outcome.trails[0].channels;
               var peaks = [];
               for (var pc = 0; pc < lit.length; ++pc) {
                  peaks.push(lit[pc].peak.toFixed(4));
               }
               console.writeln("ok  scale=" + outcome.fits[0].scale.toFixed(3)
                               + "  peak=" + peaks.join("/")
                               + "  mask=" + outcome.trails[0].coverage.touched + "px"
                               + "  (" + (Date.now() - frameStarted) + " ms)");
            } finally {
               subWindow.forceClose();
            }
         }

         if (aborted) {
            // Nothing is written. A composite holding the first few meteors
            // and not the rest looks exactly like a finished one, and the
            // operator asked for it to stop, not for a partial result.
            console.writeln("<end><cbr>MeteorComposer: cancelled after "
                            + composed + " of " + jobs.length
                            + " frames. Nothing was written.");
            console.flush();
            this.progressLabel.text = "Composition cancelled after "
                                    + composed + " / " + jobs.length;
            (new MessageBox("Cancelled after " + composed + " of " + jobs.length
                          + " frames.\n\nNothing was written: a composite with "
                          + "only some of the meteors in it is "
                          + "indistinguishable from a finished one.",
                            TITLE, StdIcon.Information, StdButton.Ok)).execute();
            return;
         }

         for (ch = 0; ch < channels; ++ch) {
            arrayToChannel(output, ch, applyAdded(masterChannels[ch], added[ch]));
         }

         var outWindow = new ImageWindow(W, H, channels, masterImage.bitsPerSample,
                                         masterImage.isReal, masterImage.isColor,
                                         "MeteorComposite");
         outWindow.mainView.beginProcess(UndoFlag.NoSwapFile);
         outWindow.mainView.image.assign(output);
         outWindow.mainView.endProcess();
         outWindow.saveAs(outputPath, false, false, false, false);
         outWindow.forceClose();

         // The mask goes beside the composite. requirements.md 7.2 allows
         // stopping at Stage 3 and handing the mask over, and when a
         // composite looks wrong the mask is the first thing to check.
         var maskPath = outputPath.replace(/\.xisf$/i, "") + "_mask.xisf";
         var maskWindow = new ImageWindow(W, H, 1, 32, true, false, "MeteorMask");
         maskWindow.mainView.beginProcess(UndoFlag.NoSwapFile);
         maskWindow.mainView.image.assign((new Matrix(combinedMask, H, W)).toImage());
         maskWindow.mainView.endProcess();
         maskWindow.saveAs(maskPath, false, false, false, false);
         maskWindow.forceClose();

         var coverage = maskCoverage({ data: combinedMask, width: W, height: H });
         var message = "Composited " + composed + " of " + jobs.length + " frames.\n\n"
                     + outputPath + "\n" + maskPath + "\n\n"
                     + "The mask covers " + (coverage.fraction * 100).toFixed(2)
                     + "% of the frame.";
         if (skipped.length > 0) {
            message += "\n\nLeft out:\n  " + skipped.join("\n  ");
         }

         // The same summary in the console, because the message box takes its
         // copy with it when it closes.
         console.writeln("<end><cbr>");
         console.writeln("MeteorComposer: composited " + composed + " of "
                         + jobs.length + " frames in "
                         + ((Date.now() - startedAt) / 1000).toFixed(1) + " s");
         console.writeln("  " + outputPath);
         console.writeln("  " + maskPath);
         console.writeln("  mask covers " + (coverage.fraction * 100).toFixed(3)
                         + "% of the frame (" + coverage.touched + " pixels, "
                         + coverage.solid + " solid)");
         if (skipped.length > 0) {
            console.warningln("  left out " + skipped.length + ":");
            for (var sk = 0; sk < skipped.length; ++sk) {
               console.warningln("    " + skipped[sk]);
            }
         }
         console.flush();

         this.progressLabel.text = "Composited " + composed + " / " + jobs.length;
         (new MessageBox(message, TITLE, StdIcon.Information, StdButton.Ok)).execute();
      } finally {
         console.abortEnabled = false;
         masterWindow.forceClose();
      }
   }

   restoreSettings() {
      try {
         this.restoreSettingsInner();
      } finally {
         // Construction and restore are both "not the operator". The flag is
         // raised in the constructor, before any control exists, and comes down
         // here - not at the start of this method. Building the mask controls
         // calls refreshMask(), and with the flag down that would have written
         // an empty mask over the stored one before this method got to read it.
         this._restoringSettings = false;
      }
   }

   restoreSettingsInner() {
      var dir = Settings.read(SETTINGS_KEY + "/registeredDir", DataType.String);
      if (dir !== null && dir.length > 0) {
         this.registeredDir = dir;
         this.dirEdit.text = dir;
      }
      // An empty stored value is not a choice, so the guess from the frames
      // directory still applies in that case.
      var outputDir = Settings.read(SETTINGS_KEY + "/outputDir", DataType.String);
      if (outputDir !== null && outputDir.length > 0) {
         this.setOutputDir(outputDir);
         this.outputDirChosen = true;
      } else if (this.registeredDir.length > 0) {
         this.setOutputDir(defaultOutputDir(this.registeredDir));
      }

      // Pane widths and the preview's orientation are per-operator working
      // preferences, not per-session data, so they belong in Settings rather
      // than in the session file.
      var listWidth = Settings.read(SETTINGS_KEY + "/listWidth", DataType.Int32);
      if (listWidth !== null && listWidth > 0) {
         this.setListWidth(listWidth);
      }
      var detailWidth = Settings.read(SETTINGS_KEY + "/detailWidth", DataType.Int32);
      if (detailWidth !== null && detailWidth > 0) {
         this.setDetailWidth(detailWidth);
      }
      var rotation = Settings.read(SETTINGS_KEY + "/rotation", DataType.Int32);
      if (rotation !== null) {
         this.preview.rotation = normalizeRotation(rotation);
      }

      // The stretch is a way of looking, not a property of the night, so it
      // belongs with the rotation rather than with the session. An unknown
      // value falls through stfPlan() to unlinked, which is what the script
      // did before there was a choice.
      var stfMode = Settings.read(SETTINGS_KEY + "/stfMode", DataType.String);
      if (stfMode !== null) {
         var known = STF_MODES.indexOf(stfMode);
         if (known >= 0) {
            this.cache.stfMode = stfMode;
            this.stfCombo.currentItem = known;
            this.lockSTFCheck.enabled = stfPlan(stfMode).lockable;
         }
      }

      // The mask describes the site, not the night, so it outlives a session:
      // the same trees are in the way next time. Stored as JSON rather than as
      // nine separate keys, because it is one setting.
      var maskJSON = Settings.read(SETTINGS_KEY + "/mask", DataType.String);
      if (maskJSON !== null && maskJSON.length > 0) {
         try {
            this.applyMaskSpec(JSON.parse(maskJSON));
         } catch (e) {
            console.warningln("MeteorComposer: stored mask could not be read: " + e);
         }
      }

      // Sets the enabled state of both halves and fills the readout, whether or
      // not anything was restored.
      this.maskSourceChanged();
   }

   // Persist now, not at closing time.
   //
   // Everything here used to be written once, from main(), after execute()
   // returned. An operator set a tilt back to zero, closed, reopened and found
   // the old value. The store held the old value, and the three settings it did
   // hold - list 220, detail 510, tilt 37 - were exactly the set left by an
   // earlier session, which is what a save that never ran looks like. Whatever
   // skipped it (an exception out of execute(), quitting the application rather
   // than the dialog), betting the operator's settings on one exit path was the
   // mistake.
   //
   // This project already made the same call for verdicts, which are written
   // after every keystroke so that nothing is lost by forgetting to save. There
   // was no reason for the mask and the view settings to be treated as less
   // durable than that. Settings.write() is cheap, and these change at human
   // speed.
   //
   // saveSettings() stays, called from main() as before, as a backstop for
   // anything that changed without going through a setter.
   saveSettings() {
      this.saveViewSettings();
      this.saveMaskSetting();
      Settings.write(SETTINGS_KEY + "/registeredDir", DataType.String,
                     this.registeredDir);
      Settings.write(SETTINGS_KEY + "/outputDir", DataType.String, this.outputDir);
   }

   saveViewSettings() {
      Settings.write(SETTINGS_KEY + "/listWidth", DataType.Int32, this.listWidth);
      Settings.write(SETTINGS_KEY + "/detailWidth", DataType.Int32, this.detailWidth);
      Settings.write(SETTINGS_KEY + "/rotation", DataType.Int32,
                     normalizeRotation(this.preview.rotation));
      Settings.write(SETTINGS_KEY + "/stfMode", DataType.String,
                     this.cache.stfMode);
   }

   saveMaskSetting() {
      var maskJSON = JSON.stringify(this.maskSpec());
      Settings.write(SETTINGS_KEY + "/mask", DataType.String, maskJSON);
      // Said out loud, at the moment it happens. The question "was it saved?"
      // is then answered by the log the operator already keeps.
      console.writeln("<end><cbr>mask saved: " + maskJSON);
   }

   updateEnabled() {
      var hasSession = this.session !== null;
      this.detectButton.enabled = this.registeredDir.length > 0;
      this.saveSessionButton.enabled = hasSession;
      this.loadSessionButton.enabled = hasSession;
      this.exportButton.enabled = hasSession;
      this.composeButton.enabled = hasSession;
      this.meteorButton.enabled = hasSession;
      this.notMeteorButton.enabled = hasSession;
      this.uncertainButton.enabled = hasSession;
      this.clearVerdictButton.enabled = hasSession;
      this.prevButton.enabled = hasSession;
   }
};

//============================================================================
// Entry point
//============================================================================

// Ground-truth mode builds the evaluation set the detector is measured
// against. It detects with deliberately loose settings, shows no scores and no
// cutoff, and lists every candidate in capture order - all of which are
// requirements for the labelling not to be circular (docs/tests.md 5-2), and
// all of which make it look like a broken tool to anyone using it to composite
// meteors.
//
// So it is not offered. Someone screening a night's frames has no way to answer
// "which mode?", and choosing wrong costs them a session. The mode dialog only
// appears when this key is set, which is a thing only its author does:
//
//    Settings.write( "MeteorComposer/enableGroundTruthMode", DataType.Boolean, true );
//
// Run in the Script Editor once; it persists. Setting it to false, or deleting
// it, puts things back.
function groundTruthModeAvailable() {
   var enabled = Settings.read(SETTINGS_KEY + "/enableGroundTruthMode",
                               DataType.Boolean);
   return enabled === true;
}

function main() {
   console.show();
   console.writeln("<end><cbr>" + TITLE + " " + VERSION);

   var mode = MODE.SCREENING;
   if (groundTruthModeAvailable()) {
      var modeDialog = new ModeDialog;
      if (!modeDialog.execute()) {
         return;
      }
      mode = modeDialog.mode;
   }

   var dialog = new MeteorComposerDialog(mode);
   dialog.execute();
   dialog.saveSettings();
}

main();
