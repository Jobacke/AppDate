import { state } from '../store.js';
import { db, firebase } from '../config.js';

export function initCalendar() {
    window.addAppointment = addAppointment;
    window.editAppointment = editAppointment;
    window.saveAppointmentEdit = saveAppointmentEdit;
    window.deleteAppointment = deleteAppointment;
    window.closeEditAppointmentModal = closeEditAppointmentModal;
    window.openAddAppointmentModal = openAddAppointmentModal;
    // Explicitly attach listener to ensure reliable triggering
    const input = document.getElementById('icsInput');
    if (input) {
        input.onchange = function () { handleIcsUpload(this); };
        // Allow re-selecting the same file
        input.onclick = function () { this.value = null; };
    }

    // Immediately start listening when module loads
    subscribeCalendar();
}

// Expose functions globally
window.addAppointment = addAppointment;
window.editAppointment = editAppointment;
window.saveAppointmentEdit = saveAppointmentEdit;
window.deleteAppointment = deleteAppointment;
window.closeEditAppointmentModal = closeEditAppointmentModal;
window.openAddAppointmentModal = openAddAppointmentModal;
window.handleIcsUpload = handleIcsUpload;
window.jumpToToday = jumpToToday;
window.jumpToDate = jumpToDate;

let exchangeUnsubscribe = null;
let appUnsubscribe = null;

// === Navigation ===

function jumpToToday() {
    const today = new Date().toISOString().split('T')[0];
    jumpToDate(today);
}

function jumpToDate(dateStr) {
    if (!dateStr) return;

    // Convert date string to match our ID format (date-YYYY-MM-DD)
    const element = document.getElementById(`date-${dateStr}`);

    if (element) {
        // Offset for sticky header
        const headerOffset = 180;
        const elementPosition = element.getBoundingClientRect().top;
        const offsetPosition = elementPosition + window.pageYOffset - headerOffset;

        window.scrollTo({
            top: offsetPosition,
            behavior: "smooth"
        });

        // Highlight effect
        element.classList.add('bg-br-700');
        setTimeout(() => element.classList.remove('bg-br-700'), 1500);
    } else {
        // If exact date not found, find next closest
        const allDates = Object.keys(state.groupedEvents || {}).sort();
        const nextDate = allDates.find(d => d >= dateStr);
        if (nextDate) {
            jumpToDate(nextDate);
        } else {
            alert('Keine Termine an oder nach diesem Datum gefunden.');
        }
    }

    // Update picker visual
    const picker = document.getElementById('dateNav');
    if (picker && picker.value !== dateStr) picker.value = dateStr;
}

// === ICS Import ===

async function handleIcsUpload(input) {
    if (!input.files || !input.files[0]) return;
    const file = input.files[0];

    console.log("Reading file:", file.name);

    try {
        const text = await file.text();
        console.log("File content length:", text.length);

        const eventsRaw = parseICS(text);

        // Filter: Only future events (from yesterday onwards)
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayIso = yesterday.toISOString().split('T')[0];

        const events = eventsRaw.filter(e => {
            if (!e.start) return false;
            const eventDate = e.start.split('T')[0];
            return eventDate >= yesterdayIso;
        });

        console.log(`Found ${eventsRaw.length} total events. filtered to ${events.length} future events.`);

        // Use timeout to detach from the file input event stack, preventing UI glitches
        setTimeout(async () => {
            if (events.length === 0) {
                alert(`Keine zukünftigen Termine gefunden (von ${eventsRaw.length} geprüften).`);
                return;
            }

            if (!confirm(`${events.length} zukünftige Termine gefunden. Importieren?\n⚠️ Alle zuvor importierten Termine werden dabei überschrieben!`)) return;

            // Import logic...
            const collectionRef = db.collection('app_events');

            // 1. DELETE OLD IMPORTED EVENTS
            console.log("Deleting old imported events...");
            const oldEventsSnapshot = await collectionRef.where('source', '==', 'imported').get();

            if (!oldEventsSnapshot.empty) {
                const deleteBatch = db.batch();
                oldEventsSnapshot.docs.forEach(doc => {
                    deleteBatch.delete(doc.ref);
                });
                await deleteBatch.commit();
                console.log(`Deleted ${oldEventsSnapshot.size} old events.`);
            }

            // 2. IMPORT NEW EVENTS (Chunking logic)
            const CHUNK_SIZE = 400;
            const chunks = [];
            for (let i = 0; i < events.length; i += CHUNK_SIZE) chunks.push(events.slice(i, i + CHUNK_SIZE));

            console.log(`Uploading new events in ${chunks.length} batches...`);

            let totalUploaded = 0;
            for (const chunk of chunks) {
                const batch = db.batch();
                chunk.forEach(evt => {
                    const docRef = collectionRef.doc();
                    batch.set(docRef, {
                        ...evt,
                        source: 'imported', // Mark as imported so we can delete them next time
                        createdAt: new Date()
                    });
                });
                await batch.commit();
                totalUploaded += chunk.length;
                console.log(`Uploaded ${totalUploaded}/${events.length}`);
            }

            console.log("All batches committed.");
            alert(`✅ ${totalUploaded} Termine erfolgreich importiert (alte gelöscht)!`);
            input.value = ''; // Reset input here
        }, 100);

    } catch (e) {
        console.error("Import Error:", e);
        alert('Fehler: ' + e.message);
    }
}

function parseICS(icsContent) {
    const events = [];
    // Handle different line endings including mixed
    const lines = icsContent.split(/\r\n|\n|\r/);
    let currentEvent = null;

    const parseDate = (val) => {
        if (!val) return null;
        try {
            // Remove timezone params if present (e.g., ;TZID=Europe/Berlin:2023...)
            const parts = val.split(':');
            const cleanVal = parts[parts.length - 1];

            const year = cleanVal.substring(0, 4);
            const month = cleanVal.substring(4, 6);
            const day = cleanVal.substring(6, 8);
            let hour = '00', minute = '00', second = '00';

            if (cleanVal.includes('T')) {
                const timePart = cleanVal.split('T')[1];
                hour = timePart.substring(0, 2);
                minute = timePart.substring(2, 4);
                second = timePart.substring(4, 6);
            }
            return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
        } catch (e) { return null; }
    };

    lines.forEach(line => {
        line = line.trim();
        if (line === 'BEGIN:VEVENT') {
            currentEvent = {};
        } else if (line === 'END:VEVENT') {
            if (currentEvent && (currentEvent.title || currentEvent.summary) && currentEvent.start) {
                if (!currentEvent.title && currentEvent.summary) currentEvent.title = currentEvent.summary;
                events.push(currentEvent);
            }
            currentEvent = null;
        } else if (currentEvent) {
            if (line.startsWith('SUMMARY:')) currentEvent.title = line.substring(8); // Simple parsing
            // Handle SUMMARY;LANGUAGE=de:Titel format
            if (line.startsWith('SUMMARY;')) {
                const parts = line.split(':');
                if (parts.length > 1) currentEvent.title = parts.slice(1).join(':');
            }

            if (line.startsWith('DTSTART')) currentEvent.start = parseDate(line);
            if (line.startsWith('DTEND')) currentEvent.end = parseDate(line);

            if (line.startsWith('LOCATION:')) currentEvent.location = line.substring(9);
            if (line.startsWith('DESCRIPTION:')) currentEvent.description = line.substring(12);
        }
    });

    return events;
}

export function subscribeCalendar() {
    unsubscribeCalendar(); // Clear previous

    state.events = { exchange: [], app: [] };

    // Exchange Events - Reading from ROOT collection "exchange_events"
    exchangeUnsubscribe = db.collection('exchange_events')
        .onSnapshot(snapshot => {
            const events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), source: 'exchange' }));
            state.events.exchange = events;
            updateCalendarView();
        }, err => console.log("Exchange sync error", err));

    // App Events - Reading/Writing to ROOT collection "app_events"
    appUnsubscribe = db.collection('app_events')
        .onSnapshot(snapshot => {
            const events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), source: 'app' }));
            state.events.app = events;
            updateCalendarView();
        }, err => console.log("App sync error", err));
}

export function unsubscribeCalendar() {
    if (exchangeUnsubscribe) exchangeUnsubscribe();
    if (appUnsubscribe) appUnsubscribe();
    exchangeUnsubscribe = null;
    appUnsubscribe = null;
}

function updateCalendarView() {
    state.allEvents = [...state.events.exchange, ...state.events.app];
    renderCalendar();
}

function renderCalendar() {
    const container = document.getElementById('calendarList');
    if (!container) return;

    const events = state.allEvents || [];
    if (events.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-br-300"><div class="text-4xl mb-2">📅</div><p>Keine Termine gefunden</p></div>`;
        return;
    }

    // Sort
    events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    // Filter >= Yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayIso = yesterday.toISOString().split('T')[0];

    const relevantEvents = events.filter(e => {
        const dateStr = (e.start || '').split('T')[0];
        return dateStr >= yesterdayIso;
    });

    const groups = {};
    relevantEvents.forEach(e => {
        const date = (e.start || '').split('T')[0];
        if (!groups[date]) groups[date] = [];
        groups[date].push(e);
    });

    state.groupedEvents = groups;

    const dates = Object.keys(groups).sort();
    let html = '';

    dates.forEach(date => {
        const groupEvents = groups[date];
        const dayName = new Date(date).toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const isToday = date === new Date().toISOString().split('T')[0];

        html += `<div id="date-${date}" class="mb-6 scroll-mt-48 transition-colors duration-500 rounded-lg">
            <div class="sticky top-[7.5rem] bg-br-900/95 backdrop-blur py-2 border-b border-br-700 mb-2 z-10 flex items-center gap-2 shadow-md">
                <h3 class="font-bold ${isToday ? 'text-blue-400' : 'text-br-200'} text-lg">${isToday ? 'Heute, ' : ''}${dayName}</h3>
            </div>
            <div class="space-y-3">`;

        groupEvents.forEach(evt => {
            const isApp = evt.source === 'app' || evt.source === 'imported'; // Treat imported as app-editable
            // Note: Imported events usually default to 'imported' source, let's treat them as app (editable) visually if desired, or distinct.
            // For now, let's make them editable:
            const editable = isApp || evt.source === 'imported';

            const displayTime = formatEventTime(evt);

            html += `<div class="p-4 rounded-xl border ${editable ? 'bg-br-800 border-br-600 hover:border-blue-500 cursor-pointer' : 'bg-br-800/50 border-br-700'} transition-all relative overflow-hidden group"
                ${editable ? `onclick="editAppointment('${evt.id}')"` : ''}>
                ${editable ? '<div class="absolute right-0 top-0 bottom-0 w-1 bg-blue-500"></div>' : '<div class="absolute right-0 top-0 bottom-0 w-1 bg-purple-500"></div>'}
                <div class="flex justify-between items-start">
                    <div>
                        <div class="font-medium text-white mb-1">${evt.title || evt.subject || 'Termin'}</div>
                        <div class="flex items-center gap-3 text-xs text-br-300">
                            <span class="flex items-center gap-1">⏰ ${displayTime}</span>
                            ${evt.location ? `<span class="flex items-center gap-1">📍 ${evt.location}</span>` : ''}
                        </div>
                    </div>
                    ${editable ? '' : '<span class="text-[10px] bg-purple-900/50 text-purple-300 px-2 py-1 rounded border border-purple-800">Exchange</span>'}
                </div>
                ${evt.description ? `<div class="mt-2 text-xs text-br-400 line-clamp-2">${evt.description}</div>` : ''}
            </div>`;
        });
        html += `</div></div>`;
    });

    if (relevantEvents.length === 0) {
        html = `<div class="p-8 text-center text-br-300"><p>Keine zukünftigen Termine</p></div>`;
    }
    container.innerHTML = html;
}

function formatEventTime(evt) {
    if (evt.isAllDay) return 'Ganztägig';
    if (evt.start && evt.end) {
        try {
            const s = new Date(evt.start);
            const e = new Date(evt.end);
            return `${s.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} - ${e.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
        } catch (ex) { }
    }
    return 'Zeit unklar';
}

function addAppointment() {
    // Should verify state or form?
    // Handled by saveAppointmentEdit via Modal inputs
}

function openAddAppointmentModal() {
    const modal = document.getElementById('editAppointmentModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    state.editingAppointmentId = null;
    document.getElementById('apptId').value = '';
    document.getElementById('apptTitle').value = '';
    document.getElementById('apptDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('apptStart').value = '09:00';
    document.getElementById('apptEnd').value = '10:00';
    document.getElementById('apptLocation').value = '';
    document.getElementById('apptDescription').value = '';
    document.getElementById('apptAllDay').checked = false;
    document.getElementById('btnDeleteAppt').classList.add('hidden');
    document.getElementById('modalTitleAppt').textContent = '✨ Neuer Termin';
}

function editAppointment(id) {
    // Search in both lists
    let evt = state.events.app.find(e => e.id === id);
    if (!evt) evt = state.events.exchange.find(e => e.id === id); // Exchange usually not editable but safeguard

    if (!evt) return;

    // Check if source allowed (only app or imported)
    if (evt.source !== 'app' && evt.source !== 'imported') {
        // Maybe show details only? For now, prevent edit.
        return;
    }

    state.editingAppointmentId = id;
    const start = new Date(evt.start);
    const end = new Date(evt.end);

    document.getElementById('editAppointmentModal').classList.remove('hidden');
    document.getElementById('editAppointmentModal').classList.add('flex');
    document.getElementById('apptId').value = id;
    document.getElementById('apptTitle').value = evt.title;
    document.getElementById('apptDate').value = evt.start.split('T')[0];
    document.getElementById('apptStart').value = start.toTimeString().substring(0, 5);
    document.getElementById('apptEnd').value = end.toTimeString().substring(0, 5);
    document.getElementById('apptLocation').value = evt.location || '';
    document.getElementById('apptDescription').value = evt.description || '';
    document.getElementById('apptAllDay').checked = evt.isAllDay || false;
    document.getElementById('btnDeleteAppt').classList.remove('hidden');
    document.getElementById('modalTitleAppt').textContent = '✏️ Termin bearbeiten';
}

async function saveAppointmentEdit() {
    const id = state.editingAppointmentId;
    const title = document.getElementById('apptTitle').value;
    const date = document.getElementById('apptDate').value;
    const startTime = document.getElementById('apptStart').value;
    const endTime = document.getElementById('apptEnd').value;
    const location = document.getElementById('apptLocation').value;
    const description = document.getElementById('apptDescription').value;
    const isAllDay = document.getElementById('apptAllDay').checked;

    if (!title || !date) {
        alert('❌ Bitte Titel und Datum angeben');
        return;
    }

    const startIso = `${date}T${startTime}:00`;
    const endIso = `${date}T${endTime}:00`;

    const data = { title, start: startIso, end: endIso, location, description, isAllDay, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), source: 'app' };

    try {
        if (id) {
            await db.collection('app_events').doc(id).update(data);
        } else {
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await db.collection('app_events').add(data);
        }
        closeEditAppointmentModal();
    } catch (e) {
        console.error(e);
        alert('❌ Fehler beim Speichern');
    }
}

async function deleteAppointment() {
    if (!state.editingAppointmentId || !confirm('Termin wirklich löschen?')) return;
    try {
        await db.collection('app_events').doc(state.editingAppointmentId).delete();
        closeEditAppointmentModal();
    } catch (e) {
        alert('❌ Fehler beim Löschen');
    }
}

function closeEditAppointmentModal() {
    document.getElementById('editAppointmentModal').classList.add('hidden');
    document.getElementById('editAppointmentModal').classList.remove('flex');
    state.editingAppointmentId = null;
}
