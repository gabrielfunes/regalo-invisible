# Amigo invisible FugaLos · v1 para Cloudflare Workers

El amigo invisible de la familia: cada uno entra con su nombre y su PIN, deja su lista de deseos y abre su sobre. Sin registro, sin app que instalar desde una store (es una PWA). Diseño «Postal»: papel crema, verde pino y granate, sobre que se abre manteniendo pulsado, nieve y confeti.

## Cómo funciona

- Gabri es el organizador: crea los participantes, pone el PIN de cada uno, carga las parejas del año pasado (para no repetirlas) y lanza el sorteo desde su panel. Si no lo hace antes, el sorteo se hace solo el día de cierre a las 23:59 (hora de Madrid).
- La familia entra por la misma URL: toca su nombre y pone su PIN. La sesión queda guardada en el dispositivo (60 días), sin registro ni correo.
- Cada uno solo ve lo suyo: su lista de deseos, su pista recibida y, tras el sorteo, su sobre. El sobre se abre manteniendo pulsado.
- El organizador ve quién se ha apuntado y quién ha abierto su sobre, pero **nunca las asignaciones ni las listas ajenas**: así también puede jugar.
- Los peques son participantes normales con su PIN; entran desde el móvil de un adulto («Cambiar de cuenta» en Info).

## Arquitectura

- `public/index.html`: interfaz estática completa, sin proceso de build (entrada, participante y panel del organizador).
- `src/worker.js`: API, sesiones, sorteo, validación y avisos.
- `Sorteo`: un Durable Object con almacenamiento SQLite persistente.
- `wrangler.jsonc`: binding `SORTEO`, assets y migración `v1-sorteo-sqlite` del almacén.
- `test/`: pruebas del reparto (derangement con exclusiones) y de la validación.

Regla de la casa: antes de cambios grandes, la versión vigente se conserva íntegra en su rama (v1, v2, …) y se anota a grandes rasgos en `CHANGELOG.md`.

## Configuración en Cloudflare (a cargo del propietario)

1. Crea un **Worker nuevo** llamado `regalo-invisible` (el nombre de `wrangler.jsonc` debe coincidir) o despliega por CLI.
2. Añade **ADMIN_PASSWORD** como **Secret** (no como variable visible ni en el repo): la contraseña del panel de Gabri, de al menos 8 caracteres.
3. Despliegue: `npm ci && npx wrangler deploy`, o conecta el repo al Worker con `main` como rama de producción, sin build del frontend (`npm ci` y comando `npx wrangler deploy`, Node 22+).
4. No cambies el binding `SORTEO`, la clase ni el identificador `regalo-invisible-v1` en posteriores despliegues: forman parte de la identidad del almacén persistente.
5. Verifica que estás en **Workers Free** antes de desplegar. Los límites gratuitos se comparten con el resto de tu cuenta.

Por CLI:

```sh
npm ci
npx wrangler login
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

## Avisos push

- Web push (VAPID + aes128gcm, en `src/worker.js` sin dependencias): recordatorio 3 días antes del cierre, el día del cierre, cuando el sorteo está hecho, la víspera y el día del regalo. La clave VAPID se genera y se guarda en el propio Durable Object (`vapid`): no hay secretos nuevos en Cloudflare.
- Cada dispositivo activa los avisos en la pestaña Info. En Android funcionan en el navegador; en iPhone/iPad hace falta instalar la app en la pantalla de inicio (iOS 16.4+). Las suscripciones muertas (404/410 del servicio push) se borran solas.
- Las notificaciones nunca llevan asignaciones ni deseos: solo textos genéricos («¡Ya está hecho el sorteo!»). Viajan cifradas de extremo a extremo. El envío depende de los servicios push de los navegadores y es de máximo esfuerzo.

## Uso y seguridad

- El PIN lo pone el organizador (4 a 8 dígitos) y es la llave de cada participante; cambiarlo cierra las sesiones de esa persona. El servidor guarda su hash y también el PIN a la vista del organizador, que es quien lo reparte.
- La sesión del participante dura 60 días y la del organizador 30; token aleatorio de 256 bits en cookie `HttpOnly`, `Secure` y `SameSite=Strict`. El servidor comprueba su vencimiento en cada petición.
- Máximo 10 intentos de entrada por IP en 15 minutos (compartido por usuarios de la misma conexión).
- Las asignaciones (`assign:`) y las pistas (`hint:`) solo se sirven al participante al que pertenecen. La exportación JSON del organizador (`/api/export`) no las incluye.
- Validación de campos, origen y tamaño de peticiones en servidor. Máximo 50 participantes y 20 deseos por lista.
- El reparto es un derangement con exclusiones por nombre (las parejas del año pasado): si no hay combinación posible, avisa en vez de repetir.
- La fuente de Google Fonts se mantiene para el estilo «Postal». El navegador solicita la tipografía a Google; los datos del sorteo no se incluyen en esas peticiones.

## Desarrollo local y pruebas

```sh
npm ci
npm test          # reparto y validación
ADMIN_PASSWORD=una-contraseña-larga npm run dev   # http://localhost:8787
```
