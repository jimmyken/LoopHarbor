# LoopHarbor

**Ein asynchroner Agent-Arbeitsbereich für Gespräche über mehrere Runden** mit Celery, Redis, LangGraph und PostgreSQL.

[中文](README.md) | [English](README.en.md) | [日本語](README.ja.md) | Deutsch

LoopHarbor ist ein ausführbares Agent-Grundgerüst:

- FastAPI nimmt Anfragen an und gibt sofort eine `task_id` zurück.
- Redis stellt den Celery-Broker und das Ergebnis-Backend bereit.
- Celery-Worker führen Aufgaben im Hintergrund aus.
- LangGraph orchestriert die Agent-Knoten.
- PostgreSQL speichert Aufgabenstatus und LangGraph-Checkpoints.
- Clients fragen Status und Ergebnisse über die `task_id` ab.

Der Agent nutzt eine OpenAI-kompatible Chat-Completions-API mit Tool-Aufrufen für Gespräche und Vertragsprüfungen über mehrere Runden. Das Modell kann Tools für Grundrechenarten sowie Datum und Uhrzeit des Workers aufrufen und anschließend seine Antwort fortsetzen. Vertragsprüfungen dienen nur zur Orientierung und sind keine Rechtsberatung.

Die Weboberfläche, System-Prompts, Fehlermeldungen und Gedächtniszusammenfassungen sind derzeit auf Chinesisch; nur die Dokumentation ist übersetzt.

## 1. Voraussetzungen

- Python 3.12 (Installation der Abhängigkeiten geprüft; das festgelegte psycopg-Binärpaket unterstützt Python 3.14 nicht)
- Docker Desktop oder Docker Engine
- Docker Compose

## 2. Infrastruktur starten

```bash
if [ ! -e .env ]; then cp .env.example .env; fi
docker compose up -d
```

Eine vorhandene `.env` nicht überschreiben; fehlende Modelleinstellungen aus `.env.example` von Hand ergänzen. Container prüfen:

```bash
docker compose ps
```

## 3. Python-Abhängigkeiten installieren

Python 3.12 wird empfohlen. Die folgenden Befehle erstellen eine separate virtuelle Umgebung und überschreiben keine vorhandene `.venv`:

```bash
python3.12 -m venv .venv-py312
source .venv-py312/bin/activate
python -m pip install -r requirements.txt
```

In `.env` die API-Adresse, den Schlüssel und den Modellnamen des Anbieters eintragen:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-api-key
LLM_MODEL=your-model-name
MEMORY_SUMMARIZE_EVERY_TURNS=5
```

`LLM_BASE_URL` ist die API-Basisadresse ohne `/chat/completions`. Der Anbieter muss `tools` und `tool_calls` im OpenAI-Format unterstützen. Nach Konfigurationsänderungen den Worker neu starten. Ist das Modell nicht konfiguriert, schlägt eine Anfrage fehl oder ist die Antwort ungültig, erhält die Aufgabe den Status `FAILURE`; es gibt keinen Fallback auf lokale Regeln. Jede Modellanfrage hat ein Timeout von 60 Sekunden. Pro Runde sind höchstens acht Modellaufrufe und pro Modellaufruf höchstens fünf Tool-Aufrufe erlaubt. Die Vertragsprüfung benötigt ein JSON-Objekt mit `risks` als String-Array und `report` als String.

`MEMORY_SUMMARIZE_EVERY_TURNS` ist eine positive Ganzzahl, standardmäßig 5. Nach dieser Anzahl erfolgreicher Runden führt das Modell die alte Zusammenfassung und diese Runden zu einer neuen Zusammenfassung zusammen und entfernt die ursprünglichen Runden aus dem aktiven Kontext. Die nächste Runde nutzt die neue Zusammenfassung. Schlägt die Zusammenfassung fehl, schlägt die aktuelle Aufgabe fehl und das zuvor gespeicherte Gedächtnis bleibt erhalten.

Eingaben werden an den konfigurierten Modellanbieter gesendet. Vor der Übermittlung dessen Datenschutz- und Datennutzungsbedingungen prüfen und niemals echte Schlüssel committen.

Windows PowerShell:

```powershell
py -3.12 -m venv .venv-py312
.venv-py312\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

## 4. API starten

Im Projektverzeichnis ausführen:

```bash
uvicorn app.main:api --host 127.0.0.1 --port 8000
```

- Web-Arbeitsbereich: http://127.0.0.1:8000/
- Swagger: http://127.0.0.1:8000/docs
- Health-Check: http://127.0.0.1:8000/health

**Nur für die lokale Nutzung:** API und Oberfläche haben keine Authentifizierung. Jeder Client mit Zugriff auf den Dienst kann alle Sitzungen und Inhalte einsehen. Nicht an `0.0.0.0` binden und den Dienst nicht im Netzwerk freigeben; andere lokale Prozesse können dennoch darauf zugreifen.

## 5. Celery-Worker starten

Ein weiteres Terminal öffnen und dieselbe virtuelle Umgebung aktivieren. Für macOS wird der Einzelprozessmodus empfohlen:

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --pool=solo
```

`solo` führt jeweils nur eine Aufgabe aus und unterstützt keine von prefork abhängigen Soft- und Hard-Timeouts. Unter Linux kann der Mehrprozessmodus verwendet werden:

```bash
celery -A app.celery_app:celery_app worker --loglevel=INFO --concurrency=2
```

Meldet ein macOS-prefork-Worker in `fast_trace_task` den Fehler `not enough values to unpack`, den Worker stoppen und mit dem obigen `solo`-Befehl starten. Der Fehler kann vor Beginn der eigentlichen Aufgabe auftreten; dann bleibt deren Geschäftsstatus möglicherweise `QUEUED`, während Celery `FAILURE` meldet. Erst nach Bestätigung, dass die Aufgabe nicht ausgeführt wurde, erneut einreichen und mit der neuen `task_id` abfragen.

### Web-Arbeitsbereich verwenden

API und Worker starten und http://127.0.0.1:8000/ öffnen. **新建会话** (neue Sitzung) wählen, dann **通用问答** (allgemeine Fragen) oder **合同审查** (Vertragsprüfung) auswählen und eine Nachricht senden. Weitere Fragen lassen sich in derselben Sitzung stellen. Links können frühere Sitzungen wiederhergestellt werden; rechts erscheinen Aufgabenstatus, Gedächtniszusammenfassungen sowie Ein- und Ausgaben der Tools. Auf schmalen Bildschirmen öffnet **执行详情** die Ausführungsdetails. Aufgaben derselben Sitzung werden in Reihenfolge eingereiht.

Zum Beispiel zuerst darum bitten, eine Vorliebe für kurze Antworten zu merken, und dann nach dem bevorzugten Antwortstil fragen. Im Vertragsmodus erst eine Klausel senden und anschließend nach Risiken fragen. Nach dem Neuladen wird die zuletzt gewählte Sitzung wiederhergestellt. Sitzungen, Aufgaben, Tool-Ereignisse und Checkpoints werden in PostgreSQL gespeichert; Modelleingaben und Tool-Ausgaben können vertrauliche Daten enthalten. Bei erneuter Celery-Zustellung können Tool-Ereignisse doppelt auftreten.

Der Gesprächsbereich unterstützt Markdown-Überschriften, Listen, Zitate, Tabellen und Codeblöcke sowie Formeln mit `$...$`, `$$...$$`, `\(...\)` und `\[...\]`. Beim Kopieren einer Nachricht wird der Originaltext kopiert; Codeblöcke haben eine eigene Kopierschaltfläche. **查找与定位** (suchen und navigieren) durchsucht Nachrichten und ermöglicht die Navigation nach Runde oder Überschrift. Nachrichten und Tool-Aufrufe lassen sich auf- und zuklappen; zugeklappte Nachrichten zeigen eine Vorschau der ersten Zeile. Auch das Sitzungsgedächtnis lässt sich auf- und zuklappen. Wird die Sitzungsleiste verborgen, verschwindet auch die Titelleiste; über Schaltflächen links neben dem Eingabefeld lassen sich die Sitzungsliste und die Detailleiste öffnen oder schließen. Auf schmalen Bildschirmen öffnen sich die Seitenleisten als Schubladen.

Symbole links unter jeder Nachricht kopieren den Originaltext oder klappen den Inhalt ein und aus. Tool-Einträge zeigen gespeicherte Ereignisse, nicht die interne Schlussfolgerung des Modells. Rohes HTML wird nicht ausgeführt, Bilder werden nicht automatisch geladen und externe Links nur beim Anklicken geöffnet.

Das Eingabefeld beginnt einzeilig und wächst bei Bedarf. Enter sendet, Shift + Enter fügt einen Zeilenumbruch ein.

Die Rendering-Dateien sind lokal enthalten; für den Betrieb sind weder Node.js noch ein externes CDN erforderlich. Nach Änderungen an den Frontend-Rendering-Abhängigkeiten oder an [`frontend/markdown.js`](frontend/markdown.js) lassen sie sich mit `npm ci && npm run build:frontend` neu erstellen.

Nach Änderungen am Projektcode oder an `.env` API und Worker neu starten. Wartende Aufgaben benötigen einen laufenden Worker.

## 6. Agent-Anfragen über mehrere Runden

API und Worker starten. Jede Anfrage benötigt `mode`. Bei der ersten Anfrage `thread_id` weglassen, damit eine neue Sitzung erstellt wird:

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "chat",
    "message": "Bitte merke dir, dass ich kurze Antworten bevorzuge."
  }')
echo "$FIRST"
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

Für die nächste Runde die zurückgegebene `thread_id` verwenden. Die Anfrage kann sofort gesendet werden, ohne auf den Abschluss der ersten Runde zu warten. Aufgaben derselben Sitzung werden in der Reihenfolge ihrer Datenbankregistrierung ausgeführt; verschiedene Sitzungen können parallel laufen:

```bash
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"chat\",\"thread_id\":\"$THREAD_ID\",\"message\":\"Welchen Antwortstil bevorzuge ich?\"}")
echo "$SECOND"
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
```

Status jeder Runde abfragen und bei Bedarf bis zu `SUCCESS` oder `FAILURE` wiederholen:

```bash
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

Nach einer fehlgeschlagenen Runde werden spätere Runden weiter ausgeführt; die fehlgeschlagene Runde wird jedoch nicht ins Gedächtnis aufgenommen. Aufgabenregistrierung und Zustellung an die Queue sind nicht atomar. Stürzt der Prozess dazwischen ab, kann eine `QUEUED`-Aufgabe hängen bleiben und spätere Runden derselben Sitzung blockieren; dies erfordert eine manuelle Untersuchung.

Bei Erfolg steht die Antwort unter `result_json.answer`. Dieselbe `thread_id` kann für weitere Runden genutzt werden; jede Runde hat eine eigene `task_id`. Ohne `thread_id` wird bei der ersten Anfrage eine neue Sitzung erstellt. Der Sitzungsmodus ist fest: Eine unbekannte `thread_id` ergibt 404, ein Moduswechsel 409.

Auch die Vertragsprüfung unterstützt mehrere Runden. Dafür von Anfang an `contract` verwenden:

```bash
FIRST=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d '{"mode":"contract","message":"Der Käufer zahlt innerhalb von 30 Tagen nach Abnahme."}')
THREAD_ID=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["thread_id"])')
TASK1=$(printf '%s' "$FIRST" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
SECOND=$(curl -fsS -X POST http://localhost:8000/tasks \
  -H "Content-Type: application/json" \
  -d "{\"mode\":\"contract\",\"thread_id\":\"$THREAD_ID\",\"message\":\"Welche Risiken bestehen bei den Zahlungsbedingungen?\"}")
TASK2=$(printf '%s' "$SECOND" | python -c 'import json,sys; print(json.load(sys.stdin)["task_id"])')
curl -fsS "http://localhost:8000/tasks/$TASK1"
curl -fsS "http://localhost:8000/tasks/$TASK2"
```

Die Ergebnisse der Vertragsprüfung stehen unter `result_json.report` und `result_json.risks`. Bei Fragen enthält das Kompatibilitätsfeld `result_json.report` dieselbe Antwort, `result_json.risks` ist ein leeres Array. Das alte Eingabefeld `contract_text` kann weiterhin `message` ersetzen, aber `mode` ist erforderlich.

Celery-Status separat abfragen:

```bash
curl -fsS "http://localhost:8000/tasks/$TASK2/celery"
```

## 7. Architektur

| Komponente | Aufgabe |
|---|---|
| FastAPI | Geschäftsaufgaben einreichen und abfragen |
| Redis-Broker | Nachrichten wartender Aufgaben zustellen |
| Celery-Worker | Aufgaben im Hintergrund ausführen |
| Celery-Ergebnis-Backend | Celery-Status und Rückgabewerte speichern |
| LangGraph | Agent-Knoten orchestrieren |
| PostgreSQL-Geschäftstabellen | Sitzungen, Einreichungsreihenfolge, Aufgabenstatus und Ergebnisse speichern |
| PostgreSQL-Checkpointer | LangGraph-Checkpoints und aktives Sitzungsgedächtnis speichern |

`task_id`, `thread_id` und `checkpoint_id` sind verschiedene Begriffe:

- `task_id`: eine Celery-Hintergrundaufgabe.
- `thread_id`: LangGraph-Workflowzustand.
- `checkpoint_id`: ein bestimmter Checkpoint.

Die Zusammenfassung ersetzt den aktiven Kontext für das Modell; sie löscht weder alte Checkpoints noch ursprüngliche Aufgabeneingaben oder Ergebnisse physisch. Eine Sitzungs-ID ist keine Authentifizierung. Für den Produktivbetrieb sind Authentifizierung, Mandantentrennung und eine Datenaufbewahrungsrichtlinie erforderlich.

## 8. Anpassungen für den Produktivbetrieb

Dies ist ein minimales, ausführbares Grundgerüst und sollte ohne weitere Anpassungen keine vertraulichen Produktionsdaten verarbeiten. Mindestens erforderlich sind:

1. **Zuverlässige Zustellung:** Registrierung und Celery-Zustellung sind getrennt. Ein transaktionales Outbox-Muster ist zu erwägen.
2. **Idempotenz:** Celery kann Aufgaben erneut zustellen. Für Tools mit Seiteneffekten geschäftliche Idempotenzschlüssel und Ergebnisabgleich verwenden.
3. **Aufgabenstatus:** Wiederholungszähler, Abbruch, Leases/Heartbeats, Fehlerklassen und manuelle Wiederherstellung ergänzen.
4. **Fortschritt:** Fortschritt an LangGraph-Knotengrenzen aktualisieren oder Knotenereignisse in einem Ereignisstrom speichern.
5. **Große Dateien:** Große PDFs oder Binärdateien in einem Objektspeicher ablegen und nur eine URI über die Queue senden.
6. **Sicherheit:** Authentifizierung, Mandantentrennung, Eingabevalidierung, Maskierung, TLS, Geheimnisverwaltung und Audit-Logs ergänzen.
7. **Überwachung:** Queue-Länge, Worker-Verfügbarkeit, Laufzeit, Fehlerrate und Checkpoint-Speicher überwachen.
8. **Timeouts:** Externe API-Timeouts, Celery-Soft-/Hard-Limits und Redis-Visibility-Timeout konfigurieren; Sichtbarkeit und erneute Zustellung langer Aufgaben prüfen.
9. **Datenbankverbindungen:** Verbindungspool verwenden und Verbindungsgrenzen, Backups und Migrationen konfigurieren.

## 9. Wiederherstellungssemantik

Ein Checkpoint speichert den persistierten LangGraph-Workflowzustand, nicht den Ausführungsstack einer Python-Funktion. Stürzt ein Knoten vor dem nächsten Checkpoint ab, kann er bei der Wiederherstellung erneut ausgeführt werden. Externe Seiteneffekte müssen idempotent sein.

Die Graphknoten dieses Demos werden synchron ausgeführt; der Celery-Worker führt den gesamten Graphen im Hintergrund aus. Für eine feinere Wiederherstellung sind geeignet aufgeteilte LangGraph-Knoten mit wiederherstellbaren Ausgaben und idempotenten externen Operationen nötig.
