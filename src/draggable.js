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
import {listen, listenOncePromise} from './event-helper';
import {dev} from './log';
import * as st from './style';

/** @const {number} */
const FRICTION_COEFF = 0.85;
/** @const {number} */
const STOP_THRESHOLD = 10;
/** @const {number} */
const DOCK_MARGIN = 20;


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
      move: (x,y) => {},
      drop: () => {},
      dismiss: () => {},
    };

    /** @private @const {!../service/vsync-impl.Vsync} */
    this.vsync_ = vsyncFor(ampdoc.win);

    /** @private @const {!Node} */
    this.contextNode_ = contextNode;

    /** @private {boolean} */
    this.isTouched_ = false;

    /** @private {boolean} */
    this.isDragging_ = false;

    /** @private {boolean} */
    this.isDismissed_ = false;

    /** @private {boolean} */
    this.stopReported_ = true;

    /** @private {Array} */
    this.unlisteners = []

    /** @private {Object} */
    this.coordinates_ = {
      mouse: {x: 0, y: 0},
      displacement: {x: 0, y: 0},
      initial: {x: 0, y: 0, w:0, h:0},
      position: {x: 0, y: 0},
      previous: {x: 0, y: 0},
      velocity: {x: 0, y: 0},
    };

    this.viewport_ = viewportForDoc(this.ampdoc_);

    this.initialize_();
  }

  /** @private */
  initialize_() {
    // this.unlisten_();

    this.vsync_.run({
      measure: () => {
        const initialRect = this.contextNode_./*OK*/getBoundingClientRect();
        this.coordinates_.initial.x  = initialRect.left
        this.coordinates_.initial.y  = initialRect.top;
        this.coordinates_.initial.w  = initialRect.width
        this.coordinates_.initial.h  = initialRect.height;
        this.coordinates_.position.x = initialRect.left;
        this.coordinates_.position.y = initialRect.top;
        this.coordinates_.previous.x = initialRect.left;
        this.coordinates_.previous.y = initialRect.top;
      },
      mutate: () => {
        this.drag_();
      }
    });

    // Desktop listeners
    // this.addListener_(
      listen(this.contextNode_, 'mousedown', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateMouse_(e);
        this.updateDisplacement_();
        console.log('mousedown');
      })
    // );
    // this.addListener_(
      listen(this.ampdoc_.win.document, 'mouseup', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
        console.log('mouseup');
      })
    // );
    // this.addListener_(
      listen(this.ampdoc_.win.document, 'mousemove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateMouse_(e);
        console.log('mousemove');
      })
    // );

    // Touch listeners
    // this.addListener_(
      listen(this.contextNode_, 'touchstart', e => {
        e.preventDefault();
        this.isTouched_ = true;
        this.isDragging_ = false;
        this.updateMouse_(e);
        this.updateDisplacement_();
        console.log('touchstart');
      })
    // );
    // this.addListener_(
      listen(this.ampdoc_.win.document, 'touchend', () => {
        this.isTouched_ = false;
        this.isDragging_ = false;
        console.log('touchend');
      })
    // );
    // this.addListener_(
      listen(this.ampdoc_.win.document, 'touchmove', e => {
        e.preventDefault();
        this.isDragging_ = this.isTouched_;
        this.updateMouse_(e);
        console.log('touchmove');
      })
    // );
  }

  /** @private **/
  addListener_(unlistener) {
    this.unlisteners.push(unlistener);
  }

  /** @private **/
  unlisten_() {
    let unlistener = this.unlisteners.pop();
    while (unlistener) {
      unlistener.call(this);
      unlistener = this.unlisteners.pop();
    }
  }

  /** @private **/
  style_(style) {
    st.setStyles(dev().assertElement(this.contextNode_), style);
  }

  drag_() {

    console.log('drag called');
    // TODO(@wassgha) constraint for stopping

    const coord = this.coordinates_;

    if (this.isDragging_) {

      coord.previous.x = coord.position.x;
      coord.previous.y = coord.position.y;

      coord.position.x = coord.mouse.x - coord.displacement.x;
      coord.position.y = coord.mouse.y - coord.displacement.y;

      coord.velocity.x = (coord.position.x - coord.previous.x);
      coord.velocity.y = (coord.position.y - coord.previous.y);

      // const centerX = coord.position.x + coord.initial.w/2;
      // const centerY = coord.position.y + coord.initial.h/2;

      // if (centerX  > this.viewport_.getWidth() || centerX < 0
      //     || centerY > this.viewport_.getHeight() || centerY < 0)
      // {
      //     console.log('dismiss');
      //     this.isDismissed_ = true;
      // }
    } else {

      coord.position.x += coord.velocity.x;
      coord.position.y += coord.velocity.y;

      coord.velocity.x *= FRICTION_COEFF;
      coord.velocity.y *= FRICTION_COEFF;

      // if (this.isDismissed_) {
      //   this.callback_('dismiss');
      //   this.isDismissed_ = false;
      //   return;
      // }
    }

    // Snap to corners
    // if (Math.abs(coord.velocity.x) <= STOP_THRESHOLD
    //     && Math.abs(coord.velocity.y) <= STOP_THRESHOLD) {
    //
    //   if ((coord.position.x + coord.initial.w/2) > this.viewport_.getWidth()/2) {
    //     coord.position.x = this.viewport_.getWidth() - coord.initial.w - DOCK_MARGIN;
    //   } else if (coord.position.x < this.viewport_.getWidth()/2) {
    //     coord.position.x = DOCK_MARGIN;
    //   }
    //   if ((coord.position.y + coord.initial.h/2) > this.viewport_.getHeight()/2) {
    //     coord.position.y = this.viewport_.getHeight() - coord.initial.h - DOCK_MARGIN;
    //   } else if (coord.position.y < this.viewport_.getHeight()/2) {
    //     coord.position.y = DOCK_MARGIN;
    //   }
    //
    //   this.style_({'transition': 'all .2s'});
    //   if (!this.stopReported_) {
    //     this.stopReported_ = true;
    //   }
    // } else {
    //   this.stopReported_ = false;
    //   this.style_({'transition': ''});
    // }

    // this.callback_('move');

    // Re-run on every animation frame
    this.vsync_.mutate(() => {
      st.setStyles(this.contextNode_, {
        'transform': st.translate(coord.position.x, coord.position.y),
      });
      this.drag_();
    });
  }

  callback_(callback) {
    if (callback == 'move') {
      const coord = this.coordinates_;
      this.callbacks_[callback].call(this, coord.position.x, coord.position.y);
    } else {
      this.callbacks_[callback].call(this);
    }
  }

  updateMouse_(e) {
    if (e.x) {
      this.coordinates_.mouse.x = e.x;
      this.coordinates_.mouse.y = e.y;
    } else if (e.touches) {

      this.coordinates_.mouse.x = e.touches[0].clientX;
      this.coordinates_.mouse.y = e.touches[0].clientY;
    }
  }

  updateDisplacement_() {
    this.coordinates_.displacement.x = Math.abs(
        this.coordinates_.position.x - this.coordinates_.mouse.x
    );
    this.coordinates_.displacement.y = Math.abs(
        this.coordinates_.position.y - this.coordinates_.mouse.y
    );
  }

}
