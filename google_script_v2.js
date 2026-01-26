function processCalendarEmails() {
    const SEARCH_QUERY = 'subject:AppDate is:unread in:inbox -in:trash -in:drafts';
    const SECRET_TOKEN = 'AppDate123'; // Muss mit Flow übereinstimmen

    // Konfiguration für Firestore
    const PROJECT_ID = 'appdate-backend'; // Dein Firebase Projekt ID
    const COLLECTION_NAME = 'exchange_events';

    console.log("Suche nach: " + SEARCH_QUERY);

    const threads = GmailApp.search(SEARCH_QUERY);
    threads.forEach(thread => {
        const messages = thread.getMessages();
        messages.forEach(message => {
            try {
                if (message.isUnread()) {
                    console.log("------------------------------------------");
                    console.log("Verarbeite: " + message.getSubject());

                    let body = message.getPlainBody() || message.getBody();
                    body = body.replace(/[\r\n\t]/g, " ");

                    if (body.indexOf(SECRET_TOKEN) === -1) {
                        console.log("⚠️ Kein Secret Token. Skip.");
                        return;
                    }

                    // Parser Helper
                    const extract = (key) => {
                        const regex = new RegExp(`"${key}"\\s*:\\s*"(.*?)"`);
                        const match = body.match(regex);
                        return match ? match[1] : "";
                    };

                    const data = {
                        id: extract("id"), // WICHTIG: ID aus Outlook
                        title: extract("title"),
                        start: extract("start"),
                        end: extract("end"),
                        location: extract("location"),
                        description: extract("description"),
                        Action: extract("Action") // Case sensitive match with Flow
                    };

                    // Fallback ID wenn keine im JSON (hash aus start+title)
                    if (!data.id) {
                        data.id = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (data.start + data.title)));
                        console.log("⚠️ Keine ID empfangen. Generiere Hash-ID: " + data.id);
                    }

                    // Titel Fallback
                    if (!data.title) {
                        data.title = message.getSubject().replace("AppDate", "").trim() || "Unbenannter Termin";
                    }

                    updateFirestore(PROJECT_ID, COLLECTION_NAME, data);

                    console.log("🗑️ Nachricht verarbeitet -> Lösche permanent.");

                    // HINWEIS: Um Nachrichten permanent zu löschen, muss der "Gmail API" Dienst aktiviert werden!
                    // Gehe im Apps Script Editor links auf "Dienste" (+) -> Wähle "Gmail API" -> Hinzufügen.
                    try {
                        Gmail.Users.Messages.remove('me', message.getId());
                        console.log("✅ Permanent gelöscht.");
                    } catch (e) {
                        console.error("❌ Fehler beim permanenten Löschen (Gmail API aktiviert?): " + e.message);
                        console.log("Fallback: Verschiebe in Papierkorb.");
                        message.moveToTrash();
                    }
                }
            } catch (err) {
                console.error("❌ Kritischer Fehler beim Verarbeiten einer Nachricht: " + err.message);
            }
        });
    });
}

function updateFirestore(projectId, collection, data) {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

    // 1. Suche ob Dokument mit dieser 'externalId' existiert
    // Da wir in Firestore nicht einfach nach Feld suchen können ohne Index, und wir keine ID als Doc-ID verwenden (bisher auto-id),
    // müssen wir einen Query machen.
    // TRICK: Wir speichern das Doc in Firestore direkt unter der Outlook-ID (base64 encoded safe string).
    // Dann ist Doc-ID = Outlook-ID. Upsert wird trivial!

    // ID muss URL-Safe sein. Outlook IDs sind lang und hässlich. Base64?
    // Oder wir nehmen einfach nur a-z0-9. Base64UrlEncode ist gut.
    const safeDocId = Utilities.base64EncodeWebSafe(data.id).replace(/=/g, "");

    const docUrl = `${firestoreUrl}/${collection}/${safeDocId}`;

    // CHECK FOR DELETE
    // Wenn keine Startzeit da ist, oder Action=deleted (Outlook sendet oft "deleted" oder "removed"), löschen wir.
    // Wir prüfen case-insensitive auf 'delete'
    const actionLower = (data.Action || "").toLowerCase();
    if (actionLower.includes('delete') || (!data.start && data.id)) {
        console.log("🗑️ LÖSCHEN detected für ID: " + data.id);
        const options = {
            'method': 'delete',
            'muteHttpExceptions': true
        };
        UrlFetchApp.fetch(docUrl, options);
        console.log("✅ Gelöscht.");
        return;
    }

    // CREATE / UPDATE (PATCH)
    // Wir nutzen patch mit updateMask, das verhält sich wie Upsert (erstellt wenn nicht da).

    const payload = {
        "fields": {
            "externalId": { "stringValue": data.id },
            "title": { "stringValue": data.title },
            "start": { "stringValue": data.start },
            "end": { "stringValue": data.end },
            "location": { "stringValue": data.location },
            "source": { "stringValue": "exchange" },
            "description": { "stringValue": data.description }
        }
    };

    const params = Object.keys(payload.fields).map(f => `updateMask.fieldPaths=${f}`).join('&');
    const finalUrl = `${docUrl}?${params}`;

    const options = {
        'method': 'patch',
        'contentType': 'application/json',
        'payload': JSON.stringify(payload),
        'muteHttpExceptions': true
    };

    try {
        const response = UrlFetchApp.fetch(finalUrl, options);
        if (response.getResponseCode() === 200) {
            console.log("✅ Firestore Upsert Success: " + safeDocId);
        } else {
            console.error("❌ Firestore Error [" + response.getResponseCode() + "]: " + response.getContentText());
        }
    } catch (e) {
        console.error("Fetch Exception: " + e);
    }
}
