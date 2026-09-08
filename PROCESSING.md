# Video processing

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
