URL Alchemist for Chrome 2.0

URL Alchemist 2.0 is a Chrome extension for building browser workflows from visual blocks. Create editable workspaces, compile them into portable binary Action Packs, and run those packs from page input data, hotkeys, context menus, intervals, or visible overlay events.

What it can do
Clean tracking links, rewrite URLs, search selected text, launch from clipboard text, capture page title or metadata, fetch HTTPS remote data, show messages and media in page overlays, copy structured output, and keep local per-pack logs.

Workspaces and Action Packs
Workspaces are the editable source files. They store the full block graph, trigger settings, metadata, and saved editor viewport. Action Packs are the optimized binary runtime files that Chrome executes. You can export either format: share a workspace when someone should edit the source, or share an Action Pack when they only need the reviewed runtime package.

Safer imports
Imported Action Packs are staged before install. URL Alchemist validates their schema, recomputes permissions and risk metadata, explains the compiled steps in plain language, and keeps the Confirm Import button locked until the pack is tested in the sandbox or explicitly reviewed. Action Packs cannot run imported JavaScript, eval, or downloaded code.

Current Chrome 2.0 highlights
- Visual workspace editor with drag-and-drop blocks, saved pan and zoom, recovery drafts, and pop-out editing.
- Run on input data from URL, selected text, link URL, page title, clipboard, page text, page links, page metadata, and related sources.
- Per-pack hotkeys recorded in the editor and matched by the content-script key listener.
- Remote data and asset blocks with HTTPS-only validation, byte limits, timeouts, and private-network blocking.
- Overlay-first interaction blocks for prompts, messages, image/video/audio display, input capture, keyboard events, mouse events, tick handlers, shared state, and grid drawing.
- Debugging tools including trace, per-pack logs, Save string to log, Abort, and uninstalled-file audit.
- Local-first backup and restore for settings, workspaces, Action Packs, metadata, and checksums.

Built-in examples
The Examples tab includes practical packs and workspaces such as Clean Campaign Links, Keep Stable Query, GitHub PR Files Shortcut, Search Selected Text, Clipboard Search Launcher, Remember Current Page, Copy Page Title, Debug Page Logger, Research Note Snapshot, Remote Text Fetch Preview, Remote POST Snapshot, Clean Words, Break Reminder, Playback Resume, Overlay Input Capture, and Snake Overlay Arcade. Examples are never installed automatically; you choose whether to install the compiled pack or open the workspace source.

Privacy and control
URL Alchemist stores data locally by default. Google Sync is optional and best-effort for small items. Clipboard access is optional. Local file navigation is disabled by default. Clipboard, raw page, remote request, page mutation, and overlay input behavior is surfaced as risk information before install.

Build the browser workflows you actually need, inspect what they do, and keep control over how your tabs, URLs, page data, and overlays behave.
