URL Alchemist

Google Chrome:
https://chromewebstore.google.com/detail/url-alchemist/ijonigkmhlokmdhcjcjinhpionfnjdeo

Firefox:
https://addons.mozilla.org/en-US/firefox/addon/url-alchemist/

URL Alchemist builds browser workflows from visual blocks. Create editable workspaces, compile them into portable binary Action Packs, and run those packs from page input data, hotkeys, context menus, intervals, conditional checks, or visible overlay events.

What it can do
Clean tracking links, rewrite URLs, search selected text, launch from clipboard text, capture page title, page text, links, and metadata, fetch HTTPS remote data, show prompts, messages, images, videos, and sounds in page overlays, copy text or structured output, mutate page text when approved, and keep local per-pack logs.

Workspaces and Action Packs
Workspaces are editable source files. They store the full block graph, trigger settings, metadata, compatibility notes, and saved editor viewport. Action Packs are optimized binary runtime files. Export a workspace when someone should inspect or edit the source; export an Action Pack when they only need the reviewed runtime package.

Safer imports
Imported Action Packs are staged before install. URL Alchemist validates their schema, recomputes permissions and risk metadata, explains the compiled steps in plain language, and keeps the Confirm Import button locked until the pack is tested in the sandbox or explicitly reviewed. Action Packs cannot run imported JavaScript, eval, or downloaded code.

Current highlights
- Visual workspace editor with drag-and-drop blocks, saved pan and zoom, recovery drafts, pop-out editing, variable declarations, and clear variable-use highlighting.
- Run on input data from URL, selected text, link URL, page title, clipboard, page text, page links, page metadata, and related sources.
- Trigger support for page input data, context menus, hotkeys, intervals, conditional runs, and event-driven overlays.
- String, regex, text transform, text split/join, URL query, list, dictionary, logic, math, loop, Substitution, Abort, SaveLoad, and shared-state blocks for building reusable workflows without custom code.
- Remote data and asset blocks with HTTPS-only validation, byte limits, timeouts, and private-network blocking.
- Overlay-first interaction blocks for prompts, messages, image/video/audio display, input capture, keyboard events, mouse events, tick handlers, shared state, and grid drawing.
- Debugging tools including trace, per-pack logs, Save string to log, export log, clear log, and automatic log rotation.
- Local-first backup and restore for settings, workspaces, Action Packs, metadata, checksums, and builder identity.

Built-in examples
The Examples tab includes practical packs and workspaces such as Clean Campaign Links, Keep Stable Query, Query Param Manager, GitHub PR Files Shortcut, Search Selected Text, Clipboard Search Launcher, Remember Current Page, Variable Use Across Runs, Copy Page Title, Clipboard Cleanup, Debug Page Logger, Research Note Snapshot, Uppercase Selection Clipboard, Remote Text Fetch Preview, Remote POST Snapshot, Clean Words, Break Reminder, Daily Break Once, Playback Resume, Overlay Input Capture, and Snake Overlay Arcade. Examples are never installed automatically; you choose whether to install the compiled pack or open the workspace source.

Privacy and control
URL Alchemist stores data locally by default. Profile sync is optional and best-effort for small items. Clipboard access is optional. Local file navigation is disabled by default. Clipboard, raw page, remote request, page mutation, and overlay input behavior are surfaced as risk information before install.

Build the browser workflows you actually need, inspect what they do, and keep control over how your tabs, URLs, page data, and overlays behave.

## Release packaging

From the repository root, run `./change_version.sh MAJOR MINOR PATCH` after dependencies and tests are ready. The command records one shared build timestamp, regenerates bundled artifacts once per browser, builds both targets, and creates a Chrome `.zip`, Firefox `.xpi`, reviewer source `.zip` files, versioned source `.tar.gz` files, and SHA-256 manifests in the existing artifact directories. Set `URL_ALCHEMIST_BUILD_TIME` explicitly when a predetermined timestamp is required; otherwise the script captures one UTC value and stores it in both reviewer source archives so reviewer builds use consistent release metadata.

Version 2.6.1 delivers a denser, polished workspace editor with compact inline-labelled blocks, a deduplicated Block Library, smoother connection rendering, and connection-driven Logical Flow layouts. Logical Flow branches now auto-position adopted subtrees, expand from measured block bounds, keep shared merges outside branch regions, and move as one live composite while dragging. V1 `.urlpack` import/conversion and older V2 migration paths remain available.
- Workspace and Action Pack artifacts remain on schema 9; supported older V2 schemas are migrated before validation.
- Removed version-file export/update metadata from workspace and Action Pack metadata; old fields are stripped during migration and export.
- Added local-only install metadata for trust source, review status, logging, locks, install timestamps, checksums, and Focus Guard statistics.
- Added IndexedDB resource storage keyed by SHA-256, with resources excluded from sync and bundled into exported artifacts.
- Added Focus Guard for local content-blocker workspaces with block/allow rules, custom block pages, optional image resources, stats, and lock levels.
- Added per-pack logging toggles. Fresh installs default logging off; migrated existing packs keep logging on.
- Added local-only Ollama builder settings and preview-first strict JSON workspace drafting with no runtime AI blocks.
