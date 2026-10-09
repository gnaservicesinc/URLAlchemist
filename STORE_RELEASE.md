# GitHub releases and browser store submissions

The **Release and submit browser stores** workflow builds both browser targets
from an annotated `vMAJOR.MINOR.PATCH` tag. It installs the locked dependencies,
runs all tests, generates bundled Action Packs, builds the extensions, and
creates a GitHub Release with the Chrome ZIP, Firefox XPI, readable source ZIPs
and tarballs, and `SHA256SUMS.txt`.

The Chrome and Firefox jobs then submit those exact release assets independently.
Firefox receives its reviewer source ZIP with the version submission. Neither
store job rebuilds the package. Failed or missing Firefox credentials do not
prevent the Chrome job or GitHub Release from succeeding.

## One-time credentials

Set these in [URLAlchemist Actions secrets and variables](https://github.com/gnaservicesinc/URLAlchemist/settings/secrets/actions).
Never commit credentials, paste them into issues, or include them in source ZIPs.

| Store | Actions setting | Purpose |
| --- | --- | --- |
| Chrome | Variable `CWS_PUBLISHER_ID` | Publisher owning the existing URL Alchemist listing |
| Chrome | Secret `CWS_SERVICE_ACCOUNT_JSON` | Google service-account JSON authorized for that publisher |
| Firefox | Secret `AMO_JWT_ISSUER` | Mozilla API key belonging to an owner/developer of the existing listing |
| Firefox | Secret `AMO_JWT_SECRET` | Matching Mozilla API secret |

Chrome credentials are configured for this repository. The Google service account
was verified against the URL Alchemist item with a read-only status request.
Firefox requires its separate Mozilla API credential pair before submission.

For Chrome, enable the Chrome Web Store API in the service account's Google Cloud
project and add the account under **Chrome Web Store Developer Dashboard → Account
→ Service account**. Find the publisher ID under **Publisher → Settings**. The
human contact email is a separate field. See Google's
[service-account guide](https://developer.chrome.com/docs/webstore/service-accounts).
An existing PVT service account can serve this extension when it has access to the
same publisher; a read-only status check confirms access to this specific item.

If a publisher uses OAuth instead, the Chrome script also accepts all three
Actions secrets `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, and `CWS_REFRESH_TOKEN`.

For Firefox, sign in as an owner/developer of URL Alchemist and obtain the key and
secret on [Mozilla's API credentials page](https://addons.mozilla.org/en-US/developers/addon/api/key/).
Mozilla credentials authenticate an account and can be reused for its other
owned add-ons; they are separate from Google's credentials. See
[Mozilla API authentication](https://mozilla.github.io/addons-server/topics/api/auth.html).

Secrets can be set through GitHub Settings or `gh secret set NAME --repo
gnaservicesinc/URLAlchemist`, which reads the value interactively or from stdin.
GitHub cannot return the plaintext of an existing encrypted Actions secret.

## Release a new version

1. Update source, relevant help, reviewer notes, and `RELEASE_NOTES.md`.
2. Run `./change_version.sh MAJOR MINOR PATCH` to synchronize browser versions and
   build the artifacts. Run `npm test` and complete the relevant browser smoke.
3. Commit the intended source changes and create an annotated tag matching both
   manifests, for example `git tag -a v2.8.0 -m 'URL Alchemist 2.8.0'`.
4. Push the branch and tag. The tag starts the release workflow automatically.
5. Inspect each job and its summary. Check the GitHub Release assets and each
   store's actual response before reporting the outcome.

The workflow does not overwrite an existing GitHub Release. Firefox retries use
the submission tools from the selected workflow revision with the tagged release
metadata and exact published archives, allowing API fixes without changing tags.
A retry of a store
uses the immutable packages already attached to that release, avoiding a rebuild
with different bytes or timestamps.

## Retry or inspect one store

Open **Actions → Release and submit browser stores → Run workflow**, select
`main`, enter the existing annotated release tag, and choose:

- `submit-chrome` or `submit-firefox` to retry that store with the published assets.
- `status-chrome` or `status-firefox` for a read-only status check.
- `release` only when the GitHub Release has not yet been created.

Chrome skips an already submitted matching version and stops if another version
is awaiting review/staged or the listing has a policy warning. Firefox records
the original upload and source SHA-256 digests in private reviewer notes: AMO
signing changes the XPI checksum, so the signed download hash cannot identify
the original upload. A retry must match those saved digests and the listed
version, and it verifies that reviewer source remains attached. An existing
version submitted through a different process requires dashboard inspection.

If an API request times out, inspect the dashboard or run a status check before
retrying. Explicit AMO rate-limit responses honor `Retry-After` with fresh JWTs
and up to four retries; waits above ten minutes stop safely for a later retry.
The scripts fail on unconfirmed versions, rejected/disabled AMO files,
invalid uploads, mismatched identities, and missing reviewer source. They never
print credentials, access tokens, or raw API error bodies.

## Local checks

After `npm run build`:

```bash
npm run test:release
npm run release:package
RELEASE_DIR="$PWD/.release-local/release" npm run store:chrome -- --dry-run
RELEASE_DIR="$PWD/.release-local/release" npm run store:firefox -- --dry-run
```

`--dry-run` verifies manifests, checksums, and reviewer source without credentials
or network requests. `--preflight` additionally validates credential structure
without network requests. `--status` makes read-only store requests. `--submit`
uploads and submits for review. The output JSON names the version and observed
state; GitHub job summaries keep review/publication distinct.

Source packages exclude dependencies, generated builds, cached results, local
release tools, environment files, private keys, and nested extension/archive
uploads. The reviewer build uses the included `package-lock.json` and recorded
`RELEASE_BUILD_TIME.txt` to regenerate the bundled examples and extension.

## Release status vocabulary

A successful GitHub Release is a download/release handoff. Chrome
`PENDING_REVIEW` and Firefox `unreviewed` mean submitted and awaiting review.
Approval and public rollout are separate. Confirm `PUBLISHED`/`public` and the
version on the listing before calling a store release live.

- [Chrome listing](https://chromewebstore.google.com/detail/url-alchemist/ijonigkmhlokmdhcjcjinhpionfnjdeo)
- [Firefox listing](https://addons.mozilla.org/en-US/firefox/addon/url-alchemist/)
- [GitHub Releases](https://github.com/gnaservicesinc/URLAlchemist/releases)
- [Chrome upload API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
- [Chrome submit/status API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
- [AMO version and source API](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create)
