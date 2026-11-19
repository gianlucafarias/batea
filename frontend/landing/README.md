# Landing de Batea

Desde `frontend`, corré `npm ci` y `npm run dev:landing` para ver la landing. `npm run build:landing` genera `landing/dist`. El servidor de Vite sirve la UI y, con la clave pública configurada, el widget. La función `/api/beta` se ejecuta en Vercel o con `vercel dev` desde el proyecto enlazado.

## Vercel

1. Importá el repositorio y elegí `frontend` como Root Directory. El archivo `vercel.json` define la compilación, la carpeta de salida y el preset de Vite.
2. En Google Cloud, habilitá Google Sheets API. Creá una cuenta de servicio dedicada, sin roles de IAM sobre el proyecto. Compartí solamente [Batea - Lista beta](https://docs.google.com/spreadsheets/d/1GS3oa7OK_yCkBwV76smak3PZCveQNmoTbF3DF94ZU20/edit) con su correo, como Editora. Dejá el acceso general en Restringido. La función guarda la fecha UTC y el email en la pestaña `Solicitudes`.
3. En Cloudflare Turnstile, creá un widget administrado y autorizá el hostname del sitio. En Vercel, cargá las variables de `.env.example` antes del build:

   | Variable | Valor |
   | --- | --- |
   | `VITE_TURNSTILE_SITE_KEY` | Clave pública del widget |
   | `TURNSTILE_SECRET_KEY` | Clave privada del widget |
   | `GOOGLE_SHEETS_SPREADSHEET_ID` | ID entre `/d/` y `/edit` en la URL de la hoja |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | Contenido del archivo JSON de la cuenta de servicio |

   Marcá las dos credenciales privadas como sensibles en Vercel. Cargalas directamente en el panel, sin incluirlas en Git. Para pruebas con escritura real, usá un dominio y una hoja de prueba en el entorno Preview.
4. Comprobá el despliegue con un email de prueba. Tras la confirmación en la página, verificá que aparezca una fila nueva en Sheets.

El formulario confirma la recepción de la solicitud. Las invitaciones se gestionan desde la hoja.
