import { state } from '../store.js';
import { db, firebase } from '../config.js';

const APP_VERSION = 'v1.2.5';

export function initCalendar() {
    console.log("AppDate Version:", APP_VERSION);
    document.querySelectorAll('.app-version-label').forEach(el => el.textContent = APP_VERSION);

    window.addAppointment = addAppointment;
    window.editAppointment = editAppointment;
    window.saveAppointmentEdit = saveAppointmentEdit;
    window.deleteAppointment = deleteAppointment;
    window.closeEditAppointmentModal = closeEditAppointmentModal;
    window.openAddAppointmentModal = openAddAppointmentModal;
    // Explicitly attach listener to ensure reliable triggering
    const input = document.getElementById('icsInput');
    if (input) {
        // onchange is handled via HTML attribute now
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
window.setCalendarFilter = setCalendarFilter;
window.jumpToToday = jumpToToday;
window.jumpToDate = jumpToDate;

window.exportManualAppointments = exportManualAppointments;
window.handleBackupUpload = handleBackupUpload;

let exchangeUnsubscribe = null;
let appUnsubscribe = null;
let currentFilter = 'all';
let currentSearchTerm = '';
let initialScrollDone = false;

// View State
let currentView = 'calendar'; // 'calendar' or 'overview'
let overviewRange = 'week'; // 'week', 'month', 'year', 'custom'

// Selection Mode State
let isSelectionMode = false;
let selectedIds = new Set();

window.switchView = (view) => {
    currentView = view;

    // UI Toggles
    const calList = document.getElementById('calendarList');
    const ovView = document.getElementById('overviewView');
    const btnCal = document.getElementById('nav-btn-calendar');
    const btnOv = document.getElementById('nav-btn-overview');

    // Header specific elements to hide/show
    // Actually, keep header global but maybe hide the "Jump to Today" in overview if desired.
    // user wanted "New Tab", so standard behavior is enough.

    if (view === 'calendar') {
        calList.classList.remove('hidden');
        ovView.classList.add('hidden');

        // Nav Styling
        btnCal.classList.add('text-blue-400', 'bg-blue-500/10');
        btnCal.classList.remove('text-br-400', 'hover:text-br-200');

        btnOv.classList.remove('text-blue-400', 'bg-blue-500/10');
        btnOv.classList.add('text-br-400', 'hover:text-br-200');

        renderCalendar(); // Refresh
    } else {
        calList.classList.add('hidden');
        ovView.classList.remove('hidden');

        // Nav Styling
        btnOv.classList.add('text-blue-400', 'bg-blue-500/10');
        btnOv.classList.remove('text-br-400', 'hover:text-br-200');

        btnCal.classList.remove('text-blue-400', 'bg-blue-500/10');
        btnCal.classList.add('text-br-400', 'hover:text-br-200');

        renderOverview();
    }
};

window.setOverviewRange = (range) => {
    overviewRange = range;

    // Update Buttons
    ['week', 'month', 'year', 'custom'].forEach(r => {
        const btn = document.getElementById(`ov-btn-${r}`);
        if (r === range) {
            btn.classList.add('bg-blue-600', 'text-white', 'shadow');
            btn.classList.remove('text-br-300', 'hover:text-white');
        } else {
            btn.classList.remove('bg-blue-600', 'text-white', 'shadow');
            btn.classList.add('text-br-300', 'hover:text-white');
        }
    });

    const customInputs = document.getElementById('overviewCustomInputs');
    if (range === 'custom') {
        customInputs.classList.remove('hidden');
    } else {
        customInputs.classList.add('hidden');
    }

    renderOverview();
};

window.renderOverview = () => {
    const container = document.getElementById('overviewList');
    if (!container) return;

    // state.allEvents already contains EXPANDED instances from renderCalendar logic
    // We just need to filter them by date range and category.
    let events = state.allEvents || [];

    // 1. Apply Source Filter
    events = events.filter(e => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'exchange') return e.source === 'exchange' || e.source === 'imported';
        if (currentFilter === 'manual') return e.source === 'app';
        return true;
    });

    // 2. Apply Time Range Filter
    const now = new Date();

    let startLimit, endLimit;

    if (overviewRange === 'week') {
        const current = new Date(now);
        const day = current.getDay() || 7;
        if (day !== 1) current.setHours(-24 * (day - 1));
        startLimit = current.toISOString().split('T')[0];

        const end = new Date(current);
        end.setDate(end.getDate() + 6);
        endLimit = end.toISOString().split('T')[0];

    } else if (overviewRange === 'month') {
        startLimit = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        endLimit = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

    } else if (overviewRange === 'year') {
        startLimit = `${now.getFullYear()}-01-01`;
        endLimit = `${now.getFullYear()}-12-31`;

    } else if (overviewRange === 'custom') {
        startLimit = document.getElementById('ovStart').value;
        endLimit = document.getElementById('ovEnd').value;
    }

    // Filter by Date Range
    const relevantEvents = events.filter(e => {
        const dateStr = (e.start || '').split('T')[0];
        if (startLimit && dateStr < startLimit) return false;
        if (endLimit && dateStr > endLimit) return false;
        return true;
    });

    relevantEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    if (relevantEvents.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-br-300">Keine Termine im Zeitraum</div>`;
        return;
    }

    let html = `<div class="bg-br-800 rounded-xl overflow-hidden border border-br-600/50">`;
    let lastDate = '';

    relevantEvents.forEach(e => {
        const dateRaw = e.start.split('T')[0];
        const dateObj = new Date(e.start);
        const dateDisplay = dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
        const dayShort = dateObj.toLocaleDateString('de-DE', { weekday: 'short' });
        const timeDisplay = e.isAllDay ? 'All Day' : dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

        const isNewDay = dateRaw !== lastDate;
        lastDate = dateRaw;

        const rowClass = isNewDay ? 'border-t border-br-700/50' : '';
        const bgClass = e.source === 'exchange' ? 'text-purple-300' : 'text-blue-300';

        // Compact Row
        html += `
        <div class="flex items-center p-3 hover:bg-white/5 transition-colors gap-3 ${rowClass}">
            <div class="w-14 flex flex-col items-center leading-tight opacity-70">
                <span class="text-[10px] uppercase font-bold text-br-400">${dayShort}</span>
                <span class="text-xs font-mono text-br-200">${dateDisplay}</span>
            </div>
            
            <div class="w-12 text-xs font-mono text-br-300 text-right">
                ${timeDisplay}
            </div>
            
            <div class="flex-grow min-w-0">
                <div class="text-sm font-medium text-white truncate">${e.title}</div>
                ${e.location ? `<div class="text-[10px] text-br-400 truncate">📍 ${e.location}</div>` : ''}
                ${(e.description && e.description.trim() !== '{') ? `<div class="text-[10px] text-br-500 truncate mt-0.5">${e.description}</div>` : ''}
            </div>

            <div class="w-2 h-2 rounded-full ${e.source === 'exchange' ? 'bg-purple-500' : 'bg-blue-500'}"></div>
        </div>
        `;
    });
    html += `</div>`;

    // Summary Footer
    html += `<div class="text-center text-xs text-br-400 mt-2">${relevantEvents.length} Termine gefunden</div>`;

    container.innerHTML = html;
};

window.filterBySearch = (val) => {
    currentSearchTerm = val;
    renderCalendar();
};

window.toggleSelectionMode = () => {
    isSelectionMode = !isSelectionMode;
    selectedIds.clear();
    updateSelectionUI();
    renderCalendar();
};

window.toggleEventSelection = (id) => { // id is a string
    // Don't open edit modal if in selection mode!
    // Handled by onclick logic in renderCalendar, but good to check.
    if (!isSelectionMode) return;

    if (selectedIds.has(id)) {
        selectedIds.delete(id);
    } else {
        selectedIds.add(id);
    }
    updateSelectionUI();
    renderCalendar(); // Re-render to show checkbox state
};

window.deleteSelectedAppointments = async () => {
    if (selectedIds.size === 0) return;

    if (!confirm(`${selectedIds.size} Termine wirklich löschen?`)) return;

    try {
        const batch = db.batch();
        let count = 0;

        // We need to find the docs. Some are app, some are exchange.
        // We can just try to delete from both collections if we don't know the source easily by ID alone
        // OR we can look them up in state.

        const allEvents = [...state.events.app, ...state.events.exchange];

        selectedIds.forEach(id => {
            const evt = allEvents.find(e => e.id === id);
            if (!evt) return; // Should not happen

            const collection = evt.source === 'exchange' ? 'exchange_events' : 'app_events';
            const ref = db.collection(collection).doc(id);
            batch.delete(ref);
            count++;
        });

        await batch.commit();
        alert(`✅ ${count} Termine gelöscht.`);

        // Reset Mode
        isSelectionMode = false;
        selectedIds.clear();
        updateSelectionUI();
        // renderCalendar will be triggered by snapshot listener

    } catch (e) {
        console.error("Batch Delete Error:", e);
        alert("Fehler beim Löschen: " + e.message);
    }
};

function updateSelectionUI() {
    const btn = document.getElementById('btnSelectionMode');
    const btnText = btn.querySelector('span:not(#selectionCountBadge)');
    const badge = document.getElementById('selectionCountBadge');
    const deleteBtn = document.getElementById('btnDeleteSelected');
    const addBtn = document.querySelector('button[onclick="openAddAppointmentModal()"]'); // Find the green button

    if (isSelectionMode) {
        btn.classList.add('bg-blue-600', 'text-white', 'border-blue-500');
        btn.classList.remove('text-br-300');
        if (btnText) btnText.textContent = 'Nicht Löschen';

        if (addBtn) addBtn.classList.add('hidden'); // Hide Add button to make space/reduce confusion

        if (selectedIds.size > 0) {
            deleteBtn.classList.remove('hidden');
            deleteBtn.classList.add('flex');
            badge.textContent = selectedIds.size;
            badge.classList.remove('hidden');
            badge.classList.add('flex');
        } else {
            deleteBtn.classList.add('hidden');
            deleteBtn.classList.remove('flex');
            badge.classList.add('hidden');
            badge.classList.remove('flex');
        }
    } else {
        btn.classList.remove('bg-blue-600', 'text-white', 'border-blue-500');
        btn.classList.add('text-br-300');
        if (btnText) btnText.textContent = 'Löschauswahl';

        if (addBtn) addBtn.classList.remove('hidden');

        deleteBtn.classList.add('hidden');
        deleteBtn.classList.remove('flex');
        badge.classList.add('hidden');
        badge.classList.remove('flex');
    }
}

function setCalendarFilter(val) {
    currentFilter = val;

    const types = ['all', 'exchange', 'manual'];

    // Update Main Header Buttons
    types.forEach(type => {
        const btn = document.getElementById(`filter-btn-${type}`);
        if (btn) {
            if (type === val) {
                btn.classList.add('bg-blue-600', 'text-white', 'shadow');
                btn.classList.remove('text-br-300', 'hover:text-white', 'bg-transparent');
            } else {
                btn.className = "px-3 py-1.5 text-xs font-medium rounded-lg text-br-300 hover:text-white transition-all";
            }
        }
    });

    // Update Overview Toolbar Buttons
    types.forEach(type => {
        const btn = document.getElementById(`ov-filter-btn-${type}`);
        if (btn) {
            if (type === val) {
                btn.classList.add('bg-blue-600', 'text-white', 'shadow');
                btn.classList.remove('text-br-300', 'hover:text-white', 'bg-transparent');
            } else {
                btn.className = "px-3 py-1.5 text-xs font-medium rounded-lg text-br-300 hover:text-white transition-all";
            }
        }
    });

    // Render active view
    if (currentView === 'overview') {
        renderOverview();
    } else {
        renderCalendar();
    }
}

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
    // Debug Alert (remove later)
    // alert("Debug: Upload Triggered"); 
    // Console log is better if alert is blocked? But user says "question not coming".
    console.log("DEBUG: handleIcsUpload called with", input);

    if (!input.files || !input.files[0]) {
        console.log("No file selected.");
        return;
    }

    // Move confirm here (Sync/Direct context) to avoid blocking
    if (!confirm('⚠️ ACHTUNG: Dies löscht ALLE bestehenden Termine (App & Exchange) und importiert die Datei neu.\n\nWirklich fortfahren?')) {
        input.value = '';
        return;
    }

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

                console.log("User confirmed Reset & Import (Pre-Check passed).");

                const collectionRef = db.collection('app_events');

                // --- 1. CLEANUP OLD DATA (Nuclear Option) ---
                console.log("Cleaning up ALL old data (Full Reset)...");

                // A) Delete ALL 'app_events' (Manual + Imported)
                const appEventsSnapshot = await collectionRef.get();
                console.log(`Found ${appEventsSnapshot.size} app events to delete.`);
                await deleteInBatches(db, appEventsSnapshot.docs);
                console.log("Deleted all app events.");

                // B) Delete ALL 'exchange_events'
                const exchangeSnapshot = await db.collection('exchange_events').get();
                console.log(`Found ${exchangeSnapshot.size} exchange events to delete.`);
                await deleteInBatches(db, exchangeSnapshot.docs);
                console.log("Deleted all exchange events.");


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

// === Manual Backup & Restore ===

async function exportManualAppointments() {
    try {
        // Filter strictly for 'app' source events (manual)
        const manualEvents = state.events.app.filter(e => e.source === 'app' || (!e.source && !e.type)); // fallback for legacy

        if (manualEvents.length === 0) {
            alert('Keine manuellen Termine zum Exportieren gefunden.');
            return;
        }

        const dataStr = JSON.stringify(manualEvents, null, 2);
        const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);

        const exportFileDefaultName = `app-termine-backup-${new Date().toISOString().split('T')[0]}.json`;

        const linkElement = document.createElement('a');
        linkElement.setAttribute('href', dataUri);
        linkElement.setAttribute('download', exportFileDefaultName);
        linkElement.click();

        console.log(`Exported ${manualEvents.length} manual events.`);

    } catch (e) {
        console.error("Export Error:", e);
        alert('Fehler beim Export: ' + e.message);
    }
}

async function handleBackupUpload(input) {
    if (!input.files || !input.files[0]) return;

    const file = input.files[0];
    if (!confirm(`Möchtest du das Backup "${file.name}" wiederherstellen?\nDies fügt die Termine zu den bestehenden hinzu.`)) {
        input.value = '';
        return;
    }

    try {
        const text = await file.text();
        const events = JSON.parse(text);

        if (!Array.isArray(events)) throw new Error("Ungültiges Format (Kein Array)");

        console.log(`Restoring ${events.length} events...`);

        let restoredCount = 0;
        const batch = db.batch();
        let batchCount = 0;

        for (const evt of events) {
            // Sanitize: Remove ID (new doc), ensure source='app'
            const { id, ...data } = evt;
            data.source = 'app';
            data.createdAt = new Date(); // Reset creation time or keep? Better reset to avoid confusion.

            // Check essential fields
            if (!data.title || !data.start) continue;

            const docRef = db.collection('app_events').doc();
            batch.set(docRef, data);

            restoredCount++;
            batchCount++;

            // Firestore Batch limit is 500
            if (batchCount >= 450) {
                await batch.commit();
                batchCount = 0;
            }
        }

        if (batchCount > 0) await batch.commit();

        alert(`✅ ${restoredCount} Termine erfolgreich wiederhergestellt.`);
        input.value = '';

    } catch (e) {
        console.error("Restore Error:", e);
        alert('Fehler beim Wiederherstellen: ' + e.message);
        input.value = '';
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
            const events = snapshot.docs.map(doc => {
                const data = doc.data();
                // IMPORTANT: preserve 'imported' source if present! Default to 'app' only if missing.
                return { id: doc.id, ...data, source: data.source || 'app' };
            });
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

// === Main Calendar View Logic ===

function updateCalendarView() {
    processEvents();
}

function processEvents() {
    const expandedMap = new Map();

    const processEvent = (evt) => {
        if (!evt.start) return;

        // Clean IDs for maps
        const baseId = evt.id;

        // If not recurring, just add once
        if (!evt.recurrence || evt.recurrence === 'none') {
            const key = `${evt.start.split('T')[0]}|${evt.title}`;
            // If duplicate exists (e.g. from sync overlap), overwrite or skip?
            // With distinct IDs, map keys are distinct if ID used? 
            // We use instance key for grouping.
            expandedMap.set(key, evt);
            return;
        }

        // Handle Recurrence
        let currentDate = new Date(evt.start);
        const recurrenceEnd = evt.recurrenceEnd ? new Date(evt.recurrenceEnd) : new Date(new Date().getFullYear() + 2, 0, 1);

        // Limit infinite loops
        let instances = 0;
        const maxInstances = 365 * 2; // ~2 years daily

        const recurrence = evt.recurrence;
        const interval = parseInt(evt.recurrenceInterval || 1);

        while (currentDate <= recurrenceEnd && instances < maxInstances) {
            const y = currentDate.getFullYear();
            const m = String(currentDate.getMonth() + 1).padStart(2, '0');
            const d = String(currentDate.getDate()).padStart(2, '0');
            const dateStr = `${y}-${m}-${d}`;

            // Check Exclusions
            if (evt.excludedDates && evt.excludedDates.includes(dateStr)) {
                incrementDate(currentDate, recurrence, interval);
                instances++;
                continue;
            }

            // Construct Start
            // Keep original hours/minutes
            const startObj = new Date(evt.start);
            const sH = String(startObj.getHours()).padStart(2, '0');
            const sM = String(startObj.getMinutes()).padStart(2, '0');

            // Duration calculation
            const endObj = new Date(evt.end);
            const duration = endObj.getTime() - startObj.getTime(); // ms

            const newStartIso = `${y}-${m}-${d}T${sH}:${sM}:00`;
            const newStartObj = new Date(newStartIso);

            // Calculate new End by adding duration to new Start
            const newEndObj = new Date(newStartObj.getTime() + duration);

            // Convert to ISO string manually to preserve local time
            const eY = newEndObj.getFullYear();
            const eMo = String(newEndObj.getMonth() + 1).padStart(2, '0');
            const eD = String(newEndObj.getDate()).padStart(2, '0');
            const eH = String(newEndObj.getHours()).padStart(2, '0');
            const eMi = String(newEndObj.getMinutes()).padStart(2, '0');

            const newEndIso = `${eY}-${eMo}-${eD}T${eH}:${eMi}:00`;

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

    // Auto-update view if in overview mode
    if (currentView === 'overview') {
        renderOverview();
    } else {
        renderCalendar();
    }
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

    // Apply Filter & Search
    const filteredEvents = events.filter(e => {
        // 1. Text Search Filter
        if (currentSearchTerm) {
            const term = currentSearchTerm.toLowerCase();
            const title = (e.title || '').toLowerCase();
            const desc = (e.description || '').toLowerCase();
            const loc = (e.location || '').toLowerCase();
            if (!title.includes(term) && !desc.includes(term) && !loc.includes(term)) {
                return false; // Skip if no match
            }
        }

        // 2. Category/Source Filter
        if (currentFilter === 'all') return true;
        if (currentFilter === 'exchange') return e.source === 'exchange' || e.source === 'imported';
        if (currentFilter === 'manual') return e.source === 'app';
        return true;
    });

    if (filteredEvents.length === 0) {
        container.innerHTML = `<div class="p-8 text-center text-br-300"><div class="text-4xl mb-2">🔍</div><p>Keine Termine für diesen Filter</p></div>`;
        return;
    }

    filteredEvents.sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayIso = yesterday.toISOString().split('T')[0];

    const relevantEvents = filteredEvents.filter(e => {
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

            // Safely escape ID for onclick
            const safeId = evt.id.replace(/'/g, "\\'");
            const isSelected = selectedIds.has(evt.id);

            let clickAction, cardClass;
            let selectionIndicator = '';

            if (isSelectionMode) {
                clickAction = `window.toggleEventSelection('${safeId}')`;

                // Selection Style
                if (isSelected) {
                    cardClass = 'bg-blue-600/20 border-blue-500 ring-1 ring-blue-500 shadow-lg shadow-blue-500/10 cursor-pointer';
                    selectionIndicator = `<div class="absolute right-4 top-4 text-blue-400 animate-in zoom-in spin-in-90 duration-200"><i class="ph-check-circle-fill text-2xl"></i></div>`;
                } else {
                    cardClass = 'bg-br-800 border-br-600 hover:bg-br-750 cursor-pointer opacity-80 hover:opacity-100';
                    selectionIndicator = `<div class="absolute right-4 top-4 text-br-500"><i class="ph-circle text-2xl"></i></div>`;
                }

            } else {
                // Normal Mode
                clickAction = `window.editAppointment('${safeId}', ${startParam})`;

                cardClass = !isExchange
                    ? 'bg-br-800 border-br-600 hover:border-blue-500 cursor-pointer'
                    : 'bg-br-800/50 border-br-700 cursor-pointer hover:border-purple-500';
            }

            html += `<div class="p-4 rounded-xl border ${cardClass} transition-all relative overflow-hidden group select-none"
                onclick="${clickAction}">
                
                ${isSelectionMode ? selectionIndicator : (isExchange ? '<div class="absolute right-0 top-0 bottom-0 w-1 bg-purple-500"></div>' : '<div class="absolute right-0 top-0 bottom-0 w-1 bg-blue-500"></div>')}
                
                <div class="flex justify-between items-start ${isSelectionMode ? 'pr-8' : ''}">
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
                ${(evt.description && evt.description.length > 3 && !evt.description.includes('{')) ? `<div class="mt-2 text-xs text-br-400 line-clamp-2">${evt.description}</div>` : ''}
            </div>`;
        });
        html += `</div></div>`;
    });

    if (relevantEvents.length === 0) {
        html = `<div class="p-8 text-center text-br-300"><p>Keine zukünftigen Termine</p></div>`;
    }
    container.innerHTML = html;

    // Auto-Scroll to Today on first load
    if (!initialScrollDone) {
        setTimeout(() => {
            jumpToToday();
            initialScrollDone = true;
        }, 300);
    }
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
    const cleanDesc = (evt.description || '').trim();
    document.getElementById('apptDescription').value = cleanDesc === '{' ? '' : cleanDesc;
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
        document.getElementById('btnGroupRecurringDelete').classList.add('flex');
    } else {
        document.getElementById('btnDeleteAppt').classList.remove('hidden');
        document.getElementById('btnGroupRecurringDelete').classList.add('hidden');
        document.getElementById('btnGroupRecurringDelete').classList.remove('flex');
    }
    document.getElementById('modalTitleAppt').textContent = '✏️ Termin bearbeiten';
}

async function saveAppointmentEdit() {
    const id = document.getElementById('apptId').value;
    const title = document.getElementById('apptTitle').value;
    const dateStr = document.getElementById('apptDate').value;
    const startTime = document.getElementById('apptStart').value;
    const endTime = document.getElementById('apptEnd').value;
    const location = document.getElementById('apptLocation').value;
    const description = document.getElementById('apptDescription').value;
    const isAllDay = document.getElementById('apptAllDay').checked;

    // Recurrence
    const recurrence = document.getElementById('apptRecurrence').value;
    const recurrenceEnd = document.getElementById('apptRecurrenceEnd').value;
    const recurrenceInterval = document.getElementById('apptRecurrenceInterval').value;

    if (!title || !dateStr) {
        alert('Bitte Titel und Datum ausfüllen.');
        return;
    }

    const startIso = `${dateStr}T${startTime}:00`;
    const endIso = `${dateStr}T${endTime}:00`;

    const data = {
        title,
        start: startIso,
        end: endIso,
        location,
        description,
        isAllDay,
        recurrence,
        recurrenceEnd,
        recurrenceInterval,
        source: 'app', // Always app for edits
        updatedAt: new Date()
    };

    try {
        if (id) {
            // Check if Exchange - if so, we create a COPY in app_events (Shadow) or just "edit" it by creating a new doc?
            // User requested ability to edit Exchange. Since we can't write to Outlook, we should save it as an App event 
            // and maybe hide the original? Or simple: Just overwrite in app_events (if it was exch, we create new doc).

            // To simplify: If it's an existing App event, update.
            // If it's Exchange, we can't really "edit" it unless we duplicate it.
            // But let's assume we just update the doc if it exists in app_events.

            // Check if it exists in app_events
            const appDoc = await db.collection('app_events').doc(id).get();
            if (appDoc.exists) {
                await db.collection('app_events').doc(id).update(data);
            } else {
                // It was Exchange (or imported). We create a new App Event?
                // But wait, the ID is from Exchange.
                // We can't overwrite Exchange ID in App collection easily.
                // Ideally: Create new App Event, user manually deletes old Exchange?
                // Or: We treat it as a new event.
                // To avoid complexity: Create NEW event, user has to delete the other one if they want.
                // BUT: User clicked "Edit".
                // Let's create a NEW doc with new ID.
                await db.collection('app_events').add(data);
                // Optional: Delete the "old" one? If it was Exchange, we can delete the local copy? 
                // We already implemented delete for Exchange events (local delete).
                await db.collection('exchange_events').doc(id).delete();
            }
        } else {
            // New
            data.createdAt = new Date();
            await db.collection('app_events').add(data);
        }
        closeEditAppointmentModal();
    } catch (e) {
        console.error("Save Error:", e);
        alert('Fehler beim Speichern: ' + e.message);
    }
}

async function deleteAppointment() {
    const id = state.editingAppointmentId;
    if (!id) return;
    if (!confirm('Termin wirklich löschen?')) return;

    try {
        // Try Delete from both (cleaner)
        // If it exists in app:
        await db.collection('app_events').doc(id).delete();
        // If it exists in exchange:
        await db.collection('exchange_events').doc(id).delete();

        closeEditAppointmentModal();
    } catch (e) {
        console.error("Delete Error:", e);
    }
}

// Handling Recurring Deletion
async function deleteCurrentInstance() {
    const id = state.editingAppointmentId;
    const date = state.editingInstanceDate; // YYYY-MM-DD
    if (!id || !date) return;

    // We add this date to "excludedDates" array of the master event
    try {
        const docRef = db.collection('app_events').doc(id);
        const doc = await docRef.get();
        if (doc.exists) {
            const data = doc.data();
            const excluded = data.excludedDates || [];
            excluded.push(date);
            await docRef.update({ excludedDates: excluded });
            closeEditAppointmentModal();
            return;
        }

        // Exchange? We can basically do the same if we treat Exchange events as "local" docs now (since we have write access to the collection).
        const exRef = db.collection('exchange_events').doc(id);
        const exDoc = await exRef.get();
        if (exDoc.exists) {
            const data = exDoc.data();
            const excluded = data.excludedDates || [];
            excluded.push(date);
            await exRef.update({ excludedDates: excluded });
            closeEditAppointmentModal();
        }

    } catch (e) {
        console.error("Instance Delete Error:", e);
    }
}

async function deleteSeries() {
    // Same as deleteAppointment essentially
    deleteAppointment();
}

function closeEditAppointmentModal() {
    document.getElementById('editAppointmentModal').classList.remove('flex');
    document.getElementById('editAppointmentModal').classList.add('hidden');
}

// === Reset Functions ===
// (Called from HTML)
window.executeReset = async () => {
    // ... not implemented directly here, logic is inside handleIcsUpload internal flow
    // Reuse handleIcsUpload logic or just UI?
    // Actually the button in UI triggers handleIcsUpload which triggers the UI flow.
};
