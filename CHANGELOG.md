# Changelog

## v1.1.0 · 2026-11-24

- Las parejas del año pasado ya no las carga el organizador: cada participante indica en «Mi lista» a quién le regaló (solo lo usa el sorteo). Se quita ese apartado del panel.
- Cerrar sesión del panel más a mano (botón arriba) y que funcione aunque la sesión haya caducado, para entrar luego como participante.

## v1.0.1 · 2026-11-22

- La app pasa a llamarse «Amigo invisible FugaLos» (título, cabeceras, manifiesto PWA, notificaciones, mensaje de invitación y nombre por defecto del sorteo). Sin cambios técnicos: el worker y el almacén siguen llamándose igual.

## v1.0.0 · 2026-11-22

- Primera versión: sorteo de amigo invisible familiar en Cloudflare Workers (Worker + Durable Object SQLite, frontend estático sin build, PWA instalable).
- Entrada por nombre + PIN (sin registro); el organizador crea participantes, pone los PIN, carga las parejas del año pasado y lanza el sorteo (o se hace solo al cerrar el plazo, 23:59 Madrid).
- Reparto sin auto-regalos y sin repetir las parejas del año pasado; avisa si no hay combinación posible.
- Cada participante solo ve lo suyo: lista de deseos propia (texto + enlaces), sobre con «mantén pulsado» para revelar, lista de su amigo y pista anónima para él.
- El organizador ve quién se ha apuntado y quién ha abierto el sobre, nunca las asignaciones. Exportación manual sin asignaciones ni pistas.
- Avisos push (VAPID generado en el Durable Object): cierre de plazo, sorteo hecho, víspera y día del regalo.
- Diseño «Postal»: papel crema, verde pino y granate, sobre animado, nieve y confeti. Pruebas del reparto y de la validación.

