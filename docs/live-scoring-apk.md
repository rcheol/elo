# Same-phone live scoring: first version

## Confirmed scope

- One Android phone runs PRISM camera broadcasting and a movable HoneyServe score remote.
- The user confirms each game's final score in HoneyServe. PRISM can keep broadcasting across games.
- No automatic end at 21, deuce, or 30. A tied score cannot enter the existing ELO ranking; continue or cancel without a result.
- This is one game per session, not a best-of-three match engine.

## Build and install

The public `rcheol/elo` repository builds a test APK with GitHub Actions and publishes it
to [GitHub Releases](https://github.com/rcheol/elo/releases) after both build and lint succeed.
[Download the latest APK directly](https://github.com/rcheol/elo/releases/latest/download/honeyserve-live.apk)
and install `honeyserve-live.apk` on an Android 8+ phone. No GitHub login or ZIP extraction is needed.
Allow installation from the downloading app when Android asks.
Each successful main-branch build publishes its own release, source commit and SHA-256 checksum.
The download link always points to the latest published build. Release assets do not have the
seven-day expiration of the backup Actions artifact (`honeyserve-live-test-apk`).

The workflow uses a standard hosted runner, AGP 8.9.2, Gradle 8.11.1, JDK 17 and SDK 35.
It does not require Expo, a paid build account, or a streaming API key.
GitHub's public-repository standard runner minutes are free; artifact storage is quota-limited.
Local command with the same toolchain: `gradle -p android-live :app:assembleDebug :app:lintDebug`.

This is a debug-signed test APK, not a Play Store release. Each clean runner may create a different
debug certificate, so another build may require uninstalling the previous test APK. Do not uninstall
with unsent scores. A future release needs a stable private signing key stored only in CI secrets.

## First phone test

1. Log in to HoneyServe in the APK. Select two players on each team. Left/right mean each team's
   perspective facing the net, not camera-left for both teams. Select the first serving team and
   the team closest to the camera. The initial right player serves at 0:0.
2. Copy the `PRISM 고정 점수판` URL. It belongs to the signed-in scoring account, not an individual game.
   Choose `중계 준비` to send that game's players and 0:0 score to the fixed scoreboard.
3. In PRISM, add a Web Browser Widget using that URL. It has a transparent background.
   Use camera broadcast mode, not full screen capture: screen capture may record the floating controls.
4. In HoneyServe choose `점수 리모컨 띄우기` before broadcasting. Grant Android's display-over-other-apps
   permission, then press the remote button again. Open PRISM and start the YouTube stream.
   Tap `시작` on the floating remote without leaving PRISM. Drag the remote by its title.
5. Tap A+1 or B+1 after each rally. The displayed server/positions refer to the next service,
   not actual player tracking during a rally. The undo arrow reverts the last point or court switch.
6. Tap `종료` on the remote and confirm that this game's final score is correct. PRISM can stay live.
   This enables
   `최종 기록 저장`. Errors and pending saves stay visible in the dialog. Exactly one match is inserted
   and the normal ELO recalculation runs. `저장된 경기 기록 보기` opens that match in the ranking website.
   For another game, choose `새 경기`, select the players and choose `중계 준비`. The same PRISM
   widget switches to the new game automatically. Reopen the floating remote for that game.
   End the PRISM broadcast separately when the entire session is over.
7. Paste the YouTube live/VOD link in the controller. Enter the video timestamp (in seconds) at which
   `경기 시작` was tapped. It can be corrected after the match; start delays and video trimming make
   automatic wall-clock-to-VOD synchronization unreliable without YouTube metadata.
8. Open `중계 영상 · 득점 타임라인` in the website's match history. Each point has a timestamp link.
   `득점 장면 이어보기` plays from 8 seconds before to 3 seconds after each recorded point.
   These are playback windows, not downloaded/edited video clips or automatic rally segmentation.

Do a short private/unlisted test broadcast before using this for a real match. Check that PRISM
keeps the camera active when the overlay receives touches, that the overlay is absent from the
broadcast video, and that the browser widget continues refreshing on the specific phone.
Android/vendor battery restrictions, PRISM behavior, screen rotation, and interrupted networks
still need actual-device acceptance testing. Web automation cannot verify those properties.

APK 0.1.1 adds an explicit back-arrow button. It closes an open confirmation before navigating
back; if there is no previous page, it opens the ranking homepage. Android's system Back uses the
same behavior. Returning to a previously loaded homepage refreshes records without resetting scroll.
An unanswered save can be retried with the same operation ID without inserting a duplicate match.

## Data and recovery

- `live_sessions` is separate from `app_state`. Frequent overlay reads do not download rankings,
  profiles, or video-analysis frames. The account's fixed token and current game pointer are stored
  in `live_channels`. A 2-second ETag poll returns 304 if unchanged; between games it polls every
  5 seconds and keeps the final score until the next game is prepared. Session IDs are part of ETags
  so identical revision numbers in different games cannot hide the transition.
- Existing per-game overlay URLs still work for their original game and stop on finish. Replace the
  PRISM URL once with the new `#channel/...` URL to enable continuous games; no APK reinstall is needed.
- The read-only, unguessable overlay URL reveals only scoreboard data. It never authorizes writes.
  Anyone holding the fixed URL can also view future games scored by that account.
  Scoring requires the owner's unexpired login cookie. Other members and admins cannot control it.
- UUID operation keys and revision checks reject duplicate/conflicting operations. Android persists
  pending commands before sending, retries with the same key, and shows the last server-confirmed
  score plus the unsent count. Queued scores do not appear in PRISM until connectivity returns.
- Close/reopen the remote to resume pending sends in the same game. Do not finish on another screen
  while the remote has unsent scores. Conflicts pause sending and require explicit review/discard.
- Finish, match insertion and ELO changes share one database transaction. Failure rolls back both.
- Point tap time and server receipt time are separate. Undo excludes an event from the final timeline
  but preserves it in the audit ledger. Server-authoritative snapshots never trust a client score total.
- No camera video or audio is uploaded through Render. PRISM sends the stream directly to YouTube.
- Existing match edits change ELO but do not rewrite the original scoring ledger. A deleted match's
  public replay endpoint returns 404. Registered sessions are not recreated by retrying finish.
- Browser controllers retain the last session per account. APK cookies and queue are app-private and
  excluded from Android backup. No Google tokens or keys are stored or required in this version.

## Verification

```powershell
$env:PGLITE_TEST_MODULE = ([System.Uri](Join-Path (Get-Location) 'tmp/pg-regression/node_modules/@electric-sql/pglite/dist/index.js')).AbsoluteUri
node --test tests/live-engine.test.mjs tests/live-api.test.mjs tests/live-overlay.test.mjs tests/live-refresh.test.mjs tests/video-bandwidth.test.mjs tests/video-polling.test.mjs tests/video-review.test.mjs
$env:PLAYWRIGHT_TEST_MODULE = ([System.Uri](Join-Path (Get-Location) 'tmp/review-ui/node_modules/playwright/index.mjs')).AbsoluteUri
node tests/live-ui.mjs
```

These tests use isolated databases; they never insert test games into production.

## Sources

- PRISM Web Browser Widget: https://guide.prismlive.com/mobile/guides/widgets-and-effects/web-widget/using-web-browser-widget
- BWF Laws, doubles section 11: https://extranet.bwf.sport/docs/document-system/81/1466/1470/Section%204.1%20-%20Laws%20of%20Badminton%20-%2026%20April%202025%20V5.0%20(2)%20.pdf
- Android overlay permission: https://developer.android.com/reference/android/Manifest.permission#SYSTEM_ALERT_WINDOW
- Android foreground service specialUse: https://developer.android.com/develop/background-work/services/fgs/service-types#special-use
- AGP compatibility: https://developer.android.com/build/releases/agp-8-9-0-release-notes
- Free public runners: https://docs.github.com/en/billing/concepts/product-billing/github-actions
- YouTube playback API: https://developers.google.com/youtube/iframe_api_reference

Future optional single-button YouTube completion requires OAuth and the channel owner's consent:
https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition
It would not by itself guarantee that PRISM stops its local camera encoder. That integration is not
implemented in this version, following the user's choice to stop PRISM manually.
