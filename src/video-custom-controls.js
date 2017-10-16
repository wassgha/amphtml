/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Animation} from './animation';
import {dev} from './log';
import {listen} from './event-helper';
import {Services} from './services';
import {VideoEvents} from './video-interface';
import {secsToHHMMSS} from './utils/datetime';
import * as st from './style';
import * as tr from './transition';


/**
 * CustomControls is a class that given a video manager entry
 * ({@link ./service/video-manager-impl.VideoEntry}), adds an overlay of
 * customizable controls to the video element and manages their behavior.
 */
export class CustomControls {

  /**
   * Initializes variables and creates the custom controls
   * @param {!./service/ampdoc-impl.AmpDoc} ampdoc
   * @param {!./service/video-manager-impl.VideoEntry} entry
   * @param {{
   *    darkSkin:(boolean|undefined),
   *    mainControls:(Array<string>|undefined),
   *    miniControls:(Array<string>|undefined),
   *    floating:(string|undefined),
   * }=} opt_options
   *      - darkSkin: whether to use dark or light theme
   *      - mainControls: list of controls to add to the main bar
   *      - miniControls: list of controls to add to the minimized overlay
   *      - floating: single control button to use as the main action
   */
  constructor(ampdoc, entry, opt_options) {

    /** @private {!./service/ampdoc-impl.AmpDoc}  */
    this.ampdoc_ = ampdoc;

    /** @private {!./service/video-manager-impl.VideoEntry} */
    this.entry_ = entry;

    /** @private @const {!./service/vsync-impl.Vsync} */
    this.vsync_ = Services.vsyncFor(this.ampdoc_.win);

    this.options_ = opt_options || {
      darkSkin: false,
      mainControls: ['time', 'spacer', 'volume', 'fullscreen'],
      miniControls: ['play', 'volume', 'fullscreen'],
      floating: 'play',
    };

    /** @private {?Element} */
    this.controlContainer_ = null;

    /** @private {?Element} */
    this.controlBarContainer_ = null;

    /** @private {?Element} */
    this.controlBarWrapper_ = null;

    /** @private {?Element} */
    this.floatingContainer_ = null;

    /** @private {?Element} */
    this.miniControlsContainer_ = null;

    /** @private {?Element} */
    this.miniControlsWrapper_ = null;

    /** @private {?Element} */
    this.controlsBg_ = null;

    /** @private {?number} */
    this.controlsTimer_ = null;

    /** @private {boolean} */
    this.controlsShown_ = true;

    /** @private {boolean} */
    this.controlsShowing_ = false;

    /** @private {boolean} */
    this.controlsDisabled_ = false;

    /** @private {boolean} */
    this.minimal_ = false;

    this.createCustomControls_(this.options_);
  }

  /**
   * Returns the element that wraps all the controls
   * @return {!Element}
   */
  getElement() {
    return dev().assertElement(this.controlContainer_);
  }

  /**
   * Fullscreen Button
   * @return {!Element}
   * @private
   */
  createFullscreenBtn_() {
    const doc = this.ampdoc_.win.document;
    const fsBtnWrap = doc.createElement('div');
    fsBtnWrap.classList.add('amp-media-custom-controls-icon-wrapper');
    fsBtnWrap.classList.add('amp-media-custom-controls-fullscreen');
    const fsBtn = this.createIcon_('fullscreen');
    fsBtnWrap.appendChild(fsBtn);
    listen(fsBtnWrap, 'click', () => {
      if (this.entry_.video.isFullscreen()) {
        this.entry_.video.fullscreenExit();
      } else {
        this.entry_.video.fullscreenEnter();
      }
    });
    return fsBtnWrap;
  }

  /**
   * Volume controls
   * @return {!Element}
   * @private
   */
  createVolumeControls_() {
    const doc = this.ampdoc_.win.document;
    const volumeContainer = doc.createElement('div');
    volumeContainer.classList.add('amp-media-custom-controls-volume');
    const muteBtnWrap = doc.createElement('div');
    muteBtnWrap.classList.add('amp-media-custom-controls-icon-wrapper');
    muteBtnWrap.classList.add('amp-media-custom-controls-mute');
    const muteBtn = this.createIcon_(
        this.entry_.isMuted() ? 'mute' : 'volume-max'
    );
    muteBtnWrap.appendChild(muteBtn);
    volumeContainer.appendChild(muteBtnWrap);
    listen(muteBtnWrap, 'click', () => {
      if (this.entry_.isMuted()) {
        this.entry_.video.unmute();
      } else {
        this.entry_.video.mute();
      }
    });
    this.listenMultiple_(
        this.entry_.video.element,
        [VideoEvents.MUTED, VideoEvents.UNMUTED],
        e => {
          if (e.type == VideoEvents.MUTED) {
            this.changeIcon_(muteBtn, 'mute');
          } else {
            this.changeIcon_(muteBtn, 'volume-max');
          }
        }
    );
    return volumeContainer;
  }

  /**
   * Spacer that separates the left/right portions of the controls bar
   * @return {!Element}
   * @private
   */
  createSpacer_() {
    const doc = this.ampdoc_.win.document;
    const spacer = doc.createElement('div');
    spacer.classList.add('amp-media-custom-controls-spacer');
    return spacer;
  }

  /**
   * Play/Pause Button
   * @param {?Element|string} loadingElement
   * @return {!Element}
   * @private
   */
  createPlayPauseBtn_(loadingElement) {
    const doc = this.ampdoc_.win.document;
    const playpauseBtnWrap = doc.createElement('div');
    playpauseBtnWrap.classList.add('amp-media-custom-controls-icon-wrapper');
    playpauseBtnWrap.classList.add('amp-media-custom-controls-playpause');
    const playpauseBtn = this.createIcon_('play');
    playpauseBtnWrap.appendChild(playpauseBtn);
    if (loadingElement == 'self') {
      loadingElement = playpauseBtnWrap;
    }
    listen(playpauseBtnWrap, 'click', () => {
      if (this.entry_.isPlaying()) {
        this.changeIcon_(playpauseBtn, 'play');
        this.entry_.video.pause();
      } else {
        this.changeIcon_(playpauseBtn, 'pause');
        this.entry_.video.play(/*autoplay*/ false);
        loadingElement.classList.toggle(
            'amp-media-custom-controls-loading', true
        );
      }
    });
    this.listenMultiple_(this.entry_.video.element,
        [VideoEvents.PLAYING, VideoEvents.PAUSE],
        e => {
          loadingElement.classList.toggle(
              'amp-media-custom-controls-loading', false
          );
          if (e.type == VideoEvents.PAUSE) {
            this.changeIcon_(playpauseBtn, 'play');
            this.showControls();
            if (this.controlsTimer_) {
              clearTimeout(this.controlsTimer_);
            }
          } else {
            this.changeIcon_(playpauseBtn, 'pause');
          }
        }
    );
    return playpauseBtnWrap;
  }

  /**
   * Duration/Played time indicator
   * @return {!Element}
   * @private
   */
  createProgressTime_() {
    const doc = this.ampdoc_.win.document;
    const progressTime = doc.createElement('div');
    progressTime.classList.add('amp-media-custom-controls-progress-time');
    progressTime.textContent = '0:00 / 0:00';
    // Update played time
    const updateProgress = () => {
      const current = this.entry_.video.getCurrentTime() || 0;
      const currentFormatted = secsToHHMMSS(current);
      const total = this.entry_.video.getDuration() || 0;
      const totalFormatted = secsToHHMMSS(total);
      progressTime.textContent = currentFormatted + ' / ' + totalFormatted;
    };

    this.listenMultiple_(
        this.entry_.video.element,
        [VideoEvents.TIME_UPDATE, VideoEvents.LOAD],
        updateProgress.bind(this)
    );

    return progressTime;
  }

  /**
   * Progress bar
   * @return {!Element}
   * @private
   */
  createProgressBar_() {
    const doc = this.ampdoc_.win.document;
    const progressBar = doc.createElement('div');
    progressBar.classList.add('amp-media-custom-controls-progress-bar');
    const totalBar = doc.createElement('div');
    totalBar.classList.add('amp-media-custom-controls-total-bar');
    const currentBar = doc.createElement('div');
    currentBar.classList.add('amp-media-custom-controls-current-bar');
    const scrubber = doc.createElement('div');
    scrubber.classList.add('amp-media-custom-controls-scrubber');
    let scrubberTouched = false;
    let scrubberDragging = false;
    totalBar.appendChild(currentBar);
    totalBar.appendChild(scrubber);
    progressBar.appendChild(totalBar);
    let size = null;
    // Seek
    listen(totalBar, 'click', e => {
      // TODO(@wassgha) Seek when implemented
      if (!size) {
        size = progressBar./*OK*/getBoundingClientRect();
      }
      const left = size.left;
      const total = size.width;
      const newPercent = Math.min(100,
          Math.max(0, 100 * (e.clientX - left) / total)
      );
      st.setStyles(scrubber, {
        'left': st.percent(newPercent),
      });
      st.setStyles(currentBar, {
        'width': st.percent(newPercent),
      });
    });

    const toggleScrubberTouched = () => {
      scrubberTouched = true;
    };
    [totalBar, scrubber].forEach(element => {
      this.listenMultiple_(
          element,
          'mousedown touchstart',
          toggleScrubberTouched.bind(this)
      );
    });

    this.listenMultiple_(doc, 'mousemove touchmove', e => {
      // TODO(@wassgha) Seek when implemented
      if (!size) {
        size = progressBar./*OK*/getBoundingClientRect();
      }
      const left = size.left;
      const total = size.width;
      const newPercent = Math.min(100,
          Math.max(0, 100 * (e.clientX - left) / total)
      );
      scrubberDragging = scrubberTouched;
      if (scrubberDragging) {
        st.setStyles(scrubber, {
          'left': st.percent(newPercent),
        });
        st.setStyles(currentBar, {
          'width': st.percent(newPercent),
        });
      }
    });

    this.listenMultiple_(doc, 'mouseup touchend', () => {
      scrubberTouched = false;
      scrubberDragging = false;
    });

    // Update progress bar
    const updateProgress = () => {
      const current = this.entry_.video.getCurrentTime() || 0;
      const total = this.entry_.video.getDuration() || 0;
      const percent = total ? Math.floor(current * (100 / total)) : 0;
      st.setStyles(currentBar, {
        'width': st.percent(percent),
      });
      st.setStyles(scrubber, {
        'left': st.percent(percent),
      });
    };

    this.listenMultiple_(
        this.entry_.video.element,
        [VideoEvents.TIME_UPDATE, VideoEvents.LOAD],
        updateProgress.bind(this)
    );

    return progressBar;
  }

  createIcon_(name) {
    const doc = this.ampdoc_.win.document;
    const icon = doc.createElement('div');
    icon.classList.add('amp-media-custom-controls-icon');
    icon.classList.add('amp-media-custom-controls-icon-' + name);
    return icon;
  }

  changeIcon_(icon, name) {
    icon.className = '';
    icon.classList.add('amp-media-custom-controls-icon');
    icon.classList.add('amp-media-custom-controls-icon-' + name);
  }

  /**
   * Creates a button element from the button's name
   * @param {string} btn
   * @param {?Element|string} opt_loadingElement
   * @return {!Element}
   * @private
   */
  elementFromButton_(btn, opt_loadingElement = 'self') {
    const doc = this.ampdoc_.win.document;
    switch (btn) {
      case 'play':
        return this.createPlayPauseBtn_(opt_loadingElement);
      case 'time':
        return this.createProgressTime_();
      case 'spacer':
        return this.createSpacer_();
      case 'volume':
        return this.createVolumeControls_();
      case 'fullscreen':
        return this.createFullscreenBtn_();
      default:
        return doc.createElement('span');
    };
  }

  /**
   * Create the custom controls shim and insert it inside the video
   * @param {{
   *    darkSkin:(boolean|undefined),
   *    mainControls:(Array<string>|undefined),
   *    miniControls:(Array<string>|undefined),
   *    floating:(string|undefined),
   * }=} opt_options
   *      - darkSkin: whether to use dark or light theme
   *      - mainControls: list of controls to add to the main bar
   *      - miniControls: list of controls to add to the minimized overlay
   *      - floating: single control button to use as the main action
   * @private
   */
  createCustomControls_(opt_options) {
    // Set up options
    const darkSkin = opt_options.darkSkin || false;
    const mainControls = opt_options.mainControls
                      || ['time', 'spacer', 'volume', 'fullscreen'];
    const miniControls = opt_options.miniControls
                      || ['play', 'volume', 'fullscreen'];
    const floating = opt_options.floating || 'play';
    // Set up controls
    const doc = this.ampdoc_.win.document;
    this.controlContainer_ = doc.createElement('div');
    const controlClasses = this.controlContainer_.classList;
    controlClasses.add('amp-media-custom-controls');
    controlClasses.toggle('amp-media-custom-controls-light-skin', !darkSkin);
    // Controls background
    this.controlsBg_ = doc.createElement('div');
    this.controlsBg_.classList.add('amp-media-custom-controls-bg');
    // Control bar wrapper
    this.controlBarWrapper_ = doc.createElement('div');
    this.controlBarWrapper_.classList
        .add('amp-media-custom-controls-bar-wrapper');
    // Control bar container
    this.controlBarContainer_ = doc.createElement('div');
    this.controlBarContainer_.classList.add('amp-media-custom-controls-bar');
    // Mini-controls wrapper
    this.miniControlsWrapper_ = doc.createElement('div');
    this.miniControlsWrapper_.classList
        .add('amp-media-custom-controls-mini-wrapper');
    // Mini-controls container
    this.miniControlsContainer_ = doc.createElement('div');
    this.miniControlsContainer_.classList.add('amp-media-custom-controls-mini');
    // Floating controls container
    this.floatingContainer_ = doc.createElement('div');
    this.floatingContainer_.classList.add('amp-media-custom-controls-floating');


    // Shadow filter
    const shadowFilter = this.createIcon_('shadow');
    st.setStyles(shadowFilter, {
      'width': '0px',
      'height': '0px',
      'position': 'absolute',
    });

    // Show controls when mouse is over
    let oldCoords = '0-0';
    const showControlsIfNewPos = e => {
      if (e.type == 'mousemove'
      && e.clientX + '-' + e.clientY != oldCoords) {
        this.showControls();
        oldCoords = e.clientX + '-' + e.clientY;
      } else if (e.type != 'mousemove') {
        this.showControls();
      }
    };
    [this.entry_.video.element,
      this.floatingContainer_,
      this.controlContainer_,
      this.controlBarContainer_,
    ].forEach(element => {
      listen(element, 'mousemove', showControlsIfNewPos.bind(this));
    });

    // Hide controls when mouse is outside
    const hideControls = () => {
      if (this.controlsTimer_) {
        clearTimeout(this.controlsTimer_);
      }
      this.hideControls();
    };
    listen(this.controlContainer_, 'mouseleave', hideControls.bind(this));

    const toggleControls = e => {
      if (e.target != this.controlContainer_
          && e.target != this.miniControlsContainer_) {
        return;
      }
      e.stopPropagation();
      if (this.controlsTimer_) {
        clearTimeout(this.controlsTimer_);
      }
      if (this.controlsShown_) {
        this.hideControls(true);
      } else {
        this.showControls();
      }
    };

    // Toggle controls when video is clicked
    listen(this.controlContainer_, 'click', toggleControls.bind(this));

    // Add to the element
    this.vsync_.mutate(() => {
      // Add SVG shadow
      this.controlContainer_.appendChild(shadowFilter);

      // Add background
      this.controlContainer_.appendChild(this.controlsBg_);

      // Add main controls
      mainControls.forEach(btn => {
        this.controlBarContainer_.appendChild(
            this.elementFromButton_(btn)
        );
      });
      this.controlBarWrapper_.appendChild(this.controlBarContainer_);
      this.controlBarWrapper_.appendChild(this.createProgressBar_());
      this.controlContainer_.appendChild(this.controlBarWrapper_);

      // Add mini controls
      miniControls.forEach(btn => {
        this.miniControlsContainer_.appendChild(
            this.elementFromButton_(btn)
        );
      });
      this.miniControlsWrapper_.appendChild(this.miniControlsContainer_);
      this.miniControlsWrapper_.appendChild(this.createProgressBar_());
      this.controlContainer_.appendChild(this.miniControlsWrapper_);

      // Floating controls
      this.floatingContainer_.appendChild(
          this.elementFromButton_(floating, this.floatingContainer_)
      );
      this.controlContainer_.appendChild(this.floatingContainer_);

      // Add main buttons container
      this.entry_.video.element.appendChild(this.controlContainer_);
    });
  }

  /**
   * Enables controls if disabled
   */
  enableControls() {
    this.controlsDisabled_ = false;
    if (this.controlContainer_) {
      st.resetStyles(this.controlContainer_, ['pointer-events']);
    }
  }

  /**
   * Disables controls (showControls would no longer work)
   */
  disableControls() {
    this.controlsDisabled_ = true;
    if (this.controlContainer_) {
      st.setStyles(this.controlContainer_, {
        'pointer-events': 'none',
      });
    }
  }

  /**
   * Fades out the custom controls
   * @param {boolean} override hide controls even when video is not playing
   */
  hideControls(override = false) {
    this.vsync_.mutate(() => {
      if (!this.controlBarWrapper_
          || !this.floatingContainer_
          || !this.controlsBg_
          || (!this.entry_.isPlaying() && !override)
          || !this.controlsShown_) {
        return;
      }

      Animation.animate(dev().assertElement(this.miniControlsContainer_),
          tr.setStyles(dev().assertElement(this.miniControlsContainer_), {
            'opacity': tr.numeric(1, 0),
          })
      , 200);

      Animation.animate(dev().assertElement(this.controlBarWrapper_),
          tr.setStyles(dev().assertElement(this.controlBarWrapper_), {
            'opacity': tr.numeric(1, 0),
          })
      , 200);

      Animation.animate(dev().assertElement(this.controlsBg_),
          tr.setStyles(dev().assertElement(this.controlsBg_), {
            'opacity': tr.numeric(1, 0),
          })
      , 200);

      Animation.animate(dev().assertElement(this.floatingContainer_),
          tr.setStyles(dev().assertElement(this.floatingContainer_), {
            'opacity': tr.numeric(1, 0),
          })
      , 200).thenAlways(() => {
        const classes = this.controlContainer_.classList;
        classes.toggle('amp-media-custom-controls-hidden', true);
        this.controlsShown_ = false;
      });
    });
  }

  /**
   * Fades-in the custom controls
   */
  showControls() {
    this.vsync_.mutate(() => {
      if (!this.controlBarWrapper_
          || !this.floatingContainer_
          || !this.controlsBg_
          || this.controlsDisabled_) {
        return;
      }

      if (this.controlsTimer_) {
        clearTimeout(this.controlsTimer_);
      }
      this.controlsTimer_ = setTimeout(() => {
        this.hideControls();
      }, 3000);

      if (this.controlsShown_ || this.controlsShowing_) {
        return;
      }

      this.controlContainer_.classList.toggle(
          'amp-media-custom-controls-hidden', false
      );
      this.controlsShowing_ = true;

      if (this.minimal_) {
        Animation.animate(dev().assertElement(this.miniControlsContainer_),
            tr.setStyles(dev().assertElement(this.miniControlsContainer_), {
              'opacity': tr.numeric(0, 1),
            })
        , 200).thenAlways(() => {
          this.controlsShown_ = true;
          this.controlsShowing_ = false;
          this.controlsDisabled_ = false;
        });
      } else {
        Animation.animate(dev().assertElement(this.controlBarWrapper_),
            tr.setStyles(dev().assertElement(this.controlBarWrapper_), {
              'opacity': tr.numeric(0, 1),
            })
        , 200);

        Animation.animate(dev().assertElement(this.controlsBg_),
            tr.setStyles(dev().assertElement(this.controlsBg_), {
              'opacity': tr.numeric(0, 1),
            })
        , 200);

        Animation.animate(dev().assertElement(this.floatingContainer_),
            tr.setStyles(dev().assertElement(this.floatingContainer_), {
              'opacity': tr.numeric(0, 1),
            })
        , 200).thenAlways(() => {
          this.controlsShown_ = true;
          this.controlsShowing_ = false;
          this.controlsDisabled_ = false;
        });
      }
    });
  }

  /**
   * Switches between full controls (with control bar and floating main action)
   * and minimal controls (overlayed actions and a minimal progress bar).
   * Minimal controls are used by default for docked videos.
   * @param {boolean} enable enable/disable minimal controls
   */
  toggleMinimalControls(enable = true) {
    this.controlContainer_.classList.toggle(
        'amp-media-custom-controls-minimal', enable
    );
    this.minimal_ = enable;
  }

  /**
   * Listens for multiple events on an element
   * @param {!EventTarget} element
   * @param {string|Array<string>} eventTypes
   * @param {function(!Event)} listener
   * @param {Object=} opt_evtListenerOpts
   * @private
   */
  listenMultiple_(element, eventTypes, listener, opt_evtListenerOpts) {
    let eventTypesArray;
    if (Array.isArray(eventTypes)) {
      eventTypesArray = eventTypes;
    } else {
      eventTypesArray = eventTypes.split(' ');
    }
    eventTypesArray.forEach(eventType => {
      listen(
          element,
          eventType,
          listener,
          opt_evtListenerOpts
      );
    });
  }
}
