function processCalendarEmails() {
    const SEARCH_QUERY = 'subject:AppDate is:unread';
    const SECRET_TOKEN = 'AppDate123';
    console.log("Suche nach: " + SEARCH_QUERY);

    const threads = GmailApp.search(SEARCH_QUERY);
    threads.forEach(thread => {
        const messages = thread.getMessages();
        messages.forEach(message => {
            if (message.isUnread()) {
                console.log("------------------------------------------");
                console.log("Verarbeite: " + message.getSubject());

                // Body bereinigen
                let body = message.getPlainBody() || message.getBody();
                body = body.replace(/[\r\n\t]/g, " ");

                // 1. Sicherheits-Check
                if (body.indexOf(SECRET_TOKEN) === -1) {
                    console.log("⚠️ Kein Secret Token gefunden. Überspringe.");
                    return;
                }

                // 2. Daten extrahieren
                const extract = (key) => {
                    // Regex für "key": "Value" Muster
                    const regex = new RegExp(`"${key}"\\s*:\\s*"(.*?)"`);
                    const match = body.match(regex);
                    return match ? match[1] : "";
                };

                const data = {
                    title: extract("title"),
                    start: extract("start"),
                    end: extract("end"),
                    location: extract("location"),
                    description: extract("description")
                };

                console.log("Gelesene Daten:", data);

                // Titel Fallback
                if (!data.title) {
                    data.title = message.getSubject().replace("AppDate", "").trim() || "Unbenannter Termin";
                }

                // --- HIER IST DIE WICHTIGSTE ÄNDERUNG ---
                // Wir senden es an "exchange_events", damit die WebApp (AppDate) es findet!
                pushToFirestore(data);

                console.log('✅ ERFOLG: Termin importiert: ' + data.title);
                message.markRead();
            }
        });
    });
}

function pushToFirestore(data) {
    // Ziel: Collection "exchange_events" auf Projekt "appdate-backend"
    const url = `https://firestore.googleapis.com/v1/projects/appdate-backend/databases/(default)/documents/exchange_events`;

    const payload = {
        "fields": {
            "title": { "stringValue": data.title },
            "start": { "stringValue": data.start },    // Muss ISO-Format sein (z.B. 2024-12-24T18:00:00)
            "end": { "stringValue": data.end },        // Muss ISO-Format sein
            "location": { "stringValue": data.location },
            "source": { "stringValue": "exchange" },   // Wichtig für die Farbe in der App (Lila)
            "description": { "stringValue": data.description }
        }
    };

    const options = {
        'method': 'post',
        'contentType': 'application/json',
        'payload': JSON.stringify(payload),
        'muteHttpExceptions': true
    };

    try {
        const response = UrlFetchApp.fetch(url, options);
        const params = JSON.parse(response.getContentText());

        if (response.getResponseCode() === 200) {
            console.log("✅ Firestore Write Success. ID: " + (params.name || "ok"));
        } else {
            console.error("❌ Firestore Error [" + response.getResponseCode() + "]: " + response.getContentText());
        }
    } catch (e) {
        console.error("Fetch Exception: " + e);
    }
}
