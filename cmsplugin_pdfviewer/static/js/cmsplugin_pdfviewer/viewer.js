/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* globals PDFJS, PDFBug, FirefoxCom, Stats, Cache, PDFFindBar, CustomStyle,
           PDFFindController, ProgressBar, TextLayerBuilder, DownloadManager,
           getFileName, scrollIntoView, getPDFFileNameFromURL, PDFHistory,
           Preferences, ViewHistory, PageView, ThumbnailView, URL,
           noContextMenuHandler, PasswordPrompt,
           PresentationMode, Promise, DocumentProperties */

'use strict';

var DEFAULT_URL = 'compressed.tracemonkey-pldi-09.pdf';
var DEFAULT_SCALE = 'auto';
var DEFAULT_SCALE_DELTA = 1.1;
var UNKNOWN_SCALE = 0;
var CACHE_SIZE = 20;
var CSS_UNITS = 96.0 / 72.0;
var SCROLLBAR_PADDING = 40;
var VERTICAL_PADDING = 5;
var MAX_AUTO_SCALE = 1.25;
var MIN_SCALE = 0.25;
var MAX_SCALE = 4.0;
var VIEW_HISTORY_MEMORY = 20;
var SCALE_SELECT_CONTAINER_PADDING = 16;
var SCALE_SELECT_PADDING = 22;
var THUMBNAIL_SCROLL_MARGIN = -19;
var USE_ONLY_CSS_ZOOM = false;
var CLEANUP_TIMEOUT = 30000;
var IGNORE_CURRENT_POSITION_ON_ZOOM = false;
var RenderingStates = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3
};
var FindStates = {
  FIND_FOUND: 0,
  FIND_NOTFOUND: 1,
  FIND_WRAPPED: 2,
  FIND_PENDING: 3
};

PDFJS.imageResourcesPath = './images/';
  PDFJS.workerSrc = '../build/pdf.worker.js';
  PDFJS.cMapUrl = '../web/cmaps/';
  PDFJS.cMapPacked = true;


(function ( $ ){
  $.fn.PDFViewer = function(options){
    var settings = $.extend({}, options);
    
    if(!settings.source){
        $.error('No PDF document source was given');
        return this; 
    }

    var $pluginInstance = $(this);

    var mozL10n = document.webL10n(window, document, $pluginInstance.get(0));


    
    // optimised CSS custom property getter/setter
    var CustomStyle = (function CustomStyleClosure() {

      // As noted on: http://www.zachstronaut.com/posts/2009/02/17/
      //              animate-css-transforms-firefox-webkit.html
      // in some versions of IE9 it is critical that ms appear in this list
      // before Moz
      var prefixes = ['ms', 'Moz', 'Webkit', 'O'];
      var _cache = {};

      function CustomStyle() {}

      CustomStyle.getProp = function get(propName, element) {
        // check cache only when no element is given
        if (arguments.length == 1 && typeof _cache[propName] == 'string') {
          return _cache[propName];
        }

        element = element || document.documentElement;
        var style = element.style, prefixed, uPropName;

        // test standard property first
        if (typeof style[propName] == 'string') {
          return (_cache[propName] = propName);
        }

        // capitalize
        uPropName = propName.charAt(0).toUpperCase() + propName.slice(1);

        // test vendor specific properties
        for (var i = 0, l = prefixes.length; i < l; i++) {
          prefixed = prefixes[i] + uPropName;
          if (typeof style[prefixed] == 'string') {
            return (_cache[propName] = prefixed);
          }
        }

        //if all fails then set to undefined
        return (_cache[propName] = 'undefined');
      };

      CustomStyle.setProp = function set(propName, element, str) {
        var prop = this.getProp(propName);
        if (prop != 'undefined') {
          element.style[prop] = str;
        }
      };

      return CustomStyle;
    })();

    function getFileName(url) {
      var anchor = url.indexOf('#');
      var query = url.indexOf('?');
      var end = Math.min(
        anchor > 0 ? anchor : url.length,
        query > 0 ? query : url.length);
      return url.substring(url.lastIndexOf('/', end) + 1, end);
    }

    /**
     * Returns scale factor for the canvas. It makes sense for the HiDPI displays.
     * @return {Object} The object with horizontal (sx) and vertical (sy)
                        scales. The scaled property is set to false if scaling is
                        not required, true otherwise.
     */
    function getOutputScale(ctx) {
      var devicePixelRatio = window.devicePixelRatio || 1;
      var backingStoreRatio = ctx.webkitBackingStorePixelRatio ||
                              ctx.mozBackingStorePixelRatio ||
                              ctx.msBackingStorePixelRatio ||
                              ctx.oBackingStorePixelRatio ||
                              ctx.backingStorePixelRatio || 1;
      var pixelRatio = devicePixelRatio / backingStoreRatio;
      return {
        sx: pixelRatio,
        sy: pixelRatio,
        scaled: pixelRatio != 1
      };
    }

    /**
     * Scrolls specified element into view of its parent.
     * element {Object} The element to be visible.
     * spot {Object} An object with optional top and left properties,
     *               specifying the offset from the top left edge.
     */
    function scrollIntoView(element, spot) {
      // Assuming offsetParent is available (it's not available when viewer is in
      // hidden iframe or object). We have to scroll: if the offsetParent is not set
      // producing the error. See also animationStartedClosure.
      var parent = element.offsetParent;
      var offsetY = element.offsetTop + element.clientTop;
      var offsetX = element.offsetLeft + element.clientLeft;
      if (!parent) {
        console.error('offsetParent is not set -- cannot scroll');
        return;
      }
      while (parent.clientHeight === parent.scrollHeight) {
        if (parent.dataset._scaleY) {
          offsetY /= parent.dataset._scaleY;
          offsetX /= parent.dataset._scaleX;
        }
        offsetY += parent.offsetTop;
        offsetX += parent.offsetLeft;
        parent = parent.offsetParent;
        if (!parent) {
          return; // no need to scroll
        }
      }
      if (spot) {
        if (spot.top !== undefined) {
          offsetY += spot.top;
        }
        if (spot.left !== undefined) {
          offsetX += spot.left;
          parent.scrollLeft = offsetX;
        }
      }
      parent.scrollTop = offsetY;
    }

    /**
     * Event handler to suppress context menu.
     */
    function noContextMenuHandler(e) {
      e.preventDefault();
    }

    /**
     * Returns the filename or guessed filename from the url (see issue 3455).
     * url {String} The original PDF location.
     * @return {String} Guessed PDF file name.
     */
    function getPDFFileNameFromURL(url) {
      var reURI = /^(?:([^:]+:)?\/\/[^\/]+)?([^?#]*)(\?[^#]*)?(#.*)?$/;
      //            SCHEME      HOST         1.PATH  2.QUERY   3.REF
      // Pattern to get last matching NAME.pdf
      var reFilename = /[^\/?#=]+\.pdf\b(?!.*\.pdf\b)/i;
      var splitURI = reURI.exec(url);
      var suggestedFilename = reFilename.exec(splitURI[1]) ||
                               reFilename.exec(splitURI[2]) ||
                               reFilename.exec(splitURI[3]);
      if (suggestedFilename) {
        suggestedFilename = suggestedFilename[0];
        if (suggestedFilename.indexOf('%') != -1) {
          // URL-encoded %2Fpath%2Fto%2Ffile.pdf should be file.pdf
          try {
            suggestedFilename =
              reFilename.exec(decodeURIComponent(suggestedFilename))[0];
          } catch(e) { // Possible (extremely rare) errors:
            // URIError "Malformed URI", e.g. for "%AA.pdf"
            // TypeError "null has no properties", e.g. for "%2F.pdf"
          }
        }
      }
      return suggestedFilename || 'document.pdf';
    }

    var ProgressBar = (function ProgressBarClosure() {

      function clamp(v, min, max) {
        return Math.min(Math.max(v, min), max);
      }

      function ProgressBar(id, opts) {

        // Fetch the sub-elements for later.
        this.div = document.querySelector(id + ' .progress');

        // Get the loading bar element, so it can be resized to fit the viewer.
        this.bar = this.div.parentNode;

        // Get options, with sensible defaults.
        this.height = opts.height || 100;
        this.width = opts.width || 100;
        this.units = opts.units || '%';

        // Initialize heights.
        this.div.style.height = this.height + this.units;
        this.percent = 0;
      }

      ProgressBar.prototype = {

        updateBar: function ProgressBar_updateBar() {
          if (this._indeterminate) {
            this.div.classList.add('indeterminate');
            this.div.style.width = this.width + this.units;
            return;
          }

          this.div.classList.remove('indeterminate');
          var progressSize = this.width * this._percent / 100;
          this.div.style.width = progressSize + this.units;
        },

        get percent() {
          return this._percent;
        },

        set percent(val) {
          this._indeterminate = isNaN(val);
          this._percent = clamp(val, 0, 100);
          this.updateBar();
        },

        setWidth: function ProgressBar_setWidth(viewer) {
          if (viewer) {
            var container = viewer.parentNode;
            var scrollbarWidth = container.offsetWidth - viewer.offsetWidth;
            if (scrollbarWidth > 0) {
              this.bar.setAttribute('style', 'width: calc(100% - ' +
                                             scrollbarWidth + 'px);');
            }
          }
        },

        hide: function ProgressBar_hide() {
          this.bar.classList.add('hidden');
          this.bar.removeAttribute('style');
        }
      };

      return ProgressBar;
    })();

    var Cache = function cacheCache(size) {
      var data = [];
      this.push = function cachePush(view) {
        var i = data.indexOf(view);
        if (i >= 0) {
          data.splice(i);
        }
        data.push(view);
        if (data.length > size) {
          data.shift().destroy();
        }
      };
    };




    var DEFAULT_PREFERENCES = {
      showPreviousViewOnLoad: true,
      defaultZoomValue: '',
      ifAvailableShowOutlineOnLoad: false,
      enableWebGL: false
    };


    /**
     * Preferences - Utility for storing persistent settings.
     *   Used for settings that should be applied to all opened documents,
     *   or every time the viewer is loaded.
     */
    var Preferences = {
      prefs: Object.create(DEFAULT_PREFERENCES),
      isInitializedPromiseResolved: false,
      initializedPromise: null,

      /**
       * Initialize and fetch the current preference values from storage.
       * @return {Promise} A promise that is resolved when the preferences
       *                   have been initialized.
       */
      initialize: function preferencesInitialize() {
        return this.initializedPromise =
            this._readFromStorage(DEFAULT_PREFERENCES).then(function(prefObj) {
          this.isInitializedPromiseResolved = true;
          if (prefObj) {
            this.prefs = prefObj;
          }
        }.bind(this));
      },

      /**
       * Stub function for writing preferences to storage.
       * NOTE: This should be overridden by a build-specific function defined below.
       * @param {Object} prefObj The preferences that should be written to storage.
       * @return {Promise} A promise that is resolved when the preference values
       *                   have been written.
       */
      _writeToStorage: function preferences_writeToStorage(prefObj) {
        return Promise.resolve();
      },

      /**
       * Stub function for reading preferences from storage.
       * NOTE: This should be overridden by a build-specific function defined below.
       * @param {Object} prefObj The preferences that should be read from storage.
       * @return {Promise} A promise that is resolved with an {Object} containing
       *                   the preferences that have been read.
       */
      _readFromStorage: function preferences_readFromStorage(prefObj) {
        return Promise.resolve();
      },

      /**
       * Reset the preferences to their default values and update storage.
       * @return {Promise} A promise that is resolved when the preference values
       *                   have been reset.
       */
      reset: function preferencesReset() {
        return this.initializedPromise.then(function() {
          this.prefs = Object.create(DEFAULT_PREFERENCES);
          return this._writeToStorage(DEFAULT_PREFERENCES);
        }.bind(this));
      },

      /**
       * Replace the current preference values with the ones from storage.
       * @return {Promise} A promise that is resolved when the preference values
       *                   have been updated.
       */
      reload: function preferencesReload() {
        return this.initializedPromise.then(function () {
          this._readFromStorage(DEFAULT_PREFERENCES).then(function(prefObj) {
            if (prefObj) {
              this.prefs = prefObj;
            }
          }.bind(this));
        }.bind(this));
      },

      /**
       * Set the value of a preference.
       * @param {string} name The name of the preference that should be changed.
       * @param {boolean|number|string} value The new value of the preference.
       * @return {Promise} A promise that is resolved when the value has been set,
       *                   provided that the preference exists and the types match.
       */
      set: function preferencesSet(name, value) {
        return this.initializedPromise.then(function () {
          if (DEFAULT_PREFERENCES[name] === undefined) {
            throw new Error('preferencesSet: \'' + name + '\' is undefined.');
          } else if (value === undefined) {
            throw new Error('preferencesSet: no value is specified.');
          }
          var valueType = typeof value;
          var defaultType = typeof DEFAULT_PREFERENCES[name];

          if (valueType !== defaultType) {
            if (valueType === 'number' && defaultType === 'string') {
              value = value.toString();
            } else {
              throw new Error('Preferences_set: \'' + value + '\' is a \"' +
                              valueType + '\", expected \"' + defaultType + '\".');
            }
          } else {
            if (valueType === 'number' && (value | 0) !== value) {
              throw new Error('Preferences_set: \'' + value +
                              '\' must be an \"integer\".');
            }
          }
          this.prefs[name] = value;
          return this._writeToStorage(this.prefs);
        }.bind(this));
      },

      /**
       * Get the value of a preference.
       * @param {string} name The name of the preference whose value is requested.
       * @return {Promise} A promise that is resolved with a {boolean|number|string}
       *                   containing the value of the preference.
       */
      get: function preferencesGet(name) {
        return this.initializedPromise.then(function () {
          var defaultValue = DEFAULT_PREFERENCES[name];

          if (defaultValue === undefined) {
            throw new Error('preferencesGet: \'' + name + '\' is undefined.');
          } else {
            var prefValue = this.prefs[name];

            if (prefValue !== undefined) {
              return prefValue;
            }
          }
          return defaultValue;
        }.bind(this));
      }
    };


    Preferences._writeToStorage = function (prefObj) {
      return new Promise(function (resolve) {
        localStorage.setItem('pdfjs.preferences', JSON.stringify(prefObj));
        resolve();
      });
    };

    Preferences._readFromStorage = function (prefObj) {
      return new Promise(function (resolve) {
        var readPrefs = JSON.parse(localStorage.getItem('pdfjs.preferences'));
        resolve(readPrefs);
      });
    };

    var DownloadManager = (function DownloadManagerClosure() {

      function download(blobUrl, filename) {
        var a = document.createElement('a');
        if (a.click) {
          // Use a.click() if available. Otherwise, Chrome might show
          // "Unsafe JavaScript attempt to initiate a navigation change
          //  for frame with URL" and not open the PDF at all.
          // Supported by (not mentioned = untested):
          // - Firefox 6 - 19 (4- does not support a.click, 5 ignores a.click)
          // - Chrome 19 - 26 (18- does not support a.click)
          // - Opera 9 - 12.15
          // - Internet Explorer 6 - 10
          // - Safari 6 (5.1- does not support a.click)
          a.href = blobUrl;
          a.target = '_parent';
          // Use a.download if available. This increases the likelihood that
          // the file is downloaded instead of opened by another PDF plugin.
          if ('download' in a) {
            a.download = filename;
          }
          // <a> must be in the document for IE and recent Firefox versions.
          // (otherwise .click() is ignored)
          (document.body || document.documentElement).appendChild(a);
          a.click();
          a.parentNode.removeChild(a);
        } else {
          if (window.top === window &&
              blobUrl.split('#')[0] === window.location.href.split('#')[0]) {
            // If _parent == self, then opening an identical URL with different
            // location hash will only cause a navigation, not a download.
            var padCharacter = blobUrl.indexOf('?') === -1 ? '?' : '&';
            blobUrl = blobUrl.replace(/#|$/, padCharacter + '$&');
          }
          window.open(blobUrl, '_parent');
        }
      }

      function DownloadManager() {}

      DownloadManager.prototype = {
        downloadUrl: function DownloadManager_downloadUrl(url, filename) {
          if (!PDFJS.isValidUrl(url, true)) {
            return; // restricted/invalid URL
          }

          download(url + '#pdfjs.action=download', filename);
        },

        downloadData: function DownloadManager_downloadData(data, filename,
                                                            contentType) {

          var blobUrl = PDFJS.createObjectURL(data, contentType);
          download(blobUrl, filename);
        },

        download: function DownloadManager_download(blob, url, filename) {
          if (!URL) {
            // URL.createObjectURL is not supported
            this.downloadUrl(url, filename);
            return;
          }

          if (navigator.msSaveBlob) {
            // IE10 / IE11
            if (!navigator.msSaveBlob(blob, filename)) {
              this.downloadUrl(url, filename);
            }
            return;
          }

          var blobUrl = URL.createObjectURL(blob);
          download(blobUrl, filename);
        }
      };

      return DownloadManager;
    })();




    var cache = new Cache(CACHE_SIZE);
    var currentPageNumber = 1;


    /**
     * View History - This is a utility for saving various view parameters for
     *                recently opened files.
     *
     * The way that the view parameters are stored depends on how PDF.js is built,
     * for 'node make <flag>' the following cases exist:
     *  - FIREFOX or MOZCENTRAL - uses sessionStorage.
     *  - B2G                   - uses asyncStorage.
     *  - GENERIC or CHROME     - uses localStorage, if it is available.
     */
    var ViewHistory = (function ViewHistoryClosure() {
      function ViewHistory(fingerprint) {
        this.fingerprint = fingerprint;
        var initializedPromiseResolve;
        this.isInitializedPromiseResolved = false;
        this.initializedPromise = new Promise(function (resolve) {
          initializedPromiseResolve = resolve;
        });

        var resolvePromise = (function ViewHistoryResolvePromise(db) {
          this.isInitializedPromiseResolved = true;
          this.initialize(db || '{}');
          initializedPromiseResolve();
        }).bind(this);

        resolvePromise(localStorage.getItem('cmsplugin-pdfviewer'));
      }

      ViewHistory.prototype = {
        initialize: function ViewHistory_initialize(database) {
          database = JSON.parse(database);
          if (!('files' in database)) {
            database.files = [];
          }
          if (database.files.length >= VIEW_HISTORY_MEMORY) {
            database.files.shift();
          }
          var index;
          for (var i = 0, length = database.files.length; i < length; i++) {
            var branch = database.files[i];
            if (branch.fingerprint === this.fingerprint) {
              index = i;
              break;
            }
          }
          if (typeof index !== 'number') {
            index = database.files.push({fingerprint: this.fingerprint}) - 1;
          }
          this.file = database.files[index];
          this.database = database;
        },

        set: function ViewHistory_set(name, val) {
          if (!this.isInitializedPromiseResolved) {
            return;
          }
          var file = this.file;
          file[name] = val;
          var database = JSON.stringify(this.database);



          localStorage.setItem('cmsplugin-pdfviewer', database);
        },

        get: function ViewHistory_get(name, defaultValue) {
          if (!this.isInitializedPromiseResolved) {
            return defaultValue;
          }
          return this.file[name] || defaultValue;
        }
      };

      return ViewHistory;
    })();


    /**
     * Creates a "search bar" given set of DOM elements
     * that act as controls for searching, or for setting
     * search preferences in the UI. This object also sets
     * up the appropriate events for the controls. Actual
     * searching is done by PDFFindController
     */
    var PDFFindBar = {
      opened: false,
      bar: null,
      toggleButton: null,
      findField: null,
      highlightAll: null,
      caseSensitive: null,
      findMsg: null,
      findStatusIcon: null,
      findPreviousButton: null,
      findNextButton: null,

      initialize: function(options) {
        if(typeof PDFFindController === 'undefined' || PDFFindController === null) {
          throw 'PDFFindBar cannot be initialized ' +
                'without a PDFFindController instance.';
        }

        this.bar = options.bar;
        this.toggleButton = options.toggleButton;
        this.findField = options.findField;
        this.highlightAll = options.highlightAllCheckbox;
        this.caseSensitive = options.caseSensitiveCheckbox;
        this.findMsg = options.findMsg;
        this.findStatusIcon = options.findStatusIcon;
        this.findPreviousButton = options.findPreviousButton;
        this.findNextButton = options.findNextButton;

        var self = this;
        this.toggleButton.addEventListener('click', function() {
          self.toggle();
        });

        this.findField.addEventListener('input', function() {
          self.dispatchEvent('');
        });

        this.bar.addEventListener('keydown', function(evt) {
          switch (evt.keyCode) {
            case 13: // Enter
              if (evt.target === self.findField) {
                self.dispatchEvent('again', evt.shiftKey);
              }
              break;
            case 27: // Escape
              self.close();
              break;
          }
        });

        this.findPreviousButton.addEventListener('click',
          function() { self.dispatchEvent('again', true); }
        );

        this.findNextButton.addEventListener('click', function() {
          self.dispatchEvent('again', false);
        });

        this.highlightAll.addEventListener('click', function() {
          self.dispatchEvent('highlightallchange');
        });

        this.caseSensitive.addEventListener('click', function() {
          self.dispatchEvent('casesensitivitychange');
        });
      },

      dispatchEvent: function(aType, aFindPrevious) {
        var event = document.createEvent('CustomEvent');
        event.initCustomEvent('find' + aType, true, true, {
          query: this.findField.value,
          caseSensitive: this.caseSensitive.checked,
          highlightAll: this.highlightAll.checked,
          findPrevious: aFindPrevious
        });
        return $pluginInstance.get(0).dispatchEvent(event);
      },

      updateUIState: function(state, previous) {
        var notFound = false;
        var findMsg = '';
        var status = '';

        switch (state) {
          case FindStates.FIND_FOUND:
            break;

          case FindStates.FIND_PENDING:
            status = 'pending';
            break;

          case FindStates.FIND_NOTFOUND:
            findMsg = mozL10n.get('find_not_found', null, 'Phrase not found');
            notFound = true;
            break;

          case FindStates.FIND_WRAPPED:
            if (previous) {
              findMsg = mozL10n.get('find_reached_top', null,
                          'Reached top of document, continued from bottom');
            } else {
              findMsg = mozL10n.get('find_reached_bottom', null,
                                    'Reached end of document, continued from top');
            }
            break;
        }

        if (notFound) {
          this.findField.classList.add('notFound');
        } else {
          this.findField.classList.remove('notFound');
        }

        this.findField.setAttribute('data-status', status);
        this.findMsg.textContent = findMsg;
      },

      open: function() {
        if (!this.opened) {
          this.opened = true;
          this.toggleButton.classList.add('toggled');
          this.bar.classList.remove('hidden');
        }

        this.findField.select();
        this.findField.focus();
      },

      close: function() {
        if (!this.opened) {
          return;
        }
        this.opened = false;
        this.toggleButton.classList.remove('toggled');
        this.bar.classList.add('hidden');

        PDFFindController.active = false;
      },

      toggle: function() {
        if (this.opened) {
          this.close();
        } else {
          this.open();
        }
      }
    };



    /**
     * Provides a "search" or "find" functionality for the PDF.
     * This object actually performs the search for a given string.
     */

    var PDFFindController = {
      startedTextExtraction: false,

      extractTextPromises: [],

      pendingFindMatches: {},

      // If active, find results will be highlighted.
      active: false,

      // Stores the text for each page.
      pageContents: [],

      pageMatches: [],

      // Currently selected match.
      selected: {
        pageIdx: -1,
        matchIdx: -1
      },

      // Where find algorithm currently is in the document.
      offset: {
        pageIdx: null,
        matchIdx: null
      },

      resumePageIdx: null,

      state: null,

      dirtyMatch: false,

      findTimeout: null,

      pdfPageSource: null,

      integratedFind: false,

      initialize: function(options) {
        if(typeof PDFFindBar === 'undefined' || PDFFindBar === null) {
          throw 'PDFFindController cannot be initialized ' +
                'without a PDFFindBar instance';
        }

        this.pdfPageSource = options.pdfPageSource;
        this.integratedFind = options.integratedFind;

        var events = [
          'find',
          'findagain',
          'findhighlightallchange',
          'findcasesensitivitychange'
        ];

        this.firstPagePromise = new Promise(function (resolve) {
          this.resolveFirstPage = resolve;
        }.bind(this));
        this.handleEvent = this.handleEvent.bind(this);

        for (var i = 0; i < events.length; i++) {
          $pluginInstance.get(0).addEventListener(events[i], this.handleEvent);
        }
      },

      reset: function pdfFindControllerReset() {
        this.startedTextExtraction = false;
        this.extractTextPromises = [];
        this.active = false;
      },

      calcFindMatch: function(pageIndex) {
        var pageContent = this.pageContents[pageIndex];
        var query = this.state.query;
        var caseSensitive = this.state.caseSensitive;
        var queryLen = query.length;

        if (queryLen === 0) {
          // Do nothing the matches should be wiped out already.
          return;
        }

        if (!caseSensitive) {
          pageContent = pageContent.toLowerCase();
          query = query.toLowerCase();
        }

        var matches = [];

        var matchIdx = -queryLen;
        while (true) {
          matchIdx = pageContent.indexOf(query, matchIdx + queryLen);
          if (matchIdx === -1) {
            break;
          }

          matches.push(matchIdx);
        }
        this.pageMatches[pageIndex] = matches;
        this.updatePage(pageIndex);
        if (this.resumePageIdx === pageIndex) {
          this.resumePageIdx = null;
          this.nextPageMatch();
        }
      },

      extractText: function() {
        if (this.startedTextExtraction) {
          return;
        }
        this.startedTextExtraction = true;

        this.pageContents = [];
        var extractTextPromisesResolves = [];
        for (var i = 0, ii = this.pdfPageSource.pdfDocument.numPages; i < ii; i++) {
          this.extractTextPromises.push(new Promise(function (resolve) {
            extractTextPromisesResolves.push(resolve);
          }));
        }

        var self = this;
        function extractPageText(pageIndex) {
          self.pdfPageSource.pages[pageIndex].getTextContent().then(
            function textContentResolved(textContent) {
              var textItems = textContent.items;
              var str = '';

              for (var i = 0; i < textItems.length; i++) {
                str += textItems[i].str;
              }

              // Store the pageContent as a string.
              self.pageContents.push(str);

              extractTextPromisesResolves[pageIndex](pageIndex);
              if ((pageIndex + 1) < self.pdfPageSource.pages.length) {
                extractPageText(pageIndex + 1);
              }
            }
          );
        }
        extractPageText(0);
      },

      handleEvent: function(e) {
        if (this.state === null || e.type !== 'findagain') {
          this.dirtyMatch = true;
        }
        this.state = e.detail;
        this.updateUIState(FindStates.FIND_PENDING);

        this.firstPagePromise.then(function() {
          this.extractText();

          clearTimeout(this.findTimeout);
          if (e.type === 'find') {
            // Only trigger the find action after 250ms of silence.
            this.findTimeout = setTimeout(this.nextMatch.bind(this), 250);
          } else {
            this.nextMatch();
          }
        }.bind(this));
      },

      updatePage: function(idx) {
        var page = this.pdfPageSource.pages[idx];

        if (this.selected.pageIdx === idx) {
          // If the page is selected, scroll the page into view, which triggers
          // rendering the page, which adds the textLayer. Once the textLayer is
          // build, it will scroll onto the selected match.
          page.scrollIntoView();
        }

        if (page.textLayer) {
          page.textLayer.updateMatches();
        }
      },

      nextMatch: function() {
        var previous = this.state.findPrevious;
        var currentPageIndex = this.pdfPageSource.page - 1;
        var numPages = this.pdfPageSource.pages.length;

        this.active = true;

        if (this.dirtyMatch) {
          // Need to recalculate the matches, reset everything.
          this.dirtyMatch = false;
          this.selected.pageIdx = this.selected.matchIdx = -1;
          this.offset.pageIdx = currentPageIndex;
          this.offset.matchIdx = null;
          this.hadMatch = false;
          this.resumePageIdx = null;
          this.pageMatches = [];
          var self = this;

          for (var i = 0; i < numPages; i++) {
            // Wipe out any previous highlighted matches.
            this.updatePage(i);

            // As soon as the text is extracted start finding the matches.
            if (!(i in this.pendingFindMatches)) {
              this.pendingFindMatches[i] = true;
              this.extractTextPromises[i].then(function(pageIdx) {
                delete self.pendingFindMatches[pageIdx];
                self.calcFindMatch(pageIdx);
              });
            }
          }
        }

        // If there's no query there's no point in searching.
        if (this.state.query === '') {
          this.updateUIState(FindStates.FIND_FOUND);
          return;
        }

        // If we're waiting on a page, we return since we can't do anything else.
        if (this.resumePageIdx) {
          return;
        }

        var offset = this.offset;
        // If there's already a matchIdx that means we are iterating through a
        // page's matches.
        if (offset.matchIdx !== null) {
          var numPageMatches = this.pageMatches[offset.pageIdx].length;
          if ((!previous && offset.matchIdx + 1 < numPageMatches) ||
              (previous && offset.matchIdx > 0)) {
            // The simple case, we just have advance the matchIdx to select the next
            // match on the page.
            this.hadMatch = true;
            offset.matchIdx = previous ? offset.matchIdx - 1 : offset.matchIdx + 1;
            this.updateMatch(true);
            return;
          }
          // We went beyond the current page's matches, so we advance to the next
          // page.
          this.advanceOffsetPage(previous);
        }
        // Start searching through the page.
        this.nextPageMatch();
      },

      matchesReady: function(matches) {
        var offset = this.offset;
        var numMatches = matches.length;
        var previous = this.state.findPrevious;
        if (numMatches) {
          // There were matches for the page, so initialize the matchIdx.
          this.hadMatch = true;
          offset.matchIdx = previous ? numMatches - 1 : 0;
          this.updateMatch(true);
          // matches were found
          return true;
        } else {
          // No matches attempt to search the next page.
          this.advanceOffsetPage(previous);
          if (offset.wrapped) {
            offset.matchIdx = null;
            if (!this.hadMatch) {
              // No point in wrapping there were no matches.
              this.updateMatch(false);
              // while matches were not found, searching for a page 
              // with matches should nevertheless halt.
              return true;
            }
          }
          // matches were not found (and searching is not done)
          return false;
        }
      },

      nextPageMatch: function() {
        if (this.resumePageIdx !== null) {
          console.error('There can only be one pending page.');
        }
        do {
          var pageIdx = this.offset.pageIdx;
          var matches = this.pageMatches[pageIdx];
          if (!matches) {
            // The matches don't exist yet for processing by "matchesReady",
            // so set a resume point for when they do exist.
            this.resumePageIdx = pageIdx;
            break;
          }
        } while (!this.matchesReady(matches));
      },

      advanceOffsetPage: function(previous) {
        var offset = this.offset;
        var numPages = this.extractTextPromises.length;
        offset.pageIdx = previous ? offset.pageIdx - 1 : offset.pageIdx + 1;
        offset.matchIdx = null;
        if (offset.pageIdx >= numPages || offset.pageIdx < 0) {
          offset.pageIdx = previous ? numPages - 1 : 0;
          offset.wrapped = true;
          return;
        }
      },

      updateMatch: function(found) {
        var state = FindStates.FIND_NOTFOUND;
        var wrapped = this.offset.wrapped;
        this.offset.wrapped = false;
        if (found) {
          var previousPage = this.selected.pageIdx;
          this.selected.pageIdx = this.offset.pageIdx;
          this.selected.matchIdx = this.offset.matchIdx;
          state = wrapped ? FindStates.FIND_WRAPPED : FindStates.FIND_FOUND;
          // Update the currently selected page to wipe out any selected matches.
          if (previousPage !== -1 && previousPage !== this.selected.pageIdx) {
            this.updatePage(previousPage);
          }
        }
        this.updateUIState(state, this.state.findPrevious);
        if (this.selected.pageIdx !== -1) {
          this.updatePage(this.selected.pageIdx, true);
        }
      },

      updateUIState: function(state, previous) {
        if (this.integratedFind) {
          FirefoxCom.request('updateFindControlState',
                             {result: state, findPrevious: previous});
          return;
        }
        PDFFindBar.updateUIState(state, previous);
      }
    };



    var PDFHistory = {
      initialized: false,
      initialDestination: null,

      initialize: function pdfHistoryInitialize(fingerprint) {
        if (PDFJS.disableHistory || PDFView.isViewerEmbedded) {
          // The browsing history is only enabled when the viewer is standalone,
          // i.e. not when it is embedded in a web page.
          return;
        }
        this.initialized = true;
        this.reInitialized = false;
        this.allowHashChange = true;
        this.historyUnlocked = true;

        this.previousHash = window.location.hash.substring(1);
        this.currentBookmark = '';
        this.currentPage = 0;
        this.updatePreviousBookmark = false;
        this.previousBookmark = '';
        this.previousPage = 0;
        this.nextHashParam = '';

        this.fingerprint = fingerprint;
        this.currentUid = this.uid = 0;
        this.current = {};

        var state = window.history.state;
        if (this._isStateObjectDefined(state)) {
          // This corresponds to navigating back to the document
          // from another page in the browser history.
          if (state.target.dest) {
            this.initialDestination = state.target.dest;
          } else {
            PDFView.initialBookmark = state.target.hash;
          }
          this.currentUid = state.uid;
          this.uid = state.uid + 1;
          this.current = state.target;
        } else {
          // This corresponds to the loading of a new document.
          if (state && state.fingerprint &&
              this.fingerprint !== state.fingerprint) {
            // Reinitialize the browsing history when a new document
            // is opened in the web viewer.
            this.reInitialized = true;
          }
          this._pushOrReplaceState({ fingerprint: this.fingerprint }, true);
        }

        var self = this;
        window.addEventListener('popstate', function pdfHistoryPopstate(evt) {
          evt.preventDefault();
          evt.stopPropagation();

          if (!self.historyUnlocked) {
            return;
          }
          if (evt.state) {
            // Move back/forward in the history.
            self._goTo(evt.state);
          } else {
            // Handle the user modifying the hash of a loaded document.
            self.previousHash = window.location.hash.substring(1);

            // If the history is empty when the hash changes,
            // update the previous entry in the browser history.
            if (self.uid === 0) {
              var previousParams = (self.previousHash && self.currentBookmark &&
                                    self.previousHash !== self.currentBookmark) ?
                { hash: self.currentBookmark, page: self.currentPage } :
                { page: 1 };
              self.historyUnlocked = false;
              self.allowHashChange = false;
              window.history.back();
              self._pushToHistory(previousParams, false, true);
              window.history.forward();
              self.historyUnlocked = true;
            }
            self._pushToHistory({ hash: self.previousHash }, false, true);
            self._updatePreviousBookmark();
          }
        }, false);

        function pdfHistoryBeforeUnload() {
          var previousParams = self._getPreviousParams(null, true);
          if (previousParams) {
            var replacePrevious = (!self.current.dest &&
                                   self.current.hash !== self.previousHash);
            self._pushToHistory(previousParams, false, replacePrevious);
            self._updatePreviousBookmark();
          }
          // Remove the event listener when navigating away from the document,
          // since 'beforeunload' prevents Firefox from caching the document.
          window.removeEventListener('beforeunload', pdfHistoryBeforeUnload, false);
        }
        window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);

        window.addEventListener('pageshow', function pdfHistoryPageShow(evt) {
          // If the entire viewer (including the PDF file) is cached in the browser,
          // we need to reattach the 'beforeunload' event listener since
          // the 'DOMContentLoaded' event is not fired on 'pageshow'.
          window.addEventListener('beforeunload', pdfHistoryBeforeUnload, false);
        }, false);
      },

      _isStateObjectDefined: function pdfHistory_isStateObjectDefined(state) {
        return (state && state.uid >= 0 &&
                state.fingerprint && this.fingerprint === state.fingerprint &&
                state.target && state.target.hash) ? true : false;
      },

      _pushOrReplaceState: function pdfHistory_pushOrReplaceState(stateObj,
                                                                  replace) {
        if (replace) {
          window.history.replaceState(stateObj, '', document.URL);
        } else {
          window.history.pushState(stateObj, '', document.URL);
        }
      },

      get isHashChangeUnlocked() {
        if (!this.initialized) {
          return true;
        }
        // If the current hash changes when moving back/forward in the history,
        // this will trigger a 'popstate' event *as well* as a 'hashchange' event.
        // Since the hash generally won't correspond to the exact the position
        // stored in the history's state object, triggering the 'hashchange' event
        // can thus corrupt the browser history.
        //
        // When the hash changes during a 'popstate' event, we *only* prevent the
        // first 'hashchange' event and immediately reset allowHashChange.
        // If it is not reset, the user would not be able to change the hash.

        var temp = this.allowHashChange;
        this.allowHashChange = true;
        return temp;
      },

      _updatePreviousBookmark: function pdfHistory_updatePreviousBookmark() {
        if (this.updatePreviousBookmark &&
            this.currentBookmark && this.currentPage) {
          this.previousBookmark = this.currentBookmark;
          this.previousPage = this.currentPage;
          this.updatePreviousBookmark = false;
        }
      },

      updateCurrentBookmark: function pdfHistoryUpdateCurrentBookmark(bookmark,
                                                                      pageNum) {
        if (this.initialized) {
          this.currentBookmark = bookmark.substring(1);
          this.currentPage = pageNum | 0;
          this._updatePreviousBookmark();
        }
      },

      updateNextHashParam: function pdfHistoryUpdateNextHashParam(param) {
        if (this.initialized) {
          this.nextHashParam = param;
        }
      },

      push: function pdfHistoryPush(params, isInitialBookmark) {
        if (!(this.initialized && this.historyUnlocked)) {
          return;
        }
        if (params.dest && !params.hash) {
          params.hash = (this.current.hash && this.current.dest &&
                         this.current.dest === params.dest) ?
            this.current.hash :
            PDFView.getDestinationHash(params.dest).split('#')[1];
        }
        if (params.page) {
          params.page |= 0;
        }
        if (isInitialBookmark) {
          var target = window.history.state.target;
          if (!target) {
            // Invoked when the user specifies an initial bookmark,
            // thus setting PDFView.initialBookmark, when the document is loaded.
            this._pushToHistory(params, false);
            this.previousHash = window.location.hash.substring(1);
          }
          this.updatePreviousBookmark = this.nextHashParam ? false : true;
          if (target) {
            // If the current document is reloaded,
            // avoid creating duplicate entries in the history.
            this._updatePreviousBookmark();
          }
          return;
        }
        if (this.nextHashParam) {
          if (this.nextHashParam === params.hash) {
            this.nextHashParam = null;
            this.updatePreviousBookmark = true;
            return;
          } else {
            this.nextHashParam = null;
          }
        }

        if (params.hash) {
          if (this.current.hash) {
            if (this.current.hash !== params.hash) {
              this._pushToHistory(params, true);
            } else {
              if (!this.current.page && params.page) {
                this._pushToHistory(params, false, true);
              }
              this.updatePreviousBookmark = true;
            }
          } else {
            this._pushToHistory(params, true);
          }
        } else if (this.current.page && params.page &&
                   this.current.page !== params.page) {
          this._pushToHistory(params, true);
        }
      },

      _getPreviousParams: function pdfHistory_getPreviousParams(onlyCheckPage,
                                                                beforeUnload) {
        if (!(this.currentBookmark && this.currentPage)) {
          return null;
        } else if (this.updatePreviousBookmark) {
          this.updatePreviousBookmark = false;
        }
        if (this.uid > 0 && !(this.previousBookmark && this.previousPage)) {
          // Prevent the history from getting stuck in the current state,
          // effectively preventing the user from going back/forward in the history.
          //
          // This happens if the current position in the document didn't change when
          // the history was previously updated. The reasons for this are either:
          // 1. The current zoom value is such that the document does not need to,
          //    or cannot, be scrolled to display the destination.
          // 2. The previous destination is broken, and doesn't actally point to a
          //    position within the document.
          //    (This is either due to a bad PDF generator, or the user making a
          //     mistake when entering a destination in the hash parameters.)
          return null;
        }
        if ((!this.current.dest && !onlyCheckPage) || beforeUnload) {
          if (this.previousBookmark === this.currentBookmark) {
            return null;
          }
        } else if (this.current.page || onlyCheckPage) {
          if (this.previousPage === this.currentPage) {
            return null;
          }
        } else {
          return null;
        }
        var params = { hash: this.currentBookmark, page: this.currentPage };
        if (PresentationMode.active) {
          params.hash = null;
        }
        return params;
      },

      _stateObj: function pdfHistory_stateObj(params) {
        return { fingerprint: this.fingerprint, uid: this.uid, target: params };
      },

      _pushToHistory: function pdfHistory_pushToHistory(params,
                                                        addPrevious, overwrite) {
        if (!this.initialized) {
          return;
        }
        if (!params.hash && params.page) {
          params.hash = ('page=' + params.page);
        }
        if (addPrevious && !overwrite) {
          var previousParams = this._getPreviousParams();
          if (previousParams) {
            var replacePrevious = (!this.current.dest &&
                                   this.current.hash !== this.previousHash);
            this._pushToHistory(previousParams, false, replacePrevious);
          }
        }
        this._pushOrReplaceState(this._stateObj(params),
                                 (overwrite || this.uid === 0));
        this.currentUid = this.uid++;
        this.current = params;
        this.updatePreviousBookmark = true;
      },

      _goTo: function pdfHistory_goTo(state) {
        if (!(this.initialized && this.historyUnlocked &&
              this._isStateObjectDefined(state))) {
          return;
        }
        if (!this.reInitialized && state.uid < this.currentUid) {
          var previousParams = this._getPreviousParams(true);
          if (previousParams) {
            this._pushToHistory(this.current, false);
            this._pushToHistory(previousParams, false);
            this.currentUid = state.uid;
            window.history.back();
            return;
          }
        }
        this.historyUnlocked = false;

        if (state.target.dest) {
          PDFView.navigateTo(state.target.dest);
        } else {
          PDFView.setHash(state.target.hash);
        }
        this.currentUid = state.uid;
        if (state.uid > this.uid) {
          this.uid = state.uid;
        }
        this.current = state.target;
        this.updatePreviousBookmark = true;

        var currentHash = window.location.hash.substring(1);
        if (this.previousHash !== currentHash) {
          this.allowHashChange = false;
        }
        this.previousHash = currentHash;

        this.historyUnlocked = true;
      },

      back: function pdfHistoryBack() {
        this.go(-1);
      },

      forward: function pdfHistoryForward() {
        this.go(1);
      },

      go: function pdfHistoryGo(direction) {
        if (this.initialized && this.historyUnlocked) {
          var state = window.history.state;
          if (direction === -1 && state && state.uid > 0) {
            window.history.back();
          } else if (direction === 1 && state && state.uid < (this.uid - 1)) {
            window.history.forward();
          }
        }
      }
    };


    var Toolbar = {
      opened: false,
      previousContainerHeight: null,
      newContainerHeight: null,

      initialize: function toolbarInitialize(options) {
        this.toolbar = options.toolbar;
        this.presentationMode = options.presentationMode;
        this.documentProperties = options.documentProperties;
        this.buttonContainer = this.toolbar.firstElementChild;

        // Define the toolbar buttons.
        this.presentationModeButton = options.presentationModeButton;
        this.download = options.download;
        this.pageRotateCw = options.pageRotateCw;
        this.pageRotateCcw = options.pageRotateCcw;
        this.documentPropertiesButton = options.documentPropertiesButton;

        // Attach the event listeners.
        var elements = [
          // All items within the toolbar
          { element: this.presentationModeButton,
            handler: this.presentationModeClick },
          { element: this.download, handler: this.downloadClick },
          { element: this.pageRotateCw, handler: this.pageRotateCwClick },
          { element: this.pageRotateCcw, handler: this.pageRotateCcwClick },
          { element: this.documentPropertiesButton,
            handler: this.documentPropertiesClick }
        ];

        for (var item in elements) {
          var element = elements[item].element;
          if (element) {
            element.addEventListener('click', elements[item].handler.bind(this));
          }
        }
      },

      // Event handling functions.
      presentationModeClick: function toolbarPresentationModeClick(evt) {
        console.log('prez')        
        this.presentationMode.request();
        this.close();
      },

      downloadClick: function toolbarDownloadClick(evt) {
        PDFView.download();
        this.close();
      },

      pageRotateCwClick: function toolbarPageRotateCwClick(evt) {
        PDFView.rotatePages(90);
      },

      pageRotateCcwClick: function toolbarPageRotateCcwClick(evt) {
        PDFView.rotatePages(-90);
      },

      documentPropertiesClick: function toolbarDocumentPropsClick(evt) {
        this.documentProperties.show();
        this.close();
      }
    };


    var PasswordPrompt = {
      visible: false,
      updatePassword: null,
      reason: null,
      overlayContainer: null,
      passwordField: null,
      passwordText: null,
      passwordSubmit: null,
      passwordCancel: null,

      initialize: function toolbarInitialize(options) {
        this.overlayContainer = options.overlayContainer;
        this.passwordField = options.passwordField;
        this.passwordText = options.passwordText;
        this.passwordSubmit = options.passwordSubmit;
        this.passwordCancel = options.passwordCancel;

        // Attach the event listeners.
        this.passwordSubmit.addEventListener('click',
          this.verifyPassword.bind(this));

        this.passwordCancel.addEventListener('click', this.hide.bind(this));

        this.passwordField.addEventListener('keydown',
          function (e) {
            if (e.keyCode === 13) { // Enter key
              this.verifyPassword();
            }
          }.bind(this));

        window.addEventListener('keydown',
          function (e) {
            if (e.keyCode === 27) { // Esc key
              this.hide();
            }
          }.bind(this));
      },

      show: function passwordPromptShow() {
        if (this.visible) {
          return;
        }
        this.visible = true;
        this.overlayContainer.classList.remove('hidden');
        this.overlayContainer.firstElementChild.classList.remove('hidden');
        this.passwordField.focus();

        var promptString = mozL10n.get('password_label', null,
          'Enter the password to open this PDF file.');

        if (this.reason === PDFJS.PasswordResponses.INCORRECT_PASSWORD) {
          promptString = mozL10n.get('password_invalid', null,
            'Invalid password. Please try again.');
        }

        this.passwordText.textContent = promptString;
      },

      hide: function passwordPromptClose() {
        if (!this.visible) {
          return;
        }
        this.visible = false;
        this.passwordField.value = '';
        this.overlayContainer.classList.add('hidden');
        this.overlayContainer.firstElementChild.classList.add('hidden');
      },

      verifyPassword: function passwordPromptVerifyPassword() {
        var password = this.passwordField.value;
        if (password && password.length > 0) {
          this.hide();
          return this.updatePassword(password);
        }
      }
    };


    var DELAY_BEFORE_HIDING_CONTROLS = 3000; // in ms
    var SELECTOR = 'presentationControls';
    var DELAY_BEFORE_RESETTING_SWITCH_IN_PROGRESS = 1000; // in ms

    var PresentationMode = {
      active: false,
      args: null,
      contextMenuOpen: false,
      prevCoords: { x: null, y: null },

      initialize: function presentationModeInitialize(options) {
        this.container = options.container;
        this.toolbar = options.toolbar;
        this.viewer = this.container.firstElementChild;
      },

      get isFullscreen() {
        return (document.fullscreenElement ||
                document.mozFullScreen ||
                document.webkitIsFullScreen ||
                document.msFullscreenElement);
      },

      /**
       * Initialize a timeout that is used to reset PDFView.currentPosition when the
       * browser transitions to fullscreen mode. Since resize events are triggered
       * multiple times during the switch to fullscreen mode, this is necessary in
       * order to prevent the page from being scrolled partially, or completely,
       * out of view when Presentation Mode is enabled.
       * Note: This is only an issue at certain zoom levels, e.g. 'page-width'.
       */
      _setSwitchInProgress: function presentationMode_setSwitchInProgress() {
        if (this.switchInProgress) {
          clearTimeout(this.switchInProgress);
        }
        this.switchInProgress = setTimeout(function switchInProgressTimeout() {
          delete this.switchInProgress;
        }.bind(this), DELAY_BEFORE_RESETTING_SWITCH_IN_PROGRESS);

        PDFView.currentPosition = null;
      },

      _resetSwitchInProgress: function presentationMode_resetSwitchInProgress() {
        if (this.switchInProgress) {
          clearTimeout(this.switchInProgress);
          delete this.switchInProgress;
        }
      },

      request: function presentationModeRequest() {
        if (!PDFView.supportsFullscreen || this.isFullscreen ||
            !this.viewer.hasChildNodes()) {
          return false;
        }
        this._setSwitchInProgress();

        if (this.container.requestFullscreen) {
          this.container.requestFullscreen();
        } else if (this.container.mozRequestFullScreen) {
          this.container.mozRequestFullScreen();
        } else if (this.container.webkitRequestFullScreen) {
          this.container.webkitRequestFullScreen(Element.ALLOW_KEYBOARD_INPUT);
        } else if (this.container.msRequestFullscreen) {
          this.container.msRequestFullscreen();
        } else {
          return false;
        }

        this.args = {
          page: PDFView.page,
          previousScale: PDFView.currentScaleValue
        };

        return true;
      },

      enter: function presentationModeEnter() {
        this.active = true;
        this._resetSwitchInProgress();

        // Ensure that the correct page is scrolled into view when entering
        // Presentation Mode, by waiting until fullscreen mode in enabled.
        // Note: This is only necessary in non-Mozilla browsers.
        setTimeout(function enterPresentationModeTimeout() {
          PDFView.page = this.args.page;
          PDFView.setScale('page-fit', true);
        }.bind(this), 0);

        window.addEventListener('mousemove', this.mouseMove, false);
        window.addEventListener('mousedown', this.mouseDown, false);
        window.addEventListener('contextmenu', this.contextMenu, false);

        this.showControls();
        this.contextMenuOpen = false;
        this.container.setAttribute('contextmenu', 'viewerContextMenu');
      },

      exit: function presentationModeExit() {
        var page = PDFView.page;

        // Ensure that the correct page is scrolled into view when exiting
        // Presentation Mode, by waiting until fullscreen mode is disabled.
        // Note: This is only necessary in non-Mozilla browsers.
        setTimeout(function exitPresentationModeTimeout() {
          this.active = false;
          PDFView.setScale(this.args.previousScale);
          PDFView.page = page;
          this.args = null;
        }.bind(this), 0);

        window.removeEventListener('mousemove', this.mouseMove, false);
        window.removeEventListener('mousedown', this.mouseDown, false);
        window.removeEventListener('contextmenu', this.contextMenu, false);

        this.hideControls();
        PDFView.clearMouseScrollState();
        this.container.removeAttribute('contextmenu');
        this.contextMenuOpen = false;

        // Ensure that the thumbnail of the current page is visible
        // when exiting presentation mode.
        scrollIntoView($pluginInstance.find('.thumbnailContainer' + page).get(0));
      },

      showControls: function presentationModeShowControls() {
        if (this.controlsTimeout) {
          clearTimeout(this.controlsTimeout);
        } else {
          this.container.classList.add(SELECTOR);
        }
        this.controlsTimeout = setTimeout(function hideControlsTimeout() {
          this.container.classList.remove(SELECTOR);
          delete this.controlsTimeout;
        }.bind(this), DELAY_BEFORE_HIDING_CONTROLS);
      },

      hideControls: function presentationModeHideControls() {
        if (!this.controlsTimeout) {
          return;
        }
        this.container.classList.remove(SELECTOR);
        clearTimeout(this.controlsTimeout);
        delete this.controlsTimeout;
      },

      mouseMove: function presentationModeMouseMove(evt) {
        // Workaround for a bug in WebKit browsers that causes the 'mousemove' event
        // to be fired when the cursor is changed. For details, see:
        // http://code.google.com/p/chromium/issues/detail?id=103041.

        var currCoords = { x: evt.clientX, y: evt.clientY };
        var prevCoords = PresentationMode.prevCoords;
        PresentationMode.prevCoords = currCoords;

        if (currCoords.x === prevCoords.x && currCoords.y === prevCoords.y) {
          return;
        }
        PresentationMode.showControls();
      },

      mouseDown: function presentationModeMouseDown(evt) {
        var self = PresentationMode;
        if (self.contextMenuOpen) {
          self.contextMenuOpen = false;
          evt.preventDefault();
          return;
        }

        if (evt.button === 0) {
          // Enable clicking of links in presentation mode. Please note:
          // Only links pointing to destinations in the current PDF document work.
          var isInternalLink = (evt.target.href &&
                                evt.target.classList.contains('internalLink'));
          if (!isInternalLink) {
            // Unless an internal link was clicked, advance one page.
            evt.preventDefault();
            PDFView.page += (evt.shiftKey ? -1 : 1);
          }
        }
      },

      contextMenu: function presentationModeContextMenu(evt) {
        PresentationMode.contextMenuOpen = true;
      }
    };

    (function presentationModeClosure() {
      function presentationModeChange(e) {
        if (PresentationMode.isFullscreen) {
          PresentationMode.enter();
        } else {
          PresentationMode.exit();
        }
      }

      window.addEventListener('fullscreenchange', presentationModeChange, false);
      window.addEventListener('mozfullscreenchange', presentationModeChange, false);
      window.addEventListener('webkitfullscreenchange', presentationModeChange,
                              false);
      window.addEventListener('MSFullscreenChange', presentationModeChange, false);
    })();


    /* Copyright 2013 Rob Wu <gwnRob@gmail.com>
     * https://github.com/Rob--W/grab-to-pan.js
     *
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     *     http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     */

    'use strict';

    var GrabToPan = (function GrabToPanClosure() {
      /**
       * Construct a GrabToPan instance for a given HTML element.
       * @param options.element {Element}
       * @param options.ignoreTarget {function} optional. See `ignoreTarget(node)`
       * @param options.onActiveChanged {function(boolean)} optional. Called
       *  when grab-to-pan is (de)activated. The first argument is a boolean that
       *  shows whether grab-to-pan is activated.
       */
      function GrabToPan(options) {
        this.element = options.element;
        this.document = options.element.ownerDocument;
        if (typeof options.ignoreTarget === 'function') {
          this.ignoreTarget = options.ignoreTarget;
        }
        this.onActiveChanged = options.onActiveChanged;

        // Bind the contexts to ensure that `this` always points to
        // the GrabToPan instance.
        this.activate = this.activate.bind(this);
        this.deactivate = this.deactivate.bind(this);
        this.toggle = this.toggle.bind(this);
        this._onmousedown = this._onmousedown.bind(this);
        this._onmousemove = this._onmousemove.bind(this);
        this._endPan = this._endPan.bind(this);

        // This overlay will be inserted in the document when the mouse moves during
        // a grab operation, to ensure that the cursor has the desired appearance.
        var overlay = this.overlay = document.createElement('div');
        overlay.className = 'grab-to-pan-grabbing';
      }
      GrabToPan.prototype = {
        /**
         * Class name of element which can be grabbed
         */
        CSS_CLASS_GRAB: 'grab-to-pan-grab',

        /**
         * Bind a mousedown event to the element to enable grab-detection.
         */
        activate: function GrabToPan_activate() {
          if (!this.active) {
            this.active = true;
            this.element.addEventListener('mousedown', this._onmousedown, true);
            this.element.classList.add(this.CSS_CLASS_GRAB);
            if (this.onActiveChanged) {
              this.onActiveChanged(true);
            }
          }
        },

        /**
         * Removes all events. Any pending pan session is immediately stopped.
         */
        deactivate: function GrabToPan_deactivate() {
          if (this.active) {
            this.active = false;
            this.element.removeEventListener('mousedown', this._onmousedown, true);
            this._endPan();
            this.element.classList.remove(this.CSS_CLASS_GRAB);
            if (this.onActiveChanged) {
              this.onActiveChanged(false);
            }
          }
        },

        toggle: function GrabToPan_toggle() {
          if (this.active) {
            this.deactivate();
          } else {
            this.activate();
          }
        },

        /**
         * Whether to not pan if the target element is clicked.
         * Override this method to change the default behaviour.
         *
         * @param node {Element} The target of the event
         * @return {boolean} Whether to not react to the click event.
         */
        ignoreTarget: function GrabToPan_ignoreTarget(node) {
          // Use matchesSelector to check whether the clicked element
          // is (a child of) an input element / link
          return node[matchesSelector](
            'a[href], a[href] *, input, textarea, button, button *, select, option'
          );
        },

        /**
         * @private
         */
        _onmousedown: function GrabToPan__onmousedown(event) {
          if (event.button !== 0 || this.ignoreTarget(event.target)) {
            return;
          }
          if (event.originalTarget) {
            try {
              /* jshint expr:true */
              event.originalTarget.tagName;
            } catch (e) {
              // Mozilla-specific: element is a scrollbar (XUL element)
              return;
            }
          }

          this.scrollLeftStart = this.element.scrollLeft;
          this.scrollTopStart = this.element.scrollTop;
          this.clientXStart = event.clientX;
          this.clientYStart = event.clientY;
          this.document.addEventListener('mousemove', this._onmousemove, true);
          this.document.addEventListener('mouseup', this._endPan, true);
          // When a scroll event occurs before a mousemove, assume that the user
          // dragged a scrollbar (necessary for Opera Presto, Safari and IE)
          // (not needed for Chrome/Firefox)
          this.element.addEventListener('scroll', this._endPan, true);
          event.preventDefault();
          event.stopPropagation();
          this.document.documentElement.classList.add(this.CSS_CLASS_GRABBING);
        },

        /**
         * @private
         */
        _onmousemove: function GrabToPan__onmousemove(event) {
          this.element.removeEventListener('scroll', this._endPan, true);
          if (isLeftMouseReleased(event)) {
            this._endPan();
            return;
          }
          var xDiff = event.clientX - this.clientXStart;
          var yDiff = event.clientY - this.clientYStart;
          this.element.scrollTop = this.scrollTopStart - yDiff;
          this.element.scrollLeft = this.scrollLeftStart - xDiff;
          if (!this.overlay.parentNode) {
            document.body.appendChild(this.overlay);
          }
        },

        /**
         * @private
         */
        _endPan: function GrabToPan__endPan() {
          this.element.removeEventListener('scroll', this._endPan, true);
          this.document.removeEventListener('mousemove', this._onmousemove, true);
          this.document.removeEventListener('mouseup', this._endPan, true);
          if (this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
          }
        }
      };

      // Get the correct (vendor-prefixed) name of the matches method.
      var matchesSelector;
      ['webkitM', 'mozM', 'msM', 'oM', 'm'].some(function(prefix) {
        var name = prefix + 'atches';
        if (name in document.documentElement) {
          matchesSelector = name;
        }
        name += 'Selector';
        if (name in document.documentElement) {
          matchesSelector = name;
        }
        return matchesSelector; // If found, then truthy, and [].some() ends.
      });

      // Browser sniffing because it's impossible to feature-detect
      // whether event.which for onmousemove is reliable
      var isNotIEorIsIE10plus = !document.documentMode || document.documentMode > 9;
      var chrome = window.chrome;
      var isChrome15OrOpera15plus = chrome && (chrome.webstore || chrome.app);
      //                                       ^ Chrome 15+       ^ Opera 15+
      var isSafari6plus = /Apple/.test(navigator.vendor) &&
                          /Version\/([6-9]\d*|[1-5]\d+)/.test(navigator.userAgent);

      /**
       * Whether the left mouse is not pressed.
       * @param event {MouseEvent}
       * @return {boolean} True if the left mouse button is not pressed.
       *                   False if unsure or if the left mouse button is pressed.
       */
      function isLeftMouseReleased(event) {
        if ('buttons' in event && isNotIEorIsIE10plus) {
          // http://www.w3.org/TR/DOM-Level-3-Events/#events-MouseEvent-buttons
          // Firefox 15+
          // Internet Explorer 10+
          return !(event.buttons | 1);
        }
        if (isChrome15OrOpera15plus || isSafari6plus) {
          // Chrome 14+
          // Opera 15+
          // Safari 6.0+
          return event.which === 0;
        }
      }

      return GrabToPan;
    })();

    var DocumentProperties = {
      overlayContainer: null,
      fileName: '',
      fileSize: '',
      visible: false,

      // Document property fields (in the viewer).
      fileNameField: null,
      fileSizeField: null,
      titleField: null,
      authorField: null,
      subjectField: null,
      keywordsField: null,
      creationDateField: null,
      modificationDateField: null,
      creatorField: null,
      producerField: null,
      versionField: null,
      pageCountField: null,

      initialize: function documentPropertiesInitialize(options) {
        this.overlayContainer = options.overlayContainer;

        // Set the document property fields.
        this.fileNameField = options.fileNameField;
        this.fileSizeField = options.fileSizeField;
        this.titleField = options.titleField;
        this.authorField = options.authorField;
        this.subjectField = options.subjectField;
        this.keywordsField = options.keywordsField;
        this.creationDateField = options.creationDateField;
        this.modificationDateField = options.modificationDateField;
        this.creatorField = options.creatorField;
        this.producerField = options.producerField;
        this.versionField = options.versionField;
        this.pageCountField = options.pageCountField;

        // Bind the event listener for the Close button.
        if (options.closeButton) {
          options.closeButton.addEventListener('click', this.hide.bind(this));
        }

        this.dataAvailablePromise = new Promise(function (resolve) {
          this.resolveDataAvailable = resolve;
        }.bind(this));

        // Bind the event listener for the Esc key (to close the dialog).
        window.addEventListener('keydown',
          function (e) {
            if (e.keyCode === 27) { // Esc key
              this.hide();
            }
          }.bind(this));
      },

      getProperties: function documentPropertiesGetProperties() {
        if (!this.visible) {
          // If the dialog was closed before dataAvailablePromise was resolved,
          // don't bother updating the properties.
          return;
        }
        // Get the file name.
        this.fileName = getPDFFileNameFromURL(PDFView.url);

        // Get the file size.
        PDFView.pdfDocument.getDownloadInfo().then(function(data) {
          this.setFileSize(data.length);
          this.updateUI(this.fileSizeField, this.fileSize);
        }.bind(this));

        // Get the other document properties.
        PDFView.pdfDocument.getMetadata().then(function(data) {
          var fields = [
            { field: this.fileNameField, content: this.fileName },
            // The fileSize field is updated once getDownloadInfo is resolved.
            { field: this.titleField, content: data.info.Title },
            { field: this.authorField, content: data.info.Author },
            { field: this.subjectField, content: data.info.Subject },
            { field: this.keywordsField, content: data.info.Keywords },
            { field: this.creationDateField,
              content: this.parseDate(data.info.CreationDate) },
            { field: this.modificationDateField,
              content: this.parseDate(data.info.ModDate) },
            { field: this.creatorField, content: data.info.Creator },
            { field: this.producerField, content: data.info.Producer },
            { field: this.versionField, content: data.info.PDFFormatVersion },
            { field: this.pageCountField, content: PDFView.pdfDocument.numPages }
          ];

          // Show the properties in the dialog.
          for (var item in fields) {
            var element = fields[item];
            this.updateUI(element.field, element.content);
          }
        }.bind(this));
      },

      updateUI: function documentPropertiesUpdateUI(field, content) {
        if (field && content !== undefined && content !== '') {
          field.textContent = content;
        }
      },

      setFileSize: function documentPropertiesSetFileSize(fileSize) {
        var kb = fileSize / 1024;
        if (kb < 1024) {
          this.fileSize = mozL10n.get('document_properties_kb', {
            size_kb: (+kb.toPrecision(3)).toLocaleString(),
            size_b: fileSize.toLocaleString()
          }, '{{size_kb}} KB ({{size_b}} bytes)');
        } else {
          this.fileSize = mozL10n.get('document_properties_mb', {
            size_mb: (+(kb / 1024).toPrecision(3)).toLocaleString(),
            size_b: fileSize.toLocaleString()
          }, '{{size_mb}} MB ({{size_b}} bytes)');
        }
      },

      show: function documentPropertiesShow() {
        if (this.visible) {
          return;
        }
        this.visible = true;
        this.overlayContainer.classList.remove('hidden');
        this.overlayContainer.lastElementChild.classList.remove('hidden');

        this.dataAvailablePromise.then(function () {
          this.getProperties();
        }.bind(this));
      },

      hide: function documentPropertiesClose() {
        if (!this.visible) {
          return;
        }
        this.visible = false;
        this.overlayContainer.classList.add('hidden');
        this.overlayContainer.lastElementChild.classList.add('hidden');
      },

      parseDate: function documentPropertiesParseDate(inputDate) {
        // This is implemented according to the PDF specification (see
        // http://www.gnupdf.org/Date for an overview), but note that 
        // Adobe Reader doesn't handle changing the date to universal time
        // and doesn't use the user's time zone (they're effectively ignoring
        // the HH' and mm' parts of the date string).
        var dateToParse = inputDate;
        if (dateToParse === undefined) {
          return '';
        }

        // Remove the D: prefix if it is available.
        if (dateToParse.substring(0,2) === 'D:') {
          dateToParse = dateToParse.substring(2);
        }

        // Get all elements from the PDF date string.
        // JavaScript's Date object expects the month to be between
        // 0 and 11 instead of 1 and 12, so we're correcting for this.
        var year = parseInt(dateToParse.substring(0,4), 10);
        var month = parseInt(dateToParse.substring(4,6), 10) - 1;
        var day = parseInt(dateToParse.substring(6,8), 10);
        var hours = parseInt(dateToParse.substring(8,10), 10);
        var minutes = parseInt(dateToParse.substring(10,12), 10);
        var seconds = parseInt(dateToParse.substring(12,14), 10);
        var utRel = dateToParse.substring(14,15);
        var offsetHours = parseInt(dateToParse.substring(15,17), 10);
        var offsetMinutes = parseInt(dateToParse.substring(18,20), 10);

        // As per spec, utRel = 'Z' means equal to universal time.
        // The other cases ('-' and '+') have to be handled here.
        if (utRel == '-') {
          hours += offsetHours;
          minutes += offsetMinutes;
        } else if (utRel == '+') {
          hours -= offsetHours;
          minutes += offsetMinutes;
        }

        // Return the new date format from the user's locale.
        var date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
        var dateString = date.toLocaleDateString();
        var timeString = date.toLocaleTimeString();
        return mozL10n.get('document_properties_date_string',
                           {date: dateString, time: timeString},
                           '{{date}}, {{time}}');
      }
    };


    var PDFView = {
      pages: [],
      thumbnails: [],
      currentScale: UNKNOWN_SCALE,
      currentScaleValue: null,
      initialBookmark: document.location.hash.substring(1),
      container: null,
      thumbnailContainer: null,
      initialized: false,
      fellback: false,
      pdfDocument: null,
      sidebarOpen: false,
      pageViewScroll: null,
      thumbnailViewScroll: null,
      pageRotation: 0,
      mouseScrollTimeStamp: 0,
      mouseScrollDelta: 0,
      lastScroll: 0,
      previousPageNumber: 1,
      isViewerEmbedded: (window.parent !== window),
      idleTimeout: null,
      currentPosition: null,

      // called once when the document is loaded
      initialize: function pdfViewInitialize() {
        var self = this;
        var container = this.container = $pluginInstance.find('.viewerContainer').get(0);
        this.pageViewScroll = {};
        this.watchScroll(container, this.pageViewScroll, updateViewarea);

        var thumbnailContainer = this.thumbnailContainer =
                                 $pluginInstance.find('.thumbnailView').get(0);
        this.thumbnailViewScroll = {};
        this.watchScroll(thumbnailContainer, this.thumbnailViewScroll,
                         this.renderHighestPriority.bind(this));

        Preferences.initialize();

        PDFFindBar.initialize({
          bar: $pluginInstance.find('.findbar').get(0),
          toggleButton: $pluginInstance.find('.viewFind').get(0),
          findField: $pluginInstance.find('.findInput').get(0),
          highlightAllCheckbox: $pluginInstance.find('.findHighlightAll').get(0),
          caseSensitiveCheckbox: $pluginInstance.find('.findMatchCase').get(0),
          findMsg: $pluginInstance.find('.findMsg').get(0),
          findStatusIcon: $pluginInstance.find('.findStatusIcon').get(0),
          findPreviousButton: $pluginInstance.find('.findPrevious').get(0),
          findNextButton: $pluginInstance.find('.findNext').get(0)
        });

        PDFFindController.initialize({
          pdfPageSource: this,
          integratedFind: this.supportsIntegratedFind
        });

        Toolbar.initialize({
          toolbar: $pluginInstance.find('.toolbar').get(0),
          presentationMode: PresentationMode,
          presentationModeButton: $pluginInstance.find('.presentationMode').get(0),
          download: $pluginInstance.find('.download').get(0),
          pageRotateCw: $pluginInstance.find('.pageRotateCw').get(0),
          pageRotateCcw: $pluginInstance.find('.pageRotateCcw').get(0),
          documentProperties: DocumentProperties,
          documentPropertiesButton: $pluginInstance.find('.documentProperties').get(0)
        });

        PasswordPrompt.initialize({
          overlayContainer: $pluginInstance.find('.overlayContainer').get(0),
          passwordField: $pluginInstance.find('.password').get(0),
          passwordText: $pluginInstance.find('.passwordText').get(0),
          passwordSubmit: $pluginInstance.find('.passwordSubmit').get(0),
          passwordCancel: $pluginInstance.find('.passwordCancel').get(0)
        });

        PresentationMode.initialize({
          container: container,
          toolbar: Toolbar
        });

        DocumentProperties.initialize({
          overlayContainer: $pluginInstance.find('.overlayContainer').get(0),
          closeButton: $pluginInstance.find('.documentPropertiesClose').get(0),
          fileNameField: $pluginInstance.find('.fileNameField').get(0),
          fileSizeField: $pluginInstance.find('.fileSizeField').get(0),
          titleField: $pluginInstance.find('.titleField').get(0),
          authorField: $pluginInstance.find('.authorField').get(0),
          subjectField: $pluginInstance.find('.subjectField').get(0),
          keywordsField: $pluginInstance.find('.keywordsField').get(0),
          creationDateField: $pluginInstance.find('.creationDateField').get(0),
          modificationDateField: $pluginInstance.find('.modificationDateField').get(0),
          creatorField: $pluginInstance.find('.creatorField').get(0),
          producerField: $pluginInstance.find('.producerField').get(0),
          versionField: $pluginInstance.find('.versionField').get(0),
          pageCountField: $pluginInstance.find('.pageCountField').get(0)
        });

        container.addEventListener('scroll', function() {
          self.lastScroll = Date.now();
        }, false);

        var initializedPromise = Promise.all([
          Preferences.get('enableWebGL').then(function (value) {
            PDFJS.disableWebGL = !value;
          })
          // TODO move more preferences and other async stuff here
        ]);

        return initializedPromise.then(function () {
          PDFView.initialized = true;
        });
      },

      getPage: function pdfViewGetPage(n) {
        return this.pdfDocument.getPage(n);
      },

      // Helper function to keep track whether a div was scrolled up or down and
      // then call a callback.
      watchScroll: function pdfViewWatchScroll(viewAreaElement, state, callback) {
        state.down = true;
        state.lastY = viewAreaElement.scrollTop;
        viewAreaElement.addEventListener('scroll', function webViewerScroll(evt) {
          var currentY = viewAreaElement.scrollTop;
          var lastY = state.lastY;
          if (currentY > lastY) {
            state.down = true;
          } else if (currentY < lastY) {
            state.down = false;
          }
          // else do nothing and use previous value
          state.lastY = currentY;
          callback();
        }, true);
      },

      _setScaleUpdatePages: function pdfView_setScaleUpdatePages(
          newScale, newValue, resetAutoSettings, noScroll) {
        this.currentScaleValue = newValue;
        if (newScale === this.currentScale) {
          return;
        }
        for (var i = 0, ii = this.pages.length; i < ii; i++) {
          this.pages[i].update(newScale);
        }
        this.currentScale = newScale;

        if (!noScroll) {
          var page = this.page, dest;
          if (this.currentPosition && !IGNORE_CURRENT_POSITION_ON_ZOOM) {
            page = this.currentPosition.page;
            dest = [null, { name: 'XYZ' }, this.currentPosition.left,
                    this.currentPosition.top, null];
          }
          this.pages[page - 1].scrollIntoView(dest);
        }
        var event = document.createEvent('UIEvents');
        event.initUIEvent('scalechange', false, false, window, 0);
        event.scale = newScale;
        event.resetAutoSettings = resetAutoSettings;
        $pluginInstance.get(0).dispatchEvent(event);
      },

      setScale: function pdfViewSetScale(value, resetAutoSettings, noScroll) {
        if (value === 'custom') {
          return;
        }
        var scale = parseFloat(value);

        if (scale > 0) {
          this._setScaleUpdatePages(scale, value, true, noScroll);
        } else {
          var currentPage = this.pages[this.page - 1];
          if (!currentPage) {
            return;
          }
          var hPadding = PresentationMode.active ? 0 : SCROLLBAR_PADDING;
          var vPadding = PresentationMode.active ? 0 : VERTICAL_PADDING;
          var pageWidthScale = (this.container.clientWidth - hPadding) /
                                currentPage.width * currentPage.scale;
          var pageHeightScale = (this.container.clientHeight - vPadding) /
                                 currentPage.height * currentPage.scale;
          switch (value) {
            case 'page-actual':
              scale = 1;
              break;
            case 'page-width':
              scale = pageWidthScale;
              break;
            case 'page-height':
              scale = pageHeightScale;
              break;
            case 'page-fit':
              scale = Math.min(pageWidthScale, pageHeightScale);
              break;
            case 'auto':
              scale = Math.min(MAX_AUTO_SCALE, pageWidthScale);
              break;
            default:
              console.error('pdfViewSetScale: \'' + value +
                            '\' is an unknown zoom value.');
              return;
          }
          this._setScaleUpdatePages(scale, value, resetAutoSettings, noScroll);

          selectScaleOption(value);
        }
      },

      zoomIn: function pdfViewZoomIn(ticks) {
        var newScale = this.currentScale;
        do {
          newScale = (newScale * DEFAULT_SCALE_DELTA).toFixed(2);
          newScale = Math.ceil(newScale * 10) / 10;
          newScale = Math.min(MAX_SCALE, newScale);
        } while (--ticks && newScale < MAX_SCALE);
        this.setScale(newScale, true);
      },

      zoomOut: function pdfViewZoomOut(ticks) {
        var newScale = this.currentScale;
        do {
          newScale = (newScale / DEFAULT_SCALE_DELTA).toFixed(2);
          newScale = Math.floor(newScale * 10) / 10;
          newScale = Math.max(MIN_SCALE, newScale);
        } while (--ticks && newScale > MIN_SCALE);
        this.setScale(newScale, true);
      },

      set page(val) {
        var pages = this.pages;
        var event = document.createEvent('UIEvents');
        event.initUIEvent('pagechange', false, false, window, 0);

        if (!(0 < val && val <= pages.length)) {
          this.previousPageNumber = val;
          event.pageNumber = this.page;
          $pluginInstance.get(0).dispatchEvent(event);
          return;
        }

        pages[val - 1].updateStats();
        this.previousPageNumber = currentPageNumber;
        currentPageNumber = val;
        event.pageNumber = val;
        $pluginInstance.get(0).dispatchEvent(event);

        // checking if the this.page was called from the updateViewarea function:
        // avoiding the creation of two "set page" method (internal and public)
        if (updateViewarea.inProgress) {
          return;
        }
        // Avoid scrolling the first page during loading
        if (this.loading && val === 1) {
          return;
        }
        pages[val - 1].scrollIntoView();
      },

      get page() {
        return currentPageNumber;
      },

      get supportsFullscreen() {
        var doc = document.documentElement;
        var support = doc.requestFullscreen || doc.mozRequestFullScreen ||
                      doc.webkitRequestFullScreen || doc.msRequestFullscreen;

        if (document.fullscreenEnabled === false ||
            document.mozFullScreenEnabled === false ||
            document.webkitFullscreenEnabled === false ||
            document.msFullscreenEnabled === false) {
          support = false;
        }

        Object.defineProperty(this, 'supportsFullscreen', { value: support,
                                                            enumerable: true,
                                                            configurable: true,
                                                            writable: false });
        return support;
      },

      get supportsIntegratedFind() {
        var support = false;
        Object.defineProperty(this, 'supportsIntegratedFind', { value: support,
                                                                enumerable: true,
                                                                configurable: true,
                                                                writable: false });
        return support;
      },

      get supportsDocumentFonts() {
        var support = true;
        Object.defineProperty(this, 'supportsDocumentFonts', { value: support,
                                                               enumerable: true,
                                                               configurable: true,
                                                               writable: false });
        return support;
      },

      get supportsDocumentColors() {
        var support = true;
        Object.defineProperty(this, 'supportsDocumentColors', { value: support,
                                                                enumerable: true,
                                                                configurable: true,
                                                                writable: false });
        return support;
      },

      get loadingBar() {
        var bar = new ProgressBar('.loadingBar', {});
        Object.defineProperty(this, 'loadingBar', { value: bar,
                                                    enumerable: true,
                                                    configurable: true,
                                                    writable: false });
        return bar;
      },

      get isHorizontalScrollbarEnabled() {
        return (PresentationMode.active ? false :
                (this.container.scrollWidth > this.container.clientWidth));
      },

      close: function pdfViewClose() {
        var errorWrapper = $pluginInstance.find('.errorWrapper').get(0);
        errorWrapper.setAttribute('hidden', 'true');

        if (!this.pdfDocument) {
          return;
        }

        this.pdfDocument.destroy();
        this.pdfDocument = null;

        var thumbsView = $pluginInstance.find('.thumbnailView').get(0);
        while (thumbsView.hasChildNodes()) {
          thumbsView.removeChild(thumbsView.lastChild);
        }

        if ('_loadingInterval' in thumbsView) {
          clearInterval(thumbsView._loadingInterval);
        }

        var container = $pluginInstance.find('.viewer').get(0);
        while (container.hasChildNodes()) {
          container.removeChild(container.lastChild);
        }

        if (typeof PDFBug !== 'undefined') {
          PDFBug.cleanup();
        }
      },

      // TODO(mack): This function signature should really be pdfViewOpen(url, args)
      open: function pdfViewOpen(url, scale, password,
                                 pdfDataRangeTransport, args) {
        if (this.pdfDocument) {
          // Reload the preferences if a document was previously opened.
          Preferences.reload();
        }
        this.close();

        var parameters = {password: password};
        if (typeof url === 'string') { // URL
          this.url = url;
          parameters.url = url;
        } else if (url && 'byteLength' in url) { // ArrayBuffer
          parameters.data = url;
        }
        if (args) {
          for (var prop in args) {
            parameters[prop] = args[prop];
          }
        }

        var self = this;
        self.loading = true;
        self.downloadComplete = false;

        var passwordNeeded = function passwordNeeded(updatePassword, reason) {
          PasswordPrompt.updatePassword = updatePassword;
          PasswordPrompt.reason = reason;
          PasswordPrompt.show();
        };

        function getDocumentProgress(progressData) {
          self.progress(progressData.loaded / progressData.total);
        }

        PDFJS.getDocument(parameters, pdfDataRangeTransport, passwordNeeded,
                          getDocumentProgress).then(
          function getDocumentCallback(pdfDocument) {
            self.load(pdfDocument, scale);
            self.loading = false;
          },
          function getDocumentError(message, exception) {
            var loadingErrorMessage = mozL10n.get('loading_error', null,
              'An error occurred while loading the PDF.');

            if (exception && exception.name === 'InvalidPDFException') {
              // change error message also for other builds
              loadingErrorMessage = mozL10n.get('invalid_file_error', null,
                                            'Invalid or corrupted PDF file.');
            }

            if (exception && exception.name === 'MissingPDFException') {
              // special message for missing PDF's
              loadingErrorMessage = mozL10n.get('missing_file_error', null,
                                            'Missing PDF file.');

            }

            var moreInfo = {
              message: message
            };
            self.error(loadingErrorMessage, moreInfo);
            self.loading = false;
          }
        );
      },

      download: function pdfViewDownload() {
        function downloadByUrl() {
          downloadManager.downloadUrl(url, filename);
        }

        console.log(this.url)
        var url = this.url.split('#')[0];
        var filename = getPDFFileNameFromURL(url);
        var downloadManager = new DownloadManager();
        downloadManager.onerror = function (err) {
          // This error won't really be helpful because it's likely the
          // fallback won't work either (or is already open).
          PDFView.error('PDF failed to download.');
        };

        if (!this.pdfDocument) { // the PDF is not ready yet
          downloadByUrl();
          return;
        }

        if (!this.downloadComplete) { // the PDF is still downloading
          downloadByUrl();
          return;
        }

        this.pdfDocument.getData().then(
          function getDataSuccess(data) {
            var blob = PDFJS.createBlob(data, 'application/pdf');
            downloadManager.download(blob, url, filename);
          },
          downloadByUrl // Error occurred try downloading with just the url.
        ).then(null, downloadByUrl);
      },

      fallback: function pdfViewFallback(featureId) {
        return;
      },

      navigateTo: function pdfViewNavigateTo(dest) {
        var destString = '';
        var self = this;

        var goToDestination = function(destRef) {
          self.pendingRefStr = null;
          // dest array looks like that: <page-ref> </XYZ|FitXXX> <args..>
          var pageNumber = destRef instanceof Object ?
            self.pagesRefMap[destRef.num + ' ' + destRef.gen + ' R'] :
            (destRef + 1);
          if (pageNumber) {
            if (pageNumber > self.pages.length) {
              pageNumber = self.pages.length;
            }
            var currentPage = self.pages[pageNumber - 1];
            currentPage.scrollIntoView(dest);

            // Update the browsing history.
            PDFHistory.push({ dest: dest, hash: destString, page: pageNumber });
          } else {
            self.pdfDocument.getPageIndex(destRef).then(function (pageIndex) {
              var pageNum = pageIndex + 1;
              self.pagesRefMap[destRef.num + ' ' + destRef.gen + ' R'] = pageNum;
              goToDestination(destRef);
            });
          }
        };

        this.destinationsPromise.then(function() {
          if (typeof dest === 'string') {
            destString = dest;
            dest = self.destinations[dest];
          }
          if (!(dest instanceof Array)) {
            return; // invalid destination
          }
          goToDestination(dest[0]);
        });
      },

      getDestinationHash: function pdfViewGetDestinationHash(dest) {
        if (typeof dest === 'string') {
          return PDFView.getAnchorUrl('#' + escape(dest));
        }
        if (dest instanceof Array) {
          var destRef = dest[0]; // see navigateTo method for dest format
          var pageNumber = destRef instanceof Object ?
            this.pagesRefMap[destRef.num + ' ' + destRef.gen + ' R'] :
            (destRef + 1);
          if (pageNumber) {
            var pdfOpenParams = PDFView.getAnchorUrl('#page=' + pageNumber);
            var destKind = dest[1];
            if (typeof destKind === 'object' && 'name' in destKind &&
                destKind.name == 'XYZ') {
              var scale = (dest[4] || this.currentScaleValue);
              var scaleNumber = parseFloat(scale);
              if (scaleNumber) {
                scale = scaleNumber * 100;
              }
              pdfOpenParams += '&zoom=' + scale;
              if (dest[2] || dest[3]) {
                pdfOpenParams += ',' + (dest[2] || 0) + ',' + (dest[3] || 0);
              }
            }
            return pdfOpenParams;
          }
        }
        return '';
      },

      /**
       * Prefix the full url on anchor links to make sure that links are resolved
       * relative to the current URL instead of the one defined in <base href>.
       * @param {String} anchor The anchor hash, including the #.
       */
      getAnchorUrl: function getAnchorUrl(anchor) {
        return anchor;
      },

      /**
       * Show the error box.
       * @param {String} message A message that is human readable.
       * @param {Object} moreInfo (optional) Further information about the error
       *                            that is more technical.  Should have a 'message'
       *                            and optionally a 'stack' property.
       */
      error: function pdfViewError(message, moreInfo) {
        var moreInfoText = mozL10n.get('error_version_info',
          {version: PDFJS.version || '?', build: PDFJS.build || '?'},
          'PDF.js v{{version}} (build: {{build}})') + '\n';
        if (moreInfo) {
          moreInfoText +=
            mozL10n.get('error_message', {message: moreInfo.message},
            'Message: {{message}}');
          if (moreInfo.stack) {
            moreInfoText += '\n' +
              mozL10n.get('error_stack', {stack: moreInfo.stack},
              'Stack: {{stack}}');
          } else {
            if (moreInfo.filename) {
              moreInfoText += '\n' +
                mozL10n.get('error_file', {file: moreInfo.filename},
                'File: {{file}}');
            }
            if (moreInfo.lineNumber) {
              moreInfoText += '\n' +
                mozL10n.get('error_line', {line: moreInfo.lineNumber},
                'Line: {{line}}');
            }
          }
        }

        var errorWrapper = $pluginInstance.find('.errorWrapper').get(0);
        errorWrapper.removeAttribute('hidden');

        var errorMessage = $pluginInstance.find('.errorMessage').get(0);
        errorMessage.textContent = message;

        var closeButton = $pluginInstance.find('.errorClose').get(0);
        closeButton.onclick = function() {
          errorWrapper.setAttribute('hidden', 'true');
        };

        var errorMoreInfo = $pluginInstance.find('.errorMoreInfo').get(0);
        var moreInfoButton = $pluginInstance.find('.errorShowMore').get(0);
        var lessInfoButton = $pluginInstance.find('.errorShowLess').get(0);
        moreInfoButton.onclick = function() {
          errorMoreInfo.removeAttribute('hidden');
          moreInfoButton.setAttribute('hidden', 'true');
          lessInfoButton.removeAttribute('hidden');
          errorMoreInfo.style.height = errorMoreInfo.scrollHeight + 'px';
        };
        lessInfoButton.onclick = function() {
          errorMoreInfo.setAttribute('hidden', 'true');
          moreInfoButton.removeAttribute('hidden');
          lessInfoButton.setAttribute('hidden', 'true');
        };
        moreInfoButton.oncontextmenu = noContextMenuHandler;
        lessInfoButton.oncontextmenu = noContextMenuHandler;
        closeButton.oncontextmenu = noContextMenuHandler;
        moreInfoButton.removeAttribute('hidden');
        lessInfoButton.setAttribute('hidden', 'true');
        errorMoreInfo.value = moreInfoText;
      },

      progress: function pdfViewProgress(level) {
        var percent = Math.round(level * 100);
        // When we transition from full request to range requests, it's possible
        // that we discard some of the loaded data. This can cause the loading
        // bar to move backwards. So prevent this by only updating the bar if it
        // increases.
        if (percent > PDFView.loadingBar.percent) {
          PDFView.loadingBar.percent = percent;
        }
      },

      load: function pdfViewLoad(pdfDocument, scale) {
        var self = this;
        var isOnePageRenderedResolved = false;
        var resolveOnePageRendered = null;
        var onePageRendered = new Promise(function (resolve) {
          resolveOnePageRendered = resolve;
        });
        function bindOnAfterDraw(pageView, thumbnailView) {
          // when page is painted, using the image as thumbnail base
          pageView.onAfterDraw = function pdfViewLoadOnAfterDraw() {
            if (!isOnePageRenderedResolved) {
              isOnePageRenderedResolved = true;
              resolveOnePageRendered();
            }
            thumbnailView.setImage(pageView.canvas);
          };
        }

        PDFFindController.reset();

        this.pdfDocument = pdfDocument;

        DocumentProperties.resolveDataAvailable();

        var downloadedPromise = pdfDocument.getDownloadInfo().then(function() {
          self.downloadComplete = true;
          PDFView.loadingBar.hide();
          var outerContainer = $pluginInstance.find('.outerContainer').get(0);
          outerContainer.classList.remove('loadingInProgress');
        });

        var pagesCount = pdfDocument.numPages;

        var id = pdfDocument.fingerprint;
        $pluginInstance.find('.numPages').get(0).textContent =
          mozL10n.get('page_of', {pageCount: pagesCount}, 'of {{pageCount}}');
        $pluginInstance.find('.pageNumber').get(0).max = pagesCount;

        PDFView.documentFingerprint = id;
        var store = PDFView.store = new ViewHistory(id);

        this.pageRotation = 0;

        var pages = this.pages = [];
        var pagesRefMap = this.pagesRefMap = {};
        var thumbnails = this.thumbnails = [];

        var resolvePagesPromise;
        var pagesPromise = new Promise(function (resolve) {
          resolvePagesPromise = resolve;
        });
        this.pagesPromise = pagesPromise;

        var firstPagePromise = pdfDocument.getPage(1);
        var container = $pluginInstance.find('.viewer').get(0);
        var thumbsView = $pluginInstance.find('.thumbnailView').get(0);

        // Fetch a single page so we can get a viewport that will be the default
        // viewport for all pages
        firstPagePromise.then(function(pdfPage) {
          var viewport = pdfPage.getViewport((scale || 1.0) * CSS_UNITS);
          for (var pageNum = 1; pageNum <= pagesCount; ++pageNum) {
            var viewportClone = viewport.clone();
            var pageView = new PageView(container, pageNum, scale,
                                        self.navigateTo.bind(self),
                                        viewportClone);
            var thumbnailView = new ThumbnailView(thumbsView, pageNum,
                                                  viewportClone);
            bindOnAfterDraw(pageView, thumbnailView);
            pages.push(pageView);
            thumbnails.push(thumbnailView);
          }

          // Fetch all the pages since the viewport is needed before printing
          // starts to create the correct size canvas. Wait until one page is
          // rendered so we don't tie up too many resources early on.
          onePageRendered.then(function () {
            if (!PDFJS.disableAutoFetch) {
              var getPagesLeft = pagesCount;
              for (var pageNum = 1; pageNum <= pagesCount; ++pageNum) {
                pdfDocument.getPage(pageNum).then(function (pageNum, pdfPage) {
                  var pageView = pages[pageNum - 1];
                  if (!pageView.pdfPage) {
                    pageView.setPdfPage(pdfPage);
                  }
                  var refStr = pdfPage.ref.num + ' ' + pdfPage.ref.gen + ' R';
                  pagesRefMap[refStr] = pageNum;
                  getPagesLeft--;
                  if (!getPagesLeft) {
                    resolvePagesPromise();
                  }
                }.bind(null, pageNum));
              }
            } else {
              // XXX: Printing is semi-broken with auto fetch disabled.
              resolvePagesPromise();
            }
          });

          downloadedPromise.then(function () {
            var event = document.createEvent('CustomEvent');
            event.initCustomEvent('documentload', true, true, {});
            window.dispatchEvent(event);
          });

          PDFView.loadingBar.setWidth(container);

          PDFFindController.resolveFirstPage();

          // Initialize the browsing history.
          PDFHistory.initialize(self.documentFingerprint);
        });

        // Fetch the necessary preference values.
        var showPreviousViewOnLoad;
        var showPreviousViewOnLoadPromise =
          Preferences.get('showPreviousViewOnLoad').then(function (prefValue) {
            showPreviousViewOnLoad = prefValue;
          });
        var defaultZoomValue;
        var defaultZoomValuePromise =
          Preferences.get('defaultZoomValue').then(function (prefValue) {
            defaultZoomValue = prefValue;
          });

        var storePromise = store.initializedPromise;
        Promise.all([firstPagePromise, storePromise, showPreviousViewOnLoadPromise,
                     defaultZoomValuePromise]).then(function resolved() {
          var storedHash = null;
          if (showPreviousViewOnLoad && store.get('exists', false)) {
            var pageNum = store.get('page', '1');
            var zoom = defaultZoomValue || store.get('zoom', PDFView.currentScale);
            var left = store.get('scrollLeft', '0');
            var top = store.get('scrollTop', '0');

            storedHash = 'page=' + pageNum + '&zoom=' + zoom + ',' +
                         left + ',' + top;
          } else if (defaultZoomValue) {
            storedHash = 'page=1&zoom=' + defaultZoomValue;
          }
          self.setInitialView(storedHash, scale);

          // Make all navigation keys work on document load,
          // unless the viewer is embedded in a web page.
          if (!self.isViewerEmbedded) {
            self.container.focus();
          }
        }, function rejected(errorMsg) {
          console.error(errorMsg);

          firstPagePromise.then(function () {
            self.setInitialView(null, scale);
          });
        });

        var destinationsPromise =
          this.destinationsPromise = pdfDocument.getDestinations();
        destinationsPromise.then(function(destinations) {
          self.destinations = destinations;
        });

        // outline depends on destinations and pagesRefMap
        var promises = [pagesPromise, destinationsPromise,
                        PDFView.animationStartedPromise];
        Promise.all(promises).then(function() {
          pdfDocument.getOutline().then(function(outline) {
            self.outline = new DocumentOutlineView(outline);
            $pluginInstance.find('.viewOutline').get(0).disabled = !outline;

            if (outline) {
              Preferences.get('ifAvailableShowOutlineOnLoad').then(
                function (prefValue) {
                  if (prefValue) {
                    if (!self.sidebarOpen) {
                      $pluginInstance.find('.sidebarToggle').get(0).click();
                    }
                    self.switchSidebarView('outline');
                  }
                });
            }
          });
          pdfDocument.getAttachments().then(function(attachments) {
            self.attachments = new DocumentAttachmentsView(attachments);
            $pluginInstance.find('.viewAttachments').get(0).disabled = !attachments;
          });
        });

        pdfDocument.getMetadata().then(function(data) {
          var info = data.info, metadata = data.metadata;
          self.documentInfo = info;
          self.metadata = metadata;

          // Provides some basic debug information
          console.log('PDF ' + pdfDocument.fingerprint + ' [' +
                      info.PDFFormatVersion + ' ' + (info.Producer || '-').trim() +
                      ' / ' + (info.Creator || '-').trim() + ']' +
                      ' (PDF.js: ' + (PDFJS.version || '-') +
                      (!PDFJS.disableWebGL ? ' [WebGL]' : '') + ')');

          var pdfTitle;
          if (metadata && metadata.has('dc:title')) {
            pdfTitle = metadata.get('dc:title');
          }

          if (!pdfTitle && info && info['Title']) {
            pdfTitle = info['Title'];
          }

          if (info.IsAcroFormPresent) {
            console.warn('Warning: AcroForm/XFA is not supported');
            PDFView.fallback(PDFJS.UNSUPPORTED_FEATURES.forms);
          }

        });
      },

      setInitialView: function pdfViewSetInitialView(storedHash, scale) {
        // Reset the current scale, as otherwise the page's scale might not get
        // updated if the zoom level stayed the same.
        this.currentScale = 0;
        this.currentScaleValue = null;
        // When opening a new file (when one is already loaded in the viewer):
        // Reset 'currentPageNumber', since otherwise the page's scale will be wrong
        // if 'currentPageNumber' is larger than the number of pages in the file.
        $pluginInstance.find('.pageNumber').get(0).value = currentPageNumber = 1;
        // Reset the current position when loading a new file,
        // to prevent displaying the wrong position in the document.
        this.currentPosition = null;

        if (PDFHistory.initialDestination) {
          this.navigateTo(PDFHistory.initialDestination);
          PDFHistory.initialDestination = null;
        } else if (this.initialBookmark) {
          this.setHash(this.initialBookmark);
          PDFHistory.push({ hash: this.initialBookmark }, !!this.initialBookmark);
          this.initialBookmark = null;
        } else if (storedHash) {
          this.setHash(storedHash);
        } else if (scale) {
          this.setScale(scale, true);
          this.page = 1;
        }

        if (PDFView.currentScale === UNKNOWN_SCALE) {
          // Scale was not initialized: invalid bookmark or scale was not specified.
          // Setting the default one.
          this.setScale(DEFAULT_SCALE, true);
        }
      },

      renderHighestPriority: function pdfViewRenderHighestPriority() {
        if (PDFView.idleTimeout) {
          clearTimeout(PDFView.idleTimeout);
          PDFView.idleTimeout = null;
        }

        // Pages have a higher priority than thumbnails, so check them first.
        var visiblePages = this.getVisiblePages();
        var pageView = this.getHighestPriority(visiblePages, this.pages,
                                               this.pageViewScroll.down);
        if (pageView) {
          this.renderView(pageView, 'page');
          return;
        }
        // No pages needed rendering so check thumbnails.
        if (this.sidebarOpen) {
          var visibleThumbs = this.getVisibleThumbs();
          var thumbView = this.getHighestPriority(visibleThumbs,
                                                  this.thumbnails,
                                                  this.thumbnailViewScroll.down);
          if (thumbView) {
            this.renderView(thumbView, 'thumbnail');
            return;
          }
        }

        PDFView.idleTimeout = setTimeout(function () {
          PDFView.cleanup();
        }, CLEANUP_TIMEOUT);
      },

      cleanup: function pdfViewCleanup() {
        for (var i = 0, ii = this.pages.length; i < ii; i++) {
          if (this.pages[i] &&
              this.pages[i].renderingState !== RenderingStates.FINISHED) {
            this.pages[i].reset();
          }
        }
        this.pdfDocument.cleanup();
      },

      getHighestPriority: function pdfViewGetHighestPriority(visible, views,
                                                             scrolledDown) {
        // The state has changed figure out which page has the highest priority to
        // render next (if any).
        // Priority:
        // 1 visible pages
        // 2 if last scrolled down page after the visible pages
        // 2 if last scrolled up page before the visible pages
        var visibleViews = visible.views;

        var numVisible = visibleViews.length;
        if (numVisible === 0) {
          return false;
        }
        for (var i = 0; i < numVisible; ++i) {
          var view = visibleViews[i].view;
          if (!this.isViewFinished(view)) {
            return view;
          }
        }

        // All the visible views have rendered, try to render next/previous pages.
        if (scrolledDown) {
          var nextPageIndex = visible.last.id;
          // ID's start at 1 so no need to add 1.
          if (views[nextPageIndex] && !this.isViewFinished(views[nextPageIndex])) {
            return views[nextPageIndex];
          }
        } else {
          var previousPageIndex = visible.first.id - 2;
          if (views[previousPageIndex] &&
              !this.isViewFinished(views[previousPageIndex])) {
            return views[previousPageIndex];
          }
        }
        // Everything that needs to be rendered has been.
        return false;
      },

      isViewFinished: function pdfViewIsViewFinished(view) {
        return view.renderingState === RenderingStates.FINISHED;
      },

      // Render a page or thumbnail view. This calls the appropriate function based
      // on the views state. If the view is already rendered it will return false.
      renderView: function pdfViewRender(view, type) {
        var state = view.renderingState;
        switch (state) {
          case RenderingStates.FINISHED:
            return false;
          case RenderingStates.PAUSED:
            PDFView.highestPriorityPage = type + view.id;
            view.resume();
            break;
          case RenderingStates.RUNNING:
            PDFView.highestPriorityPage = type + view.id;
            break;
          case RenderingStates.INITIAL:
            PDFView.highestPriorityPage = type + view.id;
            view.draw(this.renderHighestPriority.bind(this));
            break;
        }
        return true;
      },

      setHash: function pdfViewSetHash(hash) {
        if (!hash) {
          return;
        }

        if (hash.indexOf('=') >= 0) {
          var params = PDFView.parseQueryString(hash);
          // borrowing syntax from "Parameters for Opening PDF Files"
          if ('nameddest' in params) {
            PDFHistory.updateNextHashParam(params.nameddest);
            PDFView.navigateTo(params.nameddest);
            return;
          }
          var pageNumber, dest;
          if ('page' in params) {
            pageNumber = (params.page | 0) || 1;
          }
          if ('zoom' in params) {
            var zoomArgs = params.zoom.split(','); // scale,left,top
            // building destination array

            // If the zoom value, it has to get divided by 100. If it is a string,
            // it should stay as it is.
            var zoomArg = zoomArgs[0];
            var zoomArgNumber = parseFloat(zoomArg);
            if (zoomArgNumber) {
              zoomArg = zoomArgNumber / 100;
            }
            dest = [null, {name: 'XYZ'},
                    zoomArgs.length > 1 ? (zoomArgs[1] | 0) : null,
                    zoomArgs.length > 2 ? (zoomArgs[2] | 0) : null,
                    zoomArg];
          }
          if (dest) {
            var currentPage = this.pages[(pageNumber || this.page) - 1];
            currentPage.scrollIntoView(dest);
          } else if (pageNumber) {
            this.page = pageNumber; // simple page
          }
          if ('pagemode' in params) {
            var toggle = $pluginInstance.find('.sidebarToggle').get(0);
            if (params.pagemode === 'thumbs' || params.pagemode === 'bookmarks' ||
                params.pagemode === 'attachments') {
              if (!this.sidebarOpen) {
                toggle.click();
              }
              this.switchSidebarView(params.pagemode === 'bookmarks' ?
                                       'outline' :
                                       params.pagemode);
            } else if (params.pagemode === 'none' && this.sidebarOpen) {
              toggle.click();
            }
          }
        } else if (/^\d+$/.test(hash)) { // page number
          this.page = hash;
        } else { // named destination
          PDFHistory.updateNextHashParam(unescape(hash));
          PDFView.navigateTo(unescape(hash));
        }
      },

      switchSidebarView: function pdfViewSwitchSidebarView(view) {
        var thumbsView = $pluginInstance.find('.thumbnailView').get(0);
        var outlineView = $pluginInstance.find('.outlineView').get(0);
        var attachmentsView = $pluginInstance.find('.attachmentsView').get(0);

        var thumbsButton = $pluginInstance.find('.viewThumbnail').get(0);
        var outlineButton = $pluginInstance.find('.viewOutline').get(0);
        var attachmentsButton = $pluginInstance.find('.viewAttachments').get(0);

        switch (view) {
          case 'thumbs':
            var wasAnotherViewVisible = thumbsView.classList.contains('hidden');

            thumbsButton.classList.add('toggled');
            outlineButton.classList.remove('toggled');
            attachmentsButton.classList.remove('toggled');
            thumbsView.classList.remove('hidden');
            outlineView.classList.add('hidden');
            attachmentsView.classList.add('hidden');

            PDFView.renderHighestPriority();

            if (wasAnotherViewVisible) {
              // Ensure that the thumbnail of the current page is visible
              // when switching from another view.
              scrollIntoView($pluginInstance.find('.thumbnailContainer' +
                                                     this.page).get(0));
            }
            break;

          case 'outline':
            thumbsButton.classList.remove('toggled');
            outlineButton.classList.add('toggled');
            attachmentsButton.classList.remove('toggled');
            thumbsView.classList.add('hidden');
            outlineView.classList.remove('hidden');
            attachmentsView.classList.add('hidden');

            if (outlineButton.getAttribute('disabled')) {
              return;
            }
            break;

          case 'attachments':
            thumbsButton.classList.remove('toggled');
            outlineButton.classList.remove('toggled');
            attachmentsButton.classList.add('toggled');
            thumbsView.classList.add('hidden');
            outlineView.classList.add('hidden');
            attachmentsView.classList.remove('hidden');

            if (attachmentsButton.getAttribute('disabled')) {
              return;
            }
            break;
        }
      },

      getVisiblePages: function pdfViewGetVisiblePages() {
        if (!PresentationMode.active) {
          return this.getVisibleElements(this.container, this.pages, true);
        } else {
          // The algorithm in getVisibleElements doesn't work in all browsers and
          // configurations when presentation mode is active.
          var visible = [];
          var currentPage = this.pages[this.page - 1];
          visible.push({ id: currentPage.id, view: currentPage });
          return { first: currentPage, last: currentPage, views: visible };
        }
      },

      getVisibleThumbs: function pdfViewGetVisibleThumbs() {
        return this.getVisibleElements(this.thumbnailContainer, this.thumbnails);
      },

      // Generic helper to find out what elements are visible within a scroll pane.
      getVisibleElements: function pdfViewGetVisibleElements(
          scrollEl, views, sortByVisibility) {
        var top = scrollEl.scrollTop, bottom = top + scrollEl.clientHeight;
        var left = scrollEl.scrollLeft, right = left + scrollEl.clientWidth;

        var visible = [], view;
        var currentHeight, viewHeight, hiddenHeight, percentHeight;
        var currentWidth, viewWidth;
        for (var i = 0, ii = views.length; i < ii; ++i) {
          view = views[i];
          currentHeight = view.el.offsetTop + view.el.clientTop;
          viewHeight = view.el.clientHeight;
          if ((currentHeight + viewHeight) < top) {
            continue;
          }
          if (currentHeight > bottom) {
            break;
          }
          currentWidth = view.el.offsetLeft + view.el.clientLeft;
          viewWidth = view.el.clientWidth;
          if ((currentWidth + viewWidth) < left || currentWidth > right) {
            continue;
          }
          hiddenHeight = Math.max(0, top - currentHeight) +
                         Math.max(0, currentHeight + viewHeight - bottom);
          percentHeight = ((viewHeight - hiddenHeight) * 100 / viewHeight) | 0;

          visible.push({ id: view.id, x: currentWidth, y: currentHeight,
                         view: view, percent: percentHeight });
        }

        var first = visible[0];
        var last = visible[visible.length - 1];

        if (sortByVisibility) {
          visible.sort(function(a, b) {
            var pc = a.percent - b.percent;
            if (Math.abs(pc) > 0.001) {
              return -pc;
            }
            return a.id - b.id; // ensure stability
          });
        }
        return {first: first, last: last, views: visible};
      },

      // Helper function to parse query string (e.g. ?param1=value&parm2=...).
      parseQueryString: function pdfViewParseQueryString(query) {
        var parts = query.split('&');
        var params = {};
        for (var i = 0, ii = parts.length; i < ii; ++i) {
          var param = parts[i].split('=');
          var key = param[0];
          var value = param.length > 1 ? param[1] : null;
          params[decodeURIComponent(key)] = decodeURIComponent(value);
        }
        return params;
      },

      rotatePages: function pdfViewRotatePages(delta) {
        var currentPage = this.pages[this.page - 1];
        var i, l;
        this.pageRotation = (this.pageRotation + 360 + delta) % 360;

        for (i = 0, l = this.pages.length; i < l; i++) {
          var page = this.pages[i];
          page.update(page.scale, this.pageRotation);
        }

        for (i = 0, l = this.thumbnails.length; i < l; i++) {
          var thumb = this.thumbnails[i];
          thumb.update(this.pageRotation);
        }

        this.setScale(this.currentScaleValue, true, true);

        this.renderHighestPriority();

        if (currentPage) {
          currentPage.scrollIntoView();
        }
      },

      /**
       * This function flips the page in presentation mode if the user scrolls up
       * or down with large enough motion and prevents page flipping too often.
       *
       * @this {PDFView}
       * @param {number} mouseScrollDelta The delta value from the mouse event.
       */
      mouseScroll: function pdfViewMouseScroll(mouseScrollDelta) {
        var MOUSE_SCROLL_COOLDOWN_TIME = 50;

        var currentTime = (new Date()).getTime();
        var storedTime = this.mouseScrollTimeStamp;

        // In case one page has already been flipped there is a cooldown time
        // which has to expire before next page can be scrolled on to.
        if (currentTime > storedTime &&
            currentTime - storedTime < MOUSE_SCROLL_COOLDOWN_TIME) {
          return;
        }

        // In case the user decides to scroll to the opposite direction than before
        // clear the accumulated delta.
        if ((this.mouseScrollDelta > 0 && mouseScrollDelta < 0) ||
            (this.mouseScrollDelta < 0 && mouseScrollDelta > 0)) {
          this.clearMouseScrollState();
        }

        this.mouseScrollDelta += mouseScrollDelta;

        var PAGE_FLIP_THRESHOLD = 120;
        if (Math.abs(this.mouseScrollDelta) >= PAGE_FLIP_THRESHOLD) {

          var PageFlipDirection = {
            UP: -1,
            DOWN: 1
          };

          // In presentation mode scroll one page at a time.
          var pageFlipDirection = (this.mouseScrollDelta > 0) ?
                                    PageFlipDirection.UP :
                                    PageFlipDirection.DOWN;
          this.clearMouseScrollState();
          var currentPage = this.page;

          // In case we are already on the first or the last page there is no need
          // to do anything.
          if ((currentPage == 1 && pageFlipDirection == PageFlipDirection.UP) ||
              (currentPage == this.pages.length &&
               pageFlipDirection == PageFlipDirection.DOWN)) {
            return;
          }

          this.page += pageFlipDirection;
          this.mouseScrollTimeStamp = currentTime;
        }
      },

      /**
       * This function clears the member attributes used with mouse scrolling in
       * presentation mode.
       *
       * @this {PDFView}
       */
      clearMouseScrollState: function pdfViewClearMouseScrollState() {
        this.mouseScrollTimeStamp = 0;
        this.mouseScrollDelta = 0;
      }
    };


    var PageView = function pageView(container, id, scale,
                                     navigateTo, defaultViewport) {
      this.id = id;

      this.rotation = 0;
      this.scale = scale || 1.0;
      this.viewport = defaultViewport;
      this.pdfPageRotate = defaultViewport.rotation;

      this.renderingState = RenderingStates.INITIAL;
      this.resume = null;

      this.textLayer = null;

      this.zoomLayer = null;

      this.annotationLayer = null;

      var anchor = document.createElement('a');
      anchor.name = '' + this.id;

      var div = this.el = document.createElement('div');
      div.className = 'page pageContainer' + this.id;
      div.style.width = Math.floor(this.viewport.width) + 'px';
      div.style.height = Math.floor(this.viewport.height) + 'px';

      container.appendChild(anchor);
      container.appendChild(div);

      this.setPdfPage = function pageViewSetPdfPage(pdfPage) {
        this.pdfPage = pdfPage;
        this.pdfPageRotate = pdfPage.rotate;
        var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
        this.viewport = pdfPage.getViewport(this.scale * CSS_UNITS, totalRotation);
        this.stats = pdfPage.stats;
        this.reset();
      };

      this.destroy = function pageViewDestroy() {
        this.zoomLayer = null;
        this.reset();
        if (this.pdfPage) {
          this.pdfPage.destroy();
        }
      };

      this.reset = function pageViewReset(keepAnnotations) {
        if (this.renderTask) {
          this.renderTask.cancel();
        }
        this.resume = null;
        this.renderingState = RenderingStates.INITIAL;

        div.style.width = Math.floor(this.viewport.width) + 'px';
        div.style.height = Math.floor(this.viewport.height) + 'px';

        var childNodes = div.childNodes;
        for (var i = div.childNodes.length - 1; i >= 0; i--) {
          var node = childNodes[i];
          if ((this.zoomLayer && this.zoomLayer === node) ||
              (keepAnnotations && this.annotationLayer === node)) {
            continue;
          }
          div.removeChild(node);
        }
        div.removeAttribute('data-loaded');

        if (keepAnnotations) {
          if (this.annotationLayer) {
            // Hide annotationLayer until all elements are resized
            // so they are not displayed on the already-resized page
            this.annotationLayer.setAttribute('hidden', 'true');
          }
        } else {
          this.annotationLayer = null;
        }

        delete this.canvas;

        this.loadingIconDiv = document.createElement('div');
        this.loadingIconDiv.className = 'loadingIcon';
        div.appendChild(this.loadingIconDiv);
      };

      this.update = function pageViewUpdate(scale, rotation) {
        this.scale = scale || this.scale;

        if (typeof rotation !== 'undefined') {
          this.rotation = rotation;
        }

        var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
        this.viewport = this.viewport.clone({
          scale: this.scale * CSS_UNITS,
          rotation: totalRotation
        });

        if (USE_ONLY_CSS_ZOOM && this.canvas) {
          this.cssTransform(this.canvas);
          return;
        } else if (this.canvas && !this.zoomLayer) {
          this.zoomLayer = this.canvas.parentNode;
          this.zoomLayer.style.position = 'absolute';
        }
        if (this.zoomLayer) {
          this.cssTransform(this.zoomLayer.firstChild);
        }
        this.reset(true);
      };

      this.cssTransform = function pageCssTransform(canvas) {
        // Scale canvas, canvas wrapper, and page container.
        var width = this.viewport.width;
        var height = this.viewport.height;
        canvas.style.width = canvas.parentNode.style.width = div.style.width =
            Math.floor(width) + 'px';
        canvas.style.height = canvas.parentNode.style.height = div.style.height =
            Math.floor(height) + 'px';
        // The canvas may have been originally rotated, so rotate relative to that.
        var relativeRotation = this.viewport.rotation - canvas._viewport.rotation;
        var absRotation = Math.abs(relativeRotation);
        var scaleX = 1, scaleY = 1;
        if (absRotation === 90 || absRotation === 270) {
          // Scale x and y because of the rotation.
          scaleX = height / width;
          scaleY = width / height;
        }
        var cssTransform = 'rotate(' + relativeRotation + 'deg) ' +
                           'scale(' + scaleX + ',' + scaleY + ')';
        CustomStyle.setProp('transform', canvas, cssTransform);

        if (this.textLayer) {
          // Rotating the text layer is more complicated since the divs inside the
          // the text layer are rotated.
          // TODO: This could probably be simplified by drawing the text layer in
          // one orientation then rotating overall.
          var textRelativeRotation = this.viewport.rotation -
                                     this.textLayer.viewport.rotation;
          var textAbsRotation = Math.abs(textRelativeRotation);
          var scale = (width / canvas.width);
          if (textAbsRotation === 90 || textAbsRotation === 270) {
            scale = width / canvas.height;
          }
          var textLayerDiv = this.textLayer.textLayerDiv;
          var transX, transY;
          switch (textAbsRotation) {
            case 0:
              transX = transY = 0;
              break;
            case 90:
              transX = 0;
              transY = '-' + textLayerDiv.style.height;
              break;
            case 180:
              transX = '-' + textLayerDiv.style.width;
              transY = '-' + textLayerDiv.style.height;
              break;
            case 270:
              transX = '-' + textLayerDiv.style.width;
              transY = 0;
              break;
            default:
              console.error('Bad rotation value.');
              break;
          }
          CustomStyle.setProp('transform', textLayerDiv,
                              'rotate(' + textAbsRotation + 'deg) ' +
                                'scale(' + scale + ', ' + scale + ') ' +
                                'translate(' + transX + ', ' + transY + ')');
          CustomStyle.setProp('transformOrigin', textLayerDiv, '0% 0%');
        }

        if (USE_ONLY_CSS_ZOOM && this.annotationLayer) {
          setupAnnotations(div, this.pdfPage, this.viewport);
        }
      };

      Object.defineProperty(this, 'width', {
        get: function PageView_getWidth() {
          return this.viewport.width;
        },
        enumerable: true
      });

      Object.defineProperty(this, 'height', {
        get: function PageView_getHeight() {
          return this.viewport.height;
        },
        enumerable: true
      });

      var self = this;

      function setupAnnotations(pageDiv, pdfPage, viewport) {

        function bindLink(link, dest) {
          link.href = PDFView.getDestinationHash(dest);
          link.onclick = function pageViewSetupLinksOnclick() {
            if (dest) {
              PDFView.navigateTo(dest);
            }
            return false;
          };
          if (dest) {
            link.className = 'internalLink';
          }
        }

        function bindNamedAction(link, action) {
          link.href = PDFView.getAnchorUrl('');
          link.onclick = function pageViewSetupNamedActionOnClick() {
            // See PDF reference, table 8.45 - Named action
            switch (action) {
              case 'GoToPage':
                $pluginInstance.find('.pageNumber').get(0).focus();
                break;

              case 'GoBack':
                PDFHistory.back();
                break;

              case 'GoForward':
                PDFHistory.forward();
                break;

              case 'Find':
                if (!PDFView.supportsIntegratedFind) {
                  PDFFindBar.toggle();
                }
                break;

              case 'NextPage':
                PDFView.page++;
                break;

              case 'PrevPage':
                PDFView.page--;
                break;

              case 'LastPage':
                PDFView.page = PDFView.pages.length;
                break;

              case 'FirstPage':
                PDFView.page = 1;
                break;

              default:
                break; // No action according to spec
            }
            return false;
          };
          link.className = 'internalLink';
        }

        pdfPage.getAnnotations().then(function(annotationsData) {
          viewport = viewport.clone({ dontFlip: true });
          var transform = viewport.transform;
          var transformStr = 'matrix(' + transform.join(',') + ')';
          var data, element, i, ii;

          if (self.annotationLayer) {
            // If an annotationLayer already exists, refresh its children's
            // transformation matrices
            for (i = 0, ii = annotationsData.length; i < ii; i++) {
              data = annotationsData[i];
              element = self.annotationLayer.querySelector(
                '[data-annotation-id="' + data.id + '"]');
              if (element) {
                CustomStyle.setProp('transform', element, transformStr);
              }
            }
            // See this.reset()
            self.annotationLayer.removeAttribute('hidden');
          } else {
            for (i = 0, ii = annotationsData.length; i < ii; i++) {
              data = annotationsData[i];
              var annotation = PDFJS.Annotation.fromData(data);
              if (!annotation || !annotation.hasHtml()) {
                continue;
              }

              element = annotation.getHtmlElement(pdfPage.commonObjs);
              element.setAttribute('data-annotation-id', data.id);
              mozL10n.translate(element);

              data = annotation.getData();
              var rect = data.rect;
              var view = pdfPage.view;
              rect = PDFJS.Util.normalizeRect([
                rect[0],
                view[3] - rect[1] + view[1],
                rect[2],
                view[3] - rect[3] + view[1]
              ]);
              element.style.left = rect[0] + 'px';
              element.style.top = rect[1] + 'px';
              element.style.position = 'absolute';

              CustomStyle.setProp('transform', element, transformStr);
              var transformOriginStr = -rect[0] + 'px ' + -rect[1] + 'px';
              CustomStyle.setProp('transformOrigin', element, transformOriginStr);

              if (data.subtype === 'Link' && !data.url) {
                var link = element.getElementsByTagName('a')[0];
                if (link) {
                  if (data.action) {
                    bindNamedAction(link, data.action);
                  } else {
                    bindLink(link, ('dest' in data) ? data.dest : null);
                  }
                }
              }

              if (!self.annotationLayer) {
                var annotationLayerDiv = document.createElement('div');
                annotationLayerDiv.className = 'annotationLayer';
                pageDiv.appendChild(annotationLayerDiv);
                self.annotationLayer = annotationLayerDiv;
              }

              self.annotationLayer.appendChild(element);
            }
          }
        });
      }

      this.getPagePoint = function pageViewGetPagePoint(x, y) {
        return this.viewport.convertToPdfPoint(x, y);
      };

      this.scrollIntoView = function pageViewScrollIntoView(dest) {
        if (PresentationMode.active) {
          if (PDFView.page !== this.id) {
            // Avoid breaking PDFView.getVisiblePages in presentation mode.
            PDFView.page = this.id;
            return;
          }
          dest = null;
          PDFView.setScale(PDFView.currentScaleValue, true, true);
        }
        if (!dest) {
          scrollIntoView(div);
          return;
        }

        var x = 0, y = 0;
        var width = 0, height = 0, widthScale, heightScale;
        var changeOrientation = (this.rotation % 180 === 0 ? false : true);
        var pageWidth = (changeOrientation ? this.height : this.width) /
          this.scale / CSS_UNITS;
        var pageHeight = (changeOrientation ? this.width : this.height) /
          this.scale / CSS_UNITS;
        var scale = 0;
        switch (dest[1].name) {
          case 'XYZ':
            x = dest[2];
            y = dest[3];
            scale = dest[4];
            // If x and/or y coordinates are not supplied, default to
            // _top_ left of the page (not the obvious bottom left,
            // since aligning the bottom of the intended page with the
            // top of the window is rarely helpful).
            x = x !== null ? x : 0;
            y = y !== null ? y : pageHeight;
            break;
          case 'Fit':
          case 'FitB':
            scale = 'page-fit';
            break;
          case 'FitH':
          case 'FitBH':
            y = dest[2];
            scale = 'page-width';
            break;
          case 'FitV':
          case 'FitBV':
            x = dest[2];
            width = pageWidth;
            height = pageHeight;
            scale = 'page-height';
            break;
          case 'FitR':
            x = dest[2];
            y = dest[3];
            width = dest[4] - x;
            height = dest[5] - y;
            widthScale = (PDFView.container.clientWidth - SCROLLBAR_PADDING) /
              width / CSS_UNITS;
            heightScale = (PDFView.container.clientHeight - SCROLLBAR_PADDING) /
              height / CSS_UNITS;
            scale = Math.min(Math.abs(widthScale), Math.abs(heightScale));
            break;
          default:
            return;
        }

        if (scale && scale !== PDFView.currentScale) {
          PDFView.setScale(scale, true, true);
        } else if (PDFView.currentScale === UNKNOWN_SCALE) {
          PDFView.setScale(DEFAULT_SCALE, true, true);
        }

        if (scale === 'page-fit' && !dest[4]) {
          scrollIntoView(div);
          return;
        }

        var boundingRect = [
          this.viewport.convertToViewportPoint(x, y),
          this.viewport.convertToViewportPoint(x + width, y + height)
        ];
        var left = Math.min(boundingRect[0][0], boundingRect[1][0]);
        var top = Math.min(boundingRect[0][1], boundingRect[1][1]);

        scrollIntoView(div, { left: left, top: top });
      };

      this.getTextContent = function pageviewGetTextContent() {
        return PDFView.getPage(this.id).then(function(pdfPage) {
          return pdfPage.getTextContent();
        });
      };

      this.draw = function pageviewDraw(callback) {
        var pdfPage = this.pdfPage;

        if (this.pagePdfPromise) {
          return;
        }
        if (!pdfPage) {
          var promise = PDFView.getPage(this.id);
          promise.then(function(pdfPage) {
            delete this.pagePdfPromise;
            this.setPdfPage(pdfPage);
            this.draw(callback);
          }.bind(this));
          this.pagePdfPromise = promise;
          return;
        }

        if (this.renderingState !== RenderingStates.INITIAL) {
          console.error('Must be in new state before drawing');
        }

        this.renderingState = RenderingStates.RUNNING;

        var viewport = this.viewport;
        // Wrap the canvas so if it has a css transform for highdpi the overflow
        // will be hidden in FF.
        var canvasWrapper = document.createElement('div');
        canvasWrapper.style.width = div.style.width;
        canvasWrapper.style.height = div.style.height;
        canvasWrapper.classList.add('canvasWrapper');

        var canvas = document.createElement('canvas');
        canvas.id = 'page' + this.id;
        canvasWrapper.appendChild(canvas);
        if (this.annotationLayer) {
          // annotationLayer needs to stay on top
          div.insertBefore(canvasWrapper, this.annotationLayer);
        } else {
          div.appendChild(canvasWrapper);
        }
        this.canvas = canvas;

        var ctx = canvas.getContext('2d');
        var outputScale = getOutputScale(ctx);

        if (USE_ONLY_CSS_ZOOM) {
          var actualSizeViewport = viewport.clone({ scale: CSS_UNITS });
          // Use a scale that will make the canvas be the original intended size
          // of the page.
          outputScale.sx *= actualSizeViewport.width / viewport.width;
          outputScale.sy *= actualSizeViewport.height / viewport.height;
          outputScale.scaled = true;
        }

        canvas.width = (Math.floor(viewport.width) * outputScale.sx) | 0;
        canvas.height = (Math.floor(viewport.height) * outputScale.sy) | 0;
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';
        // Add the viewport so it's known what it was originally drawn with.
        canvas._viewport = viewport;

        var textLayerDiv = null;
        if (!PDFJS.disableTextLayer) {
          textLayerDiv = document.createElement('div');
          textLayerDiv.className = 'textLayer';
          textLayerDiv.style.width = canvas.style.width;
          textLayerDiv.style.height = canvas.style.height;
          if (this.annotationLayer) {
            // annotationLayer needs to stay on top
            div.insertBefore(textLayerDiv, this.annotationLayer);
          } else {
            div.appendChild(textLayerDiv);
          }
        }
        var textLayer = this.textLayer =
          textLayerDiv ? new TextLayerBuilder({
            textLayerDiv: textLayerDiv,
            pageIndex: this.id - 1,
            lastScrollSource: PDFView,
            viewport: this.viewport,
            isViewerInPresentationMode: PresentationMode.active
          }) : null;
        // TODO(mack): use data attributes to store these
        ctx._scaleX = outputScale.sx;
        ctx._scaleY = outputScale.sy;
        if (outputScale.scaled) {
          ctx.scale(outputScale.sx, outputScale.sy);
        }

        // Rendering area

        var self = this;
        function pageViewDrawCallback(error) {
          // The renderTask may have been replaced by a new one, so only remove the
          // reference to the renderTask if it matches the one that is triggering
          // this callback.
          if (renderTask === self.renderTask) {
            self.renderTask = null;
          }

          if (error === 'cancelled') {
            return;
          }

          self.renderingState = RenderingStates.FINISHED;

          if (self.loadingIconDiv) {
            div.removeChild(self.loadingIconDiv);
            delete self.loadingIconDiv;
          }

          if (self.zoomLayer) {
            div.removeChild(self.zoomLayer);
            self.zoomLayer = null;
          }

          if (error) {
            PDFView.error(mozL10n.get('rendering_error', null,
              'An error occurred while rendering the page.'), error);
          }

          self.stats = pdfPage.stats;
          self.updateStats();
          if (self.onAfterDraw) {
            self.onAfterDraw();
          }

          cache.push(self);

          var event = document.createEvent('CustomEvent');
          event.initCustomEvent('pagerender', true, true, {
            pageNumber: pdfPage.pageNumber
          });
          div.dispatchEvent(event);

          callback();
        }

        var renderContext = {
          canvasContext: ctx,
          viewport: this.viewport,
          textLayer: textLayer,
          // intent: 'default', // === 'display'
          continueCallback: function pdfViewcContinueCallback(cont) {
            if (PDFView.highestPriorityPage !== 'page' + self.id) {
              self.renderingState = RenderingStates.PAUSED;
              self.resume = function resumeCallback() {
                self.renderingState = RenderingStates.RUNNING;
                cont();
              };
              return;
            }
            cont();
          }
        };
        var renderTask = this.renderTask = this.pdfPage.render(renderContext);

        this.renderTask.promise.then(
          function pdfPageRenderCallback() {
            pageViewDrawCallback(null);
            if (textLayer) {
              self.getTextContent().then(
                function textContentResolved(textContent) {
                  textLayer.setTextContent(textContent);
                }
              );
            }
          },
          function pdfPageRenderError(error) {
            pageViewDrawCallback(error);
          }
        );

        setupAnnotations(div, pdfPage, this.viewport);
        div.setAttribute('data-loaded', true);
      };

      this.updateStats = function pageViewUpdateStats() {
        if (!this.stats) {
          return;
        }

        if (PDFJS.pdfBug && Stats.enabled) {
          var stats = this.stats;
          Stats.add(this.id, stats);
        }
      };
    };


    var ThumbnailView = function thumbnailView(container, id, defaultViewport) {
      var anchor = document.createElement('a');
      anchor.href = PDFView.getAnchorUrl('#page=' + id);
      anchor.title = mozL10n.get('thumb_page_title', {page: id}, 'Page {{page}}');
      anchor.onclick = function stopNavigation() {
        PDFView.page = id;
        return false;
      };

      this.pdfPage = undefined;
      this.viewport = defaultViewport;
      this.pdfPageRotate = defaultViewport.rotation;

      this.rotation = 0;
      this.pageWidth = this.viewport.width;
      this.pageHeight = this.viewport.height;
      this.pageRatio = this.pageWidth / this.pageHeight;
      this.id = id;

      this.canvasWidth = 98;
      this.canvasHeight = this.canvasWidth / this.pageWidth * this.pageHeight;
      this.scale = (this.canvasWidth / this.pageWidth);

      var div = this.el = document.createElement('div');
      div.className = 'thumbnail thumbnailContainer' + id;

      if (id === 1) {
        // Highlight the thumbnail of the first page when no page number is
        // specified (or exists in cache) when the document is loaded.
        div.classList.add('selected');
      }

      var ring = document.createElement('div');
      ring.className = 'thumbnailSelectionRing';
      ring.style.width = this.canvasWidth + 'px';
      ring.style.height = this.canvasHeight + 'px';

      div.appendChild(ring);
      anchor.appendChild(div);
      container.appendChild(anchor);

      this.hasImage = false;
      this.renderingState = RenderingStates.INITIAL;

      this.setPdfPage = function thumbnailViewSetPdfPage(pdfPage) {
        this.pdfPage = pdfPage;
        this.pdfPageRotate = pdfPage.rotate;
        var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
        this.viewport = pdfPage.getViewport(1, totalRotation);
        this.update();
      };

      this.update = function thumbnailViewUpdate(rotation) {
        if (rotation !== undefined) {
          this.rotation = rotation;
        }
        var totalRotation = (this.rotation + this.pdfPageRotate) % 360;
        this.viewport = this.viewport.clone({
          scale: 1,
          rotation: totalRotation
        });
        this.pageWidth = this.viewport.width;
        this.pageHeight = this.viewport.height;
        this.pageRatio = this.pageWidth / this.pageHeight;

        this.canvasHeight = this.canvasWidth / this.pageWidth * this.pageHeight;
        this.scale = (this.canvasWidth / this.pageWidth);

        div.removeAttribute('data-loaded');
        ring.textContent = '';
        ring.style.width = this.canvasWidth + 'px';
        ring.style.height = this.canvasHeight + 'px';

        this.hasImage = false;
        this.renderingState = RenderingStates.INITIAL;
        this.resume = null;
      };

      this.getPageDrawContext = function thumbnailViewGetPageDrawContext() {
        var canvas = document.createElement('canvas');
        canvas.id = 'thumbnail' + id;

        canvas.width = this.canvasWidth;
        canvas.height = this.canvasHeight;
        canvas.className = 'thumbnailImage';
        canvas.setAttribute('aria-label', mozL10n.get('thumb_page_canvas',
          {page: id}, 'Thumbnail of Page {{page}}'));

        div.setAttribute('data-loaded', true);

        ring.appendChild(canvas);

        var ctx = canvas.getContext('2d');
        ctx.save();
        ctx.fillStyle = 'rgb(255, 255, 255)';
        ctx.fillRect(0, 0, this.canvasWidth, this.canvasHeight);
        ctx.restore();
        return ctx;
      };

      this.drawingRequired = function thumbnailViewDrawingRequired() {
        return !this.hasImage;
      };

      this.draw = function thumbnailViewDraw(callback) {
        if (!this.pdfPage) {
          var promise = PDFView.getPage(this.id);
          promise.then(function(pdfPage) {
            this.setPdfPage(pdfPage);
            this.draw(callback);
          }.bind(this));
          return;
        }

        if (this.renderingState !== RenderingStates.INITIAL) {
          console.error('Must be in new state before drawing');
        }

        this.renderingState = RenderingStates.RUNNING;
        if (this.hasImage) {
          callback();
          return;
        }

        var self = this;
        var ctx = this.getPageDrawContext();
        var drawViewport = this.viewport.clone({ scale: this.scale });
        var renderContext = {
          canvasContext: ctx,
          viewport: drawViewport,
          continueCallback: function(cont) {
            if (PDFView.highestPriorityPage !== 'thumbnail' + self.id) {
              self.renderingState = RenderingStates.PAUSED;
              self.resume = function() {
                self.renderingState = RenderingStates.RUNNING;
                cont();
              };
              return;
            }
            cont();
          }
        };
        this.pdfPage.render(renderContext).promise.then(
          function pdfPageRenderCallback() {
            self.renderingState = RenderingStates.FINISHED;
            callback();
          },
          function pdfPageRenderError(error) {
            self.renderingState = RenderingStates.FINISHED;
            callback();
          }
        );
        this.hasImage = true;
      };

      this.setImage = function thumbnailViewSetImage(img) {
        if (!this.pdfPage) {
          var promise = PDFView.getPage(this.id);
          promise.then(function(pdfPage) {
            this.setPdfPage(pdfPage);
            this.setImage(img);
          }.bind(this));
          return;
        }
        if (this.hasImage || !img) {
          return;
        }
        this.renderingState = RenderingStates.FINISHED;
        var ctx = this.getPageDrawContext();
        ctx.drawImage(img, 0, 0, img.width, img.height,
                      0, 0, ctx.canvas.width, ctx.canvas.height);

        this.hasImage = true;
      };
    };


    var FIND_SCROLL_OFFSET_TOP = -50;
    var FIND_SCROLL_OFFSET_LEFT = -400;

    /**
     * TextLayerBuilder provides text-selection
     * functionality for the PDF. It does this
     * by creating overlay divs over the PDF
     * text. This divs contain text that matches
     * the PDF text they are overlaying. This
     * object also provides for a way to highlight
     * text that is being searched for.
     */
    var TextLayerBuilder = function textLayerBuilder(options) {
      var textLayerFrag = document.createDocumentFragment();

      this.textLayerDiv = options.textLayerDiv;
      this.layoutDone = false;
      this.divContentDone = false;
      this.pageIdx = options.pageIndex;
      this.matches = [];
      this.lastScrollSource = options.lastScrollSource;
      this.viewport = options.viewport;
      this.isViewerInPresentationMode = options.isViewerInPresentationMode;
      this.textDivs = [];

      if (typeof PDFFindController === 'undefined') {
        window.PDFFindController = null;
      }

      if (typeof this.lastScrollSource === 'undefined') {
        this.lastScrollSource = null;
      }

      this.renderLayer = function textLayerBuilderRenderLayer() {
        var textDivs = this.textDivs;
        var canvas = document.createElement('canvas');
        var ctx = canvas.getContext('2d');

        // No point in rendering so many divs as it'd make the browser unusable
        // even after the divs are rendered
        var MAX_TEXT_DIVS_TO_RENDER = 100000;
        if (textDivs.length > MAX_TEXT_DIVS_TO_RENDER) {
          return;
        }

        for (var i = 0, ii = textDivs.length; i < ii; i++) {
          var textDiv = textDivs[i];
          if ('isWhitespace' in textDiv.dataset) {
            continue;
          }

          ctx.font = textDiv.style.fontSize + ' ' + textDiv.style.fontFamily;
          var width = ctx.measureText(textDiv.textContent).width;

          if (width > 0) {
            textLayerFrag.appendChild(textDiv);
            var textScale = textDiv.dataset.canvasWidth / width;
            var rotation = textDiv.dataset.angle;
            var transform = 'scale(' + textScale + ', 1)';
            transform = 'rotate(' + rotation + 'deg) ' + transform;
            CustomStyle.setProp('transform' , textDiv, transform);
            CustomStyle.setProp('transformOrigin' , textDiv, '0% 0%');
          }
        }

        this.textLayerDiv.appendChild(textLayerFrag);
        this.renderingDone = true;
        this.updateMatches();
      };

      this.setupRenderLayoutTimer = function textLayerSetupRenderLayoutTimer() {
        // Schedule renderLayout() if user has been scrolling, otherwise
        // run it right away
        var RENDER_DELAY = 200; // in ms
        var self = this;
        var lastScroll = (this.lastScrollSource === null ?
                          0 : this.lastScrollSource.lastScroll);

        if (Date.now() - lastScroll > RENDER_DELAY) {
          // Render right away
          this.renderLayer();
        } else {
          // Schedule
          if (this.renderTimer) {
            clearTimeout(this.renderTimer);
          }
          this.renderTimer = setTimeout(function() {
            self.setupRenderLayoutTimer();
          }, RENDER_DELAY);
        }
      };

      this.appendText = function textLayerBuilderAppendText(geom, styles) {
        var style = styles[geom.fontName];
        var textDiv = document.createElement('div');
        this.textDivs.push(textDiv);
        if (!/\S/.test(geom.str)) {
          textDiv.dataset.isWhitespace = true;
          return;
        }
        var tx = PDFJS.Util.transform(this.viewport.transform, geom.transform);
        var angle = Math.atan2(tx[1], tx[0]);
        if (style.vertical) {
          angle += Math.PI / 2;
        }
        var fontHeight = Math.sqrt((tx[2] * tx[2]) + (tx[3] * tx[3]));
        var fontAscent = (style.ascent ? style.ascent * fontHeight :
          (style.descent ? (1 + style.descent) * fontHeight : fontHeight));

        textDiv.style.position = 'absolute';
        textDiv.style.left = (tx[4] + (fontAscent * Math.sin(angle))) + 'px';
        textDiv.style.top = (tx[5] - (fontAscent * Math.cos(angle))) + 'px';
        textDiv.style.fontSize = fontHeight + 'px';
        textDiv.style.fontFamily = style.fontFamily;

        textDiv.textContent = geom.str;
        textDiv.dataset.fontName = geom.fontName;
        textDiv.dataset.angle = angle * (180 / Math.PI);
        if (style.vertical) {
          textDiv.dataset.canvasWidth = geom.height * this.viewport.scale;
        } else {
          textDiv.dataset.canvasWidth = geom.width * this.viewport.scale;
        }

      };

      this.setTextContent = function textLayerBuilderSetTextContent(textContent) {
        this.textContent = textContent;

        var textItems = textContent.items;
        for (var i = 0; i < textItems.length; i++) {
          this.appendText(textItems[i], textContent.styles);
        }
        this.divContentDone = true;

        this.setupRenderLayoutTimer();
      };

      this.convertMatches = function textLayerBuilderConvertMatches(matches) {
        var i = 0;
        var iIndex = 0;
        var bidiTexts = this.textContent.items;
        var end = bidiTexts.length - 1;
        var queryLen = (PDFFindController === null ?
                        0 : PDFFindController.state.query.length);

        var ret = [];

        // Loop over all the matches.
        for (var m = 0; m < matches.length; m++) {
          var matchIdx = matches[m];
          // # Calculate the begin position.

          // Loop over the divIdxs.
          while (i !== end && matchIdx >= (iIndex + bidiTexts[i].str.length)) {
            iIndex += bidiTexts[i].str.length;
            i++;
          }

          // TODO: Do proper handling here if something goes wrong.
          if (i == bidiTexts.length) {
            console.error('Could not find matching mapping');
          }

          var match = {
            begin: {
              divIdx: i,
              offset: matchIdx - iIndex
            }
          };

          // # Calculate the end position.
          matchIdx += queryLen;

          // Somewhat same array as above, but use a > instead of >= to get the end
          // position right.
          while (i !== end && matchIdx > (iIndex + bidiTexts[i].str.length)) {
            iIndex += bidiTexts[i].str.length;
            i++;
          }

          match.end = {
            divIdx: i,
            offset: matchIdx - iIndex
          };
          ret.push(match);
        }

        return ret;
      };

      this.renderMatches = function textLayerBuilder_renderMatches(matches) {
        // Early exit if there is nothing to render.
        if (matches.length === 0) {
          return;
        }

        var bidiTexts = this.textContent.items;
        var textDivs = this.textDivs;
        var prevEnd = null;
        var isSelectedPage = (PDFFindController === null ?
          false : (this.pageIdx === PDFFindController.selected.pageIdx));

        var selectedMatchIdx = (PDFFindController === null ?
                                -1 : PDFFindController.selected.matchIdx);

        var highlightAll = (PDFFindController === null ?
                            false : PDFFindController.state.highlightAll);

        var infty = {
          divIdx: -1,
          offset: undefined
        };

        function beginText(begin, className) {
          var divIdx = begin.divIdx;
          var div = textDivs[divIdx];
          div.textContent = '';
          appendTextToDiv(divIdx, 0, begin.offset, className);
        }

        function appendText(from, to, className) {
          appendTextToDiv(from.divIdx, from.offset, to.offset, className);
        }

        function appendTextToDiv(divIdx, fromOffset, toOffset, className) {
          var div = textDivs[divIdx];

          var content = bidiTexts[divIdx].str.substring(fromOffset, toOffset);
          var node = document.createTextNode(content);
          if (className) {
            var span = document.createElement('span');
            span.className = className;
            span.appendChild(node);
            div.appendChild(span);
            return;
          }
          div.appendChild(node);
        }

        function highlightDiv(divIdx, className) {
          textDivs[divIdx].className = className;
        }

        var i0 = selectedMatchIdx, i1 = i0 + 1, i;

        if (highlightAll) {
          i0 = 0;
          i1 = matches.length;
        } else if (!isSelectedPage) {
          // Not highlighting all and this isn't the selected page, so do nothing.
          return;
        }

        for (i = i0; i < i1; i++) {
          var match = matches[i];
          var begin = match.begin;
          var end = match.end;

          var isSelected = isSelectedPage && i === selectedMatchIdx;
          var highlightSuffix = (isSelected ? ' selected' : '');
          if (isSelected && !this.isViewerInPresentationMode) {
            scrollIntoView(textDivs[begin.divIdx], { top: FIND_SCROLL_OFFSET_TOP,
                                                   left: FIND_SCROLL_OFFSET_LEFT });
          }

          // Match inside new div.
          if (!prevEnd || begin.divIdx !== prevEnd.divIdx) {
            // If there was a previous div, then add the text at the end
            if (prevEnd !== null) {
              appendText(prevEnd, infty);
            }
            // clears the divs and set the content until the begin point.
            beginText(begin);
          } else {
            appendText(prevEnd, begin);
          }

          if (begin.divIdx === end.divIdx) {
            appendText(begin, end, 'highlight' + highlightSuffix);
          } else {
            appendText(begin, infty, 'highlight begin' + highlightSuffix);
            for (var n = begin.divIdx + 1; n < end.divIdx; n++) {
              highlightDiv(n, 'highlight middle' + highlightSuffix);
            }
            beginText(end, 'highlight end' + highlightSuffix);
          }
          prevEnd = end;
        }

        if (prevEnd) {
          appendText(prevEnd, infty);
        }
      };

      this.updateMatches = function textLayerUpdateMatches() {
        // Only show matches, once all rendering is done.
        if (!this.renderingDone) {
          return;
        }

        // Clear out all matches.
        var matches = this.matches;
        var textDivs = this.textDivs;
        var bidiTexts = this.textContent.items;
        var clearedUntilDivIdx = -1;

        // Clear out all current matches.
        for (var i = 0; i < matches.length; i++) {
          var match = matches[i];
          var begin = Math.max(clearedUntilDivIdx, match.begin.divIdx);
          for (var n = begin; n <= match.end.divIdx; n++) {
            var div = textDivs[n];
            div.textContent = bidiTexts[n].str;
            div.className = '';
          }
          clearedUntilDivIdx = match.end.divIdx + 1;
        }

        if (PDFFindController === null || !PDFFindController.active) {
          return;
        }

        // Convert the matches on the page controller into the match format used
        // for the textLayer.
        this.matches = matches = (this.convertMatches(PDFFindController === null ?
          [] : (PDFFindController.pageMatches[this.pageIdx] || [])));

        this.renderMatches(this.matches);
      };
    };



    var DocumentOutlineView = function documentOutlineView(outline) {
      var outlineView = $pluginInstance.find('.outlineView').get(0);
      while (outlineView.firstChild) {
        outlineView.removeChild(outlineView.firstChild);
      }

      if (!outline) {
        if (!outlineView.classList.contains('hidden')) {
          PDFView.switchSidebarView('thumbs');
        }
        return;
      }

      function bindItemLink(domObj, item) {
        domObj.href = PDFView.getDestinationHash(item.dest);
        domObj.onclick = function documentOutlineViewOnclick(e) {
          PDFView.navigateTo(item.dest);
          return false;
        };
      }


      var queue = [{parent: outlineView, items: outline}];
      while (queue.length > 0) {
        var levelData = queue.shift();
        var i, n = levelData.items.length;
        for (i = 0; i < n; i++) {
          var item = levelData.items[i];
          var div = document.createElement('div');
          div.className = 'outlineItem';
          var a = document.createElement('a');
          bindItemLink(a, item);
          a.textContent = item.title;
          div.appendChild(a);

          if (item.items.length > 0) {
            var itemsDiv = document.createElement('div');
            itemsDiv.className = 'outlineItems';
            div.appendChild(itemsDiv);
            queue.push({parent: itemsDiv, items: item.items});
          }

          levelData.parent.appendChild(div);
        }
      }
    };

    var DocumentAttachmentsView = function documentAttachmentsView(attachments) {
      var attachmentsView = $pluginInstance.find('.attachmentsView').get(0);
      while (attachmentsView.firstChild) {
        attachmentsView.removeChild(attachmentsView.firstChild);
      }

      if (!attachments) {
        if (!attachmentsView.classList.contains('hidden')) {
          PDFView.switchSidebarView('thumbs');
        }
        return;
      }

      function bindItemLink(domObj, item) {
        domObj.href = '#';
        domObj.onclick = function documentAttachmentsViewOnclick(e) {
          var downloadManager = new DownloadManager();
          downloadManager.downloadData(item.content, getFileName(item.filename),
                                       '');
          return false;
        };
      }

      var names = Object.keys(attachments).sort(function(a,b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
      for (var i = 0, ii = names.length; i < ii; i++) {
        var item = attachments[names[i]];
        var div = document.createElement('div');
        div.className = 'attachmentsItem';
        var a = document.createElement('a');
        bindItemLink(a, item);
        a.textContent = getFileName(item.filename);
        div.appendChild(a);
        attachmentsView.appendChild(div);
      }
    };


    function webViewerLoad(evt) {
      PDFView.initialize().then(webViewerInitialized);
    }

    function webViewerInitialized() {
      var params = PDFView.parseQueryString(document.location.search.substring(1));
      var file = 'file' in params ? params.file : settings.source;

      // Special debugging flags in the hash section of the URL.
      var hash = document.location.hash.substring(1);
      var hashParams = PDFView.parseQueryString(hash);

      if ('disableWorker' in hashParams) {
        PDFJS.disableWorker = (hashParams['disableWorker'] === 'true');
      }

      if ('disableRange' in hashParams) {
        PDFJS.disableRange = (hashParams['disableRange'] === 'true');
      }

      if ('disableAutoFetch' in hashParams) {
        PDFJS.disableAutoFetch = (hashParams['disableAutoFetch'] === 'true');
      }

      if ('disableFontFace' in hashParams) {
        PDFJS.disableFontFace = (hashParams['disableFontFace'] === 'true');
      }

      if ('disableHistory' in hashParams) {
        PDFJS.disableHistory = (hashParams['disableHistory'] === 'true');
      }

      if ('webgl' in hashParams) {
        PDFJS.disableWebGL = (hashParams['webgl'] !== 'true');
      }

      if ('useOnlyCssZoom' in hashParams) {
        USE_ONLY_CSS_ZOOM = (hashParams['useOnlyCssZoom'] === 'true');
      }

      if ('verbosity' in hashParams) {
        PDFJS.verbosity = hashParams['verbosity'] | 0;
      }

      if ('ignoreCurrentPositionOnZoom' in hashParams) {
        IGNORE_CURRENT_POSITION_ON_ZOOM =
          (hashParams['ignoreCurrentPositionOnZoom'] === 'true');
      }



      var locale = PDFJS.locale || navigator.language;
      if ('locale' in hashParams) {
        locale = hashParams['locale'];
      }
      mozL10n.setLanguage(locale);

      if ('textLayer' in hashParams) {
        switch (hashParams['textLayer']) {
          case 'off':
            PDFJS.disableTextLayer = true;
            break;
          case 'visible':
          case 'shadow':
          case 'hover':
            var viewer = $pluginInstance.find('.viewer').get(0);
            viewer.classList.add('textLayer-' + hashParams['textLayer']);
            break;
        }
      }

      if ('pdfBug' in hashParams) {
        PDFJS.pdfBug = true;
        var pdfBug = hashParams['pdfBug'];
        var enabled = pdfBug.split(',');
        PDFBug.enable(enabled);
        PDFBug.init();
      }

      if (!PDFView.supportsFullscreen) {
        $pluginInstance.find('.presentationMode').get(0).classList.add('hidden');
      }

      if (PDFView.supportsIntegratedFind) {
        $pluginInstance.find('.viewFind').get(0).classList.add('hidden');
      }

      // Listen for unsuporrted features to trigger the fallback UI.
      PDFJS.UnsupportedManager.listen(PDFView.fallback.bind(PDFView));

      // Suppress context menus for some controls
      $pluginInstance.find('.scaleSelect').get(0).oncontextmenu = noContextMenuHandler;

      var mainContainer = $pluginInstance.find('.mainContainer').get(0);
      var outerContainer = $pluginInstance.find('.outerContainer').get(0);
      mainContainer.addEventListener('transitionend', function(e) {
        if (e.target == mainContainer) {
          var event = document.createEvent('UIEvents');
          event.initUIEvent('resize', false, false, window, 0);
          window.dispatchEvent(event);
          outerContainer.classList.remove('sidebarMoving');
        }
      }, true);

      $pluginInstance.find('.sidebarToggle').get(0).addEventListener('click',
        function() {
          this.classList.toggle('toggled');
          outerContainer.classList.add('sidebarMoving');
          outerContainer.classList.toggle('sidebarOpen');
          PDFView.sidebarOpen = outerContainer.classList.contains('sidebarOpen');
          PDFView.renderHighestPriority();
        });

      $pluginInstance.find('.viewThumbnail').get(0).addEventListener('click',
        function() {
          PDFView.switchSidebarView('thumbs');
        });

      $pluginInstance.find('.viewOutline').get(0).addEventListener('click',
        function() {
          PDFView.switchSidebarView('outline');
        });

      $pluginInstance.find('.viewAttachments').get(0).addEventListener('click',
        function() {
          PDFView.switchSidebarView('attachments');
        });

      $pluginInstance.find('.previous').get(0).addEventListener('click',
        function() {
          PDFView.page--;
        });

      $pluginInstance.find('.next').get(0).addEventListener('click',
        function() {
          PDFView.page++;
        });

      $pluginInstance.find('.zoomIn').get(0).addEventListener('click',
        function() {
          PDFView.zoomIn();
        });

      $pluginInstance.find('.zoomOut').get(0).addEventListener('click',
        function() {
          PDFView.zoomOut();
        });

      $pluginInstance.find('.pageNumber').get(0).addEventListener('click',
        function() {
          this.select();
        });

      $pluginInstance.find('.pageNumber').get(0).addEventListener('change',
        function() {
          // Handle the user inputting a floating point number.
          PDFView.page = (this.value | 0);

          if (this.value !== (this.value | 0).toString()) {
            this.value = PDFView.page;
          }
        });

      $pluginInstance.find('.scaleSelect').get(0).addEventListener('change',
        function() {
          PDFView.setScale(this.value);
        });

      if (file) {
        PDFView.open(file, 0);
      }
    }

    document.addEventListener('DOMContentLoaded', webViewerLoad, true);

    function updateViewarea() {

      if (!PDFView.initialized) {
        return;
      }
      var visible = PDFView.getVisiblePages();
      var visiblePages = visible.views;
      if (visiblePages.length === 0) {
        return;
      }

      PDFView.renderHighestPriority();

      var currentId = PDFView.page;
      var firstPage = visible.first;

      for (var i = 0, ii = visiblePages.length, stillFullyVisible = false;
           i < ii; ++i) {
        var page = visiblePages[i];

        if (page.percent < 100) {
          break;
        }
        if (page.id === PDFView.page) {
          stillFullyVisible = true;
          break;
        }
      }

      if (!stillFullyVisible) {
        currentId = visiblePages[0].id;
      }

      if (!PresentationMode.active) {
        updateViewarea.inProgress = true; // used in "set page"
        PDFView.page = currentId;
        updateViewarea.inProgress = false;
      }

      var currentScale = PDFView.currentScale;
      var currentScaleValue = PDFView.currentScaleValue;
      var normalizedScaleValue = parseFloat(currentScaleValue) === currentScale ?
        Math.round(currentScale * 10000) / 100 : currentScaleValue;

      var pageNumber = firstPage.id;
      var pdfOpenParams = '#page=' + pageNumber;
      pdfOpenParams += '&zoom=' + normalizedScaleValue;
      var currentPage = PDFView.pages[pageNumber - 1];
      var container = PDFView.container;
      var topLeft = currentPage.getPagePoint((container.scrollLeft - firstPage.x),
                                             (container.scrollTop - firstPage.y));
      var intLeft = Math.round(topLeft[0]);
      var intTop = Math.round(topLeft[1]);
      pdfOpenParams += ',' + intLeft + ',' + intTop;

      if (PresentationMode.active || PresentationMode.switchInProgress) {
        PDFView.currentPosition = null;
      } else {
        PDFView.currentPosition = { page: pageNumber, left: intLeft, top: intTop };
      }

      var store = PDFView.store;
      store.initializedPromise.then(function() {
        store.set('exists', true);
        store.set('page', pageNumber);
        store.set('zoom', normalizedScaleValue);
        store.set('scrollLeft', intLeft);
        store.set('scrollTop', intTop);
      });
      var href = PDFView.getAnchorUrl(pdfOpenParams);

      // Update the current bookmark in the browsing history.
      PDFHistory.updateCurrentBookmark(pdfOpenParams, pageNumber);
    }

    window.addEventListener('resize', function webViewerResize(evt) {
      if (PDFView.initialized &&
          ($pluginInstance.find('.pageWidthOption').get(0).selected ||
           $pluginInstance.find('.pageFitOption').get(0).selected ||
           $pluginInstance.find('.pageAutoOption').get(0).selected)) {
        PDFView.setScale($pluginInstance.find('.scaleSelect').get(0).value);
      }
      updateViewarea();
    });

    window.addEventListener('hashchange', function webViewerHashchange(evt) {
      if (PDFHistory.isHashChangeUnlocked) {
        PDFView.setHash(document.location.hash.substring(1));
      }
    });

    window.addEventListener('change', function webViewerChange(evt) {
      var files = evt.target.files;
      if (!files || files.length === 0) {
        return;
      }
      var file = files[0];

      if (!PDFJS.disableCreateObjectURL &&
          typeof URL !== 'undefined' && URL.createObjectURL) {
        PDFView.open(URL.createObjectURL(file), 0);
      } else {
        // Read the local file into a Uint8Array.
        var fileReader = new FileReader();
        fileReader.onload = function webViewerChangeFileReaderOnload(evt) {
          var buffer = evt.target.result;
          var uint8Array = new Uint8Array(buffer);
          PDFView.open(uint8Array, 0);
        };
        fileReader.readAsArrayBuffer(file);
      }

      PDFView.url = file.name;

      // URL does not reflect proper document location - hiding some icons.
      $pluginInstance.find('.download').get(0).setAttribute('hidden', 'true');
    }, true);

    function selectScaleOption(value) {
      var options = $pluginInstance.find('.scaleSelect').get(0).options;
      var predefinedValueFound = false;
      for (var i = 0; i < options.length; i++) {
        var option = options[i];
        if (option.value != value) {
          option.selected = false;
          continue;
        }
        option.selected = true;
        predefinedValueFound = true;
      }
      return predefinedValueFound;
    }

    $pluginInstance.get(0).addEventListener('localized', function localized(evt) {
      document.getElementsByTagName('html')[0].dir = mozL10n.getDirection();

      PDFView.animationStartedPromise.then(function() {
        // Adjust the width of the zoom box to fit the content.
        // Note: This is only done if the zoom box is actually visible,
        // since otherwise element.clientWidth will return 0.
        var container = $pluginInstance.find('.scaleSelectContainer').get(0);
        if (container.clientWidth > 0) {
          var select = $pluginInstance.find('.scaleSelect').get(0);
          select.setAttribute('style', 'min-width: inherit;');
          var width = select.clientWidth + SCALE_SELECT_CONTAINER_PADDING;
          select.setAttribute('style', 'min-width: ' +
                                       (width + SCALE_SELECT_PADDING) + 'px;');
          container.setAttribute('style', 'min-width: ' + width + 'px; ' +
                                          'max-width: ' + width + 'px;');
        }
      });
    }, true);

    $pluginInstance.get(0).addEventListener('scalechange', function scalechange(evt) {
      $pluginInstance.find('.zoomOut').get(0).disabled = (evt.scale === MIN_SCALE);
      $pluginInstance.find('.zoomIn').get(0).disabled = (evt.scale === MAX_SCALE);

      var customScaleOption = $pluginInstance.find('.customScaleOption').get(0);
      customScaleOption.selected = false;

      if (!evt.resetAutoSettings &&
          ($pluginInstance.find('.pageWidthOption').get(0).selected ||
           $pluginInstance.find('.pageFitOption').get(0).selected ||
           $pluginInstance.find('.pageAutoOption').get(0).selected)) {
        updateViewarea();
        return;
      }

      var predefinedValueFound = selectScaleOption('' + evt.scale);
      if (!predefinedValueFound) {
        customScaleOption.textContent = Math.round(evt.scale * 10000) / 100 + '%';
        customScaleOption.selected = true;
      }
      updateViewarea();
    }, true);

    $pluginInstance.get(0).addEventListener('pagechange', function pagechange(evt) {
      var page = evt.pageNumber;
      if (PDFView.previousPageNumber !== page) {
        $pluginInstance.find('.pageNumber').get(0).value = page;
        var selected = document.querySelector('.thumbnail.selected');
        if (selected) {
          selected.classList.remove('selected');
        }
        var thumbnail = $pluginInstance.find('.thumbnailContainer' + page).get(0);
        thumbnail.classList.add('selected');
        var visibleThumbs = PDFView.getVisibleThumbs();
        var numVisibleThumbs = visibleThumbs.views.length;

        // If the thumbnail isn't currently visible, scroll it into view.
        if (numVisibleThumbs > 0) {
          var first = visibleThumbs.first.id;
          // Account for only one thumbnail being visible.
          var last = (numVisibleThumbs > 1 ? visibleThumbs.last.id : first);
          if (page <= first || page >= last) {
            scrollIntoView(thumbnail, { top: THUMBNAIL_SCROLL_MARGIN });
          }
        }
      }
      $pluginInstance.find('.previous').get(0).disabled = (page <= 1);
      $pluginInstance.find('.next').get(0).disabled = (page >= PDFView.pages.length);
    }, true);

    function handleMouseWheel(evt) {
      var MOUSE_WHEEL_DELTA_FACTOR = 40;
      var ticks = (evt.type === 'DOMMouseScroll') ? -evt.detail :
                  evt.wheelDelta / MOUSE_WHEEL_DELTA_FACTOR;
      var direction = (ticks < 0) ? 'zoomOut' : 'zoomIn';

      if (evt.ctrlKey) { // Only zoom the pages, not the entire viewer
        evt.preventDefault();
        PDFView[direction](Math.abs(ticks));
      } else if (PresentationMode.active) {
        PDFView.mouseScroll(ticks * MOUSE_WHEEL_DELTA_FACTOR);
      }
    }

    $pluginInstance.get(0).addEventListener('DOMMouseScroll', handleMouseWheel);
    $pluginInstance.get(0).addEventListener('mousewheel', handleMouseWheel);

    $pluginInstance.get(0).addEventListener('click', function click(evt) {
      if (PresentationMode.active && evt.button === 0) {
        // Necessary since preventDefault() in 'mousedown' won't stop
        // the event propagation in all circumstances in presentation mode.
        evt.preventDefault();
      }
    }, false);

    $pluginInstance.get(0).addEventListener('keydown', function keydown(evt) {
      if (PasswordPrompt.visible) {
        return;
      }

      var handled = false;
      var cmd = (evt.ctrlKey ? 1 : 0) |
                (evt.altKey ? 2 : 0) |
                (evt.shiftKey ? 4 : 0) |
                (evt.metaKey ? 8 : 0);

      // First, handle the key bindings that are independent whether an input
      // control is selected or not.
      if (cmd === 1 || cmd === 8 || cmd === 5 || cmd === 12) {
        // either CTRL or META key with optional SHIFT.
        switch (evt.keyCode) {
          case 70: // f
            if (!PDFView.supportsIntegratedFind) {
              PDFFindBar.open();
              handled = true;
            }
            break;
          case 71: // g
            if (!PDFView.supportsIntegratedFind) {
              PDFFindBar.dispatchEvent('again', cmd === 5 || cmd === 12);
              handled = true;
            }
            break;
          case 61: // FF/Mac '='
          case 107: // FF '+' and '='
          case 187: // Chrome '+'
          case 171: // FF with German keyboard
            PDFView.zoomIn();
            handled = true;
            break;
          case 173: // FF/Mac '-'
          case 109: // FF '-'
          case 189: // Chrome '-'
            PDFView.zoomOut();
            handled = true;
            break;
          case 48: // '0'
          case 96: // '0' on Numpad of Swedish keyboard
            // keeping it unhandled (to restore page zoom to 100%)
            setTimeout(function () {
              // ... and resetting the scale after browser adjusts its scale
              PDFView.setScale(DEFAULT_SCALE, true);
            });
            handled = false;
            break;
        }
      }

      // CTRL or META without shift
      if (cmd === 1 || cmd === 8) {
        switch (evt.keyCode) {
          case 83: // s
            PDFView.download();
            handled = true;
            break;
        }
      }

      // CTRL+ALT or Option+Command
      if (cmd === 3 || cmd === 10) {
        switch (evt.keyCode) {
          case 80: // p
            Toolbar.presentationModeClick();
            handled = true;
            break;
          case 71: // g
            // focuses input.pageNumber field
            $pluginInstance.find('.pageNumber').get(0).select();
            handled = true;
            break;
        }
      }

      if (handled) {
        evt.preventDefault();
        return;
      }

      // Some shortcuts should not get handled if a control/input element
      // is selected.
      var curElement = document.activeElement || document.querySelector(':focus');
      var curElementTagName = curElement && curElement.tagName.toUpperCase();
      if (curElementTagName === 'INPUT' ||
          curElementTagName === 'TEXTAREA' ||
          curElementTagName === 'SELECT') {
          return;
      }

      if (cmd === 0) { // no control key pressed at all.
        switch (evt.keyCode) {
          case 38: // up arrow
          case 33: // pg up
          case 8: // backspace
            if (!PresentationMode.active &&
                PDFView.currentScaleValue !== 'page-fit') {
              break;
            }
            /* in presentation mode */
            /* falls through */
          case 37: // left arrow
            // horizontal scrolling using arrow keys
            if (PDFView.isHorizontalScrollbarEnabled) {
              break;
            }
            /* falls through */
          case 75: // 'k'
          case 80: // 'p'
            PDFView.page--;
            handled = true;
            break;
          case 27: // esc key
            if (!PDFView.supportsIntegratedFind && PDFFindBar.opened) {
              PDFFindBar.close();
              handled = true;
            }
            break;
          case 40: // down arrow
          case 34: // pg down
          case 32: // spacebar
            if (!PresentationMode.active &&
                PDFView.currentScaleValue !== 'page-fit') {
              break;
            }
            /* falls through */
          case 39: // right arrow
            // horizontal scrolling using arrow keys
            if (PDFView.isHorizontalScrollbarEnabled) {
              break;
            }
            /* falls through */
          case 74: // 'j'
          case 78: // 'n'
            PDFView.page++;
            handled = true;
            break;

          case 36: // home
            if (PresentationMode.active) {
              PDFView.page = 1;
              handled = true;
            }
            break;
          case 35: // end
            if (PresentationMode.active) {
              PDFView.page = PDFView.pdfDocument.numPages;
              handled = true;
            }
            break;
          case 82: // 'r'
            PDFView.rotatePages(90);
            break;
        }
      }

      if (cmd === 4) { // shift-key
        switch (evt.keyCode) {
          case 32: // spacebar
            if (!PresentationMode.active &&
                PDFView.currentScaleValue !== 'page-fit') {
              break;
            }
            PDFView.page--;
            handled = true;
            break;

          case 82: // 'r'
            PDFView.rotatePages(-90);
            break;
        }
      }

      if (!handled && !PresentationMode.active) {
        // 33=Page Up  34=Page Down  35=End    36=Home
        // 37=Left     38=Up         39=Right  40=Down
        if (evt.keyCode >= 33 && evt.keyCode <= 40 &&
            !PDFView.container.contains(curElement)) {
          // The page container is not focused, but a page navigation key has been
          // pressed. Change the focus to the viewer container to make sure that
          // navigation by keyboard works as expected.
          PDFView.container.focus();
        }
        // 32=Spacebar
        if (evt.keyCode === 32 && curElementTagName !== 'BUTTON') {
          if (!PDFView.container.contains(curElement)) {
            PDFView.container.focus();
          }
        }
      }

      if (cmd === 2) { // alt-key
        switch (evt.keyCode) {
          case 37: // left arrow
            if (PresentationMode.active) {
              PDFHistory.back();
              handled = true;
            }
            break;
          case 39: // right arrow
            if (PresentationMode.active) {
              PDFHistory.forward();
              handled = true;
            }
            break;
        }
      }

      if (handled) {
        evt.preventDefault();
        PDFView.clearMouseScrollState();
      }
    });

    (function animationStartedClosure() {
      // The offsetParent is not set until the pdf.js iframe or object is visible.
      // Waiting for first animation.
      var requestAnimationFrame = window.requestAnimationFrame ||
                                  window.mozRequestAnimationFrame ||
                                  window.webkitRequestAnimationFrame ||
                                  window.oRequestAnimationFrame ||
                                  window.msRequestAnimationFrame ||
                                  function startAtOnce(callback) { callback(); };
      PDFView.animationStartedPromise = new Promise(function (resolve) {
        requestAnimationFrame(function onAnimationFrame() {
          resolve();
        });
      });
    })();

    return this;
  };
})(jQuery);
