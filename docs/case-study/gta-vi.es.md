# INVESTIGACIÓN: por qué se mutea el VOD y cómo conseguir el directo completo

> **Nota:** este documento es el caso de estudio que originó el proyecto (IlloJuan / GTA VI).
> El software es genérico y funciona con cualquier canal de Twitch/YouTube; la configuración
> de canal, marca y ruta está documentada en [`README.es.md`](../../README.es.md).
>
> English version: [gta-vi.md](gta-vi.md).

**Fecha:** 19 de noviembre de 2026
**Caso:** IlloJuan — *Grand Theft Auto VI* (stream del 18–19 de noviembre de 2026)
**Canales:** `twitch.tv/illojuan` · YouTube `UCKvoBRFqMNqvuSvFBiNadgw` (IlloJuan / LMDShow)

---

## 1. Resumen ejecutivo

La conclusión de la investigación es contundente:

> **El silenciado por copyright ocurre en el VOD almacenado, no en la señal en vivo.**
> Si grabas el directo mientras se emite, conservas el audio completo. Si esperas al VOD,
> llega ya mutilado (Twitch) o puede estar borrado/bloqueado (YouTube).

Por eso el sistema **no descarga el VOD**: graba **las dos señales en vivo a la vez** (Twitch y YouTube), las guarda en trozos resilientes, las une y después **audita su propia copia contra la lista oficial de tramos muteados de Twitch**. Esa auditoría es la prueba de que el objetivo se cumple.

Evidencia real obtenida durante la investigación:

| Dato | Valor |
|---|---|
| VOD de Twitch analizado | `2932866051` — “Yo estuve aquí ❤️ - Grand Theft Auto VI #1” |
| Inicio del directo | 2026-11-18 23:15:54 UTC (00:15 hora peninsular) |
| Duración | 18 760 s = **5 h 12 min 40 s** |
| Tramos muteados por Twitch | **12 tramos × 180 s = 2 160 s = 36 min** |
| Porcentaje silenciado | **11,51 %** del VOD |
| Patrón | Todos los tramos son bloques exactos de **3 minutos** |
| VOD anterior (`2932595314`, “Eliminar”) | 15 180 s y **0 tramos muteados** (el sistema detecta solo cuando hay música reconocida) |
| VOD de YouTube del mismo día | `zdFy-O_wUTU`, `was_live`, 14 940 s (4 h 09 min), público durante la investigación |

Los 12 offsets reales devueltos por Twitch (segundos desde el inicio del VOD):

```
 5220 (1:27:00)   8100 (2:15:00)   10620 (2:57:00)   14400 (4:00:00)
14760 (4:06:00)  15480 (4:18:00)   15660 (4:21:00)   16920 (4:42:00)
17100 (4:45:00)  17820 (4:57:00)   18180 (5:03:00)   18360 (5:06:00)
```

La consulta que devuelve esto es la misma que usa el reproductor web de Twitch (GraphQL público, sin OAuth). Está implementada en `src/twitch.js` (`getVodMutes`). Es la base de la auditoría automática.

---

## 2. Twitch: cuándo y cómo se silencia

### 2.1. Qué se escanea

Twitch usa un sistema de reconocimiento de audio de terceros que **escanea VODs y clips**, no la emisión en directo. La ayuda oficial lo dice así:

> “Twitch services scan VODs as a proactive way to help broadcasters avoid having videos containing unauthorized audio. If copyrighted audio is detected in a VOD, we automatically mute that portion of the VOD.”
> — [Twitch Help: How to Appeal Muted Audio](https://help.twitch.tv/s/article/how-to-appeal-flagged-content)

Y en las preguntas frecuentes de la misma página:

> “**Will my live content be flagged or muted?** No, this appeals process is strictly for VOD content.”

La guía de música de Twitch añade:

> “We may mute VODs and delete Clips where our audio recognition system detects copyrighted audio in them.”
> — [Twitch Music Guidelines](https://legal.twitch.com/en/legal/music)

### 2.2. Cuándo se aplica

El VOD se crea al terminar el directo y Twitch lo procesa después. El escaneo de audio se ejecuta sobre ese archivo ya cerrado, no sobre los paquetes que reciben los espectadores en vivo. En la práctica:

- Mientras estás en directo: **no hay mute**. Miles de personas están oyendo la música en ese momento.
- Al terminar: el VOD aparece en el canal y, en cuestión de minutos, Twitch va marcando los tramos detectados. La interfaz los muestra con líneas rojas y un icono de altavoz muteado.
- Un VOD puede tardar más o menos en mostrar todos los mutes; el sistema no publica un SLA. Por eso el archivero **vigila el VOD durante 24 h** y registra el instante exacto en que aparece el primer mute (`secondsAfterStreamEnd`).

No he encontrado documentación oficial que prometa un tiempo concreto (“X minutos después del directo”). Lo que sí es oficial y reproducible es que **el directo no se mutea** y que **el VOD sí**. El sistema medirá el tiempo real en los próximos directos y lo dejará en el panel y en `metadata.json`.

### 2.3. Granularidad observada: bloques de 3 minutos

Los 12 tramos del VOD de GTA VI duran exactamente **180 s** y empiezan en múltiplos de 180 s (salvo el primero, que también es múltiplo). Es decir, Twitch no corta “solo la canción”: silencia la **ventana de detección completa** de 3 minutos que contiene la música. Esto explica que se pierdan también trozos de voz o de juego alrededor del tema.

Consecuencia práctica: no sirve “descargar el VOD y quitar el mute”; el audio original de esos 36 minutos **no está** en el VOD. Solo existe en la señal en vivo (o en una grabación local del streamer).

### 2.4. El VOD no es una fuente fiable

Aunque el VOD no estuviera muteado, seguiría sin ser una garantía:

- El streamer puede **borrarlo** (como hace Juan con YouTube).
- El VOD puede ser **solo para suscriptores**.
- Twitch conserva el VOD un tiempo limitado: **60 días** para Partners, Prime y Turbo; **14 días** para afiliados; **7 días** para el resto. Además, el guardado de directos **no está activado por defecto**: si el streamer no lo activó antes de emitir, el VOD no existe.
- Los **clips** afectados se eliminan, no solo se mutean.
- El escaneo puede tardar; descargar “nada más terminar” es una carrera contra el procesamiento y no siempre gana.

### 2.5. La alternancia de VODs lo confirma

El VOD `2932595314` (“Eliminar”, 4 h 13 min) **no tiene ningún tramo muteado**. El siguiente (`2932866051`) tiene 12. Si el mute fuera “de la cuenta” o “del juego” en general, ambos estarían igual. Es detección **por contenido y por tramo**: solo se marcan las ventanas donde suena música reconocida. Nuestra captura en vivo no depende de ese escaneo.

---

## 3. YouTube: cuándo y cómo se reclama

### 3.1. El directo se escanea, pero el claim del archivo llega después

La ayuda oficial de YouTube distingue dos fases:

> “All live streams are scanned for matches to third-party content, including copyrighted content in the form of another live broadcast. When third-party content is identified, a placeholder image may replace your live stream… If the third-party content remains in your stream, your live stream will be temporarily interrupted or terminated.”
>
> “**Content ID claims are only made after you complete your live streams, if you decide to archive the video.**”
> — [YouTube Help: Copyright issues with live streams](https://support.google.com/youtube/answer/3367684)

Es decir:

- Durante el directo, YouTube puede avisar, poner una imagen de sustitución, interrumpir o terminar la emisión si detecta contenido de terceros (sobre todo retransmisiones de TV, eventos, etc.).
- El **claim de Content ID sobre el archivo** se aplica **cuando el directo ya ha terminado**, si el creador decide archivar el vídeo. Ese claim puede mutear, bloquear por territorios, monetizar o limitar el VOD.
- El **streaming en vivo de música de un videojuego** no suele provocar el corte en tiempo real que sí provoca retransmitir una película o un partido; en el caso de IlloJuan el directo no se cortó y el problema apareció en el archivo, que es el motivo por el que lo borra.

### 3.2. Por qué Juan borra el VOD de YouTube

Un claim de Content ID **no es** un strike, pero un strike sí puede llegar si el titular presenta una reclamación de eliminación. La política de YouTube permite que el titular bloquee el vídeo o lo mutee; el creador puede disputar, mutear el tramo o borrar el vídeo. Para un canal grande, la estrategia conservadora es **borrar el VOD** y no arriesgar el canal. Es exactamente lo que describe el usuario.

Consecuencia: **no puedes depender de que el VOD de YouTube siga existiendo**. A las pocas horas (o minutos) puede estar privado, bloqueado o eliminado. La señal en vivo, en cambio, ya se emitió con el audio completo.

### 3.3. Evidencia observada

El 19-11-2026, el vídeo `zdFy-O_wUTU` (“El día que borré el GTA VI por error 👍🏻”) estaba público y `yt-dlp` lo identificaba como:

```json
{
  "id": "zdFy-O_wUTU",
  "title": "El día que borré el GTA VI por error 👍🏻",
  "duration": 14940,
  "was_live": true,
  "live_status": "was_live",
  "channel": "IlloJuan",
  "channel_id": "UCKvoBRFqMNqvuSvFBiNadgw",
  "availability": "public"
}
```

Ese mismo día, el VOD de Twitch de la franja equivalente seguía disponible pero con 36 minutos muteados. Es la combinación perfecta para demostrar el problema: **una plataforma silencia, la otra borra**.

---

## 4. El caso GTA VI: por qué la música del juego dispara todo

GTA VI emite radio musical con licencia dentro del juego. Esa música está registrada por las discográficas y los sistemas de reconocimiento de ambas plataformas la identifican igual que si el streamer pusiera un Spotify en directo:

- En Twitch: el escaneo del VOD marca ventanas de 3 minutos y las mutea.
- En YouTube: el escaneo posterior del archivo genera claims de Content ID; el creador borra el VOD para no arriesgar strikes.
- El “modo streamer” o desactivar la radio del juego lo evitaría, pero **no está activado** en este directo (o no cubre toda la música). No podemos controlar la configuración del streamer.

Por tanto, la única fuente con el audio íntegro es **la señal que se emitió en vivo**.

---

## 5. Evaluación de todas las alternativas

| Estrategia | ¿Audio completo? | ¿Fiable a largo plazo? | Problemas |
|---|---|---|---|
| Descargar el VOD de Twitch después | **No** | No | 36 min muteados en el caso real; el VOD puede borrarse; carrera contra el escaneo |
| Descargar el VOD de YouTube después | A veces | **No** | Juan lo borra; claims/bloqueos por región; puede estar privado |
| Grabar el directo de Twitch en vivo | **Sí** | Sí | Los anuncios insertados dejan huecos si se filtran; se resuelve con YouTube en paralelo |
| Grabar el directo de YouTube en vivo | **Sí** | Sí | Puede haber interrupciones por live matching (raro con música de juego); sin anuncios |
| Grabar **ambos** en paralelo | **Sí** | **Sí** | Consumo de disco/ancho de banda; es la opción implementada |
| Capturar la pantalla del PC del streamer | Sí | No | No tenemos acceso a su equipo; no es desplegable |
| Pedirle el archivo local | Sí | No | Depende de él; no es un sistema automático |
| Clips/highlights de Twitch | No | No | Fragmentos; los clips con música se borran |
| Esperar a que Twitch/YouTube “desmuteen” | No | No | Twitch no desmutea automáticamente; el appeal es del streamer |

**Decisión:** captura dual en vivo, con Twitch como fuente principal de calidad y YouTube como copia completa sin anuncios. El sistema elige/etiqueta la copia con mejor cobertura y audita la de Twitch contra sus propios mutes.

---

## 6. Diseño del sistema implementado

```
                         ┌─────────────────────────────┐
                         │  Monitor Twitch (5 s)       │
                         │  GQL público: stream + VOD  │
                         └──────────────┬──────────────┘
                                        │ live detectado
                                        ▼
┌──────────────────┐          ┌──────────────────┐          ┌──────────────────┐
│ Monitor YouTube  │  live    │   Orquestador    │  spawn   │ streamlink       │
│ /live + RSS 30s  │─────────▶│  sesiones +      │─────────▶│ → TS por trozos  │
└──────────────────┘          │  watchdog        │          └────────┬─────────┘
                              │                  │                   │
                              │                  │          ┌────────▼─────────┐
                              │                  │─────────▶│ yt-dlp           │
                              │                  │          │ --live-from-start│
                              └────────┬─────────┘          └────────┬─────────┘
                                       │                             │
                                       ▼                             ▼
                              ┌──────────────────┐          ┌──────────────────┐
                              │ ffmpeg concat    │◀─────────│ trozos locales   │
                              │ + probe + audit  │          │ (disco rápido)   │
                              └────────┬─────────┘          └──────────────────┘
                                       │
                                       ▼
                              ┌──────────────────┐
                              │ NAS GTAVI/*.mkv  │
                              │ + metadata.json  │
                              └──────────────────┘
```

### 6.1. Detección

- **Twitch:** GraphQL público cada 5 s (`user.stream`). Detecta `type: live` y obtiene `stream.id`, título, juego, viewers y `createdAt` (inicio real).
- **YouTube:** `https://www.youtube.com/channel/<id>/live` cada 30 s. Se parsea `ytInitialPlayerResponse.videoDetails` y se exige que `channelId` coincida con el canal configurado (evita falsos positivos por vídeos recomendados). Fallback por RSS + `yt-dlp` para A/B tests.
- Al detectar live se crea una sesión y se lanza la captura **inmediatamente**.

### 6.2. Captura

- **Twitch:** `streamlink` sobre el HLS en vivo, calidad `best` (1080p60), `--twitch-disable-ads`, escritura directa a `.ts`. El TS es resistente a cortes: si el proceso muere, el trozo sigue siendo reproducible.
- **YouTube:** `yt-dlp --live-from-start` (recupera desde el principio del DVR aunque el monitor llegue tarde), hasta 1080p, MKV. Si el proceso muere, se recuperan los flujos separados de vídeo/audio y se muxean.
- **Watchdog:** cada 10 s comprueba que el archivo crece. Si no crece en 4 min (más que un corte publicitario), mata y reinicia. Backoff exponencial. Reinicio ilimitado; notificación a los 3 reinicios.
- **Trozos:** cada intento es un archivo nuevo (`part-0001.ts`, `part-0002...`). Nunca se sobrescribe lo ya grabado.
- **Crash del contenedor:** al arrancar, `recover()` reconcilia los archivos del disco, reanuda si el directo sigue y finaliza si ya terminó.

### 6.3. Finalización

1. Se normalizan los trozos (mux de vídeo/audio en YouTube; TS directo en Twitch).
2. `ffmpeg -f concat -c copy` → MKV local.
3. `ffprobe`: duración, códecs, presencia de audio.
4. `silencedetect`: lista de silencios largos (posibles fallos de captura).
5. SHA-256 opcional.
6. Copia verificada al NAS (`/media/videos/GTAVI/...mkv`). Si el NAS falla, el archivo se queda en local y se reintenta; **nunca se borra antes de copiar**.
7. `metadata.json` con todo (trozos, cobertura, mutes, auditoría).

### 6.4. Auditoría (la prueba del objetivo)

Cuando Twitch termina de escanear el VOD:

1. Se localiza el VOD por `createdAt`.
2. Se consultan sus `mutedSegments` por GraphQL.
3. Para cada tramo muteado, se muestrea **nuestra grabación** en el punto medio (30 s) y se mide `volumedetect`.
4. `PASS` si hay audio (> −55 dB), `FAIL` si es silencio digital (−91 dB).
5. Se guarda un informe con offsets, duración, dB y veredicto.

El panel muestra, por ejemplo:

> **Audio íntegro donde Twitch silenció** — 12/12 tramos con audio · 36 min muteados por Twitch · control −18,4 dB

Eso es exactamente lo que se pide: no “creo que se grabó”, sino **verificación contra la lista oficial de Twitch**.

### 6.5. Por qué grabar las dos plataformas

- Twitch: mejor calidad y sin recodificación; pero los anuncios insertados pueden dejar huecos al filtrarlos.
- YouTube: sin anuncios y `--live-from-start` puede recuperar el principio; pero puede sufrir interrupciones por live matching.
- Si una falla, la otra cubre. El panel etiqueta la cobertura de cada archivo y conserva ambas.

---

## 7. Evidencia reproducible

### 7.1. Tramos muteados del VOD real

```bash
docker compose run --rm stream-vod-guard node src/cli.js mutes 2932866051
```

Salida (resumida):

```json
{
  "id": "2932866051",
  "title": "Yo estuve aquí ❤️ - Grand Theft Auto VI #1",
  "createdAt": "2026-11-18T23:15:54Z",
  "lengthSeconds": 18760,
  "mutedSegments": [
    { "offset": 5220, "duration": 180 },
    { "offset": 8100, "duration": 180 },
    ...
  ],
  "summary": { "count": 12, "totalSeconds": 2160, "total": "36m 00s", "percent": 11.51 }
}
```

### 7.2. Los mutes son silencio digital

```bash
docker compose run --rm stream-vod-guard node src/cli.js audit-vod 2932866051 --samples
```

Descarga el audio y mide 30 s del primer tramo muteado contra 30 s de control. Resultado real en esta máquina ([`twitch-vod-audit.txt`](./twitch-vod-audit.txt)):

```
| Tramo muteado #1 | 01:28:00 | -91 dB | -91 dB | SILENCIO digital |
...
| Control (sin mute) | 01:22:00 | -31.1 dB | -10.8 dB | audio normal |
```

El análisis directo del audio del VOD con `silencedetect` confirma los 12 tramos ([`twitch-silencedetect.txt`](./twitch-silencedetect.txt)):

```
silence_start: 5220.05
silence_end: 5400.04 | silence_duration: 179.999
...
```

Es decir: **el audio original de esos 36 minutos no existe en el VOD**. No es un problema de reproducción ni de volumen; Twitch lo eliminó.

### 7.3. Prueba de captura + crash + reinicio + audio

```bash
docker compose run --rm stream-vod-guard bash scripts/demo-capture.sh
```

El test:

1. Genera un directo HLS sintético con vídeo y tono de 440 Hz.
2. Lo graba con `streamlink` (mismo camino que Twitch).
3. Mata el proceso con `SIGKILL` a mitad.
4. Comprueba que el watchdog crea un segundo trozo y sigue grabando.
5. Finaliza con `ffmpeg`, verifica que el MKV tiene vídeo y audio, y que la duración es > 15 s.

Salida esperada: `E2E OK · parts=2 restarts=1 duration=... size=...`.

---

## 8. Conclusiones

1. **Twitch no mutea el directo; mutea el VOD después.** Es un hecho documentado y reproducible.
2. **YouTube no aplica el claim de Content ID al archivo hasta que el directo termina**; el directo se emite completo y el VOD puede desaparecer.
3. **Descargar VODs no garantiza nada.** En el caso real, el VOD de Twitch ya tenía 36 minutos silenciados y el de YouTube es vulnerable a borrado/bloqueo.
4. **La captura en vivo es la única fuente que conserva el audio original.** Hacerlo en las dos plataformas añade redundancia.
5. **La auditoría contra la API de mutes de Twitch convierte la promesa en evidencia verificable.** El sistema no solo graba: demuestra que tiene audio en los tramos que Twitch silenció.

---

## 9. Nota de uso

Este sistema está pensado para **uso personal y timeshift**: ver después un directo que se emitió en abierto, sin redistribuirlo. La música sigue teniendo derechos de sus titulares; grabar el directo no te da licencia para publicarlo, remezclarlo ni subirlo a otra plataforma. Respeta la voluntad del streamer y las condiciones de Twitch/YouTube. Si el creador pide que no se archive, no lo hagas.

---

## 10. Fuentes

- Twitch Help — *How to Appeal Muted Audio*: <https://help.twitch.tv/s/article/how-to-appeal-flagged-content>
- Twitch Help — *DMCA & Copyright FAQs*: <https://help.twitch.tv/s/article/dmca-and-copyright-faqs>
- Twitch Help — *Copyrighted Audio Detection & Warnings*: <https://help.twitch.tv/s/article/copyrighted-audio-warnings>
- Twitch Legal — *Music Guidelines*: <https://legal.twitch.com/en/legal/music>
- Twitch Help — *On-Demand Content on Twitch* (retención de VODs): <https://help.twitch.tv/s/article/video-on-demand>
- YouTube Help — *Copyright issues with live streams*: <https://support.google.com/youtube/answer/3367684>
- YouTube Help — *Content ID claims*: <https://support.google.com/youtube/answer/6013276>
- YouTube Help — *Use Content ID matching on live streams*: <https://support.google.com/youtube/answer/9896248>
- Twitch GraphQL público (operación `VideoPlayer_VODSeekbar`), consultado el 2026-11-19.
