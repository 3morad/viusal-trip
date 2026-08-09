# CHROMA

A gesture-driven psychedelic music visualizer.

Spotify's playback audio is sealed behind DRM and its analysis endpoints were
deprecated in November 2024, so the architecture splits the roles: Spotify
supplies track metadata, while the audio itself is captured from a loopback
device, a microphone, or a local file and analysed in the browser.

**[Read the build spec](docs/index.html)** for the signal path, the DSP chain,
the gesture mappings, the renderer and the build order. The page runs a live
WebGL2 prototype of the core claim, and will drive itself from your microphone
if you let it.

## Layout

- `docs/index.html` plus `engine.js` and `playground.js` are the playground: a
  fullscreen visualiser driven by audio and hand tracking.
- `docs/vendor/` holds the MediaPipe runtime and hand model, vendored so there
  is no CDN dependency and no network call at runtime.
- `docs/spec.html` is the written build spec, generated from `body.html` by
  `build.sh`. It carries its own inline copy of the engine and is a frozen
  reference; the playground is the live code.

## Running it

```sh
cd docs && python3 -m http.server 8000
```

Microphone and camera both need localhost or https, and neither works inside a
cross origin frame that withholds the permission.

## Controls

Hands first, pointer as fallback. Pinch drives zoom and warp, hand height
shifts hue, wrist roll spins the field, closing your hand holds the trails,
and two hands moving apart opens the kaleidoscope. A fist holds, an open palm
resets, two fingers changes scene.

Keys: `1` `2` `3` scene, `H` hands on or off, `F` fullscreen, `Space` hold.
