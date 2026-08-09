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

## Running it

`docs/index.html` is the artifact body; the artifact host supplies the document
shell. For anywhere else, generate a complete document from the same source:

```sh
./docs/build-standalone.sh          # writes docs/standalone.html
cd docs && python3 -m http.server 8000
```

Then open `http://localhost:8000/standalone.html`. Microphone capture needs
localhost or https, and it cannot work inside a cross origin frame that
withholds the permission, which is why the hosted artifact leads with the
file input instead.
