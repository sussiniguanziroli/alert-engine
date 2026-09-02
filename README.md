# alert-engine

Motor de alarmas y automatizaciones del panel **SF LightBug**. Corre como
servicio Node bajo pm2 en una VM de Google, conectado al broker MQTT local
(mosquitto) y a Firestore.

Hace dos cosas:

1. **Alarmas** — modelo de estados **ISA-18.2**
   (`UNACK → ACK → RTN_UNACK → Normal`) con journal inmutable.
2. **LightBug Automations** — reglas `condición → acción` que publican comandos
   MQTT por su cuenta.

## Arquitectura

```
ESP / dispositivos → MQTT (mosquitto localhost:1883)
                          ↓
                     alert-engine (este servicio)
                          ↓ escribe
   Firestore  tenants/{t}/alerts              (estado vivo de alarmas)
              tenants/{t}/alarm_events         (journal de alarmas)
              tenants/{t}/automation_events    (journal de automatizaciones)
              tenants/{t}/locations/{l}/automationState/{id}
              audit_logs                       (acciones sobre equipos)
              email_trigger_queue              (extensión Trigger Email)
                          ↑ lee
              tenants/{t}/locations/{l}         layout.widgets[].alertRules
                                                layout.automations[]
              …/automationPauses/{machineId}    (kill switch del operario)
```

| Módulo | Rol |
|---|---|
| `index.js` | Bootstrap: Firebase Admin + MQTT, suscripción a topics, loop de mensajes |
| `alertState.js` | Espejo en memoria + transiciones ISA-18.2 + journal + hooks |
| `evaluator.js` | Comparadores numéricos de las condiciones |
| `payload.js` | Lectura del valor y armado de comandos MQTT |
| `boolTokens.js` | Semántica on/off para el readback (gemelo del panel) |
| `rulesCache.js` | Cache reactivo de reglas de alerta (índice por topic) |
| `offlineWatcher.js` | Detección de equipos sin datos (registro reactivo) |
| `emailNotifier.js` | Envío de email (cooldown persistido + chequeo de shelve) |
| `automationsCache.js` | Cache reactivo de automatizaciones (3 índices + topics de readback) |
| `automationEngine.js` | Compuertas, antirrebote, ejecución y auditoría |
| `commandSender.js` | Publica con QoS1 y espera el readback del equipo |
| `pauseRegistry.js` | Espejo del kill switch por máquina |
| `scheduler.js` | Disparos por horario + recuperación de corridas perdidas |
| `cronMatch.js` | Cron acotado con zona horaria, sin dependencias |

## Cómo se dispara una automatización

Tres caminos, un solo ejecutor (`automationEngine.trigger`):

- **Por medición** — llega un mensaje MQTT, se evalúa la condición y se dispara
  en el **flanco** (falsa → verdadera), no en cada lectura que la sigue
  cumpliendo.
- **Por horario** — tick de un minuto, en la zona horaria de la *location*
  (`location.timezone`, default `America/Argentina/Buenos_Aires`). La VM corre
  en UTC: sin convertir, "las 6" arrancarían a las 3 de la mañana.
- **Por alarma** — hook en el `RAISE` de `alertState`, al lado del de email.

Antes de ejecutar, cuatro compuertas: la regla activa, la ubicación no pausada,
el **equipo no pausado** (kill switch) y el antirrebote cumplido.

> Las automatizaciones **ignoran el lock de operador a propósito**: si están
> activas, se ejecutan aunque alguien esté operando el equipo a mano. Lo único
> que las frena es una pausa explícita. El panel avisa de esto con un chip al
> lado del indicador de lock.

## Tests

```bash
npm test        # node --test, sin dependencias de testing
```

`fixtures/switchTokens.fixture.json` tiene una copia idéntica en el panel
(`src/shared/fixtures/`). Los dos repos corren sus tests contra ese archivo: es
lo que evita que la tabla de tokens booleanos, duplicada a propósito, derive en
silencio y haga que un comando que funcionó se registre como no confirmado.

## Requisitos

- Node 18+
- mosquitto accesible en `MQTT_BROKER`
- `serviceAccountKey.json` de Firebase Admin en la raíz (NO se versiona)

## Configuración

1. Copiar el ejemplo de entorno y completar:

   ```bash
   cp .env.example .env
   # editar .env con las credenciales MQTT reales
   ```

2. Colocar `serviceAccountKey.json` en la raíz del proyecto (gitignored).

3. Instalar dependencias:

   ```bash
   npm install
   ```

## Correr

```bash
# desarrollo
node index.js

# producción (pm2)
pm2 start ecosystem.config.js
pm2 logs alert-engine
```

## Deploy en la VM (git pull + pm2 reload)

```bash
cd /ruta/al/alert-engine
git pull
npm install          # solo si cambió package.json
pm2 reload alert-engine
```

> El `.env` y el `serviceAccountKey.json` viven solo en la VM y nunca se
> commitean. Si cambian variables de entorno, editá `.env` en la VM y hacé
> `pm2 reload alert-engine`.

## Notas

- Las **reglas** de alerta y las **automatizaciones** se configuran desde el
  panel (modal de Alertas y automatizaciones) y se guardan en
  `layout.widgets[].alertRules` y `layout.automations[]` de cada location; el
  engine las lee de forma reactiva, sin reiniciar.
- Las queries del front sobre `alerts` / `alarm_events` / `automation_events`
  requieren índices compuestos en Firestore. Están declarados en
  `firestore.indexes.json` del repo del panel.
- `automationState` lo escribe **solo** este servicio (Admin SDK, saltea las
  reglas). No está en `layout.automations` a propósito: ese documento lo
  reescribe el panel entero en cada edición, y guardar ahí el último disparo
  sería una carrera contra el editor además de despertar el `onSnapshot` del
  dashboard de todos los conectados cada vez que arranca una bomba.
- **Sin dependencias nuevas.** El cron acotado y la zona horaria se resuelven
  con `Intl.DateTimeFormat`, que ya viene en Node, así que el servicio sigue con
  las mismas tres de siempre (`dotenv`, `firebase-admin`, `mqtt`).
