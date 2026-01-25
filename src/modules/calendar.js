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
        // Calculate dynamic header height + buffer
        const header = document.querySelector('header');
        const headerHeight = header ? header.offsetHeight : 120; // fallback
        const buffer = 80; // Extra space for date headers

        const headerOffset = headerHeight + buffer;
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

        // Use timeout to detach from UI stack
        setTimeout(async () => {
            try {
                // Checkpoint 1
                console.log("Starting import process inside timeout...");

                if (events.length === 0) {
                    alert(`Keine zukünftigen Termine gefunden.`);
                    return;
                }

                // Temporary removal of confirm to test execution flow
                // if(!confirm(...)) return; 
                console.log("Skipped confirm dialog for debugging. Proceeding...");

                const collectionRef = db.collection('app_events');

                // --- 1. CLEANUP OLD DATA ---
                console.log("Cleaning up old data...");

                // A) Delete old 'imported' events from app_events
                const oldImportSnapshot = await collectionRef.where('source', '==', 'imported').get();
                console.log(`Found ${oldImportSnapshot.size} old imported events to delete.`);
                await deleteInBatches(db, oldImportSnapshot.docs);
                console.log("Deleted old imported events.");

                // B) Delete ALL 'exchange_events'
                const exchangeSnapshot = await db.collection('exchange_events').get();
                console.log(`Found ${exchangeSnapshot.size} old exchange events to delete.`);
                await deleteInBatches(db, exchangeSnapshot.docs);
                console.log("Deleted old exchange events.");


                // --- 2. IMPORT NEW EVENTS ---
                console.log("Starting upload of new events...");
                const CHUNK_SIZE = 400;
                const chunks = [];
                for (let i = 0; i < events.length; i += CHUNK_SIZE) chunks.push(events.slice(i, i + CHUNK_SIZE));

                let totalUploaded = 0;
                for (const chunk of chunks) {
                    const batch = db.batch();
                    chunk.forEach(evt => {
                        const docRef = collectionRef.doc();
                        batch.set(docRef, {
                            ...evt,
                            source: 'imported',
                            createdAt: new Date()
                        });
                    });
                    await batch.commit();
                    totalUploaded += chunk.length;
                    console.log(`Uploaded batch. Total: ${totalUploaded}`);
                }

                console.log("All done.");
                alert(`✅ ${totalUploaded} Termine erfolgreich importiert!`);
                input.value = '';

            } catch (innerError) {
                console.error("Critical Error inside Import Timeout:", innerError);
                alert("Kritischer Import-Fehler: " + innerError.message);
            }
        }, 100);

    } catch (e) {
        console.error("Import Error:", e);
        alert('Fehler: ' + e.message);
    }
}

// Helper to delete docs in batches of 400
async function deleteInBatches(db, docs) {
    if (docs.length === 0) return;
    const CHUNK_SIZE = 400;
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) {
        const batch = db.batch();
        const chunk = docs.slice(i, i + CHUNK_SIZE);
        chunk.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
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
            const events = snapshot.docs.map(doc => {
                const data = doc.data();
                // FIX: Power Automate sends UTC but often without 'Z' suffix or just raw string.
                // We assume ALL exchange events are UTC.
                let start = data.start;
                let end = data.end;

                if (start && !start.endsWith('Z') && start.includes('T')) start += 'Z';
                if (end && !end.endsWith('Z') && end.includes('T')) end += 'Z';

                return { id: doc.id, ...data, start, end, source: 'exchange' };
            });
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

// === Recurring Events Helper ===
function toggleRecurrenceInput() {
    const val = document.getElementById('apptRecurrence').value;
    const endInput = document.getElementById('apptRecurrenceEnd');
    const intervalGroup = document.getElementById('recurrenceIntervalGroup');
    const unitLabel = document.getElementById('recurrenceUnitLabel');

    if (val === 'none') {
        endInput.disabled = true;
        endInput.value = '';
        intervalGroup.classList.add('hidden');
    } else {
        endInput.disabled = false;
        intervalGroup.classList.remove('hidden');

        let label = 'Tage';
        if (val === 'weekly') label = 'Wochen';
        if (val === 'monthly') label = 'Monate';
        if (val === 'yearly') label = 'Jahre';
        unitLabel.textContent = label;

        if (!endInput.value) {
            // Default to 1 year from now
            const d = new Date();
            d.setFullYear(d.getFullYear() + 1);
            endInput.value = d.toISOString().split('T')[0];
        }
    }
}

// Add Listener
document.addEventListener('DOMContentLoaded', () => {
    const recSelect = document.getElementById('apptRecurrence');
    if (recSelect) recSelect.addEventListener('change', toggleRecurrenceInput);
});


// Export new Delete functions
window.deleteCurrentInstance = deleteCurrentInstance;
window.deleteSeries = deleteSeries;

function updateCalendarView() {
    // 1. Deduplication & Expansion
    const expandedMap = new Map(); // Key: "originalId|date" -> event

    const processEvent = (evt) => {
        const key = `${evt.start.split('T')[0]}|${evt.title}`;

        // No recurrence or interval 0 (safety)
        if (!evt.recurrence || evt.recurrence === 'none') {
            expandedMap.set(key, evt);
            return;
        }

        const recurrence = evt.recurrence;
        const interval = parseInt(evt.recurrenceInterval || 1, 10);

        const startDate = new Date(evt.start);
        const endDateLimit = evt.recurrenceEnd ? new Date(evt.recurrenceEnd) : new Date(new Date().setFullYear(new Date().getFullYear() + 1));

        let instances = 0;
        let currentDate = new Date(startDate);
        const duration = new Date(evt.end).getTime() - startDate.getTime();

        // Lock Original Time to prevent DST Drift
        const origH = String(startDate.getHours()).padStart(2, '0');
        const origMin = String(startDate.getMinutes()).padStart(2, '0');

        // Safety: Max 500 instances
        while (currentDate <= endDateLimit && instances < 500) {
            const y = currentDate.getFullYear();
            const m = String(currentDate.getMonth() + 1).padStart(2, '0');
            const d = String(currentDate.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`; // YYYY-MM-DD

            // Check Exclusions (Single Delete)
            if (evt.excludedDates && evt.excludedDates.includes(dateStr)) {
                // Skip but increment
                incrementDate(currentDate, recurrence, interval);
                instances++;
                continue;
            }

            // Use Original Time (origH, origMin) NOT currentDate time
            const newStartIso = `${y}-${m}-${d}T${origH}:${origMin}:00`;
            const newEndIso = new Date(new Date(newStartIso).getTime() + duration).toISOString().slice(0, 19);

            const instance = { ...evt, start: newStartIso, end: newEndIso, _isInstance: instances > 0 };
            const instanceKey = `${newStartIso.split('T')[0]}|${evt.title}`;

            expandedMap.set(instanceKey, instance);

            incrementDate(currentDate, recurrence, interval);
            instances++;
        }
    };

    const allSources = [...state.events.app, ...state.events.exchange];
    allSources.forEach(processEvent);

    state.allEvents = Array.from(expandedMap.values());
    renderCalendar();
}

function incrementDate(date, recurrence, interval) {
    if (recurrence === 'daily') date.setDate(date.getDate() + interval);
    if (recurrence === 'weekly') date.setDate(date.getDate() + (7 * interval));
    if (recurrence === 'monthly') date.setMonth(date.getMonth() + interval);
    if (recurrence === 'yearly') date.setFullYear(date.getFullYear() + interval);
}

function renderCalendar() {
    const container = document.getElementById('calendarList');
    if (!container) return;

    const events = state.allEvents || [];
    if (events.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-br-300"><div class="text-4xl mb-2">📅</div><p>Keine Termine gefunden</p></div>`;
        return;
    }

    events.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

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
            // Allow editing/deleting ALL events, including Exchange.
            // This allows cleaning up stale sync entries manually.
            const isExchange = evt.source === 'exchange';
            // Visual: Recurring instances get small icon?
            const isRecurring = evt.recurrence && evt.recurrence !== 'none';
            const displayTime = formatEventTime(evt);

            // Pass evt.start (instance start) to edit
            const startParam = evt.start ? `'${evt.start}'` : 'null';

            html += `<div class="p-4 rounded-xl border ${!isExchange ? 'bg-br-800 border-br-600 hover:border-blue-500 cursor-pointer' : 'bg-br-800/50 border-br-700'} transition-all relative overflow-hidden group"
                ${!isExchange ? `onclick="editAppointment('${evt.id}', ${startParam})"` : ''}>
                ${isExchange ? '<div class="absolute right-0 top-0 bottom-0 w-1 bg-purple-500"></div>' : '<div class="absolute right-0 top-0 bottom-0 w-1 bg-blue-500"></div>'}
                <div class="flex justify-between items-start">
                    <div>
                        <div class="font-medium text-white mb-1 flex items-center gap-2">
                             ${evt.title || 'Termin'}
                             ${isRecurring ? '<span class="text-[10px] text-blue-300 bg-blue-900/40 px-1 rounded">↻</span>' : ''}
                        </div>
                        <div class="flex items-center gap-3 text-xs text-br-300">
                            <span class="flex items-center gap-1">⏰ ${displayTime}</span>
                            ${evt.location ? `<span class="flex items-center gap-1">📍 ${evt.location}</span>` : ''}
                        </div>
                    </div>
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
    return '';
}

function addAppointment() { } // unused

function openAddAppointmentModal() {
    const modal = document.getElementById('editAppointmentModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    state.editingAppointmentId = null;
    state.editingInstanceDate = null;
    document.getElementById('apptId').value = '';
    document.getElementById('apptTitle').value = '';
    document.getElementById('apptDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('apptStart').value = '09:00';
    document.getElementById('apptEnd').value = '10:00';
    document.getElementById('apptLocation').value = '';
    document.getElementById('apptDescription').value = '';
    document.getElementById('apptAllDay').checked = false;

    // Reset Recurrence
    document.getElementById('apptRecurrence').value = 'none';
    document.getElementById('apptRecurrenceInterval').value = '1';
    document.getElementById('apptRecurrenceEnd').value = '';
    toggleRecurrenceInput();

    // Show standard delete hidden (it's new)
    document.getElementById('btnDeleteAppt').classList.add('hidden');
    document.getElementById('btnGroupRecurringDelete').classList.add('hidden');
    document.getElementById('modalTitleAppt').textContent = '✨ Neuer Termin';
}

function editAppointment(id, instanceStart) {
    let evt = state.events.app.find(e => e.id === id);
    if (!evt) evt = state.events.exchange.find(e => e.id === id);

    if (!evt) {
        console.error("Event not found for editing:", id);
        return;
    }

    state.editingAppointmentId = id;
    // Extract YYYY-MM-DD from instanceStart if present, else from evt.start
    const currentStart = instanceStart || evt.start;
    const dateStr = currentStart.split('T')[0];
    state.editingInstanceDate = dateStr;

    const start = new Date(currentStart);
    // Use duration to calc end
    const origStart = new Date(evt.start);
    const origEnd = new Date(evt.end);
    const duration = origEnd - origStart;
    const end = new Date(start.getTime() + duration);

    document.getElementById('editAppointmentModal').classList.remove('hidden');
    document.getElementById('editAppointmentModal').classList.add('flex');
    document.getElementById('apptId').value = id;
    document.getElementById('apptTitle').value = evt.title;
    document.getElementById('apptDate').value = dateStr;
    document.getElementById('apptStart').value = start.toTimeString().substring(0, 5);
    document.getElementById('apptEnd').value = end.toTimeString().substring(0, 5);
    document.getElementById('apptLocation').value = evt.location || '';
    document.getElementById('apptDescription').value = evt.description || '';
    document.getElementById('apptAllDay').checked = evt.isAllDay || false;

    // Recurrence
    document.getElementById('apptRecurrence').value = evt.recurrence || 'none';
    document.getElementById('apptRecurrenceInterval').value = evt.recurrenceInterval || '1';
    document.getElementById('apptRecurrenceEnd').value = evt.recurrenceEnd || '';
    toggleRecurrenceInput();

    // Toggle Buttons based on Recurrence
    const isRecurring = evt.recurrence && evt.recurrence !== 'none';
    if (isRecurring) {
        document.getElementById('btnDeleteAppt').classList.add('hidden');
        document.getElementById('btnGroupRecurringDelete').classList.remove('hidden');
    } else {
        document.getElementById('btnDeleteAppt').classList.remove('hidden');
        document.getElementById('btnGroupRecurringDelete').classList.add('hidden');
    }

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

    // Recurrence
    const recurrence = document.getElementById('apptRecurrence').value;
    const recurrenceInterval = document.getElementById('apptRecurrenceInterval').value;
    const recurrenceEnd = document.getElementById('apptRecurrenceEnd').value;

    if (!title || !date) {
        alert('❌ Bitte Titel und Datum angeben');
        return;
    }

    const startIso = `${date}T${startTime}:00`;
    const endIso = `${date}T${endTime}:00`;

    // Source handling
    let source = 'app';
    if (id) {
        const existing = state.events.app.find(e => e.id === id) || state.events.exchange.find(e => e.id === id);
        if (existing) source = existing.source;
    }

    const data = {
        title,
        start: startIso,
        end: endIso,
        location,
        description,
        isAllDay,
        recurrence,
        recurrenceInterval: parseInt(recurrenceInterval || 1, 10),
        recurrenceEnd,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        source
    };

    try {
        if (id) {
            await db.collection(source === 'exchange' ? 'exchange_events' : 'app_events').doc(id).update(data);
        } else {
            data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            await db.collection('app_events').add(data);
        }
        closeEditAppointmentModal();
    } catch (e) {
        console.error(e);
        alert('❌ Fehler beim Speichern: ' + e.message);
    }
}

async function deleteAppointment() {
    const id = state.editingAppointmentId;
    console.log("Start delete flow for ID:", id);

    if (!id) {
        console.log("No ID found. Cannot delete.");
        return;
    }

    // Explicitly removed confirm() to fix blocking issue.
    console.log("Proceeding with delete (no confirm dialog).");
    console.log("User confirmed delete (assumed).");

    // Bruteforce: Delete from BOTH collections to be sure.
    // Deleting a non-existent doc is not an error in Firestore.
    try {
        console.log("Deleting from app_events...");
        const p1 = db.collection('app_events').doc(id).delete();

        console.log("Deleting from exchange_events...");
        const p2 = db.collection('exchange_events').doc(id).delete();

        await Promise.all([p1, p2]);

        console.log("Deleted from DB (bruteforce check both tables). Success.");
        closeEditAppointmentModal();
    } catch (e) {
        console.error("Delete Error:", e);
        alert('❌ Fehler beim Löschen: ' + e.message);
    }
}

function closeEditAppointmentModal() {
    document.getElementById('editAppointmentModal').classList.add('hidden');
    document.getElementById('editAppointmentModal').classList.remove('flex');
    state.editingAppointmentId = null;
}
