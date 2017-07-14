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
import {VideoSessionManager} from './video-session-manager';
import {removeElement} from '../dom.js';
import {listen, listenOncePromise} from '../event-helper';
import {dev} from '../log';
import {getMode} from '../mode';
import {registerServiceBuilderForDoc, getServiceForDoc} from '../service';
import {setStyles} from '../style';
import {isFiniteNumber} from '../types';
import {mapRange} from '../utils/math';
import {
  PlayingStates,
  VideoAnalyticsType,
  VideoAttributes,
  VideoEvents,
} from '../video-interface';
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
import {layoutRectLtwh, RelativePositions} from '../layout-rect';
import {Animation} from '../animation';
import * as st from '../style';
import * as tr from '../transition';

/**
 * @const {number} Percentage of the video that should be in viewport before it
 * is considered visible.
 */
const VISIBILITY_PERCENT = 75;

/**
 * @const {number} How much to scale the video by when minimized.
 */
const DOCK_SCALE = 0.6;

/**
 * @const {string} Docked video's class name as it is minimizing
 */
const DOCK_CLASS = 'i-amphtml-dockable-video-minimizing';

/**
 * @const {number} Margin to leave around a docked video
 */
const DOCK_MARGIN = 20;

/**
 * @const {number} Amount by which the velocity decreseases every frame
 */
const FRICTION_COEFF = 0.55;

/**
 * @const {number} Used to determine at which minmal velocity the element is
 * considered to have stopped moving
 */
const STOP_THRESHOLD = 3;

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
* Internal states used to describe whether the video is inline
* or minimizing in each of the corners
*
* @enum {string}
*/
export const MinimizePositions = {
  INLINE: 'inline',
  TOP_LEFT: 'top_left',
  BOTTOM_LEFT: 'bottom_left',
  TOP_RIGHT: 'top_right',
  BOTTOM_RIGHT: 'bottom_right',
};

/**
* Docking states
*
* Internal states used to describe whether the video is inline,
* currently docking or fully docked
*
* @enum {string}
*/
export const DockingStates = {
  INLINE: 'inline',
  DOCKING: 'docking',
  DOCKED: 'docked',
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

    /** @private {!./service/viewport-impl.Viewport} */
    this.viewport_ = viewportForDoc(this.ampdoc_);

    /** @private {?Array<!VideoEntry>} */
    this.entries_ = null;

    /** @private {boolean} */
    this.scrollListenerInstalled_ = false;

    /** @private {./position-observer-impl.AmpDocPositionObserver} */
    this.positionObserver_ = null;

    /** @private {?VideoEntry} */
    this.dockedVideo_ = null;
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
    const entry = new VideoEntry(this, video);
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
   * in the this.viewport_.
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
    if (!entry.hasAutoplay && !assertTrackingVideo(entry.video)) {
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
      this.viewport_.onScroll(scrollListener);
      this.viewport_.onChanged(scrollListener);
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
   * Checks whether there's no video already docked
   *
   * @param {VideoEntry} entry
   * @return {boolean}
   */
  canDock(entry) {
    return !this.dockedVideo_ || this.dockedVideo_ == entry;
  }

  /**
   * Registers the provided video as docked
   *
   * @param {VideoEntry} entry
   */
  registerDocked(entry) {
    this.dockedVideo_ = entry;
  }

  /**
   * Un-registers the currently docked video
   */
  unregisterDocked() {
    this.dockedVideo_ = null;
    for (let i = 0; i < this.entries_.length; i++) {
      this.entries_[i].hasBeenInViewBefore = false;
    }
  }
}

/**
 * VideoEntry represents an entry in the VideoManager's list.
 */
class VideoEntry {
  /**
   * @param {!VideoManager} manager
   * @param {!../video-interface.VideoInterface} video
   */
  constructor(manager, video) {

    /** @private @const {!VideoManager} */
    this.manager_ = manager;

    /** @private @const {!./ampdoc-impl.AmpDoc}  */
    this.ampdoc_ = manager.ampdoc_;

    /** @private {!./service/viewport-impl.Viewport} */
    this.viewport_ = viewportForDoc(this.ampdoc_);

    /** @package @const {!../video-interface.VideoInterface} */
    this.video = video;

    /** @private {?Element} */
    this.autoplayAnimation_ = null;

    /** @private {boolean} */
    this.loaded_ = false;

    /** @private {boolean} */
    this.isPlaying_ = false;

    /** @private {boolean} */
    this.isVisible_ = false;

    /** @private @const {!../service/vsync-impl.Vsync} */
    this.vsync_ = vsyncFor(this.ampdoc_.win);

    /** @private @const */
    this.actionSessionManager_ = new VideoSessionManager();

    this.actionSessionManager_.onSessionEnd(
        () => this.analyticsEvent_(VideoAnalyticsType.SESSION));

    /** @private @const */
    this.visibilitySessionManager_ = new VideoSessionManager();

    this.visibilitySessionManager_.onSessionEnd(
        () => this.analyticsEvent_(VideoAnalyticsType.SESSION_VISIBLE));

    /** @private @const {function(): !Promise<boolean>} */
    this.boundSupportsAutoplay_ = supportsAutoplay.bind(null, this.ampdoc_.win,
        getMode(this.ampdoc_.win).lite);

    const element = dev().assert(video.element);

    /** @private {boolean} */
    this.userInteractedWithAutoPlay_ = false;

    /** @private */
    this.playCalledByAutoplay_ = false;

    /** @private */
    this.pauseCalledByAutoplay_ = false;

    /** @private {?ClientRect} */
    this.initialRect_ = null;

    /** @private {string} */
    this.minimizePosition_ = MinimizePositions.INLINE;

    /** @private {string} */
    this.dockingState_ = DockingStates.INLINE;

    /** @private {number} */
    this.visibleHeight_ = 0;

    /** @private {?Element} */
    this.internalElement_ = null;

    /** @private */
    this.muted_ = false;
    /** @private {?Element} */
    this.draggingMask_ = null;

    /** @private {string} */
    this.pageDir_ = 'ltr';

    /** @private {?PositionInViewportEntryDef} */
    this.lastPosition_ = null;

    /** @private {boolean} */
    this.dragListenerInstalled_ = false;

    /** @private {boolean} */
    this.isTouched_ = false;

    /** @private {boolean} */
    this.isDragging_ = false;

    /** @private {boolean} */
    this.isSnapping_ = false;

    /** @private {boolean} */
    this.isDismissed_ = false;

    /** @private {Object} */
    this.dragCoordinates_ = {
      mouse: {x: 0, y: 0},
      displacement: {x: 0, y: 0},
      initial: {x: 0, y: 0},
      position: {x: 0, y: 0},
      previous: {x: 0, y: 0},
      velocity: {x: 0, y: 0},
    };

    this.hasBeenInViewBefore = false;

    this.hasDocking = element.hasAttribute(VideoAttributes.DOCK);

    this.hasAutoplay = element.hasAttribute(VideoAttributes.AUTOPLAY);

    listenOncePromise(element, VideoEvents.LOAD)
        .then(() => this.videoLoaded());


    listen(element, VideoEvents.PAUSE, () => this.videoPaused_());
    listen(element, VideoEvents.PLAYING, () => this.videoPlayed_());
    listen(element, VideoEvents.ENDED, () => this.videoEnded_());
    listen(element, VideoEvents.MUTED, () => this.muted_ = true);
    listen(element, VideoEvents.UNMUTED, () => this.muted_ = false);

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
      // Determine the page's direction to help decide which side to dock on
      // TODO(@wassgha) Probably will be needed for more functionality later
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
    this.actionSessionManager_.beginSession();
    if (this.isVisible_) {
      this.visibilitySessionManager_.beginSession();
    }
    this.analyticsEvent_(VideoAnalyticsType.PLAY);
  }

  /**
   * Callback for when the video has been paused
   * @private
   */
  videoPaused_() {
    const trackingVideo = assertTrackingVideo(this.video);
    if (trackingVideo &&
        trackingVideo.getCurrentTime() !== trackingVideo.getDuration()) {
      this.analyticsEvent_(VideoAnalyticsType.PAUSE);
    }
    this.isPlaying_ = false;

    // Prevent double-trigger of session if video is autoplay and the video
    // is paused by a the user scrolling the video out of view.
    if (!this.pauseCalledByAutoplay_) {
      this.actionSessionManager_.endSession();
    } else {
      // reset the flag
      this.pauseCalledByAutoplay_ = false;
    }
  }

  /**
   * Callback for when the video ends
   * @private
   */
  videoEnded_() {
    this.isPlaying_ = false;
    this.analyticsEvent_(VideoAnalyticsType.ENDED);
    this.actionSessionManager_.endSession();
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
    if (!viewerForDoc(this.ampdoc_).isVisible()) {
      return;
    }

    this.boundSupportsAutoplay_().then(supportsAutoplay => {
      const canAutoplay = this.hasAutoplay && !this.userInteractedWithAutoPlay_;

      if (canAutoplay && supportsAutoplay) {
        this.autoplayLoadedVideoVisibilityChanged_();
      } else {
        this.nonAutoplayLoadedVideoVisibilityChanged_();
      }
    });
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
    this.viewport_.onResize(() => {
      this.vsync_.run({
        measure: () => {
          this.initialRect_ = this.video.element./*OK*/getBoundingClientRect();
        },
        mutate: () => {
          this.dockingState_ = DockingStates.INLINE;
          if (this.lastPosition_) {
            this.onDockableVideoPositionChanged(this.lastPosition_);
          }
        },
      });
    });
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

    const unlistenPlaying = listen(this.video.element, VideoEvents.PLAYING,
        toggleAnimation.bind(this, /*playing*/ true));

    function onInteraction() {
      this.userInteractedWithAutoPlay_ = true;
      this.video.showControls();
      this.video.unmute();
      unlistenInteraction();
      unlistenPause();
      unlistenPlaying();
      removeElement(animation);
      removeElement(mask);
    }
  }

  /**
   * Called when visibility of a loaded autoplay video changes.
   * @private
   */
  autoplayLoadedVideoVisibilityChanged_() {
    if (this.isVisible_) {
      this.visibilitySessionManager_.beginSession();
      this.video.play(/*autoplay*/ true);
      this.playCalledByAutoplay_ = true;
    } else {
      if (this.isPlaying_) {
        this.visibilitySessionManager_.endSession();
      }
      this.video.pause();
      this.pauseCalledByAutoplay_ = true;
    }
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
   * Called when visibility of a loaded non-autoplay video changes.
   * @private
   */
  nonAutoplayLoadedVideoVisibilityChanged_() {
    if (this.isVisible_) {
      this.visibilitySessionManager_.beginSession();
    } else if (this.isPlaying_) {
      this.visibilitySessionManager_.endSession();
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
              && !this.internalElement_.classList.contains(DOCK_CLASS))
    ) {
      return;
    }

    // During the docking transition we either perform the docking or undocking
    // scroll-bound animations
    //
    // Conditions for animating the video are:
    // 1. The video is out of view and it has been in-view at least once before
    const outOfView = (this.minimizePosition_ != MinimizePositions.INLINE)
                      && this.hasBeenInViewBefore;
    // 2. Is either manually playing or paused while docked (so that it is
    // undocked even when paused)
    const manPlaying = this.getPlayingState() == PlayingStates.PLAYING_MANUAL;
    const paused = this.getPlayingState() == PlayingStates.PAUSED;
    const docked = this.internalElement_.classList.contains(DOCK_CLASS);

    if (outOfView && (manPlaying || (paused && docked))) {
      // On the first time, we initialize the docking animation
      if (this.dockingState_ == DockingStates.INLINE
          && this.manager_.canDock(this)) {
        this.initializeDocking_();
      }
      // Then we animate docking or undocking
      if (this.dockingState_ != DockingStates.INLINE) {
        this.animateDocking_();
      }
    } else if (this.internalElement_.classList.contains(DOCK_CLASS)) {
      // Here undocking animations are done so we restore the element
      // inline by clearing all styles and removing the position:fixed
      this.finishDocking_();
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
    const isLtr = this.pageDir_ == 'ltr';
    const isBottom = newPos.relativePos == RelativePositions.BOTTOM;
    const isTop = newPos.relativePos == RelativePositions.TOP;
    const isInside = newPos.relativePos == RelativePositions.INSIDE;

    // Record last position in case we need to redraw (ex. on resize);
    this.lastPosition_ = newPos;

    // If the video is out of view, newPos.positionRect will be null so we can
    // fake the position to be right above or below the viewport based on the
    // relativePos field
    if (!newPos.positionRect) {
      newPos.positionRect = isBottom ?
        // A fake rectangle with same width/height as the video, except it's
        // position right below the viewport
        layoutRectLtwh(
            this.initialRect_.left,
            this.viewport_.getHeight(),
            this.initialRect_.width,
            this.initialRect_.height
        ) :
        // A fake rectangle with same width/height as the video, except it's
        // position right above the viewport
        layoutRectLtwh(
            this.initialRect_.left,
            -this.initialRect_.height,
            this.initialRect_.width,
            this.initialRect_.height
        );
    }

    const docViewTop = newPos.viewportRect.top;
    const docViewBottom = newPos.viewportRect.bottom;
    const elemTop = newPos.positionRect.top;
    const elemBottom = newPos.positionRect.bottom;

    // Calculate height currently displayed
    if (elemTop <= docViewTop) {
      this.visibleHeight_ = elemBottom - docViewTop;
    } else if (elemBottom >= docViewBottom) {
      this.visibleHeight_ = docViewBottom - elemTop;
    } else {
      this.visibleHeight_ = elemBottom - elemTop;
    }

    // Calculate whether the video has been in view at least once
    this.hasBeenInViewBefore = this.hasBeenInViewBefore ||
                               this.visibleHeight_ == this.initialRect_.height;

    // Calculate space on top and bottom of the video to see if it is possible
    // for the video to become hidden by scrolling to the top/bottom
    const spaceOnTop = this.video.element./*OK*/offsetTop;
    const spaceOnBottom = this.viewport_.getScrollHeight()
                         - spaceOnTop
                         - this.video.element./*OK*/offsetHeight;
    // Don't minimize if video can never be hidden by scrolling to top/bottom
    // or if it would always be minimized (its height is > the viewport's)
    if ((isBottom && spaceOnTop < this.viewport_.getHeight())
        || (isTop && spaceOnBottom < this.viewport_.getHeight())
        || this.video.element./*OK*/offsetHeight > this.viewport_.getHeight()) {
      this.minimizePosition_ = MinimizePositions.INLINE;
      return;
    }

    // Calculate where the video should be docked if it hasn't been dragged
    if (this.minimizePosition_ == MinimizePositions.INLINE && !isInside) {
      if (isTop) {
        this.minimizePosition_ = isLtr ? MinimizePositions.TOP_RIGHT
                                       : MinimizePositions.TOP_LEFT;
      } else if (isBottom) {
        this.minimizePosition_ = isLtr ? MinimizePositions.BOTTOM_RIGHT
                                       : MinimizePositions.BOTTOM_LEFT;
      }
    } else if (isInside) {
      this.minimizePosition_ = MinimizePositions.INLINE;
    } else {
      // The inline video is outside but the minimizePosition has been set, this
      // means the position was manually changed by drag/drop, keep it as is.
    }
  }

  /**
   * Set the initial width and hight when the video is docking
   * so that we scale relative to the initial video's dimensions
   * @private
   */
  initializeDocking_() {
    this.internalElement_.classList.add(DOCK_CLASS);
    this.video.hideControls();
    st.setStyles(dev().assertElement(this.internalElement_), {
      'height': st.px(this.initialRect_.height),
      'width': st.px(this.initialRect_.width),
      'maxWidth': st.px(this.initialRect_.width),
    });
    this.dockingState_ = DockingStates.DOCKING;
    this.manager_.registerDocked(this);
  }

  /**
   * Performs scroll-bound animations on the video as it is being scrolled
   * out of the viewport
   * @private
   */
  animateDocking_() {
    // Calculate offsetXLeft
    const offsetXLeft = this.calcDockOffsetXLeft();
    // Calculate offsetXRight
    const offsetXRight = this.calcDockOffsetXRight();
    // Calculate offsetYTop
    const offsetYTop = this.calcDockOffsetYTop();
    // Calculate offsetYBottom
    const offsetYBottom = this.calcDockOffsetYBottom();

    // Calculate translate
    let translate;
    switch (this.minimizePosition_) {
      case MinimizePositions.TOP_LEFT:
        translate = st.translate(offsetXLeft, offsetYTop);
        break;
      case MinimizePositions.TOP_RIGHT:
        translate = st.translate(offsetXRight, offsetYTop);
        break;
      case MinimizePositions.BOTTOM_LEFT:
        translate = st.translate(offsetXLeft, offsetYBottom);
        break;
      case MinimizePositions.BOTTOM_RIGHT:
        translate = st.translate(offsetXRight, offsetYBottom);
        break;
      default:
    }

    const scale = st.scale(this.scrollMap_(DOCK_SCALE, 1));
    const transform = translate + ' ' + scale;

    st.setStyles(dev().assertElement(this.internalElement_), {
      'transform': transform,
      'transformOrigin': 'top left',
      'bottom': 'auto',
      'top': '0px',
      'right': 'auto',
      'left': '0px',
    });

    // Update docking state
    if (this.scrollMap_(DOCK_SCALE, 1) == DOCK_SCALE) {
      this.dockingState_ = DockingStates.DOCKED;
      this.initializeDragging_();
      this.drag_();
    } else {
      this.finishDragging_();
      this.dockingState_ = DockingStates.DOCKING;
    }
  }

  /**
   * Restores styling of the video to make it go back to its original inline
   * position.
   *
   * @private
   */
  finishDocking_() {
    // Restore the video inline
    this.internalElement_.classList.remove(DOCK_CLASS);
    this.internalElement_.setAttribute('style', '');
    this.dockingState_ = DockingStates.INLINE;
    this.video.showControls();
    this.manager_.unregisterDocked();
    this.dragListenerInstalled_ = false;
  }

  initializeDragging_() {
    if (this.dragListenerInstalled_) {
      return;
    }
    const minimizedRect = this.internalElement_./*OK*/getBoundingClientRect();
    this.dragCoordinates_.initial.x = minimizedRect.left;
    this.dragCoordinates_.initial.y = minimizedRect.top;
    this.dragCoordinates_.position.x = minimizedRect.left;
    this.dragCoordinates_.position.y = minimizedRect.top;
    this.dragCoordinates_.previous.x = minimizedRect.left;
    this.dragCoordinates_.previous.y = minimizedRect.top;

    this.draggingMask_ = this.createDraggingMask_();

    // Desktop listeners
    listen(this.draggingMask_, 'mousedown', e => {
      e.preventDefault();
      this.isTouched_ = true;
      this.isDragging_ = false;
      this.mouse_(e, true);
    });
    listen(this.ampdoc_.win.document, 'mouseup', () => {
      this.isTouched_ = false;
      this.isDragging_ = false;
    });
    listen(this.ampdoc_.win.document, 'mousemove', e => {
      this.isDragging_ = this.isTouched_;
      if (this.isDragging_) {
        e.preventDefault();
      }
      this.mouse_(e);
    });
    // Touch listeners
    listen(this.draggingMask_, 'touchstart', e => {
      e.preventDefault();
      this.isTouched_ = true;
      this.isDragging_ = false;
      this.mouse_(e, true);
    });
    listen(this.ampdoc_.win.document, 'touchend', () => {
      this.isTouched_ = false;
      this.isDragging_ = false;
    });
    listen(this.ampdoc_.win.document, 'touchmove', e => {
      this.isDragging_ = this.isTouched_;
      if (this.isDragging_) {
        e.preventDefault();
      }
      this.mouse_(e);
    });
    this.dragListenerInstalled_ = true;
  }

  /**
   * Handles the dragging, dropping and snapping to corners.
   * Ran once every animation frame
   * @private
   */
  drag_() {
    // Stop the loop if the video is no longer in a draggable state
    if (!this.loaded_
      || !this.internalElement_
      || this.minimizePosition_ == MinimizePositions.DEFAULT
      || this.minimizePosition_ == MinimizePositions.INVIEW
      || this.visibleHeight_ != 0
      || !this.internalElement_.classList.contains(DOCK_CLASS)
      || this.dockingState_ != DockingStates.DOCKED) {
      return;
    }

    const minimizedRect = this.internalElement_./*OK*/getBoundingClientRect();
    const dragCoord = this.dragCoordinates_;
    if (this.isDragging_) {
      dragCoord.previous.x = dragCoord.position.x;
      dragCoord.previous.y = dragCoord.position.y;

      dragCoord.position.x = dragCoord.mouse.x - dragCoord.displacement.x;
      dragCoord.position.y = dragCoord.mouse.y - dragCoord.displacement.y;

      dragCoord.velocity.x = (dragCoord.position.x - dragCoord.previous.x);
      dragCoord.velocity.y = (dragCoord.position.y - dragCoord.previous.y);

      const vidCenterX = dragCoord.position.x + minimizedRect.width / 2;
      const vidCenterY = dragCoord.position.y + minimizedRect.height / 2;

      if (vidCenterX > this.viewport_.getWidth()
          || vidCenterX < 0
          || vidCenterY > this.viewport_.getHeight()
          || vidCenterY < 0) {
        this.isDismissed_ = true;
      }
    } else {
      dragCoord.position.x += dragCoord.velocity.x;
      dragCoord.position.y += dragCoord.velocity.y;

      dragCoord.velocity.x *= FRICTION_COEFF;
      dragCoord.velocity.y *= FRICTION_COEFF;

      if (this.isDismissed_) {
        this.video.pause();
        this.finishDocking_();
        this.isDismissed_ = false;
        return;
      }
    }

    // Snap to corners
    if (!this.isDragging_ && !this.isSnapping_
        && Math.abs(dragCoord.velocity.x) <= STOP_THRESHOLD
        && Math.abs(dragCoord.velocity.y) <= STOP_THRESHOLD) {
      // X/Y Coordinates for each corner
      const top = DOCK_MARGIN;
      const left = DOCK_MARGIN;
      const right = this.viewport_.getWidth()
                    - minimizedRect.width
                    - DOCK_MARGIN;
      const bottom = this.viewport_.getHeight()
                     - minimizedRect.height
                     - DOCK_MARGIN;
      // Determine corner and update this.minimizePosition_
      this.calcSnapCorner_(minimizedRect);
      // Set coordinates based on corner
      let newPosX = dragCoord.position.x, newPosY = dragCoord.position.y;
      switch (this.minimizePosition_) {
        case MinimizePositions.BOTTOM_RIGHT:
          newPosX = right;
          newPosY = bottom;
          break;
        case MinimizePositions.TOP_RIGHT:
          newPosX = right;
          newPosY = top;
          break;
        case MinimizePositions.BOTTOM_LEFT:
          newPosX = left;
          newPosY = bottom;
          break;
        case MinimizePositions.TOP_LEFT:
          newPosX = left;
          newPosY = top;
          break;
      }
      // Animate the snap transition
      if (dragCoord.position.x != newPosX || dragCoord.position.y != newPosY) {
        this.isSnapping_ = true;
        // Snap to the calculated corner
        this.animateSnap_(this.draggingMask_, newPosX, newPosY);
        this.animateSnap_(this.internalElement_, newPosX, newPosY);
      }
    }

    // Update the video's position
    if (!this.isSnapping_) {
      this.dragMove_(this.draggingMask_);
      this.dragMove_(this.internalElement_);
    }

    // Re-run on every animation frame
    this.vsync_.mutate(() => {
      this.drag_();
    });
  }

  /**
   * Removes the draggable mask and ends dragging
   * @private
   */
  finishDragging_() {
    this.removeDraggingMask_();
  }

  /**
   * Reads mouse coordinate and saves them to an internal variable
   * @param {Event} e
   * @param {boolean} updateDisplacement
   * @private
   */
  mouse_(e, updateDisplacement = false) {
    if (e.x) {
      this.dragCoordinates_.mouse.x = e.x;
      this.dragCoordinates_.mouse.y = e.y;
    } else if (e.touches) {
      this.dragCoordinates_.mouse.x = e.touches[0].clientX;
      this.dragCoordinates_.mouse.y = e.touches[0].clientY;
    }
    if (updateDisplacement) {
      this.dragCoordinates_.displacement.x = Math.abs(
          this.dragCoordinates_.position.x - this.dragCoordinates_.mouse.x
      );
      this.dragCoordinates_.displacement.y = Math.abs(
          this.dragCoordinates_.position.y - this.dragCoordinates_.mouse.y
      );
    }
  }

  /**
   * Calculates which corner to snap to based on the element's position
   * @param {?ClientRect} minimizedRect
   * @private
   */
  calcSnapCorner_(minimizedRect) {
    const viewportCenterX = this.viewport_.getWidth() / 2;
    const viewportCenterY = this.viewport_.getHeight() / 2;
    const centerX = this.dragCoordinates_.position.x + minimizedRect.width / 2;
    const centerY = this.dragCoordinates_.position.y + minimizedRect.height / 2;
    if (centerX >= viewportCenterX) {
      if (centerY >= viewportCenterY) {
        this.minimizePosition_ = MinimizePositions.BOTTOM_RIGHT;
      } else if (centerY < viewportCenterY) {
        this.minimizePosition_ = MinimizePositions.TOP_RIGHT;
      }
    } else if (centerX < viewportCenterX) {
      if (centerY >= viewportCenterY) {
        this.minimizePosition_ = MinimizePositions.BOTTOM_LEFT;
      } else if (centerY < viewportCenterY) {
        this.minimizePosition_ = MinimizePositions.TOP_LEFT;
      }
    }
  }

  /**
   * Calculates the x-axis offset when the video is docked to the left
   * @return {string}
   */
  calcDockOffsetXLeft() {
    return st.px(this.scrollMap_(this.initialRect_.left, DOCK_MARGIN, true));
  }

  /**
   * Calculates the x-axis offset when the video is docked to the right
   * @return {string}
   */
  calcDockOffsetXRight() {
    const initialRight = this.viewport_.getWidth()
                          - this.initialRect_.left
                          - this.initialRect_.width;
    const scaledWidth = DOCK_SCALE * this.initialRect_.width;
    return st.px(
        this.scrollMap_(
            this.viewport_.getWidth() - this.initialRect_.width - initialRight,
            this.viewport_.getWidth() - scaledWidth - DOCK_MARGIN,
            true
        )
    );
  }

  /**
   * Calculates the y-axis offset when the video is docked to the top
   * @return {string}
   */
  calcDockOffsetYTop() {
    const inlineRect = this.video.element./*OK*/getBoundingClientRect();
    const inlineTop = inlineRect.top < 0 ? 0 : inlineRect.top;
    return st.px(this.scrollMap_(inlineTop, DOCK_MARGIN, true));
  }

  /**
   * Calculates the y-axis offset when the video is docked to the bottom
   * @return {string}
   */
  calcDockOffsetYBottom() {
    const inlineRect = this.video.element./*OK*/getBoundingClientRect();
    const maxTop = this.viewport_.getHeight() - this.initialRect_.height;
    const inlineTop = inlineRect.top > maxTop ? maxTop : inlineRect.top;
    const scaledHeight = DOCK_SCALE * this.initialRect_.height;
    return st.px(
        this.scrollMap_(
            inlineTop,
            this.viewport_.getHeight() - scaledHeight - DOCK_MARGIN,
            true
        )
    );
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
   * Update's the elements coordinates to one of the set corners with a timeDef
   * animation
   * @private
   * @param {?Element} element
   */
  animateSnap_(element, newPosX, newPosY) {
    const anim = new Animation(element);
    anim.add(0, tr.setStyles(dev().assertElement(element), {
      'transform': tr.concat([
        tr.translate(
            tr.px(tr.numeric(this.dragCoordinates_.position.x, newPosX)),
            tr.px(tr.numeric(this.dragCoordinates_.position.y, newPosY))
        ),
        tr.scale(tr.numeric(DOCK_SCALE, DOCK_SCALE)),
      ]),
    }), 1);
    anim.start(200).thenAlways(() => {
      // Update the positions
      this.dragCoordinates_.position.x = newPosX;
      this.dragCoordinates_.position.y = newPosY;
      this.isSnapping_ = false;
    });
  }

  /**
   * Update's the elements coordinates according to the draggable's
   * set coordinates
   * @private
   * @param {?Element} element
   */
  dragMove_(element) {
    const translate = st.translate(
        st.px(this.dragCoordinates_.position.x),
        st.px(this.dragCoordinates_.position.y)
    );
    const scale = st.scale(DOCK_SCALE);
    st.setStyles(dev().assertElement(element), {
      'transform': translate + ' ' + scale,
      'transformOrigin': 'top left',
      'bottom': 'auto',
      'top': '0px',
      'right': 'auto',
      'left': '0px',
    });
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
   * Creates a mask to overlay on top of a minimized video to capture drag
   * and drop events on iframe-based players
   * @private
   * @return {!Element}
   */
  createDraggingMask_() {
    const doc = this.ampdoc_.win.document;
    const mask = doc.createElement('i-amphtml-dragging-mask');
    st.setStyles(dev().assertElement(mask), {
      'top': st.getStyle(this.internalElement_, 'top'),
      'left': st.getStyle(this.internalElement_, 'left'),
      'bottom': st.getStyle(this.internalElement_, 'bottom'),
      'right': st.getStyle(this.internalElement_, 'right'),
      'transform': st.getStyle(this.internalElement_, 'transform'),
      'transformOrigin': st.getStyle(this.internalElement_, 'transform'),
      'borderRadius': st.getStyle(this.internalElement_, 'borderRadius'),
      'width': st.getStyle(this.internalElement_, 'width'),
      'height': st.getStyle(this.internalElement_, 'height'),
      'position': 'fixed',
      'z-index': '3',
      'background': 'transparent',
    });
    this.video.element.appendChild(mask);
    return mask;
  }


  /**
   * Removes the draggable mask so that the video can be interacted with
   * again when inline
   * @private
   */
  removeDraggingMask_() {
    if (this.draggingMask_) {
      removeElement(this.draggingMask_);
      this.draggingMask_ = null;
    }
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
      // Calculate what percentage of the video is in this.viewport_.
      const change = this.video.element.getIntersectionChangeEntry();
      const visiblePercent = !isFiniteNumber(change.intersectionRatio) ? 0
          : change.intersectionRatio * 100;
      this.isVisible_ = visiblePercent >= VISIBILITY_PERCENT;
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

  /**
   * @param {string} eventType
   * @param {!Object<string, string>=} opt_vars A map of vars and their values.
   * @private
   */
  analyticsEvent_(eventType, opt_vars) {
    const trackingVideo = assertTrackingVideo(this.video);
    if (trackingVideo) {
      const detailsPromise = opt_vars ? Promise.resolve(opt_vars) :
          this.getAnalyticsDetails_(trackingVideo);

      detailsPromise.then(details => {
        trackingVideo.element.dispatchCustomEvent(
            VideoEvents.ANALYTICS, {type: eventType, details});
      });
    }
  }

  /**
   * Collects a snapshot of the current video state for video analytics
   * @param {!../video-interface.VideoInterfaceWithAnalytics} video
   * @return {!Promise<!../video-interface.VideoAnalyticsDetailsDef>}
   * @private
   */
  getAnalyticsDetails_(video) {
    return this.boundSupportsAutoplay_().then(supportsAutoplay => {
      const {width, height} = this.video.element.getLayoutBox();
      const autoplay = this.hasAutoplay && supportsAutoplay;
      const playedRanges = video.getPlayedRanges();
      const playedTotal = playedRanges.reduce(
          (acc, range) => acc + range[1] - range[0], 0);

      return {
        'autoplay': autoplay,
        'currentTime': video.getCurrentTime(),
        'duration': video.getDuration(),
        // TODO(cvializ): add fullscreen
        'height': height,
        'id': video.element.id,
        'muted': this.muted_,
        'playedTotal': playedTotal,
        'playedRangesJson': JSON.stringify(playedRanges),
        'state': this.getPlayingState(),
        'width': width,
      };
    });
  }
}

/**
 * Asserts that a video is a tracking video
 * @param {!../video-interface.VideoInterface} video
 * @return {?../video-interface.VideoInterfaceWithAnalytics}
 * @private visible for testing
 */
export function assertTrackingVideo(video) {
  const trackingVideo =
      /** @type {?../video-interface.VideoInterfaceWithAnalytics} */ (video);
  if (trackingVideo.supportsAnalytics && trackingVideo.supportsAnalytics()) {
    return trackingVideo;
  } else {
    return null;
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
