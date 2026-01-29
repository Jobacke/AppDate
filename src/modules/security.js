import { db, auth, firebase, SHARED_USER_EMAIL, PIN_SALT } from '../config.js';
import { state } from '../store.js';
import { finalizeUnlock } from './auth.js';


// State
let currentPinInput = [];
let modalMode = 'none'; // 'setup', 'change-verify-old', 'change-new'

// Exports for HTML
export function initSecurity() {
    window.openSecuritySettings = openSecuritySettings;
    window.closeSecurityModal = closeSecurityModal;
    window.startPinChange = startPinChange;
    // window.startPinRemoval = startPinRemoval; // Removed for security
    window.lockApp = lockApp;
    window.confirmPinAction = confirmPinAction;
    window.cancelPinAction = cancelPinAction;
    window.clearPinDigit = clearPinDigit;

    // Bind Security Button
    const btnSecurity = document.getElementById('btnSecurity');
    if (btnSecurity) {
        btnSecurity.addEventListener('click', openSecuritySettings);
    }

    // Bind Keypad clicks
    document.querySelectorAll('.pin-key').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const digit = e.target.getAttribute('data-num');
            if (digit) handlePinDigit(digit);
        });
    });
}

// --- Auth / Lock Logic ---

export function showLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    if (lockScreen) {
        lockScreen.classList.remove('hidden');
        lockScreen.classList.add('flex');
    }
    currentPinInput = [];
    updatePinDisplay();
    // Use timeout to avoid focus fighting
    setTimeout(() => {
        // Maybe focus a hidden input if we want keyboard support?
    }, 100);
}

export function hideLockScreen() {
    const lockScreen = document.getElementById('lockScreen');
    if (lockScreen) {
        lockScreen.classList.add('hidden');
        lockScreen.classList.remove('flex');
    }
    currentPinInput = [];
}

export function lockApp() {
    // Explicitly clear session flag
    sessionStorage.removeItem('APP_UNLOCKED');

    // We can either signOut (requiring strict online re-auth) 
    // OR just reload page to trigger lock screen (lighter).
    // Given the requirement "Cloud-based", SignOut is safest.
    auth.signOut().then(() => {
        console.log("App Locked via SignOut");
        // auth.js listener will trigger showLockScreen
    });
}

async function handlePinDigit(digit) {
    // Only process input if lock screen is visible OR inside modal pin view
    const lockScreen = document.getElementById('lockScreen');
    const modalPinView = document.getElementById('securityPinView');

    // Determine context. 
    // If modal is open and in pin view, don't use the lock screen keypad logic?
    // Wait, the lock screen has its OWN keypad in HTML?
    // Assuming the event listeners attached to '.pin-key' cover BOTH keypads if they share class, 
    // OR they are unique.
    // In many apps, the lock screen is an overlay.
    // If the modal is open, we usually use the input field `modalPinInput` and correct button clicks?
    // The previous implementation used `modalPinInput` for the modal, and keypad for the lock screen.
    // Let's stick to that separation.

    // If Lock Screen is hidden, ignore this keypad (unless it's the modal keypad?)
    // Typically `pin-key` class is used on the Lock Screen keypad.
    if (lockScreen.classList.contains('hidden')) return;

    if (currentPinInput.length < 4) {
        currentPinInput.push(digit);
        updatePinDisplay();

        if (currentPinInput.length === 4) {
            await verifyLockScreenPin();
        }
    }
}

function clearPinDigit() {
    if (currentPinInput.length > 0) {
        currentPinInput.pop();
        updatePinDisplay();
    }
    document.getElementById('lockMessage').textContent = '';
}

function updatePinDisplay() {
    const container = document.getElementById('pinDisplayDots');
    if (!container) return;
    const dots = container.children;
    for (let i = 0; i < 4; i++) {
        if (i < currentPinInput.length) {
            dots[i].classList.remove('bg-br-700', 'border-br-600');
            dots[i].classList.add('bg-blue-500', 'border-blue-400', 'shadow-[0_0_10px_rgba(59,130,246,0.5)]');
        } else {
            dots[i].classList.remove('bg-blue-500', 'border-blue-400', 'shadow-[0_0_10px_rgba(59,130,246,0.5)]');
            dots[i].classList.add('bg-br-700', 'border-br-600');
        }
    }
}

async function verifyLockScreenPin() {
    const pin = currentPinInput.join('');
    // For Shared Account: PIN + Salt = Password
    const password = pin + PIN_SALT;

    // UI Feedback
    const msgEl = document.getElementById('lockMessage');
    msgEl.textContent = 'Prüfe...';

    try {
        // ALWAYS Verify against Cloud (Auth).
        // If we are already logged in (cached), this check confirms the PIN/Password is correct.
        // If we are not logged in, this logs us in.
        await auth.signInWithEmailAndPassword(SHARED_USER_EMAIL, password);

        // If we get here, PIN is correct.
        msgEl.textContent = 'Erfolg';

        // Trigger Unlock Sequence
        finalizeUnlock();

    } catch (error) {
        console.error("Login Error:", error);

        if (error.code === 'auth/user-not-found') {
            // First run recovery / Setup
            if (confirm("Kein PIN eingerichtet (Benutzer nicht gefunden). Möchtest du diesen PIN jetzt als Passwort festlegen?")) {
                try {
                    await auth.createUserWithEmailAndPassword(SHARED_USER_EMAIL, password);
                    // Success -> Auto logged in
                    finalizeUnlock();
                } catch (e) {
                    showLockError("Erstellen fehlgeschlagen: " + e.message);
                    shake();
                }
            } else {
                showLockError("Benutzer nicht gefunden.");
                shake();
            }
        } else if (error.code === 'auth/wrong-password') {
            showLockError("Falscher PIN");
            shake();
        } else if (error.code === 'auth/too-many-requests') {
            showLockError("Zu viele Versuche. Warte kurz.");
            shake();
        } else {
            showLockError("Fehler: " + error.message);
            shake();
        }
    }
}

function showLockError(msg) {
    const el = document.getElementById('lockMessage');
    if (el) el.textContent = msg;
}

function shake() {
    const dotsContainer = document.getElementById('pinDisplayDots');
    if (dotsContainer) {
        dotsContainer.classList.add('animate-shake'); // Tailwind custom animation or class
        setTimeout(() => {
            currentPinInput = [];
            updatePinDisplay();
            dotsContainer.classList.remove('animate-shake');
        }, 500);
    }
}

// --- Modal / Settings Logic ---

function openSecuritySettings() {
    const modal = document.getElementById('securityModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    resetModalView();
}

function closeSecurityModal() {
    const modal = document.getElementById('securityModal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    resetModalView();
}

function resetModalView() {
    document.getElementById('securityMainView').classList.remove('hidden');
    document.getElementById('securityPinView').classList.add('hidden');
    document.getElementById('modalPinInput').value = '';
    const err = document.getElementById('modalPinError');
    if (err) err.textContent = '';

    modalMode = 'none';

    // Show Manage Section (Since we are logged in to see this)
    // If not logged in, we wouldn't see settings.
    document.getElementById('pinManageSection').classList.remove('hidden');
    document.getElementById('pinSetupSection').classList.add('hidden');
}

function showPinView(title, desc, mode) {
    document.getElementById('securityMainView').classList.add('hidden');
    document.getElementById('securityPinView').classList.remove('hidden');
    document.getElementById('securityPinView').classList.add('flex');

    document.getElementById('pinViewTitle').textContent = title;
    document.getElementById('pinViewDesc').textContent = desc;

    const input = document.getElementById('modalPinInput');
    input.value = '';
    input.focus();

    modalMode = mode;
}

function startPinChange() {
    showPinView('Authentifizierung', 'Alten PIN eingeben', 'change-verify-old');
}

function cancelPinAction() {
    resetModalView();
}

async function confirmPinAction() {
    const input = document.getElementById('modalPinInput').value;
    const errorEl = document.getElementById('modalPinError');

    if (!/^\d{4}$/.test(input)) {
        errorEl.textContent = 'Muss genau 4 Zahlen enthalten.';
        return;
    }

    if (modalMode === 'change-verify-old') {
        const isValid = await reauthUser(input);
        if (isValid) {
            showPinView('Neuer PIN', 'Bitte neuen Code eingeben', 'change-new');
        } else {
            errorEl.textContent = 'Falscher PIN.';
        }
    } else if (modalMode === 'change-new') {
        await updatePin(input);
        closeSecurityModal();
        alert('PIN erfolgreich geändert!');
    }
}

// --- Auth Helpers ---

async function reauthUser(pin) {
    try {
        const password = pin + PIN_SALT;
        const cred = firebase.auth.EmailAuthProvider.credential(SHARED_USER_EMAIL, password);
        await auth.currentUser.reauthenticateWithCredential(cred);
        return true;
    } catch (e) {
        console.error("Reauth failed", e);
        return false;
    }
}

async function updatePin(pin) {
    try {
        const password = pin + PIN_SALT;
        await auth.currentUser.updatePassword(password);
    } catch (e) {
        console.error("Update password failed", e);
        alert("Fehler beim Ändern: " + e.message);
    }
}
