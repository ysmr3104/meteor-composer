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

      this.bitmap = null;
      this.imageWidth = 0;
      this.imageHeight = 0;
      this.zoomLevel = 1.0;

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
            if (self.bitmap === null) {
               return;
            }

            var dispW = Math.round(self.bitmap.width * self.zoomLevel);
            var dispH = Math.round(self.bitmap.height * self.zoomLevel);
            g.drawScaledBitmap(
               new Rect(-self.scrollX, -self.scrollY,
                        dispW - self.scrollX, dispH - self.scrollY),
               self.bitmap);

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
            var img = viewToImage(x, y, self.zoomLevel, self.scrollX, self.scrollY);
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
         imageHeight: this.imageHeight
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
      if (this._needsFit) {
         this.fitToWindow();
      } else {
         this.updateViewport();
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
      if (this.bitmap === null || candidateIndex < 0
          || candidateIndex >= this.candidates.length) {
         return;
      }
      var c = candidateCentroid(this.candidates[candidateIndex],
                                SCREEN_FACTOR, SCREEN_FACTOR);
      var viewW = this.viewport.width;
      var viewH = this.viewport.height;
      this.setScroll(c.x * this.zoomLevel - viewW / 2,
                     c.y * this.zoomLevel - viewH / 2);
   }

   setScroll(x, y) {
      this.scrollX = Math.max(0, Math.min(this.maxScrollX, Math.round(x)));
      this.scrollY = Math.max(0, Math.min(this.maxScrollY, Math.round(y)));
      this.horizontalScrollPosition = this.scrollX;
      this.verticalScrollPosition = this.scrollY;
      this.viewport.update();
   }

   updateViewport() {
      if (this.bitmap === null) {
         this.setHorizontalScrollRange(0, 0);
         this.setVerticalScrollRange(0, 0);
         this.viewport.update();
         return;
      }
      var dispW = Math.round(this.bitmap.width * this.zoomLevel);
      var dispH = Math.round(this.bitmap.height * this.zoomLevel);
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
      if (this.bitmap === null) {
         return;
      }
      var viewW = this.viewport.width > 0 ? this.viewport.width : this.width;
      var viewH = this.viewport.height > 0 ? this.viewport.height : this.height;
      if (viewW <= 0 || viewH <= 0) {
         return;
      }
      this.zoomLevel = Math.min(viewW / this.bitmap.width, viewH / this.bitmap.height);
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
      if (this.bitmap === null || Math.abs(this.zoomLevel - newZoom) < 1e-9) {
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
      // defaultSortKey() returns "score" for screening mode, but nothing
      // produces a score yet (Phase 2). Sorting by it would silently be
      // sorting by nothing, so fall back to capture order until it exists.
      this.sortKey = defaultSortKey(mode);
      if (this.sortKey === "score") {
         this.sortKey = "frameIndex";
      }
      this.sortAscending = true;

      var self = this;

      this.windowTitle = TITLE + " " + VERSION + "  -  "
                       + (mode === MODE.GROUND_TRUTH ? "Ground truth" : "Screening");

      this.buildSourceSection();
      this.buildListSection();
      this.buildPreviewSection();
      this.buildVerdictSection();
      this.buildButtonSection();

      var split = new HorizontalSizer;
      split.spacing = 6;
      split.add(this.listSizer, 38);
      split.add(this.previewSizer, 62);

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

      // No Score column yet. Classification scoring is Phase 2
      // (docs/requirements.md 9); until it exists the column would be empty
      // on every row, which reads as a defect rather than as "not built yet".
      // modeShowsScores() stays as the gate for when it arrives: in
      // ground-truth mode the column must not appear at all.
      this.columns = ["#", "File", "Len", "Ang", "Elong", "Track", "Verdict"];

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
      this.sortCombo.onItemSelected = function (index) {
         self.sortKey = self.sortKeys[index];
         // Longest first is the useful direction for length; everything else
         // reads forwards.
         self.sortAscending = (self.sortKey !== "length");
         self.refreshList();
      };
      var startIndex = this.sortKeys.indexOf(this.sortKey);
      this.sortCombo.currentItem = startIndex >= 0 ? startIndex : 0;

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
      if (!modeAllowsFiltering(this.mode)) {
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
      controls.add(this.sortLabel);
      controls.add(this.sortCombo);
      controls.add(this.hidePersistentCheck);
      controls.addStretch();

      this.listSizer = new VerticalSizer;
      this.listSizer.spacing = 4;
      this.listSizer.add(controls);
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
      toolbar.addSpacing(10);
      toolbar.add(this.lockSTFCheck);
      toolbar.addSpacing(10);
      toolbar.add(this.frameLabel, 100);

      this.previewSizer = new VerticalSizer;
      this.previewSizer.spacing = 4;
      this.previewSizer.add(toolbar);
      this.previewSizer.add(this.preview, 100);
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

      this.exportButton = new PushButton(this);
      this.exportButton.text = "Export ground truth...";
      this.exportButton.onClick = function () {
         self.exportGroundTruth();
      };

      this.closeButton = new PushButton(this);
      this.closeButton.text = "Close";
      this.closeButton.onClick = function () {
         self.ok();
      };

      this.buttonSizer = new HorizontalSizer;
      this.buttonSizer.spacing = 6;
      this.buttonSizer.add(this.saveSessionButton);
      this.buttonSizer.add(this.loadSessionButton);
      this.buttonSizer.add(this.exportButton);
      this.buttonSizer.addStretch();
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

      var sum = summarize(this.session);
      this.progressLabel.text = results.frames.length + " frames, "
                              + sum.total + " candidates.";
      this.cache.clear();
      this.refreshList();
      this.updateEnabled();
   }

   // --- List ---------------------------------------------------------------

   refreshList() {
      if (this.session === null) {
         return;
      }
      var filter = { hidePersistent: this.hidePersistentCheck.checked };
      var rows = filterRows(this.session, filter);
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
         node.setText(5, "" + row.trackLength + (row.persistent ? " *" : ""));
         node.setText(6, this.verdictText(row.verdict));
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
   }

   // --- Judging ------------------------------------------------------------

   judge(verdict, stay) {
      if (this.currentRow < 0) {
         return;
      }
      var row = this.displayed[this.currentRow];
      setVerdict(this.session, row.id, verdict);

      var node = this.candidateTree.child(this.currentRow);
      if (node !== null) {
         node.setText(this.columns.length - 1, this.verdictText(verdict));
      }

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

   saveSession() {
      if (this.session === null) {
         return;
      }
      var dlg = new SaveFileDialog;
      dlg.caption = "Save screening session";
      dlg.filters = [["JSON files", "*.json"]];
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

   restoreSettings() {
      var dir = Settings.read(SETTINGS_KEY + "/registeredDir", DataType.String);
      if (dir !== null && dir.length > 0) {
         this.registeredDir = dir;
         this.dirEdit.text = dir;
      }
   }

   saveSettings() {
      Settings.write(SETTINGS_KEY + "/registeredDir", DataType.String,
                     this.registeredDir);
   }

   updateEnabled() {
      var hasSession = this.session !== null;
      this.detectButton.enabled = this.registeredDir.length > 0;
      this.saveSessionButton.enabled = hasSession;
      this.loadSessionButton.enabled = hasSession;
      this.exportButton.enabled = hasSession;
      this.meteorButton.enabled = hasSession;
      this.notMeteorButton.enabled = hasSession;
      this.uncertainButton.enabled = hasSession;
      this.clearVerdictButton.enabled = hasSession;
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
