# alert-engine

Motor de alarmas SCADA del panel IoT (Fortunato). Corre como servicio Node bajo
pm2 en una VM de Google, conectado al broker MQTT local (mosquitto) y a Firestore.

Implementa el modelo de estados **ISA-18.2**: `UNACK → ACK → RTN_UNACK → Normal`,
con journal de eventos inmutable.

## Arquitectura

```
ESP / dispositivos → MQTT (mosquitto localhost:1883)
                          ↓
                     alert-engine (este servicio)
                          ↓ escribe
   Firestore  tenants/{t}/alerts        (estado vivo)
              tenants/{t}/alarm_events   (journal inmutable)
              email_trigger_queue        (extensión Trigger Email)
```

| Módulo | Rol |
|---|---|
| `index.js` | Bootstrap: Firebase Admin + MQTT, suscripción a topics, loop de mensajes |
| `alertState.js` | Espejo en memoria + transiciones de estado + journal |
| `evaluator.js` | Comparadores numéricos de las condiciones |
| `rulesCache.js` | Cache reactivo de reglas (índice por topic) |
| `offlineWatcher.js` | Detección de equipos sin datos (registro reactivo) |
| `emailNotifier.js` | Envío de email (cooldown persistido + chequeo de shelve) |

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

- Las **reglas** de alerta se configuran desde el panel (esquema unifilar) y se
  guardan en `layout.widgets[].alertRules` de cada location; el engine las lee
  de forma reactiva.
- Las queries del front sobre `alerts` / `alarm_events` requieren índices
  compuestos en Firestore (Firestore sugiere el link de creación en consola la
  primera vez que corren).
