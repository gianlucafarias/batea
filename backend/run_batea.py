"""Punto de entrada de la app empaquetada (PyInstaller). En desarrollo se usa `python -m batea.main`."""
import multiprocessing

if __name__ == "__main__":
    multiprocessing.freeze_support()   # los procesos de análisis se relanzan con este mismo ejecutable
    from batea.main import main

    main()
