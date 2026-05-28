function processCalendarEmails() {
    // Suche so einfach wie möglich halten, Filterung passiert im Code
    const SEARCH_QUERY = 'subject:AppDate is:unread';
    const SECRET_TOKEN = 'AppDate'; // Muss mit Flow übereinstimmen

    // Konfiguration für Firestore
    const PROJECT_ID = 'appdate-backend'; // Dein Firebase Projekt ID
    const COLLECTION_NAME = 'exchange_events';

    console.log("Suche nach: " + SEARCH_QUERY);

    const threads = GmailApp.search(SEARCH_QUERY);
    threads.forEach(thread => {
        const messages = thread.getMessages();
        messages.forEach(message => {
            try {
                // Prüfe auf Nachrichtenebene, da Suchanfragen bei Gmail immer ganze Threads zurückgeben
                if (message.isUnread() && !message.isInTrash()) {
                    console.log("------------------------------------------");
                    const subject = message.getSubject();
                    console.log("Verarbeite: " + subject);

                    // Ignoriere Google Fehler-Mails direkt hier im Code
                    if (subject.includes("Summary of failures")) {
                        console.log("⚠️ Fehler-Benachrichtigung von Google erkannt. Ab in den Papierkorb.");
                        message.moveToTrash();
                        return;
                    }

                    let body = message.getPlainBody() || message.getBody();
                    body = body.replace(/[\r\n\t]/g, " ");

                    // Parser Helper
                    const extract = (key) => {
                        const regex = new RegExp(`"${key}"\\s*:\\s*"(.*?)"`);
                        const match = body.match(regex);
                        return match ? match[1] : "";
                    };

                    // Check secret token
                    const secretToken = extract("secret_token");
                    if (secretToken !== SECRET_TOKEN) {
                        console.log("⚠️ Kein gültiger Secret Token. Skip.");
                        message.moveToTrash(); // In den Papierkorb verschieben, damit sie beim nächsten Lauf nicht mehr gefunden wird
                        return;
                    }

                    const data = {
                        id: extract("id"), // WICHTIG: ID aus Outlook
                        title: extract("title"),
                        start: extract("start"),
                        end: extract("end"),
                        location: extract("location"),
                        description: extract("description").replace(/\{/g, "").trim(),
                        Action: extract("Action") // Case sensitive match with Flow
                    };

                    // Auto-Tagging für App Filter
                    // Wenn [App] im Titel oder Beschreibung, setze Flag
                    if ((data.title && data.title.includes('[App]')) || (data.description && data.description.includes('[App]'))) {
                        data.isAppRelevant = true;
                        // Clean tags from title for cleaner display
                        if (data.title) data.title = data.title.replace('[App]', '').trim();
                    }

                    // Fallback ID wenn keine im JSON (hash aus start+title)
                    if (!data.id) {
                        data.id = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, (data.start + data.title)));
                        console.log("⚠️ Keine ID empfangen. Generiere Hash-ID: " + data.id);
                    }

                    // Titel Fallback
                    if (!data.title) {
                        data.title = message.getSubject().replace("AppDate", "").trim() || "Unbenannter Termin";
                    }

                    // FIX: Convert UTC times to local time (CET/CEST = UTC+1/UTC+2)
                    // Outlook sends times in UTC, we need to store them in local time
                    const convertUTCToLocal = (utcString) => {
                        if (!utcString || !utcString.includes('T')) return utcString;
                        // Parse as UTC
                        const utcDate = new Date(utcString.endsWith('Z') ? utcString : utcString + 'Z');
                        // Get local time components
                        const year = utcDate.getFullYear();
                        const month = String(utcDate.getMonth() + 1).padStart(2, '0');
                        const day = String(utcDate.getDate()).padStart(2, '0');
                        const hours = String(utcDate.getHours()).padStart(2, '0');
                        const minutes = String(utcDate.getMinutes()).padStart(2, '0');
                        const seconds = String(utcDate.getSeconds()).padStart(2, '0');
                        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
                    };

                    data.start = convertUTCToLocal(data.start);
                    data.end = convertUTCToLocal(data.end);

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
                } // Ende von if (message.isUnread() && !message.isInTrash())
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
            "description": { "stringValue": data.description },
            "isAppRelevant": { "booleanValue": !!data.isAppRelevant }
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
