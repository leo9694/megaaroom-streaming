# Video processing

## Installation and cleanup

Windows updates use a unique `MegaRoomAuxiliar/releases/<timestamp-id>` directory
for the archive, extraction and npm ci. Existing executables are never unlinked
by an update. The launcher switches only after dependencies and JS syntax pass;
running helpers are not terminated. If port 43123 is occupied, installation asks
the user to finish current work and reopen the launcher. Shared jobs, pairing
and CPU settings remain in `~/.megaaroom-local`. Old releases are retained.

Completed helper jobs are hidden unless History is expanded; errors stay visible.
Deleting a catalogue item marks deletionPending, blocks further playback/jobs,
stops only that entry's FFmpeg processes, and removes its upload folder, parent
and episode stream directories (including temp/batch outputs), import tickets
and watch progress before dropping the catalogue record. Concurrent local return
transfers must finish first. Failure keeps the flagged item for retry instead of
silently losing the reference to leftover files. Shared migrated source folders
referenced by another catalogue item are retained. In-memory tombstones prevent
queued FFmpeg jobs and stale progress saves from recreating deleted data.

## Local PC helper

Series details include an add-episodes form targeting the same stored season.
Files are naturally sorted by filename, then numbered from an explicit first
episode (default: highest existing number + 1). Overlapping numbers reject the
whole batch; existing IDs, metadata, watch progress and media are retained.
Direct VPS uploads can skip video optimization or process selected qualities;
local prepared uploads carry a targetSeriesId in the upload ticket and append
only after validated artifacts arrive. Receiver-side append is serialized with
other catalogue writes, including a second conflict check on completion.
Each episode saves its own processing options. Additional upload folders are
tracked for full season deletion. The episode list refreshes independently of
the video element. The existing helper protocol is reused (no helper upgrade).

The browser estimates remaining time from a bounded recent-progress window
(60 seconds for byte transfers, 180 seconds for coarse processing percentages).
Estimates require at least five seconds and positive measured progress. Each
card resets its estimator on a phase/profile change, retry, or long idle gap.
Unknown totals and stalled progress show nonnumeric waiting/calculating states.
The display explicitly estimates the current download/processing/upload scope,
not an unsupported total including future phases or season queue items. It
reuses existing progress polls/events and needs no helper upgrade or timers.

Helper v5 attaches live machine resources to active /jobs snapshots: aggregate
CPU busy percentage from deltas in os.cpus().times, total/used physical RAM,
and selected CPU profile/thread limit. This is whole-machine usage, not per-job
or FFmpeg attribution. CPU stays null until a sampling interval has elapsed.
Sampling is cached for one second and triggered only by active-job snapshots;
the UI reuses its three-second progress poll, with no subprocess or extra timer.
Finished/queued/error jobs do not retain or display live resource numbers.

For series, the post-upload optimization form offers the selected episode or
the entire stored season. Season jobs are sorted by numeric episodeNumber
(1, 2, 3, ..., 10), regardless of catalogue array order. VPS requests register
all eligible entries on the shared sequential queue in one operation. Local
requests reserve the season and issue one scoped ticket per eligible episode;
helper v4 accepts the complete batch, persists it and queues it numerically.
The batch continues after page reload. Ready/unsupported episodes are skipped.
One failed episode is shown independently and does not stop later queue items.
CPU profiles and quality selection apply to the selected batch. Initial local
upload processing and individual post-upload optimization remain supported.

The existing-media optimization form also offers VPS/local and CPU profile
selection, even for uploads originally sent with processing disabled. The local
helper v3 downloads only the authorized original, prepares selected HLS outputs,
and streams artifacts back to the existing movie/episode. Ticket URLs restrict
download/upload to one entry; no VPS login credentials are shared. A reservation
blocks simultaneous server HLS generation while that ticket remains pending.
Delete a failed local task to cancel the reservation, or retry the same task.
Tickets expire in seven days. The helper must remain running throughout download,
processing and upload; jobs and progress persist as with initial local uploads.

New output segments use immutable batch directories. Publication merges quality
playlists and keeps prior segments so active players and saved watch progress are
preserved. The original file is not reuploaded or replaced. Reopen playback after
completion to see the extra qualities. The CPU setting uses the same saved local
profile and takes effect from the next FFmpeg process.

Legacy local imports whose source/cover URLs omitted the upload folder are
repaired when reading the catalogue if the corresponding original exists. New
imports generate relative URLs from the full uploads root. Original playback
prefers an existing original-video AAC MP4, and missing media responds with 404
instead of falling through to the app HTML page.

The upload form can target the VPS or this computer. The local option requires
the loopback helper (`npm run local-helper -- https://your-domain.example`).
The Windows installer at `/install-local.ps1` installs Node.js if needed using
an interactive winget installation and installs bundled FFmpeg/ffprobe via npm.
It prints a pairing code, restricted to the site origin chosen at installation.
Remote sites must use HTTPS and the browser must allow local network access.
The helper binds only 127.0.0.1:43123 and requires the pairing key and origin
for every request. It never accepts arbitrary commands or shell arguments.

Originals first copy from the browser to the helper disk. Once that request
completes, jobs survive page reload/close. The helper prepares all selected
audio, text subtitles and HLS using the same pipeline as the VPS. Large output
files stream from disk directly to the VPS with a seven-day upload ticket
limited to a single new movie/season. Existing VPS Basic Auth credentials
are never shared with the helper. The receiver validates paths and playlists,
publishes after all files arrive, and does not enqueue FFmpeg. Original video
is retained for the Original playback option. Incompatible original codecs
still depend on device support; bitmap subtitles retain existing limitations.

Jobs and temporary media live in `~/.megaaroom-local`. Successful media is
removed locally after publication. Failed jobs retain files for retry through
the site; restarting the helper marks interrupted jobs for manual retry.
Retry repeats an interrupted transfer (no byte-range upload resume). The VPS
ticket makes completed transfers idempotent. Installation/first copy require
the browser to stay open; the actual processing and VPS upload do not.
Allow disk capacity for originals, per-audio original MP4 copies and HLS.
The single transfer contains all originals and renditions for one movie/season.
The domain's reverse proxy must allow that total body size and long uploads:
in its MegaRoom `server` block use `client_max_body_size 0;`, and in the app
location use `proxy_request_buffering off;`, `proxy_read_timeout 3600;` and
`proxy_send_timeout 3600;`. Limit these changes to this app's domain. Node and
the local helper disable the default request timeout for large file transfers.
The helper has persistent CPU profiles: economy (up to two threads), balanced
(half the logical CPUs), fast (three quarters), and maximum (all logical CPUs).
Filters use at most eight threads. Fast/maximum use normal OS priority;
economy/balanced use below-normal. These are codec thread limits, not CPU quotas.
Changes apply when the next FFmpeg process starts; active processes continue
with their original limits. AsyncLocalStorage scopes this policy to local jobs,
leaving the VPS defaults unchanged. GPU encoding is not enabled by these profiles.
Authenticated helper settings are available at GET/POST /settings. Failed jobs
can be removed with POST /jobs/:id/delete; deletion is blocked for other states
and resolved temporary paths are validated before removal. Removal only touches
the job's helper uploads, generated streams, and job record, not original user
files or published VPS media. Update the installed helper to enable these APIs.

Run `node --test local-processing.test.js` for real FFmpeg + authenticated
receiver coverage, independent of production. This validates local components,
not browser network permission UX or an actual customer machine installation.

New movie and season uploads offer an opt-in processing checkbox and separate
480p, 720p and 1080p choices. These settings persist in the catalogue, including
after a server restart. Legacy items without settings keep all qualities.
With processing off, audio preparation copies the original video stream and
encodes audio as before; subtitles remain available through the existing
extraction path. No fallback video encoding is allowed in that mode. Playback
therefore requires device support for the original video codec. A selected
quality above the source dimensions is skipped rather than upscaled.

Optimization keeps the 480p, 720p and 1080p renditions when the source
dimensions allow them, without upscaling. Existing completed HLS is reused.
Outputs remain H.264 8-bit with AAC stereo, with the existing bitrate limits.
AUTO selection and player buffer settings are unchanged.

FFmpeg jobs share one serial queue per Node process, including audio and
subtitle requests. Run only one PM2 instance for this application. Decoder
and encoder threads default to half the available CPUs, with a minimum of
one and a maximum of two. Filters use one thread. The child process requests
below-normal OS priority. This reserves capacity but is not a hard CPU quota.

The superfast encoder preset trades some compression efficiency for less
encoding work. The bitrate ceilings are retained; detailed scenes may lose
some fidelity compared with veryfast. HLS frame rates above 30 are capped at
30, while lower frame rates are preserved.

Set MEDIA_THREADS=1 for the lowest CPU pressure, or up to 4 on larger hosts.
Increasing this value may reduce elapsed time at the cost of CPU usage.
Limits apply after restarting the app; they do not change running FFmpeg
processes. These changes do not delete or automatically reconvert ready media.

Validate locally with: node --test media-processing.test.js progress-store.test.js
Real movie conversion time depends on source resolution, duration and VPS CPU;
the synthetic smoke test is not a production benchmark.
