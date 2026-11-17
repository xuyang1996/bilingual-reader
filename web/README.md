# KAI Trans web

- [`h5/`](h5/) contains the text translator served at [h5.kaitrans.eu.cc](https://h5.kaitrans.eu.cc/) and loaded by the Android app at [app.kaitrans.eu.cc](https://app.kaitrans.eu.cc/).
- [`website/`](website/) contains the [product website](https://home.kaitrans.eu.cc/) and its [privacy policy](https://home.kaitrans.eu.cc/privacy/).

Both directories contain static HTML, CSS, JavaScript and assets. Serve each directory as a separate web root. To preview locally from the repository root, run these commands in separate terminals.

```sh
python3 -m http.server 8467 --bind 127.0.0.1 --directory web/h5
python3 -m http.server 8468 --bind 127.0.0.1 --directory web/website
```

The Chrome Web Store package builder excludes this directory.
