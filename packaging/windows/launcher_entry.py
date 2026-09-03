"""PyInstaller entry script; kept outside the package so analysis sees the import."""

from biomed_launcher.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
