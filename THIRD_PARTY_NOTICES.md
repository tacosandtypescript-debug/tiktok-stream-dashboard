# Third-party notices

The Windows TTS sidecar is a separate PyInstaller executable. It contains the
components below, resolved by the checked-in `services/tts-provider/requirements.lock`.
The application license in `LICENSE` does not replace or restrict these
licenses.

| Component | Locked version | License | Source / license reference |
| --- | ---: | --- | --- |
| edge-tts | 7.2.3 | LGPL-3.0-or-later; `srt_composer.py` is MIT | [upstream repository](https://github.com/rany2/edge-tts) |
| PyInstaller | 6.16.0 | GPL-2.0-or-later with the PyInstaller bootloader exception | [license](https://github.com/pyinstaller/pyinstaller/blob/main/COPYING.txt) |
| pyinstaller-hooks-contrib | 2026.7 | Apache-2.0 | [upstream repository](https://github.com/pyinstaller/pyinstaller-hooks-contrib) |
| aiohttp | 3.14.3 | Apache-2.0 | [license](https://github.com/aio-libs/aiohttp/blob/master/LICENSE.txt) |
| aiohappyeyeballs | 2.7.1 | MIT | [upstream repository](https://github.com/aio-libs/aiohappyeyeballs) |
| aiosignal | 1.4.0 | Apache-2.0 | [upstream repository](https://github.com/aio-libs/aiosignal) |
| altgraph | 0.17.5 | MIT | [upstream repository](https://github.com/ronaldoussoren/altgraph) |
| attrs | 26.1.0 | MIT | [license](https://github.com/python-attrs/attrs/blob/main/LICENSE) |
| certifi | 2026.7.22 | MPL-2.0 | [license](https://github.com/certifi/python-certifi/blob/master/LICENSE) |
| frozenlist | 1.8.0 | Apache-2.0 | [upstream repository](https://github.com/python-hyper/frozenlist) |
| idna | 3.20 | BSD-3-Clause | [license](https://github.com/kjd/idna/blob/master/LICENSE.rst) |
| multidict | 6.8.0 | Apache-2.0 | [upstream repository](https://github.com/aio-libs/multidict) |
| packaging | 26.3 | Apache-2.0 or BSD-2-Clause | [license](https://github.com/pypa/packaging/blob/main/LICENSE) |
| pefile | 2023.2.7 | MIT | [upstream repository](https://github.com/erocarrera/pefile) |
| propcache | 0.5.4 | Apache-2.0 | [upstream repository](https://github.com/aio-libs/propcache) |
| pywin32-ctypes | 0.2.3 | BSD-3-Clause | [upstream repository](https://github.com/enthought/pywin32-ctypes) |
| setuptools | 84.0.0 | MIT | [license](https://github.com/pypa/setuptools/blob/main/LICENSE) |
| tabulate | 0.10.0 | MIT | [license](https://github.com/astanin/python-tabulate/blob/master/LICENSE) |
| typing-extensions | 4.16.0 | PSF-2.0 | [license](https://github.com/python/typing_extensions/blob/main/LICENSE) |
| yarl | 1.25.1 | Apache-2.0 | [upstream repository](https://github.com/aio-libs/yarl) |

## Source offer

For the LGPL-covered `edge-tts` component and any other component whose license
requires source availability, the corresponding source is identified by the
upstream links above and the exact wheel versions are fixed in the lock file.
The sidecar is distributed as a separate executable so that it remains a
separable work from the Rust/Tauri application.

The generated `tiktok-tts-provider-<target>.exe` is not committed to Git. A
release build must retain this notice, `LICENSE`, and the lock file alongside
the release records.
