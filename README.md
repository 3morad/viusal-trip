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

One base field runs on its own. Everything else you put there yourself.

| Gesture | Adds |
|---|---|
| Pinch thumb and finger | drops an orb that stays and breathes with the low end |
| Point one finger and move | paints a trail of shards that fade over a few seconds |
| Open your whole hand | pushes a ring out from your palm |
| Two hands moving apart | mirrors everything already placed |
| Close a fist and hold | wipes back to the base |

Hand height shifts hue, wrist roll spins the field, a closing hand holds the
trails. With no camera the pointer does the same work: tap drops an orb,
drag paints.

The camera and microphone are asked for together on the first tap, so it is
one permission prompt rather than two. An on screen guide covers the gestures
and takes itself away after a minute.

Keys: `H` hands, `M` mic, `F` fullscreen, `Space` hold, `Z` undo, `C` clear.
