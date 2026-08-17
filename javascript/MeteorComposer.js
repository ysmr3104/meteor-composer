#engine v8

#feature-id    MeteorComposer : Image Analysis > MeteorComposer | ysmrastro > MeteorComposer
#feature-info  Detect meteors in a night's worth of registered frames and screen \
   the candidates by eye. Phase 1: detection and screening only.

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

#define VERSION "0.1.0"
#define TITLE   "MeteorComposer"

#include "detection_core.js"
#include "candidate_ops.js"
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

// Written beside the detection results after every verdict, so that closing
// the dialog - or losing it - never costs the screening work.
#define AUTOSAVE_NAME "meteor_session.json"

// Overlay colours by verdict. Unreviewed is deliberately the most visible:
// it is the thing the operator is looking for.
#define COLOUR_UNREVIEWED 0xFFFFD24A
#define COLOUR_METEOR     0xFF44DD55
#define COLOUR_NOT_METEOR 0xFFDD4444
#define COLOUR_UNCERTAIN  0xFFFF9922
#define COLOUR_SELECTED   0xFFFFFFFF

//============================================================================
// PJSR layer: frames on disk
//============================================================================

// External volumes formatted as exFAT carry macOS AppleDouble sidecars named
// "._<name>". They are not images and must be skipped.
function isRealXisf(name) {
   return name.length > 5
       && name.indexOf("._") !== 0
       && name.indexOf(".") !== 0
       && name.toLowerCase().lastIndexOf(".xisf") === name.length - 5;
}

// Trailing separators are stripped first: a directory chosen from the browser
// may or may not carry one, and "a/b/" would otherwise yield an empty name.
function baseName(path) {
   var trimmed = path.replace(/[\/\\]+$/, "");
   var cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
   return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

function directoryOf(path) {
   var cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
   return cut > 0 ? path.slice(0, cut) : "";
}

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
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   try {
      var Y = new Image();
      win.mainView.image.getLuminance(Y);
      Y.resample(1.0 / factor);
      var m = Y.toMatrix();
      return { data: m.toArray(), width: Y.width, height: Y.height };
   } finally {
      win.forceClose();
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

function computeSTF(view) {
   var median = view.computeOrFetchProperty("Median");
   var mad = view.computeOrFetchProperty("MAD");
   var centre = [];
   var sigma = [];
   for (var i = 0; i < median.length; ++i) {
      // A non-positive median makes the stretch degenerate.
      centre.push(Math.max(0.00001, median[i]));
      sigma.push(1.4826 * mad[i]);
   }
   return view.image.computeAutoStretch(centre, sigma, -2.8, 0.25, false);
}

// Render one frame at 1:1.
//
// `lockedSTF` reuses a stretch computed from an earlier frame. Median and MAD
// cost ~445 ms of the ~1.2 s per frame, and registered frames from one
// session are statistically near-identical, so locking is the single largest
// saving available here.
function renderFrame(path, lockedSTF) {
   var windows = ImageWindow.open(path);
   if (!windows || windows.length === 0) {
      return null;
   }
   var win = windows[0];
   var stretched = null;
   try {
      var view = win.mainView;
      var stf = lockedSTF !== null ? lockedSTF : computeSTF(view);
      stretched = new Image(view.image);
      stretched.applyDisplayFunction(stf);
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
   }

   has(path) {
      return this.entries[path] !== undefined;
   }

   get(path) {
      if (this.entries[path] !== undefined) {
         this.touch(path);
         return this.entries[path];
      }
      var result = renderFrame(path, this.lockedSTF);
      if (result === null) {
         return null;
      }
      // The first successful render supplies the stretch for the rest of the
      // session unless the operator unlocks it.
      if (this.lockedSTF === null && this.lockSTF) {
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
            g.drawScaledBitmap(
               new Rect(-self.scrollX, -self.scrollY,
                        dispW - self.scrollX, dispH - self.scrollY),
               bmp);

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
      if (this.bitmap === null) {
         this.displayBitmap = null;
         return;
      }
      this.displayBitmap = (normalizeRotation(this.rotation) === 0)
         ? this.bitmap
         : this.bitmap.rotated(normalizeRotation(this.rotation));
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
   constructor(parent, onDragged) {
      super(parent);

      this.setFixedWidth(7);
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

      this.onMouseRelease = function (x, y, button, buttonState, modifiers) {
         self.dragging = false;
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
      this.autosaveError = null;
      // Screening opens sorted by score, highest first: the ordering was
      // measured to put 25 of 31 labelled meteors in the top 50 rows.
      // Ground-truth mode opens in capture order, because ordering by the
      // classifier's opinion is itself a nudge (docs/tests.md 5-2).
      this.sortKey = defaultSortKey(mode);
      this.sortAscending = (this.sortKey !== "score");

      var self = this;

      this.windowTitle = TITLE + " " + VERSION + "  -  "
                       + (mode === MODE.GROUND_TRUTH ? "Ground truth" : "Screening");

      this.listWidth = 380;
      this.detailWidth = 360;

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
      });
      // Dragging the right-hand handle rightwards should shrink the detail
      // pane, hence the inverted sign.
      this.detailSplitter = new SplitterHandle(this, function (delta) {
         self.setDetailWidth(self.detailWidth - delta);
      });

      var split = new HorizontalSizer;
      split.spacing = 0;
      split.add(this.listPanel);
      split.add(this.listSplitter);
      split.add(this.previewPanel, 100);
      split.add(this.detailSplitter);
      split.add(this.detailPanel);

      this.sizer = new VerticalSizer;
      this.sizer.margin = 8;
      this.sizer.spacing = 6;
      this.sizer.add(this.sourceGroup);
      this.sizer.add(split, 100);
      this.sizer.add(this.verdictGroup);
      this.sizer.add(this.buttonSizer);

      this.setMinSize(1180, 760);

      // The dialog, the list and the preview all get the same handler:
      // whichever has focus, the judging keys have to work.
      var keyHandler = function (key, modifiers) {
         return self.handleKey(key, modifiers);
      };
      this.onKeyPress = keyHandler;
      this.candidateTree.onKeyPress = keyHandler;
      this.preview.onKeyPress = keyHandler;

      this.restoreSettings();
      this.updateEnabled();
   }

   // --- Construction -------------------------------------------------------

   buildSourceSection() {
      var self = this;

      this.sourceGroup = new GroupBox(this);
      this.sourceGroup.title = "Source";

      this.dirEdit = new Edit(this.sourceGroup);
      this.dirEdit.readOnly = true;
      this.dirEdit.toolTip = "<p>Directory of registered frames (.xisf).</p>";

      this.browseButton = new PushButton(this.sourceGroup);
      this.browseButton.text = "Browse...";
      this.browseButton.onClick = function () {
         var dlg = new GetDirectoryDialog;
         dlg.caption = "Registered frames directory";
         if (dlg.execute()) {
            self.registeredDir = dlg.directory;
            self.dirEdit.text = dlg.directory;
            self.updateEnabled();
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
      row1.add(this.dirEdit, 100);
      row1.add(this.browseButton);

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
      this.sourceGroup.sizer.add(row1);
      this.sourceGroup.sizer.add(row2);
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
      this.columns = ["#", "File", "Len", "Ang", "Elong", "Track", "Verdict"];
      if (modeShowsScores(this.mode)) {
         this.columns.splice(6, 0, "Score");
      }

      this.candidateTree.numberOfColumns = this.columns.length;
      for (var i = 0; i < this.columns.length; ++i) {
         this.candidateTree.setHeaderText(i, this.columns[i]);
      }
      this.candidateTree.setColumnWidth(0, 46);
      this.candidateTree.setColumnWidth(1, 210);

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
      this.showLabel.textAlignment = TextAlignment.Right | TextAlignment.VerticalCenter;

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
      this.presetLabel.textAlignment = TextAlignment.Right | TextAlignment.VerticalCenter;

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
      this.hidePersistentCheck.text = "Hide persistent tracks";
      this.hidePersistentCheck.toolTip =
         "<p>Hide candidates whose track spans more than maxMeteorFrames "
       + "frames. Those are almost certainly satellites or aircraft.</p>";
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
      this.sortLabel.textAlignment = TextAlignment.Right | TextAlignment.VerticalCenter;

      var controls = new HorizontalSizer;
      controls.spacing = 6;
      controls.add(this.showLabel);
      controls.add(this.showCombo);
      controls.addSpacing(8);
      controls.add(this.sortLabel);
      controls.add(this.sortCombo);

      var controls2 = new HorizontalSizer;
      controls2.spacing = 6;
      controls2.add(this.presetLabel);
      controls2.add(this.presetCombo);
      controls2.addSpacing(8);
      controls2.add(this.hidePersistentCheck);
      controls2.addStretch();

      this.listSizer = new VerticalSizer;
      this.listSizer.spacing = 4;
      this.listSizer.add(controls);
      this.listSizer.add(controls2);
      this.listSizer.add(this.candidateTree, 100);
   }

   buildPreviewSection() {
      var self = this;

      this.preview = new MeteorPreviewControl(this);
      this.preview.setScaledMinSize(420, 380);
      this.preview.onCandidateClick = function (candidateIndex) {
         self.selectByCandidateIndex(candidateIndex);
      };

      this.fitButton = new PushButton(this);
      this.fitButton.text = "Fit";
      this.fitButton.onClick = function () {
         self.preview.fitToWindow();
      };

      this.zoom11Button = new PushButton(this);
      this.zoom11Button.text = "1:1";
      this.zoom11Button.onClick = function () {
         self.preview.zoom11();
         self.preview.centreOn(self.currentCandidateIndex());
      };

      this.zoomInButton = new PushButton(this);
      this.zoomInButton.text = "+";
      this.zoomInButton.onClick = function () {
         self.preview.zoomIn();
      };

      this.zoomOutButton = new PushButton(this);
      this.zoomOutButton.text = "-";
      this.zoomOutButton.onClick = function () {
         self.preview.zoomOut();
      };

      this.lockSTFCheck = new CheckBox(this);
      this.lockSTFCheck.text = "Lock stretch";
      this.lockSTFCheck.checked = true;
      this.lockSTFCheck.toolTip =
         "<p>Reuse the stretch computed from the first frame. Median and MAD "
       + "cost about 445 ms of the ~1.2 s each frame takes, and registered "
       + "frames from one session are near-identical, so locking makes "
       + "stepping through the list noticeably quicker.</p>";
      this.rotateLeftButton = new PushButton(this);
      this.rotateLeftButton.text = "↶";
      this.rotateLeftButton.toolTip =
         "<p>Turn the preview a quarter turn anticlockwise. The rotation is a "
       + "property of the view, not of the frame, so it stays as you move "
       + "through the candidates.</p>";
      this.rotateLeftButton.onClick = function () {
         self.setRotation(self.preview.rotation - 90);
      };

      this.rotateRightButton = new PushButton(this);
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

      var toolbar = new HorizontalSizer;
      toolbar.spacing = 4;
      toolbar.add(this.fitButton);
      toolbar.add(this.zoom11Button);
      toolbar.add(this.zoomInButton);
      toolbar.add(this.zoomOutButton);
      toolbar.addSpacing(8);
      toolbar.add(this.rotateLeftButton);
      toolbar.add(this.rotateRightButton);
      toolbar.addSpacing(10);
      toolbar.add(this.lockSTFCheck);
      toolbar.addSpacing(10);
      toolbar.add(this.frameLabel, 100);

      this.previewSizer = new VerticalSizer;
      this.previewSizer.spacing = 4;
      this.previewSizer.add(toolbar);
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

      this.detailInButton = new PushButton(this);
      this.detailInButton.text = "+";
      this.detailInButton.onClick = function () {
         self.detail.setMargin(self.detail.margin / 1.4);
      };

      this.detailOutButton = new PushButton(this);
      this.detailOutButton.text = "-";
      this.detailOutButton.onClick = function () {
         self.detail.setMargin(self.detail.margin * 1.4);
      };

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

   setListWidth(width) {
      this.listWidth = Math.max(220, Math.min(900, Math.round(width)));
      this.listPanel.setFixedWidth(this.listWidth);
   }

   setDetailWidth(width) {
      this.detailWidth = Math.max(180, Math.min(900, Math.round(width)));
      this.detailPanel.setFixedWidth(this.detailWidth);
   }

   setRotation(degrees) {
      this.preview.setRotation(degrees);
      this.preview.centreOn(this.preview.selectedIndex);
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

      this.closeButton = new PushButton(this);
      this.closeButton.text = "Close";
      this.closeButton.onClick = function () {
         self.requestClose();
      };

      this.autosaveLabel = new Label(this);
      this.autosaveLabel.text = "";
      this.autosaveLabel.toolTip =
         "<p>Verdicts are written to " + AUTOSAVE_NAME + " beside the "
       + "detection results after every judgement, so there is nothing to "
       + "remember to save.</p>";

      this.buttonSizer = new HorizontalSizer;
      this.buttonSizer.spacing = 6;
      this.buttonSizer.add(this.saveSessionButton);
      this.buttonSizer.add(this.loadSessionButton);
      this.buttonSizer.add(this.exportButton);
      this.buttonSizer.add(this.composeButton);
      this.buttonSizer.addSpacing(12);
      this.buttonSizer.add(this.autosaveLabel, 100);
      this.buttonSizer.add(this.closeButton);
   }

   // --- Detection ----------------------------------------------------------

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
                      options: options, frames: [] };
      var withCandidates = 0;

      for (var i = 0; i < frames.length; ++i) {
         if (this.cancelRequested) {
            break;
         }
         var name = frames[i];
         var record = { file: name, candidates: [] };
         try {
            var field = loadField(this.registeredDir + "/" + name, SCREEN_FACTOR);
            if (field !== null) {
               var r = detectCandidates(field, options, null);
               record.width = field.width;
               record.height = field.height;
               record.candidates = r.candidates;
               record.sigma = r.sigma;
               record.median = r.median;
               record.componentCount = r.componentCount;
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
      }
      this.adoptResults(results);
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
         var payload = JSON.parse(File.readTextFile(dlg.fileName));
         // Remembered so the autosave lands beside the results it belongs to.
         this.resultsPath = dlg.fileName;
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
         console.writeln("<end><cbr>fixed structures: " + fixed.length);
      }

      var sum = summarize(this.session);
      this.progressLabel.text = results.frames.length + " frames, "
                              + sum.total + " candidates.";
      this.cache.clear();
      this.refreshList();
      this.updateEnabled();
      this.updateAutosaveLabel();
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
         node.setText(1, row.file);
         node.setText(2, row.candidate.length.toFixed(1));
         node.setText(3, row.candidate.angle.toFixed(1));
         node.setText(4, row.candidate.elongation.toFixed(1));
         node.setText(5, this.trackText(row));
         var col = 6;
         if (modeShowsScores(this.mode)) {
            node.setText(col++, row.score === undefined ? "-" : row.score.toFixed(3));
         }
         node.setText(col, this.verdictText(row.verdict));
      }

      if (this.displayed.length > 0) {
         var target = this.currentRow;
         if (target < 0 || target >= this.displayed.length) {
            target = 0;
         }
         this.selectDisplayed(target, true);
      } else {
         this.currentRow = -1;
         this.preview.setCandidates([], [], [], -1);
      }
      this.updateSummary();
   }

   // A fixed structure and a satellite are both "seen many times", but they
   // are not the same finding and the operator acts on them differently.
   trackText(row) {
      if (row.stationary) {
         return row.fixedCount + " fixed";
      }
      return "" + row.trackLength + (row.persistent ? " *" : "");
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

   // The candidate's position within the frame's candidate array, which is
   // what the preview draws.
   currentCandidateIndex() {
      if (this.currentRow < 0 || this.currentRow >= this.displayed.length) {
         return -1;
      }
      return this.displayed[this.currentRow].indexInFrame;
   }

   selectByCandidateIndex(candidateIndex) {
      if (this.currentRow < 0) {
         return;
      }
      var file = this.displayed[this.currentRow].file;
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
      var frameChanged = this.currentRow < 0
                      || this.displayed[this.currentRow].file !== this.displayed[index].file;
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
      if (this.currentRow < 0 || this.session === null) {
         return;
      }
      var row = this.displayed[this.currentRow];
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
            + "   " + rendered.width + "x" + rendered.height;
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
      if (this.currentRow < 0 || this.currentRow + 1 >= this.displayed.length) {
         return;
      }
      var nextFile = this.displayed[this.currentRow + 1].file;
      if (nextFile === this.displayed[this.currentRow].file) {
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
      if (this.currentRow < 0) {
         return;
      }
      var file = this.displayed[this.currentRow].file;
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
      this.updateDetail();
   }

   // --- Judging ------------------------------------------------------------

   judge(verdict, stay) {
      if (this.currentRow < 0) {
         return;
      }
      var row = this.displayed[this.currentRow];
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

   // Where the automatic save goes: beside the detection results if they came
   // from a file, otherwise beside the frames. Both are places the operator
   // already thinks of as belonging to this session, so the file is where
   // they would look for it.
   autosavePath() {
      var dir = null;
      if (this.resultsPath !== null) {
         dir = directoryOf(this.resultsPath);
      }
      if ((dir === null || dir.length === 0) && this.registeredDir.length > 0) {
         dir = this.registeredDir;
      }
      if (dir === null || dir.length === 0) {
         return null;
      }
      return dir + "/" + AUTOSAVE_NAME;
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
      var suggested = this.autosavePath();
      if (suggested !== null) {
         dlg.initialPath = suggested;
      }
      if (!dlg.execute()) {
         return;
      }
      try {
         File.writeTextFile(dlg.fileName,
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
         dlg.initialPath = suggested;
      }
      if (!dlg.execute()) {
         return;
      }
      try {
         var saved = JSON.parse(File.readTextFile(dlg.fileName));
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
         File.writeTextFile(dlg.fileName, JSON.stringify(gt, null, 2));
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

      var masterDialog = new OpenFileDialog;
      masterDialog.caption = "Choose the master light";
      masterDialog.multipleSelections = false;
      masterDialog.filters = [["Images", "*.xisf *.fit *.fits *.tif *.tiff"]];
      if (!masterDialog.execute()) {
         return;
      }

      var saveDialog = new SaveFileDialog;
      saveDialog.caption = "Save the composite as";
      saveDialog.filters = [["XISF", "*.xisf"]];
      if (this.registeredDir.length > 0) {
         saveDialog.initialPath = directoryOf(this.registeredDir) + "/meteor_composite.xisf";
      }
      if (!saveDialog.execute()) {
         return;
      }

      this.cursor = new Cursor(StdCursor.Wait);
      try {
         this.compose(masterDialog.fileName, saveDialog.fileName, jobs);
      } catch (e) {
         (new MessageBox("Composition failed:\n" + e,
                         TITLE, StdIcon.Error, StdButton.Ok)).execute();
      } finally {
         this.cursor = new Cursor(StdCursor.Arrow);
      }
   }

   compose(masterPath, outputPath, jobs) {
      var masterWindow = ImageWindow.open(masterPath)[0];
      if (!masterWindow) {
         throw new Error("could not open the master: " + masterPath);
      }

      var composed = 0;
      var skipped = [];
      var W, H, channels;

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

         for (var k = 0; k < jobs.length; ++k) {
            var job = jobs[k];
            this.progressLabel.text = "Compositing " + (k + 1) + " / " + jobs.length
                                    + "   " + job.file;
            CoreApplication.processEvents();

            var maskField = renderMask(job.trails, W, H, null);
            // One rectangle per trail, so that the local sky is measured
            // around each trail rather than once for the frame.
            var rects = [];
            for (var ti = 0; ti < job.trails.length; ++ti) {
               rects.push(maskBounds(job.trails[ti], W, H, null));
            }

            var subWindow = null;
            try {
               subWindow = ImageWindow.open(this.framePath(job.file))[0];
            } catch (e) {
               skipped.push(job.file + ": could not open");
               continue;
            }
            if (!subWindow) {
               skipped.push(job.file + ": could not open");
               continue;
            }

            try {
               var subImage = subWindow.mainView.image;
               if (subImage.width !== W || subImage.height !== H) {
                  // A cropped master against uncropped subs would put every
                  // mask in the wrong place, and the result would look like a
                  // mask bug rather than a mismatch.
                  skipped.push(job.file + ": " + subImage.width + "x" + subImage.height
                               + " does not match the master's " + W + "x" + H);
                  continue;
               }

               var subChannels = [];
               for (ch = 0; ch < channels; ++ch) {
                  subChannels.push(channelToArray(subImage, ch));
               }

               var outcome = composeFrame(masterChannels, subChannels,
                                          maskField.data, W, H, rects, added, null);
               if (!outcome.written) {
                  // Compositing a frame that does not match the master
                  // produces a result that looks plausible and is wrong, so
                  // the frame is left out and the operator is told. Nothing
                  // was written for any channel.
                  skipped.push(job.file + ": " + outcome.reason);
                  continue;
               }

               for (var m = 0; m < maskField.data.length; ++m) {
                  if (maskField.data[m] > combinedMask[m]) {
                     combinedMask[m] = maskField.data[m];
                  }
               }
               ++composed;
            } finally {
               subWindow.forceClose();
            }
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
         this.progressLabel.text = "Composited " + composed + " / " + jobs.length;
         (new MessageBox(message, TITLE, StdIcon.Information, StdButton.Ok)).execute();
      } finally {
         masterWindow.forceClose();
      }
   }

   restoreSettings() {
      var dir = Settings.read(SETTINGS_KEY + "/registeredDir", DataType.String);
      if (dir !== null && dir.length > 0) {
         this.registeredDir = dir;
         this.dirEdit.text = dir;
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
   }

   saveSettings() {
      Settings.write(SETTINGS_KEY + "/registeredDir", DataType.String,
                     this.registeredDir);
      Settings.write(SETTINGS_KEY + "/listWidth", DataType.Int32, this.listWidth);
      Settings.write(SETTINGS_KEY + "/detailWidth", DataType.Int32, this.detailWidth);
      Settings.write(SETTINGS_KEY + "/rotation", DataType.Int32,
                     normalizeRotation(this.preview.rotation));
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

function main() {
   console.show();
   console.writeln("<end><cbr>" + TITLE + " " + VERSION);

   var modeDialog = new ModeDialog;
   if (!modeDialog.execute()) {
      return;
   }

   var dialog = new MeteorComposerDialog(modeDialog.mode);
   dialog.execute();
   dialog.saveSettings();
}

main();
