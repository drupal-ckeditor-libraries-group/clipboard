﻿/*
Copyright (c) 2003-2011, CKSource - Frederico Knabben. All rights reserved.
For licensing, see LICENSE.html or http://ckeditor.com/license
*/

/*
 * EXECUTION FLOWS:
 * -- CTRL+C
 *		* browser's default behaviour
 * -- CTRL+V
 *		* listen onKey (onkeydown)
 *		* simulate 'beforepaste' for non-IEs on editable
 *		* simulate 'paste' for Fx2/Opera on editable
 *		* listen 'onpaste' on editable ('onbeforepaste' for IE)
 *		* fire 'beforePaste' on editor
 *		* !canceled && getClipboardDataByPastebin
 *		* fire 'paste' on editor
 *		* !canceled && fire 'afterPaste' on editor
 * -- CTRL+X
 *		* listen onKey (onkeydown)
 *		* fire 'saveSnapshot' on editor
 *		* browser's default behaviour
 *		* deferred second 'saveSnapshot' event
 * -- Copy command
 *		* tryToCutCopy
 *			* execCommand
 *		* !success && alert
 * -- Cut command
 *		* fixCut
 *		* tryToCutCopy
 *			* execCommand
 *		* !success && alert
 * -- Paste command
 *		* fire 'paste' on editable ('beforepaste' for IE)
 *		* !canceled && execCommand 'paste'
 *		* !success && fire 'pasteDialog' on editor
 * -- Paste from native context menu & menubar
 *		(Fx & Webkits are handled in 'paste' default listner.
 *		Opera cannot be handled at all because it doesn't fire any events
 *		Special treatment is needed for IE, for which is this part of doc)
 *		* listen 'onpaste'
 *		* cancel native event
 *		* fire 'beforePaste' on editor
 *		* !canceled && getClipboardDataByPastebin
 *		* execIECommand( 'paste' ) -> this fires another 'paste' event, so cancel it
 *		* fire 'paste' on editor
 *		* !canceled && fire 'afterPaste' on editor
 *
 *
 * PASTE EVENT - PREPROCESSING:
 * -- Possible data types: auto, text, html.
 * -- Possible data contents:
 *		* text (possible \n\r)
 *		* htmlified text (text + br,div,p - no presentional markup & attrs - depends on browser)
 *		* html
 * -- Possible flags:
 *		* htmlified - if true then content is a HTML even if no markup inside. This flag is set
 *			for content from editable pastebins, because they 'htmlify' pasted content.
 *
 * -- Type: auto:
 *		* content: text ->				filter, htmlify, set type: text
 *		* content: htmlified text ->	filter, unify text markup (brs, ps, divs), set type: text
 *		* content: html ->				filter, set type: html
 * -- Type: text:
 *		* content: text ->				filter, htmlify
 *		* content: htmlified text ->	filter, unify text markup
 *		* content: html ->				filter, strip presentional markup, unify text markup
 * -- Type: html:
 *		* content: text ->				filter
 *		* content: htmlified text ->	filter
 *		* content: html ->				filter
 *
 * -- Phases:
 *		* filtering (priorities 3-5) - e.g. pastefromword filters
 *		* content type sniffing (priority 6)
 *		* markup transformations for text (priority 6)
 */

/**
 * @file Clipboard support
 */

'use strict';

(function() {
	// Register the plugin.
	CKEDITOR.plugins.add( 'clipboard', {
		requires: [ 'dialog' ],
		init: function( editor ) {
			var textificationFilter;

			initClipboard( editor );

			CKEDITOR.dialog.add( 'paste', CKEDITOR.getUrl( this.path + 'dialogs/paste.js' ) );

			// Filter webkit garbage.
			editor.on( 'paste', function( evt ) {
				var data = evt.data.data,
					blockElements = CKEDITOR.dtd.$block;

				if ( data.indexOf( 'Apple-' ) > -1 ) {
					// Replace special webkit's &nbsp; with simple space, because webkit
					// produces them even for normal spaces.
					data = data.replace( /<span class="Apple-converted-space">&nbsp;<\/span>/gi, ' ' );

					// Strip <span> around white-spaces when not in forced 'html' content type.
					// This spans are created only when pasting plain text into Webkit,
					// but for safety resons remove them always.
					if ( evt.data.type != 'html' )
						data = data.replace( /<span class="Apple-tab-span"[^>]*>([^<]*)<\/span>/gi, '$1' );

					// This br is produced only when copying & pasting HTML content.
					if ( data.indexOf( '<br class="Apple-interchange-newline">' ) > -1 ) {
						evt.data.startsWithEOL = 1;
						evt.data.preSniffing = 'html'; // Mark as not text.
						data = data.replace( /<br class="Apple-interchange-newline">/, '' );
					}

					// Remove all other classes.
					data = data.replace( /(<[^>]+) class="Apple-[^"]*"/gi, '$1' );
				}

				if ( CKEDITOR.env.ie ) {
					// &nbsp; <p> -> <p> (br.cke-pasted-remove will be removed later)
					data = data.replace( /^&nbsp;(?: |\r\n)?<(\w+)/g, function( match, elementName ) {
						if ( elementName.toLowerCase() in blockElements ) {
							evt.data.preSniffing = 'html'; // Mark as not a text.
							return '<' + elementName;
						}
						return match;
					});
				} else if ( CKEDITOR.env.webkit ) {
					// </p><div><br></div> -> </p><br>
					// We don't mark br, because this situation can happen for htmlified text too.
					data = data.replace( /<\/(\w+)><div><br><\/div>$/, function( match, elementName ) {
						if ( elementName in blockElements ) {
							evt.data.endsWithEOL = 1;
							return '</' + elementName + '>';
						}
						return match;
					});
				}

				evt.data.data = data;
			}, null, null, 3 );

			editor.on( 'paste', function( evt ) {
				var dataObj = evt.data,
					type = dataObj.type,
					data = dataObj.data,
					isHtmlified = dataObj.htmlified,
					trueType;

				// If forced type is 'html' we don't need to know true data type.
				if ( type == 'html' || dataObj.preSniffing == 'html' )
					trueType = 'html';
				else
					trueType = recogniseContentType( data, isHtmlified );

				// Htmlify.
				if ( trueType == 'text' )
					data = textHtmlification( editor, data );
				// Unify text markup.
				else if ( trueType == 'htmlifiedtext' )
					data = htmlifiedTextHtmlification( data );
				// Strip presentional markup & unify text markup.
				else if ( type == 'text' && trueType == 'html' ) {
					// Init filter only if needed and cache it.
					data = htmlTextification( data, textificationFilter || ( textificationFilter = getTextificationFilter( editor ) ) );
				}

				if ( dataObj.startsWithEOL )
					data = '<br data-cke-eol="1">' + data;
				if ( dataObj.endsWithEOL )
					data += '<br data-cke-eol="1">';

				if ( type == 'auto' )
					type = ( trueType == 'html' ? 'html' : 'text' );

				dataObj.htmlified = true;
				dataObj.type = type;
				dataObj.data = data;
				delete dataObj.preSniffing;
				delete dataObj.startsWithEOL;
				delete dataObj.endsWithEOL;
			}, null, null, 6 );

			// Inserts processed data into the editor at the end of the
			// events chain.
			editor.on( 'paste', function( evt ) {
				var data = evt.data;
				if ( data.type == 'html' )
					editor.insertHtml( data.data );
				else if ( data.type == 'text' )
					editor.insertText( data.data, data.htmlified );

				// Deferr 'afterPaste' so all other listeners for 'paste' will be fired first.
				setTimeout( function() {
					editor.fire( 'afterPaste' );
				}, 0 );
			}, null, null, 1000 );

			editor.on( 'pasteDialog', function( evt ) {
				// TODO it's possible that this setTimeout is not needed any more,
				// because of changes introduced in the same commit as this comment.
				// Editor.getClipboardData adds listner to the dialog's events which are
				// fired after a while (not like 'showDialog').
				setTimeout( function() {
					// Open default paste dialog.
					editor.openDialog( 'paste', evt.data );
				}, 0 );
			});
		}
	});

	function initClipboard( editor ) {
		var preventBeforePasteEvent = 0,
			preventPasteEvent = 0,
			inReadOnly = 0,
			// Safari doesn't like 'beforepaste' event - it sometimes doesn't
			// properly handles ctrl+c. Probably some race-condition between events.
			// Chrome and Firefox works well with both events, so better to use 'paste'
			// which will handle pasting from e.g. browsers' menu bars.
			// IE7/8 doesn't like 'paste' event for which it's throwing random errors.
			mainPasteEvent = CKEDITOR.env.ie ? 'beforepaste' : 'paste';

		addListeners();
		addButtonsCommands();

		/**
		 * Paste data into the editor.
		 * Editor will:
		 * 		* Fire paste events (beforePaste, paste, afterPaste).
		 *		* Recognise data type (html or text).
		 * 		* If text is pasted then it will be "htmlificated".
		 *			* <strong>Note:</strong> two subsequent line-breaks will introduce one paragraph. This depends on <code>{@link CKEDITOR.config.enterMode}</code>;
		 * 			* A single line-break will be instead translated into one &lt;br /&gt;.
		 * @name CKEDITOR.editor.paste
		 * @param {String} data Data (text or html) to be pasted.
		 */
		editor.paste = function( data ) {
			return firePasteEvents( 'auto', data, 1 );
		};

		/**
		 * Get clipboard data by directly accessing the clipboard (IE only) or opening paste dialog.
		 * @param {Object} [options.title] Title of paste dialog.
		 * @param {Function} callback Function that will be executed with data.type and data.data or null if none
		 * 		of the capturing method succeeded.
		 * @example
		 * editor.getClipboardData( { title : 'Get my data' }, function( data )
		 * {
		 *		if ( data )
		 *			alert( data.type + ' ' + data.data );
		 * });
		 */
		editor.getClipboardData = function( options, callback ) {
			var beforePasteNotCanceled = false,
				dataType = 'auto',
				dialogCommited = false;

			// Options are optional - args shift.
			if ( !callback ) {
				callback = options;
				options = null;
			}

			// Listen with maximum priority to handle content before everyone else.
			// This callback will handle paste event that will be fired if direct
			// access to the clipboard succeed in IE.
			editor.on( 'paste', onPaste, null, null, 0 );

			// Listen at the end of listeners chain to see if event wasn't canceled
			// and to retrieve modified data.type.
			editor.on( 'beforePaste', onBeforePaste, null, null, 1000 );

			// getClipboardDataDirectly() will fire 'beforePaste' synchronously, so we can
			// check if it was canceled and if any listener modified data.type.

			// If command didn't succeed (only IE allows to access clipboard and only if
			// user agrees) open and handle paste dialog.
			if ( getClipboardDataDirectly() === false ) {
				// Direct access to the clipboard wasn't successful so remove listener.
				editor.removeListener( 'paste', onPaste );

				// If beforePaste was canceled do not open dialog.
				// Add listeners only if dialog really opened. 'pasteDialog' can be canceled.
				if ( beforePasteNotCanceled && editor.fire( 'pasteDialog', onDialogOpen ) ) {
					editor.on( 'pasteDialogCommit', onDialogCommit );

					// 'dialogHide' will be fired after 'pasteDialogCommit'.
					editor.on( 'dialogHide', function( evt ) {
						evt.removeListener();
						evt.data.removeListener( 'pasteDialogCommit', onDialogCommit );

						// Because Opera has to wait a while in pasteDialog we have to wait here.
						setTimeout( function() {
							// Notify even if user canceled dialog (clicked 'cancel', ESC, etc).
							if ( !dialogCommited )
								callback( null );
						}, 10 );
					});
				} else
					callback( null );
			}

			function onPaste( evt ) {
				evt.removeListener();
				evt.cancel();
				callback( evt.data );
			}

			function onBeforePaste( evt ) {
				evt.removeListener();
				beforePasteNotCanceled = true;
				dataType = evt.data.type;
			}

			function onDialogCommit( evt ) {
				evt.removeListener();
				// Cancel pasteDialogCommit so paste dialog won't automatically fire
				// 'paste' evt by itself.
				evt.cancel();
				dialogCommited = true;
				callback({ type: dataType, data: evt.data, htmlified: true } );
			}

			function onDialogOpen() {
				this.customTitle = ( options && options.title );
			}
		};

		function addButtonsCommands() {
			addButtonCommand( 'Cut', 'cut', createCutCopyCmd( 'cut' ), 1 );
			addButtonCommand( 'Copy', 'copy', createCutCopyCmd( 'copy' ), 4 );
			addButtonCommand( 'Paste', 'paste', createPasteCmd(), 8 );

			function addButtonCommand( buttonName, commandName, command, ctxMenuOrder ) {
				var lang = editor.lang[ commandName ];

				editor.addCommand( commandName, command );
				editor.ui.addButton && editor.ui.addButton( buttonName, {
					label: lang,
					command: commandName
				});

				// If the "menu" plugin is loaded, register the menu item.
				if ( editor.addMenuItems ) {
					editor.addMenuItem( commandName, {
						label: lang,
						command: commandName,
						group: 'clipboard',
						order: ctxMenuOrder
					});
				}
			}
		}

		function addListeners() {
			editor.on( 'key', onKey );
			editor.on( 'contentDom', addListenersToEditable );

			// For improved performance, we're checking the readOnly state on selectionChange instead of hooking a key event for that.
			editor.on( 'selectionChange', function( evt ) {
				inReadOnly = evt.data.selection.getRanges()[ 0 ].checkReadOnly();
				setToolbarStates();
			});

			// If the "contextmenu" plugin is loaded, register the listeners.
			if ( editor.contextMenu ) {
				editor.contextMenu.addListener( function( element, selection ) {
					inReadOnly = selection.getRanges()[ 0 ].checkReadOnly();
					return {
						cut: stateFromNamedCommand( 'Cut' ),
						copy: stateFromNamedCommand( 'Copy' ),
						paste: stateFromNamedCommand( 'Paste' )
					};
				});
			}
		}

		/**
		 * Add events listeners to editable.
		 */
		function addListenersToEditable() {
			var editable = editor.editable();

			// We'll be catching all pasted content in one line, regardless of whether
			// it's introduced by a document command execution (e.g. toolbar buttons) or
			// user paste behaviors (e.g. CTRL+V).
			editable.on( mainPasteEvent, function( evt ) {
				if ( CKEDITOR.env.ie && preventBeforePasteEvent )
					return;

				// If you've just asked yourself why preventPasteEventNow() is not here, but
				// in listener for CTRL+V and exec method of 'paste' command
				// you've asked the same question we did.
				//
				// THE ANSWER:
				//
				// First thing to notice - this answer makes sense only for IE,
				// because other browsers don't listen for 'paste' event.
				//
				// What would happen if we move preventPasteEventNow() here?
				// For:
				// * CTRL+V - IE fires 'beforepaste', so we prevent 'paste' and pasteDataFromClipboard(). OK.
				// * editor.execCommand( 'paste' ) - we fire 'beforepaste', so we prevent
				//		'paste' and pasteDataFromClipboard() and doc.execCommand( 'Paste' ). OK.
				// * native context menu - IE fires 'beforepaste', so we prevent 'paste', but unfortunately
				//		on IE we fail with pasteDataFromClipboard() here, because of... we don't know why, but
				//		we just fail, so... we paste nothing. FAIL.
				// * native menu bar - the same as for native context menu.
				//
				// But don't you know any way to distinguish first two cases from last two?
				// Only one - special flag set in CTRL+V handler and exec method of 'paste'
				// command. And that's what we did using preventPasteEventNow().

				pasteDataFromClipboard( evt );
			});

			// It's not possible to clearly handle all four paste methods (ctrl+v, native menu bar
			// native context menu, editor's command) in one 'paste/beforepaste' event in IE.
			//
			// For ctrl+v & editor's command it's easy to handle pasting in 'beforepaste' listener,
			// so we do this. For another two methods it's better to use 'paste' event.
			//
			// 'paste' is always being fired after 'beforepaste' (except of weird one on opening native
			// context menu), so for two methods handled in 'beforepaste' we're canceling 'paste'
			// using preventPasteEvent state.
			//
			// 'paste' event in IE is being fired before getClipboardDataByPastebin executes its callback.
			//
			// QUESTION: Why didn't you handle all 4 paste methods in handler for 'paste'?
			//		Wouldn't this just be simpler?
			// ANSWER: Then we would have to evt.data.preventDefault() only for native
			//		context menu and menu bar pastes. The same with execIECommand().
			//		That would force us to mark CTRL+V and editor's paste command with
			//		special flag, other than preventPasteEvent. But we still would have to
			//		have preventPasteEvent for the second event fired by execIECommand.
			//		Code would be longer and not cleaner.
			CKEDITOR.env.ie && editable.on( 'paste', function( evt ) {
				if ( preventPasteEvent )
					return;
				// Cancel next 'paste' event fired by execIECommand( 'paste' )
				// at the end of this callback.
				preventPasteEventNow();

				// Prevent native paste.
				evt.data.preventDefault();

				pasteDataFromClipboard( evt );

				// Force IE to paste content into pastebin so pasteDataFromClipboard will work.
				if ( !execIECommand( 'paste' ) )
					editor.openDialog( 'paste' );
			});

			// [IE] Dismiss the (wrong) 'beforepaste' event fired on context/toolbar menu open. (#7953)
			if ( CKEDITOR.env.ie ) {
				editable.on( 'contextmenu', preventBeforePasteEventNow, null, null, 0 );

				editable.on( 'beforepaste', function( evt ) {
					if ( evt.data && !evt.data.$.ctrlKey )
						preventBeforePasteEventNow();
				}, null, null, 0 );

			}

			editable.on( 'beforecut', function() {
				!preventBeforePasteEvent && fixCut( editor );
			});

			editable.on( 'mouseup', function() {
				setTimeout( function() {
					setToolbarStates();
				}, 0 );
			});

			editable.on( 'keyup', setToolbarStates );
		}

		/**
		 * Create object representing Cut or Copy commands.
		 */
		function createCutCopyCmd( type ) {
			return {
				type: type,
				canUndo: type == 'cut', // We can't undo copy to clipboard.
				startDisabled: true,
				exec: function( data ) {
					this.type == 'cut' && fixCut();

					var success = tryToCutCopy( this.type );

					if ( !success )
						alert( editor.lang.clipboard[ this.type + 'Error' ] ); // Show cutError or copyError.

					return success;

					/**
					 * Attempts to execute the Cut and Copy operations.
					 */
					function tryToCutCopy( type ) {
						if ( CKEDITOR.env.ie )
							return execIECommand( type );

						// non-IEs part
						try {
							// Other browsers throw an error if the command is disabled.
							return editor.document.$.execCommand( type, false, null );
						} catch ( e ) {
							return false;
						}
					}
				}
			}
		}

		function createPasteCmd() {
			return {
				// Snapshots are done manually by editable.insertXXX methods.
				canUndo: false,
				async: true,

				exec: function() {
					var cmd = this;

					editor.getClipboardData( function( data ) {
						data && firePasteEvents( data.type, data.data, 0, 1 );

						editor.fire( 'afterCommandExec', {
							name: 'paste',
							command: cmd,
							returnValue: !!data
						});
					});
				}
			};
		}

		function preventPasteEventNow() {
			preventPasteEvent = 1;
			// For safety reason we should wait longer than 0/1ms.
			// We don't know how long execution of quite complex getClipboardData will take
			// and in for example 'paste' listner execCommand() (which fires 'paste') is called
			// after getClipboardData finishes.
			// Luckily, it's impossible to immediately fire another 'paste' event we want to handle,
			// because we only handle there native context menu and menu bar.
			setTimeout( function() {
				preventPasteEvent = 0;
			}, 100 );
		}

		function preventBeforePasteEventNow() {
			preventBeforePasteEvent = 1;
			setTimeout( function() {
				preventBeforePasteEvent = 0;
			}, 10 );
		}

		/**
		 * Tries to execute any of the paste, cut or copy commands in IE. Returns a
		 * boolean indicating that the operation succeeded.
		 * @param {String} command *LOWER CASED* name of command ('paste', 'cut', 'copy').
		 */
		function execIECommand( command ) {
			var doc = editor.document,
				body = doc.getBody(),
				enabled = false,
				onExec = function() {
					enabled = true;
				};

			// The following seems to be the only reliable way to detect that
			// clipboard commands are enabled in IE. It will fire the
			// onpaste/oncut/oncopy events only if the security settings allowed
			// the command to execute.
			body.on( command, onExec );

			// IE6/7: document.execCommand has problem to paste into positioned element.
			( CKEDITOR.env.version > 7 ? doc.$ : doc.$.selection.createRange() )[ 'execCommand' ]( command );

			body.removeListener( command, onExec );

			return enabled;
		}

		function firePasteEvents( type, data, withBeforePaste, isHtmlified ) {
			var eventData = { type: type };

			if ( withBeforePaste ) {
				// Fire 'beforePaste' event so clipboard flavor get customized
				// by other plugins.
				if ( !editor.fire( 'beforePaste', eventData ) )
					return false; // Event canceled
			}

			// The very last guard to make sure the paste has successfully happened.
			// Moved here from editable#paste event listener to unify editor.paste() and
			// user paste behavior.
			// This guard should be after firing 'beforePaste' because for native pasting
			// 'beforePaste' is by default fired even for empty clipboard.
			if ( !data )
				return;

			// Reuse eventData.type because the default one could be changed by beforePaste listeners.
			eventData.data = data;
			eventData.htmlified = !!isHtmlified;

			return editor.fire( 'paste', eventData );
		}

		/**
		 * Cutting off control type element in IE standards breaks the selection entirely. (#4881)
		 */
		function fixCut() {
			if ( !CKEDITOR.env.ie || CKEDITOR.env.quirks )
				return;

			var sel = editor.getSelection(),
				control, range, dummy;

			if ( ( sel.getType() == CKEDITOR.SELECTION_ELEMENT ) && ( control = sel.getSelectedElement() ) ) {
				range = sel.getRanges()[ 0 ];
				dummy = editor.document.createText( '' );
				dummy.insertBefore( control );
				range.setStartBefore( dummy );
				range.setEndAfter( control );
				sel.selectRanges( [ range ] );

				// Clear up the fix if the paste wasn't succeeded.
				setTimeout( function() {
					// Element still online?
					if ( control.getParent() ) {
						dummy.remove();
						sel.selectElement( control );
					}
				}, 0 );
			}
		}

		/**
		 * Allow to peek clipboard content by redirecting the
		 * pasting content into a temporary bin and grab the content of it.
		 */
		function getClipboardDataByPastebin( evt, callback ) {
			var doc = editor.document,
				editable = editor.editable(),
				cancel = function( evt ) {
					evt.cancel();
				};

			// Avoid recursions on 'paste' event or consequent paste too fast. (#5730)
			if ( doc.getById( 'cke_pastebin' ) )
				return;

			var sel = editor.getSelection(),
				range = editor.createRange();

			// Create container to paste into.
			// For rich content we prefer to use "body" since it holds
			// the least possibility to be splitted by pasted content, while this may
			// breaks the text selection on a frame-less editable, "div" would be
			// the best one in that case, also in another case on old IEs moving the
			// selection into a "body" paste bin causes error panic.
			var pastebin = new CKEDITOR.dom.element( editable.is( 'body' ) && !CKEDITOR.env.ie ? 'body' : 'div', doc );

			pastebin.setAttribute( 'id', 'cke_pastebin' );
			editable.append( pastebin );

			pastebin.setStyles({
				position: 'absolute',
				// Position the bin exactly at the position of the selected element
				// to avoid any subsequent document scroll.
				top: sel.getStartElement().getDocumentPosition().y + 'px',
				width: '1px',
				height: '1px',
				overflow: 'hidden'
			});

			// Pull the paste bin off screen (when possible) since a small resize handler will be displayed around it.
			if ( editor.editable().is( 'body' ) )
				pastebin.setStyle( editor.config.contentsLangDirection == 'ltr' ? 'left' : 'right', '-1000px' );

			var bms = sel.createBookmarks();

			editor.on( 'selectionChange', cancel, null, null, 0 );

			// Temporarily move selection to the pastebin.
			range.setStartAt( pastebin, CKEDITOR.POSITION_AFTER_START );
			range.setEndAt( pastebin, CKEDITOR.POSITION_BEFORE_END );
			range.select( true );

			// Wait a while and grab the pasted contents.
			setTimeout( function() {
				// Restore properly the document focus. (#5684, #8849)
				editable.focus();

				// Grab the HTML contents.
				// We need to look for a apple style wrapper on webkit it also adds
				// a div wrapper if you copy/paste the body of the editor.
				// Remove hidden div and restore selection.
				var bogusSpan;
				pastebin = ( CKEDITOR.env.webkit && ( bogusSpan = pastebin.getFirst() ) && ( bogusSpan.is && bogusSpan.hasClass( 'Apple-style-span' ) ) ? bogusSpan : pastebin );

				// IE7: selection must go before removing pastebin. (#8691)
				sel.selectBookmarks( bms );

				editor.removeListener( 'selectionChange', cancel );

				pastebin.remove();
				callback( pastebin.getHtml() );
			}, 0 );
		}

		// Try to get content directly from clipboard, without native event
		// being fired before. In other words - synthetically get clipboard data
		// if it's possible.
		function getClipboardDataDirectly() {
			if ( CKEDITOR.env.ie ) {
				// Prevent IE from pasting at the begining of the document.
				editor.focus();

				// Command will be handled by 'beforepaste', but as
				// execIECommand( 'paste' ) will fire also 'paste' event
				// we're canceling it.
				preventPasteEventNow();

				if ( editor.editable().fire( mainPasteEvent ) && !execIECommand( 'paste' ) ) {
					return false;
				}
			} else {
				try {
					if ( editor.editable().fire( mainPasteEvent ) && !editor.document.$.execCommand( 'Paste', false, null ) ) {
						throw 0;
					}
				} catch ( e ) {
					return false;
				}
			}
		}

		/**
		 * Listens for some clipboard related keystrokes, so they get customized.
		 * Needs to be bind to keydown event.
		 */
		function onKey( event ) {
			if ( editor.mode != 'wysiwyg' )
				return;

			switch ( event.data.keyCode ) {
				// Paste
				case CKEDITOR.CTRL + 86: // CTRL+V
				case CKEDITOR.SHIFT + 45: // SHIFT+INS
					var editable = editor.editable();

					// Cancel 'paste' event because ctrl+v is for IE handled
					// by 'beforepaste'.
					preventPasteEventNow();

					// Simulate 'beforepaste' event for all none-IEs.
					!CKEDITOR.env.ie && editable.fire( 'beforepaste' );

					// Simulate 'paste' event for Opera/Firefox2.
					if ( CKEDITOR.env.opera || CKEDITOR.env.gecko && CKEDITOR.env.version < 10900 )
						editable.fire( 'paste' );
					return;

					// Cut
				case CKEDITOR.CTRL + 88: // CTRL+X
				case CKEDITOR.SHIFT + 46: // SHIFT+DEL
					// Save Undo snapshot.
					editor.fire( 'saveSnapshot' ); // Save before cut
					setTimeout( function() {
						editor.fire( 'saveSnapshot' ); // Save after cut
					}, 0 );
			}
		}

		function pasteDataFromClipboard( evt ) {
			// Default type is 'auto', but can be changed by beforePaste listeners.
			var eventData = { type: 'auto' };
			// Fire 'beforePaste' event so clipboard flavor get customized by other plugins.
			// If 'beforePaste' is canceled continue executing getClipboardDataByPastebin and then do nothing
			// (do not fire 'paste', 'afterPaste' events). This way we can grab all - synthetically
			// and natively pasted content and prevent its insertion into editor
			// after canceling 'beforePaste' event.
			var beforePasteNotCanceled = editor.fire( 'beforePaste', eventData );

			getClipboardDataByPastebin( evt, function( data ) {
				// Clean up.
				// Content can be trimmed because pasting space produces '&nbsp;'.
				data = CKEDITOR.tools.trim( data.replace( /<span[^>]+data-cke-bookmark[^<]*?<\/span>/ig, '' ) );

				// Fire remaining events (without beforePaste)
				beforePasteNotCanceled && firePasteEvents( eventData.type, data, 0, 1 );
			});
		}

		function setToolbarStates() {
			if ( editor.mode != 'wysiwyg' )
				return;

			var pasteState = stateFromNamedCommand( 'Paste' );

			editor.getCommand( 'cut' ).setState( stateFromNamedCommand( 'Cut' ) );
			editor.getCommand( 'copy' ).setState( stateFromNamedCommand( 'Copy' ) );
			editor.getCommand( 'paste' ).setState( pasteState );
			editor.fire( 'pasteState', pasteState );
		}

		function stateFromNamedCommand( command ) {
			var retval;

			if ( inReadOnly && command in { Paste:1,Cut:1 } )
				return CKEDITOR.TRISTATE_DISABLED;

			if ( command == 'Paste' ) {
				// IE Bug: queryCommandEnabled('paste') fires also 'beforepaste(copy/cut)',
				// guard to distinguish from the ordinary sources (either
				// keyboard paste or execCommand) (#4874).
				CKEDITOR.env.ie && ( preventBeforePasteEvent = 1 );
				try {
					// Always return true for Webkit (which always returns false)
					retval = editor.document.$.queryCommandEnabled( command ) || CKEDITOR.env.webkit;
				} catch ( er ) {}
				preventBeforePasteEvent = 0;
			}
			// Cut, Copy - check if the selection is not empty
			else {
				var ranges = editor.getSelection().getRanges();
				retval = !( ranges.length == 1 && ranges[ 0 ].collapsed );
			}

			return retval ? CKEDITOR.TRISTATE_OFF : CKEDITOR.TRISTATE_DISABLED;
		}
	}

	// Returns:
	// * 'text' if no html markup at all && !isHtmlified.
	// * 'htmlifiedtext' if content looks like transformed by browser from plain text.
	//		See clipboard/paste.html TCs for more info.
	// * 'html' if it's neither 'text' nor 'htmlifiedtext'.
	function recogniseContentType( data, isHtmlified ) {
		if ( !isHtmlified && !data.match( /<[^>]+>/g ) && !data.match( /&([a-z0-9]+|#[0-9]+);/gi ) )
			return 'text';

		if ( CKEDITOR.env.webkit ) {
			// Plain text or ( <div><br></div> and text inside <div> ).
			if ( !data.match( /^[^<]*$/g ) && !data.match( /^(<div><br( ?\/)?><\/div>|<div>[^<]*<\/div>)*$/gi ) )
				return 'html';
		} else if ( CKEDITOR.env.ie ) {
			// Text or <br> or text and <br> in <p>.
			if ( !data.match( /^([^<]|<br( ?\/)?>|<p>([^<]|<br( ?\/)?>)*<\/p>)*$/gi ) )
				return 'html';
		} else if ( CKEDITOR.env.gecko || CKEDITOR.env.opera ) {
			// Text or <br>.
			if ( !data.match( /^([^<]|<br( ?\/)?>)*$/gi ) )
				return 'html';
		} else
			return 'html';

		return 'htmlifiedtext';
	}

	// TODO Function shouldn't check selection - context will be fixed later.
	function textHtmlification( editor, text ) {
		var selection = editor.getSelection(),
			mode = selection.getStartElement().hasAscendant( 'pre', true ) ? CKEDITOR.ENTER_BR : editor.config.enterMode,
			isEnterBrMode = mode == CKEDITOR.ENTER_BR,
			tools = CKEDITOR.tools;

		var html = CKEDITOR.tools.htmlEncode( text.replace( /\r\n|\r/g, '\n' ) );

		// Convert leading and trailing whitespaces into &nbsp;
		html = html.replace( /^[ \t]+|[ \t]+$/g, function( match, offset, s ) {
			if ( match.length == 1 ) // one space, preserve it
			return '&nbsp;';
			else if ( !offset ) // beginning of block
			return tools.repeat( '&nbsp;', match.length - 1 ) + ' ';
			else // end of block
			return ' ' + tools.repeat( '&nbsp;', match.length - 1 );
		});

		// Convert subsequent whitespaces into &nbsp;
		html = html.replace( /[ \t]{2,}/g, function( match ) {
			return tools.repeat( '&nbsp;', match.length - 1 ) + ' ';
		});

		var paragraphTag = mode == CKEDITOR.ENTER_P ? 'p' : 'div';

		// Two line-breaks create one paragraph.
		if ( !isEnterBrMode ) {
			html = html.replace( /(\n{2})([\s\S]*?)(?:$|\1)/g, function( match, group1, text ) {
				return '<' + paragraphTag + '>' + text + '</' + paragraphTag + '>';
			});
		}

		// One <br> per line-break.
		html = html.replace( /\n/g, '<br>' );

		// Compensate padding <br> for non-IE.
		if ( !( isEnterBrMode || CKEDITOR.env.ie ) ) {
			html = html.replace( new RegExp( '<br>(?=</' + paragraphTag + '>)' ), function( match ) {
				return tools.repeat( match, 2 );
			});
		}

		return html;
	}

	// This function transforms what browsers produce when
	// pasting plain text into editable element (see clipboard/paste.html TCs
	// for more info) into correct HTML (similar to that produced by text2Html).
	function htmlifiedTextHtmlification( data ) {
		// Replace adjacent white-spaces with one space and unify all to spaces.
		data = data.replace( /(&nbsp;|\s)+/ig, ' ' )
		// Remove spaces before/after opening/closing tag.
		.replace( /> /g, '>' ).replace( / </g, '<' )
		// Normalize XHTML syntax.
		.replace( /<br ?\/>/gi, '<br>' );

		// IE - lower cased tags.
		data = data.replace( /<\/?[A-Z]+>/g, function( match ) {
			return match.toLowerCase();
		});

		// Webkit.
		if ( CKEDITOR.env.webkit && data.indexOf( '<div>' ) > -1 ) {
			// Two line breaks create one paragraph in Webkit.
			if ( data.match( /<div>(<br>| |)<\/div>/ ) )
				data = '<p>' + data.replace( /<div>(<br>| |)<\/div>/g, '</p><p>' ) + '</p>';
			// One line break create br.
			data = data.replace( /<\/div><div>/g, '<br>' );

			// Remove div tags that remained - they should be inside <p> tags.
			// See TCs for "incorrect recognition" to see why we cannot remove all divs.
			data = data.replace( /<\/div>(<br>)*<\/p>/g, '$1</p>' ).replace( /<p><div>/g, '<p>' );

			// Remove remaining divs.
			data = data.replace( /<\/?div>/g, '' );
		}

		// Opera and Firefox.
		if ( ( CKEDITOR.env.gecko || CKEDITOR.env.opera ) && data.indexOf( '<br><br>' ) > -1 ) {
			// Two line breaks create one paragraph, three - 2, four - 3, etc.
			data = '<p>' + data.replace( /(<br>){2,}/g, function( match ) {
				return CKEDITOR.tools.repeat( '</p><p>', match.length / 4 - 1 );
			}) + '</p>';
		}

		// Fix <brs>, but only at the beginning of the block, so we wont't break bogus <br>.
		return data.replace( /<p><br>/g, '<p></p><p>' );
	}

	// Filter can be editor dependent.
	function getTextificationFilter( editor ) {
		var filter = new CKEDITOR.htmlParser.filter();

		// Elements which creates vertical breaks (have vert margins) - took from HTML5 spec.
		// http://dev.w3.org/html5/markup/Overview.html#toc
		var replaceWithParaIf = { blockquote:1,dl:1,fieldset:1,h1:1,h2:1,h3:1,h4:1,h5:1,h6:1,ol:1,p:1,table:1,ul:1 },

			// All names except of <br>.
			stripInlineIf = CKEDITOR.tools.extend({ br: 0 }, CKEDITOR.dtd.$inline ),

			// What's finally allowed (cke:br will be removed later).
			allowedIf = { p:1,br:1,'cke:br':1 },

			knownIf = CKEDITOR.dtd,

			// All names that will be removed (with content).
			removeIf = CKEDITOR.tools.extend( { area:1,basefont:1,embed:1,iframe:1,map:1,object:1,param:1 }, CKEDITOR.dtd.$nonBodyContent, CKEDITOR.dtd.$cdata );

		var flattenTableCell = function( element ) {
				delete element.name;
				element.add( new CKEDITOR.htmlParser.text( ' ' ) );
			},
			// Squash adjacent headers into one. <h1>A</h1><h2>B</h2> -> <h1>A<br>B</h1><h2></h2>
			// Empty ones will be removed later.
			squashHeader = function( element ) {
				var next = element,
					br, el;

				while ( ( next = next.next ) && next.name && next.name.match( /^h\d$/ ) ) {
					// TODO shitty code - waitin' for htmlParse.element fix.
					br = new CKEDITOR.htmlParser.element( 'cke:br' );
					br.isEmpty = true;
					element.add( br );
					while ( el = next.children.shift() )
						element.add( el );
				}
			};

		filter.addRules({
			elements: {
				h1: squashHeader,
				h2: squashHeader,
				h3: squashHeader,
				h4: squashHeader,
				h5: squashHeader,
				h6: squashHeader,

				img: function( element ) {
					var alt = CKEDITOR.tools.trim( element.attributes.alt || '' ),
						txt = ' ';

					// Replace image with its alt if it doesn't look like an url or is empty.
					if ( alt && !alt.match( /(^http|\.(jpe?g|gif|png))/i ) )
						txt = ' [' + alt + '] ';

					return new CKEDITOR.htmlParser.text( txt );
				},

				td: flattenTableCell,
				th: flattenTableCell,

				$: function( element ) {
					var initialName = element.name,
						br;

					// Remove entirely.
					if ( removeIf[ initialName ] )
						return false;

					// Remove all attributes.
					delete element.attributes;

					// Pass brs.
					if ( initialName == 'br' )
						return element;

					// Elements that we want to replace with paragraphs.
					if ( replaceWithParaIf[ initialName ] )
						element.name = 'p';

					// Elements that we want to strip (tags only, without the content).
					else if ( stripInlineIf[ initialName ] )
						delete element.name;

					// Surround other known element with <brs> and strip tags.
					else if ( knownIf[ initialName ] ) {
						// TODO shitty code - waitin' for htmlParse.element fix.
						br = new CKEDITOR.htmlParser.element( 'cke:br' );
						br.isEmpty = true;

						// Replace hrs (maybe sth else too?) with only one br.
						if ( CKEDITOR.dtd.$empty[ initialName ] )
							return br;

						element.add( br, 0 );
						br = br.clone();
						br.isEmpty = true;
						element.add( br );
						delete element.name;
					}

					// Final cleanup - if we can still find some not allowed elements then strip their names.
					if ( !allowedIf[ element.name ] )
						delete element.name;
				}
			}
		});

		return filter;
	}

	function htmlTextification( data, filter ) {
		var fragment = new CKEDITOR.htmlParser.fragment.fromHtml( data ),
			writer = new CKEDITOR.htmlParser.basicWriter();

		fragment.writeHtml( writer, filter );
		data = writer.getHtml();

		// Cleanup cke:brs.
		data = data.replace( /\s*(<\/?[a-z:]+ ?\/?>)\s*/g, '$1' ) // Remove spaces around tags.
		.replace( /(<cke:br \/>){2,}/g, '<cke:br />' ) // Join multiple adjacent cke:brs
		.replace( /(<cke:br \/>)(<\/?p>|<br \/>)/g, '$2' ) // Strip cke:brs adjacent to original brs or ps.
		.replace( /(<\/?p>|<br \/>)(<cke:br \/>)/g, '$1' ).replace( /<(cke:)?br( \/)?>/g, '<br>' ) // Finally - rename cke:brs to brs and fix <br /> to <br>.
		.replace( /<p><\/p>/g, '' ); // Remove empty paragraphs.

		// Fix nested ps. E.g.:
		// <p>A<p>B<p>C</p>D<p>E</p>F</p>G
		// <p>A</p><p>B</p><p>C</p><p>D</p><p>E</p><p>F</p>G
		var nested = 0;
		return data.replace( /<\/?p>/g, function( match ) {
			if ( match == '<p>' ) {
				if ( ++nested > 1 )
					return '</p><p>';
			} else {
				if ( --nested > 0 )
					return '</p><p>';
			}

			return match;
		}).replace( /<p><\/p>/g, '' ); // Step before: </p></p> -> </p><p></p><p>. Fix this here.
	}
})();

/**
 * Fired when a clipboard operation is about to be taken into the editor.
 * Listeners can manipulate the data to be pasted before having it effectively
 * inserted into the document.
 * @name CKEDITOR.editor#paste
 * @since 3.1
 * @event
 * @param {String} data.type Type of data in data.data. Usually 'html' or 'text', but for listeners
 * 		with priority less than 6 it can be also 'auto', what means that content type has to be recognised
 * 		(this will be done by content type sniffer that listens with priority 6).
 * @param {String} data.data Data to be pasted - html or text.
 * @param {Boolean} [data.htmlified] If true then data are htmlified what means that they probably
 *		come frome editable pastebin or were transformed to HTML. They won't be encoded and should be treat
 *		as HTML even if they don't contain any markup.
 */

/**
 * Internal event to open the Paste dialog
 * @name CKEDITOR.editor#pasteDialog
 * @event
 * @param {Function} [data] Callback that will be passed to editor.openDialog.
 */
