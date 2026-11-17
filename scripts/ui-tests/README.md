# Pruebas de interfaz (sin ventanas)

Controlan un Chrome sin ventana (headless) contra servidores de prueba con datos falsos. **No tocan tu biblioteca.**
Necesitan `puppeteer-core` instalado **fuera** del proyecto (para no sumar dependencias a la app):

```sh
mkdir /tmp/pp && cd /tmp/pp && npm init -y && npm i puppeteer-core@23
cp /ruta/a/batea/scripts/ui-tests/*.mjs .
```

Servidores de prueba (cada uno con su propia carpeta de datos y sin rekordbox; ver RELEASING.md → «Probar cómo se comporta sin rekordbox»):

| Puerto | Qué es | Datos |
|---|---|---|
| 8766 | instalación nueva | base vacía |
| 8768 | usuario que ya tiene temas | una carpeta con un `.wav` de más de 2 minutos, traída con `POST /api/discover` |

Los dos se levantan con `BATEA_AUTODISCOVER=0` y una carpeta personal falsa (`HOME=…`) para que nunca recorran tu disco.

```sh
node welcome-first-run.mjs /ruta/a/Music/MisTemas   # arranque, pregunta, indicador, importar una carpeta, interruptor, repetir, usuario existente
```

Para ver las diapositivas con cada estado de progreso sin esperar: `http://127.0.0.1:8766/#slide=3&demo=sync` (`demo` = `waiting`, `sync`, `discover`, `done` o `empty`; sin `demo` se ve la primera pantalla, la pregunta).
