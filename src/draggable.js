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

import {vsyncFor,viewportForDoc} from './services';
import {listen, listenOncePromise} from '../event-helper';
import {dev} from '../log';
import * as st from '../style';

/** @const {number} */
const FRICTION_COEFF = 0.65;
/** @const {number} */
const STOP_THRESHOLD = 10;


/**
 * Draggable class, allows for dragging, dropping and snapping of DOM elements
 * and provides callbacks for all drag/drop events.
 */
export class Draggable {
  /**
   * @param {!Node} contextNode Context node.
   * @param {!Object} opt_callbacks
   */
  constructor(ampdoc, contextNode, opt_callbacks) {

    /** @private @const {!./ampdoc-impl.AmpDoc}  */
    this.ampdoc_ = ampdoc;

    /** @private @const {!Object} */
    this.callbacks_ = opt_callbacks || {
      drag: () => {},
      move: () => {},
      drop: () => {},
      dismiss: () => {},
    };

    /** @private @const {!Node} */
    this.contextNode_ = contextNode;

    /** @private {boolean} */
    this.isTouched_ = false;

    /** @private {boolean} */
    this.isDragging_ = false;

    /** @private {boolean} */
    this.isDismissed = false;

    /** @private {Array} */
    this.unlisteners = []

    /** @private {Object} */
    this.coordinates_ = {
      mouse: {x: 0, y: 0},
      displacement: {x: 0, y: 0},
      initial: {x: 0, y: 0},
      position: {x: 0, y: 0},
      previous: {x: 0, y: 0},
      velocity: {x: 0, y: 0},
    };

    this.initialize_();
  }

  /** @private */
  initialize_() {
    unlisten_();

    const initialRect = this.contextNode_./*OK*/getBoundingClientRect();

    this.coordinates_.initial = {x:initialRect.left, y:initialRect.top};
    this.coordinates_.position = this.coordinates_.initial;
    this.coordinates_.previous = this.coordinates_.initial;

    // Desktop listeners
    this.addListener_(
      listen(this.contextNode_, 'mousedown', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateCoordinates_(e, true);
      })
    );
    this.addListener_(
      listen(this.ampdoc_.win.document, 'mouseup', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
      })
    );
    this.addListener_(
      listen(this.ampdoc_.win.document, 'mousemove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateCoordinates_(e);
      })
    );

    // Touch listeners
    this.addListener_(
      listen(this.contextNode_, 'touchstart', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateCoordinates_(e, true);
      })
    );
    this.addListener_(
      listen(this.ampdoc_.win.document, 'touchend', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
      })
    );
    this.addListener_(
      listen(this.ampdoc_.win.document, 'touchmove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateCoordinates_(e);
      })
    );

    this.vsync_.mutate(() => {
      this.drag_();
    });
  }

  /** @private **/
  addListener_(unlistener) {
    this.unlisteners.push(unlistener);
  }

  /** @private **/
  unlisten_() {
    let unlistener = this.unlisteners.pop();
    while (unlistener) {
      unlistener.call();
      unlistener = this.unlisteners.pop();
    }
  }

  /** @private **/
  style_(style) {
    st.setStyles(dev().assertElement(this.contextNode_), style);
  }

  drag_() {
    // Save some power and help preserve the environment
    if (!this.loaded_
      || !this.contextNode_
      || this.minimizePosition_ == MinimizePositions.DEFAULT
      || this.minimizePosition_ == MinimizePositions.INVIEW
      || this.visibleHeight_ != 0
      || !this.contextNode_.classList.contains(DOCK_CLASS)) {
        this.contextNode_.style.transition = '';
        return;
    }

    const posRect = this.contextNode_./*OK*/getBoundingClientRect();
    const coord = this.coordinates_;
    const viewport = viewportForDoc(this.ampdoc_);
    if (this.isDragging_) {

      coord.previous.x = coord.position.x;
      coord.previous.y = coord.position.y;

      coord.position.x = coord.mouse.x - coord.displacement.x;
      coord.position.y = coord.mouse.y - coord.displacement.y;

      coord.velocity.x = (coord.position.x - coord.previous.x);
      coord.velocity.y = (coord.position.y - coord.previous.y);

      const centerX = coord.position.x + posRect.width/2;
      const centerY = coord.position.y + posRect.height/2;

      if (centerX  > viewport.getWidth() || centerX < 0
          || centerY > viewport.getHeight() || centerY < 0)
      {
            this.isDismissed = true;
      }
    } else {

      coord.position.x += coord.velocity.x;
      coord.position.y += coord.velocity.y;

      coord.velocity.x *= FRICTION_COEFF;
      coord.velocity.y *= FRICTION_COEFF;

      if (this.isDismissed) {
        this.callbacks.dismissed.call();
        this.isDismissed = false;
        return;
      }
    }


    // Snap to corners
    if (Math.abs(coord.velocity.x) <= STOP_THRESHOLD
        && Math.abs(coord.velocity.y) <= STOP_THRESHOLD) {

      this.callbacks.drop.call();

      if ((coord.position.x + posRect.width/2) > viewport.getWidth()/2) {
        coord.position.x = viewport.getWidth() - posRect.width - DOCK_MARGIN;
      } else if (coord.position.x < viewport.getWidth()/2) {
        coord.position.x = DOCK_MARGIN;
      }
      if ((coord.position.y + posRect.height/2) > viewport.getHeight()/2) {
        coord.position.y = viewport.getHeight() - posRect.height - DOCK_MARGIN;
      } else if (coord.position.y < viewport.getHeight()/2) {
        coord.position.y = DOCK_MARGIN;
      }

      this.style_({'transition': 'transform 2s'});
    } else {
      this.style_({'transition': ''});
    }

    this.callbacks.drag.call(coord.position.x, coord.position.y);

    // // Update the video's position
    // const translate = st.translate(
    //   st.px(coord.position.x),
    //   st.px(coord.position.y)
    // );
    //
    // const scale = st.scale(DOCK_SCALE);
    // this.style_({
    //   'transform': translate + ' ' + scale,
    //   'transformOrigin': 'top left',
    //   'bottom': 'auto',
    //   'top': '0px',
    //   'right': 'auto',
    //   'left': '0px',
    // });


    // Re-run on every animation frame
    this.vsync_.mutate(() => {
      this.handleDockingDrag_();
    });
  }

  updateCoordinates_(e, initial = false) {
    if (e.x) {
      this.coordinates_.mouse.x = e.x;
      this.coordinates_.mouse.y = e.y;
    } else if (e.touches) {
      this.coordinates_.mouse.x = e.touches[0].clientX;
      this.coordinates_.mouse.y = e.touches[0].clientY;
    }
    if (initial) {
      this.coordinates_.displacement.x = Math.abs(
          this.coordinates_.position.x - this.coordinates_.mouse.x
      );
      this.coordinates_.displacement.y = Math.abs(
          this.coordinates_.position.y - this.coordinates_.mouse.y
      );
    }
  }

}
