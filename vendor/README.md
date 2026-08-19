Vendored pure-Python dependencies so the app runs on hosts where `pip install`
is not possible (e.g. PythonAnywhere free accounts). `app.py` uses the installed
package when available and falls back to this directory otherwise.

- tinydb 4.9.0 — MIT licence (see tinydb/LICENSE) — https://github.com/msiemens/tinydb
