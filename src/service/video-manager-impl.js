/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
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

import {ActionTrust} from '../action-trust';
import {removeElement} from '../dom.js';
import {listen, listenOncePromise} from '../event-helper';
import {dev} from '../log';
import {getMode} from '../mode';
import {registerServiceBuilderForDoc, getServiceForDoc} from '../service';
import {setStyles} from '../style';
import {isFiniteNumber} from '../types';
import {mapRange} from '../utils/math';
import {VideoEvents, VideoAttributes} from '../video-interface';
import {
  viewerForDoc,
  viewportForDoc,
  vsyncFor,
  platformFor,
} from '../services';
import {
  installPositionObserverServiceForDoc,
  PositionObserverFidelity,
  PositionInViewportEntryDef,
} from './position-observer-impl';
import {
  scopedQuerySelector,
} from '../dom';
import * as st from '../style';

/**
 * @const {number} Percentage of the video that should be in viewport before it
 * is considered visible.
 */
const VISIBILITY_PERCENT = 75;

/**
 * @const {number} How much to scale the video by when minimized.
 */
const DOCK_SCALE = 0.6;
const DOCK_CLASS = 'i-amphtml-dockable-video-minimizing';
const DOCK_MARGIN = 20;

/**
 * Dragging constants
 */
const FRICTION_COEFF = 0.65;
const STOP_THRESHOLD = 10;

/**
 * Playing States
 *
 * Internal playing states used to distinguish between video playing on user's
 * command and videos playing automatically
 *
 * @constant {!Object<string, string>}
 */
export const PlayingStates = {
  /**
   * playing_manual
   *
   * When the video user manually interacted with the video and the video
   * is now playing
   *
   * @event playing_manual
   */
  PLAYING_MANUAL: 'playing_manual',

  /**
   * playing_auto
   *
   * When the video has autoplay and the user hasn't interacted with it yet
   *
   * @event playing_auto
   */
  PLAYING_AUTO: 'playing_auto',

  /**
   * paused
   *
   * When the video is paused.
   *
   * @event paused
   */
  PAUSED: 'paused',
};

/**
* Minimization Positions
*
* Internal states used to describe whether the video is inside the viewport
* or minimizing starting from the bottom or minimizing starting from the top
*
* @enum {string}
*/
export const MinimizePositions = {
  DEFAULT: 'default',
  INVIEW: 'inview',
  TOP: 'top',
  BOTTOM: 'bottom',
};


/**
 * VideoManager keeps track of all AMP video players that implement
 * the common Video API {@see ../video-interface.VideoInterface}.
 *
 * It is responsible for providing a unified user experience and analytics for
 * all videos within a document.
 */
export class VideoManager {

  /**
   * @param {!./ampdoc-impl.AmpDoc} ampdoc
   */
  constructor(ampdoc) {

    /** @private @const {!./ampdoc-impl.AmpDoc}  */
    this.ampdoc_ = ampdoc;

    /** @private {?Array<!VideoEntry>} */
    this.entries_ = null;

    /** @private {?VideoEntry} */
    this.curDocked_ = null;

    /** @private {boolean} */
    this.scrollListenerInstalled_ = false;

    /** @private {./position-observer-impl.AmpDocPositionObserver} */
    this.positionObserver_ = null;
  }

  /**
   * Registers a video component that implements the VideoInterface.
   * @param {!../video-interface.VideoInterface} video
   */
  register(video) {
    dev().assert(video);

    this.registerCommonActions_(video);

    if (!video.supportsPlatform()) {
      return;
    }

    this.entries_ = this.entries_ || [];
    const entry = new VideoEntry(this.ampdoc_, video, this);
    this.maybeInstallVisibilityObserver_(entry);
    this.maybeInstallPositionObserver_(entry);
    this.entries_.push(entry);
  }

  /**
   * Register common actions such as play, pause, etc... on the video element
   * so they can be called using AMP Actions.
   * For example: <button on="tap:myVideo.play">
   *
   * @param {!../video-interface.VideoInterface} video
   * @private
   */
  registerCommonActions_(video) {
    // TODO(choumx, #9699): HIGH for unmuted play, LOW for muted play.
    video.registerAction('play', video.play.bind(video, /* isAutoplay */ false),
        ActionTrust.MEDIUM);
    // TODO(choumx, #9699): LOW.
    video.registerAction('pause', video.pause.bind(video), ActionTrust.MEDIUM);
    video.registerAction('mute', video.mute.bind(video), ActionTrust.MEDIUM);
    // TODO(choumx, #9699): HIGH.
    video.registerAction('unmute', video.unmute.bind(video),
        ActionTrust.MEDIUM);
  }

  /**
   * Install the necessary listeners to be notified when a video becomes visible
   * in the viewport.
   *
   * Visibility of a video is defined by being in the viewport AND having
   * {@link VISIBILITY_PERCENT} of the video element visible.
   *
   * @param {VideoEntry} entry
   * @private
   */
  maybeInstallVisibilityObserver_(entry) {
    // TODO(aghassemi): Remove this later. For now, the visibility observer
    // only matters for autoplay videos so no point in monitoring arbitrary
    // videos yet.
    if (!entry.hasAutoplay) {
      return;
    }

    listen(entry.video.element, VideoEvents.VISIBILITY, () => {
      entry.updateVisibility();
    });

    listen(entry.video.element, VideoEvents.RELOAD, () => {
      entry.videoLoaded();
    });

    // TODO(aghassemi, #6425): Use IntersectionObserver
    if (!this.scrollListenerInstalled_) {
      const scrollListener = () => {
        for (let i = 0; i < this.entries_.length; i++) {
          this.entries_[i].updateVisibility();
        }
      };
      const viewport = viewportForDoc(this.ampdoc_);
      viewport.onScroll(scrollListener);
      viewport.onChanged(scrollListener);
      this.scrollListenerInstalled_ = true;
    }
  }

  /**
   * Install the necessary listeners to be notified when a video scrolls in the
   * viewport
   *
   * @param {VideoEntry} entry
   * @private
   */
  maybeInstallPositionObserver_(entry) {
    if (!entry.hasDocking) {
      return;
    }

    if (!this.positionObserver_) {
      installPositionObserverServiceForDoc(this.ampdoc_);
      this.positionObserver_ = getServiceForDoc(
          this.ampdoc_,
          'position-observer'
      );
    }


    this.positionObserver_.observe(
        entry.video.element,
        PositionObserverFidelity.HIGH,
        newPos => {
          entry.updateVisibility();
          entry.onDockableVideoPositionChanged(newPos);
        }
    );
  }

  /**
   * Returns the entry in the video manager corresponding to the video
   * provided
   *
   * @param {!../video-interface.VideoInterface} video
   * @return {VideoEntry} entry
   * @private
   */
  getEntryForVideo_(video) {
    for (let i = 0; i < this.entries_.length; i++) {
      if (this.entries_[i].video === video) {
        return this.entries_[i];
      }
    }
    dev().assert(false, 'video is not registered to this video manager');
    return null;
  }

  /**
   * Returns whether the video is paused or playing after the user interacted
   * with it or playing through autoplay
   *
   * @param {!../video-interface.VideoInterface} video
   * @return {!../video-interface.VideoInterface} PlayingStates
   */
  getPlayingState(video) {
    return this.getEntryForVideo_(video).getPlayingState();
  }

  /**
   * Returns whether the video was interacted with or not
   *
   * @param {!../video-interface.VideoInterface} video
   * @return {boolean}
   */
  userInteractedWithAutoPlay(video) {
    return this.getEntryForVideo_(video).userInteractedWithAutoPlay();
  }

  /**
   * Undocks all docked videos except the currently docked video
   */
  undockAllExceptCurrent() {
    for (let i = 0; i < this.entries_.length; i++) {
      if (this.entries_[i] != this.curDocked_ && this.entries_[i].hasDocking) {
        // undocks the video
        this.entries_[i].unDockVideo_();
        this.entries_[i].hasBeenInViewBefore = false;
      }
    }
  }

  /**
   * Declares that the provided entry is the current docked video
   * @param {VideoEntry} entry
   */
  registerDocked(entry) {
    this.curDocked_ = entry;
    this.undockAllExceptCurrent();
  }

  /**
   * Undocks the currently docked video
   */
  unregisterDocked() {
    this.curDocked_ = null;
    this.undockAllExceptCurrent();
  }

  /**
   * Returns whether there is currently a docked video or not
   * @returns {boolean}
   */
  noDockedVid() {
    return this.curDocked_ == null;
  }

  /**
   * Returns the current docked video if it exists
   * @returns {?VideoEntry}
   */
  curDockedVid() {
    return this.curDocked_;
  }

}

/**
 * VideoEntry represents an entry in the VideoManager's list.
 */
class VideoEntry {
  /**
   * @param {!./ampdoc-impl.AmpDoc} ampdoc
   * @param {!../video-interface.VideoInterface} video
   * @param {!VideoManager} vidManager
   */
  constructor(ampdoc, video, vidManager) {

    /** @private @const {!./ampdoc-impl.AmpDoc}  */
    this.ampdoc_ = ampdoc;

    /** @package @const {!../video-interface.VideoInterface} */
    this.video = video;

    /** @private @const {!VideoManager} */
    this.vidManager_ = vidManager;

    /** @private {?Element} */
    this.autoplayAnimation_ = null;

    /** @private {boolean} */
    this.loaded_ = false;

    /** @private {boolean} */
    this.isPlaying_ = false;

    /** @private {boolean} */
    this.isVisible_ = false;

    /** @private @const {!../service/vsync-impl.Vsync} */
    this.vsync_ = vsyncFor(ampdoc.win);

    /** @private @const {function(): !Promise<boolean>} */
    this.boundSupportsAutoplay_ = supportsAutoplay.bind(null, ampdoc.win,
        getMode(ampdoc.win).lite);

    const element = dev().assert(video.element);

    /** @private {boolean} */
    this.userInteractedWithAutoPlay_ = false;

    /** @private {boolean} */
    this.playCalledByAutoplay_ = false;

    /** @private {Object} */
    this.initialRect_ = null;

    /** @private {string} */
    this.minimizePosition_ = MinimizePositions.DEFAULT;

    /** @private {number} */
    this.visibleHeight_ = 0;

    /** @private {?Element} */
    this.internalElement_ = null;

    /** @private {string} */
    this.pageDir_ = 'ltr';

    /** @private {boolean} */
    this.hasBeenInViewBefore = false;

    /** @private {boolean} */
    this.dragListenerInstalled_ = false;

    /** @private {boolean} */
    this.isTouched_ = false;

    /** @private {boolean} */
    this.isDragging_ = false;

    /** @private {boolean} */
    this.dismissed = false;

    /** @private {Object} */
    this.dragCoordinates_ = {
      mouse: {x: 0, y: 0},
      displacement: {x: 0, y: 0},
      initial: {x: 0, y: 0},
      position: {x: 0, y: 0},
      previous: {x: 0, y: 0},
      velocity: {x: 0, y: 0},
    };

    this.hasDocking = element.hasAttribute(VideoAttributes.DOCK);

    this.hasAutoplay = element.hasAttribute(VideoAttributes.AUTOPLAY);

    listenOncePromise(element, VideoEvents.LOAD)
        .then(() => this.videoLoaded());

    listen(this.video.element, VideoEvents.PAUSE, this.videoPaused_.bind(this));

    listen(this.video.element, VideoEvents.PLAY, this.videoPlayed_.bind(this));

    // Currently we only register after video player is build.
    this.videoBuilt_();
  }

  /**
   * Called when the video element is built.
   * @private
   */
  videoBuilt_() {
    this.updateVisibility();
    if (this.hasAutoplay) {
      this.autoplayVideoBuilt_();
    }
    if (this.hasDocking) {
      this.dockableVideoBuilt_();
      // Determine the docking side based on the page's direction
      // TODO(@wassgha) Probably will be needed for more functionalities later
      // but for now, only needed for video docking
      const doc = this.ampdoc_.win.document;
      this.pageDir_ = doc.body.getAttribute('dir')
                     || doc.documentElement.getAttribute('dir')
                     || 'ltr';
    }
  }

  /**
   * Callback for when the video starts playing
   * @private
   */
  videoPlayed_() {
    this.isPlaying_ = true;
  }

  /**
  * Callback for when the video has been paused
   * @private
   */
  videoPaused_() {
    this.isPlaying_ = false;
  }

  /**
   * Called when the video is loaded and can play.
   */
  videoLoaded() {
    this.loaded_ = true;

    // Get the internal element (the actual video/iframe)
    this.internalElement_ = scopedQuerySelector(
        this.video.element,
        'video, iframe'
    );

    this.updateVisibility();
    if (this.isVisible_) {
      // Handles the case when the video becomes visible before loading
      this.loadedVideoVisibilityChanged_();
    }
  }

  /**
   * Called when visibility of a video changes.
   * @private
   */
  videoVisibilityChanged_() {
    if (this.loaded_) {
      this.loadedVideoVisibilityChanged_();
    }
  }

  /**
   * Only called when visibility of a loaded video changes.
   * @private
   */
  loadedVideoVisibilityChanged_() {
    if (this.hasAutoplay) {
      this.autoplayLoadedVideoVisibilityChanged_();
    }
  }

  /* Docking Behaviour */

  /**
   * Called when a dockable video is built.
   * @private
   */
  dockableVideoBuilt_() {
    this.vsync_.run({
      measure: () => {
        this.initialRect_ = this.video.element./*OK*/getBoundingClientRect();
      },
      mutate: () => {
        this.video.element.classList.add('i-amphtml-dockable-video');
      },
    });

    // Re-measure initial position when the window resizes / orientation changes
    const viewport = viewportForDoc(this.ampdoc_);
    // TODO(@wassgha) change to onResized (no need for this to fire when the
    // viewport is scrolled)
    viewport.onChanged(() => {
      this.vsync_.measure(() => {
        this.initialRect_ = this.video.element./*OK*/getBoundingClientRect();
        this.initializeDocking_();
      });
    });
    // TODO(@wassgha) Add video element wrapper here
  }


  /* Autoplay Behaviour */

  /**
   * Called when an autoplay video is built.
   * @private
   */
  autoplayVideoBuilt_() {

    // Hide controls until we know if autoplay is supported, otherwise hiding
    // and showing the controls quickly becomes a bad user experience for the
    // common case where autoplay is supported.
    if (this.video.isInteractive()) {
      this.video.hideControls();
    }

    this.boundSupportsAutoplay_().then(supportsAutoplay => {
      if (!supportsAutoplay && this.video.isInteractive()) {
        // Autoplay is not supported, show the controls so user can manually
        // initiate playback.
        this.video.showControls();
        return;
      }

      // Only muted videos are allowed to autoplay
      this.video.mute();

      if (this.video.isInteractive()) {
        this.autoplayInteractiveVideoBuilt_();
      }
    });
  }

  /**
   * Called by autoplayVideoBuilt_ when an interactive autoplay video is built.
   * It handles hiding controls, installing autoplay animation and handling
   * user interaction by unmuting and showing controls.
   * @private
   */
  autoplayInteractiveVideoBuilt_() {
    const toggleAnimation = playing => {
      this.vsync_.mutate(() => {
        animation.classList.toggle('amp-video-eq-play', playing);
      });
    };

    // Hide the controls.
    this.video.hideControls();

    // Create autoplay animation and the mask to detect user interaction.
    const animation = this.createAutoplayAnimation_();
    const mask = this.createAutoplayMask_();
    this.vsync_.mutate(() => {
      this.video.element.appendChild(animation);
      this.video.element.appendChild(mask);
    });

    // Listen to pause, play and user interaction events.
    const unlistenInteraction = listen(mask, 'click', onInteraction.bind(this));

    const unlistenPause = listen(this.video.element, VideoEvents.PAUSE,
        toggleAnimation.bind(this, /*playing*/ false));

    const unlistenPlay = listen(this.video.element, VideoEvents.PLAY,
        toggleAnimation.bind(this, /*playing*/ true));

    function onInteraction() {
      this.userInteractedWithAutoPlay_ = true;
      this.video.showControls();
      this.video.unmute();
      unlistenInteraction();
      unlistenPause();
      unlistenPlay();
      removeElement(animation);
      removeElement(mask);
    }
  }

  /**
   * Called when visibility of a loaded autoplay video changes.
   * @private
   */
  autoplayLoadedVideoVisibilityChanged_() {
    if (this.userInteractedWithAutoPlay_
       || !viewerForDoc(this.ampdoc_).isVisible()) {
      return;
    }

    this.boundSupportsAutoplay_().then(supportsAutoplay => {
      if (!supportsAutoplay) {
        return;
      }

      if (this.isVisible_) {
        this.video.play(/*autoplay*/ true);
        this.playCalledByAutoplay_ = true;
      } else {
        this.video.pause();
      }
    });
  }

  /**
   * Maps the visible height of the video (viewport height scrolled) to a value
   * in a specified number range
   * @param {number} min the lower bound of the range
   * @param {number} max the upper bound of the range
   * @param {boolean} reverse whether the mapping is proportional or inversely
   * proportional to the viewport height scrolled
   * @private
   */
  scrollMap_(min, max, reverse = false) {
    if (reverse) {
      return mapRange(this.visibleHeight_,
          this.initialRect_.height, 0,
          min, max);
    } else {
      return mapRange(this.visibleHeight_,
          0, this.initialRect_.height,
          min, max);
    }
  }

  /**
   * Called when the video's position in the viewport changed (at most once per
   * animation frame)
   * @param {PositionInViewportEntryDef} newPos
   */
  onDockableVideoPositionChanged(newPos) {
    this.updateDockableVideoPosition_(newPos);

    // Short-circuit the position change handler if the video isn't loaded yet
    // or is not playing manually while in-line (paused videos need to go
    // through if they are docked since this method handles the "undocking"
    // animation)
    if (!this.loaded_
      || !this.initialRect_
      || !this.internalElement_
      || (this.getPlayingState() != PlayingStates.PLAYING_MANUAL
          && !this.internalElement_.classList.contains(DOCK_CLASS)
      || (!this.vidManager_.noDockedVid()
          && this.vidManager_.curDockedVid() != this))
    ) {
      return;
    }

    // Initialize docking width/height
    if (this.minimizePosition_ != MinimizePositions.INVIEW
        && this.hasBeenInViewBefore) {
      this.vsync_.mutate(() => {
        this.vidManager_.registerDocked(this);
        this.initializeDocking_();
      });
    }

    // Temporary fix until PositionObserver somehow tracks objects outside of
    // the viewport (forces the style to be what we want in the final state)
    if (!newPos.positionRect
       && this.userInteractedWithAutoPlay()
       && this.minimizePosition_ != MinimizePositions.DEFAULT) {
      this.vsync_.mutate(() => {
        this.endDocking_();
      });
      return;
    }

    // During the docking transition we either perform the docking or undocking
    // scroll-bound animations
    //
    // Conditions for animating the video are:
    // 1. The video is out of view and it has been in-view at least once before
    const inView = this.minimizePosition_ == MinimizePositions.INVIEW;
    const outOfView = !inView
                      && this.minimizePosition_ != MinimizePositions.DEFAULT
                      && this.hasBeenInViewBefore;
    // 2. Is either manually playing or paused while docked (so that it is
    // undocked even when paused)
    const manPlaying = (this.getPlayingState() == PlayingStates.PLAYING_MANUAL);
    const paused = this.getPlayingState() == PlayingStates.PAUSED;
    const docked = this.internalElement_.classList.contains(DOCK_CLASS);

    if (outOfView && (manPlaying || (paused && docked))) {
      // We animate docking or undocking
      this.vsync_.mutate(() => {
        this.animateDocking_();
      });
    } else if (inView && this.internalElement_.classList.contains(DOCK_CLASS)) {
      // Here undocking animations are done so we restore the element
      // inline by clearing all styles and removing the position:fixed
      this.vsync_.mutate(() => {
        this.vidManager_.unregisterDocked();
        this.unDockVideo_();
      });
    }
  }

  /**
   * Updates the minimization position of the video (in viewport, above or
   * below viewport), also the height of the part of the video that is
   * currently in the viewport (between 0 and the initial video height).
   * @param {PositionInViewportEntryDef} newPos
   * @private
   */
  updateDockableVideoPosition_(newPos) {
    // TODO(@wassgha) Refactor when position observer starts reporting the
    // relative position
    if (newPos.positionRect) {

      const docViewTop = newPos.viewportRect.top;
      const docViewBottom = newPos.viewportRect.bottom;

      const elemTop = newPos.positionRect.top;
      const elemBottom = newPos.positionRect.bottom;

      // Calculate height currently displayed
      if (elemTop <= docViewTop) {
        this.visibleHeight_ = elemBottom - docViewTop;
        this.minimizePosition_ = MinimizePositions.TOP;
      } else if (elemBottom >= docViewBottom) {
        this.visibleHeight_ = docViewBottom - elemTop;
        this.minimizePosition_ = MinimizePositions.BOTTOM;
      } else {
        this.visibleHeight_ = elemBottom - elemTop;
        this.minimizePosition_ = MinimizePositions.INVIEW;
      }
    } else if (this.minimizePosition_ == MinimizePositions.INVIEW
                || this.minimizePosition_ == MinimizePositions.DEFAULT)
    {
      // Here we're just guessing, until #9208 is fixed
      // (until position observer returns more information when out of view )
      this.minimizePosition_ = MinimizePositions.TOP;
      this.visibleHeight_ = 0;
    } else {
      this.visibleHeight_ = 0;
    }
  }

  /**
   * Set the initial width and hight when the video is docking
   * so that we scale relative to the initial video's dimensions
   * @private
   */
  initializeDocking_() {
    st.setStyles(dev().assertElement(this.internalElement_), {
      'height': st.px(this.initialRect_.height),
      'width': st.px(this.initialRect_.width),
      'maxWidth': st.px(this.initialRect_.width),
    });
  }

  /**
   * Performs scroll-bound animations on the video as it is being scrolled
   * out of the viewport
   * @private
   */
  animateDocking_() {
    if (this.minimizePosition_ == MinimizePositions.INVIEW) {
      return;
    }

    // Calculate space on top and bottom of the video to see if it is possible
    // for the video to become hidden by scrolling to the top/bottom
    const viewport = viewportForDoc(this.ampdoc_);
    const spaceOnTop = this.video.element./*OK*/offsetTop;
    const spaceOnBottom = viewport.getScrollHeight()
                          - spaceOnTop
                          - this.video.element./*OK*/offsetHeight;

    // Don't minimize if video can never be hidden by scrolling to the bottom
    if (this.minimizePosition_ == MinimizePositions.TOP
        && spaceOnBottom < viewport.getHeight()) {
      return;
    }

    // Don't minimize if video can never be hidden by scrolling to the top
    if (this.minimizePosition_ == MinimizePositions.BOTTOM
        && spaceOnTop < viewport.getHeight()) {
      return;
    }

    // Minimize the video
    this.video.hideControls();
    this.internalElement_.classList.add(DOCK_CLASS);

    // Different behavior based on whether the page is written left to right
    // or right to left
    let offsetX;
    if (this.pageDir_ == 'ltr') {
      const offsetRight = viewport.getWidth()
                          - this.initialRect_.left
                          - this.initialRect_.width;
      const scaledWidth = DOCK_SCALE * this.initialRect_.width;
      offsetX = st.px(
        this.scrollMap_(
          viewport.getWidth() - this.initialRect_.width - offsetRight,
          viewport.getWidth() - scaledWidth -  DOCK_MARGIN,
          true
        )
      );
    } else {
      const offsetLeft = this.initialRect_.left;
      offsetX = st.px(this.scrollMap_(offsetLeft, DOCK_MARGIN, true));
    }
    // Different behavior based on whether the video got minimized
    // from the top or the bottom
    let offsetY;
    if (this.minimizePosition_ == MinimizePositions.TOP) {
      offsetY = st.px(this.scrollMap_(0, DOCK_MARGIN, true));
    } else {
      const scaledHeight = DOCK_SCALE * this.initialRect_.height;
      offsetY = st.px(
        this.scrollMap_(
          viewport.getHeight() - this.initialRect_.height,
          viewport.getHeight() - scaledHeight - DOCK_MARGIN,
          true
        )
      );
    }


    const transform = st.translate(offsetX, offsetY) + ' '
                      + st.scale(this.scrollMap_(DOCK_SCALE, 1));

    st.setStyles(dev().assertElement(this.internalElement_), {
      'transform': transform,
      'transformOrigin': 'top left',
      'bottom': 'auto',
      'top': '0px',
      'right': 'auto',
      'left': '0px',
    });
  }

  /**
   * Applies final transformations to the docked video to assert that the final
   * position and scale of the docked video are correct (in case user scrolls
   * too fast for startDocking_ to kick in)
   *
   * NOTE(@wassgha) : won't be needed if PositionObserver returned the element's
   * position when it goes out of view.
   * @private
   */
  endDocking_() {
    const viewport = viewportForDoc(this.ampdoc_);
    // Hide the controls.
    this.video.hideControls();
    this.internalElement_.classList.add(DOCK_CLASS);

    // Different behavior based on whether the page is written left to right
    // or right to left
    let offsetX;
    if (this.pageDir_ == 'ltr') {
      const scaledWidth = DOCK_SCALE * this.initialRect_.width;
      offsetX = st.px(viewport.getWidth() - scaledWidth - DOCK_MARGIN);
    } else {
      offsetX = st.px(DOCK_MARGIN);
    }

    // Different behavior based on whether the video got minimized
    // from the top or the bottom
    let offsetY;
    if (this.minimizePosition_ == MinimizePositions.TOP) {
      offsetY = st.px(DOCK_MARGIN);
    } else {
      const scaledHeight = DOCK_SCALE * this.initialRect_.height;
      offsetY = st.px(viewport.getHeight() - scaledHeight - DOCK_MARGIN);
    }

    const transform = st.translate(offsetX, offsetY) + ' '
                      + st.scale(DOCK_SCALE);

    st.setStyles(dev().assertElement(this.internalElement_), {
      'transform': transform,
      'transformOrigin': 'top left',
      'bottom': 'auto',
      'top': '0px',
      'right': 'auto',
      'left': '0px',
    });

    if (!this.dragListenerInstalled_) {
      const minimizedRect = this.internalElement_./*OK*/getBoundingClientRect();
      this.dragCoordinates_.initial.x = minimizedRect.left;
      this.dragCoordinates_.initial.y = minimizedRect.top;
      this.dragCoordinates_.position.x = minimizedRect.left;
      this.dragCoordinates_.position.y = minimizedRect.top;
      this.dragCoordinates_.previous.x = minimizedRect.left;
      this.dragCoordinates_.previous.y = minimizedRect.top;

      console.log(this.dragCoordinates_.position);
      // Desktop listeners
      listen(this.internalElement_, 'mousedown', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateDockCoordinates_(e, true);
      });
      listen(this.ampdoc_.win.document, 'mouseup', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
      });
      listen(this.ampdoc_.win.document, 'mousemove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateDockCoordinates_(e);
      });
      // Touch listeners
      listen(this.internalElement_, 'touchstart', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateDockCoordinates_(e, true);
      });
      listen(this.ampdoc_.win.document, 'touchend', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
      });
      listen(this.ampdoc_.win.document, 'touchmove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateDockCoordinates_(e);
      });
      this.vsync_.mutate(() => {
        this.handleDockingDrag_();
      });
      this.dragListenerInstalled_ = true;
    }

    // Guessing until Refactor
    if (this.minimizePosition_ == MinimizePositions.TOP) {
      this.minimizePosition_ = MinimizePositions.BOTTOM;
    } else {
      this.minimizePosition_ = MinimizePositions.TOP;
    }
  }

  handleDockingDrag_() {
    // Save some power and help preserve the environment
    if (!this.loaded_
      || !this.internalElement_
      || this.minimizePosition_ == MinimizePositions.DEFAULT
      || this.minimizePosition_ == MinimizePositions.INVIEW
      || this.visibleHeight_ != 0
      || !this.internalElement_.classList.contains(DOCK_CLASS)) {
        this.internalElement_.style.transition = '';
        return;
    }

    const minimizedRect = this.internalElement_./*OK*/getBoundingClientRect();
    const dragCoord = this.dragCoordinates_;
    const viewport = viewportForDoc(this.ampdoc_);
    if (this.isDragging_) {

      dragCoord.previous.x = dragCoord.position.x;
      dragCoord.previous.y = dragCoord.position.y;

      dragCoord.position.x = dragCoord.mouse.x - dragCoord.displacement.x;
      dragCoord.position.y = dragCoord.mouse.y - dragCoord.displacement.y;

      dragCoord.velocity.x = (dragCoord.position.x - dragCoord.previous.x);
      dragCoord.velocity.y = (dragCoord.position.y - dragCoord.previous.y);

      const vidCenterX = dragCoord.position.x + minimizedRect.width/2;
      const vidCenterY = dragCoord.position.y + minimizedRect.height/2;

      // console.log('vidCenterX  = ' + vidCenterX);
      // console.log('vidCenterY  = ' + vidCenterY);

      if (vidCenterX  > viewport.getWidth()
          || vidCenterX < 0
          || vidCenterY > viewport.getHeight()
          || vidCenterY < 0) {
            this.dismissed = true;
      }
    } else {

      dragCoord.position.x += dragCoord.velocity.x;
      dragCoord.position.y += dragCoord.velocity.y;

      dragCoord.velocity.x *= FRICTION_COEFF;
      dragCoord.velocity.y *= FRICTION_COEFF;

      if (this.dismissed) {
        this.vidManager_.unregisterDocked();
        this.unDockVideo_();
        this.dismissed = false;
        return;
      }
    }


    // Snap to corners
    if (Math.abs(dragCoord.velocity.x) <= STOP_THRESHOLD
        && Math.abs(dragCoord.velocity.y) <= STOP_THRESHOLD) {
      if ((dragCoord.position.x + minimizedRect.width/2) > viewport.getWidth()/2) {
        this.internalElement_.style.transition = 'all .2s';
        dragCoord.position.x = viewport.getWidth() - minimizedRect.width - DOCK_MARGIN;
      } else if (dragCoord.position.x < viewport.getWidth()/2) {
        this.internalElement_.style.transition = 'all .2s';
        dragCoord.position.x = DOCK_MARGIN;
      }
      if ((dragCoord.position.y + minimizedRect.height/2) > viewport.getHeight()/2) {
        this.internalElement_.style.transition = 'all .2s';
        dragCoord.position.y = viewport.getHeight() - minimizedRect.height - DOCK_MARGIN;
      } else if (dragCoord.position.y < viewport.getHeight()/2) {
        this.internalElement_.style.transition = 'all .2s';
        dragCoord.position.y = DOCK_MARGIN;
      }
    } else {
      this.internalElement_.style.transition = '';
    }


    // Update the video's position
    const translate = st.translate(
      st.px(dragCoord.position.x),
      st.px(dragCoord.position.y)
    );
    const scale = st.scale(DOCK_SCALE);
    st.setStyles(dev().assertElement(this.internalElement_), {
      'transform': translate + ' ' + scale,
      'transformOrigin': 'top left',
      'bottom': 'auto',
      'top': '0px',
      'right': 'auto',
      'left': '0px',
    });


    // Re-run on every animation frame
    this.vsync_.mutate(() => {
      this.handleDockingDrag_();
    });
  }

  updateDockCoordinates_(e, initial = false) {
    if (e.x) {
      this.dragCoordinates_.mouse.x = e.x;
      this.dragCoordinates_.mouse.y = e.y;
    } else if (e.touches) {
      this.dragCoordinates_.mouse.x = e.touches[0].clientX;
      this.dragCoordinates_.mouse.y = e.touches[0].clientY;
    }
    if (initial) {
      this.dragCoordinates_.displacement.x = Math.abs(
          this.dragCoordinates_.position.x - this.dragCoordinates_.mouse.x
      );
      this.dragCoordinates_.displacement.y = Math.abs(
          this.dragCoordinates_.position.y - this.dragCoordinates_.mouse.y
      );
    }
  }

  /**
   * Restores styling of the video to make it go back to its original inline
   * position.
   *
   * @private
   */
  unDockVideo_() {
    // Restore the video inline
    this.minimizePosition_ = MinimizePositions.DEFAULT;
    this.internalElement_.classList.remove(DOCK_CLASS);
    this.internalElement_.setAttribute('style', '');
    this.video.showControls();
    this.dragListenerInstalled_ = false;
    console.log('undocked video');
    // TODO(@wassgha) unlisten for all click/touch events for drag/drop
  }

  /**
   * Creates a pure CSS animated equalizer icon.
   * @private
   * @return {!Element}
   */
  createAutoplayAnimation_() {
    const doc = this.ampdoc_.win.document;
    const anim = doc.createElement('i-amphtml-video-eq');
    anim.classList.add('amp-video-eq');
    // Four columns for the equalizer.
    for (let i = 1; i <= 4; i++) {
      const column = doc.createElement('div');
      column.classList.add('amp-video-eq-col');
      // Two overlapping filler divs that animate at different rates creating
      // randomness illusion.
      for (let j = 1; j <= 2; j++) {
        const filler = doc.createElement('div');
        filler.classList.add(`amp-video-eq-${i}-${j}`);
        column.appendChild(filler);
      }
      anim.appendChild(column);
    }
    const platform = platformFor(this.ampdoc_.win);
    if (platform.isIos()) {
      // iOS can not pause hardware accelerated animations.
      anim.setAttribute('unpausable', '');
    }
    return anim;
  }

  /**
   * Creates a mask to overlay on top of an autoplay video to detect the first
   * user tap.
   * We have to do this since many players are iframe-based and we can not get
   * the click event from the iframe.
   * We also can not rely on hacks such as constantly checking doc.activeElement
   * to know if user has tapped on the iframe since they won't be a trusted
   * event that would allow us to unmuted the video as only trusted
   * user-initiated events can be used to interact with the video.
   * @private
   * @return {!Element}
   */
  createAutoplayMask_() {
    const doc = this.ampdoc_.win.document;
    const mask = doc.createElement('i-amphtml-video-mask');
    mask.classList.add('i-amphtml-fill-content');
    return mask;
  }

  /**
   * Called by all possible events that might change the visibility of the video
   * such as scrolling or {@link ../video-interface.VideoEvents#VISIBILITY}.
   * @package
   */
  updateVisibility() {
    const wasVisible = this.isVisible_;

    // Measure if video is now in viewport and what percentage of it is visible.
    const measure = () => {
      // Calculate what percentage of the video is in viewport.
      const change = this.video.element.getIntersectionChangeEntry();
      const visiblePercent = !isFiniteNumber(change.intersectionRatio) ? 0
          : change.intersectionRatio * 100;
      this.isVisible_ = visiblePercent >= VISIBILITY_PERCENT;
      this.hasBeenInViewBefore = this.hasBeenInViewBefore
                                 || visiblePercent == 100;
    };

    // Mutate if visibility changed from previous state
    const mutate = () => {
      if (this.isVisible_ != wasVisible) {
        this.videoVisibilityChanged_();
      }
    };

    this.vsync_.run({
      measure,
      mutate,
    });
  }


  /**
   * Returns whether the video is paused or playing after the user interacted
   * with it or playing through autoplay
   * @return {!../video-interface.VideoInterface} PlayingStates
   */
  getPlayingState() {
    if (!this.isPlaying_) {
      return PlayingStates.PAUSED;
    }

    if (this.isPlaying_
       && this.playCalledByAutoplay_
       && !this.userInteractedWithAutoPlay_) {
      return PlayingStates.PLAYING_AUTO;
    }

    return PlayingStates.PLAYING_MANUAL;
  }

  /**
   * Returns whether the video was interacted with or not
   * @return {boolean}
   */
  userInteractedWithAutoPlay() {
    return this.userInteractedWithAutoPlay_;
  }
}

/* @type {?Promise<boolean>} */
let supportsAutoplayCache_ = null;

/**
 * Detects whether autoplay is supported.
 * Note that even if platfrom supports autoplay, users or browsers can disable
 * autoplay to save data / battery. This function detects both platfrom support
 * and when autoplay is disabled.
 *
 * Service dependencies are taken explicitly for testability.
 *
 * @private visible for testing.
 * @param {!Window} win
 * @param {boolean} isLiteViewer
 * @return {!Promise<boolean>}
 */
export function supportsAutoplay(win, isLiteViewer) {

  // Use cached result if available.
  if (supportsAutoplayCache_) {
    return supportsAutoplayCache_;
  }

  // We do not support autoplay in amp-lite viewer regardless of platform.
  if (isLiteViewer) {
    return supportsAutoplayCache_ = Promise.resolve(false);
  }

  // To detect autoplay, we create a video element and call play on it, if
  // `paused` is true after `play()` call, autoplay is supported. Although
  // this is unintuitive, it works across browsers and is currently the lightest
  // way to detect autoplay without using a data source.
  const detectionElement = win.document.createElement('video');
  // NOTE(aghassemi): We need both attributes and properties due to Chrome and
  // Safari differences when dealing with non-attached elements.
  detectionElement.setAttribute('muted', '');
  detectionElement.setAttribute('playsinline', '');
  detectionElement.setAttribute('webkit-playsinline', '');
  detectionElement.muted = true;
  detectionElement.playsinline = true;
  detectionElement.webkitPlaysinline = true;
  detectionElement.setAttribute('height', '0');
  detectionElement.setAttribute('width', '0');
  setStyles(detectionElement, {
    position: 'fixed',
    top: '0',
    width: '0',
    height: '0',
    opacity: '0',
  });

  try {
    const playPromise = detectionElement.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(() => {
        // Suppress any errors, useless to report as they are expected.
      });
    }
  } catch (e) {
    // Suppress any errors, useless to report as they are expected.
  }

  const supportsAutoplay = !detectionElement.paused;
  return supportsAutoplayCache_ = Promise.resolve(supportsAutoplay);
}

/**
 * Clears the cache used by supportsAutoplay method.
 *
 * @private visible for testing.
 */
export function clearSupportsAutoplayCacheForTesting() {
  supportsAutoplayCache_ = null;
}

/**
 * @param {!Node|!./ampdoc-impl.AmpDoc} nodeOrDoc
 */
export function installVideoManagerForDoc(nodeOrDoc) {
  registerServiceBuilderForDoc(nodeOrDoc, 'video-manager', VideoManager);
};
