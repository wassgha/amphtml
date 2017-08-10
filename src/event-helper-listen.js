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

/**
 * Listens for the specified event on the element.
 *
 * Do not use this directly. This method is implemented as a shared
 * dependency. Use `listen()` in either `event-helper` or `3p-frame-messaging`,
 * depending on your use case.
 *
 * @param {!EventTarget} element
 * @param {string} eventType
 * @param {function(!Event)} listener
 * @param {boolean=} opt_capture
 * @param {boolean=} opt_passive
 * @return {!UnlistenDef}
 * @suppress {checkTypes}
 */
export function internalListenImplementation(element, eventType, listener,
    opt_capture, opt_passive) {
  let localElement = element;
  let localListener = listener;
  /** @type {?Function}  */
  let wrapped = event => {
    try {
      return localListener(event);
    } catch (e) {
      // reportError is installed globally per window in the entry point.
      self.reportError(e);
      throw e;
    }
  };

  // Test whether browser supports the passive option or not
  let passiveSupported = false;
  try {
    const options = Object.defineProperty({}, 'passive', {
      get: function() {
        passiveSupported = true;
      },
    });
    self.addEventListener('test-passive', null, options);
  } catch (err) {
    // Passive is not supported
  }

  const capture = opt_capture || false;
  const passive = opt_passive || false;
  localElement.addEventListener(
      eventType,
      wrapped,
      passiveSupported ? {'capture': capture, 'passive': passive} : capture
  );
  return () => {
    if (localElement) {
      localElement.removeEventListener(
          eventType,
          wrapped,
          passiveSupported ? {'capture': capture, 'passive': passive} : capture
      );
    }
    // Ensure these are GC'd
    localListener = null;
    localElement = null;
    wrapped = null;
  };
}
