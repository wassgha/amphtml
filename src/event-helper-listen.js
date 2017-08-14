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
 * Variable that holds whether the browser supports options as a parameter of
 * addEventListener or not
 * @enum {string}
 */
 const optTest = {
   NOT_RUN: 'not_run',
   NOT_SUPPORTED: 'not_supported',
   SUPPORTED: 'supported',
 };

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
 * @param {Object=} opt_evtListenerOpts
 * @return {!UnlistenDef}
 */
 export function internalListenImplementation(element, eventType, listener,
   opt_evtListenerOpts) {
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
   const optsSupported = detectEvtListenerOptsSupport();
   let capture = false;
   if (opt_evtListenerOpts && opt_evtListenerOpts.capture) {
     capture = opt_evtListenerOpts.capture;
   }
   localElement.addEventListener(
       eventType,
       wrapped,
       optsSupported ? opt_evtListenerOpts : capture
   );
   return () => {
     if (localElement) {
       localElement.removeEventListener(
           eventType,
           wrapped,
           optsSupported ? opt_evtListenerOpts : capture
       );
     }
     // Ensure these are GC'd
     localListener = null;
     localElement = null;
     wrapped = null;
   };
 }

/**
 * Tests whether the browser supports options as an argument of addEventListener
 * or not.
 *
 * @return {boolean}
 * @suppress {checkTypes}
 */
 export function detectEvtListenerOptsSupport() {
   if (!self.optsSupported) {
     self.optsSupported = optTest.NOT_RUN;
   }
   // Only run the test once
   if (self.optsSupported != optTest.NOT_RUN) {
     return self.optsSupported == optTest.SUPPORTED;
   }

   self.optsSupported = optTest.NOT_SUPPORTED;
   // Test whether browser supports EventListenerOptions or not
   try {
     let optsSupported = self.optsSupported;
     const options = Object.defineProperty({}, 'capture', {
       get: function() {
         optsSupported = optTest.SUPPORTED;
       },
     });
     self.addEventListener('test-opts', null, options);
     self.optsSupported = optsSupported;
     return self.optsSupported == optTest.SUPPORTED;
   } catch (err) {
     // EventListenerOptions are not supported
   }
   return false;
 }

 /**
  * Resets the test for whether addEventListener supports options or not.
  */
 export function resetEvtListenerOptsSupport() {
   self.optsSupported = optTest.NOT_RUN;
 }
